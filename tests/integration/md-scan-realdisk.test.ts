/**
 * 真磁盘上的 `chapters/` → 库（§4 第 19 条②，垂直切片）。
 *
 * 单测证明了"给定 Buffer 能认出来"，wiring 哨兵证明了"调用点没漏"，
 * 但**真目录里的一堆文件**才是用户手上那个东西：混着 .txt、混着子目录、
 * 混着记事本的 GBK 和 VS Code 的 UTF-8 BOM。这一一条把它们全走一遍：
 *   扫目录（md-scan） → 排队（md-import） → 入库（chapter-repo）
 * 三段用的都是生产代码，没有一处把逻辑抄进测试。
 *
 * ★ 断言里最要紧的是那条"库里第 2 章的正文一个字都没变" ——
 *   这条功能唯一的破坏性风险就是拿旧 md 盖掉作者正在写的字。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo } from '@main/db/repos/daily-write-repo';
import { scanMarkdownChapters } from '@main/fs/md-scan';
import { planMarkdownImport } from '@main/fs/md-import';

let dir: string;
let db: DB;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let pid: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-md-import-'));
  db = new Database(':memory:');
  migrate(db);
  projects = new ProjectRepo(db);
  const daily = new DailyWriteRepo(db);
  chapters = new ChapterRepo(db, daily);
  pid = projects.create('测试书', dir).id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 整条链跑一遍：扫目录 → 排队 → 入库 */
async function runImport(): Promise<ReturnType<typeof planMarkdownImport>> {
  const files = await scanMarkdownChapters(dir);
  const plan = planMarkdownImport(files, chapters.listMeta(pid).map((m) => m.id));
  chapters.importChapters(
    pid,
    plan.imported.map((d) => ({ id: d.id, title: d.title, body: d.body })),
  );
  return plan;
}

describe('A. 真目录', () => {
  it('★ UTF-8 / UTF-8 BOM / GBK 三种稿子混在一起，全都要认出来', async () => {
    writeFileSync(join(dir, '第1章 开端.md'), '雪停了。\n\n他出门。', 'utf8');
    // UTF-8 with BOM（VS Code 的默认之一）：BOM 不许漏进正文
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(
      join(dir, '第2章.md'),
      Buffer.concat([bom, Buffer.from('# 京州往事\n\n城门开了。', 'utf8')]),
    );
    // GBK（记事本的"ANSI"）：'风雪\n\n京州' 的 GBK 字节
    writeFileSync(
      join(dir, '第4章.md'),
      Buffer.from([0xb7, 0xe7, 0xd1, 0xa9, 0x0a, 0x0a, 0xbe, 0xa9, 0xd6, 0xdd]),
    );

    const plan = await runImport();
    expect(plan.unresolved.map((u) => u.fileName)).toEqual([]);
    expect(plan.imported.map((d) => d.number)).toEqual([1, 2, 4]);
    expect(chapters.get(pid, '1')!.meta.title).toBe('开端');
    expect(chapters.getBody(pid, '1')).toBe('雪停了。\n\n他出门。');
    expect(chapters.get(pid, '2')!.meta.title).toBe('京州往事');
    expect(chapters.getBody(pid, '2'), 'BOM 漏进了正文').toBe('城门开了。');
    expect(chapters.getBody(pid, '4')).toBe('风雪\n\n京州');
  });

  it('★ 库里已有同号 → 跳过，库里那份正文一个字都不许变', async () => {
    const m = chapters.createChapter(pid, { title: '正在写的那一章' });
    chapters.updateBody(pid, m.id, '作者正在写的字，丢了就是事故', m.rev);
    const fileName = `第${m.id}章.md`;
    writeFileSync(join(dir, fileName), '旧稿正文，不该盖上去');
    const plan = await runImport();
    expect(plan.skipped.map((s) => s.fileName)).toEqual([fileName]);
    expect(chapters.listMeta(pid)).toHaveLength(1);
    expect(chapters.getBody(pid, m.id)).toBe('作者正在写的字，丢了就是事故');
  });

  it('★ 子目录里的稿子不动（那是分卷的事），.txt 与非稿文件不动', async () => {
    mkdirSync(join(dir, '第一卷'));
    writeFileSync(join(dir, '第一卷', '第9章.md'), '子目录里的稿子');
    writeFileSync(join(dir, '大纲.txt'), '不是 md');
    writeFileSync(join(dir, 'README'), '没有扩展名');
    writeFileSync(join(dir, '第1章.md'), '正文');
    const plan = await runImport();
    expect(plan.imported.map((d) => d.id)).toEqual(['1']);
    expect(chapters.listMeta(pid).map((c) => c.id)).toEqual(['1']);
  });

  it('空文件与认不出章号的文件报出来，不进库', async () => {
    writeFileSync(join(dir, '第1章.md'), '正文甲');
    writeFileSync(join(dir, '第二十章.md'), '中文数字认不出章号');
    writeFileSync(join(dir, '第2章.md'), '   \n\n  ');
    const plan = await runImport();
    expect(plan.imported.map((d) => d.id)).toEqual(['1']);
    expect(plan.unresolved.map((u) => u.fileName).sort()).toEqual(['第2章.md', '第二十章.md']);
  });

  it('.MD 大写扩展名也收（Windows 上很常见）', async () => {
    writeFileSync(join(dir, '第7章.MD'), '正文');
    const plan = await runImport();
    expect(plan.imported.map((d) => d.id)).toEqual(['7']);
  });

  it('目录不存在 → 空手而归，不抛错（新项目的 chapters/ 可能就是空的）', async () => {
    expect(await scanMarkdownChapters(join(dir, '不存在'))).toEqual([]);
  });
});
