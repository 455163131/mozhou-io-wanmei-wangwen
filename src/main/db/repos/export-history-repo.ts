/**
 * 导出历史 repo（P2-D T1）。
 *
 * 只记事实：成功与失败都落一行，fail 行 path/bytes 为 null、error 存真因
 * （EACCES/磁盘满等），供导出面板「最近导出」回看与排障。scope 以
 * scope_json TEXT 往返（读出 cast ExportScope），不加 CHECK——枚举收紧
 * 留给应用写侧，口径同 v14/v16。裸 SQL + 薄封装，不用 ORM。
 */
import type { Database } from 'better-sqlite3';
import type { ExportFormat, ExportHistoryInsert, ExportHistoryRow, ExportScope } from '@shared/types/export';

interface ExportHistoryRowRow {
  id: string;
  project_id: string;
  format: string;
  scope_json: string;
  dest: string;
  path: string | null;
  bytes: number | null;
  status: string;
  error: string | null;
  created_at: number;
}

function toExportHistoryRow(r: ExportHistoryRowRow): ExportHistoryRow {
  return {
    id: r.id,
    projectId: r.project_id,
    format: r.format as ExportFormat,
    scope: JSON.parse(r.scope_json) as ExportScope,
    dest: r.dest as 'project' | 'external',
    path: r.path,
    bytes: r.bytes,
    status: r.status as 'ok' | 'fail',
    error: r.error,
    createdAt: r.created_at,
  };
}

export class ExportHistoryRepo {
  constructor(private readonly db: Database) {}

  /** id 由库侧生成（同 P2-C `ic-` 生成法），调用方不传主键 */
  insert(r: ExportHistoryInsert): ExportHistoryRow {
    const id = `ex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO export_history(id, project_id, format, scope_json, dest, path, bytes, status, error, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, r.projectId, r.format, JSON.stringify(r.scope), r.dest, r.path, r.bytes, r.status, r.error, now);
    return { ...r, id, createdAt: now };
  }

  /** 最近导出记录，新在前（rowid 兜同毫秒写入的次序） */
  listRecent(limit = 50): ExportHistoryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM export_history ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as ExportHistoryRowRow[];
    return rows.map(toExportHistoryRow);
  }
}
