/**
 * 发布线共享契约（P2-D T1）。
 *
 * 契约单份（口径同 pipeline.ts/inspiration.ts）：PublishPlan 存
 * 「哪本书按什么节奏发往哪个平台」，platform 存 PlatformRule.id
 * （小写英文）不存展示名；StagingRow 存「哪章以哪份内容进过暂存」，
 * 状态机口径见 StagingRepo。排期队列不存——纯函数推导（spec §2）。
 */
import type { ChapterStatus } from './project';

export type Cadence = 'daily' | 'every2' | 'weekly' | 'custom';
export type PlanStatus = 'active' | 'paused' | 'archived';

export interface PublishPlan {
  id: string; projectId: string;
  /** PlatformRule.id（小写英文，如 'webnovel'）——存 id 不存展示名 */
  platform: string;
  cadence: Cadence; intervalDays: number;
  /** 当日本地正午 ms（P2D-R5） */
  startAt: number;
  status: PlanStatus; createdAt: number; updatedAt: number;
}
export type PublishPlanInput = Omit<PublishPlan, 'id' | 'status' | 'createdAt' | 'updatedAt'> &
  { id?: string; status?: undefined };

export interface PublishQueueItem {
  chapterId: string; ord: number; title: string; status: ChapterStatus;
  plannedAt: number | null;
  size: number; sizeUnit: '字' | 'words';
  minSize: number; meetsSize: boolean;
}
export interface CleanEdit { rule: string; at: number; before: string; after: string }
export interface CleanResult { cleaned: string; edits: CleanEdit[] }
export interface StagedEntry { chapterId: string; path: string; contentHash: string; edits: number }
export interface SkippedEntry { chapterId: string; reason: string }
export interface StageOutcome { staged: StagedEntry[]; skipped: SkippedEntry[] }
export interface StagingRow { id: string; planId: string; chapterId: string; contentHash: string; stagedAt: number; publishedAt: number | null }

/**
 * publish:plan-save req（P2-D T6）。**projectId 不在 req 里**——服务端取当前项目，
 * 越权他书 by construction 不可能（P2D anchor）；带 id 编辑同样过归属校验。
 * intervalDays 仅 cadence='custom' 时有意义，其余节奏由 repo 按 CADENCE_DAYS 派生。
 */
export interface PublishPlanSaveReq {
  id?: string;
  platform: string;
  cadence: Cadence;
  intervalDays?: number;
  /** 当日本地正午 ms（P2D-R5：UI 侧 date input × 正午换算，纯加法排期不吃 DST） */
  startAt: number;
}

/**
 * publish:queue 的暂存账本投影（T7 BLOCK 裁决）：只映射 chapterId+publishedAt 两字段——
 * 渲染层的 待排/暂存/已发布 chip 以此为真源（重载如实恢复，杀会话快照的「未暂存」假阳性），
 * 行 id/hash/暂存时刻等账本细节不外泄。
 */
export interface PublishStagedMark {
  chapterId: string;
  publishedAt: number | null;
}

/** publish:queue res（P2-D T6；T7 携带修复加 staged 真源）——队列**服务端推导**（P2D-R1：渲染层拿不到正文就不许装算得出体量）。 */
export interface PublishQueueRes {
  plan: PublishPlan;
  items: PublishQueueItem[];
  warnings: string[];
  /** staging.listByPlan 的两字段投影，按暂存先后 */
  staged: PublishStagedMark[];
}
