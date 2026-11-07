/**
 * 拆书报告 repo（P2-C T1）。
 *
 * 拆书是**零 token 复用**链路（T5）：structure 存原始结构分析（JSON，
 * 形状由 T5 定，数据层不钉死故为 unknown），dimensions 存八维提炼
 * （insert 时 null，提炼完成后 setDimensions 回填）。全局子系统，
 * 不带 project_id。裸 SQL + 薄封装，与 draft-repo 同风格。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
import type { TeardownDims, TeardownReport } from '@shared/types/inspiration';

interface TeardownRow {
  id: string;
  book_title: string;
  structure_json: string;
  dimensions_json: string | null;
  created_at: number;
}

function toReport(r: TeardownRow): TeardownReport {
  return {
    id: r.id,
    bookTitle: r.book_title,
    structure: JSON.parse(r.structure_json) as unknown,
    dimensions: r.dimensions_json ? (JSON.parse(r.dimensions_json) as TeardownDims) : null,
    createdAt: r.created_at,
  };
}

export class TeardownRepo {
  constructor(private readonly db: Database) {}

  /** 新报告 dimensions 初始 null（八维提炼是后置步骤）；id 由库侧生成 */
  insert(r: { bookTitle: string; structure: unknown }): TeardownReport {
    const id = `td-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO teardown_reports(id, book_title, structure_json, dimensions_json, created_at)
         VALUES(?,?,?,?,?)`,
      )
      .run(id, r.bookTitle, JSON.stringify(r.structure ?? null), null, now);
    return {
      id,
      bookTitle: r.bookTitle,
      structure: r.structure,
      dimensions: null,
      createdAt: now,
    };
  }

  get(id: string): TeardownReport | null {
    const r = this.db.prepare('SELECT * FROM teardown_reports WHERE id = ?').get(id) as TeardownRow | undefined;
    return r ? toReport(r) : null;
  }

  /** 全部报告；新在前（rowid 兜同毫秒写入的次序） */
  list(): TeardownReport[] {
    const rows = this.db
      .prepare('SELECT * FROM teardown_reports ORDER BY created_at DESC, rowid DESC')
      .all() as TeardownRow[];
    return rows.map(toReport);
  }

  /** 回填八维提炼；报告不存在抛 E_NOT_FOUND */
  setDimensions(id: string, dims: TeardownDims): TeardownReport {
    const cur = this.get(id);
    if (!cur) throw new MzError('E_NOT_FOUND', `拆书报告不存在：${id}`);
    this.db.prepare('UPDATE teardown_reports SET dimensions_json = ? WHERE id = ?').run(JSON.stringify(dims), id);
    return { ...cur, dimensions: dims };
  }
}
