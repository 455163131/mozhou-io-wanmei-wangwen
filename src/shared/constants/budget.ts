/**
 * 预算默认值（架构 §1.4.1）。
 * 所有值可被 agent.run 的 budget 参数覆盖，但默认值必须保守——
 * Agent 循环最坏情况是反复重试，每次都烧 token（这是上一轮评估里 E3 最大的坑）。
 */

export interface BudgetLimits {
  /** 闸门① 步数上限 */
  maxSteps: number;
  /** 闸门② token 上限 */
  maxTokens: number;
  /** 闸门② 成本上限（元）。本地模型恒不触发，退化为本机耗时上限 */
  maxCostCny: number;
  /** 本地模型专用：防本地模型跑几小时不收敛（架构 §1.4.5） */
  maxWallMs: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxSteps: 24,
  maxTokens: 200_000,
  maxCostCny: 5.0,
  maxWallMs: 2 * 60 * 60 * 1000,
};

/** 闸门③ 无进展检测：连续 N 次 progress==='none' 即终止 */
export const MAX_NO_PROGRESS = 3;

/** 闸门⑤ 连续失败：连续 N 次工具失败即终止 */
export const MAX_CONSECUTIVE_FAILURE = 3;

/**
 * 连续参数校验失败上限 → VALIDATION_FAILED。
 * 取 2：模型改一次参数仍不合法，基本可以断定它误解了 schema，
 * 再试也是烧 token（架构 §1.4.3 给的重试上限也是 2）。
 */
export const MAX_VALIDATION_FAILURE = 2;

/**
 * 闸门④ 循环检测判据 A：同参数重复调用。
 * key = toolName + hash(canonicalJSON(normalizedArgs))
 */
export const LOOP_ARG_WINDOW = 8;
/** 窗口内同一 key 出现≥ 3 次即判定（idempotent 工具豁免） */
export const LOOP_ARG_THRESHOLD = 3;

/** 闸门④ 循环检测判据 B：状态指纹振荡。窗口 8步内出现 ABAB 模式即判定 */
export const LOOP_FINGERPRINT_WINDOW = 8;
/** 序列中 ABAB 模式的最小重复次数 */
export const LOOP_OSCILLATION_MIN_REPEATS = 3;

/** 健康分扣分权重（架构 §1.4.1） */
export const SCORE_RISK_PENALTY = 14;
export const SCORE_WARN_PENALTY = 6;

/**
 * ★ 修复审查发现 MZ-013：可判项共 16 个（8 指标 + 8 标记），
 * 原实现 100/14≈7.1 导致第 8 个 risk 即触底 0 分，后半程零区分度。
 * 现按可判项数归一化。
 */
export const TOTAL_JUDGEABLE_ITEMS = 16;

/**
 * 上下文预算（架构 §1.4.2）。
 * per-chapter 预算按 provider 的 maxContextTokens 动态收缩，
 * 不能沿用云端数值——本地模型窗口小一个量级（架构 §6.1 第 17 条）。
 */
export interface ContextBudget {
  /** L1 常驻：系统提示 + 工具 schema + 风格指纹 */
  l1Chars: number;
  /** L2 计划 */
  l2Chars: number;
  /** L3 工作集：正文为主的总额度 */
  l3Chars: number;
  /** L4 历史：Observation */
  l4Chars: number;
  /** 单章上限 */
  perChapterCap: number;
  /** 单章下限 */
  perChapterFloor: number;
}

/** 按 maxContextTokens 估算字符预算。粗略比例：1 token ≈ 1.5 个中文字符 */
export function contextBudgetFor(maxContextTokens: number): ContextBudget {
  // 留1/4 给系统提示与工具 schema
  const usableTokens = Math.floor(maxContextTokens * 0.75);
  const totalChars = Math.floor(usableTokens * 1.5);
  return {
    l1Chars: Math.floor(totalChars * 0.15),
    l2Chars: Math.floor(totalChars * 0.08),
    l3Chars: Math.floor(totalChars * 0.6),
    l4Chars: Math.floor(totalChars * 0.17),
    perChapterCap: 4000,
    perChapterFloor: 200,
  };
}

/** 云端默认预算（DeepSeek 等） */
export const CLOUD_CONTEXT_BUDGET = contextBudgetFor(64_000);

/** 本地模型默认预算（Ollama 常见 8192） */
export const LOCAL_CONTEXT_BUDGET = contextBudgetFor(8_192);

/** L4 历史保留原文的最近步数，更早的压缩为一行 */
export const RECENT_OBSERVATIONS_RAW = 6;

/** 单条 Observation 送入上下文的上限字符数 */
export const OBSERVATION_CHARS_CAP = 400;

/** 单个工具参数的最大长度（防把整本书塞进参数） */
export const MAX_PARAM_STRING_LENGTH = 200_000;

/** 单次工具调用涉及的最大章节数（跨章工具的硬上限，防止一次改 500 章） */
export const MAX_CHAPTERS_PER_CALL = 50;