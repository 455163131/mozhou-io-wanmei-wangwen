// tests/unit/export-ipc.test.ts —— :memory: 真库 + mkdtemp 假项目根（P2-D T3）
//
// 三通道（export:run / export:preview / export:history）的业务实现直测，
// 口径同 inspiration-ipc.test.ts：不 mock ipcMain，直接调导出的业务函数。
// ★ 字节诚实钉：preview.bytes 必须与同参 run 落盘文件的实测字节**逐字相等**
//   （同一 buildContent，预览不是估算）。
// ★ 历史钉：成功写盘后落 ok 行；失败落 fail 行（path/bytes null、error 是真因）再原样抛。
//   预览是只读动作——不写盘、不入历史。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { ExportHistoryRepo } from '@main/db/repos/export-history-repo';
import {
  runExportIpc,
  previewExportIpc,
  historyIpc,
  type ExportIpcDeps,
} from '@main/export/export-ipc';
import { readZipEntries } from '@main/export/zip-writer';
import { MzError } from '@shared/types/ipc';

let db: ReturnType<typeof Database>;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let hist: ExportHistoryRepo;
let root: string;
let docs: string;
let pid: string;
let deps: ExportIpcDeps;

/**
 * 照 ChapterRepo 真签名造数（brief 骨架的 'p1' 裸 id 过不了 FK——
 * chapters.project_id REFERENCES projects(id)，better-sqlite3 默认开 foreign_keys）：
 * 真项目行 + insert 一步落 meta+正文+status（数据口径同 sentinel E 组/chapter-create 测试）。
 */
function makeChapter(title: string, body: string, volumeId: string | null = null, status: 'todo' | 'draft' | 'done' = 'done') {
  const metas = chapters.listMeta(pid);
  const id = String(metas.length + 1);
  chapters.insert({ id, projectId: pid, title, volumeId, order: metas.length, status, body });
  return id;
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  projects = new ProjectRepo(db);
  chapters = new ChapterRepo(db);
  hist = new ExportHistoryRepo(db);
  root = mkdtempSync(join(tmpdir(), 'mz-p2d-root-'));
  docs = mkdtempSync(join(tmpdir(), 'mz-p2d-docs-'));
  pid = projects.create('书', root).id;
  deps = {
    getProject: () => ({ id: pid, name: '书', rootDir: root }),
    chapters,
    documentsDir: docs,
    history: hist,
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(docs, { recursive: true, force: true });
});

describe('export-ipc', () => {
  it('txt 导出：文件落项目根，历史 ok 行 bytes=fs 实测', async () => {
    makeChapter('第一章 起', '雾从江面上漫过来。\n这是段内软换行。\n\n第二段。');
    makeChapter('第二章 承', '独白落潮。');
    const res = await runExportIpc(deps, { format: 'txt', scope: { kind: 'book' }, dest: 'project' });
    expect(res.path).toBe(join(root, '书.txt'));
    expect(existsSync(res.path)).toBe(true);
    expect(res.bytes).toBe(readFileSync(res.path).length);
    const row = hist.listRecent()[0];
    expect(row.status).toBe('ok');
    expect(row.bytes).toBe(res.bytes);
    expect(row.path).toBe(res.path);
    expect(row.projectId).toBe(pid);
    expect(row.format).toBe('txt');
    expect(row.scope).toEqual({ kind: 'book' });
    expect(row.dest).toBe('project');
    expect(row.error).toBeNull();
    // 内容真形：两章 + 章间 '\n---\n' 分隔（txt builder 口径）
    const text = readFileSync(res.path, 'utf8');
    expect(text).toContain('第一章 起');
    expect(text).toContain('第二章 承');
    expect(text.split('\n---\n')).toHaveLength(2);
  });

  it('epub 导出：readZipEntries 往返含 mimetype stored 首条目', async () => {
    makeChapter('第一章 起', '正文一。');
    makeChapter('第二章 承', '正文二。');
    const res = await runExportIpc(deps, { format: 'epub', scope: { kind: 'book' }, dest: 'project' });
    expect(res.path).toBe(join(root, '书.epub'));
    const entries = readZipEntries(readFileSync(res.path));
    expect(entries[0].name).toBe('mimetype');
    expect(entries[0].method).toBe(0); // stored
    expect(entries[0].data.toString()).toBe('application/epub+zip');
    const names = entries.map((e) => e.name);
    expect(names).toContain('EPUB/content.opf');
    expect(names).toContain('EPUB/toc.ncx');
    expect(names).toContain('EPUB/chapter-1.xhtml');
    expect(names).toContain('EPUB/chapter-2.xhtml');
    const row = hist.listRecent()[0];
    expect(row.status).toBe('ok');
    expect(row.bytes).toBe(res.bytes);
  });

  it('zip 导出：各章独立 txt 条目 + manifest.txt，非拼接', async () => {
    makeChapter('第一章 起', '正文一。');
    makeChapter('第二章：承/含非法字符', '正文二。');
    const res = await runExportIpc(deps, { format: 'zip', scope: { kind: 'book' }, dest: 'project' });
    const entries = readZipEntries(readFileSync(res.path));
    // 章数 + 1（manifest），假 zip（纯文本拼接）时代到此为止
    expect(entries).toHaveLength(3);
    expect(entries[0].name).toMatch(/^0001_.+\.txt$/);
    expect(entries[1].name).toMatch(/^0002_.+\.txt$/);
    // 条目名安全化：分隔符与冒号被剥掉（\ / : * ? " < > | 与控制字符）
    expect(entries[1].name).not.toMatch(/[\\/:*?"<>|]/);
    expect(entries[2].name).toBe('manifest.txt');
    expect(entries[0].data.toString('utf8')).toContain('正文一。');
    expect(entries[2].data.toString('utf8')).toContain('第一章 起');
  });

  it('dest external 写 documentsDir 根', async () => {
    makeChapter('第一章 起', '正文。');
    const res = await runExportIpc(deps, { format: 'md', scope: { kind: 'book' }, dest: 'external' });
    expect(res.path).toBe(join(docs, '书.md'));
    expect(res.path.startsWith(docs)).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    expect(readFileSync(res.path, 'utf8')).toContain('## 第一章 起');
    expect(hist.listRecent()[0].dest).toBe('external');
  });

  it('baseName 显式传入且合法 → 用它命名', async () => {
    makeChapter('第一章 起', '正文。');
    const res = await runExportIpc(deps, { format: 'txt', scope: { kind: 'book' }, dest: 'project', baseName: '我的作品集' });
    expect(res.path).toBe(join(root, '我的作品集.txt'));
    expect(existsSync(res.path)).toBe(true);
  });

  it('scope chapters 缺号 → E_NOT_FOUND 且历史落 fail 行带真因', async () => {
    const id = makeChapter('第一章 起', '正文。');
    await expect(
      runExportIpc(deps, { format: 'txt', scope: { kind: 'chapters', chapterIds: [id, '999'] }, dest: 'project' }),
    ).rejects.toThrow(/不存在/);
    const err = await runExportIpc(deps, { format: 'txt', scope: { kind: 'chapters', chapterIds: ['998', '999'] }, dest: 'project' }).catch((e) => e);
    expect(err).toBeInstanceOf(MzError);
    expect(err.code).toBe('E_NOT_FOUND');
    expect(err.message).toContain('998');
    expect(err.message).toContain('999'); // 缺号列全，不只报第一个
    const fail = hist.listRecent()[0];
    expect(fail.status).toBe('fail');
    expect(fail.path).toBeNull();
    expect(fail.bytes).toBeNull();
    expect(fail.error).toBeTruthy();
    expect(fail.error).toContain('999'); // 真因入行，不是拟人的'导出失败'
    // fail 不落文件
    expect(readdirSync(root)).toHaveLength(0);
  });

  it('baseName 路径穿越/分隔符 → E_INVALID_ARGS（不触盘）', async () => {
    makeChapter('第一章 起', '正文。');
    for (const evil of ['../evil', 'a/b', 'a\\b', '..x', '\u0000书']) {
      const err = await runExportIpc(deps, { format: 'txt', scope: { kind: 'book' }, dest: 'project', baseName: evil }).catch((e) => e);
      expect(err, `baseName=${JSON.stringify(evil)} 应被拒`).toBeInstanceOf(MzError);
      expect(err.code).toBe('E_INVALID_ARGS');
    }
    // root 内没有 evil*，也没有任何导出文件（校验在任何 fs 触碰之前）
    expect(readdirSync(root).filter((f) => f.includes('evil'))).toHaveLength(0);
    expect(readdirSync(root)).toHaveLength(0);
  });

  it('preview 不写文件、bytes 与导出逐字相等（同一构建）', async () => {
    makeChapter('第一章 起', '雾从江面上漫过来。');
    makeChapter('第二章 承', '独白落潮。');
    const req = { format: 'txt' as const, scope: { kind: 'book' } as const, dest: 'project' as const };
    const prev = await previewExportIpc(deps, req);
    expect(existsSync(join(root, '书.txt'))).toBe(false); // 预览不写盘
    expect(hist.listRecent()).toHaveLength(0); // 预览不入历史（只读动作）
    const res = await runExportIpc(deps, req);
    expect(prev.bytes).toBe(res.bytes); // ★ 字节诚实：预览即所得
    expect(prev.bytes).toBe(readFileSync(res.path).length);
    expect(prev.toc).toHaveLength(2);
    expect(prev.toc[0].label).toBe('第一章 起');
    expect(prev.toc[0].chars).toBe('雾从江面上漫过来。'.length);
    expect(prev.sample).toBe('雾从江面上漫过来。'); // 首章剥空白后前 120 字
    expect(prev.warnings).toEqual([]); // 全 done → 零告警
  });

  it('preview 含未定稿章 → warnings 如实；epub/docx 预览字节与导出相等', async () => {
    makeChapter('第一章 起', '定稿正文。');
    makeChapter('第二章 草', '草稿正文。', null, 'draft');
    const prevEpub = await previewExportIpc(deps, { format: 'epub', scope: { kind: 'book' }, dest: 'project' });
    expect(prevEpub.warnings).toHaveLength(1);
    expect(prevEpub.warnings[0]).toContain('第二章 草');
    const runEpub = await runExportIpc(deps, { format: 'epub', scope: { kind: 'book' }, dest: 'project' });
    expect(prevEpub.bytes).toBe(runEpub.bytes);
    const prevDocx = await previewExportIpc(deps, { format: 'docx', scope: { kind: 'book' }, dest: 'project' });
    const runDocx = await runExportIpc(deps, { format: 'docx', scope: { kind: 'book' }, dest: 'project' });
    expect(prevDocx.bytes).toBe(runDocx.bytes);
    expect(runDocx.bytes).toBe(readFileSync(runDocx.path).length);
    expect(prevDocx.bytes).toBeGreaterThan(0);
  });

  it('未打开项目 → E_INVALID_ARGS', async () => {
    deps.getProject = () => null;
    const err = await runExportIpc(deps, { format: 'txt', scope: { kind: 'book' }, dest: 'project' }).catch((e) => e);
    expect(err).toBeInstanceOf(MzError);
    expect(err.code).toBe('E_INVALID_ARGS');
    await expect(previewExportIpc(deps, { format: 'txt', scope: { kind: 'book' }, dest: 'project' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('坏入参门口拦：csv 已退役、scope 形状非法 → E_INVALID_ARGS 且不触盘不入历史', async () => {
    makeChapter('第一章 起', '正文。');
    // P2D-R4：旧 csv kind 退役——format 枚举只有五形
    await expect(runExportIpc(deps, { format: 'csv', scope: { kind: 'book' }, dest: 'project' } as never)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(runExportIpc(deps, { format: 'txt', scope: { kind: 'bogus' } as never, dest: 'project' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(runExportIpc(deps, { format: 'txt', scope: { kind: 'chapters', chapterIds: [] }, dest: 'project' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(readdirSync(root)).toHaveLength(0);
    expect(hist.listRecent()).toHaveLength(0);
  });

  it('volume scope：只含该卷章（listMeta 序）；空卷 → E_NOT_FOUND 不落空文件', async () => {
    // 真卷行（chapters.volume_id → volumes 的 FK），照 ProjectRepo.createVolume 口径
    const v1 = projects.createVolume(pid, '第一卷').id;
    const v2 = projects.createVolume(pid, '第二卷').id;
    makeChapter('雾起', '卷一正文。', v1);
    makeChapter('潮落', '卷二正文。', v2);
    makeChapter('无卷', '游离章正文。');
    const res = await runExportIpc(deps, { format: 'txt', scope: { kind: 'volume', volumeId: v1 }, dest: 'project' });
    const text = readFileSync(res.path, 'utf8');
    expect(text).toContain('雾起');
    expect(text).not.toContain('潮落');
    expect(text).not.toContain('无卷');
    // 空卷/不存在卷：拒，不写空文件
    const err = await runExportIpc(deps, { format: 'txt', scope: { kind: 'volume', volumeId: 'v-none' }, dest: 'project' }).catch((e) => e);
    expect(err).toBeInstanceOf(MzError);
    expect(err.code).toBe('E_NOT_FOUND');
    expect(hist.listRecent()[0].status).toBe('fail');
  });

  it('空书导出 → E_NOT_FOUND，不落空文件', async () => {
    const err = await runExportIpc(deps, { format: 'txt', scope: { kind: 'book' }, dest: 'project' }).catch((e) => e);
    expect(err).toBeInstanceOf(MzError);
    expect(err.code).toBe('E_NOT_FOUND');
    expect(readdirSync(root)).toHaveLength(0);
  });

  it('history：默认 50、limit 生效、坏 limit 被拒；行形照 ExportHistoryRow', async () => {
    makeChapter('第一章 起', '正文。');
    await runExportIpc(deps, { format: 'txt', scope: { kind: 'book' }, dest: 'project' });
    await runExportIpc(deps, { format: 'md', scope: { kind: 'chapters', chapterIds: ['1'] }, dest: 'external' });
    const all = historyIpc(deps, {});
    expect(all).toHaveLength(2);
    expect(all[0].format).toBe('md'); // 新在前
    expect(all[0].scope).toEqual({ kind: 'chapters', chapterIds: ['1'] }); // scope_json 往返
    expect(historyIpc(deps, { limit: 1 })).toHaveLength(1);
    expect(() => historyIpc(deps, { limit: 0 })).toThrowError(MzError);
    expect(() => historyIpc(deps, { limit: 301 })).toThrowError(MzError);
    expect(() => historyIpc(deps, { limit: 1.5 })).toThrowError(MzError);
  });

  it('★ T7 携带修复：历史账本尽力而为——fail 路径 history.insert 再抛时，reject 的仍是原始错误', async () => {
    // 结构性 stub（同 ExportIpcDeps 方法面）：insert 必抛，模拟账本损坏/磁盘锁。
    // 修复前 catch 内裸 insert 会把「账本坏了」冒名顶替 E_NOT_FOUND 真因；
    // 修复后 swallow-with-comment，原始错误永不被替换。
    const boom = {
      insert(): never {
        throw new Error('账本写入失败（模拟）');
      },
      listRecent: () => [],
    };
    // 类私有 db 字段让字面量无法名义 assignable——测试侧一次性宽转（生产签名不动）
    const brokenDeps: ExportIpcDeps = { ...deps, history: boom as unknown as ExportHistoryRepo };
    const err = await runExportIpc(brokenDeps, {
      format: 'txt',
      scope: { kind: 'chapters', chapterIds: ['999'] },
      dest: 'project',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MzError);
    expect(err.code).toBe('E_NOT_FOUND');
    expect(err.message).toContain('999');
    expect(err.message).not.toContain('账本写入失败');
  });
});
