/**
 * 拆书报告服务（P2-C T5）。
 *
 * 两段式，诚实分层：
 *  ① 结构统计（零 token，秒出）——复用既有 `distillReferenceWork`（纯确定性
 *     统计蒸馏，danger-1 只读契约）+ `analyze`（metrics-engine 纯计算），
 *     拼出 TeardownStructure 落 teardown_reports.structure_json。**全程不调 LLM**，
 *     入参没有 llm 就是这条承诺的可执行证据。
 *  ② 八维精读（按需，花 token）——composeTeardownPrompt + teardown 覆盖层 →
 *     llm.chat（温度 0.7，可被覆盖层「温度：」行覆盖）→ extractJson →
 *     TeardownDimsSchema.safeParse → setDimensions 回填，source='live'。
 *     任何一环失败（无 Key / 请求错 / 产出坏）都**如实回落演示兜底**：从结构
 *     统计可确定的维度拼统计句，其余维度填「演示·未精读」，source='demo'，
 *     绝不把演示冒充模型精读（DRD §7 诚实纪律，同 idea-service 的抽卡兜底）。
 *
 * ★ 全局子系统：拆书报告在书籍立项之前就存在，不键 project；repo 由调用方
 *   注入（生产走 services.teardownDeps()，测试走 :memory: 库）。
 * ★ ToolContext 构造照 pipeline/ipc.ts 的 toolCtx() 同款最小形态：只读工具不
 *   走快照通道，requireCheckpoint 直报错而非静默；digest 的 DigestDeps 只要求
 *   currentProjectId()，按只读契约喂 () => null。
 * ★ 版权守卫在上游：distillReferenceWork 的 LCS≤20 合规检查原样生效，
 *   本模块只消费其产出，不另抄原文。
 */
import { z } from 'zod';
import { MzError } from '@shared/types/ipc';
import type { ToolContext } from '@shared/types/tool';
import { analyze } from '@shared/metrics-engine';
import { TeardownDimsSchema, TEARDOWN_DEMO_MARK } from '@shared/types/inspiration';
import type { TeardownDims, TeardownStructure, InspirationCard } from '@shared/types/inspiration';
import type { TeardownRepo } from '../db/repos/teardown-repo';
import type { InspirationRepo } from '../db/repos/inspiration-repo';
import type { PipelineLlm } from '../pipeline/tools';
import type { PromptOverlay, PromptOverlayRole } from '../pipeline/overlay';
import { composeTeardownPrompt } from '../pipeline/prompts';
import { extractJson } from '../agent/host';
import { distillReferenceWork } from '../tools/impl/digest';

/** 精读内置温度（架构收敛档，同 TEMPERATURE.teardown；可被 teardown 覆盖层「温度：」行覆盖）。 */
const TEARDOWN_TEMPERATURE = 0.7;

/** 拆书八维的固定维序（TeardownDimsSchema 键序逐字一致，UI 与演示兜底共用）。 */
export const TEARDOWN_DIMENSIONS: (keyof TeardownDims)[] = [
  '定位',
  '结构',
  '节奏',
  '爽点钩子',
  '伏笔',
  '人物',
  '文风',
  '可借鉴',
];

/**
 * 最小 ToolContext（照 pipeline/ipc.ts 的 toolCtx() 形状）：digest 是 danger-1
 * 只读工具，本路径不落正文、不进快照通道——requireCheckpoint 被调用即直报错，
 * 这正是「只读契约没被悄悄越过去」的哨。
 */
function toolCtx(): ToolContext {
  return {
    runId: 'teardown-service',
    stepNo: 0,
    dryRun: true,
    requireCheckpoint: async () => {
      throw new MzError('E_CHECKPOINT_FAILED', '拆书结构统计是只读链路，不走工具快照通道');
    },
    signal: new AbortController().signal,
    logger: () => undefined,
  };
}

/**
 * ① 结构统计：零 token——distillReferenceWork + analyze 都是纯计算。
 * ★ R3 裁决：text 先、title 后（匹配测试用法）。第三参 td 注入落库 repo：
 *   brief 原测两参形态拿不到测试自造的 :memory: 库（td.get 恒空），
 *   以可执行契约为准补依赖参，前两参序逐字照 R3。
 */
export async function teardownStructure(
  text: string,
  title: string,
  td: TeardownRepo,
): Promise<{ reportId: string; structure: TeardownStructure }> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new MzError('E_INVALID_ARGS', '缺少范文正文：粘贴正文或先载入已导入书。', { retryable: false });
  }
  const bookTitle = typeof title === 'string' && title.trim() ? title.trim() : '未命名范文';
  const dr = await distillReferenceWork({ title: bookTitle, text }, toolCtx(), { currentProjectId: () => null });
  const a = analyze(text);
  const structure: TeardownStructure = {
    bench: dr.ok && dr.data ? dr.data.bench : null,
    struct: dr.ok && dr.data ? dr.data.struct : null,
    hooks: dr.ok && dr.data ? dr.data.hooks : [],
    roles: dr.ok && dr.data ? dr.data.roles : [],
    analyze: {
      chars: a.chars,
      paras: a.paras,
      sents: a.sents,
      dialogRatio: a.raw.dialogRatio,
      avgSent: a.raw.avgSent,
      openType: a.openType,
    },
  };
  const report = td.insert({ bookTitle, structure });
  return { reportId: report.id, structure };
}

export interface TeardownReadDeps {
  reportId: string;
  /** 只消费 PipelineLlm.chat 子集（测试注入假实现）。 */
  llm: Pick<PipelineLlm, 'chat'>;
  repo: TeardownRepo;
  /** teardown 角色覆盖层（缺省 null = 内置温度 + system 零追加）；容忍同步实现。 */
  getOverlay?: (role: PromptOverlayRole) => PromptOverlay | null | Promise<PromptOverlay | null>;
}

/** 结构统计 → user 消息摘要（八维精读的证据面：统计数字 + 钩子引文 + 人物粗提）。 */
function structureBrief(bookTitle: string, s: TeardownStructure): string {
  const lines: string[] = [`书名：《${bookTitle}》（八维拆解以此为对象）`];
  const fixed = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '不可判');
  if (s.analyze) {
    lines.push(
      `基础统计：${s.analyze.chars} 字 / ${s.analyze.paras} 段 / ${s.analyze.sents} 句；` +
        `平均句长 ${fixed(s.analyze.avgSent, 1)} 字；对白占比 ${fixed(s.analyze.dialogRatio, 3)}；起笔类型「${s.analyze.openType}」`,
    );
  }
  if (s.bench) {
    lines.push(
      `节奏基准：每段约 ${fixed(s.bench.sentsPerPara, 2)} 句；句长变异系数 ${fixed(s.bench.sentCv, 3)}；` +
        `3-gram 重复率 ${fixed(s.bench.triRepeat * 100, 1)}%；TTR ${fixed(s.bench.ttr, 4)}`,
    );
  }
  if (s.struct) {
    lines.push(
      `结构节拍：${s.struct.sceneCount} 个自然段；段长分布「${s.struct.chapterLenPattern}」；` +
        `钩子密度 ${fixed(s.struct.hookDensity, 2)} 处/段`,
    );
  }
  if (s.hooks.length > 0) {
    lines.push(`钩子样例（引文证据，各 ≤16 字）：${s.hooks.slice(0, 8).map((h) => `「${h.quote}」(${h.kind})`).join(' ')}`);
  }
  if (s.roles.length > 0) {
    lines.push(`人物粗提：${s.roles.slice(0, 8).map((r) => `${r.name}×${r.mentions}`).join('、')}`);
  }
  lines.push('以上为零 token 结构统计的全部证据。请据此产出八维拆解；证据不足的维度如实说明，不得编造。');
  return lines.join('\n');
}

/**
 * 演示兜底 dims：统计能确定的一律给统计句（不瞎猜），
 * 不能确定的四维（定位/伏笔/文风/可借鉴）逐字标「演示·未精读」。
 */
function demoDims(s: TeardownStructure): TeardownDims {
  const DEMO = TEARDOWN_DEMO_MARK;
  const fixed = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '不可判');
  const tag = `（${DEMO}）`;
  const struct =
    s.struct != null
      ? `${s.struct.sceneCount} 段，段长节拍「${s.struct.chapterLenPattern}」${tag}`
      : DEMO;
  const rhythm =
    s.analyze != null
      ? `平均句长 ${fixed(s.analyze.avgSent, 1)} 字，对白占比 ${fixed(s.analyze.dialogRatio, 3)}${tag}`
      : DEMO;
  const hooks =
    s.struct != null
      ? `钩子密度 ${fixed(s.struct.hookDensity, 2)} 处/段，样例 ${s.hooks.length} 条${tag}`
      : DEMO;
  const roles =
    s.roles.length > 0
      ? `粗提及${s.roles.length}人：${s.roles.slice(0, 5).map((r) => `${r.name}×${r.mentions}`).join('、')}${tag}`
      : DEMO;
  return {
    定位: DEMO,
    结构: struct,
    节奏: rhythm,
    爽点钩子: hooks,
    伏笔: DEMO,
    人物: roles,
    文风: DEMO,
    可借鉴: DEMO,
  };
}

/**
 * ② 八维精读（按需）：live 走 LLM + zod 契约；任何失败如实回落演示兜底。
 * 两条路径都 setDimensions 回填——库里的 dimensions 永远与最近一次精读口径一致。
 */
export async function teardownRead(
  deps: TeardownReadDeps,
): Promise<{ dims: TeardownDims; source: 'live' | 'demo' }> {
  const { reportId, llm, repo } = deps;
  const report = repo.get(reportId);
  if (!report) throw new MzError('E_NOT_FOUND', `拆书报告不存在：${reportId}`);
  const structure = (report.structure ?? {}) as TeardownStructure;
  const overlay = (await deps.getOverlay?.('teardown')) ?? null;
  const system = composeTeardownPrompt(overlay);
  const temperature = overlay?.temperature ?? TEARDOWN_TEMPERATURE;
  try {
    const res = await llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: structureBrief(report.bookTitle, structure) },
      ],
      temperature,
    });
    const parsed = TeardownDimsSchema.safeParse(extractJson(res.content));
    if (!parsed.success) throw new Error('精读产出未过 TeardownDimsSchema 契约');
    repo.setDimensions(reportId, parsed.data);
    return { dims: parsed.data, source: 'live' };
  } catch {
    // 诚实兜底：无 Key / 请求失败 / 产出坏 → 统计可确定维度 + 明示未精读，绝不冒充模型精读。
    const dims = demoDims(structure);
    repo.setDimensions(reportId, dims);
    return { dims, source: 'demo' };
  }
}

/**
 * 一维存入灵感库（★ R4 裁决：td/ins 分传）。未精读（dimensions null）不落半程卡；
 * 维度必须落在八维键集内（跨 IPC 的字符串不经编译期，门口拦）。
 */
export function saveDimension(deps: {
  reportId: string;
  dimension: string;
  td: TeardownRepo;
  ins: InspirationRepo;
}): InspirationCard {
  const { reportId, dimension, td, ins } = deps;
  const report = td.get(reportId);
  if (!report) throw new MzError('E_NOT_FOUND', `拆书报告不存在：${reportId}`);
  if (!report.dimensions) {
    throw new MzError('E_INVALID_ARGS', '尚未完成八维精读，没有可存的维度：先点「AI 精读八维」。', {
      retryable: false,
    });
  }
  if (!TEARDOWN_DIMENSIONS.includes(dimension as keyof TeardownDims)) {
    throw new MzError('E_INVALID_ARGS', `未知拆书维度：${String(dimension)}`, { retryable: false });
  }
  const summary = report.dimensions[dimension as keyof TeardownDims];
  return ins.insert({
    kind: 'teardown',
    title: `${dimension}·${report.bookTitle}`,
    payload: { dimension, summary, bookTitle: report.bookTitle, reportId },
    sourceLabel: report.bookTitle,
  });
}

/* ── IPC 边界（register.ts 一行式委托；zod 门口拦，坏值不透传到 repo/LLM）── */

export interface TeardownIpcDeps {
  td: TeardownRepo;
  ins: InspirationRepo;
  llm: Pick<PipelineLlm, 'chat'>;
  getOverlay?: (role: PromptOverlayRole) => PromptOverlay | null | Promise<PromptOverlay | null>;
}

const StructureArgsSchema = z.object({ title: z.string(), text: z.string().min(1) });
const ReadArgsSchema = z.object({ reportId: z.string().min(1) });
const SaveDimensionArgsSchema = z.object({ reportId: z.string().min(1), dimension: z.string().min(1) });

function invalid(channel: string, issue: z.ZodError): never {
  throw new MzError('E_INVALID_ARGS', `${channel} 入参非法：${issue.issues.map((i) => i.message).join('；')}`, {
    retryable: false,
  });
}

/** teardown:structure —— 零 token 结构统计（不碰 llm，秒出）。 */
export async function teardownStructureIpc(
  deps: TeardownIpcDeps,
  args: unknown,
): Promise<{ reportId: string; structure: TeardownStructure }> {
  const parsed = StructureArgsSchema.safeParse(args);
  if (!parsed.success) invalid('teardown:structure', parsed.error);
  return teardownStructure(parsed.data.text, parsed.data.title, deps.td);
}

/** teardown:read —— 按需八维精读（live/demo 如实回报）。 */
export async function teardownReadIpc(
  deps: TeardownIpcDeps,
  args: unknown,
): Promise<{ dims: TeardownDims; source: 'live' | 'demo' }> {
  const parsed = ReadArgsSchema.safeParse(args);
  if (!parsed.success) invalid('teardown:read', parsed.error);
  return teardownRead({ reportId: parsed.data.reportId, llm: deps.llm, repo: deps.td, getOverlay: deps.getOverlay });
}

/** teardown:save-dimension —— 一维存灵感库，回卡（自带 id，收藏/套用直接拿它）。 */
export function teardownSaveDimensionIpc(deps: TeardownIpcDeps, args: unknown): InspirationCard {
  const parsed = SaveDimensionArgsSchema.safeParse(args);
  if (!parsed.success) invalid('teardown:save-dimension', parsed.error);
  return saveDimension({ reportId: parsed.data.reportId, dimension: parsed.data.dimension, td: deps.td, ins: deps.ins });
}
