/**
 * 副作用检测（架构 §1.4.4⑤⑥、T18）。
 *
 * 场景来自 PRD §1.3 第 7 步：F4 应用后 dialog_ratio 从 0.82 升到 0.87 超出 p95 →自动回滚 F4 只保留 F13。
 *
 * ★★ **最关键的一条判据（架构 §6.1 第 15 条铁律）**：
 *
 *   「引入新问题」的判据必须是：**改前是达标（ok）的** → 改后越界。
 *
 *   把一个本来就超标（risk）的指标改得更糟，**不算副作用**——
 *   它没有引入新问题，回滚它反而会误杀掉合法的改善。
 *   反例：avgSent 本来就risk（低于 p05），规则把它改得更低，
 *         若只判「改后越界」就会回滚掉这次改动，但它其实是有方向性的改善。
 *
 *   V16 待验证：20 组「改前 ok、改后越界」+ 20 组「改前已超标、改后更差」的样例，
 *   看判定准确率。后一类**不该**算副作用。
 *
 * ★ 判据必须**可解释**，不能是黑箱。每条副作用都要给出 cause：
 *   {toolName, ruleId, metric, before, after, p95}，
 *   让用户看到「F4 让对白占比从 0.82涨到 0.87，超出你的 p95 0.828，所以撤回了它」。
 */
import type { Grade, SideEffect } from '@shared/types/tool';
import type { MetricSpec } from '@shared/types/project';
import { analyze, grade } from '@shared/metrics-engine';
import { sideEffectTargetsOf } from '../rule-engine/fix-rules';

export interface BaselineLike {
  source: string;
  metrics: Record<string, MetricSpec>;
  markerDensity: Record<string, { p50: number; p95: number }>;
}

function gradeOfMarker(density: number, base: { p50: number; p95: number }): Grade {
  if (density <= base.p50) return 'ok';
  if (density <= base.p95) return 'warn';
  return 'risk';
}

/** 单个指标的等级（raw 或 marker 统一处理） */
function gradeFor(
  key: string,
  value: number,
  baseline: BaselineLike,
): { grade: Grade; bound: number; boundKind: 'p95' | 'p05'; label: string } | null {
  if (key.startsWith('marker:')) {
    const name = key.slice(7);
    const b = baseline.markerDensity[name];
    if (!b) return null;
    return {
      grade: gradeOfMarker(value, b),
      bound: b.p95,
      boundKind: 'p95',
      label: name,
    };
  }
  const spec = baseline.metrics[key];
  if (!spec) return null;
  return {
    grade: grade(value, spec),
    bound: spec.dir === 'low-bad' ? spec.p05 : spec.p95,
    boundKind: spec.dir === 'low-bad' ? 'p05' : 'p95',
    label: spec.label,
  };
}

export interface SideEffectOptions {
  /** 样本量不足时跳过判定（噪声太大） */
  minChars?: number;
  /** 只看这些指标的改动（改句长只看 avgSent/sentCv，不看全指标） */
  affectedMetrics: string[];
}

/**
 * 检测一次改动是否引入了副作用。
 *
 * @param before 改动前的正文
 * @param after  改动后的正文
 * @param toolName 产生改动的工具
 * @param ruleId  产生改动的规则（用于局部回滚定位）
 */
export function detectSideEffects(
  before: string,
  after: string,
  toolName: string,
  ruleId: string,
  chapterId: string,
  baseline: BaselineLike,
  opts: SideEffectOptions,
): SideEffect[] {
  const a = analyze(before);
  const b = analyze(after);

  // 样本量不足不改：短文本的所有指标噪声太大，误判代价高于收益
  const minChars = opts.minChars ?? 200;
  if (a.chars < minChars || b.chars < minChars) return [];

  const effects: SideEffect[] = [];

  for (const key of opts.affectedMetrics) {
    const beforeValue =
      key.startsWith('marker:')
        ? a.per1000[key.slice(7)] ?? 0
        : (a.raw[key as keyof typeof a.raw] as number | undefined);
    const afterValue =
      key.startsWith('marker:')
        ? b.per1000[key.slice(7)] ?? 0
        : (b.raw[key as keyof typeof b.raw] as number | undefined);

    if (beforeValue === undefined || afterValue === undefined) continue;
    if (typeof beforeValue !== 'number' || typeof afterValue !== 'number') continue;
    if (Number.isNaN(beforeValue) || Number.isNaN(afterValue)) continue;

    const gi = gradeFor(key, afterValue, baseline);
    if (!gi) continue;
    const gb = gradeFor(key, beforeValue, baseline);
    if (!gb) continue;

    // ★ 核心判据：只有「改前 ok → 改后越界」才算副作用
    if (gb.grade !== 'ok') continue;
    if (gi.grade === 'ok') continue;

    // 进一步收窄：只有「越界到 risk」才算；ok→warn 是轻微抖动，不值得回滚整条规则
    if (gi.grade !== 'risk') continue;

    effects.push({
      toolName,
      ruleId,
      chapterId,
      metric: key,
      before: beforeValue,
      after: afterValue,
      bound: gi.bound,
      boundKind: gi.boundKind,
      beforeGrade: gb.grade,
      afterGrade: gi.grade,
      rolledBack: false,
      explanation: explain(key, beforeValue, afterValue, gi.bound, gi.boundKind, gb.grade, gi.grade),
    });
  }

  return effects;
}

/** 人话解释：用户要能看到「为什么撤回了它」 */
function explain(
  metric: string,
  before: number,
  after: number,
  bound: number,
  boundKind: 'p05' | 'p95',
  beforeGrade: Grade,
  afterGrade: Grade,
): string {
  const dirWord = boundKind === 'p95' ? '超出上界' : '跌破下界';
  const gradeWord = beforeGrade === 'ok' && afterGrade === 'risk' ? '由达标变成严重偏离' : `由${beforeGrade} 变为${afterGrade}`;
  const fmt = (v: number): string => (Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2));
  return `${metric} 从 ${fmt(before)} 变为 ${fmt(after)}，${dirWord}你的${boundKind} ${fmt(bound)}（${gradeWord}），已自动撤回这条改动。`;
}

/**
 * 逐规则副作用复检 + 局部回滚（架构 §1.4.4⑤ 的代码骨架）。
 *
 * ★ 这与 checkpoint 是**正交**的：副作用回滚发生在「是否入栈」的判断里，
 *   checkpoint 只记录最终被接受的改动。这样撤销栈里不会混入「试过但被否」的中间态。
 */
export interface RuleApplication {
  ruleId: string;
  before: string;
  after: string;
  changes: unknown[];
}

export interface SideEffectSweepResult {
  /** 通过复检、可以入栈的改动 */
  accepted: RuleApplication[];
  /** 被副作用回滚的规则 */
  rejected: Array<{ ruleId: string; sideEffects: SideEffect[]; rolledBack: boolean }>;
}

export function sweepSideEffects(
  perRule: RuleApplication[],
  chapterId: string,
  toolName: string,
  baseline: BaselineLike,
  /** 回滚某条规则的实现；缺省表示无法回滚（则整条拒绝） */
  reapply: (keepRuleIds: string[]) => string,
  minChars?: number,
): SideEffectSweepResult {
  const accepted: RuleApplication[] = [];
  const rejected: SideEffectSweepResult['rejected'] = [];
  const acceptedIds: string[] = [];

  for (const app of perRule) {
    // 逐条复检：把当前这条规则叠加到已接受的结果上，看是否引入副作用
    const trial = reapply([...acceptedIds, app.ruleId]);
    const affected = targetsOfRule(app.ruleId);
    const effects = detectSideEffects(
      baseOf(acceptedIds, perRule),
      trial,
      toolName,
      app.ruleId,
      chapterId,
      baseline,
      { affectedMetrics: affected, minChars },
    );

    if (effects.length === 0) {
      accepted.push(app);
      acceptedIds.push(app.ruleId);
    } else {
      for (const e of effects) e.rolledBack = true;
      rejected.push({ ruleId: app.ruleId, sideEffects: effects, rolledBack: true });
      // 不加入 acceptedIds——等价于「这条规则不进正式 Patch」
    }
  }

  return { accepted, rejected };
}

/**
 * 规则 id → 副作用检测该盯的指标。
 *
 * ★ **不再手抄映射表**。修复前这里与 `tools/impl/fix.ts` 的 `ruleTargets()`
 *   各存一份同一知识，且已经分叉：本文件 F6 写 `openType`（正确），
 *   那边写 `dialogRatio`（错误——F6 是「章首公式」，与对白占比无关）。
 *   同一条规则经不同路径会拿到不同的检测面，副作用闸门因此漏判。
 *   现在两边都走 `sideEffectTargetsOf()`，真源是 `fix-rules.ts` 的
 *   `FixRule.targets` / `FixRule.sideEffectTargets`。
 */
function targetsOfRule(ruleId: string): string[] {
  return sideEffectTargetsOf(ruleId);
}

/** 取已接受规则的起点正文（第一条的 before） */
function baseOf(acceptedIds: string[], perRule: RuleApplication[]): string {
  if (acceptedIds.length === 0) {
    return perRule.length ? perRule[0].before : '';
  }
  for (const app of perRule) {
    if (app.ruleId === acceptedIds[0]) return app.before;
  }
  return perRule[0]?.before ?? '';
}

/** 便捷：一次改动的整体副作用（不逐规则，用于 replace_phrase 这类单规则工具） */
export function overallSideEffects(
  before: string,
  after: string,
  toolName: string,
  ruleId: string,
  chapterId: string,
  baseline: BaselineLike,
): SideEffect[] {
  const targets = targetsOfRule(ruleId);
  if (targets.length === 0) return [];
  return detectSideEffects(before, after, toolName, ruleId, chapterId, baseline, {
    affectedMetrics: targets,
  });
}