// tests/unit/publish-ipc.test.ts —— :memory: 真库 + mkdtemp 项目根（P2-D T6）
//
// 五 handler（savePlanIpc / listPlansIpc / queueIpc / stageIpc / markPublishedIpc）
// 的业务实现直测，口径同 export-ipc.test.ts：不 mock ipcMain，直接调导出函数。
// ★ 服务端推导钉：队列由主进程 listMeta+getBodies 一次批取后跑 shared 纯函数
//   buildQueue——渲染层拿不到正文就不许装算得出体量（P2D-R1）。
// ★ 批准即提交钉（P2D-R2）：stageIpc 的 chapterIds 就是「已批准集」，服务端对每章
//   独立再清洗一遍才落暂存文件——不信任客户端清洗结果（预览与服务端同函数同入参，
//   但各算各的）。
// ★ 双保险钉：已发布章在 stageIpc 前置 published 集里被路由为 skipped
//   「已发布不许换稿」（不悄悄覆盖）；repo 层的 E_STAGING_STATE 抛档由
//   markPublishedIpc 未暂存路径 + tests/unit/staging-repo.test.ts 覆盖。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { PublishPlanRepo } from '@main/db/repos/publish-plan-repo';
import { StagingRepo } from '@main/db/repos/staging-repo';
import {
  savePlanIpc,
  listPlansIpc,
  queueIpc,
  stageIpc,
  markPublishedIpc,
  type PublishIpcDeps,
} from '@main/publish/publish-ipc';
import type { ChapterStatus } from '@shared/types/project';
import { MzError } from '@shared/types/ipc';

let db: ReturnType<typeof Database>;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let plans: PublishPlanRepo;
let staging: StagingRepo;
let root: string;
let pid: string;
let deps: PublishIpcDeps;

const START_AT = Date.UTC(2026, 0, 15, 4, 0, 0); // 任意当日 ms（纯加法口径与本地日历无关）
const DAY_MS = 86400000;

/** 照 ChapterRepo 真签名造数（FK 纪律同 export-ipc.test：真项目行 + insert 一步落 meta+正文+status） */
function makeChapter(title: string, body: string, status: ChapterStatus = 'done'): string {
  const metas = chapters.listMeta(pid);
  const id = String(metas.length + 1);
  chapters.insert({ id, projectId: pid, title, volumeId: null, order: metas.length, status, body });
  return id;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  projects = new ProjectRepo(db);
  chapters = new ChapterRepo(db);
  plans = new PublishPlanRepo(db);
  staging = new StagingRepo(db);
  root = mkdtempSync(join(tmpdir(), 'mz-p2d-pub-root-'));
  pid = projects.create('书', root).id;
  deps = {
    getProject: () => ({ id: pid, name: '书', rootDir: root }),
    plans,
    staging,
    chapters,
    projects,
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('publish-ipc · savePlanIpc / listPlansIpc', () => {
  it('① 坏 platform 门口拦（repo 白名单）→ E_INVALID_ARGS，坏值不落库', () => {
    const err = (() => {
      try {
        savePlanIpc(deps, { platform: '某野鸡站', cadence: 'daily', startAt: START_AT });
        return null;
      } catch (e) {
        return e as MzError;
      }
    })();
    expect(err).toBeInstanceOf(MzError);
    expect(err!.code).toBe('E_INVALID_ARGS');
    expect(listPlansIpc(deps, {})).toHaveLength(0);
  });

  it('① 好 plan 回带 id + 服务端取当前项目（req 里没有 projectId，越权他书 by construction 不可能）', () => {
    const p = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    expect(p.id).toBeTruthy();
    expect(p.projectId).toBe(pid);
    expect(p.platform).toBe('webnovel');
    expect(p.status).toBe('active');
    // 非 custom 的 intervalDays 由 repo 派生（req 不采信）
    expect(p.intervalDays).toBe(1);
    // 带 id 再存 = 编辑回同 id，不并生新行
    const again = savePlanIpc(deps, { id: p.id, platform: 'webnovel', cadence: 'weekly', startAt: START_AT });
    expect(again.id).toBe(p.id);
    expect(again.intervalDays).toBe(7);
    expect(listPlansIpc(deps, {})).toHaveLength(1);
  });

  it('① custom 节奏缺 intervalDays → E_INVALID_ARGS；custom 带值原样入库', () => {
    expect(() => savePlanIpc(deps, { platform: 'fanqie', cadence: 'custom', startAt: START_AT })).toThrowError(MzError);
    const p = savePlanIpc(deps, { platform: 'fanqie', cadence: 'custom', intervalDays: 3, startAt: START_AT });
    expect(p.intervalDays).toBe(3);
  });

  it('① listPlansIpc 只见当前项目：他书计划不串门；archived 缺省滤掉', () => {
    savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    // 直接经 repo 造一条他书计划（绕过「req 不收 projectId」的服务端口径）
    const otherRoot = mkdtempSync(join(tmpdir(), 'mz-p2d-pub-other-'));
    try {
      const otherPid = projects.create('别书', otherRoot).id;
      plans.upsert({ projectId: otherPid, platform: 'fanqie', cadence: 'daily', intervalDays: 1, startAt: START_AT });
      expect(listPlansIpc(deps, {})).toHaveLength(1);
      expect(listPlansIpc(deps, {}).every((x) => x.projectId === pid)).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
    const p = plans.get(listPlansIpc(deps, {})[0].id)!;
    plans.setStatus(p.id, 'archived');
    expect(listPlansIpc(deps, {})).toHaveLength(0);
    expect(listPlansIpc(deps, { includeArchived: true })).toHaveLength(1);
  });

  it('① 未打开项目 → E_INVALID_ARGS（两读两写通道同口径）', () => {
    const closed: PublishIpcDeps = { ...deps, getProject: () => null };
    expect(() => savePlanIpc(closed, { platform: 'webnovel', cadence: 'daily', startAt: START_AT })).toThrowError(/未打开项目/);
    expect(() => listPlansIpc(closed, {})).toThrowError(/未打开项目/);
    expect(() => queueIpc(closed, { planId: 'pl-x' })).toThrowError(/未打开项目/);
  });

  it('坏入参门口拦：cadence 枚举外 / startAt 非整数 → E_INVALID_ARGS', () => {
    expect(() => savePlanIpc(deps, { platform: 'webnovel', cadence: 'hourly', startAt: START_AT } as never)).toThrowError(MzError);
    expect(() => savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: 1.5 } as never)).toThrowError(MzError);
  });
});

describe('publish-ipc · queueIpc（服务端推导入队，P2D-R1）', () => {
  /** 两章 done + 一章 draft；webnovel 日更 */
  function seedQueue(): { planId: string; done1: string; done2: string; draft: string } {
    const done1 = makeChapter('第一章 起', '定稿正文一。'.repeat(10));
    const done2 = makeChapter('第二章 承', '定稿正文二。'.repeat(10));
    const draft = makeChapter('第三章 草', '草稿正文。', 'draft');
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    return { planId: plan.id, done1, done2, draft };
  }

  it('② 两 done 入队带 plannedAt/minSize；draft 跳过进 warnings（带章号与标题可审）', () => {
    const { planId, draft } = seedQueue();
    const res = queueIpc(deps, { planId });
    expect(res.plan.id).toBe(planId);
    expect(res.items).toHaveLength(2);
    expect(res.items[0].ord).toBe(1);
    expect(res.items[0].plannedAt).toBe(START_AT);
    expect(res.items[1].plannedAt).toBe(START_AT + DAY_MS); // 纯毫秒加法，无 DST
    // language 走 pipelineParams 缺省 'zh' → 字符口径；webnovel chapterWords=2000 为 minSize
    expect(res.items[0].minSize).toBe(2000);
    expect(res.items[0].sizeUnit).toBe('字');
    expect(res.items[0].meetsSize).toBe(false); // 短章低于目标，机检如实
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('未定稿跳过');
    expect(res.warnings[0]).toContain('第三章 草');
    expect(res.items.every((i) => i.chapterId !== draft)).toBe(true);
  });

  it('② plan 不存在 / 非本项目 → E_NOT_FOUND（他书计划 id 不喂本项目队列）', () => {
    const { planId } = seedQueue();
    expect(() => queueIpc(deps, { planId: 'pl-none' })).toThrowError(/E_NOT_FOUND|不存在/);
    const otherRoot = mkdtempSync(join(tmpdir(), 'mz-p2d-pub-other-'));
    try {
      const otherPid = projects.create('别书', otherRoot).id;
      const foreign = plans.upsert({ projectId: otherPid, platform: 'fanqie', cadence: 'daily', intervalDays: 1, startAt: START_AT });
      const err = (() => {
        try {
          queueIpc(deps, { planId: foreign.id });
          return null;
        } catch (e) {
          return e as MzError;
        }
      })();
      expect(err).toBeInstanceOf(MzError);
      expect(err!.code).toBe('E_NOT_FOUND');
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
    void planId;
  });

  it('② 空库 → items 空、warnings 空（诚实空态不是错误）', () => {
    const plan = savePlanIpc(deps, { platform: 'fanqie', cadence: 'every2', startAt: START_AT });
    const res = queueIpc(deps, { planId: plan.id });
    expect(res.items).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.plan.intervalDays).toBe(2);
  });
});

describe('publish-ipc · stageIpc（批准即提交 + 服务端独立再清洗）', () => {
  function dirtyChapter(title: string): string {
    // '**' 强调残留 + 行尾空白：暂存文件读回必须两者皆无
    return makeChapter(title, `**起**雾从江面上漫过来。\n第二段尾部有空白   \n\n\n\n\n收束。`);
  }

  it('③ 批准两章 → 文件落 <root>/staging/webnovel/ 两 .txt，读回无 ** 无行尾空白；staged 携 edits 数与 sha256 contentHash', async () => {
    const a = dirtyChapter('第一章 起');
    const b = dirtyChapter('第二章 承');
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    const res = await stageIpc(deps, { planId: plan.id, chapterIds: [a, b] });
    expect(res.staged).toHaveLength(2);
    expect(res.skipped).toEqual([]);
    for (const entry of res.staged) {
      expect(entry.path.startsWith(join(root, 'staging', 'webnovel'))).toBe(true);
      expect(existsSync(entry.path)).toBe(true);
      const text = readFileSync(entry.path, 'utf8');
      expect(text).not.toContain('**');
      expect(text).not.toMatch(/[ \t]+$/m);
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.contentHash).toBe(sha256Hex(text)); // hash 对暂存文件本体，不是原稿
      expect(entry.edits).toBeGreaterThan(0);
    }
    expect(readdirSync(join(root, 'staging', 'webnovel'))).toHaveLength(2);
    // 文件名形如 <pad4(章id数字)>_<安全标题>.txt
    expect(readdirSync(join(root, 'staging', 'webnovel')).every((f) => /^\d{4}_.+\.txt$/.test(f))).toBe(true);
    // 库侧同批落 staging 行（未发布态）
    const rows = staging.listByPlan(plan.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.publishedAt === null)).toBe(true);
  });

  it('③ 请求含 draft 章 → skipped「未定稿（需 revised/done）」，不落文件；不存在的章 skipped 带真因', async () => {
    const done = dirtyChapter('第一章 起');
    const draft = makeChapter('第二章 草', '草稿。', 'draft');
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    const res = await stageIpc(deps, { planId: plan.id, chapterIds: [done, draft, '999'] });
    expect(res.staged).toHaveLength(1);
    const skippedIds = res.skipped.map((s) => s.chapterId);
    expect(skippedIds).toContain(draft);
    expect(res.skipped.find((s) => s.chapterId === draft)!.reason).toContain('未定稿');
    expect(res.skipped.find((s) => s.chapterId === '999')!.reason).toContain('不存在');
    expect(readdirSync(join(root, 'staging', 'webnovel'))).toHaveLength(1);
  });

  it('③ 空数组门口拦 + 他书/不存在 plan 同 gate（E_INVALID_ARGS / E_NOT_FOUND），不落任何文件', async () => {
    const done = dirtyChapter('第一章 起');
    void done;
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    await expect(stageIpc(deps, { planId: plan.id, chapterIds: [] })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(stageIpc(deps, { planId: 'pl-none', chapterIds: ['1'] })).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(existsSync(join(root, 'staging'))).toBe(false);
  });

  it('⑤ 幂等重跑（未 mark）：同文件覆盖、行数与暂存行数都不增', async () => {
    const a = dirtyChapter('第一章 起');
    const b = dirtyChapter('第二章 承');
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    const first = await stageIpc(deps, { planId: plan.id, chapterIds: [a, b] });
    const second = await stageIpc(deps, { planId: plan.id, chapterIds: [a, b] });
    expect(readdirSync(join(root, 'staging', 'webnovel'))).toHaveLength(2);
    expect(staging.listByPlan(plan.id)).toHaveLength(2);
    expect(second.staged.map((s) => s.path).sort()).toEqual(first.staged.map((s) => s.path).sort());
    // 二次清洗幂等（clean(clean(x)) 无新编辑）：第二次 edits 仍是对原稿的一次净账，文件字节不变
    expect(readFileSync(second.staged[0].path, 'utf8')).toBe(readFileSync(first.staged[0].path, 'utf8'));
  });

  it('④ mark → 再 stage 同章 → skipped「已发布不许换稿」（前置 published 集路由），文件与库行都不动；未 mark 的另一章照常重暂存', async () => {
    const a = dirtyChapter('第一章 起');
    const b = dirtyChapter('第二章 承');
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    const first = await stageIpc(deps, { planId: plan.id, chapterIds: [a, b] });
    const pathA = first.staged.find((s) => s.chapterId === a)!.path;
    const bytesBefore = readFileSync(pathA, 'utf8');
    markPublishedIpc(deps, { planId: plan.id, chapterId: a });
    const again = await stageIpc(deps, { planId: plan.id, chapterIds: [a, b] });
    expect(again.staged.map((s) => s.chapterId)).toEqual([b]);
    expect(again.skipped).toHaveLength(1);
    expect(again.skipped[0].chapterId).toBe(a);
    expect(again.skipped[0].reason).toContain('已发布');
    expect(readFileSync(pathA, 'utf8')).toBe(bytesBefore); // 已发布章的暂存文件一字未动
    expect(readdirSync(join(root, 'staging', 'webnovel'))).toHaveLength(2);
  });

  it('overseas 市场清洗真形：HTML 标签剥除（rule.market=overseas），cn 平台不动标签', async () => {
    const en = makeChapter('第一章 起', '正文<p>段</p>尾。', 'done');
    const p1 = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    const r1 = await stageIpc(deps, { planId: p1.id, chapterIds: [en] });
    expect(readFileSync(r1.staged[0].path, 'utf8')).not.toContain('<p>');
    const zh = makeChapter('第二章 标签', '正文<p>段</p>尾。', 'done');
    const p2 = savePlanIpc(deps, { platform: 'fanqie', cadence: 'daily', startAt: START_AT });
    const r2 = await stageIpc(deps, { planId: p2.id, chapterIds: [zh] });
    expect(readFileSync(r2.staged[0].path, 'utf8')).toContain('<p>'); // cn 市场标签保留（人工取舍）
  });

  it('标题安全化：非法字符剥净、空标题兜底「章+id」，路径永远在项目根内', async () => {
    const evil = makeChapter('坏/标题:\\毒?*名"', '正文。', 'done');
    const blank = makeChapter('   ', '正文。', 'done');
    const plan = savePlanIpc(deps, { platform: 'fanqie', cadence: 'daily', startAt: START_AT });
    const res = await stageIpc(deps, { planId: plan.id, chapterIds: [evil, blank] });
    expect(res.staged).toHaveLength(2);
    const names = res.staged.map((s) => s.path.split(/[\\/]/).pop()!);
    for (const n of names) {
      expect(n).not.toMatch(/[\\/:*?"<>|]/);
      expect(n).toMatch(/^\d{4}_.+\.txt$/);
    }
    expect(names.some((n) => n.includes(`章${blank}`))).toBe(true); // 空标题兜底 '章'+id
  });
});

describe('publish-ipc · markPublishedIpc', () => {
  it('④ mark 回 publishedAt 非 null；重复 mark 幂等回原值（重试不打乱发布时刻）', async () => {
    const a = makeChapter('第一章 起', '正文。');
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    await stageIpc(deps, { planId: plan.id, chapterIds: [a] });
    const row = markPublishedIpc(deps, { planId: plan.id, chapterId: a });
    expect(row.publishedAt).not.toBeNull();
    const again = markPublishedIpc(deps, { planId: plan.id, chapterId: a });
    expect(again.publishedAt).toBe(row.publishedAt);
    expect(again.id).toBe(row.id);
  });

  it('④ 未暂存的章谈何发布 → E_STAGING_STATE 直抛（repo 抛档在 publish-ipc 侧同样可达）', () => {
    const a = makeChapter('第一章 起', '正文。');
    const plan = savePlanIpc(deps, { platform: 'webnovel', cadence: 'daily', startAt: START_AT });
    const err = (() => {
      try {
        markPublishedIpc(deps, { planId: plan.id, chapterId: a });
        return null;
      } catch (e) {
        return e as MzError;
      }
    })();
    expect(err).toBeInstanceOf(MzError);
    expect(err!.code).toBe('E_STAGING_STATE');
  });

  it('plan 不存在 → E_NOT_FOUND；未打开项目 → E_INVALID_ARGS；坏 planId 类型门口拦', () => {
    expect(() => markPublishedIpc(deps, { planId: 'pl-none', chapterId: '1' })).toThrowError(MzError);
    const closed: PublishIpcDeps = { ...deps, getProject: () => null };
    expect(() => markPublishedIpc(closed, { planId: 'pl-x', chapterId: '1' })).toThrowError(/未打开项目/);
    expect(() => markPublishedIpc(deps, { planId: 42 as never, chapterId: '1' })).toThrowError(MzError);
  });
});
