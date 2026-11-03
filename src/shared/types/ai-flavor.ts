/**
 * AI 味检测 · 类型定义（独立板块）。
 *
 * ★ 与「专家团」完全解耦：本文件不 import expert/*，expert/* 也不 import 本文件。
 *   两者唯一的共同点是都跑在 metrics-engine 的统计基座上，但各自独立演进。
 *
 * ★ 分值方向约定（写死，避免歧义）：
 *   **0 = 几乎肯定是人写；100 = 几乎肯定是 AI 生成**。
 *   方向与朱雀一致（它输出「AI 生成概率」），与原型 MZ 的 qu-aiwei 方向相反——
 *   所以全项目凡涉及 AI 味分值处一律以本约定为准，不得混用。
 */

// ── 检测维度 ─────────────────────────────────────────────────────────

/**
 * 检测维度。每项独立可开关、独立打分、独立给原因。
 * ★ 维度划分原则：一个维度对应一类**可被作者直接改写动作**的问题。
 *   若某个统计特征无法翻译成「怎么改」，它就不该单独成维度。
 */
export type FlavorDimension =
  | 'sentence-rhythm' // 句子节奏：句长是否过于均匀
  | 'paragraph-rhythm' // 段落节奏：段长是否过于均匀
  | 'lexical-diversity' // 用字多样性：是否用词重复单调
  | 'phrase-repetition' // 短语重复：三连重复、套话连用
  | 'opening-pattern' // 句首模式：句首是否反复同一结构
  | 'template-connector' // 模板连接词：然而/因此/不仅…而且
  | 'marker-density' // AI 味标志词密度：顿了一下 / 抬起头 / 一X一X
  | 'punctuation-pattern' // 标点模式：破折号省略号使用是否规整
  | 'dialog-ratio' // 对白占比：是否长时间无对白（AI 偏好叙述）
  | 'parallel-structure'; // 排比工整度：过于对仗的伪文学腔

export const FLAVOR_DIMENSIONS: FlavorDimension[] = [
  'sentence-rhythm',
  'paragraph-rhythm',
  'lexical-diversity',
  'phrase-repetition',
  'opening-pattern',
  'template-connector',
  'marker-density',
  'punctuation-pattern',
  'dialog-ratio',
  'parallel-structure',
];

export const FLAVOR_DIMENSION_NAMES: Record<FlavorDimension, string> = {
  'sentence-rhythm': '句子节奏',
  'paragraph-rhythm': '段落节奏',
  'lexical-diversity': '用字多样性',
  'phrase-repetition': '短语重复',
  'opening-pattern': '句首模式',
  'template-connector': '模板连接词',
  'marker-density': 'AI 味标志词',
  'punctuation-pattern': '标点模式',
  'dialog-ratio': '对白占比',
  'parallel-structure': '排比工整度',
};

// ── 等级 ─────────────────────────────────────────────────────────────

/**
 * 五级判定。阈值是**可配的**（见 FlavorConfig.thresholds）。
 * 四档而不是百分制连续值，是因为作者需要的是「要不要改」而非小数。
 */
export type FlavorLevel = 'clean' | 'mild' | 'suspicious' | 'heavy' | 'severe';

export const FLAVOR_LEVEL_NAMES: Record<FlavorLevel, string> = {
  clean: '干净',
  mild: '轻微',
  suspicious: '可疑',
  heavy: '偏重',
  severe: '严重',
};

export const FLAVOR_LEVEL_ORDER: Record<FlavorLevel, number> = {
  clean: 0,
  mild: 1,
  suspicious: 2,
  heavy: 3,
  severe: 4,
};

/**
 * 置信度（v2 校准后新增）。
 * 含义 = 「该维度/该报告的基线依据有多可信」，由样本量 / 校准占比 / 基线是否陈旧合成。
 * ★ 与「AI 概率」无关——本项目从不出 AI 概率，只出可核对的偏离度。
 */
export type FlavorConfidence = 'high' | 'medium' | 'low';

// ── 命中定位 ─────────────────────────────────────────────────────────

/** 命中片段：必须能定位到原文，否则用户无法核对 */
export interface FlavorHit {
  dimension: FlavorDimension;
  /** 命中类型，如 'triRepeat' / 'templateConnector' / 'openingDup' */
  kind: string;
  level: FlavorLevel;
  /** 该片段的严重度贡献分（0~100） */
  severity: number;
  /** 命中文本原文（逐字，用于 UI 高亮；长文本截断但保留前后缀） */
  excerpt: string;
  /** 在全文中的字符偏移，UI 据此定位滚动 */
  offset: number;
  /** 长度（字符数） */
  length: number;
  /** 所属段落序号（从 1 开始），段落粒度展示用 */
  paragraphNo: number;
  /**
   * ★ 原因说明：必须写清「为什么这算 AI 味」以及「怎么改」。
   *   只报「这里有问题」而不给理由的检测器，用户不会信第二次。
   */
  reason: string;
  /** 可执行的改动建议 */
  advice: string;
}

// ── 分段得分 ─────────────────────────────────────────────────────────

/** 分段（段落粒度）得分。用户最关心「哪几段有问题」 */
export interface ParagraphScore {
  /** 段落序号，从 1 开始 */
  no: number;
  /** 该段起止偏移（全文坐标） */
  start: number;
  end: number;
  /** 该段 AI 味分 0~100 */
  score: number;
  level: FlavorLevel;
  chars: number;
  /** 该段命中的片段数 */
  hitCount: number;
  /** 主要贡献维度（得分最高的那个） */
  topDimension: FlavorDimension | null;
}

// ── 维度得分 ─────────────────────────────────────────────────────────

export interface DimensionScore {
  dimension: FlavorDimension;
  /** 0~100，越高越可疑（v2 起 = 偏离「你自己的正常范围」的程度，非「像 AI」） */
  score: number;
  level: FlavorLevel;
  /** 是否因样本不足未参与总评 */
  skipped: boolean;
  /** 该维度算出的实际统计值（供 UI 显示，如「句长变异系数 0.31」） */
  measured: number | null;
  /** 该维度的参考基线值（阈值来源），便于用户理解判定依据 */
  baseline: number | null;
  /** 一句话说明该维度当前的问题 */
  note: string;
  // ── v2 校准新增（可选：老报告反序列化不报错）──
  /** 该维度本次是否用了已校准基线 */
  calibrated?: boolean;
  /** 该维度基线的置信度 */
  confidence?: FlavorConfidence;
  /** 原始偏离度 d（未换算成分数），供 UI 原样展示「偏离 X 个带宽」 */
  deviation?: number | null;
  /** 该维度的「正常带」[p05, p95]，供 UI 画轨道 */
  band?: [number, number] | null;
}

// ── 总报告 ───────────────────────────────────────────────────────────

export interface FlavorReport {
  chapterId: string;
  /** 总 AI 味指数 0~100 */
  index: number;
  level: FlavorLevel;
  /** 全文字符数（不含空白） */
  chars: number;
  /** 段落数 */
  paragraphs: number;
  dimensions: DimensionScore[];
  paragraphs_: ParagraphScore[];
  hits: FlavorHit[];
  /** 命中最多的维度（用户优先改这个） */
  dominantDimension: FlavorDimension | null;
  /** 样本不足时整体不可信，必须让用户知道 */
  sufficient: boolean;
  /** 若 insufficient，这里是原因 */
  insufficientReason?: string;
  /** 引擎版本，便于前后对比时判断口径是否变化 */
  engineVersion: string;
  at: number;
  // ── v2 校准新增（可选：老报告反序列化不报错）──
  /** 本次用的是哪份基线（'default' | 'user'） */
  baselineId?: string;
  /** 基线来源文案 */
  baselineSource?: string;
  /** ★ 基线由旧「特征提取口径」生成（与 FLAVOR_FEATURE_VERSION 不符）——不阻断，但降置信 */
  baselineStale?: boolean;
  /** 参与总评的「已校准」维度权重占比（0~1），置信度展示用 */
  calibratedRatio?: number;
}

// ── 配置 ─────────────────────────────────────────────────────────────

export interface FlavorThresholds {
  clean: number;
  mild: number;
  suspicious: number;
  heavy: number;
}

export interface FlavorConfig {
  /** 总开关。关闭时 IPC 仍可用（只读检测），但 UI 入口隐藏 */
  enabled: boolean;
  /** 维度开关：关掉的维度不参与总评（score 记 0 且 skipped=true） */
  dimensions: Record<FlavorDimension, boolean>;
  /** 各维度在总评中的权重（不填用默认） */
  weights: Partial<Record<FlavorDimension, number>>;
  thresholds: FlavorThresholds;
  /** 最小样本量：低于此字符数不出总评（避免短文误判） */
  minChars: number;
  /** 是否把命中的原文片段回传给渲染层（大文本时可关以省传输） */
  includeExcerpts: boolean;
  /** 单章最多返回多少个命中片段（防止长文返回上万条压垮 UI） */
  maxHits: number;
  /**
   * v2 校准新增：置信度为 'low' 的维度是否仍计入总指数。
   * 默认 true（全部计入）；置 false 时低置信维度被排除（等价于旧「未校准不计」的保守档）。
   */
  strictCalibration?: boolean;
}

export const DEFAULT_FLAVOR_CONFIG: FlavorConfig = {
  enabled: true,
  dimensions: {
    'sentence-rhythm': true,
    'paragraph-rhythm': true,
    'lexical-diversity': true,
    'phrase-repetition': true,
    'opening-pattern': true,
    'template-connector': true,
    'marker-density': true,
    'punctuation-pattern': true,
    'dialog-ratio': true,
    'parallel-structure': true,
  },
  weights: {},
  thresholds: { clean: 25, mild: 40, suspicious: 55, heavy: 70 },
  minChars: 200,
  includeExcerpts: true,
  maxHits: 300,
  strictCalibration: true,
};

export function levelOf(score: number, t: FlavorThresholds): FlavorLevel {
  if (score < t.clean) return 'clean';
  if (score < t.mild) return 'mild';
  if (score < t.suspicious) return 'suspicious';
  if (score < t.heavy) return 'heavy';
  return 'severe';
}

/**
 * ★ 必须展示给用户的定位说明（不是可选的文案，是产品原则）。
 *
 * 依据朱雀调研的结论：朱雀是**二分类器**，输出「AI 生成概率%」且不解释原因，
 * 已被公开批评（央视）且在中文上误判有实证（老舍《林海》被判 99.9% AI）。
 *
 * 墨书做的是**可解释的写作体检**，不是「鉴 AI 判决」：
 *   - 报「第 3 段句长集中在 22–26 字」「逗号/句号比 4.2」这类可核对的事实，
 *     而不是「你有 87% 是 AI」这种无法反驳的结论；
 *   - **网文本身就套路化**（打脸、金手指、章末钩子），天然长得像统计平均，
 *     被误判的风险显著高于一般文体，这一点必须让用户知道。
 */
export const FLAVOR_DISCLAIMER =
  '本检测给出的是「写作体检」而非「AI 判决」。所有结论都基于可核对的统计事实' +
  '（句长分布、标点比例、词频、套话密度），不涉及模型打分，因此**不能据此断定' +
  '一篇稿子是否由 AI 生成**。网文本身就有大量套路化写法，指标偏高不等于作品有问题，' +
  '请结合具体命中片段自行判断。';

// ── 改写路径 ─────────────────────────────────────────────────────────

/**
 * 两条改写路径（用户可选）。
 * ★ 共同约束：**只做局部重写**，不允许整篇重写——
 *   整篇重写会丢掉作者的风格指纹，而风格正是这个工具要保护的东西。
 */
export type RewritePath =
  /** 一键自动改写：本地规则直接改写命中片段，不调 LLM，可离线 */
  | 'auto-rule'
  /** 交给主 Agent 重新生成：把片段与原因喂给 Agent，由它改写 */
  | 'agent';

export interface RewriteRequest {
  chapterId: string;
  path: RewritePath;
  /** 只改写这些维度的命中（不传 = 全部） */
  dimensions?: FlavorDimension[];
  /** 只改写这些段落（不传 = 全部） */
  paragraphNos?: number[];
  /** 改动前的 AI 味指数，用于前后对比留痕 */
  beforeIndex: number;
}

export interface RewriteOutcome {
  chapterId: string;
  path: RewritePath;
  /** 改了几个片段 */
  changedCount: number;
  /** 改动前的指数 */
  beforeIndex: number;
  /** 改动后的指数（真实重跑检测得到，不是估算） */
  afterIndex: number;
  /** 下降值（正数=改善）。局部改写也可能变差，故用带符号语义 */
  delta: number;
  /** 若走 agent 路径，关联的 runId */
  runId?: string;
  /** 面向用户的说明 */
  message: string;
}
