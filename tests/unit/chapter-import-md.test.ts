/**
 * 导入旧稿的**入库**语义（§4 第 19 条②，真 SQLite）。
 *
 * `planMarkdownImport` 只负责排队（谁入库谁跳过），这里管的是答应的三件事真做到：
 *   · 「绝不覆盖」不只是计划层的客气话 —— repo 在事务里**再查一次**主键，
 *     撞号就整批回滚。计划与库之间可能插进一次 Agent 写章，只信计划等于赌。
 *   · 章号由文件名带来，是**调用方指定的 id** —— 这与 `createChapter`（id 由 repo 算）
 *     刻意相反：导入必须保持原来的号，把旧稿重新编号等于把作者的引用全打乱。
 *   · `ord` 追加到全书末尾、按章号顺序，导入不许把已有章节的相对顺序搅了。
 *   · 日增量要记账：导入的是字数净增，和新建一章同一套（第 3 条）。
 *
 * 走真库（better-sqlite3 + migrate），必须用 `npm test`（Electron ABI），见 §5。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo } from '@main/db/repos/daily-write-repo';

let db: DB;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let daily: DailyWriteRepo;
let pid: string;
let otherPid: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  projects = new ProjectRepo(db);
  daily = new DailyWriteRepo(db);
  chapters = new ChapterRepo(db, daily);
  pid = projects.create('测试书', '/tmp/a').id;
  otherPid = projects.create('另一本书', '/tmp/b').id;
});

function rawBody(chapterId: string): string | undefined {
  const r = db
    .prepare('SELECT body FROM chapter_bodies WHERE project_id = ? AND chapter_id = ?')
    .get(pid, chapterId) as { body: string } | undefined;
  return r?.body;
}

describe('A. 批量入库', () => {
  it('三章一起进，id 就是文件名里的号', () => {
    const metas = chapters.importChapters(pid, [
      { id: '1', title: '开局', body: '一二三' },
      { id: '2', title: '风起', body: '四五六七八' },
      { id: '3', title: '', body: '零' },
    ]);
    expect(metas.map((m) => m.id)).toEqual(['1', '2', '3']);
    expect(metas[0].title).toBe('开局');
    expect(metas[0].charCount).toBe(3);
    expect(metas[1].charCount).toBe(5);
    expect(rawBody('2')).toBe('四五六七八');
  });

  it('★ 已有章节时追加到全书末尾，不动它们的 ord', () => {
    const first = chapters.createChapter(pid, { title: '已有的第一章' });
    const before = chapters.listMeta(pid).map((m) => `${m.id}:${m.order}`);
    chapters.importChapters(pid, [{ id: '9', title: '旧稿', body: '正文' }]);
    const after = chapters.listMeta(pid).map((m) => `${m.id}:${m.order}`);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(first.order).toBe(0);
    expect(after.length).toBe(before.length + 1);
    // 新导入的排在最后
    expect(Number(after[after.length - 1].split(':')[0])).toBe(9);
  });

  it('空批次 → 空数组，不抛错（导入没命中任何东西是正常结果）', () => {
    expect(chapters.importChapters(pid, [])).toEqual([]);
  });

  it('标题去空白；空标题允许（与 createChapter 同口径）', () => {
    const metas = chapters.importChapters(pid, [
      { id: '1', title: '  风雪夜  ', body: '甲' },
      { id: '2', title: '   ', body: '乙' },
    ]);
    expect(metas[0].title).toBe('风雪夜');
    expect(metas[1].title).toBe('');
  });

  it('导入即 draft、rev 从 1 起（新建一章的口径，不是 revised）', () => {
    const m = chapters.importChapters(pid, [{ id: '1', title: '甲', body: '正文' }])[0];
    expect(m.status).toBe('draft');
    expect(m.rev).toBe(1);
  });

  it('★ 日增量记账 = 导入字数之和（第 3 条：今日新增要有真数据源）', () => {
    const before = daily.summary(pid).today;
    chapters.importChapters(pid, [
      { id: '1', title: '甲', body: '一二三四' },
      { id: '2', title: '乙', body: '五六七' },
    ]);
    expect(daily.summary(pid).today - before).toBe(7);
  });
});

describe('B. 撞号：整批回滚，绝不覆盖', () => {
  it('★ 库里已有同号 → 抛错，且原正文一个字都没被盖掉', () => {
    const m = chapters.createChapter(pid, { title: '库里的那章' });
    chapters.updateBody(pid, m.id, '正在写的正文，一个字都不许丢', m.rev);
    expect(() =>
      chapters.importChapters(pid, [{ id: m.id, title: '旧稿', body: '旧稿正文' }]),
    ).toThrow(/已存在|不许覆盖/);
    expect(chapters.getBody(pid, m.id)).toBe('正在写的正文，一个字都不许丢');
    expect(chapters.listMeta(pid)).toHaveLength(1);
  });

  it('★ 中途撞号 → 整批回滚，不留半批导入的章（幂等：修好文件名再跑一次不会重复）', () => {
    const m = chapters.createChapter(pid, { title: '已存在的第1章' });
    expect(() =>
      chapters.importChapters(pid, [
        { id: '2', title: '甲', body: '正文甲' },
        { id: m.id, title: '乙', body: '正文乙' },
        { id: '3', title: '丙', body: '正文丙' },
      ]),
    ).toThrow(/已存在|不许覆盖/);
    expect(chapters.listMeta(pid).map((x) => x.id)).toEqual([m.id]);
    expect(rawBody('2')).toBeUndefined();
    expect(rawBody('3')).toBeUndefined();
    expect(daily.summary(pid).today).toBe(0);
  });

  it('同一批里自己跟自己撞号也要拒（两个文件解出同一个号）', () => {
    expect(() =>
      chapters.importChapters(pid, [
        { id: '4', title: '甲', body: '一' },
        { id: '4', title: '乙', body: '二' },
      ]),
    ).toThrow(/已存在|不许覆盖/);
    expect(chapters.listMeta(pid)).toHaveLength(0);
  });
});

describe('C. 边界', () => {
  it('没打开项目 / 项目不存在 → 拒绝', () => {
    expect(() => chapters.importChapters('', [{ id: '1', title: '甲', body: '乙' }])).toThrow(
      /没有打开项目/,
    );
    expect(() => chapters.importChapters('不存在的书', [{ id: '1', title: '甲', body: '乙' }])).toThrow(
      /项目不存在/,
    );
  });

  it('★ 章号只在书内唯一（第 18 条）：A 书有第 1 章不影响 B 书导入第 1 章', () => {
    chapters.importChapters(pid, [{ id: '1', title: 'A 的第一章', body: '甲' }]);
    const metas = chapters.importChapters(otherPid, [{ id: '1', title: 'B 的第一章', body: '乙' }]);
    expect(metas[0].id).toBe('1');
    expect(chapters.getBody(pid, '1')).toBe('甲');
    expect(chapters.getBody(otherPid, '1')).toBe('乙');
  });

  it('volumeId 一律 null（未分卷）—— 旧稿的卷归属不能靠猜', () => {
    const metas = chapters.importChapters(pid, [{ id: '1', title: '甲', body: '乙' }]);
    expect(metas[0].volumeId).toBeNull();
  });

  it('非数字 id 拒收：导入只认章号，别把文件名当 id 塞进主键', () => {
    expect(() => chapters.importChapters(pid, [{ id: '楔子', title: '甲', body: '乙' }])).toThrow(
      /章号/,
    );
  });
});
