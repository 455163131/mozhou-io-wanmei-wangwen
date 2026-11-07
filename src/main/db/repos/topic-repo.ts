/**
 * 选题 repo（P2-C T1）。
 *
 * 选题库是灵感线的收口：卡片收藏 → 选题 → 立项（关联 project）。
 * **全局子系统**：topics 不带项目隔离，唯一的项目挂钩点是可空的
 * project_id（立项时由 linkProject 回填）。生命周期单向：
 * 待立项 → 已立项 | 已放弃，终态不可再转（口径同 draft-repo 的
 * pending → adopted | discarded）。裸 SQL + 薄封装，不用 ORM。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
import type { Topic, TopicStatus } from '@shared/types/inspiration';

interface TopicRow {
  id: string;
  title: string;
  premise: string;
  status: string;
  project_id: string | null;
  source_card_id: string | null;
  created_at: number;
  updated_at: number;
}

function toTopic(r: TopicRow): Topic {
  return {
    id: r.id,
    title: r.title,
    premise: r.premise,
    status: r.status as TopicStatus,
    projectId: r.project_id,
    sourceCardId: r.source_card_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class TopicRepo {
  constructor(private readonly db: Database) {}

  /** 新选题默认「待立项」；id 由库侧生成，调用方不传主键 */
  insert(t: { title: string; premise: string; sourceCardId?: string | null }): Topic {
    const id = `tp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO topics(id, title, premise, status, project_id, source_card_id, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(id, t.title, t.premise, '待立项', null, t.sourceCardId ?? null, now, now);
    return {
      id,
      title: t.title,
      premise: t.premise,
      status: '待立项',
      projectId: null,
      sourceCardId: t.sourceCardId ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 选题列表，可按状态过滤；新在前（rowid 兜同毫秒写入的次序） */
  listByStatus(s?: TopicStatus): Topic[] {
    const rows = s
      ? (this.db
          .prepare('SELECT * FROM topics WHERE status = ? ORDER BY created_at DESC, rowid DESC')
          .all(s) as TopicRow[])
      : (this.db.prepare('SELECT * FROM topics ORDER BY created_at DESC, rowid DESC').all() as TopicRow[]);
    return rows.map(toTopic);
  }

  get(id: string): Topic | null {
    const r = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined;
    return r ? toTopic(r) : null;
  }

  /**
   * 状态流转**只允许单向** 待立项 → 已立项 | 已放弃（模板：draft-repo.setStatus）。
   * 立项/放弃都是人的终局决定，回退或改判会让选题库的生命周期不可审计；
   * 其余流转（含终态互转、对已终态选题重复设置）一律抛 E_TOPIC_STATE。
   */
  setStatus(id: string, status: TopicStatus): Topic {
    const cur = this.get(id);
    if (!cur) throw new MzError('E_TOPIC_STATE', `选题不存在：${id}`);
    if (cur.status !== '待立项' || status === '待立项') {
      throw new MzError('E_TOPIC_STATE', `不允许的状态流转：${cur.status} → ${status}`);
    }
    const now = Date.now();
    this.db.prepare('UPDATE topics SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    return { ...cur, status, updatedAt: now };
  }

  /** 立项后回填项目关联（全局子系统唯一的项目挂钩点）；选题不存在抛 E_NOT_FOUND */
  linkProject(id: string, projectId: string): Topic {
    const cur = this.get(id);
    if (!cur) throw new MzError('E_NOT_FOUND', `选题不存在：${id}`);
    this.db.prepare('UPDATE topics SET project_id = ? WHERE id = ?').run(projectId, id);
    return { ...cur, projectId };
  }
}
