/**
 * AI 味「基线」· 纯 shared 层（零 Node import / 零 IO / 零副作用）。
 *
 * ★ 基线是什么、为什么要它：
 *   引擎各维度的 `scale(value, good, bad)` 需要一组「人写一侧 / AI 一侧」的锚点。
 *   锚点若凭手感写，会随作者、题材漂移；本文件把锚点换成**同一语料实测的分位数**，
 *   让「偏高 / 正常」有可核对的依据，而不是拍脑袋。
 *
 * ★ 数据来源（可复现）：
 *   - 语料：《系统面板永远是零》定稿 715 章，1,515,404 字
 *   - 计算脚本：`scripts/compute-flavor-baseline.mjs`（import 真实 engine.ts，口径零漂移）
 *   - 生成脚本：`scripts/gen-baseline-constant.mjs`（由上述脚本产出的 JSON 重写本文件常量块）
 *   - 口径版本：由生成脚本烙成**字面量**（权威来源 = JSON 的 `enginePin`，
 *     当前 `1.0.0`）。过期判断见 `isBaselineStale()`。
 *
 * ★ 两个「零膨胀」指标务必注意（不是数据错）：
 *   `connector_per1000`（模板连接词密度）与 `parallel_per100sent`（对仗结构密度）
 *   在本语料里 p95 = 0 —— 即**至少 95% 的章节这两项为 0**。
 *   原因：这是一本口语化网文，几乎不用「然而 / 因此 / 不仅…而且」这类书面承接词，
 *   也几乎不用成对对仗。所以它们是**强 AI 判别信号**：人写≈0，只有 AI 腔才会非零。
 *   判据层（T02）对零膨胀走**计数口径**软饱和（`scoreZeroInflated`，denom = KZ×max(corpusMaxCount,1)），
 *   故这两项的 MetricBaseline 额外带 `corpusMaxCount`（语料单章出现次数最大值）。本文件不做特殊化。
 */

import { FLAVOR_FEATURE_VERSION } from './engine';

// ── 类型 ─────────────────────────────────────────────────────────────

/** 单个指标的分位数画像（全部来自同语料逐章实测） */
export interface MetricBaseline {
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  /**
   * ★ 零膨胀指标（`connector_per1000` / `parallel_per100sent`）专用：
   *   语料中「**单章出现次数**」的最大值（整数，来自语料逐章原始计数）。
   *   零膨胀判据走**计数口径**（长度无关），`denomCount = KZ × max(corpusMaxCount, 1)`。
   *   非零膨胀指标为 undefined。
   */
  corpusMaxCount?: number;
  /**
   * 该指标是否由**用户语料校准**（T03）。
   *   缺省（undefined）视为 `true` —— 内置默认基线与老数据都视为已校准；
   *   `flavor-baseline-builder` 对**样本不足而回退默认值**的指标写 `false`，
   *   引擎据此把该维度标记为「未校准」，UI 可据此提示「该维度因样本不足，暂用默认」。
   */
  calibrated?: boolean;
}

/**
 * 11 个底层指标（引擎 10 个维度实际用到的全部统计量）。
 *
 * ⚠️ **key 命名的历史包袱（`connector_per1000` / `parallel_per100sent`）**：
 *   这两个 key 名沿用**历史的密度命名**，但 v2（T02）起：
 *     - 判据走**计数口径**（`scoreZeroInflated(count, corpusMaxCount)`），**不用**密度；
 *     - 下面的 `corpusMaxCount` 存的是「单章出现次数」；
 *     - 本对象里的 `p05..max` 仍是该指标的**密度分位数**（历史/展示用，判据不读）。
 *   改名为 `*_count` 会波及已落库用户基线的 key 身份，收益低，故**保留旧名 + 此注释**。
 */
export type FlavorMetricKey =
  | 'sent_cv'
  | 'para_cv'
  | 'ttr'
  | 'tri_repeat'
  | 'opening_dup_ratio'
  | 'connector_per1000'
  | 'ai_marker_per1000'
  | 'comma_period_ratio'
  | 'dash_ellipsis_per1000'
  | 'dialog_para_ratio'
  | 'parallel_per100sent';

export interface FlavorBaseline {
  /** 基线来源标识，如「系统面板永远是零」或用户项目名 */
  corpus: string;
  chapters: number;
  totalChars: number;
  /**
   * ★ **生成该基线时的「特征提取口径」版本**（注意：不是 `FLAVOR_ENGINE_VERSION`）。
   *   基线存的是特征分位数，其可比性只取决于「怎么算特征」，与打分逻辑无关。
   *   字段名沿用 `engineVersion` 只为兼容已落库数据，语义已改为特征版本。
   *   过期判断见 `isBaselineStale()`。
   */
  engineVersion: string;
  metrics: Record<FlavorMetricKey, MetricBaseline>;
  /** builtin = 内置默认基线；user = 用户用自己的语料算的 */
  source: 'builtin' | 'user';
  at: number;
}

/**
 * 指标键的**稳定顺序**（供测试 / UI / 生成脚本按同一顺序遍历）。
 * ★ 显式列数组而不是 `Object.keys(metrics)`：后者顺序依赖对象字面量，
 *   生成脚本重写常量块时若顺序变化会引入难以察觉的 diff 噪声。
 */
export const FLAVOR_METRIC_KEYS: FlavorMetricKey[] = [
  'sent_cv',
  'para_cv',
  'ttr',
  'tri_repeat',
  'opening_dup_ratio',
  'connector_per1000',
  'ai_marker_per1000',
  'comma_period_ratio',
  'dash_ellipsis_per1000',
  'dialog_para_ratio',
  'parallel_per100sent',
];

// ── 内置默认基线 ─────────────────────────────────────────────────────

/**
 * 内置默认基线（715 章语料实测）。
 *
 * ★ `engineVersion` 是**字面量**，不是实时常量——这是刻意的：
 *   该字段的语义是「**生成这份基线时的「特征提取口径」版本**」（= `FLAVOR_FEATURE_VERSION`）。
 *   若引用实时常量，将来特征口径一变，这份 1.0.0 算出来的数据就会自称新版，可比性判断随之失效。
 *   版本号的权威来源是 `data/corpus_flavor_baseline.json`（`featureVersion` / 回退 `engineVersion`），
 *   由 `scripts/gen-baseline-constant.mjs` 负责烙进下面的字面量。
 *   **特征提取口径**变更后，请重跑：`node scripts/gen-baseline-constant.mjs`。
 *
 * ★ 「基线是否过期」由 `isBaselineStale()` 判断（比较本字段与 `FLAVOR_FEATURE_VERSION`，
 *   **不是** `FLAVOR_ENGINE_VERSION`），UI 据此提示「基线口径已过期，建议重算」。
 *
 * ★ `at: 0`：内置基线是编译期常量，没有「生成时刻」这一概念；
 *   用 0 明确表示「非运行时生成」，避免在 shared 层引入 Date.now() 副作用。
 */
export const DEFAULT_FLAVOR_BASELINE: FlavorBaseline = {
  corpus: '系统面板永远是零',
  chapters: 715,
  totalChars: 1515404,
  // ⚠️ 版本号是「生成时的特征提取口径版本」（见 corpus_flavor_baseline.json），
  //    不要改成 FLAVOR_ENGINE_VERSION —— 基线可比性靠它（特征口径，非打分口径）。
  /* @generated:engineVersion:start */
  engineVersion: '1.0.0',
  /* @generated:engineVersion:end */
  /* @generated:metrics:start */
  metrics: {
    sent_cv: { p05: 0.4907, p25: 0.53, p50: 0.558, p75: 0.591, p95: 0.6403, mean: 0.5611, min: 0.455, max: 0.721 },
    para_cv: { p05: 0.584, p25: 0.653, p50: 0.718, p75: 0.7965, p95: 0.938, mean: 0.733, min: 0.446, max: 1.146 },
    ttr: { p05: 0.1232, p25: 0.1449, p50: 0.1561, p75: 0.1698, p95: 0.1937, mean: 0.1573, min: 0.1002, max: 0.2404 },
    tri_repeat: { p05: 0.1914, p25: 0.2409, p50: 0.2778, p75: 0.3145, p95: 0.3825, mean: 0.2791, min: 0.0885, max: 0.4767 },
    opening_dup_ratio: { p05: 0.077, p25: 0.099, p50: 0.124, p75: 0.1585, p95: 0.214, mean: 0.1314, min: 0.049, max: 0.274 },
    // 零膨胀：本语料 ≥95% 章节为 0（人写几乎不出现；只有 AI 腔才会非零）
    connector_per1000: { p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, mean: 0.0007, min: 0, max: 0.4708, corpusMaxCount: 1 },
    ai_marker_per1000: { p05: 0, p25: 0.47, p50: 0.94, p75: 1.435, p95: 2.353, mean: 0.9764, min: 0, max: 3.06 },
    comma_period_ratio: { p05: 0.487, p25: 0.59, p50: 0.69, p75: 0.8, p95: 0.99, mean: 0.7079, min: 0.38, max: 1.27 },
    dash_ellipsis_per1000: { p05: 0, p25: 0, p50: 0, p75: 0.4637, p95: 1.9283, mean: 0.3299, min: 0, max: 4.9706 },
    dialog_para_ratio: { p05: 0.4028, p25: 0.56, p50: 0.656, p75: 0.736, p95: 0.827, mean: 0.6416, min: 0.089, max: 0.905 },
    // 零膨胀：本语料 ≥95% 章节为 0（人写几乎不出现；只有 AI 腔才会非零）
    parallel_per100sent: { p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, mean: 0.0112, min: 0, max: 1.8519, corpusMaxCount: 2 },
  },
  /* @generated:metrics:end */
  source: 'builtin',
  at: 0,
};

// ── 过期判断 ─────────────────────────────────────────────────────────

/**
 * 基线是否已过期（生成它的**特征提取口径**版本 ≠ 当前特征提取版本）。
 *
 * ★ 为什么需要它：基线的分位数是用**某个特征提取口径**算出来的。只有「怎么算特征」变了
 *   （增删指标、改切分/正则/统计方式）时，旧基线才与当前引擎**不可比**。
 *
 * ★ 关键：比较对象是 `FLAVOR_FEATURE_VERSION`，**不是** `FLAVOR_ENGINE_VERSION`。
 *   只改打分逻辑（判据 / 权重 / 阈值 / 护栏）不影响特征分位数的可比性，因此**不该**报过期——
 *   否则 UI 会对每个用户弹「建议重建基线」，而重建耗时且结果毫无变化，用户会学会忽略，
 *   等到基线真过期时也不再理会（这类信号宁可不说也不能乱说）。
 *
 * ★ 纯函数、零副作用，可安全在渲染层调用。
 *
 * @returns true = 已过期（特征口径不同，建议重算）；false = 口径一致，可用
 */
export function isBaselineStale(baseline: FlavorBaseline): boolean {
  return baseline.engineVersion !== FLAVOR_FEATURE_VERSION;
}
