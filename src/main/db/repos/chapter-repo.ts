/**
 * 章节与项目 repo（架构 T10）。
 * 裸 SQL + 薄封装，不用 ORM。
 */
import type { Database } from 'better-sqlite3';
import type { Chapter, ChapterMeta, ChapterMetrics, Project, Volume } from '@shared/types/project';
import { countChars } from '@shared/util/text-zh';
import { nextId } from '@shared/util/id';
import { DailyWriteRepo } from './daily-write-repo';

interface ChapterRow {
  id: string;
  project_id: string;
  title: string;
  volume_id: string | null;
  ord: number;
  status: string;
  char_count: number;
  rev: number;
  updated_at: number;
}

function toMeta(r: ChapterRow): ChapterMeta {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    volumeId: r.volume_id,
    order: r.ord,
    status: r.status as ChapterMeta['status'],
    charCount: r.char_count,
    rev: r.rev,
    updatedAt: r.updated_at,
  };
}

/**
 * `IN (...)` 单批绑定变量上限。
 *
 * SQLite 的 `SQLITE_MAX_VARIABLE_NUMBER` 旧版是 999、新版 32766。把全部 chapterId
 * 一次摊进占位符，会在大项目上抛 "too many SQL variables"——而网文的常态规模
 * （500~2000 章）正好踩在这条线上。受影响的是导出、建基线、状态哈希与全量备份，
 * 全是用户感知最强的路径。取 500 一档：远离任何版本的上限，单批内存也可控。
 */
const IN_CLAUSE_CHUNK = 500;

/**
 * 拖拽排序的统一前置校验：前端传来的 id 列表必须**恰好**等于库里现有的那一套。
 *
 * 为什么宁抛不宽容：
 *   · 少给一条 → 那条的 ord 保持旧值，很可能与新的某条撞上，`ORDER BY ord` 从此不确定；
 *   · 多给一条（别的项目的 id，或前端列表过期）→ 会把别人的顺序改掉。
 * 两种都是"看起来成功了"的静默数据损坏，比一次报错难查一个数量级。
 *
 * @param kind 错误消息里的对象名（卷 / 章节）
 */
function assertExactIdSet(existingIds: string[], orderedIds: readonly string[], kind: string): void {
  const existing = new Set(existingIds);
  const given = new Set(orderedIds);
  if (given.size !== orderedIds.length) {
    throw new Error(`重排${kind}的列表里有重复 id`);
  }
  const missing = existingIds.filter((id) => !given.has(id));
  const extra = orderedIds.filter((id) => !existing.has(id));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`漏了 ${missing.length} 个${kind}`);
    if (extra.length > 0) parts.push(`${extra.length} 个${kind}不属于本项目`);
    throw new Error(`重排${kind}被拒绝：${parts.join('，')}（列表可能已过期，请刷新后重试）`);
  }
}

export class ChapterRepo {
  /**
   * @param dailyWrites 日增量账。默认自建（同一个 db），**不给"忘了传"留机会**：
   *   本仓库反复出现的事故形状就是逻辑对、没人喂它，把它做成可选注入等于把
   *   记账重新变成调用方的责任。
   */
  constructor(
    private readonly db: Database,
    private readonly dailyWrites: DailyWriteRepo = new DailyWriteRepo(db),
  ) {}

  /** 列元信息，不拉正文（架构 §1.9 分页：列表不需要正文） */
  listMeta(projectId: string): ChapterMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY ord ASC')
      .all(projectId) as ChapterRow[];
    return rows.map(toMeta);
  }

  /** 分页读取（虚拟化窗口用） */
  listMetaPage(projectId: string, limit: number, offset: number): ChapterMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY ord ASC LIMIT ? OFFSET ?')
      .all(projectId, limit, offset) as ChapterRow[];
    return rows.map(toMeta);
  }

  count(projectId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE project_id = ?')
      .get(projectId) as { n: number };
    return r.n;
  }

  /**
   * 取单章：元信息 + 正文。
   * ★ 章节号只在**书内**唯一（§4 第 18 条），只给 chapterId 定位不了记录。
   */
  get(projectId: string, chapterId: string): Chapter | null {
    const row = this.db
      .prepare('SELECT * FROM chapters WHERE project_id = ? AND id = ?')
      .get(projectId, chapterId) as ChapterRow | undefined;
    if (!row) return null;
    const bodyRow = this.db
      .prepare('SELECT body FROM chapter_bodies WHERE project_id = ? AND chapter_id = ?')
      .get(projectId, chapterId) as { body: string } | undefined;
    return { meta: toMeta(row), body: bodyRow?.body ?? '' };
  }

  getBody(projectId: string, chapterId: string): string | null {
    const row = this.db
      .prepare('SELECT body FROM chapter_bodies WHERE project_id = ? AND chapter_id = ?')
      .get(projectId, chapterId) as { body: string } | undefined;
    return row ? row.body : null;
  }

  /**
   * 更新正文，乐观锁。
   * @param expectedRev 不匹配则抛 E_REVISION_CONFLICT（说明有外部改动，如用户手动改过）
   */
  updateBody(projectId: string, chapterId: string, body: string, expectedRev: number): ChapterMeta {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM chapters WHERE project_id = ? AND id = ?')
        .get(projectId, chapterId) as ChapterRow | undefined;
      if (!row) throw new Error(`章节不存在：${chapterId}`);
      if (row.rev !== expectedRev) {
        const err = new Error(
          `章节 ${chapterId} 已被外部修改（当前 rev=${row.rev}，传入 rev=${expectedRev}），请重新加载。`,
        );
        err.name = 'E_REVISION_CONFLICT';
        throw err;
      }

      const now = Date.now();
      const rev = row.rev + 1;
      const chars = countChars(body);

      this.db
        .prepare('UPDATE chapters SET rev = ?, char_count = ?, updated_at = ? WHERE project_id = ? AND id = ?')
        .run(rev, chars, now, projectId, chapterId);
      this.db
        .prepare(
          'INSERT INTO chapter_bodies(project_id, chapter_id, body) VALUES(?, ?, ?) ' +
            'ON CONFLICT(project_id, chapter_id) DO UPDATE SET body = excluded.body',
        )
        .run(projectId, chapterId, body);

      // 指标缓存作废：正文变了，缓存的指标不再可信
      this.db
        .prepare('DELETE FROM chapter_metrics WHERE project_id = ? AND chapter_id = ?')
        .run(projectId, chapterId);

      // ★ 日增量（§4 第 3 条）：记在事务里，与正文同一存亡。
      //   rev 冲突在上方就抛了，走不到这里，所以失败的保存不会记账。
      this.dailyWrites.recordDelta(row.project_id, chars - row.char_count, now);

      return toMeta({ ...row, rev, char_count: chars, updated_at: now });
    })();
  }

  /** 批量取正文（按批扫描用；批读完释放引用）。★ 分块，见 IN_CLAUSE_CHUNK */
  getBodies(projectId: string, chapterIds: string[]): Map<string, string> {
    if (chapterIds.length === 0) return new Map();
    const out = new Map<string, string>();
    for (let i = 0; i < chapterIds.length; i += IN_CLAUSE_CHUNK) {
      const slice = chapterIds.slice(i, i + IN_CLAUSE_CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT chapter_id, body FROM chapter_bodies ` +
            `WHERE project_id = ? AND chapter_id IN (${placeholders})`,
        )
        .all(projectId, ...slice) as Array<{ chapter_id: string; body: string }>;
      for (const r of rows) out.set(r.chapter_id, r.body);
    }
    return out;
  }

  /**
   * 某项目的全部章节（元数据 + 正文），供全量备份使用。
   *
   * ★ 这是「一次读全书」的唯一正当入口（架构 §1.9 的例外）：
   *   全量备份是显式冷路径，只在手动保存 / 退出 / 空闲 30 分钟三个低频时机触发。
   *   编辑器与 Agent 每步的热路径**不得**调用它。
   *   按 IN_CLAUSE_CHUNK 分块读取，避免大项目一次性把全书正文摊进单条 SQL。
   */
  listAllWithBody(projectId: string): Array<{ meta: ChapterMeta; body: string }> {
    const metas = this.listMeta(projectId);
    if (metas.length === 0) return [];
    const bodies = this.getBodies(projectId, metas.map((m) => m.id));
    return metas.map((meta) => ({ meta, body: bodies.get(meta.id) ?? '' }));
  }

  insert(meta: Omit<ChapterMeta, 'rev' | 'updatedAt' | 'charCount'> & { body: string }): ChapterMeta {
    const now = Date.now();
    const chars = countChars(meta.body);
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) ' +
            'VALUES(?,?,?,?,?,?,?,1,?)',
        )
        .run(meta.id, meta.projectId, meta.title, meta.volumeId, meta.order, meta.status, chars, now);
      this.db
        .prepare('INSERT INTO chapter_bodies(project_id, chapter_id, body) VALUES(?,?,?)')
        .run(meta.projectId, meta.id, meta.body);
      // 新建一章带正文 = 全部字数都是净增
      this.dailyWrites.recordDelta(meta.projectId, chars, now);
    })();
    return {
      ...meta,
      charCount: chars,
      rev: 1,
      updatedAt: now,
    };
  }

  /**
   * 新建一章（§4 第 17 条）。此前 `insert()` 全仓**零调用方**，
   * 于是 UI、IPC、Agent 三条路上都没有建章入口，`chapters` 表恒为空。
   *
   * ★ 章节号（书内的 `id`）在这里算，**不由调用方传**：
   *   把主键交给界面决定，双击就多一章、或两次拿到同一个号撞主键。
   *   口径 = 本项目现有可解析为数字的最大号 + 1（不是"条数 + 1"——删过一章就不该把号退回去）；
   *   非数字 id（楔子、番外这类占位）不参与算号。
   *   `ord` 由库里的 `MAX(ord)+1` 算，追加到全书末尾。
   */
  createChapter(
    projectId: string,
    opts: { title?: string; volumeId?: string | null } = {},
  ): ChapterMeta {
    if (!projectId) throw new Error('新建章节被拒绝：没有打开项目');
    const proj = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as
      | { id: string }
      | undefined;
    if (!proj) throw new Error(`新建章节被拒绝：项目不存在 ${projectId}`);

    const volumeId = opts.volumeId ?? null;
    if (volumeId !== null) {
      const v = this.db.prepare('SELECT project_id FROM volumes WHERE id = ?').get(volumeId) as
        | { project_id: string }
        | undefined;
      if (!v) throw new Error(`新建章节被拒绝：卷不存在 ${volumeId}`);
      if (v.project_id !== projectId) {
        throw new Error(`卷「${volumeId}」不属于本项目，不能把章建进去`);
      }
    }

    const rows = this.db
      .prepare('SELECT id FROM chapters WHERE project_id = ?')
      .all(projectId) as Array<{ id: string }>;
    let maxNo = 0;
    for (const r of rows) {
      const n = Number(r.id);
      if (Number.isFinite(n) && n > maxNo) maxNo = n;
    }
    // 主键是 (project_id, id)（§4 第 18 条），所以号只在本项目内比较就够了——
    // 别的书占过 1/2/3 不影响这本书从 1 开始。修复前这里是全局主键，
    // 第二本书建第一章拿到的是 4，"每本书各自从 1 开始"在 schema 层就不成立。
    const no = maxNo + 1;

    const next = this.db
      .prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM chapters WHERE project_id = ?')
      .get(projectId) as { n: number };

    return this.insert({
      id: String(no),
      projectId,
      title: (opts.title ?? '').trim(),
      volumeId,
      order: next.n,
      status: 'draft',
      body: '',
    });
  }

  /** 缓存指标（500 章仅 0.25MB，可全量缓存） */
  /**
   * 拖拽重排：`orderedIds` 必须是本项目全部章节的**恰好一个排列**。
   *
   * 只改 `ord`。正文、`rev`、`updated_at` 一律不碰 —— 排序不是编辑：
   * 动了 `rev` 会让编辑器里那份未保存的正文在下次保存时撞上乐观锁，
   * 用户感知就是"我就拖了一下顺序，怎么写不回去了"。
   */
  reorder(projectId: string, orderedIds: readonly string[]): ChapterMeta[] {
    const rows = this.db
      .prepare('SELECT id FROM chapters WHERE project_id = ?')
      .all(projectId) as Array<{ id: string }>;
    assertExactIdSet(rows.map((r) => r.id), orderedIds, '章节');
    const upd = this.db.prepare('UPDATE chapters SET ord = ? WHERE id = ? AND project_id = ?');
    // 一个事务：中途抛出去的话，半新半旧的顺序比原顺序更难解释
    this.db.transaction(() => {
      orderedIds.forEach((id, i) => upd.run(i, id, projectId));
    })();
    return this.listMeta(projectId);
  }

  /**
   * 把一章挪进某一卷；`volumeId = null` 表示「未分卷」。
   * 章按 (projectId, chapterId) 定位，卷必须属于同一个项目 ——
   * 否则是拿 A 书的章/卷改 B 书的数据（跨项目越权写入）。
   */
  setVolume(projectId: string, chapterId: string, volumeId: string | null): ChapterMeta {
    const row = this.db
      .prepare('SELECT * FROM chapters WHERE project_id = ? AND id = ?')
      .get(projectId, chapterId) as ChapterRow | undefined;
    if (!row) throw new Error(`章节不存在：${chapterId}`);
    if (volumeId !== null) {
      const vol = this.db.prepare('SELECT project_id FROM volumes WHERE id = ?').get(volumeId) as
        | { project_id: string }
        | undefined;
      if (!vol) throw new Error(`卷不存在：${volumeId}`);
      if (vol.project_id !== projectId) throw new Error('该卷不属于当前项目');
    }
    this.db
      .prepare('UPDATE chapters SET volume_id = ? WHERE project_id = ? AND id = ?')
      .run(volumeId, projectId, chapterId);
    const meta = this.listMeta(projectId).find((c) => c.id === chapterId);
    if (!meta) throw new Error(`章节状态读取失败：${chapterId}`);
    return meta;
  }

  saveMetrics(m: ChapterMetrics): void {
    this.db
      .prepare(
        'INSERT INTO chapter_metrics(project_id, chapter_id, chars, paras, sents, avg_sent, sent_cv, avg_para, ' +
          'sents_per_para, ttr, bigram_ttr, tri_repeat, dialog_ratio, score, computed_at) ' +
          'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
          'ON CONFLICT(project_id, chapter_id) DO UPDATE SET chars=excluded.chars, paras=excluded.paras, ' +
          'sents=excluded.sents, avg_sent=excluded.avg_sent, sent_cv=excluded.sent_cv, ' +
          'avg_para=excluded.avg_para, sents_per_para=excluded.sents_per_para, ttr=excluded.ttr, ' +
          'bigram_ttr=excluded.bigram_ttr, tri_repeat=excluded.tri_repeat, ' +
          'dialog_ratio=excluded.dialog_ratio, score=excluded.score, computed_at=excluded.computed_at',
      )
      .run(
        m.projectId, m.chapterId, m.chars, m.paras, m.sents, m.avgSent, m.sentCv, m.avgPara,
        m.sentsPerPara, m.ttr, m.bigramTtr, m.triRepeat, m.dialogRatio, m.score, m.computedAt,
      );
  }

  getMetrics(projectId: string, chapterId: string): ChapterMetrics | null {
    const r = this.db
      .prepare('SELECT * FROM chapter_metrics WHERE project_id = ? AND chapter_id = ?')
      .get(projectId, chapterId) as Record<string, number> | undefined;
    if (!r) return null;
    return {
      projectId,
      chapterId,
      chars: r.chars,
      paras: r.paras,
      sents: r.sents,
      avgSent: r.avg_sent,
      sentCv: r.sent_cv,
      avgPara: r.avg_para,
      sentsPerPara: r.sents_per_para,
      ttr: r.ttr,
      bigramTtr: r.bigram_ttr,
      triRepeat: r.tri_repeat,
      dialogRatio: r.dialog_ratio,
      score: r.score,
      computedAt: r.computed_at,
    };
  }
}

export class ProjectRepo {
  constructor(private readonly db: Database) {}

  create(name: string, rootDir: string, targetWords = 0): Project {
    const id = nextId('proj');
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO projects(id, name, root_dir, created_at, updated_at, target_words) VALUES(?,?,?,?,?,?)',
      )
      .run(id, name, rootDir, now, now, targetWords);
    return { id, name, rootDir, createdAt: now, updatedAt: now, targetWords, pricePerK: 0 };
  }

  get(projectId: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | Record<string, string | number>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      rootDir: r.root_dir as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      targetWords: r.target_words as number,
      pricePerK: r.price_per_k as number,
    };
  }

  list(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Array<
      Record<string, string | number>
    >;
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      rootDir: r.root_dir as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      targetWords: r.target_words as number,
      pricePerK: r.price_per_k as number,
    }));
  }

  /**
   * 设千字单价（元）。稿费预估的唯一输入，0 表示未配置。
   * 拒 NaN / 负数 / 无穷：这三个值会一路安静地变成"稿费 −0 元"或"稿费 NaN 元"糊在仪表盘上。
   */
  setPricePerK(projectId: string, pricePerK: number): Project {
    if (!Number.isFinite(pricePerK) || pricePerK < 0) {
      throw new Error(`千字单价必须是非负有限数，收到 ${pricePerK}`);
    }
    const now = Date.now();
    this.db
      .prepare('UPDATE projects SET price_per_k = ?, updated_at = ? WHERE id = ?')
      .run(Math.round(pricePerK), now, projectId);
    const p = this.get(projectId);
    if (!p) throw new Error(`项目不存在：${projectId}`);
    return p;
  }

  touch(projectId: string): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId);
  }

  volumes(projectId: string): Volume[] {
    const rows = this.db
      .prepare('SELECT id, project_id, title, ord FROM volumes WHERE project_id = ? ORDER BY ord ASC')
      .all(projectId) as Array<{ id: string; project_id: string; title: string; ord: number }>;
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, title: r.title, order: r.ord }));
  }

  insertVolume(projectId: string, title: string, order: number): Volume {
    const id = nextId('vol');
    this.db
      .prepare('INSERT INTO volumes(id, project_id, title, ord) VALUES(?,?,?,?)')
      .run(id, projectId, title, order);
    return { id, projectId, title, order };
  }

  /**
   * 新建一卷，ord 追加到末尾（由库自己算 MAX，调用方不数）。
   *
   * ★ 这是 §4 第 4 条的正主：`insertVolume` 早就写好了，但全仓零调用方 ——
   *   UI 没入口、IPC 没通道、Agent 没工具，所以「分卷」一直是只读展示。
   *   标题在这里裁空白并拒绝空值：卷名是用户能直接看到的文本，
   *   空卷名会在规划视图里渲染成一张没有名字的卡。
   */
  createVolume(projectId: string, title: string): Volume {
    const clean = title.trim();
    if (!clean) throw new Error('卷名不能为空');
    const next = this.db
      .prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM volumes WHERE project_id = ?')
      .get(projectId) as { next: number };
    return this.insertVolume(projectId, clean, next.next);
  }

  /** 拖拽重排卷册。规则与 ChapterRepo.reorder 相同：整表全给、一个事务、越界即抛。 */
  reorderVolumes(projectId: string, orderedIds: readonly string[]): Volume[] {
    const rows = this.db
      .prepare('SELECT id FROM volumes WHERE project_id = ?')
      .all(projectId) as Array<{ id: string }>;
    assertExactIdSet(rows.map((r) => r.id), orderedIds, '卷');
    const upd = this.db.prepare('UPDATE volumes SET ord = ? WHERE id = ? AND project_id = ?');
    this.db.transaction(() => {
      orderedIds.forEach((id, i) => upd.run(i, id, projectId));
    })();
    return this.volumes(projectId);
  }
}

/** 风格指纹 repo（T22）。★ 绝不能用示例基线当默认 */
export class StyleProfileRepo {
  constructor(private readonly db: Database) {}

  get(projectId: string): { source: string; sampleChapters: number; metrics: Record<string, unknown>; markerDensity: Record<string, unknown> } | null {
    const r = this.db.prepare('SELECT * FROM style_profiles WHERE project_id = ?').get(projectId) as
      | Record<string, string | number>
      | undefined;
    if (!r) return null;
    return {
      source: r.source as string,
      sampleChapters: r.sample_chapters as number,
      metrics: JSON.parse(r.metrics_json as string) as Record<string, unknown>,
      markerDensity: JSON.parse(r.marker_json as string) as Record<string, unknown>,
    };
  }

  save(
    projectId: string,
    source: string,
    sampleChapters: number,
    metrics: Record<string, unknown>,
    markerDensity: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        'INSERT INTO style_profiles(project_id, source, sample_chapters, metrics_json, marker_json, updated_at) ' +
          'VALUES(?,?,?,?,?,?) ' +
          'ON CONFLICT(project_id) DO UPDATE SET source=excluded.source, ' +
          'sample_chapters=excluded.sample_chapters, metrics_json=excluded.metrics_json, ' +
          'marker_json=excluded.marker_json, updated_at=excluded.updated_at',
      )
      .run(
        projectId,
        source,
        sampleChapters,
        JSON.stringify(metrics),
        JSON.stringify(markerDensity),
        Date.now(),
      );
  }
}

/**
 * 分位数计算：按章算分位数而非对拼接文本取均值（架构 §1.7）。
 *
 * ★ **唯一百分位实现**：插值口径 `idx = (n−1)·p`（numpy 默认），与
 *   `scripts/compute-flavor-baseline.mjs` 的 `percentile()` 完全一致。
 *   用户自建基线（`baseline-builder.ts`）也复用它，保证「用户基线 / 默认基线 / 语料脚本」
 *   三处同口径。`min` / `max` 一并返回（= 排序后首尾），避免各处再写一遍极值逻辑。
 */
export function percentiles(values: number[]): {
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
} {
  if (values.length === 0) {
    return { p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, mean: 0, min: 0, max: 0 };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p: number): number => {
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    p05: at(0.05),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}