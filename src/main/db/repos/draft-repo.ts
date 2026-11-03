/**
 * 草稿隔离区 repo（P0 生成流水线 T1）。
 *
 * AI 产出**一律先落 drafts 表**，人工采纳（adopted）才进正稿——
 * 定稿主权在作者手里，流水线永远不直接写 chapters/chapter_bodies。
 * 裸 SQL + 薄封装，与 chapter-repo 同风格，不用 ORM。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';

/** role ∈ 'concept'|'architect'|'writer'；kind ∈ 'concept'|'outline'|'chapter' */
export type Draft = {
  id: string;
  projectId: string;
  chapterId: string | null;
  role: string;
  kind: string;
  content: string;
  status: 'pending' | 'adopted' | 'discarded';
  createdAt: number;
};

interface DraftRow {
  id: string;
  project_id: string;
  chapter_id: string | null;
  role: string;
  kind: string;
  content: string;
  status: string;
  created_at: number;
}

function toDraft(r: DraftRow): Draft {
  return {
    id: r.id,
    projectId: r.project_id,
    chapterId: r.chapter_id,
    role: r.role,
    kind: r.kind,
    content: r.content,
    status: r.status as Draft['status'],
    createdAt: r.created_at,
  };
}

export class DraftRepo {
  constructor(private readonly db: Database) {}

  /** 新草稿默认 pending；id 由库侧生成，调用方不传主键 */
  insert(d: { projectId: string; role: string; kind: string; content: string; chapterId?: string | null }): Draft {
    const id = `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO drafts(id, project_id, chapter_id, role, kind, content, status, created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(id, d.projectId, d.chapterId ?? null, d.role, d.kind, d.content, 'pending', now);
    return {
      id,
      projectId: d.projectId,
      chapterId: d.chapterId ?? null,
      role: d.role,
      kind: d.kind,
      content: d.content,
      status: 'pending',
      createdAt: now,
    };
  }

  /** 项目内草稿列表，可按状态过滤；新稿在前 */
  list(projectId: string, status?: Draft['status']): Draft[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM drafts WHERE project_id = ? AND status = ? ORDER BY created_at DESC, id DESC')
          .all(projectId, status) as DraftRow[])
      : (this.db
          .prepare('SELECT * FROM drafts WHERE project_id = ? ORDER BY created_at DESC, id DESC')
          .all(projectId) as DraftRow[]);
    return rows.map(toDraft);
  }

  get(id: string): Draft | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
    return r ? toDraft(r) : null;
  }

  /**
   * 状态流转**只允许单向** pending → adopted | discarded。
   * 采纳/弃稿都是人的终局决定，回退或改判会让「哪些稿子进过正稿」变得不可审计；
   * 其余转移（含 adopted→discarded、discarded→adopted、对已终态稿重复设置）一律抛 E_DRAFT_STATE。
   */
  setStatus(id: string, status: 'pending' | 'adopted' | 'discarded'): Draft {
    const cur = this.get(id);
    if (!cur) throw new MzError('E_DRAFT_STATE', `草稿不存在：${id}`);
    if (cur.status !== 'pending' || status === 'pending') {
      throw new MzError('E_DRAFT_STATE', `不允许的状态流转：${cur.status} → ${status}`);
    }
    this.db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(status, id);
    return { ...cur, status };
  }

  /** 某章挂着的草稿（按章审阅用） */
  byChapter(projectId: string, chapterId: string): Draft[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM drafts WHERE project_id = ? AND chapter_id = ? ORDER BY created_at DESC, id DESC',
      )
      .all(projectId, chapterId) as DraftRow[];
    return rows.map(toDraft);
  }
}
