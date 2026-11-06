// tests/integration/pipeline-ipc-sentinel.test.ts
//
// P0 生成流水线 T5：IPC 六通道 + progress 推送 + 数据契约补真。
// A 组照抄 brief（health-inline-mark-wiring.test.ts:132 模式）：四处契约哨兵，
// readFileSync + 断言四个文件都含六通道名——本仓库反复出的事故形状是
// 「逻辑对、契约散在四处漏一处」（§5 坑 3），所以每一处都钉死。
// B/C/D 组走真 SQLite 内存库：六通道行为、adopt 语义（正文入正稿唯一入口）、
// Carry-1/Carry-2、R11 budget 注入、R10 v12 迁移与 projects 参数真列。
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ★ T6/R3：CH 扩展含 project:set-gen——立项参数通道同样四处齐改（ipc.ts / api.ts /
//   index.ts / register.ts），哨兵同步钉死，防「契约散在四处漏一处」。
// ★ P1-A T2：canon 三通道（canon:list/canon:add/canon:remove）入列，总 10 通道——
//   世界观铁律的管理通道同样受四处齐改铁律约束。
// ★ P2-A T3：覆盖层与技能表五通道（overlay:get/save/remove、skills:list/match）入列，
//   总 15 通道——覆盖层是文件不是表，但通道契约同样四处齐改，一个都不许漏。
// ★ P2-B T3：手改通道两枚（ledger:patch / ledger:remove）入列，总 17 通道——
//   共写一本账的入口与登记通道同受四处齐改铁律约束。
// ★ P2-B T5：状态矩阵通道两枚（charstate:list / charstate:set）入列，总 19 通道——
//   v15 章×人物快照的读写入口同样四处齐改，一个都不许漏。
const CH = ['pipeline:run-concept', 'pipeline:run-outline', 'pipeline:write-draft', 'pipeline:list-drafts', 'pipeline:adopt-draft', 'pipeline:discard-draft', 'project:set-gen', 'canon:list', 'canon:add', 'canon:remove', 'overlay:get', 'overlay:save', 'overlay:remove', 'skills:list', 'skills:match', 'ledger:patch', 'ledger:remove', 'charstate:list', 'charstate:set'];
const FILES = ['src/shared/types/ipc.ts', 'src/preload/api.ts', 'src/preload/index.ts', 'src/main/ipc/register.ts'];

describe('pipeline IPC 四处契约哨兵', () => {
  for (const f of FILES) {
    const src = readFileSync(join(process.cwd(), f), 'utf8');
    for (const ch of CH) it(`${f} 含 ${ch}`, () => expect(src).toContain(ch));
  }
  it('push 通道登记', () => {
    expect(readFileSync(join(process.cwd(), 'src/shared/types/ipc.ts'), 'utf8')).toContain('pipeline:progress');
  });
});

/* ── B/C/D 组：真库行为 ─────────────────────────────────────────── */

import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo } from '@main/db/repos/daily-write-repo';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { pipelineHandlers, type PipelineDeps } from '@main/pipeline/tools';
import {
  runConcept,
  runOutline,
  writeDraft,
  listDrafts,
  adoptDraft,
  discardDraft,
  type PipelineIpcServices,
} from '@main/pipeline/ipc';
import { MzError } from '@shared/types/ipc';
import type { ToolContext } from '@shared/types/tool';
import type { OutlineOut, PipelineCtx } from '@shared/types/pipeline';
// ★ P2-A T3：覆盖层与技能表五通道的业务实现（register.ts 只做一行式委托，
//   行为用例直调这些函数——与 B/C/D 组"测 ipc 业务函数、不 mock ipcMain"同款口径）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  overlayGet,
  overlaySave,
  overlayRemove,
  skillsList,
  skillsMatch,
} from '@main/pipeline/overlay-ipc';
import { CRAFT_SKILLS } from '@main/pipeline/craft-skills';

const CONCEPT_JSON = JSON.stringify({ titles: ['雾隐山海', '玉佩三千年', '山海崩'], logline: '时间秘境换回一座城', synopsis: '梗概'.repeat(20), goldenFinger: '玉佩秘境 3000:3，代价是被遗忘', hooks: ['h1', 'h2', 'h3', 'h4', 'h5'] });
const OUTLINE_JSON = JSON.stringify({ volumes: [{ title: '第一卷', goal: '出山+灭世伏笔', targetChapters: 30 }], chapterPlan: [{ title: '雾中拾玉', hook: '玉佩里传出心跳声' }] });
const CHAPTER_PLAN_JSON = JSON.stringify({ chapterPlan: [{ title: '第二卷首章', hook: '旧敌登门' }] });
const PLAN_ITEM = { title: '雾中拾玉', hook: '玉佩里传出心跳声' };

function toolCtx(): ToolContext {
  return {
    runId: 'sentinel',
    stepNo: 0,
    dryRun: true,
    requireCheckpoint: async () => '',
    signal: new AbortController().signal,
    logger: () => {},
  };
}

interface EnvOpts {
  /** llm 固定回复（默认 CONCEPT_JSON） */
  llmContent?: string;
  /** 覆盖 getCtx 的字段 */
  ctx?: Partial<PipelineCtx>;
  /** R11：注入的窗口预算 */
  budget?: () => number;
  /** currentProjectId() 的返回（默认新建项目 id） */
  currentProjectId?: string | null;
}

function makeEnv(opts: EnvOpts = {}) {
  const db = new Database(':memory:');
  migrate(db);
  const projects = new ProjectRepo(db);
  const pid = projects.create('测试书', '/tmp/t5', 300000).id;
  const chapterRepo = new ChapterRepo(db, new DailyWriteRepo(db));
  const drafts = new DraftRepo(db);
  const baseCtx: PipelineCtx = { genre: '古风玄幻', platform: '番茄', chapterWords: 2000, targetWords: 300000, premise: 'p', canon: [], language: 'zh', foreshadowLines: [], castLines: [] };
  const deps: PipelineDeps = {
    db,
    projectId: () => pid,
    llm: { chat: async () => ({ content: opts.llmContent ?? CONCEPT_JSON, usage: { input: 1, output: 1 } }) },
    getCtx: async () => ({ ...baseCtx, ...opts.ctx }),
    budget: opts.budget,
  };
  const handlers = pipelineHandlers(deps);
  const sent: { ch: string; p: Record<string, unknown> }[] = [];
  let edits = 0;
  const services = {
    db,
    chapterRepo,
    push: { send: (ch: string, p: Record<string, unknown>) => { sent.push({ ch, p }); } },
    backup: { noteEdit: () => { edits += 1; } },
    currentProjectId: () => (opts.currentProjectId === undefined ? pid : opts.currentProjectId),
    pipelineHandlers: () => handlers,
  } as unknown as PipelineIpcServices;
  const progress = () => sent.filter((x) => x.ch === 'pipeline:progress').map((x) => x.p as { projectId: string; step: string; state: string; detail?: string });
  return { db, pid, projects, chapterRepo, drafts, handlers, sent, services, progress, editCount: () => edits };
}

describe('B. IPC 六通道行为（真库）', () => {
  it('run-concept：progress running→done，草稿只进隔离区', async () => {
    const { services, pid, drafts, progress } = makeEnv();
    const r = await runConcept(services, pid);
    expect(typeof r.draftId).toBe('string');
    expect(drafts.list(pid, 'pending')[0].kind).toBe('concept');
    const prog = progress();
    expect(prog.map((p) => p.state)).toEqual(['running', 'done']);
    expect(prog.every((p) => p.projectId === pid && p.step === 'concept')).toBe(true);
  });

  it('run-concept：模型输出坏契约 → failed detail 带真因（code+message，不拟人化）', async () => {
    const { services, pid, progress } = makeEnv({ llmContent: '不是 JSON {{{' });
    await expect(runConcept(services, pid)).rejects.toMatchObject({ code: 'E_PIPELINE_PARSE' });
    const failed = progress().find((p) => p.state === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.detail).toContain('E_PIPELINE_PARSE');
    expect(failed!.detail).toContain('模型输出不符合契约');
  });

  it('run-concept：projectId 与当前打开项目不一致 → E_INVALID_ARGS 拒绝', async () => {
    const { services, pid } = makeEnv();
    await expect(runConcept(services, 'proj_别的书')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    void pid;
  });

  it('run-outline：不带 volumeIndex = 全书规划入草稿（step=outline）', async () => {
    const { services, pid, drafts, progress } = makeEnv({ llmContent: OUTLINE_JSON });
    const r = await runOutline(services, { projectId: pid });
    expect(typeof r.draftId).toBe('string');
    expect(drafts.list(pid, 'pending')[0].kind).toBe('outline');
    expect(progress().map((p) => p.step)).toEqual(['outline', 'outline']);
  });

  it('write-draft：正文入草稿区（step=draft），不碰正稿', async () => {
    const { services, pid, drafts, chapterRepo, progress } = makeEnv({ llmContent: '雾从江面上漫过来。' });
    const r = await writeDraft(services, { projectId: pid, chapterNo: 1, planItem: PLAN_ITEM });
    const d = drafts.list(pid, 'pending')[0];
    expect(d.id).toBe(r.draftId);
    expect(d.kind).toBe('chapter');
    expect(d.content).toContain('雾从江面上漫过来');
    expect(chapterRepo.listMeta(pid)).toHaveLength(0);
    expect(progress().map((p) => p.state)).toEqual(['running', 'done']);
  });

  it('write-draft：chapterNo 非正整数 → E_INVALID_ARGS 且 retryable:false（Carry-2）', async () => {
    const { services, pid } = makeEnv();
    for (const bad of [0, -1, 1.5, NaN]) {
      const e = await writeDraft(services, { projectId: pid, chapterNo: bad, planItem: PLAN_ITEM }).catch((x) => x);
      expect(e, `chapterNo=${bad} 应被拒`).toBeInstanceOf(MzError);
      expect(e.code).toBe('E_INVALID_ARGS');
      expect((e.detail as { retryable: boolean }).retryable).toBe(false);
    }
  });

  it('list-drafts：status 过滤直连 repo；非法 status 被拒', async () => {
    const { services, pid, drafts } = makeEnv();
    drafts.insert({ projectId: pid, role: 'concept', kind: 'concept', content: '{}' });
    const d2 = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: 'x' });
    drafts.setStatus(d2.id, 'discarded');
    expect(listDrafts(services, { projectId: pid })).toHaveLength(2);
    expect(listDrafts(services, { projectId: pid, status: 'pending' })).toHaveLength(1);
    expect(listDrafts(services, { projectId: pid, status: 'discarded' })[0].id).toBe(d2.id);
    expect(() => listDrafts(services, { projectId: pid, status: 'bogus' as never })).toThrowError(MzError);
  });

  it('adopt-draft：kind=chapter 无 chapterId → createChapter 后 updateBody（正文入正稿唯一入口）', async () => {
    const { services, pid, drafts, chapterRepo, sent, progress, editCount } = makeEnv();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '雾漫过来，这是第一章正文。' });
    const r = await adoptDraft(services, d.id);
    expect(r.chapterId).toBeTruthy();
    expect(chapterRepo.getBody(pid, r.chapterId!)).toBe('雾漫过来，这是第一章正文。');
    expect(drafts.get(d.id)!.status).toBe('adopted');
    expect(editCount()).toBe(1);
    expect(sent.some((x) => x.ch === 'chapter:changed')).toBe(true);
    const prog = progress();
    expect(prog.map((p) => p.state)).toEqual(['running', 'done']);
    expect(prog[0].step).toBe('adopt');
  });

  it('adopt-draft：kind=chapter 带 chapterId 指向已有章 → 写进该章', async () => {
    const { services, pid, drafts, chapterRepo } = makeEnv();
    const meta = chapterRepo.createChapter(pid, { title: '第一章' });
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '采纳后的新正文。', chapterId: meta.id });
    const r = await adoptDraft(services, d.id);
    expect(r.chapterId).toBe(meta.id);
    expect(chapterRepo.getBody(pid, meta.id)).toBe('采纳后的新正文。');
    expect(chapterRepo.listMeta(pid)).toHaveLength(1);
  });

  it('adopt-draft：空库 + chapterId="1"（流水线草稿形状）→ R14 回退建章，id 自然对齐（终评 C1）', async () => {
    const { services, pid, drafts, chapterRepo, editCount, sent } = makeEnv();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '第一章正文。', chapterId: '1' });
    const r = await adoptDraft(services, d.id);
    expect(r.chapterId).toBe('1');
    expect(chapterRepo.getBody(pid, '1')).toBe('第一章正文。');
    expect(chapterRepo.count(pid)).toBe(1);
    expect(drafts.get(d.id)!.status).toBe('adopted');
    expect(editCount()).toBe(1);
    expect(sent.some((x) => x.ch === 'chapter:changed')).toBe(true);
  });

  it('adopt-draft：chapterId 恰为现有章数+1 → R14 回退建章后写入（终评 C1）', async () => {
    const { services, pid, drafts, chapterRepo } = makeEnv();
    chapterRepo.createChapter(pid, { title: '第一章' });
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '第二章正文。', chapterId: '2' });
    const r = await adoptDraft(services, d.id);
    expect(r.chapterId).toBe('2');
    expect(chapterRepo.getBody(pid, '2')).toBe('第二章正文。');
    expect(chapterRepo.count(pid)).toBe(2);
  });

  it('adopt-draft：跳章草稿 → E_PIPELINE_STATE 直报不能跳章，正稿与草稿都不动（R14 防跳章）', async () => {
    const { services, pid, drafts, chapterRepo, progress } = makeEnv();
    chapterRepo.createChapter(pid, { title: '第一章' });
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '第三章正文。', chapterId: '3' });
    const e = await adoptDraft(services, d.id).catch((x) => x);
    expect(e).toBeInstanceOf(MzError);
    expect(e.code).toBe('E_PIPELINE_STATE');
    expect(e.message).toBe('不能跳章：本书现有章号到 1，第 3 章尚不存在，请先写第 2 章');
    expect((e.detail as { retryable: boolean }).retryable).toBe(false);
    expect(chapterRepo.count(pid)).toBe(1);                 // 正稿未被写
    expect(drafts.get(d.id)!.status).toBe('pending');       // 草稿保持 pending，可修正后再采纳
    expect(progress().find((p) => p.state === 'failed')!.detail).toContain('不能跳章');
  });

  it('adopt-draft：kind=concept/outline 仅标记 adopted，不碰正稿', async () => {
    const { services, pid, drafts, chapterRepo } = makeEnv();
    const d = drafts.insert({ projectId: pid, role: 'concept', kind: 'concept', content: CONCEPT_JSON });
    const r = await adoptDraft(services, d.id);
    expect(r).toEqual({ chapterId: null });
    expect(drafts.get(d.id)!.status).toBe('adopted');
    expect(chapterRepo.listMeta(pid)).toHaveLength(0);
  });

  it('adopt-draft：已终态草稿再 adopt → E_DRAFT_STATE，正稿不被写', async () => {
    const { services, pid, drafts, chapterRepo } = makeEnv();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '正文' });
    await adoptDraft(services, d.id);
    const chaptersAfterFirst = chapterRepo.listMeta(pid).length;
    await expect(adoptDraft(services, d.id)).rejects.toMatchObject({ code: 'E_DRAFT_STATE' });
    expect(chapterRepo.listMeta(pid)).toHaveLength(chaptersAfterFirst);
  });

  it('discard-draft：pending → discarded，返回 {ok:true}', async () => {
    const { services, pid, drafts } = makeEnv();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '废稿' });
    await expect(discardDraft(services, d.id)).resolves.toEqual({ ok: true });
    expect(drafts.get(d.id)!.status).toBe('discarded');
  });
});

describe('C. Carry-1 与 R11（handler 层）', () => {
  it('Carry-1：无已采纳全书卷纲就续写 → E_PIPELINE_STATE，文案逐字', async () => {
    const { handlers } = makeEnv({ llmContent: CHAPTER_PLAN_JSON });
    const res = await handlers.outline({ volumeIndex: 1 }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({
      code: 'E_PIPELINE_STATE',
      message: '续写章纲需要已采纳的全书卷纲：先执行生成卷纲章纲',
      retryable: false,
    });
  });

  it('Carry-1 经 IPC：runOutline 续写无卷纲 → 拒且 failed detail 带真因', async () => {
    const { services, pid, progress } = makeEnv({ llmContent: CHAPTER_PLAN_JSON });
    await expect(runOutline(services, { projectId: pid, volumeIndex: 1 })).rejects.toMatchObject({ code: 'E_PIPELINE_STATE' });
    expect(progress().find((p) => p.state === 'failed')!.detail).toContain('续写章纲需要已采纳的全书卷纲');
  });

  it('Carry-1 满足：已有卷纲时续写只过 ChapterPlanSchema 并合并 volumes', async () => {
    const outline: OutlineOut = JSON.parse(OUTLINE_JSON);
    const { handlers, drafts, pid } = makeEnv({ llmContent: CHAPTER_PLAN_JSON, ctx: { outline } });
    const res = await handlers.outline({ volumeIndex: 1 }, toolCtx());
    expect(res.ok).toBe(true);
    const saved: OutlineOut = JSON.parse(drafts.list(pid, 'pending')[0].content);
    expect(saved.volumes).toEqual(outline.volumes);
    expect(saved.chapterPlan[0].title).toBe('第二卷首章');
  });

  it('Carry-2：chapterNo 校验正整数（Number.isInteger && >=1）', async () => {
    const { handlers } = makeEnv();
    for (const bad of [0, -3, 2.5, NaN, Infinity]) {
      const res = await handlers.writeDraft({ chapterNo: bad, planItem: PLAN_ITEM }, toolCtx());
      expect(res.ok, `chapterNo=${bad} 应被拒`).toBe(false);
      expect(res.error).toMatchObject({ code: 'E_INVALID_ARGS', retryable: false });
    }
  });

  it('R11：budget 注入生效——窗口过小触发保护层硬失败（真因透传，I1：真码不压平）', async () => {
    const { handlers } = makeEnv({ budget: () => 10, llmContent: '正文' });
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: PLAN_ITEM }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('E_PROTECTED_OVERBUDGET');
    expect(res.error?.message).toContain('超保护配额');
  });

  it('R11：未注入 budget 回退 128_000，正常装配不报错', async () => {
    const { handlers } = makeEnv({ llmContent: '雾从江面上漫过来。' });
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: PLAN_ITEM }, toolCtx());
    expect(res.ok).toBe(true);
  });
});

describe('E. R15/R16 空洞库（删章/导入书导致章号非连续，count 口径失真）', () => {
  /** 直接用 ChapterRepo.insert 造 {id:'1'},{id:'3'} 空洞库（nextNo=4） */
  function makeHoleEnv() {
    const env = makeEnv();
    for (const [id, order] of [['1', 0], ['3', 1]] as const) {
      env.chapterRepo.insert({
        id,
        projectId: env.pid,
        title: `第${id}章`,
        volumeId: null,
        order,
        status: 'draft',
        body: '',
      });
    }
    return env;
  }

  it('采纳 chapterId "2"（<nextNo 且指向章不存在）→ E_PIPELINE_STATE 空洞号直报，正稿草稿都不动（R16）', async () => {
    const { services, pid, drafts, chapterRepo, progress } = makeHoleEnv();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '第二章正文。', chapterId: '2' });
    const e = await adoptDraft(services, d.id).catch((x) => x);
    expect(e).toBeInstanceOf(MzError);
    expect(e.code).toBe('E_PIPELINE_STATE');
    expect(e.message).toBe('第 2 章是空洞号（已被删除或从未存在）：下一个可写章号是 4');
    expect(e.message).toContain('空洞号');
    expect((e.detail as { retryable: boolean }).retryable).toBe(false);
    expect(chapterRepo.listMeta(pid).map((m) => m.id)).toEqual(['1', '3']); // 正稿未被动
    expect(drafts.get(d.id)!.status).toBe('pending');                        // 草稿保持 pending
    expect(progress().find((p) => p.state === 'failed')!.detail).toContain('空洞号');
  });

  it('采纳 chapterId "4"（==nextNo）→ 回退建章 id "4" 且正文写入（R15 基准=最大可解析号+1）', async () => {
    const { services, pid, drafts, chapterRepo, editCount, sent } = makeHoleEnv();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '第四章正文。', chapterId: '4' });
    const r = await adoptDraft(services, d.id);
    expect(r.chapterId).toBe('4');
    expect(chapterRepo.getBody(pid, '4')).toBe('第四章正文。');
    expect(chapterRepo.listMeta(pid).map((m) => m.id)).toEqual(['1', '3', '4']);
    expect(drafts.get(d.id)!.status).toBe('adopted');
    expect(editCount()).toBe(1);
    expect(sent.some((x) => x.ch === 'chapter:changed')).toBe(true);
  });

  it('采纳 chapterId "6"（>nextNo）→ 防跳章硬拦，文案用 nextNo 口径（R15）', async () => {
    const { services, pid, drafts, chapterRepo } = makeHoleEnv();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '第六章正文。', chapterId: '6' });
    const e = await adoptDraft(services, d.id).catch((x) => x);
    expect(e).toBeInstanceOf(MzError);
    expect(e.code).toBe('E_PIPELINE_STATE');
    expect(e.message).toBe('不能跳章：本书现有章号到 3，第 6 章尚不存在，请先写第 4 章');
    expect((e.detail as { retryable: boolean }).retryable).toBe(false);
    expect(chapterRepo.listMeta(pid).map((m) => m.id)).toEqual(['1', '3']); // 正稿未被动
    expect(drafts.get(d.id)!.status).toBe('pending');
  });

  it('createChapter 返回不对齐 id → E_PIPELINE_STATE 建章对齐失败，updateBody 不被调（R15 断言在写入前）', async () => {
    const env = makeEnv();
    const { services, pid, drafts } = env;
    let updateBodyCalled = false;
    const repo = services.chapterRepo;
    // 假 createChapter：库侧建成 id '99'（与期望的第 1 章不对齐）
    repo.createChapter = () => ({
      id: '99',
      projectId: pid,
      title: '',
      volumeId: null,
      order: 0,
      status: 'draft',
      charCount: 0,
      rev: 1,
      updatedAt: Date.now(),
    });
    const origUpdateBody = repo.updateBody.bind(repo);
    repo.updateBody = (...args: Parameters<typeof origUpdateBody>) => {
      updateBodyCalled = true;
      return origUpdateBody(...args);
    };
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '第一章正文。', chapterId: '1' });
    const e = await adoptDraft(services, d.id).catch((x) => x);
    expect(e).toBeInstanceOf(MzError);
    expect(e.code).toBe('E_PIPELINE_STATE');
    expect(e.message).toBe('建章对齐失败：期望第 1 章，库侧建成第 99 章');
    expect((e.detail as { retryable: boolean }).retryable).toBe(false);
    expect(updateBodyCalled).toBe(false);                    // 断言在 updateBody 之前，不留半程正文
    expect(drafts.get(d.id)!.status).toBe('pending');        // 草稿未终态化
  });
});

describe('D. R10 数据契约补真（v12 迁移 + projects 参数真列）', () => {
  it('v12：projects 增 genre/platform/chapter_words，旧列一根不动（只增不改）', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(currentVersion(db)).toBeGreaterThanOrEqual(12);
    const cols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['genre', 'platform', 'chapter_words']));
    expect(cols).toEqual(expect.arrayContaining(['id', 'name', 'root_dir', 'created_at', 'updated_at', 'target_words', 'price_per_k']));
  });

  it('ProjectRepo.pipelineParams：缺省 = 未设定（空串/0），setPipelineParams 后可读回真值', () => {
    const db = new Database(':memory:');
    migrate(db);
    const projects = new ProjectRepo(db);
    const pid = projects.create('测试书', '/tmp/d').id;
    expect(projects.pipelineParams(pid)).toEqual({ genre: '', platform: '', chapterWords: 0, language: 'zh' });
    projects.setPipelineParams(pid, { genre: '古风玄幻', platform: '番茄', chapterWords: 8000 });
    expect(projects.pipelineParams(pid)).toEqual({ genre: '古风玄幻', platform: '番茄', chapterWords: 8000, language: 'zh' });
    // 部分更新：未传字段保持原值
    projects.setPipelineParams(pid, { chapterWords: 6000 });
    expect(projects.pipelineParams(pid)).toEqual({ genre: '古风玄幻', platform: '番茄', chapterWords: 6000, language: 'zh' });
    // 非法值被拒
    expect(() => projects.setPipelineParams(pid, { chapterWords: -1 })).toThrow();
    expect(() => projects.setPipelineParams(pid, { chapterWords: 1.5 })).toThrow();
  });
});

/* ── F 组：P2-A T3 覆盖层与技能表五通道行为 ─────────────────────── */

describe('F. P2-A T3 覆盖层与技能表五通道（行为）', () => {
  // 覆盖层是文件不是表：行为用例喂真 tmp 数据目录（mkdtemp），用完即删。
  const dirs: string[] = [];
  async function tmpDataDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'mz-overlay-sentinel-'));
    dirs.push(d);
    return d;
  }
  afterEach(async () => {
    while (dirs.length > 0) {
      const d = dirs.shift();
      if (d) await rm(d, { recursive: true, force: true });
    }
  });

  it('overlay:save → overlay:get 往返（温度与附加要求逐字回读；template 是默认模板而非当前内容）', async () => {
    const dir = await tmpDataDir();
    await expect(
      overlaySave(dir, { role: 'writer', temperature: 0.4, additional: '多写动作，少写心理。' }),
    ).resolves.toEqual({ ok: true });
    const r = await overlayGet(dir, { role: 'writer' });
    expect(r.exists).toBe(true);
    expect(r.overlay).toEqual({ role: 'writer', temperature: 0.4, additional: '多写动作，少写心理。' });
    expect(r.warnings).toEqual([]);
    // template = serializeOverlay 生成的默认模板（UI「恢复默认」预览用）：温度留空、附加要求为空
    expect(r.template).toContain('温度：');
    expect(r.template).toContain('## 附加要求');
    expect(r.template).not.toContain('多写动作');
  });

  it('overlay:remove → existed:true，再 get exists:false（默认态零告警）；再删 existed:false（幂等）', async () => {
    const dir = await tmpDataDir();
    await overlaySave(dir, { role: 'concept', temperature: null, additional: 'x' });
    await expect(overlayRemove(dir, { role: 'concept' })).resolves.toEqual({ existed: true });
    const r = await overlayGet(dir, { role: 'concept' });
    expect(r).toMatchObject({ exists: false, overlay: null, warnings: [] });
    await expect(overlayRemove(dir, { role: 'concept' })).resolves.toEqual({ existed: false });
  });

  it('★ 按角色分派钉（carry T2 minor-2）：save writer 后 get concept 的 overlay 仍是 null', async () => {
    const dir = await tmpDataDir();
    await overlaySave(dir, { role: 'writer', temperature: 0.2, additional: '只给写手的附加要求' });
    const concept = await overlayGet(dir, { role: 'concept' });
    expect(concept.exists).toBe(false);
    expect(concept.overlay).toBeNull();
    const architect = await overlayGet(dir, { role: 'architect' });
    expect(architect.overlay).toBeNull();
    // 写手自己的角色仍在——钉的是"按角色分派"而不是"全局生效"
    const writer = await overlayGet(dir, { role: 'writer' });
    expect(writer.overlay?.additional).toBe('只给写手的附加要求');
  });

  it('overlay:save 温度非法 → E_INVALID_ARGS 且 retryable:false；null=沿用内置是合法态', async () => {
    const dir = await tmpDataDir();
    for (const bad of [2.5, -0.1, NaN, Infinity]) {
      const e = await overlaySave(dir, { role: 'writer', temperature: bad, additional: '' }).catch((x) => x);
      expect(e, `temperature=${bad} 应被拒`).toBeInstanceOf(MzError);
      expect(e.code).toBe('E_INVALID_ARGS');
      expect((e.detail as { retryable: boolean }).retryable).toBe(false);
    }
    await expect(overlaySave(dir, { role: 'writer', temperature: null, additional: 'y' })).resolves.toEqual({ ok: true });
  });

  it('覆盖层只开 concept/architect/writer：非法角色 → E_INVALID_ARGS', async () => {
    const dir = await tmpDataDir();
    for (const bad of ['polisher', 'editor', '']) {
      const e = await overlayGet(dir, { role: bad as never }).catch((x) => x);
      expect(e, `role=${bad} 应被拒`).toBeInstanceOf(MzError);
      expect(e.code).toBe('E_INVALID_ARGS');
      expect((e.detail as { retryable: boolean }).retryable).toBe(false);
    }
    await expect(overlayRemove(dir, { role: 'polisher' as never })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(
      overlaySave(dir, { role: 'polisher' as never, temperature: null, additional: '' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('skills:list = CRAFT_SKILLS 注册序全量', () => {
    const list = skillsList();
    expect(list).toHaveLength(6);
    expect(list.map((s) => s.id)).toEqual(CRAFT_SKILLS.map((s) => s.id));
  });

  it('skills:match 命中/零命中/角色隔离；非法角色 → E_INVALID_ARGS', () => {
    const hit = skillsMatch({ text: '这一章结尾要留钩子', role: 'writer' });
    expect(hit.ids).toEqual(['chapter-hook']);
    expect(hit.titles).toEqual(['章末钩子三件套']);
    expect(skillsMatch({ text: '今天天气不错', role: 'writer' })).toEqual({ ids: [], titles: [] });
    // 角色隔离：chapter-hook 只属写手，架构师同样触发词零命中
    expect(skillsMatch({ text: '钩子', role: 'architect' }).ids).toEqual([]);
    // 架构师命中：卷纲触发 causal-outline
    expect(skillsMatch({ text: '先排卷纲', role: 'architect' }).ids).toEqual(['causal-outline']);
    for (const bad of ['concept', 'polisher', 'bogus']) {
      // skills:match 是同步纯函数：非法角色直接抛 MzError（不是 reject）
      const e = (() => {
        try {
          skillsMatch({ text: 'x', role: bad as never });
          return null;
        } catch (err) {
          return err as MzError;
        }
      })();
      expect(e, `role=${bad} 应被拒`).toBeInstanceOf(MzError);
      expect(e!.code).toBe('E_INVALID_ARGS');
      expect((e!.detail as { retryable: boolean }).retryable).toBe(false);
    }
  });
});
