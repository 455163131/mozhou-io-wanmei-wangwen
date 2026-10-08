/**
 * 修正计划器（架构 §1.3 铁律 3 / T08）。
 *
 * ★★★ **本文件是「preview 与 execute 共用同一段变换逻辑」的落点**★★★
 *
 * 架构原话：「写成两个函数，100% 会出现『预览显示改 3 处，实际改了 4 处』，
 * 用户信任直接崩掉。」
 *
 * 因此这里只有**一个** `planFixes()`，它只做「算」，不做「落盘」。
 * dry-run 与真实执行的区别仅在于调用方是否把结果写进 DB。
 * 下面的 `applyPlan()` 负责落盘并回滚，两者严格分离。
 */
import type { Edit } from '@shared/types/tool';
import { analyze, deviation, judge, MARKER_KEYS } from '@shared/metrics-engine';
import type { MetricSpec } from '@shared/types/project';
import {
  FIX_RULES,
  type FixContext,
  type FixRule,
  notApplicableWhy,
} from './fix-rules';

export interface PlanSkipped {
  id: string;
  label: string;
  layer?: string;
  targets: string[];
  /** 该规则是否与当前章节相关（有偏离才相关） */
  relevant: boolean;
  /** 改动处数（仅「试了但无效」时有） */
  changes?: number;
  why: string;
}

export interface FixPlan {
  before: string;
  after: string;
  changes: Edit[];
  skipped: PlanSkipped[];
  scoreBefore: number;
  scoreAfter: number;
  /** 逐规则产出的改动，供副作用检测逐规则回滚（架构 §1.4.4⑤） */
  perRule: Array<{ ruleId: string; before: string; after: string; changes: Edit[] }>;
}

export interface BaselineLike {
  source: string;
  metrics: Record<string, MetricSpec>;
  markerDensity: Record<string, { p50: number; p95: number }>;
}

/** 构造规则执行上下文 */
export function fixContext(text: string, baseline: BaselineLike): FixContext {
  const a = analyze(text);
  const devs: Record<string, number> = {};
  const low: Record<string, number> = {};
  const high: Record<string, number> = {};

  /**
   * 登记一个指标的偏离**幅度与方向**。
   *
   * ★★ 为什么必须分开记方向 ★★
   * `deviation()` 只返回幅度（恒 ≥0），把方向丢掉了。而 F7~F10 的判据依赖方向：
   * 句长偏短要合并、偏长要切分；段落偏碎要合并、偏长要切分。
   *
   * 修复前 `low` 与 `high` 都被赋成 `a.raw`（指标实测值），后果是三条规则
   * 朝**错误方向**改写用户正文：
   *   · F7 的 `ctx.low.avgSent` 恒为真（实测句长非零）→ 永远走「合并短句」，
   *     长句章不但没被切分，反而被继续合并；
   *   · F8/F9 的 `!!ctx.low.x` 退化成「值非零即真」→ sentCv 已经过高（节奏够乱）
   *     时仍去做「长短交错」，sentsPerPara 已经过高时仍去「段落合并」；
   *   · F10 的 `!!ctx.high.avgPara` 同理 → 段落本就偏短时仍去「长段切分」。
   */
  const put = (key: string, dev: number, below: boolean): void => {
    devs[key] = dev;
    low[key] = dev > 0 && below ? dev : 0;
    high[key] = dev > 0 && !below ? dev : 0;
  };

  for (const [key, spec] of Object.entries(baseline.metrics)) {
    const v = a.raw[key as keyof typeof a.raw];
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    // 双侧区间（p05~p95）：低于下界才算「偏低」
    put(key, deviation(v, spec), v < spec.p05);
  }
  for (const k of MARKER_KEYS) {
    const b = baseline.markerDensity[k];
    if (!b) continue;
    // marker 型语义是「越低越好」（见 deviation 的 MarkerSpec 分支），
    // 只可能偏高，永不判偏低。
    put(`marker:${k}`, deviation(a.per1000[k] || 0, { p50: b.p50, p95: b.p95 }), false);
  }

  return {
    a: a.raw as unknown as Record<string, number>,
    devs,
    low,
    high,
    per1000: a.per1000,
  };
}

/** 取一组 target 键在当前文本下的偏离度（0 = 达标） */
export function targetDevs(
  text: string,
  targets: string[],
  baseline: BaselineLike,
): Record<string, number> {
  const a = analyze(text);
  const out: Record<string, number> = {};
  for (const k of targets) {
    if (k.indexOf('marker:') === 0) {
      const key = k.slice(7);
      const b = baseline.markerDensity[key];
      if (!b) continue;
      out[k] = deviation(a.per1000[key] || 0, { p50: b.p50, p95: b.p95 });
    } else if (baseline.metrics[k]) {
      const v = a.raw[k as keyof typeof a.raw];
      if (typeof v === 'number') out[k] = deviation(v, baseline.metrics[k]);
    }
  }
  return out;
}

function scoreOf(text: string, baseline: BaselineLike): number {
  const a = analyze(text);
  const items = judge({
    raw: a.raw,
    per1000: a.per1000,
    metrics: baseline.metrics,
    markerDensity: baseline.markerDensity,
  });
  const penalty = items.reduce(
    (s, i) => s + (i.level === 'risk' ? 14 : i.level === 'warn' ? 6 : 0),
    0,
  );
  return Math.max(0, Math.min(100, 100 * (1 - penalty / (16 * 14))));
}

/**
 * 规则级效果复测：**改动必须让至少一个目标指标的偏离度下降，否则整条回退**。
 *
 * 理由：若指标统计了正文全部字数、而可改片段又被引号/专名保护，规则会空转——
 * 改了几十处却一分不涨，等于无收益地改动作者正文。宁可不动，也要如实说明。
 * （目标键一个都解析不出来时不设闸，退回旧行为，避免误杀。）
 */
function ruleIsWorthIt(
  cur: string,
  result: string,
  rule: FixRule,
  baseline: BaselineLike,
): { measurable: boolean; improved: boolean } {
  const dA = targetDevs(cur, rule.targets, baseline);
  const dB = targetDevs(result, rule.targets, baseline);
  const measurable = Object.keys(dA).length > 0;
  const improved = Object.keys(dA).some((k) => dB[k] < dA[k] - 1e-9);
  return { measurable, improved };
}

export interface PlanFixesOptions {
  /** 只跑指定规则；不传 = 全部 auto 规则 */
  rules?: string[];
  baseline: BaselineLike;
}

/**
 * ★ 唯一的变换逻辑。preview 与 execute 都调它，**不存在第二份实现**。
 * 本函数**不做任何IO**，纯计算，可安全用于预览。
 */
export function planFixes(text: string, opts: PlanFixesOptions): FixPlan {
  const only = opts.rules ?? null;
  const baseline = opts.baseline;
  const ctx = fixContext(text, baseline);
  const scoreBefore = scoreOf(text, baseline);

  let cur = text;
  const changes: Edit[] = [];
  const skipped: PlanSkipped[] = [];
  const perRule: FixPlan['perRule'] = [];

  for (const rule of FIX_RULES) {
    if (only && only.indexOf(rule.id) < 0) continue;

    if (!rule.auto) {
      // 负面知识也进入 skipped，让 UI 能显示「这章有 2 处系统不自动改的原因」
      skipped.push({
        id: rule.id,
        label: rule.label,
        targets: rule.targets,
        relevant: rule.targets.some((k) => !!ctx.devs[k]),
        why: rule.why ?? '',
      });
      continue;
    }

    const need = rule.targets.some((k) => !!ctx.devs[k]);
    if (rule.applies && !rule.applies(cur, ctx)) continue;
    if (!rule.applies && !need) continue;

    // auto:false 已在上方 return；此处再判一次是类型窄化所需
    if (!rule.fix) continue;
    const r = rule.fix(cur, ctx);
    if (!r || r.changes.length === 0) {
      if (need) {
        skipped.push({
          id: rule.id,
          label: rule.label,
          targets: rule.targets,
          relevant: true,
          why: notApplicableWhy(rule),
        });
      }
      continue;
    }

    const { measurable, improved } = ruleIsWorthIt(cur, r.text, rule, baseline);
    if (measurable && !improved) {
      skipped.push({
        id: rule.id,
        label: rule.label,
        targets: rule.targets,
        relevant: true,
        changes: r.changes.length,
        why:
          `命中 ${r.changes.length} 处，但复测后目标指标未改善` +
          `（可改片段集中在受保护的对白或专有名词上），已整条回退，不做无收益改写。`,
      });
      continue;
    }

    perRule.push({ ruleId: rule.id, before: cur, after: r.text, changes: r.changes });
    for (const c of r.changes) {
      changes.push({
        ...c,
        note: `${rule.label}：${c.note}`.replace(new RegExp(`^${rule.label}：${rule.label}：`), `${rule.label}：`),
        ruleId: rule.id,
      });
    }
    cur = r.text;
  }

  return {
    before: text,
    after: cur,
    changes,
    skipped,
    scoreBefore,
    scoreAfter: scoreOf(cur, baseline),
    perRule,
  };
}

/**
 * 局部回滚单条规则：把某条规则的改动从结果中撤销，其它规则的改动保留。
 *
 * 实现方式：从 before 重放**除该规则外**的所有规则。
 * 为什么不用「反向 patch」：规则之间会相互影响偏移，反向 patch 不可靠；
 * 重放是确定性的，且与 planFixes 用同一段逻辑，口径一致。
 */
export function rollbackRule(
  plan: FixPlan,
  ruleId: string,
  opts: PlanFixesOptions,
): { text: string; removed: Edit[] } {
  if (!plan.perRule.some((r) => r.ruleId === ruleId)) {
    // 该规则本就没产生改动，无需回滚
    return { text: plan.after, removed: [] };
  }

  // 从原文重放「除该规则外」的全部规则。
  // 为什么不反向 patch：规则之间会相互影响偏移，反向 patch 不可靠；
  // 重放是确定性的，且复用 planFixes 同一段逻辑，口径与执行时完全一致。
  const replanned = planFixes(plan.before, {
    ...opts,
    rules: plan.perRule.filter((r) => r.ruleId !== ruleId).map((r) => r.ruleId),
  });

  // 被撤销的编辑 = 原计划全部编辑 - 重放后保留的编辑
  const keptKeys = new Set(replanned.changes.map((c) => `${c.at}:${c.before}`));
  const removed = plan.changes.filter((c) => !keptKeys.has(`${c.at}:${c.before}`));
  return { text: replanned.after, removed };
}

/** 统计改动处数与字节数 */
export function planStats(plan: FixPlan): { edits: number; bytes: number } {
  return {
    edits: plan.changes.length,
    bytes: Buffer.byteLength(plan.after, 'utf8') - Buffer.byteLength(plan.before, 'utf8'),
  };
}