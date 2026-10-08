/**
 * 账本落库（§4 第 13 条）。
 *
 * ★ 修复前的现状（实测）：`db/migrate.ts` 的 version 3 建好了 `ledger_*` 五张表，
 *   但全仓没有一行读写它们；`services.ts` 用四个 `Map<string, T[]>` 顶替，
 *   而四个 Map **只有 get、没有 set** → 账本会话内恒为空，`query_ledger` 永远返回空集合，
 *   S2 跨章一致性对账没有数据来源。本文件把"表"和"用法"接上。
 *
 * 列拆装的口径（写下来免得后人以为是随手）：
 *   · 实体整体 JSON 存 `payload`，同时把过滤/索引要用的字段拆成真实列
 *     （name / subject / when / status / planted_chapter）。只存 payload 等于白建索引。
 *   · 主键是 `id`，所以 upsert = 覆盖。账本条目是"事实"，同一事实修订两次应当收敛。
 *   · 一批一个事务：半张人物卡比没登记更糟——`query_ledger` 会把它当既成事实引用。
 */
import type { Database } from 'better-sqlite3';
import type { CharacterProfile, Foreshadow, NumberAnchor, TimelineEvent } from '@shared/types/ledger';

const FORESHADOW_STATUSES: readonly Foreshadow['status'][] = ['resolved', 'suspected', 'unresolved'];

/** 空/纯空白的 id 会让主键变成空串：既无法覆盖，也无法回查，必须在入口拦住 */
function assertId(id: string, kind: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`${kind}的 id 为空——它是主键，空 id 的条目既覆盖不了也查不回来`);
  }
}

function assertText(value: string, kind: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${kind}的${label}为空：这一列是索引列，空值等于条目再也过滤不出来`);
  }
}

export class LedgerRepo {
  constructor(private readonly db: Database) {}

  /**
   * 同一 id 已登记在别的项目下时拒绝。
   * 表的主键是全局 id，不拦就会把别人项目的账本条目"搬"到本项目来（项目隔离被击穿）。
   */
  private assertIdNotTakenByOtherProject(table: string, id: string, projectId: string, kind: string): void {
    const row = this.db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as
      | { project_id: string }
      | undefined;
    if (row && row.project_id !== projectId) {
      throw new Error(`${kind}「${id}」不属于本项目，不能登记进来`);
    }
  }

  private count(table: string, projectId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId) as {
      n: number;
    };
    return r.n;
  }

  counts(projectId: string): { characters: number; numbers: number; timeline: number; foreshadows: number } {
    return {
      characters: this.count('ledger_characters', projectId),
      numbers: this.count('ledger_numbers', projectId),
      timeline: this.count('ledger_timeline', projectId),
      foreshadows: this.count('ledger_foreshadows', projectId),
    };
  }

  // ── 人物卡 ──

  upsertCharacters(projectId: string, items: readonly CharacterProfile[]): number {
    if (items.length === 0) return 0;
    for (const c of items) {
      assertId(c.id, '人物卡');
      assertText(c.name, '人物卡', '人物名');
      this.assertIdNotTakenByOtherProject('ledger_characters', c.id, projectId, '人物卡');
    }
    const stmt = this.db.prepare(
      'INSERT INTO ledger_characters(id, project_id, name, payload, updated_at) VALUES(?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name, ' +
        'payload=excluded.payload, updated_at=excluded.updated_at',
    );
    this.db
      .transaction(() => {
        for (const c of items) {
          stmt.run(c.id, projectId, c.name, JSON.stringify(c), c.updatedAt || Date.now());
        }
      })
      .call(this.db);
    return this.count('ledger_characters', projectId);
  }

  characters(projectId: string, subject?: string): CharacterProfile[] {
    const like = subject && subject.trim() !== '' ? `%${subject.trim()}%` : null;
    const sql = like
      ? 'SELECT payload FROM ledger_characters WHERE project_id = ? AND name LIKE ? ORDER BY rowid'
      : 'SELECT payload FROM ledger_characters WHERE project_id = ? ORDER BY rowid';
    const rows = (like
      ? this.db.prepare(sql).all(projectId, like)
      : this.db.prepare(sql).all(projectId)) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as CharacterProfile);
  }

  // ── 数字锚点 ──

  upsertNumbers(projectId: string, items: readonly NumberAnchor[]): number {
    if (items.length === 0) return 0;
    for (const n of items) {
      assertId(n.id, '数字锚点');
      assertText(n.subject, '数字锚点', 'subject');
      this.assertIdNotTakenByOtherProject('ledger_numbers', n.id, projectId, '数字锚点');
    }
    const stmt = this.db.prepare(
      'INSERT INTO ledger_numbers(id, project_id, subject, payload) VALUES(?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, subject=excluded.subject, ' +
        'payload=excluded.payload',
    );
    this.db
      .transaction(() => {
        for (const n of items) stmt.run(n.id, projectId, n.subject, JSON.stringify(n));
      })
      .call(this.db);
    return this.count('ledger_numbers', projectId);
  }

  numbers(projectId: string, subject?: string): NumberAnchor[] {
    const like = subject && subject.trim() !== '' ? `%${subject.trim()}%` : null;
    const sql = like
      ? 'SELECT payload FROM ledger_numbers WHERE project_id = ? AND subject LIKE ? ORDER BY rowid'
      : 'SELECT payload FROM ledger_numbers WHERE project_id = ? ORDER BY rowid';
    const rows = (like
      ? this.db.prepare(sql).all(projectId, like)
      : this.db.prepare(sql).all(projectId)) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as NumberAnchor);
  }

  // ── 时间线 ──

  upsertTimeline(projectId: string, items: readonly TimelineEvent[]): number {
    if (items.length === 0) return 0;
    for (const t of items) {
      assertId(t.id, '时间线事件');
      assertText(t.when, '时间线事件', 'when（故事内时间）');
      this.assertIdNotTakenByOtherProject('ledger_timeline', t.id, projectId, '时间线事件');
    }
    const stmt = this.db.prepare(
      'INSERT INTO ledger_timeline(id, project_id, "when", payload) VALUES(?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, "when"=excluded."when", ' +
        'payload=excluded.payload',
    );
    this.db
      .transaction(() => {
        for (const t of items) stmt.run(t.id, projectId, t.when, JSON.stringify(t));
      })
      .call(this.db);
    return this.count('ledger_timeline', projectId);
  }

  timeline(projectId: string): TimelineEvent[] {
    const rows = this.db
      .prepare('SELECT payload FROM ledger_timeline WHERE project_id = ? ORDER BY rowid')
      .all(projectId) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as TimelineEvent);
  }

  // ── 伏笔 ──

  upsertForeshadows(projectId: string, items: readonly Foreshadow[]): number {
    if (items.length === 0) return 0;
    for (const f of items) {
      assertId(f.id, '伏笔');
      if (!FORESHADOW_STATUSES.includes(f.status)) {
        throw new Error(
          `伏笔的 status 只能是 ${FORESHADOW_STATUSES.join('/')} 之一，收到「${String(f.status)}」：` +
            '写错一个字母它就永远过滤不出来',
        );
      }
      assertText(f.plantedAt?.chapterId ?? '', '伏笔', '埋设章节（plantedAt.chapterId）');
      this.assertIdNotTakenByOtherProject('ledger_foreshadows', f.id, projectId, '伏笔');
    }
    const stmt = this.db.prepare(
      'INSERT INTO ledger_foreshadows(id, project_id, status, planted_chapter, payload) VALUES(?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, status=excluded.status, ' +
        'planted_chapter=excluded.planted_chapter, payload=excluded.payload',
    );
    this.db
      .transaction(() => {
        for (const f of items) stmt.run(f.id, projectId, f.status, f.plantedAt.chapterId, JSON.stringify(f));
      })
      .call(this.db);
    return this.count('ledger_foreshadows', projectId);
  }

  foreshadows(projectId: string, status?: Foreshadow['status']): Foreshadow[] {
    const sql = status
      ? 'SELECT payload FROM ledger_foreshadows WHERE project_id = ? AND status = ? ORDER BY rowid'
      : 'SELECT payload FROM ledger_foreshadows WHERE project_id = ? ORDER BY rowid';
    const rows = (status
      ? this.db.prepare(sql).all(projectId, status)
      : this.db.prepare(sql).all(projectId)) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Foreshadow);
  }
}
