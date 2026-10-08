/**
 * Agent 引擎类型契约（架构 §1.4）。
 */
import type { Edit, SideEffect, ToolCall, ToolDanger } from './tool';

/** 预算上限（架构 §1.4.1 闸门②）。定义在此以便主进程与渲染层共用 */
export interface BudgetLimits {
  /** 闸门① 步数上限 */
  maxSteps: number;
  /** 闸门② token 上限 */
  maxTokens: number;
  /** 闸门② 成本上限（元）。本地模型恒不触发，退化为本机耗时上限 */
  maxCostCny: number;
  /** 本地模型专用：防本地模型跑几小时不收敛 */
  maxWallMs: number;
}

export type RunStatus =
  | 'idle'
  | 'planning'
  | 'selecting'
  | 'executing'
  | 'observing'
  | 'evaluating'
  | 'paused'
  | 'terminated';

export type StepPhase =
  | 'planning'
  | 'tool-call'
  | 'observing'
  | 'evaluating'
  | 'skipped';

/** 本地定义会产生同名冲突，故 ToolCall 从 ./tool 导入；此处仅做文档说明：
 *  - ToolCall（工具调用请求）在 types/tool.ts
 *  - ToolCallCard（UI 展示用）在本文件下方
 */

export type StepStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rolled-back'
  | 'aborted';

export interface PlanStep {
  index: number;
  /** 面向用户的意图描述，轨迹面板直接显示（架构 §4.2「决策理由可见」） */
  intent: string;
  /** Agent 选它的理由。必须显式给出——验收标准第 2 条要求能看到「跳过 F7/F9：格式约束」 */
  rationale?: string;
  /** 计划要用的工具名；实际执行可能与之不同（Agent 可改主意） */
  plannedTool?: string;
}

export interface Plan {
  /** 对用户目标的一句话复述，用于让用户确认「Agent 理解对了」 */
  goalRestated: string;
  steps: PlanStep[];
  /** Agent 声明的「我不打算做什么」及原因——这是自主决策的直接证据 */
  explicitlySkipped?: Array<{ what: string; why: string }>;
}

export type ObservationKind = 'facts' | 'inference';

export interface Observation {
  stepNo: number;
  toolName: string;
  kind: ObservationKind;
  /** 事实型= 纯统计算出，可信；推断型 = 模型归纳，不可全信（架构 §1.4.2） */
  summary: string;
  /** 结构化数据（如指标值），供下一轮规划直接使用 */
  data?: unknown;
  durationMs: number;
  ok: boolean;
  /** 失败时的结构化原因，直接展示给用户（PRD 要求「失败不隐藏」） */
  errorMessage?: string;
  /** 失败后已尝试过的策略链（架构 §4.2 视觉规范：不要让失败静默滑过） */
  attempts?: string[];
}

export type ProgressVerdict = 'positive' | 'partial' | 'none' | 'negative';

/** 评估器输出（架构 §1.4.4⑤：progress==='negative' 触发局部回滚） */
export interface Evaluation {
  progress: ProgressVerdict;
  /** 是否达成用户目标 */
  goalAchieved: boolean;
  /** 给 Agent 看的下一步建议 */
  nextHint?: string;
  /** 本步引入的副作用（若有） */
  sideEffects?: SideEffect[];
  /** 面向用户的一句话结论，进轨迹面板 */
  reason: string;
}

export interface StepRecord {
  stepNo: number;
  runId: string;
  phase: StepPhase;
  status: StepStatus;
  toolName: string;
  /** 参数摘要（已截断，避免把整章正文塞进轨迹） */
  argsSummary: string;
  resultSummary: string;
  durationMs: number;
  rationale?: string;
  edits?: Edit[];
  /** 本步对应的 checkpoint（写工具才有），与轨迹步骤一一对应 */
  checkpointId?: string;
  sideEffects?: SideEffect[];
  errorMessage?: string;
  attempts?: string[];
  /** 本步之后的项目文本指纹，用于轨迹面板解释「为什么判定为无进展」 */
  stateHash?: string;
}

/** 10 种结构化终止原因（架构 §1.4.1）。UI 显示成人话，轨迹面板据此渲染不同徽标。 */
export type TerminationReason =
  | { code: 'GOAL_ACHIEVED'; summary: string }
  | { code: 'MAX_STEPS'; used: number; limit: number }
  | { code: 'BUDGET_EXCEEDED'; spentCny: number; limitCny: number; spentTokens: number }
  | { code: 'NO_PROGRESS'; stalls: number }
  | { code: 'LOOP_REPEAT_ARG'; toolName: string; times: number; argsHash: string }
  | { code: 'LOOP_STATE_OSCILLATION'; pattern: string }
  | { code: 'LOOP_NO_EFFECT'; unchangedSteps: number }
  | { code: 'CONSECUTIVE_FAILURE'; failures: number; lastError: string }
  | { code: 'USER_ABORTED'; atStep: number }
  | { code: 'VALIDATION_FAILED'; errors: string[] };

export type TerminationCode = TerminationReason['code'];

export interface RunStats {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costCny: number;
  /** 本机耗时（本地模型时这是主要「成本」参照，架构 §1.4.5） */
  wallMs: number;
  toolCalls: number;
  /** 累计改动处数 */
  edits: number;
  /** 被 checkpoint 保住的可回滚点数 */
  checkpoints: number;
}

export interface RunState {
  runId: string;
  goal: string;
  status: RunStatus;
  steps: StepRecord[];
  plan: Plan | null;
  observations: Observation[];
  stats: RunStats;
  /** 终止原因（仅status==='terminated' 时有值） */
  termination: TerminationReason | null;
  /** 终止时保留的改动数（闸门终止不回滚，架构 §1.4.1 关键决策） */
  keptChanges: number;
  startedAt: number;
  endedAt: number | null;
}

/** Agent 向 LLM 发起的一次工具选择请求 */
/** ToolCall 与 ToolCallRequest 在 types/tool.ts 定义，此处仅文档说明 */
export type { ToolCall } from './tool';

export interface ToolCallingCapability {
  /** native=标准 tools；prompted=文本协议<<TOOL:name{json}>>；unsupported=降级单步 */
  functionCalling: 'native' | 'prompted' | 'unsupported';
  streaming: boolean;
  maxContextTokens: number;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息可能携带工具调用请求 */
  toolCalls?: ToolCall[];
  /** tool 消息回填的观测结果 */
  observation?: Observation;
  name?: string;
}

export interface ToolCallCard {
  stepNo: number;
  toolName: string;
  danger: ToolDanger;
  writePolicy: string;
  argsSummary: string;
}