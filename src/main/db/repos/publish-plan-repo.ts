/**
 * 排期计划 repo（P2-D T1）。
 *
 * publish_plans 记「哪本书按什么节奏发往哪个平台」。platform 存
 * PlatformRule.id（写侧过 PLATFORM_RULES 白名单，坏值不落库）；
 * cadence 非 custom 时 intervalDays 由 CADENCE_DAYS 派生（一处来源，
 * 常量单源见 @shared/publish/schedule.ts——P2D-T4 收编搬家）。
 * 生命周期：active↔paused 可来回，active|paused→archived 单向，
 * archived 是终态（口径同 topic-repo 的终态不可再转）。裸 SQL + 薄封装。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
import { PLATFORM_RULES } from '@shared/constants/platforms';
import { CADENCE_DAYS } from '@shared/publish/schedule';
import type { Cadence, PlanStatus, PublishPlan, PublishPlanInput } from '@shared/types/publish';

interface PublishPlanRowRow {
  id: string;
  project_id: string;
  platform: string;
  cadence: string;
  interval_days: number;
  start_at: number;
  status: string;
  created_at: number;
  updated_at: number;
}

function toPublishPlan(r: PublishPlanRowRow): PublishPlan {
  return {
    id: r.id,
    projectId: r.project_id,
    platform: r.platform,
    cadence: r.cadence as Cadence,
    intervalDays: r.interval_days,
    startAt: r.start_at,
    status: r.status as PlanStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class PublishPlanRepo {
  constructor(private readonly db: Database) {}

  /** 有 id → UPDATE（不存在抛 E_NOT_FOUND，动 updated_at）；无 id → INSERT（status='active'） */
  upsert(p: PublishPlanInput): PublishPlan {
    if (!PLATFORM_RULES.some((r) => r.id === p.platform)) {
      throw new MzError('E_INVALID_ARGS', `E_INVALID_ARGS: 平台 '${p.platform}' 不在 PLATFORM_RULES 白名单`);
    }
    // 非 custom 节奏由 CADENCE_DAYS 派生 intervalDays，一处来源不允许调用方各算各的
    let intervalDays = p.intervalDays;
    if (p.cadence !== 'custom') {
      intervalDays = CADENCE_DAYS[p.cadence];
    } else if (!Number.isInteger(intervalDays) || intervalDays < 1) {
      throw new MzError('E_INVALID_ARGS', `E_INVALID_ARGS: custom 节奏的 intervalDays 必须为 ≥1 的整数，收到 ${p.intervalDays}`);
    }
    const now = Date.now();
    if (p.id) {
      const cur = this.get(p.id);
      if (!cur) throw new MzError('E_NOT_FOUND', `排期计划不存在：${p.id}`);
      this.db
        .prepare(
          `UPDATE publish_plans
           SET project_id = ?, platform = ?, cadence = ?, interval_days = ?, start_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(p.projectId, p.platform, p.cadence, intervalDays, p.startAt, now, p.id);
      return { ...cur, projectId: p.projectId, platform: p.platform, cadence: p.cadence, intervalDays, startAt: p.startAt, updatedAt: now };
    }
    const id = `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO publish_plans(id, project_id, platform, cadence, interval_days, start_at, status, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, p.projectId, p.platform, p.cadence, intervalDays, p.startAt, 'active', now, now);
    return {
      id,
      projectId: p.projectId,
      platform: p.platform,
      cadence: p.cadence,
      intervalDays,
      startAt: p.startAt,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string): PublishPlan | null {
    const r = this.db.prepare('SELECT * FROM publish_plans WHERE id = ?').get(id) as PublishPlanRowRow | undefined;
    return r ? toPublishPlan(r) : null;
  }

  /** 缺省滤掉 archived（终态不进日常视图）；includeArchived=true 时全量 */
  listByProject(projectId: string, includeArchived = false): PublishPlan[] {
    const rows = includeArchived
      ? (this.db
          .prepare('SELECT * FROM publish_plans WHERE project_id = ? ORDER BY created_at DESC')
          .all(projectId) as PublishPlanRowRow[])
      : (this.db
          .prepare("SELECT * FROM publish_plans WHERE project_id = ? AND status != 'archived' ORDER BY created_at DESC")
          .all(projectId) as PublishPlanRowRow[]);
    return rows.map(toPublishPlan);
  }

  /**
   * 状态流转：active↔paused 允许，active|paused→archived 允许；
   * archived 是终态，回退或改判一律 E_PLAN_STATE（归档是人的终局决定，
   * 回退会让排期历史不可审计）。
   */
  setStatus(id: string, to: PlanStatus): PublishPlan {
    const cur = this.get(id);
    if (!cur) throw new MzError('E_NOT_FOUND', `排期计划不存在：${id}`);
    if (cur.status === 'archived') {
      throw new MzError('E_PLAN_STATE', `不允许的状态流转：${cur.status} → ${to}（archived 是终态）`);
    }
    const now = Date.now();
    this.db.prepare('UPDATE publish_plans SET status = ?, updated_at = ? WHERE id = ?').run(to, now, id);
    return { ...cur, status: to, updatedAt: now };
  }
}
