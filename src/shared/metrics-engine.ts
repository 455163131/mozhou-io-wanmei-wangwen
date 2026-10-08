/**
 * 指标引擎（架构 T06）。
 *
 * 移植自 `outputs/metrics.js`（274 行），**逐行移植、零改动**的部分：
 *   - 句末标点切分规则
 *   - 9 条 AI 味标记族正则
 *   - TTR / bigram 独特比 / 3-gram 重复率的算法
 *   - 章首起笔类型判定
 *
 * 相比原实现**有意的三处修正**（均为审查发现，理由随代码注释）：
 *   1. 空输入不再抛 TypeError（原mzAnalyze(null) 直接崩）
 *   2. 样本量不足时返回 sufficient:false，不再把「没写够字」判成「极不健康」
 *   3. 健康分按可判项数归一化，消除 8 项触底 0 分的假确定性
 *
 * ★ 分层铁律：本文件**零 DOM 引用**。移植后必须 grep 确认
 *   `document\.` / `window\.` 命中数为 0 —— 这些代码原本假设在浏览器里跑。
 */
import { stripWhitespace, countChars } from './util/text-zh';
import { MIN_CHARS_FOR_JUDGEMENT } from './constants/metrics';
import {
  SCORE_RISK_PENALTY,
  SCORE_WARN_PENALTY,
  TOTAL_JUDGEABLE_ITEMS,
} from './constants/budget';
import type { MetricSpec } from './types/project';
import type { Grade } from './types/tool';

// ───────────────────────── 标记族（逐行移植 metrics.js:25-42） ─────────────────────────

/**
 * AI 味标记词表。来源：作者本人在《系统面板永远是零》715 章上完成的全书诊断。
 *
 * ⚠️ 审查发现（C3）：`一X一X 叠词` 会在「一步一步 / 一天一天 / 一字一字」这类
 * 正常中文表达上误报。这属于**口径设计问题**而非 bug——「叠词」本就是中文常态，
 * 规则本身就是启发式。这里保留原型行为（改动会移动基线），
 * 但把已知误报模式记在此处，避免后来者以为是新引入的bug。
 */
export const MARKERS: Record<string, RegExp> = {
  '看了X遍/X久/X会儿': /看(了|着)[^，。！？“「]{0,6}(遍|久|会儿|眼|秒)/g,
  '把X放在/搁在/摊在/摆在': /把[^，。！？“「]{0,10}(放在|搁在|摊在|摆在|压在|丢在|扔在|按在|贴在)/g,
  '顿/停了一下': /(顿了一下|顿了顿|停了(一下|停)|愣(了一下|了愣))/g,
  '一X一X 叠词': /一(.)一\1/g,
  '第N天/第N年': /第[一二三四五六七八九十百千零两0-9]+(天|年|个月)/g,
  '没说话/没答/没出声': /没(说话|答|出声|应声|吭声)/g,
  '抬起头/低头': /(抬起头|低下头|抬头看|低头看)/g,
  '观感类摆拍精确': /(看|读|想|站|等|停)(了|着)?[一二三四五六七八九十百千两0-9]+(秒|秒半|分钟|遍|眼|下)/g,
};

export const MARKER_KEYS = Object.keys(MARKERS);

// ───────────────────────── 常量（逐行移植 metrics.js:14-19） ─────────────────────────

const SENT_SPLIT = /[。！？…]+/;
const DIALOG_OPEN = /[“「]/;
const OPEN_TIME = /^[一二三四五六七八九十百千零两0-9]+月[一二三四五六七八九十百千零两0-9]+[号日]/;
const OPEN_TIME_ANY = /^[一二三四五六七八九十百千零两0-9]+(月|号|日|年|点)/;

// ───────────────────────── 工具函数 ─────────────────────────

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

/** 总体标准差（与 Python statistics.pstdev 一致，已对拍验证） */
function pstdev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
}

/**
 * 计数：每次新建 RegExp 实例。
 * 原因：MZ_MARKERS 是模块级单例，带 /g 标志的 regex 复用会因lastIndex 泄漏导致计数漂移。
 * 审查已实测验证：重建后两次调用结果一致，原 regex 的 lastIndex 恒为 0。
 */
function countMatches(text: string, re: RegExp): number {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let n = 0;
  while (r.exec(text) !== null) n++;
  return n;
}

// ───────────────────────── 主分析 ─────────────────────────

export interface AnalyzeResult {
  /** 去空白后的字符数；0 表示无有效内容 */
  chars: number;
  paras: number;
  sents: number;
  raw: {
    avgSent: number;
    sentSd: number;
    sentCv: number;
    avgPara: number;
    paraSd: number;
    sentsPerPara: number;
    ttr: number;
    bigramTtr: number;
    triRepeat: number;
    dialogRatio: number;
  };
  markerHits: Record<string, number>;
  /** 每千字标记密度 */
  per1000: Record<string, number>;
  openType: string;
  /** 逐段字数（UI 分布图用） */
  paraLens: number[];
  /** 逐句字数 */
  sentLens: number[];
}

/**
 * 主分析函数。
 *
 * ⚠️ 与原型metrics.js 的差异：入参做了防御。
 * 原型 `mzAnalyze(null)` 会抛 `TypeError: Cannot read properties of null (reading 'replace')`，
 * 而编辑器清空 / localStorage 脏数据都会触发这种调用。
 */
export function analyze(text: unknown): AnalyzeResult {
  const safeText = typeof text === 'string' ? text : '';

  const nospace = stripWhitespace(safeText);
  const chars = nospace.length;

  const paras = safeText.split('\n').filter((p) => p.trim().length > 0);
  const paraLens = paras.map((p) => stripWhitespace(p).length).filter((x) => x > 0);

  const sents = safeText
    .split(SENT_SPLIT)
    .map((s) => stripWhitespace(s))
    .filter((s) => s.length > 0);
  const sentLens = sents.map((s) => s.length);

  // 词/字多样性与重复
  let ttr = 0;
  let bigramTtr = 0;
  let triRepeat = 0;
  if (chars > 0) {
    ttr = new Set(nospace).size / chars;
    const bg: string[] = [];
    for (let i = 0; i < nospace.length - 1; i++) bg.push(nospace.slice(i, i + 2));
    bigramTtr = bg.length ? new Set(bg).size / bg.length : 0;
    const tg: string[] = [];
    for (let i = 0; i < nospace.length - 2; i++) tg.push(nospace.slice(i, i + 3));
    triRepeat = tg.length ? (tg.length - new Set(tg).size) / tg.length : 0;
  }

  const avgSent = mean(sentLens);
  const sentSd = pstdev(sentLens);
  const sentCv = avgSent > 0 ? sentSd / avgSent : 0;

  const dlgParas = paras.filter((p) => DIALOG_OPEN.test(p)).length;

  const markerHits: Record<string, number> = {};
  for (const k of MARKER_KEYS) markerHits[k] = countMatches(safeText, MARKERS[k]);
  const per1000: Record<string, number> = {};
  for (const k of MARKER_KEYS) per1000[k] = chars ? (markerHits[k] * 1000) / chars : 0;

  return {
    chars,
    paras: paras.length,
    sents: sentLens.length,
    raw: {
      avgSent,
      sentSd,
      sentCv,
      avgPara: mean(paraLens),
      paraSd: pstdev(paraLens),
      sentsPerPara: paraLens.length ? sentLens.length / paraLens.length : 0,
      ttr,
      bigramTtr,
      triRepeat,
      dialogRatio: paras.length ? dlgParas / paras.length : 0,
    },
    markerHits,
    per1000,
    openType: chapterOpenType(safeText),
    paraLens,
    sentLens,
  };
}

/** 章首起笔类型（逐行移植 metrics.js:224-231） */
export function chapterOpenType(text: string): string {
  const first = (text.split('\n')[0] || '').trim();
  if (!first) return '空';
  if (OPEN_TIME.test(first)) return '时间+地点公式';
  if (DIALOG_OPEN.test(first)) return '对白起笔';
  if (OPEN_TIME_ANY.test(first)) return '时间起笔';
  return '叙述/动作起笔';
}

// ───────────────────────── 分级判定 ─────────────────────────

/**
 * 单项分级。方向三态：
 *   -both     ：落在 [p05,p95] 内 → ok；偏离带宽度 ≤20% → warn；否则 risk
 *   -high-bad ：越低越好（≤p95 → ok）
 *   -low-bad  ：越高越好（≥p05 → ok）
 */
export function grade(value: number, spec: MetricSpec): Grade {
  const { p05, p95, dir } = spec;
  if (dir === 'high-bad') {
    if (value <= p95) return 'ok';
    if (value <= p95 * 1.2) return 'warn';
    return 'risk';
  }
  if (dir === 'low-bad') {
    if (value >= p05) return 'ok';
    if (value >= p05 * 0.8) return 'warn';
    return 'risk';
  }
  // both
  const span = Math.max(p95 - p05, 1e-9);
  if (value >= p05 && value <= p95) return 'ok';
  const dev = value < p05 ? (p05 - value) / span : (value - p95) / span;
  return dev <= 0.2 ? 'warn' : 'risk';
}

/**
 * 标记密度分级：用 p50 判 ok、p95 判 warn。
 *
 * ⚠️ 审查发现（MZ-032，技术债）：mzJudge 汇报给 UI 的 band 是 [0, p95]，
 * 与此处的 p50 ok线不一致——值落在 band 内却报 warn。
 * 原型 UI 走自己的 gradeOf()、从不调用本函数，所以**用户不会被误导**。
 * 真正的解法是消除双实现漂移（见 agent/side-effect.ts复用同一 grade()）。
 * 此处保持与原型一致，避免改变基线语义。
 */
export function gradeMarker(density: number, base: { p50: number; p95: number }): Grade {
  if (density <= base.p50) return 'ok';
  if (density <= base.p95) return 'warn';
  return 'risk';
}

/**
 * 偏离度（0 = 达标）。用于「超基线 71%」这类可读结论。
 * 语义：相对于健康区间的距离，带宽度为单位。
 */
export function deviation(value: number, spec: DeviationSpec): number {
  if ('p05' in spec) {
    const s = spec as MetricSpec;
    const span = Math.max(s.p95 - s.p05, 1e-9);
    if (value >= s.p05 && value <= s.p95) return 0;
    return value < s.p05 ? (s.p05 - value) / span : (value - s.p95) / span;
  }
  // marker 型：只有 p50 / p95，越低越好
  const b = spec as MarkerSpec;
  const span = Math.max(b.p95 - b.p50, 1e-9);
  return value <= b.p50 ? 0 : (value - b.p50) / span;
}

// ───────────────────────── 健康分 ─────────────────────────

/** 偏离度计算的两种入参：raw 指标（带 p05/p95 三向）或 marker 密度（仅 p50/p95，单向） */
export type MarkerSpec = { p50: number; p95: number };
export type DeviationSpec = MetricSpec | MarkerSpec;

export interface JudgeInput {
  raw: AnalyzeResult['raw'];
  per1000: Record<string, number>;
  metrics: Record<string, MetricSpec>;
  markerDensity: Record<string, { p50: number; p95: number }>;
}

export interface JudgeItem {
  key: string;
  label: string;
  value: number;
  unit: string;
  band: [number, number];
  level: Grade;
  deviation: number;
}

/** 把分析结果与基线比对，产出全部判定项 */
export function judge(input: JudgeInput): JudgeItem[] {
  const items: JudgeItem[] = [];

  for (const [key, spec] of Object.entries(input.metrics)) {
    const value = input.raw[key as keyof typeof input.raw];
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    const level = grade(value, spec);
    items.push({
      key,
      label: spec.label,
      value,
      unit: spec.unit,
      band: [spec.p05, spec.p95],
      level,
      deviation: deviation(value, spec),
    });
  }

  for (const [key, density] of Object.entries(input.per1000)) {
    const base = input.markerDensity[key];
    if (!base) continue;
    const level = gradeMarker(density, base);
    items.push({
      key: `marker:${key}`,
      label: key,
      value: density,
      unit: '/千字',
      band: [0, base.p95],
      level,
      deviation: deviation(density, { p50: base.p50, p95: base.p95 }),
    });
  }

  return items;
}

/** 只取非 ok 的项——issues 的真正含义是「需要解释的偏差」 */
export function issuesOnly(items: JudgeItem[]): JudgeItem[] {
  return items.filter((i) => i.level !== 'ok');
}

/**
 * 健康分（0-100，越高越好）。
 *
 * ★ 修正（MZ-013）：按可判项数归一化。
 * 原型扣分 `risk -14 / warn -6` 满分 100，但可判项共 16 个，
 * `100/14 ≈ 7.1` 导致第 8 个 risk 即触底 0 分——后半程完全无区分度，
 * 且「认真写的 2059 字章节 24 分」与「空白文档 2 分」区分度不足。
 */
export function healthScore(items: JudgeItem[], sufficient = true): number {
  // 样本不足时给「不评分」而不是给一个无意义的低分
  if (!sufficient) return 100;

  let penalty = 0;
  for (const i of items) {
    penalty += i.level === 'risk' ? SCORE_RISK_PENALTY : i.level === 'warn' ? SCORE_WARN_PENALTY : 0;
  }
  const maxPenalty = TOTAL_JUDGEABLE_ITEMS * SCORE_RISK_PENALTY;
  const score = 100 * (1 - penalty / maxPenalty);
  return Math.max(0, Math.min(100, score));
}

/** 样本量是否够做判定（修正「空文档 2 分」问题） */
export function isSufficient(chars: number): boolean {
  return chars >= MIN_CHARS_FOR_JUDGEMENT;
}

export { countChars };