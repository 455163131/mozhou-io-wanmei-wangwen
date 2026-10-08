/**
 * 内置 AI 味基线常量测试。
 *
 * ★ 为什么值得单测一个「常量」：
 *   基线是引擎判定的锚点，一旦被手工改错（抄错分位、漏指标、把零膨胀改成非零），
 *   引擎的「偏不偏高」会静默失准且极难发现。本用例把两条**事实**固化下来：
 *     1) 11 个指标齐全、分位数单调自洽；
 *     2) connector_per1000 与 parallel_per100sent 的 p95 恒为 0（零膨胀事实）。
 *   第 2 条尤其重要——后来人看到 p95=0 很容易以为是脏数据而「顺手修一下」。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLAVOR_BASELINE,
  FLAVOR_METRIC_KEYS,
  isBaselineStale,
  type MetricBaseline,
} from '@shared/ai-flavor/baseline';
import { FLAVOR_ENGINE_VERSION, FLAVOR_FEATURE_VERSION } from '@shared/ai-flavor/engine';

/** MetricBaseline 的全部数值字段（顺序即断言顺序） */
const FIELDS = ['p05', 'p25', 'p50', 'p75', 'p95', 'mean', 'min', 'max'] as const;

/** 逐个指标的断言顺序阶梯：用于验证分位数单调 */
const MONOTONIC = ['p05', 'p25', 'p50', 'p75', 'p95'] as const;

describe('DEFAULT_FLAVOR_BASELINE · 内置基线常量', () => {
  it('11 个指标齐全，且键集合与 FLAVOR_METRIC_KEYS 完全一致', () => {
    const keys = Object.keys(DEFAULT_FLAVOR_BASELINE.metrics).sort();
    expect(keys).toEqual([...FLAVOR_METRIC_KEYS].sort());
    // 显式再点一遍数量：11，防止未来误删被「集合相等」掩盖
    expect(FLAVOR_METRIC_KEYS).toHaveLength(11);
    expect(keys).toHaveLength(11);
  });

  it('每个指标 8 个分位字段齐全，且均为有限数', () => {
    for (const key of FLAVOR_METRIC_KEYS) {
      const m: MetricBaseline = DEFAULT_FLAVOR_BASELINE.metrics[key];
      expect(m, `指标 ${key} 缺失`).toBeTruthy();
      for (const f of FIELDS) {
        expect(Number.isFinite(m[f]), `指标 ${key}.${f} 不是有限数：${m[f]}`).toBe(true);
      }
    }
  });

  it('分位数自洽：p05 ≤ p25 ≤ p50 ≤ p75 ≤ p95，且 min ≤ p05、p95 ≤ max', () => {
    for (const key of FLAVOR_METRIC_KEYS) {
      const m = DEFAULT_FLAVOR_BASELINE.metrics[key];
      for (let i = 1; i < MONOTONIC.length; i++) {
        const lo = m[MONOTONIC[i - 1]];
        const hi = m[MONOTONIC[i]];
        expect(lo, `指标 ${key} 分位非单调：${MONOTONIC[i - 1]}=${lo} > ${MONOTONIC[i]}=${hi}`).toBeLessThanOrEqual(hi);
      }
      expect(m.min, `指标 ${key} 的 min > p05`).toBeLessThanOrEqual(m.p05);
      expect(m.p95, `指标 ${key} 的 p95 > max`).toBeLessThanOrEqual(m.max);
    }
  });

  it('★ 零膨胀事实：connector_per1000 与 parallel_per100sent 的 p95 === 0', () => {
    // 这两项在人写网文里 ≥95% 章节为 0，p95=0 是**数据事实**而非缺失/脏数据。
    // 若此断言失败，多半是有人手工改动了常量——请先确认语料再改，别直接放行。
    expect(DEFAULT_FLAVOR_BASELINE.metrics.connector_per1000.p95).toBe(0);
    expect(DEFAULT_FLAVOR_BASELINE.metrics.parallel_per100sent.p95).toBe(0);
    // 但 max 必须 > 0：否则说明这两列可能整体没算（真·空数据）
    expect(DEFAULT_FLAVOR_BASELINE.metrics.connector_per1000.max).toBeGreaterThan(0);
    expect(DEFAULT_FLAVOR_BASELINE.metrics.parallel_per100sent.max).toBeGreaterThan(0);
  });

  it('元信息正确：source=builtin、chapters=715、totalChars=1515404、engineVersion 非空', () => {
    expect(DEFAULT_FLAVOR_BASELINE.source).toBe('builtin');
    expect(DEFAULT_FLAVOR_BASELINE.chapters).toBe(715);
    expect(DEFAULT_FLAVOR_BASELINE.totalChars).toBe(1515404);
    expect(DEFAULT_FLAVOR_BASELINE.corpus).toBe('系统面板永远是零');
    expect(DEFAULT_FLAVOR_BASELINE.at).toBe(0); // 编译期常量无生成时刻，固定为 0
    // ★ 这里**故意只校验非空**，不硬绑定 `FLAVOR_FEATURE_VERSION` 的取值：
    //   常量随特征口径联动，硬断言会让「特征口径升版」这条**应当发生**的变更意外弄红测试。
    //   版本与数据的对应关系由 gen-baseline-constant.mjs 的提醒保证。
    expect(typeof DEFAULT_FLAVOR_BASELINE.engineVersion).toBe('string');
    expect(DEFAULT_FLAVOR_BASELINE.engineVersion.length).toBeGreaterThan(0);
  });
});

describe('isBaselineStale · 基线过期判断（比较对象是「特征提取版本」，不是「引擎版本」）', () => {
  it('★ 默认基线不得误报过期（T02 只改打分、未改特征提取）', () => {
    // FLAVOR_ENGINE_VERSION（打分口径）已升到 2.0.0，但 FLAVOR_FEATURE_VERSION（特征口径）
    // 仍是 1.0.0；基线存的是特征分位数 → 依然有效 → 必须为 false。
    // ★ 这是本补丁要锁的核心行为：用引擎版本当判据会误报，导致 UI 对每个用户弹「建议重建」。
    expect(isBaselineStale(DEFAULT_FLAVOR_BASELINE)).toBe(false);
    // 顺带固化「打分版本 ≠ 特征版本」当前成立（2.0.0 ≠ 1.0.0）——两个概念彼此独立。
    expect(FLAVOR_ENGINE_VERSION).not.toBe(FLAVOR_FEATURE_VERSION);
  });

  it('★ 比较对象是特征版本：把 engineVersion 设成「引擎版本」应判为过期', () => {
    // 若 isBaselineStale 误用 FLAVOR_ENGINE_VERSION，这条会得到 false（即错误地放行）。
    const wrong = { ...DEFAULT_FLAVOR_BASELINE, engineVersion: FLAVOR_ENGINE_VERSION };
    expect(isBaselineStale(wrong)).toBe(true);
  });

  it('engineVersion 等于特征版本 → false（基线可用）', () => {
    const fresh = { ...DEFAULT_FLAVOR_BASELINE, engineVersion: FLAVOR_FEATURE_VERSION };
    expect(isBaselineStale(fresh)).toBe(false);
  });

  it('engineVersion 与特征版本不同 → true（特征口径变了，基线过期）', () => {
    const stale = { ...DEFAULT_FLAVOR_BASELINE, engineVersion: '0.9.0' };
    expect(isBaselineStale(stale)).toBe(true);
  });
});
