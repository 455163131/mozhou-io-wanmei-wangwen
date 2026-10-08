/**
 * AI 味检测引擎（纯函数，零 DOM / 零 IO / 零网络 / 零 Node import）。
 *
 * ★★ v2 判据（本版口径破坏性变更，`FLAVOR_ENGINE_VERSION` → 2.0.0）★★
 *
 * 旧 v1：`scale(value, good=人写典型值, bad=AI典型值)`。缺陷：语料**全是人写的**，
 *   `bad`（AI 值）没有任何依据，是拍脑袋。
 * 新 v2：不再问「你像不像 AI」，改问「你离**你自己的**正常范围有多远」——
 *   `good` 用**语料实测分位数**（有依据），`bad` 换成「显著偏离的距离」（不假装知道 AI 值）。
 *   详见 `docs/FLAVOR_CALIBRATION_DESIGN.md` §1.2。
 *
 * 判据公式（`scoreByDeviation`）：
 *   span = max(p95 − p05, ε)
 *   high-bad（越高越可疑）：good = p95，d = max(0, (v − p95)/span)
 *   low-bad （越低越可疑）：good = p05，d = max(0, (p05 − v)/span)
 *   score = round(clamp01(d / SAT) × 100)
 *
 * 零膨胀分支（`scoreZeroInflated`，**计数口径**）：`connector_per1000` 与 `parallel_per100sent` 的
 *   语料 p95 = 0（人写口语化网文里这两类几乎不出现）。若走主公式，span = 0 会让
 *   **任意一个「然而」把该维度打到 100 分**——故改走计数软饱和：出现 1 次 ≤33 分、
 *   须达 KZ×corpusMaxCount 才 100；且**与章节长度无关**。详见设计 §1.2.1。
 *
 * ★ 设计原则一：**每个维度都要能翻译成「怎么改」**。
 * ★ 设计原则二：**样本不足必须认怂**（低于 minChars 不出总评）。
 * ★ 设计原则三：**中文三种引号、三种分段格式、繁简都要处理**。
 *
 * 分值方向：0 = 干净，100 = 严重偏离（与「AI 生成概率」无关，本项目不出概率）。
 */
import {
  DEFAULT_FLAVOR_CONFIG,
  FLAVOR_DIMENSIONS,
  levelOf,
  type DimensionScore,
  type FlavorConfig,
  type FlavorConfidence,
  type FlavorDimension,
  type FlavorHit,
  type FlavorLevel,
  type FlavorReport,
  type ParagraphScore,
} from '@shared/types/ai-flavor';
import {
  DEFAULT_FLAVOR_BASELINE,
  isBaselineStale,
  type FlavorBaseline,
  type FlavorMetricKey,
  type MetricBaseline,
} from './baseline';

export const FLAVOR_ENGINE_VERSION = '2.0.0';

/**
 * **特征提取口径**版本。
 *
 * ★ 为什么要和 `FLAVOR_ENGINE_VERSION` 分开：
 *   `FLAVOR_ENGINE_VERSION` 涵盖「引擎的一切」（含打分逻辑：判据 / 权重 / 阈值 / 护栏）；
 *   而**基线存的是「特征分位数」**（11 个 `FlavorMetricKey` 怎么算），不存分数。
 *   所以基线的可比性只取决于**特征提取口径**，与打分逻辑无关。
 *   只改打分（例如 v2 的判据重写）→ 基线依旧有效，**不该** bump 它、也不该报过期。
 *   只有「怎么算特征」变了（增删指标、改切分/正则/统计方式）才 bump。
 *
 * ★ 用途：`isBaselineStale()` 用它判断基线是否过期——
 *   若拿 `FLAVOR_ENGINE_VERSION` 当判据，则「只改打分」也会误报过期，
 *   UI 会对每个用户弹「建议重建基线」，而重建耗时且结果无变化 → 用户学会忽略，真过期时也不再理会。
 *
 * ★ 当前 T02 只改了打分逻辑，未改特征提取 → 保持 1.0.0（与已落库基线一致，无需重算）。
 */
export const FLAVOR_FEATURE_VERSION = '1.0.0';

/** ε：防止 span=0 时除零（真正为 0 的情况交由零膨胀分支处理） */
const EPS = 1e-9;
/** 判据饱和系数 SAT 默认值（设计 §1.2【待验证】：无 AI 样本可验，保守取 1.0） */
const DEFAULT_SAT = 1.0;
/** 零膨胀软饱和的拉满倍数 KZ（设计 §1.2.1，可配） */
const ZERO_INFLATED_KZ = 3;
/** 段落节奏「对白墙」护栏阈值（设计 §3.3） */
const DIALOG_GUARD_RATIO = 0.85;
const DIALOG_GUARD_SENTS_PER_PARA = 1.05;

/**
 * 旧口径基线（缺 `corpusMaxCount`）时，零膨胀维度不可判的**披露文案**。
 * ★ 「降级必须披露」：不静默兜底成 0 分或猜一个 denom，而是明说「未判分 + 建议重建基线」。
 */
const OLD_BASELINE_NOTE =
  '该基线为旧口径（缺少计数字段 corpusMaxCount），此维度无法可靠判分；建议重建基线';

/**
 * 基线分位数非单调（`p05 > p95`）时，该维度不可判的**披露文案**（QA D3）。
 * ★ 若不校验，`span → ε` 会把任意值放大到 100——静默给出满分是最坏的一类失败。
 */
const ANOMALY_NOTE = '基线异常：分位数非单调（p05 > p95），该维度未判分；建议重建基线';

// ── 默认权重 ─────────────────────────────────────────────────────────

/**
 * 权重设计依据：越「作者能直接动手改」的维度权重越高。
 * ★ v2 保持权重不变（设计 §3.5）：权重最优解需「人写 vs AI」正负样本拟合，
 *   本项目无 AI 样本，任何基于分布的微调都是伪优化。故权重继续承载「可改动性/精度」先验。
 */
const DEFAULT_WEIGHTS: Record<FlavorDimension, number> = {
  'sentence-rhythm': 0.12,
  'paragraph-rhythm': 0.08,
  'lexical-diversity': 0.10,
  'phrase-repetition': 0.14,
  'opening-pattern': 0.08,
  'template-connector': 0.15,
  'marker-density': 0.18,
  'punctuation-pattern': 0.05,
  'dialog-ratio': 0.05,
  'parallel-structure': 0.05,
};

// ── 词表 ─────────────────────────────────────────────────────────────

/**
 * 模板连接词。AI 的中文常出现「然而/因此/不仅…而且」这类书面化承接词，
 * 而网文口语化写作几乎不用——所以这类词的密度是强信号。
 * ★ 只收录「单独出现即异常」的词，刻意排除「不仅」「而且」「正如」（太常见）。
 */
export const TEMPLATE_CONNECTORS = [
  '然而',
  '因此',
  '因而',
  '与此同时',
  '除此之外',
  '尽管如此',
  '综上所述',
  '总而言之',
  '值得一提的是',
  '不容忽视',
  '显而易见',
  '毫无疑问',
  '换言之',
  '换句话说',
  '在此过程中',
  '从某种意义',
  '某种程度上',
  '不言而喻',
];

/**
 * 对仗/排比腔的固定结构。适度用是文笔，密集出现是 AI 腔。
 * ★ 收录的是**成对结构**——单看一个词可能正常，成对出现才是模板腔。
 *
 * ★★ 量词一律用**惰性**（`{n,m}?`）——QA D1 修正：
 *   贪婪量词会把**两个紧邻**的结构合并成**一个** match，计数偏低 → 得分偏低。
 *   例：`/仿佛.{0,12}一般/g` 遇到「仿佛A一般仿佛B一般」会因贪婪 `.{0,12}` 把整段吞成 1 个 match
 *   （6 处只数到 3）。惰性 `.{0,12}?` 让每处最短匹配 → 一处一个 match，计数正确。
 */
export const PARALLEL_PATTERNS = [
  /仿佛.{0,12}?一般/g,
  /不禁.{0,10}?(起来|了)/g,
  /(仿佛|宛如|犹如).{0,8}?(此刻|瞬间)/g,
  /(那一刻|那一瞬|与此同时)[，,].{0,20}?/g,
  /不是.{1,12}?而是.{1,12}?/g,
  /与其.{1,12}?不如.{1,12}?/g,
  /不仅[^。！？]{1,20}?而且/g,
  /既[^。！？]{1,15}?又[^。！？]{1,15}?/g,
  /一方面[^。！？]{1,20}?另一方面/g,
  /不仅仅是[^。！？]{1,20}?更是/g,
];

/**
 * 高置信 AI 标志词。
 * ★ v2 重要事实：本表**实为 9 条**（第 9 条是朱雀 P1「副词+动词」），
 *   且引擎 `measured` = 这 9 条的**聚合密度**（`ai_marker_per1000`）。
 *   新基线直接测了该聚合（p95=2.353）→ `marker-density` 维度按**单一聚合判据**校准，
 *   无需按类分层；逐类仅用于命中的归因文案。见设计 §2.3。
 */
export const AI_MARKERS: { key: string; re: RegExp; advice: string }[] = [
  {
    key: '顿了一下',
    re: /(顿|停|沉默)(了)?(一下|片刻)/g,
    advice: '「顿了一下」是最典型的 AI 停顿描写。改为具体动作或直接省略这个停顿。',
  },
  {
    key: '瞳孔紧缩',
    re: /(瞳孔|眼眸)(骤然|猛地|微微一)?(缩|缩了)/g,
    advice: '「瞳孔紧缩」是网文套话里最被 AI 滥用的一种。改为角色自己的反应（动作/台词）。',
  },
  {
    key: '深吸一口气',
    re: /(深|长长地?)吸(了)?(一)?口气/g,
    advice: '「深吸一口气」几乎无信息量。若必须表达情绪，用身体细节或直接推进情节。',
  },
  {
    key: '嘴角勾起',
    re: /(嘴角|唇边)(微微|轻轻)?(勾起|掀起|扬起)/g,
    advice: '「嘴角勾起」是 AI 高频微笑描写。改写为具体表情或干脆不写。',
  },
  {
    key: '不易察觉',
    re: /(不易|难以)(察觉|觉察)/g,
    advice: '「不易察觉」是 AI 偏爱的模糊修饰，读者感受不到。删掉或换成可观察的细节。',
  },
  {
    key: '复杂的情绪',
    re: /(复杂|难以言喻|说不清)的(情绪|感觉|滋味)/g,
    advice: '「复杂的情绪」是把情绪抽象掉了。写出具体是哪一种情绪、因何而起。',
  },
  {
    key: '空气仿佛凝固',
    re: /(空气|气氛)(仿佛|似乎|好像)?(凝固|凝滞)/g,
    advice: '「空气凝固」是极高频 AI 收场句。改为具体的人和动作来表现紧张。',
  },
  {
    key: '一X一X 叠词',
    re: /一(.)一\1/g,
    advice:
      '「一步一步」「一天一天」这类叠词在正常中文里极常见，属**低置信**信号。' +
      '仅当密集出现时才是问题，建议优先检查是否连续多句用此结构。',
  },
  {
    key: '副词+动词',
    re: /(缓缓|淡淡|轻轻|静静|默默|微微|幽幽|悠悠)(地)?(说|道|看|走|笑|叹|站|坐|望|想)/g,
    advice:
      '「缓缓说道」「淡淡一笑」这类「副词+动词」是 AI 偏爱的情绪修饰方式，' +
      '信息量低且重复。改为具体动作，或直接删掉副词。',
  },
];

/** 破折号与省略号：AI 使用得比人类更规整、更频繁 */
const PUNCT_DASH = /——|—|--/g;
const PUNCT_ELLIPSIS = /…{1,2}|\.{3,}|。{3,}/g;
const PUNCT_COMMA = /[，,、；;]/g;
const PUNCT_PERIOD = /[。！？!?]/g;

// ── 文本切分（中文三种格式都要处理）──────────────────────────────────

export interface ParagraphSlice {
  no: number;
  start: number;
  end: number;
  text: string;
}

/**
 * 段落切分。
 *
 * ★ 三种格式实测中最常见的陷阱（原型踩过的坑）：
 *   ① 空行分段（Markdown / 平台导出）
 *   ② **一段一行、段间不空行**（最常见的 .txt 小说）
 *   ③ 定宽折行（古籍电子本 / PDF 复制）
 *   只按空行切，会把格式②的整章读成一段。
 *
 * 判据：看**行尾句末标点比例**——折行文本的多数行不以句末标点结尾。
 * 且必须先判折行再谈空行（一个零星空行会带偏全局判断）。
 */
export function splitParagraphs(text: string): ParagraphSlice[] {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return [];

  // 判据：行尾是句末标点的比例
  const enders = /[。！？…」』"”]$/;
  const endedCount = nonEmpty.filter((l) => enders.test(l.trim())).length;
  const endedRatio = endedCount / nonEmpty.length;
  const isWrapped = endedRatio < 0.45; // 折行文本的判据阈值

  const out: ParagraphSlice[] = [];
  let offset = 0;
  let no = 0;
  let buf = '';
  let bufStart = -1;

  const flush = () => {
    const t = buf.trim();
    if (t.length > 0) {
      no += 1;
      out.push({ no, start: bufStart, end: bufStart + buf.length, text: t });
    }
    buf = '';
    bufStart = -1;
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 还原被 split 掉的 \n

    if (line.trim().length === 0) {
      // 空行：格式①的分段符（折行文本里的零星空行也按分段处理，安全）
      flush();
      continue;
    }
    if (bufStart < 0) bufStart = lineStart;
    else if (isWrapped) buf += line.trim(); // 折行：直接拼接，不加分隔
    else if (buf.length > 0) {
      // 非折行且非空行：说明是「一段一行不空行」格式 → 新起一段
      flush();
      bufStart = lineStart;
    }
    if (isWrapped) buf += line.trim();
    else buf = buf.length > 0 ? `${buf}${line}` : line;
  }
  flush();
  return out;
}

/** 句子切分。保留偏移以便定位 */
export interface SentenceSlice {
  start: number;
  end: number;
  text: string;
}

export function splitSentences(text: string, baseOffset = 0): SentenceSlice[] {
  const out: SentenceSlice[] = [];
  // 句末标点：中文句号/叹号/问号/省略号，以及闭引号后
  const re = /[^。！？…]*[。！？…]+[」』"”]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw.trim().length === 0) continue;
    out.push({
      start: baseOffset + m.index,
      end: baseOffset + m.index + raw.length,
      text: raw.trim(),
    });
  }
  return out;
}

// ── 统计工具 ─────────────────────────────────────────────────────────

function meanOf(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function pstdev(a: number[]): number {
  if (a.length === 0) return 0;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
}

/** 变异系数：标准差 / 均值。衡量「均匀程度」，与量纲无关，可跨文本比较 */
function cvOf(a: number[]): number {
  const m = meanOf(a);
  return m > 0 ? pstdev(a) / m : 0;
}

function countMatches(text: string, re: RegExp): number {
  // 每次新建 RegExp，避免 lastIndex 状态泄漏（原型踩过的坑）
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let n = 0;
  while (r.exec(text) !== null) n++;
  return n;
}

function findAll(text: string, re: RegExp): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    out.push({ index: m.index, text: m[0] });
    if (m[0].length === 0) r.lastIndex++; // 防空匹配死循环
  }
  return out;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── v2 判据：方向 / 模式 / 打分函数 ──────────────────────────────────

/** 维度方向：high-bad = 越高越可疑；low-bad = 越低越可疑（设计 §1.3） */
export type FlavorDir = 'high-bad' | 'low-bad';
/** 判据模式：deviation = 主公式；zero-inflated = 零膨胀软饱和（设计 §1.2.1） */
export type FlavorMode = 'deviation' | 'zero-inflated';

/** 单个指标的判据规格 */
export interface JudgeSpec {
  dir: FlavorDir;
  mode: FlavorMode;
}

/**
 * 11 个指标各一条判据规格（方向 + 模式）。参数照抄设计 §2.1 总表。
 *
 * ★ 键是**指标**（11 个）而不是维度（10 个）——这一点很重要：
 *   `punctuation-pattern` 有**两个子信号**（comma 与 dash）。若按维度建表再「按指标反查维度」，
 *   `dash_ellipsis_per1000` 会因为「不是任何维度的主指标」而落进兜底方向（实测会被判成
 *   low-bad → dash 分支恒 0 分，形同死代码）。故这里直接以指标为键，杜绝反查。
 *
 * 维度 → 主指标（设计 §2.1 总表）：
 *   sentence-rhythm   → sent_cv             (low-bad)
 *   paragraph-rhythm  → para_cv             (low-bad，＋对白护栏)
 *   lexical-diversity → ttr                 (low-bad)
 *   phrase-repetition → tri_repeat          (high-bad)
 *   opening-pattern   → opening_dup_ratio   (high-bad)
 *   template-connector→ connector_per1000   (high-bad，零膨胀)
 *   marker-density    → ai_marker_per1000   (high-bad，9 类聚合)
 *   punctuation-pattern→ comma_period_ratio (high-bad，＋ dash_ellipsis 子信号 high-bad)
 *   dialog-ratio      → dialog_para_ratio   (low-bad)
 *   parallel-structure→ parallel_per100sent (high-bad，零膨胀)
 *
 * ★ 方向是**维度/指标语义**，不随语料变：low-bad→good=p05、high-bad→good=p95，
 *   与既有 `metrics-engine.ts::grade()` 一致（该口径曾被任务书写反，本表为准）。
 */
const METRIC_JUDGE: Record<FlavorMetricKey, JudgeSpec> = {
  sent_cv: { dir: 'low-bad', mode: 'deviation' },
  para_cv: { dir: 'low-bad', mode: 'deviation' },
  ttr: { dir: 'low-bad', mode: 'deviation' },
  tri_repeat: { dir: 'high-bad', mode: 'deviation' },
  opening_dup_ratio: { dir: 'high-bad', mode: 'deviation' },
  connector_per1000: { dir: 'high-bad', mode: 'zero-inflated' },
  ai_marker_per1000: { dir: 'high-bad', mode: 'deviation' },
  comma_period_ratio: { dir: 'high-bad', mode: 'deviation' },
  dash_ellipsis_per1000: { dir: 'high-bad', mode: 'deviation' },
  dialog_para_ratio: { dir: 'low-bad', mode: 'deviation' },
  parallel_per100sent: { dir: 'high-bad', mode: 'zero-inflated' },
};

/**
 * 维度 → **主指标**（`calibrated` 回退标记读该主指标，T03）。
 *
 * ★ 与 `METRIC_JUDGE` 的「维度 → 主指标」注释一致。`punctuation-pattern` 有逗号/破折号两个
 *   子信号，取 `comma_period_ratio` 为主：二者用**同一批章节**算分位，样本闸门下要么一起校准、
 *   要么一起回退，故取主即可，不会出现「一子信号校准、另一回退」的错配。
 */
const DIM_MAIN_METRIC: Record<FlavorDimension, FlavorMetricKey> = {
  'sentence-rhythm': 'sent_cv',
  'paragraph-rhythm': 'para_cv',
  'lexical-diversity': 'ttr',
  'phrase-repetition': 'tri_repeat',
  'opening-pattern': 'opening_dup_ratio',
  'template-connector': 'connector_per1000',
  'marker-density': 'ai_marker_per1000',
  'punctuation-pattern': 'comma_period_ratio',
  'dialog-ratio': 'dialog_para_ratio',
  'parallel-structure': 'parallel_per100sent',
};

export interface ScoreResult {
  /** 0~100，越高越可疑 */
  score: number;
  /** 原始偏离度 d（未换算成分数），可核对 */
  deviation: number;
  /** 无法判分（如基线分位数非单调 p05 > p95）。省略 = false */
  unjudged?: boolean;
}

/**
 * 主判据：按基线分位数把特征值映射成 0~100（设计 §1.2）。
 *
 * ★ 方向务必记牢（曾被写反）：**high-bad 边界取 p95、low-bad 边界取 p05**。
 *   v 落在正常带内 → 0 分；偏离达「一整个正常带宽度」→ 100 分。
 *
 * ★ 基线单调性护栏（QA D3）：若基线被篡改成 `p05 > p95`，则 `span = max(p95−p05, ε) = ε`，
 *   任意值都会被放大到 100 —— **静默给出满分是最坏的一类失败**（用户会以为文章糟透了）。
 *   故入口先校验 `p95 >= p05`，不满足即 **unjudged + 披露**，绝不静默饱和。
 */
export function scoreByDeviation(
  value: number,
  base: MetricBaseline,
  dir: FlavorDir,
  sat: number = DEFAULT_SAT,
): ScoreResult {
  // ★ 单调性护栏：p95 < p05 → 基线异常 → 不可判（不猜满分）。
  if (base.p95 < base.p05) {
    return { score: 0, deviation: 0, unjudged: true };
  }
  const span = Math.max(base.p95 - base.p05, EPS);
  const d =
    dir === 'high-bad'
      ? Math.max(0, (value - base.p95) / span) // 只在超过上边界时为正
      : Math.max(0, (base.p05 - value) / span); // 只在低于下边界时为正
  const score = Math.round(clamp01(d / Math.max(sat, EPS)) * 100);
  return { score, deviation: d };
}

/**
 * 零膨胀指标判据（**计数口径**，长度无关）（设计 §1.2.1 / 架构师最终定夺）。
 *
 * `denom = kz × max(corpusMaxCount, 1)`。
 *
 * ★ 为什么用计数而非密度：密度是长度相关量——同一个词在 600 字章节与 3000 字章节得分不同
 *   （实测 600 字章出现 1 次即 100 分、中位长度只得 33 分），短章被过度惩罚。
 *   计数口径与章节长度无关，也与 UI 文案「约 N 次/章才算显著」一致。
 *
 * ★ 恒有 `corpusMaxCount / denom ≡ 1/3`（`corpusMaxCount ≥ 1` 时）→
 *   作者自己最极端的一章也只有 33 分、出现 1 次同样 ≤33 分（绝不跳满）。
 *
 * @param count          本章该结构的**出现次数**（整数）
 * @param corpusMaxCount 语料中「单章出现次数」的最大值（来自基线；<1 时兜底为 1，避免除零）
 * @returns 0~100 分数
 */
export function scoreZeroInflated(
  count: number,
  corpusMaxCount: number,
  kz: number = ZERO_INFLATED_KZ,
): number {
  const denom = kz * Math.max(corpusMaxCount, 1); // ≥ KZ ≥ 1，天然不会除零
  return Math.round(clamp01(Math.max(0, count) / denom) * 100);
}

/** 基线样本量 → 置信度（设计 §4.5：≥30 high；10~29 medium；<10 low） */
function confidenceOf(baseline: FlavorBaseline): FlavorConfidence {
  if (baseline.chapters >= 30) return 'high';
  if (baseline.chapters >= 10) return 'medium';
  return 'low';
}

// ── 特征提取（检测与自建基线共用的唯一口径来源）──────────────────────

/**
 * 一篇文章的全部底层特征值。**口径唯一来源**：检测与用户自建基线都用它，
 * 保证「基线与检测同口径」（设计 §3.2）。
 */
export interface FlavorFeatures {
  /** 全文字符数（不含空白）——对齐设计 §4.2.1 的 `f.chars`（minChars 判定用） */
  chars: number;
  /** 段落数（对齐设计 §3.2 字段名） */
  paraCount: number;
  /** 句子数（对齐设计 §3.2 字段名） */
  sentCount: number;
  /** 句/段比（段落节奏护栏用） */
  sentsPerPara: number;
  /** 段落长度中位数（原 v1 护栏用的量，v2 仅留作诊断） */
  paraMedian: number;
  sentCv: number;
  paraCv: number;
  ttr: number;
  triRepeat: number;
  dialogParaRatio: number;
  openDupRatio: number;
  /** 模板连接词出现**次数**（零膨胀维度按计数判定，长度无关） */
  connectorCount: number;
  /** 9 类 AI_MARKERS 聚合密度（marker-density 维度分用它） */
  markerTotalPer1000: number;
  /** 逐类 marker 密度（命中归因用，不决定维度分） */
  markerPer1000: Record<string, number>;
  commaPeriodRatio: number;
  /** 破折号+省略号密度（对齐设计 §3.2 的 `dashPer1000` ≡ 指标 `dash_ellipsis_per1000`） */
  dashPer1000: number;
  /** 对仗结构出现**次数**（零膨胀维度按计数判定，长度无关） */
  parallelCount: number;
}

/** 段内句子切片（internal，供 detectFlavor 与特征提取共用，避免重复切分） */
function sentencesOf(paras: ParagraphSlice[]): SentenceSlice[] {
  const out: SentenceSlice[] = [];
  for (const p of paras) out.push(...splitSentences(p.text, p.start));
  return out;
}

/**
 * 从「正文」提取全部特征。
 *
 * ★ 契约：`text` 是**章节正文，不含标题行**。调用方负责分离标题
 *   （`Chapter.body` 天然不含标题；`chapter_bodies` 表也只存 body）。
 *   ⚠️ **不要**在本函数内「去掉首个非空行」——传进来的已是正文，再删就是把
 *   **第一段正文**当标题删掉（每章丢一段）。
 */
export function extractFlavorFeatures(text: string): FlavorFeatures {
  const paras = splitParagraphs(text);
  const sents = sentencesOf(paras);
  return computeFeatures(text, paras, sents);
}

function computeFeatures(text: string, paras: ParagraphSlice[], sents: SentenceSlice[]): FlavorFeatures {
  const nospace = text.replace(/\s/g, '');
  const chars = nospace.length;

  const sentLens = sents.map((s) => s.text.replace(/\s/g, '').length).filter((x) => x > 0);
  const paraLens = paras.map((p) => p.text.replace(/\s/g, '').length).filter((x) => x > 0);

  const paraSorted = [...paraLens].sort((a, b) => a - b);
  const paraMedian = paraSorted.length ? paraSorted[Math.floor(paraSorted.length / 2)] : 0;

  // 三字片段重复率：nospace 上滑窗
  const tri: string[] = [];
  for (let i = 0; i < nospace.length - 2; i++) tri.push(nospace.substr(i, 3));
  const triRepeat = tri.length ? (tri.length - new Set(tri).size) / tri.length : 0;

  // 对白段占比：三种引号都认
  const dialogRe = /[“"「][^”"」]{1,400}[”"」]/;
  const dialogParas = paras.filter((p) => dialogRe.test(p.text)).length;
  const dialogParaRatio = paras.length ? dialogParas / paras.length : 0;

  // 句首两字最大重复占比
  const heads = sents.map((s) => s.text.slice(0, 2)).filter((h) => h.length === 2);
  const headCounter = new Map<string, number>();
  for (const h of heads) headCounter.set(h, (headCounter.get(h) ?? 0) + 1);
  const maxDup = headCounter.size ? Math.max(...headCounter.values()) : 0;
  const openDupRatio = heads.length ? maxDup / heads.length : 0;

  // 模板连接词**计数**（零膨胀维度按计数判定，长度无关；密度仅在 note 里现算展示）
  let connectorHits = 0;
  for (const w of TEMPLATE_CONNECTORS) connectorHits += countMatches(text, new RegExp(w, 'g'));

  // AI_MARKERS：逐类 + 聚合
  const markerPer1000: Record<string, number> = {};
  let markerTotal = 0;
  for (const m of AI_MARKERS) {
    const n = countMatches(text, m.re);
    markerTotal += n;
    markerPer1000[m.key] = chars > 0 ? (n * 1000) / chars : 0;
  }
  const markerTotalPer1000 = chars > 0 ? (markerTotal * 1000) / chars : 0;

  // 标点
  const comma = countMatches(text, PUNCT_COMMA);
  const period = countMatches(text, PUNCT_PERIOD);
  const commaPeriodRatio = period > 0 ? comma / period : comma > 0 ? 6 : 0;
  const dash = countMatches(text, PUNCT_DASH);
  const ell = countMatches(text, PUNCT_ELLIPSIS);
  const dashEllipsisPer1000 = chars > 0 ? ((dash + ell) * 1000) / chars : 0;

  // 对仗结构**计数**（零膨胀维度按计数判定，长度无关；密度仅在 note 里现算展示）
  let parallelHits = 0;
  for (const p of PARALLEL_PATTERNS) parallelHits += countMatches(text, p);

  return {
    chars,
    paraCount: paras.length,
    sentCount: sents.length,
    sentsPerPara: paras.length ? sents.length / paras.length : 0,
    paraMedian,
    sentCv: sentLens.length ? cvOf(sentLens) : 0,
    paraCv: paraLens.length ? cvOf(paraLens) : 0,
    ttr: chars > 0 ? new Set(nospace).size / chars : 0,
    triRepeat,
    dialogParaRatio,
    openDupRatio,
    connectorCount: connectorHits,
    markerTotalPer1000,
    markerPer1000,
    commaPeriodRatio,
    dashPer1000: dashEllipsisPer1000,
    parallelCount: parallelHits,
  };
}

// ── 各维度计算（读基线，不再硬编码 good/bad）────────────────────────

interface DimResult {
  score: number;
  measured: number | null;
  baseline: number | null;
  note: string;
  deviation: number | null;
  band: [number, number] | null;
  /**
   * 是否未参与总评（会被剔除并重归一）。省略=false。两类情形：
   *   ① 语义上**不适用**（对白墙护栏）；
   *   ② **无法可靠判分**（旧口径基线缺 `corpusMaxCount`）——此时 `note` 必须披露原因。
   * ★ 与「样本不足」不同：样本不足走 `unjudged(..., false)`，仍以 0 分计入（认怂但参与）。
   */
  skipped?: boolean;
}

/** 维度未参与判定的统一结果（样本不足 / 护栏跳过）；`skipped=true` 表示从总评剔除 */
function unjudged(measured: number | null, note: string, skipped = false): DimResult {
  return { score: 0, measured, baseline: null, note, deviation: null, band: null, skipped };
}

/** `judge()` 的返回：`unjudged=true` = 「无法可靠判分」（旧口径缺字段 / 基线非单调） */
interface JudgeOutcome {
  score: number;
  deviation: number | null;
  anchor: number | null;
  band: [number, number] | null;
  /** 无法判分时置 true（调用方须标记 skipped 并披露 `reason`）。省略 = false */
  unjudged?: boolean;
  /** `unjudged=true` 时的披露文案 */
  reason?: string;
}

/** 按 METRIC_JUDGE 把某指标值打分（含零膨胀分支），并把「锚点/带宽」一并带回 */
function judge(key: FlavorMetricKey, value: number, baseline: FlavorBaseline): JudgeOutcome {
  const j = METRIC_JUDGE[key];
  const base = baseline.metrics[key];
  if (j.mode === 'zero-inflated') {
    // ★ 零膨胀指标的 `value` 传的是**整数计数**（非密度）；判据只用 corpusMaxCount。
    //   无「正常带」概念 → anchor/band/deviation 均为 null（UI 不显示带宽）。
    //
    // ★★ 旧口径识别（务必区分「缺字段」与 `0`，**不要用 `?? 0` 把两者混为一谈**）：
    //   `corpusMaxCount == null`（`undefined` 或 `null`）= **旧口径基线**（当年只存密度形态，
    //     没有计数字段）→ 该维度**无法可靠判分**，须 unjudged（转 skipped + 披露「建议重建基线」）。
    //     ⚠️ 用 `== null` 而非 `=== undefined`：基线 JSON 里若该字段是显式 `null`
    //     （或经其它序列化路径变成 `null`），只判 `undefined` 会**漏过** → 落进 `max(null,1)`
    //     → 静默按新口径判分（QA D2）。`== null` 同时覆盖两者。
    //     ⚠️ 绝不静默兜底：`parallel` 旧基线缺字段时若 `?? 0` 兜底成 denom = 3×1 = 3，
    //     会把「1 处」算成 33 分（正确值应为 17 分）——静默算错且不报警，属潜伏缺陷。
    //   `corpusMaxCount === 0` 是**合法值**（语料单章最多出现 0 次），此时 `max(0,1)` 兜底为 1
    //     才正确（`scoreZeroInflated` 内部处理）。
    if (base.corpusMaxCount == null) {
      return { score: 0, deviation: null, anchor: null, band: null, unjudged: true, reason: OLD_BASELINE_NOTE };
    }
    const score = scoreZeroInflated(value, base.corpusMaxCount, ZERO_INFLATED_KZ);
    return { score, deviation: null, anchor: null, band: null };
  }
  const r = scoreByDeviation(value, base, j.dir, DEFAULT_SAT);
  // ★ 基线非单调（p05 > p95）→ 不可判，披露而非静默给满分（QA D3）。
  if (r.unjudged) {
    return { score: 0, deviation: null, anchor: null, band: null, unjudged: true, reason: ANOMALY_NOTE };
  }
  const anchor = j.dir === 'high-bad' ? base.p95 : base.p05;
  return { score: r.score, deviation: r.deviation, anchor, band: [base.p05, base.p95] };
}

const fmt = (x: number, d = 2): string => x.toFixed(d);

function dimSentenceRhythm(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.sentCount < 3) return unjudged(null, '句子太少，无法判断节奏');
  const r = judge('sent_cv', f.sentCv, baseline);
  // ★ 基线异常（p05 > p95）→ 不可判：披露而非静默给满分（QA D3）。
  if (r.unjudged) return unjudged(Number(f.sentCv.toFixed(3)), r.reason ?? ANOMALY_NOTE, true);
  const band = baseline.metrics.sent_cv;
  return {
    score: r.score,
    measured: Number(f.sentCv.toFixed(3)),
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `句长变化度 ${fmt(f.sentCv, 3)}，低于你的正常范围 [${band.p05}, ${band.p95}]——节奏比平时更平`
        : `句长变化度 ${fmt(f.sentCv, 3)}，在你的正常范围内`,
  };
}

function dimParagraphRhythm(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.paraCount < 3) return unjudged(null, '段落太少，无法判断节奏');

  // ★ v2 护栏（替换 v1 的「段落中位<120 跳过」）：只挡「纯对白墙」——
  //   对白段≥85% 且几乎一句一段。v1 用「段落短」当判据，对网文 715/715 章永久失效。
  // ★ 触发时 `skipped=true`：护栏语义是「**不适用**」（对白墙的段落整齐本就不该判），
  //   而非「评估过、没问题」——故从总评剔除并重归一，不记为 0 分把总分拉低。
  if (f.dialogParaRatio >= DIALOG_GUARD_RATIO && f.sentsPerPara <= DIALOG_GUARD_SENTS_PER_PARA) {
    return unjudged(
      Number(f.paraCv.toFixed(3)),
      `对白驱动的短句排版（对白段 ${(f.dialogParaRatio * 100).toFixed(0)}%、${fmt(
        f.sentsPerPara,
      )} 句/段），不计入段落节奏判定`,
      true,
    );
  }

  const r = judge('para_cv', f.paraCv, baseline);
  // ★ 基线异常（p05 > p95）→ 不可判：披露（QA D3）。
  if (r.unjudged) return unjudged(Number(f.paraCv.toFixed(3)), r.reason ?? ANOMALY_NOTE, true);
  const band = baseline.metrics.para_cv;
  return {
    score: r.score,
    measured: Number(f.paraCv.toFixed(3)),
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `段落长度变化度 ${fmt(f.paraCv, 3)}，低于你的正常范围 [${band.p05}, ${band.p95}]——段落比平时更等长`
        : `段落长度变化度 ${fmt(f.paraCv, 3)}，在你的正常范围内`,
  };
}

function dimLexicalDiversity(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.chars < 100) return unjudged(null, '文本过短，无法评估用字多样性');
  const r = judge('ttr', f.ttr, baseline);
  if (r.unjudged) return unjudged(Number(f.ttr.toFixed(4)), r.reason ?? ANOMALY_NOTE, true);
  const band = baseline.metrics.ttr;
  return {
    score: r.score,
    measured: Number(f.ttr.toFixed(4)),
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `单字多样性 ${(f.ttr * 100).toFixed(1)}%，低于你的正常范围 [${band.p05}, ${band.p95}]——反复用同几个字`
        : `单字多样性 ${(f.ttr * 100).toFixed(1)}%，在你的正常范围内`,
  };
}

function dimPhraseRepetition(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.chars < 100) return unjudged(null, '文本过短，无法评估短语重复');
  const r = judge('tri_repeat', f.triRepeat, baseline);
  if (r.unjudged) return unjudged(Number(f.triRepeat.toFixed(4)), r.reason ?? ANOMALY_NOTE, true);
  const band = baseline.metrics.tri_repeat;
  return {
    score: r.score,
    measured: Number(f.triRepeat.toFixed(4)),
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `三字片段重复率 ${(f.triRepeat * 100).toFixed(1)}%，高于你的正常范围上限 ${band.p95}（偏离 ${fmt(
            r.deviation ?? 0,
          )} 个带宽）`
        : `三字片段重复率 ${(f.triRepeat * 100).toFixed(1)}%，在你的正常范围内`,
  };
}

function dimOpeningPattern(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.sentCount < 8) return unjudged(null, '句子太少，无法判断句首模式');
  const r = judge('opening_dup_ratio', f.openDupRatio, baseline);
  if (r.unjudged) return unjudged(Number(f.openDupRatio.toFixed(3)), r.reason ?? ANOMALY_NOTE, true);
  const band = baseline.metrics.opening_dup_ratio;
  return {
    score: r.score,
    measured: Number(f.openDupRatio.toFixed(3)),
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `句首两字重复占比 ${(f.openDupRatio * 100).toFixed(1)}%，高于你的正常范围上限 ${(
            band.p95 * 100
          ).toFixed(1)}%——句式比平时单调`
        : `句首两字重复占比 ${(f.openDupRatio * 100).toFixed(1)}%，在你的正常范围内`,
  };
}

function dimTemplateConnector(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.chars < 100) return unjudged(null, '文本过短');
  const r = judge('connector_per1000', f.connectorCount, baseline);
  // ★ 不可判（旧口径缺 corpusMaxCount）→ 明确披露，不猜分、不参与总评。
  if (r.unjudged) return unjudged(f.connectorCount, r.reason ?? OLD_BASELINE_NOTE, true);
  // 密度仅用于文案展示（判据用计数，长度无关）
  const density = f.chars > 0 ? (f.connectorCount * 1000) / f.chars : 0;
  return {
    score: r.score,
    measured: f.connectorCount,
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `模板连接词 ${f.connectorCount} 处（${fmt(density)}/千字），高于你的语料正常值（≈0）——「然而/因此」这类书面承接词网文里几乎不用`
        : `模板连接词 ${f.connectorCount} 处（${fmt(density)}/千字），在你的正常范围内（语料实测≈0，出现才计分）`,
  };
}

function dimMarkerDensity(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.chars < 100) return unjudged(null, '文本过短');
  const r = judge('ai_marker_per1000', f.markerTotalPer1000, baseline);
  if (r.unjudged) return unjudged(Number(f.markerTotalPer1000.toFixed(2)), r.reason ?? ANOMALY_NOTE, true);
  const band = baseline.metrics.ai_marker_per1000;
  return {
    score: r.score,
    measured: Number(f.markerTotalPer1000.toFixed(2)),
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `AI 味标志词密度 ${fmt(f.markerTotalPer1000)} 次/千字（9 类聚合），高于你的正常范围上限 ${band.p95}`
        : `AI 味标志词密度 ${fmt(f.markerTotalPer1000)} 次/千字（9 类聚合），在你的正常范围内`,
  };
}

function dimPunctuationPattern(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.chars < 200) return unjudged(null, '文本过短');
  // 两个子信号：逗号/句号比、破折号+省略号密度；取较严者（引擎既有行为）。
  // ★ 注意 dash 虽 p05=p50=0 但 p95≠0 → 走主公式，**不是**零膨胀（勿误套 §1.2.1）。
  const rc = judge('comma_period_ratio', f.commaPeriodRatio, baseline);
  const rd = judge('dash_ellipsis_per1000', f.dashPer1000, baseline);
  // ★ 任一子信号基线异常（p05 > p95）→ 该维度不可判：披露（QA D3）。
  if (rc.unjudged || rd.unjudged) {
    return unjudged(
      Number(f.commaPeriodRatio.toFixed(2)),
      rc.reason ?? rd.reason ?? ANOMALY_NOTE,
      true,
    );
  }
  const useComma = rc.score >= rd.score;
  const win = useComma ? rc : rd;
  const bandC = baseline.metrics.comma_period_ratio;
  const bandD = baseline.metrics.dash_ellipsis_per1000;
  const notes: string[] = [];
  if (rc.score > 0) {
    notes.push(`逗号/句号比 ${fmt(f.commaPeriodRatio)}，高于你的正常范围上限 ${bandC.p95}——句式比平时更拖`);
  }
  if (rd.score > 0) {
    notes.push(`破折号/省略号 ${fmt(f.dashPer1000)} 次/千字，高于你的正常范围上限 ${bandD.p95}`);
  }
  return {
    score: win.score,
    measured: Number(f.commaPeriodRatio.toFixed(2)),
    baseline: useComma ? rc.anchor : rd.anchor,
    deviation: useComma ? rc.deviation : rd.deviation,
    band: useComma ? rc.band : rd.band,
    note:
      notes.length > 0
        ? notes.join('；')
        : `标点使用正常（逗号/句号比 ${fmt(f.commaPeriodRatio)}，破折号/省略号 ${fmt(
            f.dashPer1000,
          )} 次/千字）`,
  };
}

function dimDialogRatio(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.chars < 200 || f.paraCount < 3) return unjudged(null, '无法评估对白占比');
  const r = judge('dialog_para_ratio', f.dialogParaRatio, baseline);
  if (r.unjudged) return unjudged(Number(f.dialogParaRatio.toFixed(3)), r.reason ?? ANOMALY_NOTE, true);
  const band = baseline.metrics.dialog_para_ratio;
  return {
    score: r.score,
    measured: Number(f.dialogParaRatio.toFixed(3)),
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `对白段占比 ${(f.dialogParaRatio * 100).toFixed(0)}%，低于你的正常范围 [${(
            band.p05 * 100
          ).toFixed(0)}%, ${(band.p95 * 100).toFixed(0)}%]——这一章叙述偏重`
        : `对白段占比 ${(f.dialogParaRatio * 100).toFixed(0)}%，在你的正常范围内`,
  };
}

function dimParallelStructure(f: FlavorFeatures, baseline: FlavorBaseline): DimResult {
  if (f.sentCount < 5) return unjudged(null, '句子太少');
  const r = judge('parallel_per100sent', f.parallelCount, baseline);
  // ★ 不可判（旧口径缺 corpusMaxCount）→ 明确披露，不猜分、不参与总评。
  if (r.unjudged) return unjudged(f.parallelCount, r.reason ?? OLD_BASELINE_NOTE, true);
  // 密度仅用于文案展示（判据用计数，长度无关）
  const density = f.sentCount > 0 ? (f.parallelCount * 100) / f.sentCount : 0;
  return {
    score: r.score,
    measured: f.parallelCount,
    baseline: r.anchor,
    deviation: r.deviation,
    band: r.band,
    note:
      r.score > 0
        ? `对仗式表达 ${f.parallelCount} 处（${fmt(density)}/百句），高于你的语料正常值（≈0）——「仿佛…一般」「不是…而是」密集时显得刻意`
        : `对仗式表达 ${f.parallelCount} 处（${fmt(density)}/百句），在你的正常范围内`,
  };
}

// ── 命中片段生成（沿用 v1，逐类 marker 用于归因）─────────────────────

/** 从命中偏移反查所属段落序号 */
function paragraphOf(slices: ParagraphSlice[], offset: number): number {
  for (const p of slices) if (offset >= p.start && offset <= p.end) return p.no;
  return slices.length > 0 ? slices[slices.length - 1].no : 0;
}

function excerptOf(text: string, index: number, len: number, pad = 12): string {
  const s = Math.max(0, index - pad);
  const e = Math.min(text.length, index + len + pad);
  const head = s > 0 ? '…' : '';
  const tail = e < text.length ? '…' : '';
  return head + text.slice(s, e) + tail;
}

function makeHit(
  text: string,
  slices: ParagraphSlice[],
  dimension: FlavorDimension,
  kind: string,
  index: number,
  length: number,
  severity: number,
  level: FlavorLevel,
  reason: string,
  advice: string,
  cfg: FlavorConfig,
): FlavorHit {
  return {
    dimension,
    kind,
    level,
    severity,
    excerpt: cfg.includeExcerpts ? excerptOf(text, index, length) : '',
    offset: index,
    length,
    paragraphNo: paragraphOf(slices, index),
    reason,
    advice,
  };
}

// ── 主入口 ───────────────────────────────────────────────────────────

/**
 * 检测一章的 AI 味偏离度。
 *
 * @param input    章节**正文**，不含标题行。调用方负责分离标题
 *                 （`Chapter.body` 天然不含标题）。⚠️ 本函数**不做**任何删行变换：
 *                 传入的已是正文，若在此再删首个非空行，就是把第一段正文当标题删掉。
 * @param chapterId 章节 id（仅用于报告回填）
 * @param cfg      配置（维度开关 / 阈值 / 权重）
 * @param baseline 判据基线；缺省 = 内置 715 章默认基线。主进程负责解析「用户基线 or 默认」后注入。
 */
export function detectFlavor(
  input: string,
  chapterId: string,
  cfg: FlavorConfig = DEFAULT_FLAVOR_CONFIG,
  baseline: FlavorBaseline = DEFAULT_FLAVOR_BASELINE,
): FlavorReport {
  // 防御：非字符串入参（编辑器清空 / localStorage 脏数据）不抛错
  const text = typeof input === 'string' ? input : '';

  const slices = splitParagraphs(text);
  const sentSlices = sentencesOf(slices);
  const f = computeFeatures(text, slices, sentSlices);

  const results: Record<FlavorDimension, DimResult> = {
    'sentence-rhythm': dimSentenceRhythm(f, baseline),
    'paragraph-rhythm': dimParagraphRhythm(f, baseline),
    'lexical-diversity': dimLexicalDiversity(f, baseline),
    'phrase-repetition': dimPhraseRepetition(f, baseline),
    'opening-pattern': dimOpeningPattern(f, baseline),
    'template-connector': dimTemplateConnector(f, baseline),
    'marker-density': dimMarkerDensity(f, baseline),
    'punctuation-pattern': dimPunctuationPattern(f, baseline),
    'dialog-ratio': dimDialogRatio(f, baseline),
    'parallel-structure': dimParallelStructure(f, baseline),
  };

  // 置信度来自基线样本量（设计 §2.4）。各维度「是否校准」改由主指标的 `calibrated` 决定（见下）。
  const conf = confidenceOf(baseline);

  // 维度得分（关掉的维度、以及「不适用」的护栏维度 → skipped，不参与总评）
  const dimensions: DimensionScore[] = FLAVOR_DIMENSIONS.map((d) => {
    const on = cfg.dimensions[d] !== false;
    const r = results[d];
    const skipped = !on || r.skipped === true;
    const score = skipped ? 0 : r.score;
    // ★ 是否已校准：读该维度**主指标**的 `calibrated`（缺省视为 true）。
    //   用户基线对样本不足而回退默认值的指标写 false → 该维度如实标记「未校准」，UI 可提示。
    const calibrated = baseline.metrics[DIM_MAIN_METRIC[d]]?.calibrated !== false;
    return {
      dimension: d,
      score,
      level: levelOf(score, cfg.thresholds),
      skipped,
      measured: on ? r.measured : null,
      baseline: on ? r.baseline : null,
      note: on ? r.note : '该维度已在配置中关闭',
      calibrated,
      confidence: conf,
      deviation: on ? r.deviation : null,
      band: on ? r.band : null,
    };
  });

  // 总评：加权平均，只算参与的维度；低置信维度在 strictCalibration 下可排除
  const active = dimensions.filter((d) => !d.skipped);
  const counted = active.filter((d) => (cfg.strictCalibration === false ? d.confidence !== 'low' : true));
  let wSum = 0;
  let acc = 0;
  for (const d of counted) {
    const w = cfg.weights[d.dimension] ?? DEFAULT_WEIGHTS[d.dimension] ?? 0.1;
    acc += d.score * w;
    wSum += w;
  }
  const index = wSum > 0 ? Math.round(acc / wSum) : 0;

  // 已校准维度权重占比（置信度展示用）
  let calW = 0;
  let allW = 0;
  for (const d of active) {
    const w = cfg.weights[d.dimension] ?? DEFAULT_WEIGHTS[d.dimension] ?? 0.1;
    allW += w;
    if (d.calibrated) calW += w;
  }
  const calibratedRatio = allW > 0 ? calW / allW : 1;

  // 生成命中片段
  const hits: FlavorHit[] = [];

  // 标志词命中（最高价值：可直接定位 + 有明确改法）
  if (cfg.dimensions['marker-density'] !== false) {
    for (const m of AI_MARKERS) {
      for (const hit of findAll(text, m.re)) {
        // 「一X一X」是低置信信号，降级处理
        const lowConf = m.key === '一X一X 叠词';
        const sev = lowConf ? 28 : 62;
        hits.push(
          makeHit(
            text,
            slices,
            'marker-density',
            m.key,
            hit.index,
            hit.text.length,
            sev,
            levelOf(sev, cfg.thresholds),
            `命中 AI 高频习惯表达「${hit.text}」`,
            m.advice,
            cfg,
          ),
        );
      }
    }
  }

  // 模板连接词命中
  if (cfg.dimensions['template-connector'] !== false) {
    for (const w of TEMPLATE_CONNECTORS) {
      for (const hit of findAll(text, new RegExp(w, 'g'))) {
        hits.push(
          makeHit(
            text,
            slices,
            'template-connector',
            'connector',
            hit.index,
            hit.text.length,
            52,
            levelOf(52, cfg.thresholds),
            `使用了书面化承接词「${hit.text}」——网文口语化写作通常不需要这类词`,
            `删掉「${hit.text}」，或改为更口语的过渡（直接接下一句往往更好）`,
            cfg,
          ),
        );
      }
    }
  }

  // 句首重复命中（按重复组给出，避免刷屏）
  if (cfg.dimensions['opening-pattern'] !== false) {
    const counter = new Map<string, SentenceSlice[]>();
    for (const s of sentSlices) {
      const head = s.text.slice(0, 2);
      if (head.length < 2) continue;
      const arr = counter.get(head);
      if (arr) arr.push(s);
      else counter.set(head, [s]);
    }
    for (const [head, group] of counter) {
      if (group.length < 3) continue;
      const first = group[0];
      hits.push(
        makeHit(
          text,
          slices,
          'opening-pattern',
          'openingDup',
          first.start,
          first.text.length,
          45,
          levelOf(45, cfg.thresholds),
          `有 ${group.length} 个句子以「${head}」开头，句式单调`,
          `改掉其中 ${group.length - 1} 个句子的开头，让句式有变化`,
          cfg,
        ),
      );
    }
  }

  // 对仗结构命中
  if (cfg.dimensions['parallel-structure'] !== false) {
    for (const p of PARALLEL_PATTERNS) {
      for (const hit of findAll(text, p)) {
        hits.push(
          makeHit(
            text,
            slices,
            'parallel-structure',
            'parallel',
            hit.index,
            hit.text.length,
            38,
            levelOf(38, cfg.thresholds),
            `对仗式表达「${hit.text.length > 14 ? hit.text.slice(0, 14) + '…' : hit.text}」`,
            '适度对仗是文笔，但密集出现会显得刻意。考虑换成更直白的叙述。',
            cfg,
          ),
        );
      }
    }
  }

  // 按严重度排序 → 截断（防止长文返回上万条压垮 UI）
  hits.sort((a, b) => b.severity - a.severity || a.offset - b.offset);
  const limited = hits.slice(0, cfg.maxHits);

  // 段落得分：段内命中严重度的聚合 + 段自身节奏
  const paragraphs_: ParagraphScore[] = slices.map((p) => {
    const inPara = limited.filter((h) => h.offset >= p.start && h.offset <= p.end);
    const paraChars = p.text.replace(/\s/g, '').length;
    let score = 0;
    if (inPara.length > 0) {
      const sevSum = inPara.reduce((s, h) => s + h.severity, 0);
      score = Math.min(100, Math.round(sevSum / Math.max(1, Math.sqrt(paraChars / 80))));
    }
    const dimCount = new Map<FlavorDimension, number>();
    for (const h of inPara) dimCount.set(h.dimension, (dimCount.get(h.dimension) ?? 0) + 1);
    let top: FlavorDimension | null = null;
    let topN = 0;
    for (const [d, n] of dimCount) {
      if (n > topN) {
        topN = n;
        top = d;
      }
    }
    return {
      no: p.no,
      start: p.start,
      end: p.end,
      score,
      level: levelOf(score, cfg.thresholds),
      chars: paraChars,
      hitCount: inPara.length,
      topDimension: top,
    };
  });

  // 主导维度：命中数 × 严重度最高的那个
  const dimSeverity = new Map<FlavorDimension, number>();
  for (const h of limited) {
    dimSeverity.set(h.dimension, (dimSeverity.get(h.dimension) ?? 0) + h.severity);
  }
  let dominant: FlavorDimension | null = null;
  let domScore = -1;
  for (const [d, v] of dimSeverity) {
    if (v > domScore) {
      domScore = v;
      dominant = d;
    }
  }
  // 无命中时退化为「扣分最多的维度」
  if (!dominant && active.length > 0) {
    dominant = active.reduce((a, b) => (b.score > a.score ? b : a)).dimension;
  }

  const sufficient = f.chars >= cfg.minChars;

  return {
    chapterId,
    index: sufficient ? index : 0,
    level: sufficient ? levelOf(index, cfg.thresholds) : 'clean',
    chars: f.chars,
    paragraphs: slices.length,
    dimensions,
    paragraphs_,
    hits: limited,
    dominantDimension: dominant,
    sufficient,
    insufficientReason: sufficient
      ? undefined
      : `正文仅 ${f.chars} 字，低于最小样本量 ${cfg.minChars} 字。` +
        `短文本的所有多样性指标天然偏低，此时判定会冤枉作者，故不出总评。`,
    engineVersion: FLAVOR_ENGINE_VERSION,
    at: Date.now(),
    baselineId: baseline.source === 'builtin' ? 'default' : 'user',
    baselineSource: baseline.corpus,
    baselineStale: isBaselineStale(baseline),
    calibratedRatio,
  };
}

/** 供 UI 显示「这次比上次好了多少」 */
export function compareIndex(before: number, after: number): number {
  return before - after; // 正数 = 改善（AI 味下降）
}
