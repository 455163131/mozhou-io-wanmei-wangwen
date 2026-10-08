import type { MetricSpec } from '../types/project';

/**
 * 指标 key 枚举（迁自 metrics.js 的 MZ_BASELINE，架构 T06）。
 *
 * ⚠️ 参考基线说明（架构 §6第 10 条铁律）：
 * 下面的 REFERENCE_BASELINE 来自《系统面板永远是零》715 章实测，
 * **只能用于首次体验**。真实项目必须用用户自己的语料按章分位数重建
 * （见style-profile-repo.rebuildBaseline）。UI 必须展示 baselineSource 标注来源。
 */

export const METRIC_KEYS = [
  'avgSent',
  'sentCv',
  'avgPara',
  'sentsPerPara',
  'ttr',
  'bigramTtr',
  'triRepeat',
  'dialogRatio',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** UI 展示用的指标元信息（不在指标引擎里，避免污染算法层） */
export const METRIC_LABELS: Record<MetricKey, { label: string; unit: string; decimals: number }> = {
  avgSent: { label: '平均句长', unit: '字', decimals: 2 },
  sentCv: { label: '标点节奏 CV', unit: '', decimals: 3 },
  avgPara: { label: '平均段长', unit: '字', decimals: 2 },
  sentsPerPara: { label: '每段句数', unit: '句', decimals: 2 },
  ttr: { label: '字符级 TTR', unit: '', decimals: 4 },
  bigramTtr: { label: '二元组独特比', unit: '', decimals: 4 },
  triRepeat: { label: '3-gram 重复率', unit: '', decimals: 4 },
  dialogRatio: { label: '对白段占比', unit: '', decimals: 4 },
};

/** 指标 → 判定方向。both=双侧偏离即异常 */
export const METRIC_DIR: Record<MetricKey, 'both' | 'low-bad' | 'high-bad'> = {
  avgSent: 'both',
  sentCv: 'low-bad',
  avgPara: 'both',
  sentsPerPara: 'low-bad',
  ttr: 'low-bad',
  bigramTtr: 'low-bad',
  triRepeat: 'high-bad',
  dialogRatio: 'both',
};

/**
 * 参考基线（《系统面板永远是零》715 章 / 1,515,404 字实测，2026-10-07）。
 * 与 metrics.js 的 MZ_BASELINE 数值一致，已与 corpus_baseline.json 逐项核对
 * （8 项 mean 偏差 ≤0.014；40 个分位数中 38 个吻合，其余为最近秩vs 线性插值差异）。
 */
export const REFERENCE_BASELINE: {
  source: string;
  chapters: number;
  totalChars: number;
  metrics: Record<MetricKey, MetricSpec>;
  markerDensity: Record<string, { p50: number; p95: number }>;
} = {
  source: '参考基线（来自《系统面板永远是零》715 章实测，尚未用你的语料重建）',
  chapters: 715,
  totalChars: 1515404,
  metrics: {
    avgSent:      { label: '平均句长',     unit: '字', p05: 9.68,  p25: 10.68, p50: 11.49, p75: 12.62, p95: 14.33, mean: 11.729, dir: 'both' },
    sentCv:       { label: '标点节奏 CV',  unit: '',   p05: 0.55,  p25: 0.595, p50: 0.633, p75: 0.683, p95: 0.959, mean: 0.664, dir: 'low-bad' },
    avgPara:      { label: '平均段长',     unit: '字', p05: 12.45, p25: 14.99, p50: 18.75, p75: 22.82, p95: 29.03, mean: 19.421, dir: 'both' },
    sentsPerPara: { label: '每段句数',     unit: '句', p05: 1.10,  p25: 1.23,  p50: 1.47,  p75: 1.70,  p95: 2.14, mean: 1.515, dir: 'low-bad' },
    ttr:          { label: '字符级 TTR',   unit: '',   p05: 0.130, p25: 0.145, p50: 0.157, p75: 0.170, p95: 0.190, mean: 0.157, dir: 'low-bad' },
    bigramTtr:    { label: '二元组独特比', unit: '',   p05: 0.425, p25: 0.484, p50: 0.518, p75: 0.550, p95: 0.599, mean: 0.517, dir: 'low-bad' },
    triRepeat:    { label: '3-gram 重复率', unit: '',   p05: 0.191, p25: 0.241, p50: 0.278, p75: 0.315, p95: 0.383, mean: 0.279, dir: 'high-bad' },
    dialogRatio:  { label: '对白段占比',   unit: '',   p05: 0.400, p25: 0.560, p50: 0.656, p75: 0.736, p95: 0.828, mean: 0.642, dir: 'both' },
  },
  markerDensity: {
    '看了X遍/X久/X会儿':      { p50: 0.78,  p95: 1.63 },
    '一X一X 叠词':            { p50: 0.51,  p95: 1.03 },
    '第N天/第N年':            { p50: 0.46,  p95: 0.91 },
    '把X放在/搁在/摊在/摆在': { p50: 0.42,  p95: 0.83 },
    '抬起头/低头':            { p50: 0.21,  p95: 0.49 },
    '顿/停了一下':            { p50: 0.19,  p95: 0.42 },
    '没说话/没答/没出声':     { p50: 0.09,  p95: 0.24 },
    '观感类摆拍精确':         { p50: 0.943, p95: 2.443 },
  },
};

/**
 * ★ 修复审查发现的问题：空文档被判定为「极不健康」得 2 分，
 * 而认真写的 2059 字章节只得 24 分——指示灯因此失去意义。
 * 低于此样本量时不做判定，返回 sufficient:false，UI 显示「待写满 N 字后开始诊断」。
 */
export const MIN_CHARS_FOR_JUDGEMENT = 100;

/** 低于此样本量时侧效判定噪声太大，不触发自动回滚 */
export const MIN_CHARS_FOR_SIDE_EFFECT = 200;

/** 单章正文硬上限（架构 §1.9），超过则 UI 提示「本章异常偏长」但不阻断 */
export const MAX_CHAPTER_BYTES = 8 * 1024;

/** 单次扫描批大小（架构 §1.9：Node 侧无渲染压力，比原型的 8 章/批放大到 20） */
export const SCAN_BATCH_SIZE = 20;

/** 章节树虚拟化窗口（架构 §1.9） */
export const CHAPTER_TREE_WINDOW = 50;

/** 批量扫描并发（架构 §1.9：保守取 2，更多可能触发 better-sqlite3 主线程阻塞） */
export const SCAN_CONCURRENCY = 2;

/** 章节列表分页大小 */
export const CHAPTER_PAGE_SIZE = 50;

/** 六个层次：与 MZ_SIX_LAYERS 对齐。★ 两个 marker 必须收录，否则扣了分界面不显示 */
export const LAYER_IDS = ['structure', 'expression', 'material', 'narrative', 'emotion', 'context'] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export const LAYER_NAMES: Record<LayerId, string> = {
  structure: '结构层',
  expression: '表达层',
  material: '素材层',
  narrative: '叙事层',
  emotion: '情感层',
  context: '语境层',
};

/**
 * 层 → 负责的指标/标记。
 * ★ 与审查发现 MZ-009 相关的修复：marker:抬起头/低头 与 marker:没说话 必须在此列出，
 * 否则它们扣健康分但界面无任何一行解释。
 */
export const LAYER_METRICS: Record<LayerId, string[]> = {
  structure: ['sentsPerPara', 'avgPara', 'avgSent'],
  expression: [
    'marker:看了X遍/X久/X会儿',
    'marker:把X放在/搁在/摊在/摆在',
    'marker:顿/停了一下',
    'marker:一X一X 叠词',
    'marker:抬起头/低头',
    'marker:没说话/没答/没出声',
  ],
  material: ['marker:观感类摆拍精确', 'marker:第N天/第N年', 'ttr', 'bigramTtr', 'triRepeat'],
  narrative: ['dialogRatio', 'sentCv'],
  emotion: [],
  // context 层是配置项而非指标，metrics 故意为空（架构原设计）
  context: [],
};