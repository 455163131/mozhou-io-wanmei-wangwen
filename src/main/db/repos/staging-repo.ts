/**
 * 发布暂存 repo（P2-D T1）。
 *
 * publish_staging 记「哪章以哪份内容进过暂存」，状态机三态：
 * 未暂存 → 已暂存(publishedAt=null) → 已发布(publishedAt=now)。
 * 已暂存未发布可反复换稿（换 hash 不换 id）；已发布不许悄悄换稿
 * （E_STAGING_STATE）；mark 幂等（重复调用回原 publishedAt）。
 * UNIQUE(plan_id, chapter_id) 保证一章在一计划里只有一条暂存事实。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
import type { StagingRow } from '@shared/types/publish';

interface StagingRowRow {
  id: string;
  plan_id: string;
  chapter_id: string;
  content_hash: string;
  staged_at: number;
  published_at: number | null;
}

function toStagingRow(r: StagingRowRow): StagingRow {
  return {
    id: r.id,
    planId: r.plan_id,
    chapterId: r.chapter_id,
    contentHash: r.content_hash,
    stagedAt: r.staged_at,
    publishedAt: r.published_at,
  };
}

export class StagingRepo {
  constructor(private readonly db: Database) {}

  get(planId: string, chapterId: string): StagingRow | null {
    const r = this.db
      .prepare('SELECT * FROM publish_staging WHERE plan_id = ? AND chapter_id = ?')
      .get(planId, chapterId) as StagingRowRow | undefined;
    return r ? toStagingRow(r) : null;
  }

  /** 新行 publishedAt=null；未发布可换稿（回原 id）；已发布拒改——换稿须新章新暂存 */
  upsertStaged(planId: string, chapterId: string, contentHash: string): StagingRow {
    const cur = this.get(planId, chapterId);
    if (cur && cur.publishedAt !== null) {
      throw new MzError('E_STAGING_STATE', `已发布章不许悄悄换稿：plan ${planId} 章 ${chapterId}`);
    }
    const now = Date.now();
    if (cur) {
      this.db
        .prepare('UPDATE publish_staging SET content_hash = ?, staged_at = ? WHERE id = ?')
        .run(contentHash, now, cur.id);
      return { ...cur, contentHash, stagedAt: now };
    }
    const id = `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO publish_staging(id, plan_id, chapter_id, content_hash, staged_at, published_at)
         VALUES(?,?,?,?,?,NULL)`,
      )
      .run(id, planId, chapterId, contentHash, now);
    return { id, planId, chapterId, contentHash, stagedAt: now, publishedAt: null };
  }

  /** 只从 null→now；未暂存抛 E_STAGING_STATE；已标幂等回原值（重试不打乱发布时刻） */
  markPublished(planId: string, chapterId: string): StagingRow {
    const cur = this.get(planId, chapterId);
    if (!cur) {
      throw new MzError('E_STAGING_STATE', `未暂存的章无所谓发布：plan ${planId} 章 ${chapterId}`);
    }
    if (cur.publishedAt !== null) return cur;
    const now = Date.now();
    this.db.prepare('UPDATE publish_staging SET published_at = ? WHERE id = ?').run(now, cur.id);
    return { ...cur, publishedAt: now };
  }

  /** 计划下的暂存行，按暂存先后（rowid 兜同毫秒次序） */
  listByPlan(planId: string): StagingRow[] {
    const rows = this.db
      .prepare('SELECT * FROM publish_staging WHERE plan_id = ? ORDER BY staged_at ASC, rowid ASC')
      .all(planId) as StagingRowRow[];
    return rows.map(toStagingRow);
  }
}
