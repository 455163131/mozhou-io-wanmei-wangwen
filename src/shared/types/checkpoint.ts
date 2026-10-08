/**
 * Checkpoint 类型（架构 §1.4.4）。
 * 这是老板决策「允许自动改 + 可回滚」的**唯一防线**——preview 已降级为旁路。
 */
import type { Edit, Patch } from './tool';

export interface CheckpointConfig {
  /** 默认 50 步 */
  maxDepth: number;
  /** 默认 64MB（50×7.5KB=375KB，留足余量给跨章工具） */
  maxTotalBytes: number;
  /** 单项目栈上限，超出后 LRU 淘汰最老的 */
  perProjectCap: number;
  /** 默认 lru */
  strategy: 'lru' | 'fifo';
}

/** 存储位置：内存 or 磁盘存档。LRU 淘汰不删除，只转存磁盘（架构 §1.4.4③） */
export type CheckpointTier = 'memory' | 'archive';

export interface Checkpoint {
  id: string;
  runId: string;
  /** 与轨迹面板步骤一一对应：轨迹第 N 步 ↔ checkpoint N */
  stepNo: number;
  toolName: string;
  at: number;
  /** 单章快照（不存全量——差 500 倍，架构 §1.4.4①） */
  patches: Patch[];
  /** 涉及的全部章节，便于回滚时确定范围 */
  affectedChapters: string[];
  bytes: number;
  /** 每次进栈时 +1，即「回到这一步之前」= undoTo(checkpoint of seq） */
  seq: number;
  tier: CheckpointTier;
  /** tier==='archive' 时记录磁盘文件名 */
  archiveFile?: string;
  /** 已被撤销标记（不删除，因为用户可能想再滚回来） */
  rolledBackAt: number | null;
  /** 编辑摘要，用于改动历史视图的单行展示 */
  editsCount: number;
}

/** 回滚结果。必须告知用户「丢了多少手动修改」——这是 E_ROLLBACK_CONFLICT 的核心 */
export interface RollbackResult {
  checkpointId: string;
  /** 撤销了几步 */
  undone: number;
  fromSeq: number;
  toSeq: number;
  /** 被覆盖的手动修改数（>0 时必须先弹确认，见架构 §6.1 第 14 条） */
  lostManualEdits: number;
  /** 被覆盖的手动修改明细，供确认框展示 */
  lostEdits: Array<{ chapterId: string; at: number; snippet: string }>;
  restoredChapters: string[];
}

/** 局部回滚：只撤一条规则的改动，保留其它有效改动 */
export interface SideEffectRollback {
  chapterId: string;
  ruleId: string;
  /** 被撤销的编辑（从正文中移除） */
  removedEdits: Edit[];
  restoredText: string;
}