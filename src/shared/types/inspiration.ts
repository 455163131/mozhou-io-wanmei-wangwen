/**
 * P2-C 灵感线子系统的共享类型（T1 数据层）。
 *
 * ★ 为什么放 shared：灵感卡片/选题/拆书报告既是主进程三 Repo 的落库形状，
 *   也是 T2+ IPC 契约与渲染层四页（扫榜/抽脑洞/拆书/选题库）的展示形状——
 *   契约只有一份，两侧永不各持手抄（口径同 pipeline.ts）。
 *
 * ★ 为什么带 zod：三类卡片的 payload 部分来自抓取/LLM 产出，字段缺失是常态；
 *   入库前先过 schema，坏数据在门口拦下。库列本身不加 CHECK——口径同 v14，
 *   收紧留给应用写侧。
 *
 * ★ 全局子系统：卡片在书籍立项**之前**就存在，因此不带 project_id；
 *   只有 topics 在立项（已立项）后才通过 linkProject 获得可空的项目关联。
 */
import { z } from 'zod';

/* ── 扫榜热榜（T2）──────────────────────────────────────────────── */

/** 榜单平台（三站点直抓；zod 边界校验用 z.enum 同集合，见 inspiration-ipc.ts） */
export type Platform = '番茄' | '晋江' | '起点';

/**
 * 榜单条目。
 * ★ heat 只在页面**确有可信热度数字**时才填（如番茄「在读：27.7万」），
 *   否则一律 null——DRD §7 拒绝无依据的热度数字，宁缺毋假。
 * ★ live 区分实时抓取（true）与演示兜底（false），UI 据此打「演示数据」徽标。
 * ★ cardId（P2-C T3/R9）：parse/demo 产出不填；trending:fetch 幂等落库
 *   kind='trend' 卡后回填——UI 收藏/套用直接拿它走 inspiration:collect /
 *   topic:create-from-card。可选字段，旧调用方向后兼容。
 */
export interface ChartEntry {
  rank: number;
  title: string;
  author: string;
  platform: Platform;
  heat: number | null;
  tags: string[];
  url: string;
  live: boolean;
  cardId?: string;
}

/**
 * 榜单抓取结果。回落演示集时 source='demo' 且 error 带**真因**
 * （robots 禁止 / 非 200 / 解析失败 / 网络错），绝不静默换数据。
 */
export interface ChartFetchResult {
  entries: ChartEntry[];
  source: 'live' | 'demo';
  error?: string;
}

/* ── 卡片 ──────────────────────────────────────────────────────── */

/** 卡片种类：扫榜热榜 / 抽脑洞 / 拆书报告 */
export type CardKind = 'trend' | 'idea' | 'teardown';

/** 扫榜卡片 payload（T2 抓取产出；live=false 为演示兜底数据） */
export const TrendPayloadSchema = z.object({
  platform: z.string(),
  author: z.string().optional(),
  heat: z.number().optional(),
  rank: z.number().optional(),
  tags: z.array(z.string()).optional(),
  url: z.string().optional(),
  live: z.boolean(),
  /** P2-C T3/R9：幂等去重键 `platform|url`（url 空 → `platform|title|author`）；旧卡可无 */
  sourceKey: z.string().optional(),
});
export type TrendPayload = z.infer<typeof TrendPayloadSchema>;

/** 脑洞卡片 payload（T4 抽脑洞产出；temperature 为采样温度记录） */
export const IdeaPayloadSchema = z.object({
  direction: z.string(),
  premise: z.string(),
  hook: z.string().optional(),
  genre: z.string().optional(),
  temperature: z.number(),
  live: z.boolean(),
});
export type IdeaPayload = z.infer<typeof IdeaPayloadSchema>;

/**
 * 脑洞 LLM 产出契约（T4）：direction/premise 必有，hook/genre 可选。
 * 入库前过 IdeaSchema.safeParse，坏产出在门口拦下→演示兜底（绝不把垃圾当 live）。
 * 与 IdeaPayload 的区别：payload 是落库形状（带 temperature/live 记录），
 * IdeaOut 是模型该吐的纯内容形状（不含程序侧记账字段）。
 */
export const IdeaSchema = z.object({
  direction: z.string(),
  premise: z.string(),
  hook: z.string().optional(),
  genre: z.string().optional(),
});
export type IdeaOut = z.infer<typeof IdeaSchema>;

/** 拆书卡片 payload（T5 拆书报告的摘要卡；reportId 指向 teardown_reports） */
export const TeardownPayloadSchema = z.object({
  dimension: z.string(),
  summary: z.string(),
  bookTitle: z.string(),
  reportId: z.string(),
});
export type TeardownPayload = z.infer<typeof TeardownPayloadSchema>;

/** 卡片 payload：按 kind 判别（落库存 JSON TEXT，读出为已解析对象） */
export type CardPayload = TrendPayload | IdeaPayload | TeardownPayload;

export interface InspirationCard {
  id: string;
  kind: CardKind;
  title: string;
  payload: CardPayload;
  /** 来源标签（平台名/方向名/书名），列表页直接展示 */
  sourceLabel: string;
  /** 是否已收藏进选题池（0/1，与库列同口径） */
  collected: number;
  createdAt: number;
}

/* ── 选题 ──────────────────────────────────────────────────────── */

/** 选题生命周期：单向 待立项 → 已立项 | 已放弃（终态不可再转） */
export type TopicStatus = '待立项' | '已立项' | '已放弃';

export interface Topic {
  id: string;
  title: string;
  /** 一句话前提（PD-1：立项时带入 projects.premise 的种子） */
  premise: string;
  status: TopicStatus;
  /** 立项后关联的项目 id；未立项为 null——全局子系统唯一的项目挂钩点 */
  projectId: string | null;
  /** 来源卡片 id（从卡片收藏转化而来时记录）；可空 */
  sourceCardId: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ── 拆书报告 ──────────────────────────────────────────────────── */

/** 拆书八维（T5 产出；全 string，缺维在写侧拦） */
export const TeardownDimsSchema = z.object({
  定位: z.string(),
  结构: z.string(),
  节奏: z.string(),
  爽点钩子: z.string(),
  伏笔: z.string(),
  人物: z.string(),
  文风: z.string(),
  可借鉴: z.string(),
});
export type TeardownDims = z.infer<typeof TeardownDimsSchema>;

export interface TeardownReport {
  id: string;
  bookTitle: string;
  /** 结构分析原始产出（JSON，形状由 T5 定，数据层不钉死） */
  structure: unknown;
  /** 八维提炼；insert 时为 null，setDimensions 后回填 */
  dimensions: TeardownDims | null;
  createdAt: number;
}
