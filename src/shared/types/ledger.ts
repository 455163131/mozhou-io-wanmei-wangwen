/**
 * 情节记忆类型（架构 §1.7）。
 * `refs` 字段是刻意保留的原型设计：每个属性都带原文出处，
 * 让 Agent 引用人物设定时能给出证据，而不是凭空断言（架构 §1.7 已确认项）。
 */

/** 原文引用：指向某章某处的一段引文 */
export interface SourceRef {
  chapterId: string;
  /** 章节内偏移（字符） */
  offset: number;
  /** 引文原文（短句，非整段） */
  quote: string;
}

export interface CharacterProfile {
  id: string;
  name: string;
  role: string;
  age: string;
  note: string;
  /** 每个属性都带出处 */
  refs: SourceRef[];
  updatedAt: number;
}

export interface NumberAnchor {
  id: string;
  /** 数字本身的字符串形态，保留「3.5万」这类写法 */
  value: string;
  /** 归一化后的数值，便于比较（3.5万 → 35000） */
  numeric: number;
  /** 计量单位（岁/元/斤/次…） */
  unit: string;
  /** 这个数字指什么（谁的年龄、哪笔账） */
  subject: string;
  refs: SourceRef[];
}

export interface TimelineEvent {
  id: string;
  /** 故事内时间，如「三年前」「第 7 天」 */
  when: string;
  what: string;
  refs: SourceRef[];
}

export interface Foreshadow {
  id: string;
  /** 埋设位置 */
  plantedAt: SourceRef;
  /** 埋设时的原文描述 */
  plantedQuote: string;
  /** 回收位置；null = 尚未回收 */
  resolvedAt: SourceRef | null;
  status: 'resolved' | 'suspected' | 'unresolved';
}

export type ConflictKind = 'character' | 'number' | 'timeline' | 'foreshadow';

/**
 * 冲突：两处原文并列，系统不裁决。
 * 这是「需作者裁决」而非「系统报错」——见 FIX_RULES 的 N2 why。
 */
export interface LedgerConflict {
  id: string;
  kind: ConflictKind;
  subject: string;
  /** 两个互相矛盾的陈述 */
  sides: Array<{ ref: SourceRef; claim: string; value: string }>;
  /** 系统为何判不出对错（面向用户解释） */
  whyUndecidable: string;
}

export interface LedgerQuery {
  kind: ConflictKind | 'all';
  /** 限定某人物/主题，可空 */
  subject?: string;
  limit?: number;
}