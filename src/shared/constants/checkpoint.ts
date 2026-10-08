import type { CheckpointConfig } from '../types/checkpoint';
import type { WritePolicyConfig } from '../types/tool';
import { ToolDanger } from '../types/tool';

/**
 * Checkpoint 默认配置（架构 §1.4.4③）。
 *
 * 容量核算（架构 §1.4.4①）：
 *   单章 2500 字 ≈ 7.5KB UTF-8。深度 50 × 7.5KB = 375KB内存，可行；
 *   500 章全量 3.75MB × 50 = 187MB，不可行。**故只存单章。**
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  maxDepth: 50,
  maxTotalBytes: 64 * 1024 * 1024,
  perProjectCap: 50,
  strategy: 'lru',
};

/** L2 磁盘存档保留天数（架构 §1.8） */
export const ARCHIVE_RETENTION_DAYS = 30;

/**
 * 写策略默认配置（老板决策 ①：默认 auto-with-undo）。
 *
 * hardStopThreshold=Irreversible 意味着 export 写项目外（★4）永不自动执行。
 */
export const DEFAULT_WRITE_POLICY: WritePolicyConfig = {
  policy: 'auto-with-undo',
  autoApproveThreshold: ToolDanger.Spillover,
  hardStopThreshold: ToolDanger.Irreversible,
};

/** checkpoint 存档子目录（相对项目根） */
export const CHECKPOINT_ARCHIVE_DIR = 'checkpoints/archive';

/** 三层备份目录（架构 §1.8） */
export const BACKUP_DIR = 'backups';
export const BACKUP_KEEP_COUNT = 5;

/** L3 项目级备份时机：仅这三个时机做全量，绝不为每步存全量 */
export const BACKUP_TRIGGERS = ['app-exit', 'idle-30min', 'manual-save'] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

/** 空闲多久算「空闲」（无编辑 + 无 run） */
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/** L3 备份间隔 */
export const IDLE_BACKUP_INTERVAL_MS = 30 * 60 * 1000;

/** 项目文件扩展名 */
export const PROJECT_EXT = '.mzproj';

/** 原始稿件存放子目录 */
export const CHAPTERS_DIR = 'chapters';