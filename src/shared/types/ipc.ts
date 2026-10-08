/**
 * IPC 契约（架构 §2.3）。
 *
 * **铁律**：通道名集中在此定义，preload/channels.ts 从中取值，
 * 禁止在业务代码里手写字符串通道名。契约先冻结再写实现，否则后面全返工（T02 是架构级卡点）。
 */
import type { LlmStatus } from './provider';
import type { Chapter, ChapterMeta, Project, Volume, StyleProfile } from './project';
import type { ChapterAnalysis, HealthReport, IssueLocation, RuleInfo } from './health';
import type { ChangeSet, ToolSpec } from './tool';
import type { LedgerQuery, LedgerConflict, CharacterProfile } from './ledger';
import type { Checkpoint, RollbackResult } from './checkpoint';
import type { RunState, TerminationReason, RunStats, StepRecord } from './agent';
import type { ToolDanger, WritePolicy, WritePolicyConfig } from './tool';

// ───────────────────────── 请求/响应载荷 ─────────────────────────

export interface OpenProjectPayload {
  /** 目录绝对路径；主进程会做路径规范化防目录穿越 */
  dir: string;
}

export interface SaveChapterPayload {
  chapterId: string;
  body: string;
  /** 乐观锁：不匹配则报 E_REVISION_CONFLICT */
  expectedRev: number;
}

export interface AgentRunPayload {
  goal: string;
  /** 限定范围；空 = 全项目 */
  chapterIds?: string[];
  /** 覆盖默认预算 */
  budget?: Partial<{
    maxSteps: number;
    maxTokens: number;
    maxCostCny: number;
    maxWallMs: number;
  }>;
  /** 覆盖写策略；不传用用户设置 */
  writePolicy?: WritePolicyConfig;
}

export interface UndoPayload {
  /** 回滚到该 checkpoint 之前 */
  checkpointId: string;
  /** 是否跳过「丢失手动修改」确认（UI 已确认过才传 true） */
  force?: boolean;
}

export interface ToolPreviewPayload {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ConfigureLlmPayload {
  providerId: string;
  baseUrl?: string;
  model?: string;
  /** 明文 Key，只在主进程落盘（safeStorage 加密），永不经 contextBridge 返回 */
  apiKey?: string;
  /** 是否重新探测能力 */
  reprobe?: boolean;
}

export interface ExportPayload {
  kind: 'md' | 'csv' | 'zip';
  chapterIds: string[];
  /** 'project' 写项目内（★2）；'external' 写项目外（★4，hardStop，永不自动） */
  dest: 'project' | 'external';
  destPath?: string;
}

// ───────────────────────── invoke 通道 ─────────────────────────

/** 请求 → 响应 的类型映射。渲染层的 mz.xxx 方法由这张表推导，杜绝手写错配。 */
export interface IpcInvokeMap {
  'app:getPaths': { req: void; res: { userData: string; documents: string } };
  'app:window': { req: { action: 'minimize' | 'maximize' | 'close' }; res: void };

  'project:open': { req: OpenProjectPayload; res: Project };
  'project:close': { req: void; res: void };
  'project:list': { req: void; res: Project[] };
  'project:save': { req: void; res: Project };
  'project:volumes': { req: void; res: Volume[] };
  /** 新建一卷（ord 由主进程追加，渲染层不数） */
  'project:create-volume': { req: { title: string }; res: Volume };
  /** 拖拽重排卷册：ids 必须是当前全部卷的一个排列 */
  'project:reorder-volumes': { req: { ids: string[] }; res: Volume[] };

  'chapter:list': { req: void; res: ChapterMeta[] };
  'chapter:get': { req: { chapterId: string }; res: Chapter };
  'chapter:update': { req: SaveChapterPayload; res: ChapterMeta };
  /** 拖拽重排章节：只改 ord，不动正文与 rev */
  'chapter:reorder': { req: { ids: string[] }; res: ChapterMeta[] };
  /** 把章挪进某卷；volumeId=null 表示移出到「未分卷」 */
  'chapter:set-volume': {
    req: { chapterId: string; volumeId: string | null };
    res: ChapterMeta;
  };

  'health:analyze': { req: { chapterIds?: string[] }; res: ChapterAnalysis[] };
  'health:report': { req: { chapterIds?: string[] }; res: HealthReport };
  'health:locate': { req: { metric: string; chapterIds?: string[] }; res: IssueLocation[] };
  'health:rules': { req: { layer?: string }; res: RuleInfo[] };

  'ledger:query': { req: LedgerQuery; res: { conflicts: LedgerConflict[]; characters: CharacterProfile[] } };
  'ledger:upsert': { req: { character: CharacterProfile }; res: CharacterProfile };

  'tool:list': { req: void; res: ToolSpec[] };
  'tool:preview': { req: ToolPreviewPayload; res: ChangeSet };
  'tool:execute': { req: ToolPreviewPayload; res: ChangeSet };

  'agent:run': { req: AgentRunPayload; res: { runId: string } };
  'agent:abort': { req: { runId: string }; res: void };
  'agent:pause': { req: { runId: string }; res: void };
  'agent:resume': { req: { runId: string }; res: void };
  'agent:state': { req: { runId?: string }; res: RunState | null };
  'agent:history': { req: { limit?: number }; res: RunState[] };

  'checkpoint:list': { req: { runId?: string }; res: Checkpoint[] };
  'checkpoint:undo': { req: UndoPayload; res: RollbackResult };

  'llm:status': { req: void; res: LlmStatus };
  'llm:configure': { req: ConfigureLlmPayload; res: LlmStatus };
  'llm:test': { req: void; res: { ok: boolean; message: string } };
  /** 仪表盘聚合统计（真实数据聚合，无 mock） */
  'dash:stats': { req: void; res: DashStats };

  'style:profile': { req: void; res: StyleProfile | null };
  'style:rebuild': { req: { chapterIds?: string[] }; res: StyleProfile };

  'export:run': { req: ExportPayload; res: { path: string; bytes: number } };

  // ── 专家团（阶段三：UI 手动触发入口）────────────────────────────────
  /** 手动触发一次专家团评审（不依赖 Agent） */
  'expert:review': {
    req: { stage: ExpertStage; chapterIds: string[]; roles?: string[] };
    res: { reviewId: string; report: unknown; failures: { role: string; reason: string }[] };
  };
  /** 评审历史 */
  'expert:history': { req: { limit?: number }; res: unknown[] };
  /** 单次评审的完整意见（裁决交互用） */
  'expert:opinions': { req: { reviewId: string }; res: unknown[] };
  /** 作者对某维度做最终裁决（defer 项的处理入口） */
  'expert:decide': {
    req: { reviewId: string; dimension: string; decision: 'accept' | 'reject' };
    res: void;
  };
  /** 专家团配置 */
  'expert:config': { req: void; res: unknown };
  'expert:configure': { req: { config: unknown }; res: unknown };
  /** 可用角色列表（UI 渲染勾选项） */
  'expert:roles': {
    req: void;
    res: { key: string; displayName: string; mission: string; defaultWeight: number }[];
  };

  // ── AI 味检测（独立板块，前缀 aiFlavor:）──────────────────────────
  /** 检测指定章节，返回完整报告（含分段得分与命中定位） */
  'aiFlavor:scan': {
    req: { chapterIds?: string[]; useCache?: boolean };
    res: FlavorScanResult[];
  };
  /** 读取某章最近一次检测结果 */
  'aiFlavor:latest': { req: { chapterId: string }; res: FlavorScanResult | null };
  /** 分数趋势（画曲线用） */
  'aiFlavor:trend': {
    req: { chapterId: string; limit?: number };
    res: { index: number; level: string; at: number }[];
  };
  /**
   * 执行改写。两条路径二选一：
   *   auto-rule = 本地规则改写（不调 LLM）
   *   agent     = 交给主 Agent 重新生成
   */
  'aiFlavor:rewrite': {
    req: {
      chapterId: string;
      path: 'auto-rule' | 'agent';
      dimensions?: string[];
      paragraphNos?: number[];
      /** true = 只返回结果不落盘（预览） */
      dryRun?: boolean;
    };
    res: {
      changedCount: number;
      beforeIndex: number;
      afterIndex: number;
      delta: number;
      newText: string;
      edits: { from: string; to: string; offset: number; why: string }[];
      rejected: { offset: number; reason: string }[];
      agentHandoff: { count: number; offsets: number[] };
      runId?: string;
      message: string;
    };
  };
  /** 改写历史（前后分对比） */
  'aiFlavor:rewriteHistory': { req: { chapterId: string }; res: unknown[] };
  /** 板块配置（维度开关、阈值、权重） */
  'aiFlavor:config': { req: void; res: unknown };
  'aiFlavor:configure': { req: { config: unknown }; res: unknown };
  /** 板块定位说明（写作体检而非 AI 判决） */
  'aiFlavor:about': { req: void; res: { disclaimer: string; engineVersion: string } };
  /** 当前生效的 AI 味基线（有用户基线用用户的，否则内置默认） */
  'aiFlavor:baseline': { req: void; res: FlavorBaselineInfo };
  /** 用当前项目语料**重建**用户基线并保存（样本不足则不保存，继续用默认） */
  'aiFlavor:rebuildBaseline': { req: { chapterIds?: string[] }; res: FlavorRebuildResult };
}

/** 当前生效的 AI 味基线摘要（渲染层展示用；不含完整分位数） */
/** 仪表盘聚合统计（全部来自真实数据：chapterRepo / checkpointManager / AgentHost 用量） */
export interface DashVolume {
  id: string;
  title: string;
  /** 该卷章节数 */
  chapters: number;
  /** 该卷总字数 */
  chars: number;
  /** 稳定稿（done+revised）字数占比 0~100 */
  progressPct: number;
}

export interface DashStats {
  totalChars: number;
  chapterCount: number;
  /** 四状态计数：todo(大纲) / draft(草稿) / revised(待审) / done(已发布) */
  byStatus: { todo: number; draft: number; revised: number; done: number };
  volumes: DashVolume[];
  /** 检查点（改动历史）总数 */
  checkpoints: number;
  /** 本次进程内 Agent 循环累计的 LLM 用量；未跑过为 null */
  llm: { requests: number; tokensIn: number; tokensOut: number; costCny: number } | null;
}

export interface FlavorBaselineInfo {
  /** builtin = 内置默认基线；user = 用户自建基线 */
  source: 'builtin' | 'user';
  /** 来源文案（语料名 / 「你的语料（N 章）」） */
  corpus: string;
  /** 参与基线的章数（内置默认 = 715） */
  chapters: number;
  /** 基线是否因**特征提取口径**变更而过期（建议重建） */
  stale: boolean;
  /** 生成该基线时的特征提取口径版本 */
  engineVersion: string;
}

/** 重建用户基线的结果 */
export interface FlavorRebuildResult {
  /** 实际参与计算的有效章数 */
  used: number;
  /** 因样本不足被跳过的章数 */
  skipped: number;
  /** 是否已保存（有效章数 < 10 时不保存） */
  saved: boolean;
  /** 可向用户披露的提示 */
  warnings: string[];
  /** 重建后**当前生效**的基线摘要（若未保存，则仍是原基线） */
  info: FlavorBaselineInfo;
}

/** 专家团评审阶段（与 expert 模块的 ReviewStage 同源，此处避免跨模块 import） */
export type ExpertStage = 'outline' | 'chapter' | 'post-polish';

/** AI 味检测结果（渲染层可见的 DTO，与 shared/types/ai-flavor 的 FlavorReport 一致） */
export interface FlavorScanResult {
  chapterId: string;
  index: number;
  level: string;
  chars: number;
  paragraphs: number;
  sufficient: boolean;
  insufficientReason?: string;
  dominantDimension: string | null;
  engineVersion: string;
  at: number;
  // ── v2 校准新增（T04 UI 用；可选字段，老报告反序列化不报错）──
  /** 本次用的是哪份基线（'default' | 'user'） */
  baselineId?: string;
  /** 基线来源文案（如「你的语料（N 章，按章分位数）」） */
  baselineSource?: string;
  /** 基线由旧特征口径生成（不阻断，降置信） */
  baselineStale?: boolean;
  /** 参与总评的「已校准」维度权重占比（0~1） */
  calibratedRatio?: number;
  dimensions: {
    dimension: string;
    score: number;
    level: string;
    skipped: boolean;
    measured: number | null;
    baseline: number | null;
    note: string;
    /** 该维度本次是否用了已校准基线（回退默认的维度为 false） */
    calibrated?: boolean;
    /** 基线置信度（high | medium | low） */
    confidence?: string;
    /** 原始偏离度 d（单位：正常带宽度），供 UI 原样展示 */
    deviation?: number | null;
    /** 该维度的「正常带」[p05, p95]；零膨胀/未判分维度为 null */
    band?: [number, number] | null;
  }[];
  paragraphs_: {
    no: number;
    start: number;
    end: number;
    score: number;
    level: string;
    chars: number;
    hitCount: number;
    topDimension: string | null;
  }[];
  hits: {
    dimension: string;
    kind: string;
    level: string;
    severity: number;
    excerpt: string;
    offset: number;
    length: number;
    paragraphNo: number;
    reason: string;
    advice: string;
  }[];
}

/** 通道名常量（由IpcInvokeMap 派生，保证与类型同源） */
export const IPC_CHANNELS = [
  'app:getPaths',
  'app:window',
  'project:open',
  'project:close',
  'project:list',
  'project:save',
  'project:volumes',
  'project:create-volume',
  'project:reorder-volumes',
  'chapter:list',
  'chapter:get',
  'chapter:update',
  'chapter:reorder',
  'chapter:set-volume',
  'health:analyze',
  'health:report',
  'health:locate',
  'health:rules',
  'ledger:query',
  'ledger:upsert',
  'tool:list',
  'tool:preview',
  'tool:execute',
  'agent:run',
  'agent:abort',
  'agent:pause',
  'agent:resume',
  'agent:state',
  'agent:history',
  'checkpoint:list',
  'checkpoint:undo',
  'llm:status',
  'llm:configure',
  'llm:test',
  'dash:stats',
  'style:profile',
  'style:rebuild',
  'export:run',
  // 专家团（阶段三）
  'expert:review',
  'expert:history',
  'expert:opinions',
  'expert:decide',
  'expert:config',
  'expert:configure',
  'expert:roles',
  // AI 味检测（独立板块）
  'aiFlavor:scan',
  'aiFlavor:latest',
  'aiFlavor:trend',
  'aiFlavor:rewrite',
  'aiFlavor:rewriteHistory',
  'aiFlavor:config',
  'aiFlavor:configure',
  'aiFlavor:about',
  'aiFlavor:baseline',
  'aiFlavor:rebuildBaseline',
] as const;

export type IpcChannel = keyof IpcInvokeMap;

export function isIpcChannel(name: string): name is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(name);
}

// ───────────────────────── 主进程 → 渲染层推送 ─────────────────────────

/**
 * 单向推送通道。只有 main/ipc/push.ts 一个出口（架构 §2.3）。
 * 回调只拿**已序列化的只读 DTO**，不含任何类实例或函数。
 */
export interface IpcPushMap {
  'agent:step': {
    runId: string;
    step: StepRecord;
  };
  'agent:tool-call': {
    runId: string;
    stepNo: number;
    toolName: string;
    /** 该工具在 registry 中声明的回滚成本；null = 宿主未注入（不谎报） */
    danger: ToolDanger | null;
    /** 本次 run 实际生效的写策略；null = 同上 */
    writePolicy: WritePolicy | null;
    argsSummary: string;
  };
  'agent:change': {
    runId: string;
    checkpointId: string;
    chapterId: string;
    edits: ChangeSet['edits'];
    bytes: number;
  };
  'agent:checkpoint': {
    runId: string;
    checkpointId: string;
    stepNo: number;
    toolName: string;
    affectedChapters: string[];
    bytes: number;
  };
  'agent:side-effect': {
    runId: string;
    toolName: string;
    metric: string;
    before: number;
    after: number;
    bound: number;
    rolledBack: boolean;
    explanation: string;
  };
  'agent:preview': { runId: string; changeSet: ChangeSet };
  'agent:terminated': {
    runId: string;
    reason: TerminationReason;
    stats: RunStats;
    keptChanges: number;
  };
  'agent:need-approval': {
    runId: string;
    toolName: string;
    danger: number;
    argsSummary: string;
    changeSetSummary: string;
  };
  'agent:plan': { runId: string; plan: RunState['plan'] };
  'chapter:changed': { chapterId: string; rev: number; source: 'agent' | 'user' };
  'project:opened': { projectId: string };
  'project:closed': { projectId: string };
  'llm:status': LlmStatus;
  'checkpoint:rolled-back': {
    checkpointId: string;
    undone: number;
    lostManualEdits: number;
  };
}

export const IPC_PUSH_CHANNELS = [
  'agent:step',
  'agent:tool-call',
  'agent:change',
  'agent:checkpoint',
  'agent:side-effect',
  'agent:preview',
  'agent:terminated',
  'agent:need-approval',
  'agent:plan',
  'chapter:changed',
  'project:opened',
  'project:closed',
  'llm:status',
  'checkpoint:rolled-back',
] as const;

export type IpcPushChannel = keyof IpcPushMap;

// ───────────────────────── 全局错误码 ─────────────────────────

/**
 * 错误码（架构 §2.3）。每个码对应渲染层的**确定动作**，不能只弹个 toast。
 */
export const ERROR_CODES = {
  /** 参数校验失败 → 回喂 Agent 自纠 */
  E_INVALID_ARGS: 'E_INVALID_ARGS',
  E_TOOL_NOT_FOUND: 'E_TOOL_NOT_FOUND',
  /** 未放行的高危工具 → 弹确认框 */
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  E_NOT_PROJECT_FILE: 'E_NOT_PROJECT_FILE',
  /** 乐观锁冲突 → 提示重载 */
  E_REVISION_CONFLICT: 'E_REVISION_CONFLICT',
  E_LLM_TIMEOUT: 'E_LLM_TIMEOUT',
  E_LLM_AUTH: 'E_LLM_AUTH',
  E_LLM_RATE: 'E_LLM_RATE',
  E_LLM_NETWORK: 'E_LLM_NETWORK',
  /** 合规守卫拦截 → 不重试 */
  E_COMPLIANCE_BLOCKED: 'E_COMPLIANCE_BLOCKED',
  E_BUDGET_EXCEEDED: 'E_BUDGET_EXCEEDED',
  E_LOOP_DETECTED: 'E_LOOP_DETECTED',
  /** 已有 run 在跑 → 拒绝新 run */
  E_RUN_CONFLICT: 'E_RUN_CONFLICT',
  /** ★ v1.1：快照落盘失败 → 拒绝执行（fail-safe） */
  E_CHECKPOINT_FAILED: 'E_CHECKPOINT_FAILED',
  E_SNAPSHOT_LIMIT: 'E_SNAPSHOT_LIMIT',
  /** 回滚会覆盖用户后续手动修改 → 弹确认框明示「将丢失 N 处」 */
  E_ROLLBACK_CONFLICT: 'E_ROLLBACK_CONFLICT',
  /** provider 不支持所需能力 → 切单步模式 + 明示 */
  E_PROVIDER_CAPABILITY: 'E_PROVIDER_CAPABILITY',
  /** 本地模型无工具调用能力 → 降级并明示（不静默） */
  E_TOOLCALL_UNSUPPORTED: 'E_TOOLCALL_UNSUPPORTED',
  /** 启动时发现上次 run 未正常结束 */
  E_RUN_UNCLOSED: 'E_RUN_UNCLOSED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 带错误码的异常，供 IPC 层序列化回传 */
export class MzError extends Error {
  constructor(
    readonly code: ErrorCode | string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'MzError';
  }
}

/** 终止原因 → 人话（UI 直接显示这段，不要让渲染层自己拼） */
export const TERMINATION_TEXT: Record<string, string> = {
  GOAL_ACHIEVED: '目标已达成',
  MAX_STEPS: '已达步数上限',
  BUDGET_EXCEEDED: '已达预算上限',
  NO_PROGRESS: '连续多步无进展',
  LOOP_REPEAT_ARG: '检测到重复调用同一工具',
  LOOP_STATE_OSCILLATION: '检测到状态来回振荡',
  LOOP_NO_EFFECT: '检测到连续多步无任何效果',
  CONSECUTIVE_FAILURE: '连续多次工具失败',
  USER_ABORTED: '已被用户叫停',
  VALIDATION_FAILED: '参数校验未通过',
};