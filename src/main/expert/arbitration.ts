/**
 * 专家意见汇总裁决引擎（纯逻辑，无 IO、无 LLM）。
 *
 * ★ 为什么先做这个：冲突裁决是专家团的核心价值，也是唯一能不依赖模型
 *   就验证正确性的部分。先把它测扎实，二期接 LLM 时才能分清问题出在
 *   模型输出还是裁决逻辑。
 *
 * ★ 裁决规则的顺序是刻意的：先命中先生效。规则 5（弃权）是一等公民——
 *   专家团不该假装总能给出答案，真冲突时把选择权交还作者比硬凑结论有价值。
 */
import type {
  ConflictRecord,
  DimensionVerdict,
  ExpertOpinion,
  ExpertRoleKey,
  ExpertTeamConfig,
  ReviewDimension,
  ReviewStage,
  RoleDefinition,
  Severity,
} from '@shared/types/expert';
import {
  ARBITRATION_RULE_LABEL,
  DEDUPE_THRESHOLD,
  SEVERITY_ORDER,
} from '@shared/types/expert';
import { EXPERT_ROLES } from './roles';

/** 越界意见的权重折扣：一个越界的专家不该主导裁决 */
const CROSS_BOUNDARY_PENALTY = 0.3;

/** 严重度差达到此值即构成冲突（差 1 级不算分歧，算观察角度不同） */
const CONFLICT_SEVERITY_GAP = 2;

// ── 文本工具 ─────────────────────────────────────────────────────────

/** 中文按字切分：中文没有空格，按标点/空白切会丢失有效信息 */
function tokenizeCn(s: string): Set<string> {
  const cleaned = s.replace(/[\s\p{P}\p{S}]+/gu, '');
  const grams = new Set<string>();
  const chars = [...cleaned];
  for (let i = 0; i < chars.length; i++) {
    grams.add(chars[i]);
    if (i + 1 < chars.length) grams.add(chars[i] + chars[i + 1]);
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  // 遍历较小的集合，O(min)
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

// ── 越界判定与权重 ───────────────────────────────────────────────────

/**
 * 标记越界意见并算出生效权重。
 *
 * 越界不等于删除——一个文字编辑跑去说「节奏有问题」是越界，
 * 但这个观察仍有参考价值，所以降权而非丢弃。
 */
function markCrossBoundary(
  opinion: ExpertOpinion,
  roleDef: RoleDefinition | undefined,
  weightOverride: Partial<Record<ExpertRoleKey, number>>,
): ExpertOpinion {
  const cross = roleDef ? roleDef.ignore.includes(opinion.dimension) : false;
  // ★ 权重覆盖优先于默认权重：用户显式配了 2.0 就是 2.0，不该再被越界惩罚打折。
  //   越界惩罚只作用于「未覆盖」的基础权重。
  const overridden = weightOverride[opinion.role];
  const base = overridden ?? roleDef?.defaultWeight ?? 0.8;
  return {
    ...opinion,
    crossBoundary: cross,
    effectiveWeight: cross && overridden === undefined ? base * CROSS_BOUNDARY_PENALTY : base,
  };
}

// ── 同维度去重 ───────────────────────────────────────────────────────

/**
 * 同维度内合并措辞相近的意见。
 * 保留最严的 severity（问题严重度不因有人重复提及而降低），
 * 证据拼接、建议取更具体的（更长的往往更具体——空话通常很短）。
 */
function dedupe(opinions: ExpertOpinion[]): ExpertOpinion[] {
  const out: ExpertOpinion[] = [];
  for (const op of opinions) {
    const bag = tokenizeCn(`${op.suggestion} ${op.evidence}`);
    const hit = out.find(
      (o) =>
        o.role === op.role &&
        o.dimension === op.dimension &&
        jaccard(bag, tokenizeCn(`${o.suggestion} ${o.evidence}`)) >= DEDUPE_THRESHOLD,
    );
    if (!hit) {
      out.push({ ...op });
      continue;
    }
    hit.severity = maxSeverity(hit.severity, op.severity);
    // 建议保留信息量更大的那条
    if (op.suggestion.length > hit.suggestion.length) hit.suggestion = op.suggestion;
    if (op.evidence && !hit.evidence.includes(op.evidence)) {
      hit.evidence = hit.evidence ? `${hit.evidence}；${op.evidence}` : op.evidence;
    }
  }
  return out;
}

// ── 冲突检测 ─────────────────────────────────────────────────────────

/** 同维度上是否存在严重度断层（差≥2 级）才算真冲突 */
function detectConflict(opinions: ExpertOpinion[]): boolean {
  if (opinions.length < 2) return false;
  const levels = opinions.map((o) => SEVERITY_ORDER[o.severity]);
  return Math.max(...levels) - Math.min(...levels) >= CONFLICT_SEVERITY_GAP;
}

// ── 裁决 ─────────────────────────────────────────────────────────────

interface ArbitrationOutcome {
  decision: 'accept' | 'reject' | 'defer';
  /** 支撑该结论的意见（defer 时为空） */
  winner: ExpertOpinion | null;
  conflict?: ConflictRecord;
}

/**
 * 单维度裁决，五条规则按序执行。
 *
 * 注意每条规则都基于**全部参与意见**而非「两两对决」——
 * 三个专家吵起来时，两两投票会产生循环平票。
 */
function arbitrate(
  dimension: ReviewDimension,
  opinions: ExpertOpinion[],
): ArbitrationOutcome {
  if (opinions.length === 0) {
    return { decision: 'reject', winner: null };
  }
  // 只有一个专家有意见 → 无冲突，直接采纳（带 'no-conflict' 标记）
  if (opinions.length === 1) {
    return { decision: 'accept', winner: opinions[0] };
  }

  const conflicted = detectConflict(opinions);
  if (!conflicted) {
    // 无断层：取最严的 severity 作为该维度结论
    const winner = opinions.reduce((a, b) =>
      SEVERITY_ORDER[b.severity] > SEVERITY_ORDER[a.severity] ? b : a,
    );
    return { decision: 'accept', winner };
  }

  const pick = (fn: (o: ExpertOpinion) => number) =>
    opinions.reduce((a, b) => (fn(b) > fn(a) ? b : a));
  const weightOf = (o: ExpertOpinion) => o.effectiveWeight ?? 0.8;

  // 规则 1：硬约束优先
  const blockers = opinions.filter((o) => o.verdict === 'block');
  if (blockers.length > 0 && blockers.length < opinions.length) {
    return {
      decision: 'accept',
      winner: pick((o) => (o.verdict === 'block' ? 1 : 0)),
      conflict: {
        dimension,
        description: '存在阻断级意见与其它意见冲突',
        parties: opinions.map((o) => o.role),
        rule: 'hard-constraint',
        ruleLabel: ARBITRATION_RULE_LABEL['hard-constraint'],
      },
    };
  }

  // 规则 2：严重度优先
  const levels = opinions.map((o) => SEVERITY_ORDER[o.severity]);
  const gap = Math.max(...levels) - Math.min(...levels);
  const topLevel = Math.max(...levels);
  const topGroup = opinions.filter((o) => SEVERITY_ORDER[o.severity] === topLevel);
  if (topGroup.length === 1 && gap >= CONFLICT_SEVERITY_GAP) {
    return {
      decision: 'accept',
      winner: topGroup[0],
      conflict: {
        dimension,
        description: `严重度断层：${topGroup[0].severity} vs ${opinions.find((o) => o !== topGroup[0])?.severity}`,
        parties: opinions.map((o) => o.role),
        rule: 'severity',
        ruleLabel: ARBITRATION_RULE_LABEL.severity,
      },
    };
  }

  // 规则 3：角色权重（越界意见权重已被打折，这里天然体现「越界不主导」）
  const weightSorted = [...opinions].sort((a, b) => weightOf(b) - weightOf(a));
  const topWeight = weightOf(weightSorted[0]);
  const weightLeaders = weightSorted.filter((o) => weightOf(o) === topWeight);
  if (weightLeaders.length === 1) {
    return {
      decision: 'accept',
      winner: weightLeaders[0],
      conflict: {
        dimension,
        description: `按角色权重裁决（最高 ${topWeight.toFixed(2)}）`,
        parties: opinions.map((o) => o.role),
        rule: 'role-weight',
        ruleLabel: ARBITRATION_RULE_LABEL['role-weight'],
      },
    };
  }

  // 规则 4：类型惯例优先——仅当该维度属于类型守门人的 focus 且在场
  const genreOpinion = opinions.find(
    (o) => o.role === 'genre' && EXPERT_ROLES.genre.focus.includes(dimension),
  );
  const genreAlsoTop = genreOpinion && weightOf(genreOpinion) === topWeight;
  if (genreAlsoTop && weightLeaders.length > 1) {
    return {
      decision: 'accept',
      winner: genreOpinion,
      conflict: {
        dimension,
        description: '该维度涉及类型惯例，按类型守门人意见裁决',
        parties: opinions.map((o) => o.role),
        rule: 'genre-instinct',
        ruleLabel: ARBITRATION_RULE_LABEL['genre-instinct'],
      },
    };
  }

  // 规则 5：弃权——把选择权交还作者
  return {
    decision: 'defer',
    winner: null,
    conflict: {
      dimension,
      description:
        weightLeaders.length > 1
          ? '多位专家意见相反且权重相当'
          : '存在严重度断层但无法明确判定优劣',
      parties: opinions.map((o) => o.role),
      rule: 'defer-to-author',
      ruleLabel: ARBITRATION_RULE_LABEL['defer-to-author'],
    },
  };
}

// ── 汇总 ─────────────────────────────────────────────────────────────

export interface AggregateInput {
  stage: ReviewStage;
  targetIds: string[];
  opinions: ExpertOpinion[];
  config: ExpertTeamConfig;
  /** 实际激活的角色 */
  activatedRoles: ExpertRoleKey[];
  /** 未激活角色的原因（用于 UI 解释「为什么只有 3 个」） */
  skippedRoles?: { role: ExpertRoleKey; reason: string }[];
}

/**
 * 把多专家的原始意见汇总成一份可呈现的评审报告。
 *
 * 输出里**保留被否决的意见**（`opinions` 字段全量），
 * 因为「哪方被否决了、为什么」本身就是用户需要的信息。
 */
export function aggregateOpinions(input: AggregateInput): {
  verdicts: DimensionVerdict[];
  summary: ExpertTeamReportSummary;
} {
  const { config } = input;

  // 1. 标记越界 + 算生效权重
  const marked = input.opinions.map((o) =>
    markCrossBoundary(o, EXPERT_ROLES[o.role], config.roleWeights),
  );

  // 2. 按维度分组 → 去重
  const byDim = new Map<ReviewDimension, ExpertOpinion[]>();
  for (const op of marked) {
    const arr = byDim.get(op.dimension);
    if (arr) arr.push(op);
    else byDim.set(op.dimension, [op]);
  }

  // 3. 逐维度裁决
  const verdicts: DimensionVerdict[] = [];
  for (const [dimension, rawGroup] of byDim) {
    const deduped = dedupe(rawGroup);
    const outcome = arbitrate(dimension, deduped);

    // 共识强度：采纳方权重 / 总权重。
    // defer 时恒为「无共识」（0.5）——不能因为「多方都有意见」就显示成高置信，
    // 那会让 UI 上待裁决的条目看起来像是已经有答案了。
    const totalWeight = deduped.reduce(
      (s, o) => s + (o.effectiveWeight ?? 0.8),
      0,
    );
    const confidence =
      outcome.decision === 'defer'
        ? 0.5
        : totalWeight > 0 && outcome.winner
          ? (outcome.winner.effectiveWeight ?? 0.8) / totalWeight
          : 0;

    const suggestion =
      outcome.decision === 'accept' && outcome.winner
        ? outcome.winner.suggestion
        : outcome.decision === 'defer'
          ? deduped.map((o) => `${roleName(o.role)}：${o.suggestion}`).join(' / ')
          : '';

    const verdict: DimensionVerdict = {
      dimension,
      decision: outcome.decision,
      suggestion,
      confidence: Math.max(0, Math.min(1, confidence)),
      opinions: deduped,
    };
    if (outcome.conflict) verdict.conflict = outcome.conflict;
    verdicts.push(verdict);
  }

  // 4. 按严重度降序，让 UI 不用再排
  verdicts.sort((a, b) => {
    const aMax = Math.max(
      0,
      ...a.opinions.map((o) => SEVERITY_ORDER[o.severity]),
    );
    const bMax = Math.max(
      0,
      ...b.opinions.map((o) => SEVERITY_ORDER[o.severity]),
    );
    return bMax - aMax;
  });

  // 5. 汇总统计
  const summary: ExpertTeamReportSummary = {
    critical: 0,
    major: 0,
    minor: 0,
    nit: 0,
    needAuthor: 0,
    conflicted: 0,
  };
  for (const v of verdicts) {
    if (v.conflict) summary.conflicted++;
    if (v.decision === 'defer') summary.needAuthor++;
    for (const o of v.opinions) {
      if (o.severity === 'critical') summary.critical++;
      else if (o.severity === 'major') summary.major++;
      else if (o.severity === 'minor') summary.minor++;
      else summary.nit++;
    }
  }

  return { verdicts, summary };
}

interface ExpertTeamReportSummary {
  critical: number;
  major: number;
  minor: number;
  nit: number;
  needAuthor: number;
  conflicted: number;
}

function roleName(key: ExpertRoleKey): string {
  return EXPERT_ROLES[key]?.displayName ?? key;
}

// ── 对照（润色后复检用）───────────────────────────────────────────────

export interface DimensionDelta {
  dimension: ReviewDimension;
  before: DimensionVerdict;
  after: DimensionVerdict;
  /** improved=改善了；regressed=变差了；same=没变 */
  trend: 'improved' | 'regressed' | 'same';
}

/**
 * 对照两次评审，判断每个维度的走向。
 *
 * 用途：润色后复检。这是「润色是否真的变好了」的唯一客观依据——
 * 经典规则引擎会全量应用所有规则而不问效果，本函数提供回答的能力。
 */
export function compareReports(
  before: DimensionVerdict[],
  after: DimensionVerdict[],
): DimensionDelta[] {
  const beforeMap = new Map(before.map((v) => [v.dimension, v]));
  const dims = new Set<ReviewDimension>([
    ...before.map((v) => v.dimension),
    ...after.map((v) => v.dimension),
  ]);
  const out: DimensionDelta[] = [];
  for (const d of dims) {
    const b = beforeMap.get(d);
    const a = after.find((v) => v.dimension === d);
    if (!b && !a) continue;
    if (!b) {
      // 润色前没问题，润色后有问题 → 变差
      out.push({ dimension: d, before: emptyVerdict(d), after: a!, trend: 'regressed' });
      continue;
    }
    if (!a) {
      out.push({ dimension: d, before: b, after: emptyVerdict(d), trend: 'improved' });
      continue;
    }
    const bScore = dimScore(b);
    const aScore = dimScore(a);
    out.push({
      dimension: d,
      before: b,
      after: a,
      trend: aScore < bScore ? 'improved' : aScore > bScore ? 'regressed' : 'same',
    });
  }
  return out;
}

/** 维度健康度分：severity 越高分越低，confidence 越高分越接近 0 */
function dimScore(v: DimensionVerdict): number {
  if (v.opinions.length === 0) return 0;
  const worst = Math.max(...v.opinions.map((o) => SEVERITY_ORDER[o.severity]));
  return worst * (1 - v.confidence) + worst;
}

function emptyVerdict(dimension: ReviewDimension): DimensionVerdict {
  return {
    dimension,
    decision: 'accept',
    suggestion: '',
    confidence: 1,
    opinions: [],
  };
}
