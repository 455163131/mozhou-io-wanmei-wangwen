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
import { MzError } from '@shared/types/ipc';
import type { CharState, CharacterProfile, Foreshadow, NumberAnchor, TimelineEvent } from '@shared/types/ledger';

const FORESHADOW_STATUSES: readonly Foreshadow['status'][] = ['resolved', 'suspected', 'unresolved'];

/** kind → 表名（patch 只开两类手改入口；remove 四类全开——删条目没有"改一半"的风险） */
const LEDGER_TABLES = {
  character: 'ledger_characters',
  foreshadow: 'ledger_foreshadows',
  number: 'ledger_numbers',
  timeline: 'ledger_timeline',
} as const;

type LedgerKind = keyof typeof LEDGER_TABLES;
type PatchableKind = 'character' | 'foreshadow';

/**
 * ★ P2-B T3 手改白名单：Agent 与作者共写一本账的边界。
 * · 结构字段（id / plantedAt / refs / updatedAt）不在名单里——patch 改了它们，
 *   出处链就断了，query_ledger 会拿着改过的"证据"引用不存在的原文；
 * · 落索引列的字段（name / status）值必须硬校验（口径与 upsert 一致：
 *   空 name / 非法 status 一旦进列，条目就永远过滤不出来）；
 * · 其余只存 payload 的手录字段（goals / chain / voice…）放宽形状，
 *   枚举收紧只针对 weight（它参与债务加权，D 档会直接炸账，见 ledger-metrics）。
 */
const PATCH_WHITELIST: Record<PatchableKind, readonly string[]> = {
  foreshadow: ['name', 'weight', 'chain', 'status', 'resolvedAt'],
  character: [
    'name', 'role', 'age', 'note',
    'goals', 'personality', 'voice', 'appearance', 'arc',
    'knows', 'notKnows', 'relations',
  ],
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

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

  // ── 手改通道（★P2-B T3：Agent 与作者共写一本账）──

  /**
   * 白名单合并更新：SELECT payload → 校验 → 合并 → UPDATE。
   * ★ 项目域守卫与 assertIdNotTakenByOtherProject 同口径（id 是全局主键，
   *   不锁项目域就能拿 A 书的 patch 打到 B 书的行），但对外只说"本项目不存在"——
   *   不泄露别的书有没有这个 id（与 chapters「拿错项目=章节不存在」同款文案）。
   * · foreshadow 的 status 是真实列：payload.status 与列必须同一次 UPDATE 里同步，
   *   否则 payload 已 resolved 而按 status 过滤仍查不到（列与账分裂）；
   *   resolvedAt 给了非空且没显式改 status 时自动置 'resolved'——作者手填回收位置，
   *   语义就是"已回收"，不该还得记得多点一下状态。planted_chapter 不动：白名单不含
   *   plantedAt，埋设位置是出处，改它走重登记而不是手改。
   * · character 的 name 同是索引列（LIKE 过滤走它），payload.name 改了列必须跟着改；
   *   updatedAt 顺手刷新（列与 payload 同步），让"最近手改过"在排序里可见。
   */
  patch(projectId: string, kind: PatchableKind, id: string, patch: Record<string, unknown>): void {
    // ★P2-B T5 收 T3 minor-1：LEDGER_TABLES 是普通对象，真值判断会放行
    // 'constructor' 这类原型链键（拿到的是 Object 构造器，SQL 拼接当场炸库错误）——
    // 守卫只认自有属性。
    if (!Object.hasOwn(LEDGER_TABLES, kind)) throw new MzError('E_INVALID_ARGS', `台账手改不支持类别「${String(kind)}」`);
    if (typeof id !== 'string' || id.trim() === '') throw new MzError('E_INVALID_ARGS', `${kind}的 id 为空`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new MzError('E_INVALID_ARGS', 'patch 必须是要改的字段对象');
    }
    const table = LEDGER_TABLES[kind];
    const row = this.db
      .prepare(`SELECT payload FROM ${table} WHERE id = ? AND project_id = ?`)
      .get(id, projectId) as { payload: string } | undefined;
    if (!row) {
      throw new MzError('E_NOT_FOUND', `${kind}「${id}」在本项目不存在：改一条账只能改自己书里的`);
    }
    const allowed = PATCH_WHITELIST[kind];
    const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (bad.length > 0) {
      throw new MzError(
        'E_INVALID_ARGS',
        `白名单外的字段不能手改：${bad.join('/')}（${kind}可改：${allowed.join('/')}）——` +
          '结构字段是出处链，改了它就等于伪造原文证据',
      );
    }
    const next = { ...(JSON.parse(row.payload) as Record<string, unknown>), ...patch };
    this.assertPatchValues(next, patch);

    if (kind === 'foreshadow') {
      const f = next as unknown as Foreshadow;
      if (patch.resolvedAt !== undefined && patch.resolvedAt !== null && patch.status === undefined) {
        f.status = 'resolved';
      }
      this.db
        .prepare(`UPDATE ${table} SET payload = ?, status = ? WHERE id = ? AND project_id = ?`)
        .run(JSON.stringify(f), f.status, id, projectId);
      return;
    }
    const c = next as unknown as CharacterProfile & { updatedAt: number };
    c.updatedAt = Date.now();
    this.db
      .prepare(`UPDATE ${table} SET payload = ?, name = ?, updated_at = ? WHERE id = ? AND project_id = ?`)
      .run(JSON.stringify(c), c.name, c.updatedAt, id, projectId);
  }

  /**
   * 白名单之外再收一道值域：只硬校验"进索引列的"和"进债务计算的"（见 PATCH_WHITELIST 注释），
   * 纯 payload 手录字段（chain/voice/relations…）放宽形状——UI 空态归 Task 4/6，不该在写侧造假闸。
   * 校验对象是合并后的整值——patch 里出现某个键，它的最终值就必须成立。
   */
  private assertPatchValues(next: Record<string, unknown>, patch: Record<string, unknown>): void {
    if ('name' in patch) {
      const n = next.name;
      if (typeof n !== 'string' || n.trim() === '') {
        throw new MzError('E_INVALID_ARGS', 'name 非法：必须是非空字符串——人物卡它是索引列，伏笔它是台账显示名，空值都不该进账');
      }
    }
    if ('weight' in patch) {
      const w = next.weight;
      if (w !== 'A' && w !== 'B' && w !== 'C') {
        throw new MzError('E_INVALID_ARGS', `伏笔 weight 非法：只能是 A/B/C 之一，收到「${String(w)}」——债务按档加权，非法档会炸账`);
      }
    }
    if ('status' in patch && !FORESHADOW_STATUSES.includes(next.status as Foreshadow['status'])) {
      throw new MzError(
        'E_INVALID_ARGS',
        `伏笔 status 非法：只能是 ${FORESHADOW_STATUSES.join('/')} 之一，收到「${String(next.status)}」`,
      );
    }
    for (const key of ['knows', 'notKnows'] as const) {
      if (key in patch && !isStringArray(next[key])) {
        throw new MzError('E_INVALID_ARGS', `人物卡 ${key} 非法：必须是字符串数组，穿帮检查逐条比对，混进非字符串就断在中间`);
      }
    }
  }

  /**
   * 删一条账。DELETE 带 project_id 定位（canon:remove 同款）：跨项目 id 直接
   * 落空返回 false，不给"拿 A 书 id 删 B 书条目"留任何缝。不存在不抛——
   * 删除是幂等收尾。
   * ★P2-B T5 两处收口（T3 留的债在此还清）：
   * · 非法 kind 不再静默 false，与 patch 同口径抛 E_INVALID_ARGS——"删不动"
   *   （幂等，回 false）和"根本没这类账"（调用方 bug，该炸）是两回事。
   *   仍用 Object.hasOwn 挡原型链键（同 patch minor-1）。
   * · character 连带删其 ledger_char_states：人物卡删了，"TA 在各章的处境"
   *   成了无主快照——留在库里 stateList 还能查出来，矩阵页会渲染出一列
   *   点不开的人物。两条 DELETE 一个事务：半删（卡没了快照还在）正是
   *   本文件开头"半张人物卡比没登记更糟"同款事故。
   */
  remove(projectId: string, kind: LedgerKind, id: string): boolean {
    if (!Object.hasOwn(LEDGER_TABLES, kind)) {
      throw new MzError('E_INVALID_ARGS', `台账删除不支持类别「${String(kind)}」`);
    }
    const table = LEDGER_TABLES[kind];
    if (typeof id !== 'string' || id.trim() === '') return false;
    if (kind !== 'character') {
      const info = this.db.prepare(`DELETE FROM ${table} WHERE id = ? AND project_id = ?`).run(id, projectId);
      return info.changes > 0;
    }
    const del = this.db.prepare(`DELETE FROM ${table} WHERE id = ? AND project_id = ?`);
    const delStates = this.db.prepare('DELETE FROM ledger_char_states WHERE character_id = ? AND project_id = ?');
    // ★ 顺序是先删快照再删卡：ledger_char_states 的 FK 指向 ledger_characters，
    //   pragma 开着时反着来会当场炸 SQLITE_CONSTRAINT（迁移 v9 的 drop 顺序同款坑）。
    return this.db
      .transaction(() => {
        delStates.run(id, projectId);
        const info = del.run(id, projectId);
        return info.changes > 0;
      })
      .call(this.db);
  }

  // ── 章×人物状态矩阵（★P2-B T5：v15 ledger_char_states）──

  /**
   * 写一章×一人的状态快照（upsert 收敛，结构键 UNIQUE(character_id, chapter_no)）。
   * · id 只在**新行**时生成：ON CONFLICT 不碰 id——T6 矩阵页拿 id 做 React key，
   *   同格重写换 id 会让 UI 整格重挂载、编辑焦点被吞；
   * · snapshot 先 trim，空即拒（口径同 canon:add）——空快照在矩阵里既显示不了
   *   处境，又会把"这一章 TA 没状态"和"存了个空"混成同一件事；
   * · 章号必须 ≥1 的整数：章号是从 1 起算的故事序（同 pipeline:write-draft
   *   Carry-2 口径），0/负/小数进库后矩阵列头就歪了；
   * · characterId 必须属于本项目：直接复用 assertIdNotTakenByOtherProject——
   *   与人物卡登记同一条闸，不给"给别书人物记状态"留缝。表对 ledger_characters
   *   有 FK（pragma 开着时 SQLite 兜底），这条闸负责给出人话错误。
   */
  stateSet(projectId: string, characterId: string, chapterNo: number, snapshot: string): CharState {
    if (typeof snapshot !== 'string' || snapshot.trim() === '') {
      throw new MzError('E_INVALID_ARGS', '状态快照不能为空：空快照既回看不了处境，也分不清"没状态"和"存了个空"');
    }
    if (!Number.isInteger(chapterNo) || chapterNo < 1) {
      throw new MzError('E_INVALID_ARGS', `章号非法：${String(chapterNo)}——章号是从 1 起算的整数，矩阵按它排列`);
    }
    if (typeof characterId !== 'string' || characterId.trim() === '') {
      throw new MzError('E_INVALID_ARGS', 'characterId 为空：快照挂不上人物就成了无主数据');
    }
    this.assertIdNotTakenByOtherProject('ledger_characters', characterId, projectId, '人物卡');
    const id = `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        'INSERT INTO ledger_char_states(id, character_id, project_id, chapter_no, snapshot, created_at) VALUES(?,?,?,?,?,?) ' +
          'ON CONFLICT(character_id, chapter_no) DO UPDATE SET snapshot=excluded.snapshot',
      )
      .run(id, characterId, projectId, chapterNo, snapshot.trim(), Date.now());
    // 回读而不是回显入参：id 可能被冲突收敛成旧行主键，返回值必须是库里真实那一行
    const row = this.db
      .prepare('SELECT id, character_id, project_id, chapter_no, snapshot FROM ledger_char_states WHERE character_id = ? AND chapter_no = ?')
      .get(characterId, chapterNo) as {
      id: string;
      character_id: string;
      project_id: string;
      chapter_no: number;
      snapshot: string;
    };
    return { id: row.id, characterId: row.character_id, projectId: row.project_id, chapterNo: row.chapter_no, snapshot: row.snapshot };
  }

  /**
   * 项目内全部快照，按章号升序（rowid 兜同毫秒写入的次序，canon:list 同款口径）。
   * T6 矩阵页按章×人渲染，序在库侧定死，渲染层不再二次排序。
   */
  stateList(projectId: string): CharState[] {
    const rows = this.db
      .prepare(
        'SELECT id, character_id, project_id, chapter_no, snapshot FROM ledger_char_states WHERE project_id = ? ORDER BY chapter_no ASC, rowid ASC',
      )
      .all(projectId) as Array<{
      id: string;
      character_id: string;
      project_id: string;
      chapter_no: number;
      snapshot: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      characterId: r.character_id,
      projectId: r.project_id,
      chapterNo: r.chapter_no,
      snapshot: r.snapshot,
    }));
  }
}
