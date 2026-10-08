/**
 * 专家团类型定义。
 *
 * ★ 范围限定：只覆盖小说写作方向，不扩展到其他领域。
 * ★ 设计要点：职责边界用 `focus` / `ignore` 两个数组在**代码里声明**，
 *   而不是靠 prompt 里写「你不要管别人管的事」——prompt 约束不可验证，
 *   数据声明可以在裁决阶段直接拿来做越界降权与冲突判定。
 */

// ── 角色 ─────────────────────────────────────────────────────────────

export type ExpertRoleKey =
  | 'structure'
  | 'character'
  | 'dialogue'
  | 'prose'
  | 'reader'
  | 'genre';

export const EXPERT_ROLE_KEYS: ExpertRoleKey[] = [
  'structure',
  'character',
  'dialogue',
  'prose',
  'reader',
  'genre',
];

// ── 评审维度 ──────────────────────────────────────────────────────────

/**
 * 修改维度。刻意收敛成一小组：维度太细则冲突判定失去意义
 *（几乎不会有两个专家在同一个冷门维度上打架），太粗则裁决无从下手。
 */
export type ReviewDimension =
  | 'plot-structure'
  | 'pacing'
  | 'character'
  | 'dialogue'
  | 'prose'
  | 'reader-experience'
  | 'genre-convention'
  | 'setting-consistency';

export const REVIEW_DIMENSIONS: ReviewDimension[] = [
  'plot-structure',
  'pacing',
  'character',
  'dialogue',
  'prose',
  'reader-experience',
  'genre-convention',
  'setting-consistency',
];

// ── 严重度与判定 ─────────────────────────────────────────────────────

export type Severity = 'critical' | 'major' | 'minor' | 'nit';

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

/** 单个专家对单个维度的判断 */
export type OpinionVerdict = 'block' | 'suggest' | 'endorse' | 'neutral';

// ── 角色定义 ─────────────────────────────────────────────────────────

export interface RoleDefinition {
  key: ExpertRoleKey;
  displayName: string;
  /** 一句话职责，写进 prompt 告诉模型「你是谁」 */
  mission: string;
  /** 该角色**关心**的维度 */
  focus: ReviewDimension[];
  /** 该角色**明确不看**的维度（越界意见会被降权） */
  ignore: ReviewDimension[];
  /** 冲突裁决时的默认权重，可被项目配置覆盖 */
  defaultWeight: number;
  /** 是否主要做「体感判断」而非「技术诊断」——体感冒与诊断不同量纲 */
  intuitive: boolean;
}

// ── 意见与结论 ───────────────────────────────────────────────────────

export interface ExpertOpinion {
  role: ExpertRoleKey;
  dimension: ReviewDimension;
  severity: Severity;
  verdict: OpinionVerdict;
  /** 证据：引用原文片段或定位，便于用户核对 */
  evidence: string;
  /** 建议：具体可执行，不接受「加强描写」这类空话 */
  suggestion: string;
  /** 裁决阶段回填：该意见是否越界（触发了本角色的 ignore） */
  crossBoundary?: boolean;
  /** 裁决阶段回填：生效权重（越界时会被打折） */
  effectiveWeight?: number;
}

/** 冲突描述：冲突是这个产品最有价值的信息，必须完整保留 */
export interface ConflictRecord {
  dimension: ReviewDimension;
  /** 分歧的具体内容 */
  description: string;
  /** 参与冲突的角色 */
  parties: ExpertRoleKey[];
  /** 裁决依据：命中了 §裁决规则的第几条 */
  rule: ArbitrationRule;
  ruleLabel: string;
}

export type ArbitrationRule =
  | 'no-conflict'
  | 'hard-constraint'
  | 'severity'
  | 'role-weight'
  | 'genre-instinct'
  | 'defer-to-author';

export const ARBITRATION_RULE_LABEL: Record<ArbitrationRule, string> = {
  'no-conflict': '无冲突',
  'hard-constraint': '硬约束优先',
  severity: '严重度优先',
  'role-weight': '角色权重优先',
  'genre-instinct': '类型惯例优先',
  'defer-to-author': '交作者判断',
};

/** 单个维度的最终结论 */
export interface DimensionVerdict {
  dimension: ReviewDimension;
  /** accept=建议采纳；reject=经裁决后不采纳；defer=需作者判断 */
  decision: 'accept' | 'reject' | 'defer';
  /** 最终建议（合并同维度意见后） */
  suggestion: string;
  /** 0~1，参与该维度的意见按权重加权的共识强度 */
  confidence: number;
  /** 参与该维度的全部意见（含被否决的，供 UI 展示分歧） */
  opinions: ExpertOpinion[];
  conflict?: ConflictRecord;
}

// ── 汇总结果 ─────────────────────────────────────────────────────────

export interface ExpertReport {
  stage: ReviewStage;
  targetIds: string[];
  /** 实际激活的角色（不是全部 6 个） */
  activatedRoles: ExpertRoleKey[];
  verdicts: DimensionVerdict[];
  summary: {
    critical: number;
    major: number;
    minor: number;
    nit: number;
    /** 需要作者裁决的维度数 */
    needAuthor: number;
    /** 发生冲突的维度数 */
    conflicted: number;
  };
  /** 未激活角色的原因说明（如「配置未勾选」），用于 UI 解释 */
  skippedRoles: { role: ExpertRoleKey; reason: string }[];
}

export type ReviewStage = 'outline' | 'chapter' | 'post-polish';

// ── 配置 ─────────────────────────────────────────────────────────────

export interface ExpertTeamConfig {
  /** 总开关。关闭时工具不注册，Agent 看不到，原流程性能零影响 */
  enabled: boolean;
  /** 各阶段的默认激活角色 */
  defaultRoles: Record<ReviewStage, ExpertRoleKey[]>;
  /** 角色权重覆盖 */
  roleWeights: Partial<Record<ExpertRoleKey, number>>;
  /** 独立预算：不与 Agent 循环共享池子，专家评审超支不会把 Agent 带停 */
  budget: {
    maxTokens: number;
    maxCostCny: number;
    timeoutMs: number;
  };
  /** 专家团可单独指定模型（不跟随全局 provider） */
  providerId?: string;
}

export const DEFAULT_EXPERT_CONFIG: ExpertTeamConfig = {
  enabled: false,
  defaultRoles: {
    // 大纲评审只激活结构 + 类型，写正文前先查结构漏洞
    outline: ['structure', 'genre'],
    // 章节评审全开
    chapter: ['structure', 'character', 'dialogue', 'prose', 'reader', 'genre'],
    // 润色后复检只看文字与读者体感
    'post-polish': ['prose', 'reader'],
  },
  roleWeights: {},
  budget: {
    maxTokens: 60_000,
    maxCostCny: 1.5,
    timeoutMs: 120_000,
  },
};

// ── 去重配置 ─────────────────────────────────────────────────────────

/**
 * 意见去重：措辞相近的意见合并，保留最严severity。
 * 相似度用「关键词 Jaccard」而非向量——本地零依赖且可解释。
 */
export const DEDUPE_THRESHOLD = 0.72;
