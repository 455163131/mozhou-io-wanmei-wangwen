import type { Grade, SideEffect } from './tool';
import type { MetricSpec } from './project';

/** 体检结果：单章全量指标 + 判定 + 定位信息 */
export interface ChapterAnalysis {
  chapterId: string;
  chars: number;
  paras: number;
  sents: number;
  raw: Record<string, number>;
  /** 每千字标记密度 */
  per1000: Record<string, number>;
  markerHits: Record<string, number>;
  /** 章首起笔类型 */
  openType: string;
  score: number;
  issues: AnalysisIssue[];
  /** 样本是否足够。低于门槛时 score/issues 无意义（对应审查发现的「空文档 2 分」问题） */
  sufficient: boolean;
}

export interface AnalysisIssue {
  key: string;
  label: string;
  value: number;
  unit: string;
  band: [number, number];
  level: Grade;
  /** 相对偏离度，供 UI 显示「超基线 71%」这类可读结论 */
  deviation: number;
}

/** 指标定位结果：告诉 Agent「问题在第几章第几个字」 */
export interface IssueLocation {
  chapterId: string;
  /** 在该章正文中的字符偏移 */
  at: number;
  /** 可直接替换的短引文 */
  quote: string;
  note: string;
}

/** 规则元信息：让 Agent 自己读规则表，而不是把规则硬编码进提示词 */
export interface RuleInfo {
  id: string;
  label: string;
  layer: string;
  targets: string[];
  auto: boolean;
  /** auto:false 时必填：为什么不提供自动改法。这段 why 会进系统提示作为负面知识 */
  why?: string;
}

/** 体侧面��汇总 */
export interface HealthReport {
  projectId: string;
  /** 风格指纹来源说明：必须展示，避免用户误以为示例基线是自己的 */
  baselineSource: string;
  sampleChapters: number;
  chapters: ChapterAnalysis[];
  /** 全书分布：key -> 分位数，供绘制分布图 */
  distribution: Record<string, Record<string, number>>;
  /** 全书共性问题：哪些指标命中率最高 */
  commonIssues: Array<{ key: string; label: string; hitChapters: number; ratio: number }>;
  avgScore: number;
}

export type { Grade, MetricSpec, SideEffect };