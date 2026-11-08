// tests/integration/p2d-acceptance.test.ts
//
// ★ P2-D T7 端到端验收：导出三通道 × 发布五通道全链（真 :memory: SQLite + migrate +
// mkdtemp 项目根，口径同 p2b/p2c-acceptance——不 mock ipcMain，直调业务函数）。
// 四场景对 plan Step 1 逐字：①预览与导出字节逐字等（同一 buildContent 的结构性诚实）；
// ②epub 全链（mimetype stored 首位 + XML 转义——epub 不过清洗，'&' 必须成 '&amp;'，
//   opf 无裸 &）；③webnovel 排期全链（draft 章不入队只进 warnings；暂存文件读回
//   cleanForPublish 幂等且无 '**'；mark 后再 stage 被 skipped「已发布」）——★ T7 扩：
//   mark 后**重新 queueIpc**，staged 真源如实带回 publishedAt（杀会话快照假阳性）；
// ④历史两行（ok + fail 且 fail.error 是原始真因，非拟人话术）。
// 红线：全程 :memory: 与 mkdtemp，不碰真实 %APPDATA%；本文件零网络调用。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { ExportHistoryRepo } from '@main/db/repos/export-history-repo';
import { PublishPlanRepo } from '@main/db/repos/publish-plan-repo';
import { StagingRepo } from '@main/db/repos/staging-repo';
import { runExportIpc, previewExportIpc, type ExportIpcDeps } from '@main/export/export-ipc';
import {
  savePlanIpc,
  stageIpc,
  markPublishedIpc,
  queueIpc,
  type PublishIpcDeps,
} from '@main/publish/publish-ipc';
import { readZipEntries } from '@main/export/zip-writer';
import { cleanForPublish } from '@shared/publish/clean';

let db: ReturnType<typeof Database>;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let hist: ExportHistoryRepo;
let plans: PublishPlanRepo;
let staging: StagingRepo;
let root: string;
let docs: string;
let pid: string;
let exportDeps: ExportIpcDeps;
let publishDeps: PublishIpcDeps;

const START_AT = Date.UTC(2026, 10, 8, 4, 0, 0); // 当日本地正午形 ms（P2D-R5 口径与本地日历无关）

function makeChapter(id: string, title: string, body: string, order: number, status: 'draft' | 'done'): void {
  chapters.insert({ id, projectId: pid, title, volumeId: null, order, status, body });
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  projects = new ProjectRepo(db);
  chapters = new ChapterRepo(db);
  hist = new ExportHistoryRepo(db);
  plans = new PublishPlanRepo(db);
  staging = new StagingRepo(db);
  root = mkdtempSync(join(tmpdir(), 'mz-p2d-accept-root-'));
  docs = mkdtempSync(join(tmpdir(), 'mz-p2d-accept-docs-'));
  // 书名含 '&'：epub/docx XML 出口的转义负对照（②钉 opf 无裸 &）
  pid = projects.create('A&B书', root).id;
  // 装配面照 services：platform/language 走 pipelineParams 真列（webnovel + en → 词口径/overseas 清洗）
  projects.setPipelineParams(pid, { platform: 'webnovel', language: 'en' });
  const proj = () => ({ id: pid, name: 'A&B书', rootDir: root });
  exportDeps = { getProject: proj, chapters, documentsDir: docs, history: hist };
  publishDeps = { getProject: proj, plans, staging, chapters, projects };
  // 三章：一章 done 带 markdown 残留（** 与零宽 + 行尾空白 + 空行串），一章 draft，一章 done 干净
  makeChapter('1', '第一章 起', '**起**雾\u200B从江面上漫过来。   \n\n\n\n\n收。', 0, 'done');
  makeChapter('2', '第二章 草', '草稿正文，未定稿。', 1, 'draft');
  makeChapter('3', '第三章 承', '定稿正文三。', 2, 'done');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(docs, { recursive: true, force: true });
});

describe('P2-D 导出发布端到端', () => {
  it('① 预览与导出字节逐字等：previewExportIpc 与同参 runExportIpc 一个字节都不差', async () => {
    const req = { format: 'txt' as const, scope: { kind: 'book' } as const, dest: 'project' as const };
    const prev = await previewExportIpc(exportDeps, req);
    const run = await runExportIpc(exportDeps, req);
    expect(run.bytes).toBe(prev.bytes); // 字节诚实：同一 buildContent，预览不是估算
    expect(readFileSync(run.path).length).toBe(prev.bytes); // 磁盘实测第三账
    expect(prev.toc.map((t) => t.label)).toEqual(['第一章 起', '第二章 草', '第三章 承']);
    expect(prev.warnings.some((w) => w.includes('第二章 草'))).toBe(true); // 未定稿照含但如实 warn
  });

  it('② epub 全链：mimetype stored 首位；书名 & 在 opf 只以 &amp; 存在（XML 转义负对照）', async () => {
    const run = await runExportIpc(exportDeps, { format: 'epub', scope: { kind: 'book' }, dest: 'project' });
    const entries = readZipEntries(readFileSync(run.path));
    expect(entries[0].name).toBe('mimetype');
    expect(entries[0].method).toBe(0); // stored 首位是 epub 规格硬要求
    expect(entries[0].data.toString()).toBe('application/epub+zip');
    const opf = entries.find((e) => e.name === 'EPUB/content.opf');
    expect(opf, 'opf 条目缺失').toBeDefined();
    const xml = opf!.data.toString('utf8');
    expect(xml).toContain('A&amp;B书'); // 转义真形
    // epubs 不过发布清洗——正文 '**' 原样在 xhtml 里是如实行为；这里钉的是 XML 出口无裸 &
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
    const names = entries.map((e) => e.name);
    expect(names).toContain('EPUB/chapter-1.xhtml');
    expect(names).toContain('EPUB/chapter-3.xhtml');
  });

  it('③ webnovel 排期全链：draft 只进 warnings；暂存文件幂等且无 **；mark 后 queue.staged 真源 + 再 stage 被 skipped', async () => {
    const plan = savePlanIpc(publishDeps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    const q0 = queueIpc(publishDeps, { planId: plan.id });
    expect(q0.items.map((i) => i.chapterId)).toEqual(['1', '3']); // draft 不候
    expect(q0.warnings.some((w) => w.includes('第二章 草'))).toBe(true);
    expect(q0.items[0].sizeUnit).toBe('words'); // language=en 词口径（服务端推导体量）
    expect(q0.staged).toEqual([]); // 一条都没暂存：空账本不是 undefined

    const res = await stageIpc(publishDeps, { planId: plan.id, chapterIds: ['1', '3'] });
    expect(res.staged).toHaveLength(2);
    for (const entry of res.staged) {
      const text = readFileSync(entry.path, 'utf8');
      expect(text).not.toContain('**'); // 服务端独立再清洗（不信任客户端）
      expect(text).not.toContain('\u200B');
      // 幂等审计：对暂存文件再跑一遍同一市场清洗，零编辑零变化
      const again = cleanForPublish(text, 'overseas');
      expect(again.edits).toHaveLength(0);
      expect(again.cleaned).toBe(text);
    }

    markPublishedIpc(publishDeps, { planId: plan.id, chapterId: '1' });
    // ★ T7 扩：mark 后重新 queueIpc——staged 真源如实恢复（'1' 已发布时刻非 null，'3' 暂存 null，'2' absent）
    const q1 = queueIpc(publishDeps, { planId: plan.id });
    const byId = new Map(q1.staged.map((s) => [s.chapterId, s.publishedAt]));
    expect(byId.size).toBe(2);
    expect(byId.get('1')).not.toBeNull();
    expect(byId.get('1')).toBeTypeOf('number');
    expect(byId.get('3')).toBeNull();
    expect(q1.staged.some((s) => s.chapterId === '2')).toBe(false);

    const again = await stageIpc(publishDeps, { planId: plan.id, chapterIds: ['1', '3'] });
    expect(again.staged.map((s) => s.chapterId)).toEqual(['3']);
    expect(again.skipped[0].reason).toContain('已发布'); // 已发布不许悄悄换稿
  });

  it('④ 历史两行：ok 行在写盘之后；fail 行 path/bytes null 且 error 是原始真因', async () => {
    const run = await runExportIpc(exportDeps, { format: 'txt', scope: { kind: 'book' }, dest: 'project' });
    expect(run.bytes).toBeGreaterThan(0);
    const err = await runExportIpc(exportDeps, {
      format: 'txt',
      scope: { kind: 'volume', volumeId: 'v-none' },
      dest: 'project',
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const rows = hist.listRecent();
    expect(rows).toHaveLength(2);
    const [fail, ok] = rows; // 新在前
    expect(fail.status).toBe('fail');
    expect(fail.path).toBeNull();
    expect(fail.bytes).toBeNull();
    expect(fail.error).toBeTruthy();
    expect(fail.error).not.toBe('导出失败'); // 真因入行，不拟人
    expect(ok.status).toBe('ok');
    expect(ok.path).toBe(run.path);
    expect(ok.bytes).toBe(run.bytes);
  });
});
