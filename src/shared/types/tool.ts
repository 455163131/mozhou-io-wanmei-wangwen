/**
 * 工具层类型契约（架构 §1.3）。主进程与渲染层**共用类型**，但**执行器不共用**。
 *
 * 渲染层只能拿到 ToolSpec 的只读视图，永远拿不到「怎么执行」。
 */

/**
 * 危险等级 v1.1：**按「回滚成本与不可逆性」分级**，与「是否需要用户确认」解耦。
 *
 * ⚠️ 与旧理解的语义差异（重要，勿沿用）：
 *   - 旧：danger 越高 → 越需要用户确认
 *   - 新：danger 越高 → 越难回滚 / 回滚越可能损失用户的其他工作
 *   - 确认强度由独立的 writePolicy + hardStopThreshold 决定，不由 danger 决定。
 *   - 反例：delete_chapter 即便可回滚也是高 danger（回滚会覆盖用户删除之后的其它修改）；
 *           replace_phrase 即便自动执行也是最低 danger（快照能精确还原到该段原始字节）。
 */
export enum ToolDanger {
  /** 快照可精确还原，改动范围被参数完全限定，零外溢 */
  Precise = 1,
  /** 可回滚，但回滚会连带覆盖同章内用户在此期间的其它手动修改 */
  Spillover = 2,
  /** 跨章节/跨表改动，回滚粒度粗（按章或按批） */
  CrossScope = 3,
  /** 影响项目外部（写项目外、覆盖导出物），或回滚成本超过单章快照上限 */
  Irreversible = 4,
  /** 会破坏不可再生的用户劳动（清库、重建全部索引） */
  Destructive = 5,
}

/** 写策略（老板已选 auto-with-undo 为默认，另两种保留可切换） */
export type WritePolicy =
  /** 写操作只产出预览，不落盘（最保守） */
  | 'preview-only'
  /** 自动执行 + 强制快照 + 随时可回滚（老板默认） */
  | 'auto-with-undo'
  /** 每个 danger ≥ threshold 的工具单独弹确认 */
  | 'ask-per-tool';

export interface WritePolicyConfig {
  policy: WritePolicy;
  /** ask-per-tool 模式下，danger ≥ 此值的工具需逐次确认 */
  autoApproveThreshold: ToolDanger;
  /** 即使 auto-with-undo，danger ≥ 此值的工具仍硬性要求确认（不可被策略覆盖） */
  hardStopThreshold: ToolDanger;
}

export type ToolParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | 'object';

export interface ToolParamSpec {
  name: string;
  type: ToolParamType;
  required: boolean;
  /** ← 模型靠这句决定传什么，必须写清「传什么」而非「这是什么」 */
  description: string;
  enum?: readonly (string | number)[];
  default?: unknown;
  /** 单参数值域上界，用于预算预检（防止把整本书塞进参数） */
  maxLength?: number;
}

export interface ToolSpec {
  /** 全局唯一，snake_case */
  name: string;
  /** 中文名，UI 显示 */
  displayName: string;
  /** 给模型看：能做什么、不能做什么 */
  description: string;
  params: ToolParamSpec[];
  /** v1.1 语义：回滚成本，非确认强度 */
  danger: ToolDanger;
  /** 与 danger 故意冗余，便于断言「声称可回滚的必须真的进得了 checkpoint」 */
  reversible: boolean;
  /** 单次调用涉及的最大正文字节数，决定快照大小与撤销栈预算 */
  maxAffectedBytes: number;
  /** 是否跨章（跨章则 checkpoint 粒度必须降级为按批） */
  crossChapter: boolean;
  /** 预估耗时，用于 UI 提示与超时预算 */
  costHintMs: number;
  /** 同参数重复调用是否安全（幂等则循环检测判据 A 豁免） */
  idempotent: boolean;
  /** 是否写工具（只读工具不落 checkpoint） */
  writes: boolean;
}

/** 工具错误码：结构化且面向模型，让模型读到能自我纠正 */
export type ToolErrorCode =
  | 'E_INVALID_ARGS'
  | 'E_TOOL_NOT_FOUND'
  | 'E_TOOL_REFUSED'
  | 'E_PERMISSION_DENIED'
  | 'E_GUARD_NOT_APPLICABLE'
  | 'E_NO_EFFECT'
  | 'E_REVISION_CONFLICT'
  | 'E_CHECKPOINT_FAILED'
  | 'E_ROLLBACK_CONFLICT'
  | 'E_NOT_PROJECT_FILE'
  | 'E_COMPLIANCE_BLOCKED'
  | 'E_SIDE_EFFECT_REJECTED'
  /** 生成流水线：模型输出未通过 JSON 提取或 zod 契约校验（可重试） */
  | 'E_PIPELINE_PARSE'
  | 'E_INTERNAL';

/** 工具调用请求：模型选中工具 + 参数 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult<R = unknown> {
  ok: boolean;
  data?: R;
  /** 结构化、面向模型的错误说明 */
  error?: { code: ToolErrorCode; message: string; retryable: boolean; hint?: string };
  /** 写工具必须回传 */
  changeSet?: ChangeSet;
  durationMs: number;
}

/** 单次编辑：before/after + 偏移 + 人类可读理由 */
export interface Edit {
  before: string;
  after: string;
  /**
   * 字符偏移，**坐标系 = 产生这条编辑的那个函数所收到的输入文本**。用于 UI 定位与高亮。
   *
   * ★ 两类调用点，语义不同，别混用：
   *   1. 单工具编辑（`replace_phrase`、每条 `FixPlan.perRule[i].changes`）：
   *      输入就是该章原文，故 `at` 是**原文偏移**。多处编辑按 `at` 倒序应用是安全的
   *      ——靠后的改动不影响靠前的偏移。`rule-engine/fix-families.ts`（m.index）
   *      与 `tools/impl/phrase.ts` 都遵循这一约定。
   *   2. `FixPlan.changes`（跨规则摊平后的总表）：每条来自不同规则，而规则是
   *      **串行**作用的（`cur = r.text`），所以各条 `at` 分属不同坐标系，
   *      整体**不可**用于反向 patch。
   *      这正是 `plan-fixes.ts` 的 `rollbackRule()` 选择「从原文重放除该规则外的
   *      所有规则」而非反向打补丁的原因（原注释：「规则之间会相互影响偏移，
   *      反向 patch 不可靠；重放是确定性的」）。
   *      跨规则的 UI 高亮若要精确，需要先把偏移 rebase 到统一坐标系（尚未实现）。
   */
  at: number;
  /** 为什么改这一处：规则名 + 说明，直接展示给用户（架构 §4.2 要求「决策理由可见」） */
  note: string;
  /** 产生该编辑的规则 id（如 F7）；局部回滚按此粒度进行 */
  ruleId?: string;
}

/**
 * 单章快照。这是 checkpoint 的最小单位。
 * 为什么只存单章不存全量：单章 7.5KB × 深度 50 = 375KB 可行；
 * 500 章全量 3.75MB × 50 = 187MB 不可行（架构 §1.4.4①，差 500 倍）。
 */
export interface Patch {
  chapterId: string;
  /** 改前完整正文（回滚的依据，PRD 验收标准第 6 条要求逐字一致） */
  beforeText: string;
  /** 改后完整正文 */
  afterText: string;
  /** 该次改动的字节数，用于撤销栈内存预算核算 */
  bytes: number;
  at: number;
  runId: string;
  toolName: string;
  edits: Edit[];
}

export interface ChangeSet {
  chapterId: string;
  patches: Patch[];
  edits: Edit[];
  bytes: number;
  /** 快照句柄，写入 checkpoint 栈；主进程持有，不经渲染层 */
  checkpointId?: string;
  /** dry-run 时为 true：不落盘，仅返回将要发生的改动 */
  dryRun: boolean;
}

/** 副作用判定结果（架构 §1.4.4⑥）：改前 ok → 改后越界 = 新引入的问题 */
export interface SideEffect {
  toolName: string;
  ruleId: string;
  chapterId: string;
  metric: string;
  before: number;
  after: number;
  bound: number;
  boundKind: 'p95' | 'p05';
  /** 改前的等级；只有 ok 才算「本来好好的被改坏」 */
  beforeGrade: Grade;
  afterGrade: Grade;
  /** 是否已自动局部回滚这条规则 */
  rolledBack: boolean;
  /** 面向用户的解释，必须可读 */
  explanation: string;
}

export type Grade = 'ok' | 'warn' | 'risk';

/** 工具执行上下文，由 sandbox 注入（执行器拿不到裸文本以外的东西） */
export interface ToolContext {
  runId: string;
  stepNo: number;
  /** 是否为预览（dry-run）：preview 与 execute 共用同一段变换逻辑，用它区分 */
  dryRun: boolean;
  /** 强制落快照的回调；写工具在改动前必须调用它。返回失败即拒绝执行（fail-safe） */
  requireCheckpoint: (chapters: readonly string[]) => Promise<string>;
  signal: AbortSignal;
  logger: (msg: string) => void;
}

/**
 * 工具执行器：预览与执行共用同一个函数，靠 ctx.dryRun 区分（架构 §1.3 铁律）
 *
 * 泛型默认值留 any 是刻意的：工具入参在进 handler 前只保证「是 JSON」，真正的形状
 * 由 sandbox 按 spec.schema 校验、再由各 handler 声明自己的 A。默认设 unknown 会逼
 * 所有调用方先窄化、却拿不到额外保障。真要收口得让 A 从 schema 推导（z.infer），
 * 那是跨 7 个 handler 的独立改造，连同 sandbox.ts 的 handler 签名一起改。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 理由见上方 doc，非疏漏
export type ToolHandler<A = any, R = any> = (
  args: A,
  ctx: ToolContext,
) => Promise<ToolResult<R>>;