/**
 * 结构化目标定义与评估器（架构 T16 补完）。
 *
 * ★ 为什么评估器是阻断级（团队负责人判定）：
 *   PRD 的核心承诺是「**谁在做决策**」。原型 FIX_RULES 是全量执行、无选择能力；
 *   Agent 必须是「归因 → 选规则子集 → 复检 → **判断是否达成**」。
 *   PRD §1.3 那个 10 步样例的第 10 步是「复评 → 87.4 ≥ 85 → GOAL_ACHIEVED」。
 *
 *   评估器返回固定值 = Agent 永远不会说「搞定了」=退化成
 *   「跑满步数的全量规则批处理器」，恰好是花三轮论证要避免的东西。
 */
import type { Evaluation } from '@shared/types/agent';

/**
 * 结构化目标。
 *
 * ★ 不接受自由文本：一句「看着改吧」无法判定达成。
 *   渲染层/调用方需把它解析成结构体；解析不出时用 kind:'custom' 交给 LLM 兜底。
 */
export type GoalSpec =
  /** 健康分达到阈值（如「把第 37 章健康分提到 85 以上」） */
  | { kind: 'health_score'; chapterId: string; threshold: number }
  /** 某指标降到阈值以下（如「triRepeat 降到 0.2 以下」） */
  | { kind: 'metric_below'; chapterId: string; metric: string; threshold: number }
  /** 某指标升到阈值以上 */
  | { kind: 'metric_above'; chapterId: string; metric: string; threshold: number }
  /** 一致性账本无冲突 */
  | { kind: 'no_conflicts'; threshold: number }
  /** 兜底：交给 LLM 判定 */
  | { kind: 'custom'; statement: string };

/** 评估所需的真实数据（★ 必须重新计算，不能用缓存的旧值） */
export interface EvalFacts {
  /** chapterId -> 当前健康分（本次复检现算） */
  healthScores: Record<string, number>;
  /** chapterId -> 指标值 */
  metrics: Record<string, Record<string, number>>;
  /** 当前冲突数 */
  conflictCount: number;
  /** 样本是否足够（不足时不能宣布达成） */
  sufficient: Record<string, boolean>;
}

export interface NumericVerdict {
  achieved: boolean;
  /** 面向用户的一句话结论，进轨迹面板 */
  reason: string;
  /** 实际值与阈值，供 UI 显示「87.4 ≥ 85」 */
  actual?: number;
  target?: number;
}

/**
 * 规则评估：四种可数值化的目标类型。
 *
 * ★ 关键：**「未达成」必须与「达成」同等重要**。
 *   循环需要靠它决定「重试 / 换策略 / 收手」，若只会说「没达成」，
 *   就退化成盲目重试——那正是闸门④要防的循环。
 */
export function evaluateGoal(goal: GoalSpec, facts: EvalFacts): NumericVerdict {
  switch (goal.kind) {
    case 'health_score': {
      const score = facts.healthScores[goal.chapterId];
      if (score === undefined) {
        return { achieved: false, reason: `第 ${goal.chapterId} 章还没有可评估的数据` };
      }
      if (facts.sufficient[goal.chapterId] === false) {
        return {
          achieved: false,
          reason: `第 ${goal.chapterId} 章字数不足，指标尚未稳定，不能宣布达成`,
        };
      }
      const achieved = score >= goal.threshold;
      return {
        achieved,
        actual: score,
        target: goal.threshold,
        reason: achieved
          ? `健康分 ${score.toFixed(1)} 已达到目标 ${goal.threshold}`
          : `健康分 ${score.toFixed(1)}，距目标 ${goal.threshold} 还差 ${(goal.threshold - score).toFixed(1)}`,
      };
    }

    case 'metric_below': {
      const v = readMetric(facts, goal.chapterId, goal.metric);
      if (v === undefined) {
        return { achieved: false, reason: `指标 ${goal.metric} 暂无可评估数据` };
      }
      const achieved = v <= goal.threshold;
      return {
        achieved,
        actual: v,
        target: goal.threshold,
        reason: achieved
          ? `${goal.metric} 已降到 ${fmt(v)}（≤ ${goal.threshold}）`
          : `${goal.metric} 当前 ${fmt(v)}，仍高于目标 ${goal.threshold}，差 ${fmt(v - goal.threshold)}`,
      };
    }

    case 'metric_above': {
      const v = readMetric(facts, goal.chapterId, goal.metric);
      if (v === undefined) {
        return { achieved: false, reason: `指标 ${goal.metric} 暂无可评估数据` };
      }
      const achieved = v >= goal.threshold;
      return {
        achieved,
        actual: v,
        target: goal.threshold,
        reason: achieved
          ? `${goal.metric} 已升到 ${fmt(v)}（≥ ${goal.threshold}）`
          : `${goal.metric} 当前 ${fmt(v)}，距目标 ${goal.threshold} 还差 ${fmt(goal.threshold - v)}`,
      };
    }

    case 'no_conflicts': {
      const achieved = facts.conflictCount <= goal.threshold;
      return {
        achieved,
        actual: facts.conflictCount,
        target: goal.threshold,
        reason: achieved
          ? `账本冲突数 ${facts.conflictCount}，已达标`
          : `账本还有 ${facts.conflictCount} 处冲突（目标 ≤ ${goal.threshold}）。` +
            `注意：冲突需你裁决，系统不会自动统一`,
      };
    }

    case 'custom':
      // custom 走 LLM 判定，这里只给出「规则层无法判定」的结论
      return { achieved: false, reason: '该目标需由模型判定，已转交 custom 评估路径' };
  }
}

function readMetric(facts: EvalFacts, chapterId: string, metric: string): number | undefined {
  const v = facts.metrics[chapterId]?.[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function fmt(v: number): string {
  return Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2);
}

/** 文本目标 → 结构化目标。解析不出来返回 null（调用方降级到 custom） */
export function parseGoal(text: string, knownChapters: string[]): GoalSpec | null {
  const t = text.trim();

  // 「第 37 章健康分提到 85 以上」/ 「健康分 85」
  const mHealth = t.match(/第\s*([0-9]+)\s*章?.*?(?:健康分|健康).*?(\d+(?:\.\d+)?)/);
  if (mHealth) {
    const chapterId = mHealth[1];
    const threshold = Number(mHealth[2]);
    if (knownChapters.includes(chapterId) && Number.isFinite(threshold)) {
      return { kind: 'health_score', chapterId, threshold };
    }
  }

  // 「triRepeat 降到 0.2 以下」/ 「dialog_ratio 低于 0.5」
  const mBelow = t.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:降到|低于|压到|小于)\s*(\d+(?:\.\d+)?)/);
  if (mBelow) {
    const cm = t.match(/第\s*([0-9]+)\s*章/);
    return {
      kind: 'metric_below',
      chapterId: cm ? cm[1] : (knownChapters[0] ?? '1'),
      metric: mBelow[1],
      threshold: Number(mBelow[2]),
    };
  }

  // 「提到 0.5 以上」
  const mAbove = t.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:提到|升到|提高到|大于)\s*(\d+(?:\.\d+)?)/);
  if (mAbove) {
    const cm = t.match(/第\s*([0-9]+)\s*章/);
    return {
      kind: 'metric_above',
      chapterId: cm ? cm[1] : (knownChapters[0] ?? '1'),
      metric: mAbove[1],
      threshold: Number(mAbove[2]),
    };
  }

  // 「检查全书有没有前后矛盾」/ 「没有冲突」
  if (/矛盾|冲突|一致性|对账/.test(t)) {
    return { kind: 'no_conflicts', threshold: 0 };
  }

  return null;
}

/**
 * custom 路径的 LLM 判定结果（Zod 校验）。
 * 用 schema 而非手写校验：模型返回的结构不可信，必须运行时校验。
 */
export const customVerdictSchema = {
  achieved: 'boolean',
  reason: 'string',
} as const;

export interface CustomVerdict {
  achieved: boolean;
  reason: string;
  /** Zod 校验失败的具体路径，用于回喂模型自纠 */
  errors?: string[];
}

/** 校验 custom 判定；返回带 errors 的结果，绝不抛 */
export function validateCustomVerdict(raw: unknown): CustomVerdict {
  const errors: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o['achieved'] !== 'boolean') {
    errors.push(`achieved: expected boolean, got ${typeof o['achieved']}`);
  }
  if (typeof o['reason'] !== 'string' || o['reason'].trim() === '') {
    errors.push(`reason: expected non-empty string, got ${typeof o['reason']}`);
  }
  if (errors.length > 0) {
    return { achieved: false, reason: '模型判定结果结构不合法，已拒绝采纳', errors };
  }
  return { achieved: o['achieved'] as boolean, reason: (o['reason'] as string).trim() };
}

/**
 * 把评估结论并入 Evaluation。
 *
 * ★ progress 的判定刻意与「达成」解耦：
 *   - 达成 → positive + goalAchieved
 *   - 未达成但有改进 → partial（继续）
 *   - 未达成且无改进 → none（交给闸门③判断是否停滞）
 *   - 未达成且**变差** → negative（触发副作用局部回滚）
 */
export function toEvaluation(
  verdict: NumericVerdict,
  baselineScore: number | undefined,
  currentScore: number | undefined,
  sideEffects: Evaluation['sideEffects'] = [],
): Evaluation {
  const delta =
    baselineScore !== undefined && currentScore !== undefined
      ? currentScore - baselineScore
      : undefined;

  let progress: Evaluation['progress'];
  if (verdict.achieved) {
    progress = 'positive';
  } else if (sideEffects.length > 0) {
    progress = 'negative';
  } else if (delta !== undefined && delta > 0.5) {
    progress = 'partial';
  } else if (delta !== undefined && delta < -0.5) {
    progress = 'negative';
  } else {
    progress = 'none';
  }

  return {
    progress,
    goalAchieved: verdict.achieved,
    reason: verdict.reason,
    sideEffects: sideEffects.length > 0 ? sideEffects : undefined,
    nextHint: verdict.achieved ? undefined : buildHint(verdict, progress),
  };
}

/** 未达成时给 Agent 的下一步建议（PRD：「允许失败，但不允许静默失败」） */
function buildHint(verdict: NumericVerdict, progress: Evaluation['progress']): string {
  if (progress === 'none') {
    return (
      `连续几步没有进展：${verdict.reason}。` +
      `建议换策略——换规则子集，或用 replace_phrase 做更小粒度的改动，避免反复无效重写。`
    );
  }
  if (progress === 'negative') {
    return `上一步引入了副作用，已自动撤回那条规则。${verdict.reason} 换一条规则试试。`;
  }
  return `${verdict.reason} 可继续，但注意不要做无收益改写。`;
}