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
  // ── 手录字段（P2-B）：Agent 旧行缺省 → UI 空态，全部可选，不破坏既有登记载荷 ──
  // 为什么不用 refs 覆盖：这些是作者主观设定，原文里往往根本没有对应句子，
  // 强行让 Agent 从正文"推断"会编造证据；留给作者手录，UI 只显示真实有的。
  /** 人物当前目标（手录） */
  goals?: string;
  /** 性格概括（手录） */
  personality?: string;
  /** 语声/口吻特征，供对白一致性校验参考（手录） */
  voice?: string;
  /** 外貌描述（手录） */
  appearance?: string;
  /** 人物弧线：从哪走向哪（手录） */
  arc?: string;
  /** 已知情报清单（手录）；与 notKnows 配对做"穿帮"检查 */
  knows?: string[];
  /** 不应知道的信息（手录）：TA 说出这些即为穿帮 */
  notKnows?: string[];
  /** 人物关系：to 引用同项目内其它 CharacterProfile 的 id（手录） */
  relations?: { to: string; label: string; chapter?: number }[];
}

/**
 * 人物状态快照（P2-B，Task 5 的 repo/IPC 按此形状逐字复用）。
 * 每章写完后可为人物存一份状态；snapshot 为序列化后的状态文本，
 * 让"当时 TA 是什么处境"可回看，而不是被后续章节覆盖。
 */
export interface CharState {
  id: string;
  /** 归属人物（CharacterProfile.id） */
  characterId: string;
  projectId: string;
  /** 故事章号 */
  chapterNo: number;
  snapshot: string;
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
  // ── 手录字段（P2-B）：Agent 旧行缺省 → UI 空态，全部可选 ──
  // 为什么 weight 缺省按 B：债务曲线不能因为旧行没权重就炸账或虚增，
  // B 是中性档（ledger-metrics.WEIGHT_VALUE 取不到时同理兜底）。
  /** 伏笔名（手录；Agent 旧行只有 plantedQuote，无名可显示空态） */
  name?: string;
  /** 重要性分档（手录）：A 主线级 / B 普通 / C 点缀，参与债务加权 */
  weight?: 'A' | 'B' | 'C';
  /** 所属伏笔链（手录）：把多条伏笔串成一线，供链条视图分组 */
  chain?: string;
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

/**
 * 一次批量登记的载荷（§4 第 13 条）。
 *
 * ★ 四类都可省略：Agent 读到一条人物设定就想登记，不该被迫同时凑齐四类。
 *   但每一类一旦给了就必须整类合法——半批非法整批不写（见 LedgerRepo 事务注释）。
 */
export interface LedgerEntries {
  characters?: CharacterProfile[];
  numbers?: NumberAnchor[];
  timeline?: TimelineEvent[];
  foreshadows?: Foreshadow[];
}

/** 登记后各类的实际条数（整表计数，不是"本批写了几条"），用于回执与 UI 刷新 */
export interface LedgerCounts {
  characters: number;
  numbers: number;
  timeline: number;
  foreshadows: number;
}