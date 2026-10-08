/**
 * 用户自建 AI 味基线（T03）。
 *
 * ★★ 唯一铁律：**基线与检测同口径** ★★
 *   逐章特征一律复用引擎的 `extractFlavorFeatures()`；百分位一律复用
 *   `chapter-repo.percentiles()`（与 `scripts/compute-flavor-baseline.mjs` 同插值口径）。
 *   本文件**不另写任何统计**——否则用户基线与默认基线会悄悄漂移。
 *
 * ★ 按章分位数，**不拼接全书**：拼接会把 N 章揉成 1 个样本、丢失章间波动（架构 §1.7 / 设计 §4.2）。
 *
 * ★ 输入即正文：**不做「删首行」**。传进来的 `text` 已是 `body`（不含标题）；
 *   若在此再删首个非空行，就是把**第一段正文**当标题删掉（B11 已核实，见 engine JSDoc）。
 *
 * ★ 零膨胀指标（connector / parallel）**不需要 mode 切换**：
 *   判据 `denom = KZ × max(corpusMaxCount, 1)` 里的 `corpusMaxCount` 由**用户语料**算出，天然自适应
 *   （从不用 → maxCount=0 → denom=3 → 1 次 = 33；用了 10 次 → denom=30 → 1 次 = 3）。
 *   故 builder 只需为这两个指标填 `corpusMaxCount`（= 该语料单章整数命中的最大值），无需任何 mode 字段。
 */
import { extractFlavorFeatures } from '@shared/ai-flavor/engine';
import {
  DEFAULT_FLAVOR_BASELINE,
  FLAVOR_METRIC_KEYS,
  type FlavorBaseline,
  type FlavorMetricKey,
  type MetricBaseline,
} from '@shared/ai-flavor/baseline';
import { percentiles } from '../db/repos/chapter-repo';

/** 默认样本闸门：有效章数 < minChapters 时不启用用户基线（硬底线） */
export const DEFAULT_MIN_CHAPTERS = 10;
/** 默认单章最小字数（nospace）：低于此的章不参与（与引擎 `minChars` 一致） */
export const DEFAULT_MIN_CHARS_PER_CHAPTER = 200;

export interface BuildOptions {
  /** 只统计这些章（缺省 / 空数组 = 用全部 `samples`） */
  chapterIds?: string[];
  /** 最少有效章数，缺省 {@link DEFAULT_MIN_CHAPTERS} */
  minChapters?: number;
  /** 单章最少字数，缺省 {@link DEFAULT_MIN_CHARS_PER_CHAPTER} */
  minCharsPerChapter?: number;
}

export interface BuildResult {
  /** 组装出的用户基线（`source: 'user'`；回退维度取默认值 + `calibrated: false`） */
  baseline: FlavorBaseline;
  /** 参与基线计算的有效章数 */
  used: number;
  /** 因样本不足（`chars < minCharsPerChapter`）被跳过的章数 */
  skipped: number;
  /** 可向用户披露的提示（跳过章数 / 回退维度数 / 样本偏少） */
  warnings: string[];
}

/** 四舍五入到 4 位小数（与 `scripts/compute-flavor-baseline.mjs` 的 `r4` 一致） */
const r4 = (x: number): number => Number(x.toFixed(4));

/** 空数组安全的求最大值（避免 `Math.max(...arr)` 在超大数组上爆栈） */
const maxOf = (a: number[]): number => a.reduce((m, x) => (x > m ? x : m), 0);

/** 每个指标的空值数组（含 11 个 `FlavorMetricKey`），供逐章累积 */
function emptyValueBuckets(): Record<FlavorMetricKey, number[]> {
  const buckets = {} as Record<FlavorMetricKey, number[]>;
  for (const k of FLAVOR_METRIC_KEYS) buckets[k] = [];
  return buckets;
}

/**
 * 把「章 → 正文」样本聚合成一份用户基线（纯函数：不读库、不落盘、不读项目）。
 *
 * @param samples        逐章正文（`text` 必须**不含标题行**）
 * @param opts           样本闸门 / 章过滤
 * @param featureVersion 记入基线的「**特征提取口径**」版本（调用方传 `FLAVOR_FEATURE_VERSION`）
 */
export function buildFlavorBaseline(
  samples: { chapterId: string; text: string }[],
  opts: BuildOptions,
  featureVersion: string,
): BuildResult {
  const minChapters = opts.minChapters ?? DEFAULT_MIN_CHAPTERS;
  const minChars = opts.minCharsPerChapter ?? DEFAULT_MIN_CHARS_PER_CHAPTER;
  const warnings: string[] = [];

  const onlyIds = opts.chapterIds?.length ? opts.chapterIds : null;
  const pool = onlyIds ? samples.filter((s) => onlyIds.includes(s.chapterId)) : samples;

  const values = emptyValueBuckets();
  // ★ 零膨胀指标的**整数计数**（`corpusMaxCount` 用；判据走计数、非密度）。
  const connectorCounts: number[] = [];
  const parallelCounts: number[] = [];

  let used = 0;
  let skipped = 0;
  let totalChars = 0;

  // ── Step 1：逐章提特征（复用引擎口径，绝不另写统计）──────────────────
  for (const s of pool) {
    const f = extractFlavorFeatures(s.text);
    if (f.chars < minChars) {
      skipped++;
      continue;
    }
    used++;
    totalChars += f.chars;

    // 密度 / 比率类：直接取引擎的 `FlavorFeatures`（口径唯一来源）
    values.sent_cv.push(f.sentCv);
    values.para_cv.push(f.paraCv);
    values.ttr.push(f.ttr);
    values.tri_repeat.push(f.triRepeat);
    values.opening_dup_ratio.push(f.openDupRatio);
    values.ai_marker_per1000.push(f.markerTotalPer1000);
    values.comma_period_ratio.push(f.commaPeriodRatio);
    values.dash_ellipsis_per1000.push(f.dashPer1000);
    values.dialog_para_ratio.push(f.dialogParaRatio);

    // 零膨胀两项：**两次量都收** —— p05..max 用**密度**（与默认基线同构），corpusMaxCount 用**计数**
    values.connector_per1000.push(f.chars > 0 ? (f.connectorCount * 1000) / f.chars : 0);
    values.parallel_per100sent.push(f.sentCount > 0 ? (f.parallelCount * 100) / f.sentCount : 0);
    connectorCounts.push(f.connectorCount);
    parallelCounts.push(f.parallelCount);
  }

  // ── Step 2/5/6：逐指标求分位；样本不足 → 回退默认值 + calibrated:false ──
  const metrics = {} as Record<FlavorMetricKey, MetricBaseline>;
  let fellBack = 0;
  for (const k of FLAVOR_METRIC_KEYS) {
    const vals = values[k];
    if (vals.length < minChapters) {
      // 回退：直接取默认基线该指标的值（不双重兜底），并标记未校准供 UI 披露。
      metrics[k] = { ...DEFAULT_FLAVOR_BASELINE.metrics[k], calibrated: false };
      fellBack++;
      continue;
    }
    const p = percentiles(vals);
    metrics[k] = {
      p05: r4(p.p05),
      p25: r4(p.p25),
      p50: r4(p.p50),
      p75: r4(p.p75),
      p95: r4(p.p95),
      mean: r4(p.mean),
      min: r4(p.min),
      max: r4(p.max),
      calibrated: true,
    };
  }

  // ── Step 3：零膨胀 `corpusMaxCount` = 该语料「单章出现次数」最大值（整数）──
  //   仅对**已校准**的指标填；回退维度保留默认值语义（不覆盖）。
  if (metrics.connector_per1000.calibrated) {
    metrics.connector_per1000.corpusMaxCount = maxOf(connectorCounts);
  }
  if (metrics.parallel_per100sent.calibrated) {
    metrics.parallel_per100sent.corpusMaxCount = maxOf(parallelCounts);
  }

  // ── Step 7：组装 ────────────────────────────────────────────────────
  const baseline: FlavorBaseline = {
    corpus: `你的语料（${used} 章，按章分位数）`,
    chapters: used,
    totalChars,
    engineVersion: featureVersion,
    metrics,
    source: 'user',
    at: Date.now(),
  };

  if (used < minChapters) {
    warnings.push(
      `有效章节仅 ${used} 章（< ${minChapters}），样本不足，用户基线不启用（继续用默认基线）。`,
    );
  }
  if (skipped > 0) {
    warnings.push(`跳过 ${skipped} 章（不足 ${minChars} 字，短文本指标不稳）。`);
  }
  if (fellBack > 0) {
    warnings.push(`有 ${fellBack} 个维度样本不足，已回退默认基线值（该维度标记为未校准）。`);
  }

  return { baseline, used, skipped, warnings };
}
