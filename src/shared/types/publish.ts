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
