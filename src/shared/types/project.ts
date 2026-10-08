/**
 * 项目与章节元数据。
 * 正文不在类型里：正文走 chapter.get 按需拉取，永不「一次读全书」（架构 §1.9）。
 */
import type {
  CharacterProfile,
  Foreshadow,
  NumberAnchor,
  TimelineEvent,
} from './ledger';

export interface Project {
  id: string;
  name: string;
  /** 项目根目录的绝对路径（由主进程规范化，渲染层不可自由指定） */
  rootDir: string;
  createdAt: number;
  updatedAt: number;
  /** 目标字数（写作目标），Agent 评估进度时用 */
  targetWords: number;
}

export type ChapterStatus = 'todo' | 'draft' | 'revised' | 'done';

export interface ChapterMeta {
  /** 章节号，如 "37"；用字符串以支持 "10.5" 这类插章编号 */
  id: string;
  projectId: string;
  title: string;
  /** 所属卷 id；null= 未分卷 */
  volumeId: string | null;
  /** 卷内顺序 */
  order: number;
  status: ChapterStatus;
  /** 去空白后的字数，用于列表虚拟化时的「不需要正文就能显示」 */
  charCount: number;
  /** 乐观锁版本号；每次写入 +1，update 时必须匹配 expectedRev */
  rev: number;
  updatedAt: number;
}

export interface Chapter {
  meta: ChapterMeta;
  /** 正文全文（约 7.5KB/章） */
  body: string;
}

export interface Volume {
  id: string;
  projectId: string;
  title: string;
  order: number;
}

/** 风格指纹：按章计算分位数而非对拼接文本取均值（架构 §1.7） */
export interface MetricSpec {
  label: string;
  unit: string;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  dir: 'both' | 'low-bad' | 'high-bad';
}

export interface StyleProfile {
  projectId: string;
  /** 参与计算的分位数来源：必须标注，不能让用户误以为示例基线是自己的 */
  source: string;
  sampleChapters: number;
  metrics: Record<string, MetricSpec>;
  markerDensity: Record<string, { p50: number; p95: number }>;
  updatedAt: number;
}

/** 逐章指标缓存（500 章仅 0.25MB，可全量缓存；架构 §1.8） */
export interface ChapterMetrics {
  chapterId: string;
  chars: number;
  paras: number;
  sents: number;
  avgSent: number;
  sentCv: number;
  avgPara: number;
  sentsPerPara: number;
  ttr: number;
  bigramTtr: number;
  triRepeat: number;
  dialogRatio: number;
  score: number;
  computedAt: number;
}

/** 分批扫描的单批结果（全书 500 章按 20 章/批） */
export interface ScanBatch {
  range: { from: string; to: string };
  chapterIds: string[];
  avgScore: number;
  issues: Array<{
    chapterId: string;
    key: string;
    label: string;
    value: number;
    band: [number, number];
    level: 'warn' | 'risk';
  }>;
}

/** .mzproj 备份格式版本。读回时据此分派加载器（本地优先应用无法强制升级） */
export const PROJECT_BACKUP_FORMAT_VERSION = 1;

/**
 * L3 全量备份载荷（架构 §1.8）。
 *
 * ★ 必须含**正文**。修复前 `backup()` 的 payload 只有一个时间戳
 *   （`{ at: Date.now() }`），产出的 `.mzproj` 里没有任何章节内容 ——
 *   所谓「三层备份」实为零层，用户没有任何可恢复的稿件副本。
 *
 * 关于 §1.9「永不一次读全书」：那条约束针对的是编辑器与 Agent 每步的热路径。
 * 全量备份是**显式的冷路径**，且只在三个低频时机触发（手动保存 / 退出 / 空闲 30 分钟），
 * 是这条约束的正当例外。
 */
export interface ProjectBackup {
  formatVersion: typeof PROJECT_BACKUP_FORMAT_VERSION;
  /** 备份生成时刻 */
  createdAt: number;
  /** 触发时机，便于用户判断该信哪一份 */
  trigger: string;
  project: Project;
  volumes: Volume[];
  /** 章节元数据 + 正文。这是备份的主体，缺了它备份就没有意义 */
  chapters: Array<{ meta: ChapterMeta; body: string }>;
  /**
   * 设定账本。当前实现是内存态（见 docs/REMAINING.md §1.4），
   * 一并落进备份，至少保证「重启不丢」这条底线。
   */
  ledger: {
    characters: CharacterProfile[];
    numbers: NumberAnchor[];
    timeline: TimelineEvent[];
    foreshadows: Foreshadow[];
  };
  /**
   * 风格档（用户自建基线）。形状与 `StyleProfileRepo.get()` 的返回一致，
   * 为 null 表示尚未构建过——恢复时据此决定是否提示用户重建基线。
   */
  style: {
    source: string;
    sampleChapters: number;
    metrics: Record<string, unknown>;
    markerDensity: Record<string, unknown>;
  } | null;
  /** 读回时自检用：章数与去空白总字数对不上就说明备份不完整 */
  integrity: {
    chapterCount: number;
    totalChars: number;
  };
}