/**
 * P0 生成流水线 T4：构思 / 架构 / 写手三个生成工具。
 *
 * ★ 这是「写作 Agent 能写作」的接线点：此前注册表里只有诊断/改写类工具，
 *   本文件把三个生成角色挂进同一个 ToolRegistry（registerExternal），
 *   Agent 与后续 IPC（T5）都能调到同一份实现。
 *
 * ★ 定稿主权（架构红线）：三个工具**只写 drafts 隔离区**，绝不触碰
 *   chapters / chapter_bodies。产物入草稿区后由人工 adopt/discard，
 *   所以 spec 一律 writes:true + danger:Precise + reversible:true（草稿可 discard）。
 *
 * ★ 契约校验（R4）：模型输出先 extractJson 再 zod safeParse，两步全部包
 *   try/catch——任何一步失败都返回结构化的 E_PIPELINE_PARSE（retryable），
 *   绝不让异常穿透 handler 炸掉 Agent 循环。
 *
 * ★ R2：ToolRegistry 没有公共 invoke，故除 registerPipelineTools 外还导出
 *   pipelineHandlers(deps)——测试与 T5 的 IPC 直接调这三个函数，
 *   注册进 registry 的也是同一份 handler，两处永不漂移。
 */
import type { Database } from 'better-sqlite3';
import type { ToolErrorCode, ToolHandler, ToolResult, ToolSpec } from '@shared/types/tool';
import { ToolDanger } from '@shared/types/tool';
import { MzError } from '@shared/types/ipc';
import type { ConceptOut, OutlineOut, PipelineCtx } from '@shared/types/pipeline';
import { ChapterPlanSchema, ConceptSchema, OutlineSchema } from '@shared/types/pipeline';
import { DraftRepo } from '../db/repos/draft-repo';
import { composeArchitectPrompt, composeConceptPrompt, composeWriterPrompt } from './prompts';
import { assembleWriterContext, type TrimTrace } from './assemble';
import { extractJson } from '../agent/host';
import type { ToolRegistry } from '../tools/registry';

/* ── 依赖契约 ──────────────────────────────────────────────────── */

/** 生成流水线用到的 LLM 子集（LlmClient.chat 结构兼容，测试可注入假实现） */
export interface PipelineLlm {
  chat(req: {
    messages: { role: 'system' | 'user'; content: string }[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; usage: { input: number; output: number } }>;
}

export interface PipelineDeps {
  db: Database;
  llm: PipelineLlm;
  getCtx(projectId: string): Promise<PipelineCtx>;
  /**
   * 当前项目 id（生产装配必给）。缺省时回退「库里最近更新的项目」——
   * 仅测试用的单项目内存库会走到这条回退。
   */
  projectId?: () => string | null;
  /**
   * 写手装配预算的上下文窗口（tokens，R11）。生产装配由 services 注入
   * 当前 provider 的 effectiveContextTokens；未注入时回退 DEFAULT_WRITER_WINDOW。
   * 做成函数而非定值：provider 可在运行期被重新配置/探测，窗口要跟着活。
   */
  budget?: () => number;
}

export interface PipelineHandlers {
  concept: ToolHandler;
  outline: ToolHandler;
  writeDraft: ToolHandler;
}

/* ── 常量 ──────────────────────────────────────────────────────── */

/** 角色温度：构思要发散、架构要收敛、写手居中 */
const TEMPERATURE = { concept: 1.05, architect: 0.7, writer: 0.9 } as const;

/**
 * 写手装配预算窗口的回退值（tokens）。R11：窗口优先取 deps.budget()
 * （services 注入当前 provider 的 effectiveContextTokens），未注入才用这个缺省。
 */
const DEFAULT_WRITER_WINDOW = 128_000;

/* ── 小工具 ────────────────────────────────────────────────────── */

function parseFailure(started: number, path: string): ToolResult {
  return {
    ok: false,
    durationMs: Date.now() - started,
    error: {
      code: 'E_PIPELINE_PARSE',
      message: '模型输出不符合契约：' + path,
      retryable: true,
    },
  };
}

function resolveProjectId(deps: PipelineDeps): string | null {
  if (deps.projectId) return deps.projectId();
  const row = deps.db
    .prepare('SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/** concept/outline 的 user 消息：项目参数 + premise 简述（章节级材料只归写手） */
function composeParamsUser(ctx: PipelineCtx): string {
  return [
    `【项目参数】题材：${ctx.genre}｜平台：${ctx.platform}｜单章目标：${ctx.chapterWords} 字｜全书目标：${ctx.targetWords} 字`,
    ctx.premise ? `【作者前提】${ctx.premise}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ── 三个 handler ──────────────────────────────────────────────── */

/**
 * 构造三个生成 handler（R2：测试与 IPC 直接调这里的返回值，
 * registerPipelineTools 挂进注册表的也是同一份）。
 */
export function pipelineHandlers(deps: PipelineDeps): PipelineHandlers {
  const drafts = new DraftRepo(deps.db);

  /** 构思：composeConceptPrompt → LLM → extractJson + ConceptSchema → 草稿区 */
  const concept: ToolHandler = async () => {
    const started = Date.now();
    const projectId = resolveProjectId(deps);
    if (!projectId) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: { code: 'E_INVALID_ARGS', message: '未打开项目，无法生成构思', retryable: false },
      };
    }
    const ctx0 = await deps.getCtx(projectId);
    const system = composeConceptPrompt(ctx0);
    const user = composeParamsUser(ctx0) + '\n\n本次任务：执行构思整理，只输出符合契约的纯 JSON。';
    const resp = await deps.llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: TEMPERATURE.concept,
      maxTokens: ctx0.chapterWords * 2,
    });

    let data: ConceptOut;
    try {
      const parsed = extractJson(resp.content);
      const r = ConceptSchema.safeParse(parsed);
      if (!r.success) return parseFailure(started, r.error.issues[0]?.path.join('.') ?? 'unknown');
      data = r.data;
    } catch {
      return parseFailure(started, 'JSON');
    }

    const draft = drafts.insert({
      projectId,
      role: 'concept',
      kind: 'concept',
      content: JSON.stringify(data),
    });
    return { ok: true, durationMs: Date.now() - started, data: { draftId: draft.id } };
  };

  /**
   * 架构：任务①全书规划过全量 OutlineSchema；
   * 任务②续写章纲（args 带 volumeIndex 或 continue 标志）只过 ChapterPlanSchema（R7），
   * 通过后与 getCtx 返回的既有 outline.volumes 合并成完整 OutlineOut 再入草稿。
   */
  const outline: ToolHandler = async (args) => {
    const started = Date.now();
    const projectId = resolveProjectId(deps);
    if (!projectId) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: { code: 'E_INVALID_ARGS', message: '未打开项目，无法生成大纲', retryable: false },
      };
    }
    const a = (args ?? {}) as { volumeIndex?: number; continue?: boolean };
    const isContinuation = a.continue === true || typeof a.volumeIndex === 'number';

    const ctx0 = await deps.getCtx(projectId);
    // ★ Carry-1：续写章纲以「已采纳的全书卷纲」为前置——没有它，
    //   合并出来的 OutlineOut.volumes 是空数组，等于让模型在没有卷纲的
    //   情况下续写。硬拦（不可重试）：重试不会凭空长出卷纲，先跑任务①。
    if (isContinuation && !ctx0.outline) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_PIPELINE_STATE',
          message: '续写章纲需要已采纳的全书卷纲：先执行生成卷纲章纲',
          retryable: false,
        },
      };
    }
    const system = composeArchitectPrompt(ctx0);
    const taskLine = isContinuation
      ? `本次任务：执行任务②——续写${typeof a.volumeIndex === 'number' ? `第 ${a.volumeIndex + 1} 卷` : '下一卷'}的章纲，只输出 {"chapterPlan":[…]}，不要重吐 volumes。`
      : '本次任务：执行任务①——全书规划，输出完整 volumes 与第一卷 chapterPlan。';
    const user = composeParamsUser(ctx0) + '\n\n' + taskLine;
    const resp = await deps.llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: TEMPERATURE.architect,
      maxTokens: ctx0.chapterWords * 2,
    });

    let data: OutlineOut;
    try {
      const parsed = extractJson(resp.content);
      if (isContinuation) {
        const r = ChapterPlanSchema.safeParse(parsed);
        if (!r.success) return parseFailure(started, r.error.issues[0]?.path.join('.') ?? 'unknown');
        // R7：续写只产 chapterPlan，卷纲沿用已定稿的既有 outline.volumes
        data = { volumes: ctx0.outline?.volumes ?? [], chapterPlan: r.data.chapterPlan };
      } else {
        const r = OutlineSchema.safeParse(parsed);
        if (!r.success) return parseFailure(started, r.error.issues[0]?.path.join('.') ?? 'unknown');
        data = r.data;
      }
    } catch {
      return parseFailure(started, 'JSON');
    }

    const draft = drafts.insert({
      projectId,
      role: 'architect',
      kind: 'outline',
      content: JSON.stringify(data),
    });
    return { ok: true, durationMs: Date.now() - started, data: { draftId: draft.id } };
  };

  /**
   * 写手：system 由 composeWriterPrompt 现场填（装配器返回的 system 是空串占位，
   * 见 assemble.ts 头注释——system 不归装配器管，章节级内容永不进 system）；
   * user 用 assembleWriterContext 的装配结果，trace 随 data 回传供审计。
   * 正文不是 JSON：content 即成品，跳过 extractJson/zod。
   */
  const writeDraft: ToolHandler = async (args) => {
    const started = Date.now();
    const projectId = resolveProjectId(deps);
    if (!projectId) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: { code: 'E_INVALID_ARGS', message: '未打开项目，无法起草正文', retryable: false },
      };
    }
    const a = (args ?? {}) as { chapterNo?: unknown; planItem?: unknown };
    const chapterNo = a.chapterNo;
    const planItem = a.planItem as { title?: unknown; hook?: unknown } | undefined;
    // ★ Carry-2：chapterNo 必须是正整数（Number.isInteger && >=1）。
    //   0 章、负章、2.5 章在书里不存在；这是调用方的缺陷而非模型可自纠的
    //   输入形状，故 retryable:false——回喂模型重试也变不出合法的章号。
    if (typeof chapterNo !== 'number' || !Number.isInteger(chapterNo) || chapterNo < 1) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: { code: 'E_INVALID_ARGS', message: 'chapterNo 必须是正整数（从 1 起算的章节序号）', retryable: false },
      };
    }
    if (!planItem || typeof planItem.title !== 'string' || typeof planItem.hook !== 'string' || !planItem.title.trim() || !planItem.hook.trim()) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: { code: 'E_INVALID_ARGS', message: 'planItem 必须是非空的 {title, hook}（本章章纲条目）', retryable: true },
      };
    }

    const ctx0 = await deps.getCtx(projectId);
    // 章节级字段（chapterNo/planItem）只进 ctx 供装配器装入 user，绝不进 system
    const ctxW: PipelineCtx = { ...ctx0, chapterNo, planItem: { title: planItem.title, hook: planItem.hook } };

    let user: string;
    let trace: TrimTrace[];
    try {
      const assembled = assembleWriterContext(ctxW, {
        // R11：窗口来自注入的 provider 配置，未注入才回退缺省——不再硬编码
        window: deps.budget?.() ?? DEFAULT_WRITER_WINDOW,
        // 输出预留与 maxTokens 同口径（tokens）：装配器据此收敛 user 预算
        outputReserve: ctxW.chapterWords * 2,
      });
      user = assembled.user;
      trace = assembled.trace;
    } catch (e) {
      // 装配失败如实转述真因，不吞不猜。★ I1（终评）：MzError 带真码
      //   （如 E_PROTECTED_OVERBUDGET）就透传真码——统一压平成 E_INTERNAL
      //   违反「错误码直报真因」全局约束；非 MzError 才回退 E_INTERNAL。
      const code: ToolErrorCode = e instanceof MzError ? (e.code as ToolErrorCode) : 'E_INTERNAL';
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: { code, message: e instanceof Error ? e.message : String(e), retryable: false },
      };
    }
    const system = composeWriterPrompt(ctxW);

    const resp = await deps.llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: TEMPERATURE.writer,
      maxTokens: ctxW.chapterWords * 2,
    });

    const content = resp.content.trim();
    if (!content) return parseFailure(started, 'content（正文为空）');

    const draft = drafts.insert({
      projectId,
      role: 'writer',
      kind: 'chapter',
      // chapterId = 章号字符串（库侧章 id 口径即「数字章号」，见 chapter-repo
      // createChapter 的 max+1 算号）。采纳时指向章尚不存在由 ipc.writeCanon
      // 的 R14 分支兜底：恰为下一章则建章写入，跳章则 E_PIPELINE_STATE 拒。
      chapterId: String(chapterNo),
      content,
    });
    return { ok: true, durationMs: Date.now() - started, data: { draftId: draft.id, trace } };
  };

  return { concept, outline, writeDraft };
}

/* ── specs ─────────────────────────────────────────────────────── */

/** 三个生成工具共用的 spec 底座：写的是草稿区，可 discard → Precise + reversible */
function genSpec(partial: Omit<ToolSpec, 'danger' | 'reversible' | 'writes' | 'maxAffectedBytes' | 'crossChapter' | 'idempotent'>): ToolSpec {
  return {
    ...partial,
    danger: ToolDanger.Precise,
    reversible: true,
    maxAffectedBytes: 0,
    crossChapter: false,
    idempotent: false,
    writes: true,
  };
}

function conceptSpec(): ToolSpec {
  return genSpec({
    name: 'pipeline_concept',
    displayName: '构思生成',
    description:
      '把作者已确认的设定收敛成结构化构思（3 个备选书名 / logline / 梗概 / 金手指 / 5 条脑洞分支）。' +
      '产出经契约校验后**只进草稿区**，由作者采纳后才算定稿——本工具永不直接写正稿。',
    params: [],
    costHintMs: 60_000,
  });
}

function outlineSpec(): ToolSpec {
  return genSpec({
    name: 'pipeline_outline',
    displayName: '大纲生成',
    description:
      '生成卷纲 + 章纲。不带参数 = 任务①全书规划（完整 volumes + 第一卷 chapterPlan）；' +
      '带 volumeIndex 或 continue = 任务②续写该卷章纲（只产 chapterPlan，与既有卷纲合并）。' +
      '产出经契约校验后只进草稿区，由作者采纳后才算定稿。',
    params: [
      {
        name: 'volumeIndex',
        type: 'number',
        required: false,
        description: '续写目标卷的 0 起索引。传了即执行任务②（续写章纲）；不传 = 任务①全书规划。',
      },
      {
        name: 'continue',
        type: 'boolean',
        required: false,
        description: '续写标志：true 等同传 volumeIndex（接续最近一卷）。两者都不传 = 全书规划。',
      },
    ],
    costHintMs: 60_000,
  });
}

function writeDraftSpec(): ToolSpec {
  return genSpec({
    name: 'pipeline_write_draft',
    displayName: '正文起草',
    description:
      '按本章章纲起草正文成品。上下文由装配器按预算装填（canon 与章纲永不裁剪，裁剪全部留痕）。' +
      '产出**只进草稿区**，由作者采纳后才进正稿——本工具永不直接写 chapters。',
    params: [
      { name: 'chapterNo', type: 'number', required: true, description: '章节序号（从 1 起算）。' },
      { name: 'planItem', type: 'object', required: true, description: '{title,hook} 本章章纲' },
    ],
    costHintMs: 120_000,
  });
}

/* ── 注册入口 ──────────────────────────────────────────────────── */

/**
 * 注册三个生成工具。
 * ★ 三道门（仿 registerExpertTool）：db / llm / getCtx 任一缺失就不注册——
 *   Agent 的工具列表里根本看不到它们，而不是注册一个必然失败的工具。
 * @returns false = 依赖不全，未注册
 */
export function registerPipelineTools(registry: ToolRegistry, deps: PipelineDeps): boolean {
  if (!deps || !deps.db || !deps.llm || !deps.getCtx) return false;
  const h = pipelineHandlers(deps);
  registry.registerExternal('pipeline_concept', conceptSpec(), h.concept);
  registry.registerExternal('pipeline_outline', outlineSpec(), h.outline);
  registry.registerExternal('pipeline_write_draft', writeDraftSpec(), h.writeDraft);
  return true;
}
