/**
 * 世界观铁律（canon）repo（P1-A T1：保护层真数据源）。
 *
 * P0 里保护层的 canon 恒为空数组、处于休眠态；本表（project_canon，迁移 v13）
 * 是它的真数据源——一条铁律一行，供上下文装配与合规守卫读取。
 * 裸 SQL + 薄封装，与 draft-repo / chapter-repo 同风格，不用 ORM。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
// ★ P1-A T2：CanonEntry 上移到 shared/types/pipeline（IPC 契约 canon:* 三通道的载荷类型），
//   这里 re-export 保持既有 import 路径不变——定义仍只有一份。
import type { CanonEntry } from '@shared/types/pipeline';

export type { CanonEntry };

interface CanonRow {
  id: string;
  project_id: string;
  text: string;
  created_at: number;
}

function toCanonEntry(r: CanonRow): CanonEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    text: r.text,
    createdAt: r.created_at,
  };
}

export class CanonRepo {
  constructor(private readonly db: Database) {}

  /**
   * 项目内铁律列表，按创建序（升序）。
   * ★ rowid 兜住同毫秒插入的次序：created_at 是 Date.now()，两条背靠背的
   *   add 很可能落在同一毫秒，只按 created_at 排序会不确定；rowid 单调递增，
   *   作平手时的次级键，保证「先入先出」与用户看到的追加顺序一致。
   */
  list(projectId: string): CanonEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM project_canon WHERE project_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(projectId) as CanonRow[];
    return rows.map(toCanonEntry);
  }

  /**
   * 新增一条铁律。文本先 trim、再把 3 个以上连续换行压成两个（去空行），
   * 清洗后为空即拒绝——空铁律会渲染成一张没有内容的卡，也会污染装配上下文。
   * id 由库侧生成（前缀 cn-），调用方不传主键。
   */
  add(projectId: string, text: string): CanonEntry {
    const clean = text.trim().replace(/\n{3,}/g, '\n\n');
    if (!clean) throw new MzError('E_INVALID_ARGS', 'canon 条目不能为空');
    const id = `cn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare('INSERT INTO project_canon(id, project_id, text, created_at) VALUES(?,?,?,?)')
      .run(id, projectId, clean, now);
    return { id, projectId, text: clean, createdAt: now };
  }

  /**
   * 删除一条铁律。带 project_id 定位（与 chapters 同口径）：不许拿 A 书的
   * 删除打到 B 书。不存在返回 false 而不抛——删除是幂等的收尾动作。
   */
  remove(projectId: string, id: string): boolean {
    const info = this.db
      .prepare('DELETE FROM project_canon WHERE project_id = ? AND id = ?')
      .run(projectId, id);
    return info.changes > 0;
  }
}
