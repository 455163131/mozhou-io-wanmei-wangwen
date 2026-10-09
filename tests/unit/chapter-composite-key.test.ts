/**
 * §4 第 18 条：章节号跨书隔离 —— `chapters` 的主键必须是 (project_id, id)。
 *
 * 缺陷形态（修第 17 条时撞出来的）：`chapters.id TEXT PRIMARY KEY` 单列主键
 * 既是主键又是**给用户看的章节号**（界面 `第${id}章`、提示词、导出文件名都用它）。
 * 于是 A 书写到第 2 章后，B 书点「新建章节」拿到的是 3 —— "每本书各自从 1 开始"
 * 这个直觉在 schema 层就不成立。第 17 条的临时处理是"跳过已被占用的号"，
 * 不炸，但号不体面，而且 B 书永远看不到自己的第 1 章。
 *
 * 这一条钉的是换完主键之后的四件事：
 *   A. schema 形状：复合主键、两张子表补 project_id、复合外键与级联仍在；
 *   B. 升级路径：已有的 v8 库（单列主键）迁上来一行不丢、正文与指标原样；
 *   C. repo 语义：每个按章取数的入口都吃 (projectId, chapterId)，
 *      拿错项目当"章节不存在"处理，绝不静默读到另一本书的同号码章；
 *   D. 回归钉：两本书各自从 1 建到 3，互不影响（修复前第二本从 4 开始）。
 *
 * B 组的旧库 fixture 是**手抄的 v1/v2 DDL**，不是从 MIGRATIONS 里取的：
 * 迁移只增不改，已发布的迁移将来若被改写，这条测试仍按当时的真实形状验收。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo } from '@main/db/repos/daily-write-repo';

const LEGACY_DDL = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root_dir TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    target_words INTEGER NOT NULL DEFAULT 0, price_per_k INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE volumes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, ord INTEGER NOT NULL
  );
  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '', volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL,
    ord INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
    char_count INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE chapter_bodies (
    chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE chapter_metrics (
    chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
    chars INTEGER NOT NULL, paras INTEGER NOT NULL, sents INTEGER NOT NULL,
    avg_sent REAL NOT NULL, sent_cv REAL NOT NULL, avg_para REAL NOT NULL,
    sents_per_para REAL NOT NULL, ttr REAL NOT NULL, bigram_ttr REAL NOT NULL,
    tri_repeat REAL NOT NULL, dialog_ratio REAL NOT NULL, score REAL NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE TABLE daily_writes (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    day TEXT NOT NULL, delta_chars INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, day)
  );
  -- ★ runs 从 v2 就存在，真·v8 库里一定有这张表。这份"旧库"以前只造了本条迁移
  --   用得上的六张表，结果任何后续迁移只要合法地碰 runs 就会在这里假失败——
  --   §4 第 26 条的 v10 加列就是这么撞上的。补齐保真度，而不是把迁移写成带眼识人。
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    goal TEXT NOT NULL, status TEXT NOT NULL, termination TEXT, stats_json TEXT,
    kept_changes INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL, ended_at INTEGER
  );
`;

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/** 造一个"已经跑完 v8、还没跑本次迁移"的旧库 */
function legacyDb(): DB {
  const db = new Database(':memory:');
  db.exec(LEGACY_DDL);
  db.pragma('user_version = 8');
  return db;
}

function tableSql(db: DB, name: string): string {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
    | { sql: string }
    | undefined;
  return (r?.sql ?? '').replace(/\s+/g, ' ');
}

function fkPairs(db: DB, table: string): Array<{ from: string; to: string; onDelete: string }> {
  const rows = db.pragma(`foreign_key_list(${table})`) as Array<{
    seq: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  return rows.map((r) => ({ from: r.from, to: r.to, onDelete: r.on_delete }));
}

function columns(db: DB, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function metricsRow(chapterId: string, score: number): Record<string, unknown> {
  return {
    chapter_id: chapterId,
    chars: 100, paras: 10, sents: 20, avg_sent: 5, sent_cv: 0.1, avg_para: 10,
    sents_per_para: 2, ttr: 0.4, bigram_ttr: 0.3, tri_repeat: 0.01,
    dialog_ratio: 0.2, score, computed_at: 1_700_000_000_000,
  };
}

function insertMetrics(db: DB, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO chapter_metrics(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
}

describe('A. schema 形状：主键与外键都带上项目维度', () => {
  let db: DB;
  let projects: ProjectRepo;
  let pid: string;
  let otherPid: string;

  beforeEach(() => {
    db = freshDb();
    projects = new ProjectRepo(db);
    pid = projects.create('A 书', '/tmp/a').id;
    otherPid = projects.create('B 书', '/tmp/b').id;
  });

  it('chapters 的主键是 (project_id, id)，不再是单列 id', () => {
    expect(tableSql(db, 'chapters')).toMatch(/PRIMARY KEY \(\s*project_id\s*,\s*id\s*\)/i);
  });

  it('★ 两本书可以各有一个第 1 章（修复前这里直接撞 UNIQUE）', () => {
    const ins = db.prepare(
      'INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) ' +
        "VALUES(?,?,'',NULL,0,'draft',0,1,1700000000000)",
    );
    expect(() => {
      ins.run('1', pid);
      ins.run('1', otherPid);
    }).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number }).n).toBe(2);
  });

  it('同一本书里同号仍然被拦住（复合主键不是取消唯一性，是把唯一性收进书内）', () => {
    const ins = db.prepare(
      'INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) ' +
        "VALUES(?,?,'',NULL,0,'draft',0,1,1700000000000)",
    );
    ins.run('1', pid);
    expect(() => ins.run('1', pid)).toThrow();
  });

  it('chapter_bodies 带上 project_id，主键是 (project_id, chapter_id)', () => {
    expect(columns(db, 'chapter_bodies')).toContain('project_id');
    expect(tableSql(db, 'chapter_bodies')).toMatch(/PRIMARY KEY \(\s*project_id\s*,\s*chapter_id\s*\)/i);
  });

  it('chapter_metrics 带上 project_id，主键是 (project_id, chapter_id)', () => {
    expect(columns(db, 'chapter_metrics')).toContain('project_id');
    expect(tableSql(db, 'chapter_metrics')).toMatch(/PRIMARY KEY \(\s*project_id\s*,\s*chapter_id\s*\)/i);
  });

  it('两张子表的外键都指向 chapters(project_id, id) 且仍 ON DELETE CASCADE', () => {
    for (const t of ['chapter_bodies', 'chapter_metrics']) {
      const pairs = fkPairs(db, t);
      expect(pairs.length, `${t} 的外键必须是复合的`).toBe(2);
      const byFrom = Object.fromEntries(pairs.map((p) => [p.from, p]));
      expect(byFrom.project_id, `${t} 必须按 project_id 关联`).toMatchObject({ to: 'project_id', onDelete: 'CASCADE' });
      expect(byFrom.chapter_id, `${t} 必须按 chapter_id 关联`).toMatchObject({ to: 'id', onDelete: 'CASCADE' });
    }
  });

  it('删掉一本书 → 它的章、正文、指标一起走；另一本书同号的那份留着', () => {
    const now = 1_700_000_000_000;
    const seed = (p: string): void => {
      db.prepare(
        'INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) ' +
          "VALUES('1',?, '第一章', NULL, 0, 'draft', 3, 1, ?)",
      ).run(p, now);
      db.prepare('INSERT INTO chapter_bodies(project_id, chapter_id, body) VALUES(?,?,?)').run(p, '1', '正文');
      insertMetrics(db, { project_id: p, ...metricsRow('1', 50) });
    };
    seed(pid);
    seed(otherPid);

    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);

    expect((db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE project_id = ?').get(pid) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM chapter_bodies WHERE project_id = ?').get(pid) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM chapter_metrics WHERE project_id = ?').get(pid) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT body FROM chapter_bodies WHERE project_id = ? AND chapter_id = ?').get(otherPid, '1') as { body: string }).body).toBe('正文');
  });
});

describe('B. 升级：已有的 v8 库迁上来一行不丢', () => {
  it('章、正文、指标原样保留，project_id 由 chapters 回填', () => {
    const db = legacyDb();
    const now = 1_700_000_000_000;
    const p = db.prepare(
      "INSERT INTO projects(id, name, root_dir, created_at, updated_at, target_words, price_per_k) VALUES('p1','旧书','/tmp/o',1,1,0,0)",
    ).run().lastInsertRowid;
    expect(p).toBeDefined();
    db.prepare(
      'INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) ' +
        "VALUES('1','p1','第一章',NULL,0,'draft',7,3,?)",
    ).run(now);
    db.prepare("INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) " +
      "VALUES('2','p1','第二章',NULL,1,'draft',0,1,?)").run(now);
    db.prepare("INSERT INTO chapter_bodies(chapter_id, body) VALUES('1','第一章的正文')").run();
    insertMetrics(db, metricsRow('2', 42));

    migrate(db);

    const ch = db.prepare("SELECT * FROM chapters WHERE id='1' AND project_id='p1'").get() as Record<string, unknown>;
    expect(ch).toMatchObject({ title: '第一章', ord: 0, status: 'draft', char_count: 7, rev: 3, updated_at: now });
    const body = db.prepare("SELECT body FROM chapter_bodies WHERE project_id='p1' AND chapter_id='1'").get() as
      | { body: string }
      | undefined;
    expect(body?.body).toBe('第一章的正文');
    const met = db.prepare("SELECT score FROM chapter_metrics WHERE project_id='p1' AND chapter_id='2'").get() as
      | { score: number }
      | undefined;
    expect(met?.score).toBe(42);
    // 没正文的章仍然在（不能因为 JOIN 丢行）
    expect((db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE id='2'").get() as { n: number }).n).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(9);
  });

  it('迁移可重复执行（幂等），跑第二次不报错也不改数据', () => {
    const db = legacyDb();
    db.prepare(
      "INSERT INTO projects(id, name, root_dir, created_at, updated_at, target_words, price_per_k) VALUES('p1','旧书','/tmp/o',1,1,0,0)",
    ).run();
    db.prepare(
      'INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) ' +
        "VALUES('1','p1','第一章',NULL,0,'draft',0,1,1)",
    ).run();
    db.prepare("INSERT INTO chapter_bodies(chapter_id, body) VALUES('1','留着')").run();

    migrate(db);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM chapter_bodies').get() as { n: number }).n;
    migrate(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM chapter_bodies').get() as { n: number }).n).toBe(before);
    expect((db.prepare("SELECT body FROM chapter_bodies WHERE project_id='p1' AND chapter_id='1'").get() as { body: string }).body).toBe('留着');
  });

  it('旧库里的孤儿正文（章已删但正文残留）不会被静默塞进某一本书', () => {
    const db = legacyDb();
    db.prepare(
      "INSERT INTO projects(id, name, root_dir, created_at, updated_at, target_words, price_per_k) VALUES('p1','旧书','/tmp/o',1,1,0,0)",
    ).run();
    // 关外键才能造孤儿：真实库里可能因为历史 bug 存在
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO chapter_bodies(chapter_id, body) VALUES('ghost','孤儿正文')").run();
    db.pragma('foreign_keys = ON');

    migrate(db);

    const n = (db.prepare("SELECT COUNT(*) AS n FROM chapter_bodies WHERE chapter_id='ghost'").get() as { n: number }).n;
    expect(n, '回填不到项目的正文不许被编派给随便一本书').toBe(0);
  });

  it('★ 章指向已被删掉的项目（手工改库才会出现）→ 迁移整体失败并回滚，不留下半迁移的库', () => {
    // 应用自己从不删项目也不删章（全仓 `DELETE FROM projects`/`chapters` 零调用方），
    // 所以这一形状只可能来自手工改库。钉它不是为了支持它，而是把后果写清楚：
    // 新表带着 REFERENCES projects(id) 的外键，插不进去就整条迁移回滚 ——
    // **库还是 v8 的原样**，不是"迁到一半、正文表已被删"。宁可起不来，也不许丢稿。
    const db = legacyDb();
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) " +
        "VALUES('1','p_ghost','无主的章',NULL,0,'draft',3,1,1)",
    ).run();
    db.prepare("INSERT INTO chapter_bodies(chapter_id, body) VALUES('1','正文还留着')").run();
    db.pragma('foreign_keys = ON');

    expect(() => migrate(db)).toThrow();

    // 回滚彻底：版本没前进、三张表都还是旧形状、数据一行没少
    expect(db.pragma('user_version', { simple: true })).toBe(8);
    expect(tableSql(db, 'chapters')).not.toMatch(/PRIMARY KEY \(\s*project_id/i);
    expect(columns(db, 'chapter_bodies')).not.toContain('project_id');
    expect((db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM chapter_bodies').get() as { n: number }).n).toBe(1);
  });

  it('★ 真实数据形状（非数字章号、带引号换行 emoji 的正文）逐字保留，外键无残留违例', () => {
    // 这条是从"拿真实库副本跑迁移"的验收探针沉淀下来的：探针只能跑一次，
    // 断言要留在库里。当时真库是 v7（还没有 daily_writes），一次跑到 v9，
    // 3 章 / 2 条正文 / 2 条指标一行不丢，1 条孤儿正文按设计丢弃。
    const db = legacyDb();
    const now = 1_700_000_000_000;
    db.prepare(
      "INSERT INTO projects(id, name, root_dir, created_at, updated_at, target_words, price_per_k) VALUES('p1','旧书','/tmp/o',1,1,0,0)",
    ).run();
    const ins = db.prepare(
      'INSERT INTO chapters(id, project_id, title, volume_id, ord, status, char_count, rev, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    ins.run('楔子', 'p1', '开天', null, 0, 'done', 12, 4, now);
    ins.run('1', 'p1', "第一章 '引号\"和\\反斜杠'", null, 1, 'draft', 30, 2, now);
    ins.run('10.5', 'p1', '插章', null, 2, 'todo', 0, 1, now);
    const insBody = db.prepare('INSERT INTO chapter_bodies(chapter_id, body) VALUES(?,?)');
    const tricky = '天地混沌。\n\n第二段落“弯引号”。\n🐉 emoji 结尾';
    insBody.run('楔子', tricky);
    insBody.run('1', '　　全角空格开头，mixed 正文。\n\n');
    insBody.run('10.5', '');
    db.prepare(
      'INSERT INTO chapter_metrics(chapter_id, chars, paras, sents, avg_sent, sent_cv, avg_para, sents_per_para, ' +
        'ttr, bigram_ttr, tri_repeat, dialog_ratio, score, computed_at) ' +
        "VALUES('楔子',12,2,3,4,0.1,6,1.5,0.4,0.3,0.01,0.2,37,?)",
    ).run(now);

    migrate(db);

    expect(
      (db.prepare('SELECT body FROM chapter_bodies WHERE project_id=? AND chapter_id=?').get('p1', '楔子') as {
        body: string;
      }).body,
    ).toBe(tricky);
    expect(
      (db.prepare('SELECT title FROM chapters WHERE project_id=? AND id=?').get('p1', '1') as { title: string }).title,
    ).toBe("第一章 '引号\"和\\反斜杠'");
    // 空正文与小数章号都还在（JOIN 回填不许把边缘行挤掉）
    expect(
      (db.prepare('SELECT body FROM chapter_bodies WHERE project_id=? AND chapter_id=?').get('p1', '10.5') as {
        body: string;
      }).body,
    ).toBe('');
    expect((db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number }).n).toBe(3);
    expect((db.prepare('SELECT score FROM chapter_metrics WHERE project_id=? AND chapter_id=?').get('p1', '楔子') as {
      score: number;
    }).score).toBe(37);
    // 迁移完不留外键违例：违例清单必须为空
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});

describe('C. repo 语义：每个入口都吃 (projectId, chapterId)', () => {
  let db: DB;
  let projects: ProjectRepo;
  let chapters: ChapterRepo;
  let pid: string;
  let otherPid: string;

  beforeEach(() => {
    db = freshDb();
    projects = new ProjectRepo(db);
    const daily = new DailyWriteRepo(db);
    chapters = new ChapterRepo(db, daily);
    pid = projects.create('A 书', '/tmp/a').id;
    otherPid = projects.create('B 书', '/tmp/b').id;
  });

  it('★ 两本书同号：各自读到各自的正文', () => {
    chapters.insert({ id: '1', projectId: pid, title: 'A1', volumeId: null, order: 0, status: 'draft', body: '甲的第一章' });
    chapters.insert({ id: '1', projectId: otherPid, title: 'B1', volumeId: null, order: 0, status: 'draft', body: '乙的第一章' });
    expect(chapters.getBody(pid, '1')).toBe('甲的第一章');
    expect(chapters.getBody(otherPid, '1')).toBe('乙的第一章');
  });

  it('★ 拿错项目 = 章节不存在，而不是静默读到另一本书', () => {
    chapters.insert({ id: '1', projectId: pid, title: 'A1', volumeId: null, order: 0, status: 'draft', body: '甲' });
    expect(chapters.getBody(otherPid, '1')).toBeNull();
    expect(chapters.get(otherPid, '1')).toBeNull();
    expect(() => chapters.updateBody(otherPid, '1', '篡改', 1)).toThrow(/章节不存在/);
    expect(chapters.getBody(pid, '1')).toBe('甲');
  });

  it('getBodies 只返回本项目的正文（批扫描不能串书）', () => {
    chapters.insert({ id: '1', projectId: pid, title: 'A1', volumeId: null, order: 0, status: 'draft', body: '甲1' });
    chapters.insert({ id: '1', projectId: otherPid, title: 'B1', volumeId: null, order: 0, status: 'draft', body: '乙1' });
    const got = chapters.getBodies(pid, ['1']);
    expect([...got.values()]).toEqual(['甲1']);
  });

  it('updateBody 落在正确的那本书上，rev 与字数照常', () => {
    const a = chapters.insert({ id: '1', projectId: pid, title: 'A1', volumeId: null, order: 0, status: 'draft', body: '甲' });
    chapters.insert({ id: '1', projectId: otherPid, title: 'B1', volumeId: null, order: 0, status: 'draft', body: '乙' });
    const m = chapters.updateBody(pid, '1', '一二三四五', a.rev);
    expect(m.rev).toBe(2);
    expect(m.charCount).toBe(5);
    expect(chapters.getBody(pid, '1')).toBe('一二三四五');
    expect(chapters.getBody(otherPid, '1')).toBe('乙');
  });

  it('setVolume 不许跨书改；同号的另一本书不受影响', () => {
    chapters.insert({ id: '1', projectId: pid, title: 'A1', volumeId: null, order: 0, status: 'draft', body: '甲' });
    chapters.insert({ id: '1', projectId: otherPid, title: 'B1', volumeId: null, order: 0, status: 'draft', body: '乙' });
    const vol = projects.createVolume(pid, '第一卷').id;
    expect(chapters.setVolume(pid, '1', vol).volumeId).toBe(vol);
    expect(chapters.setVolume(otherPid, '1', null).volumeId).toBeNull();
    expect(() => chapters.setVolume(otherPid, '1', vol)).toThrow();
  });

  it('指标缓存按书隔离：同号码的两章各存一份', () => {
    chapters.insert({ id: '1', projectId: pid, title: 'A1', volumeId: null, order: 0, status: 'draft', body: '甲' });
    chapters.insert({ id: '1', projectId: otherPid, title: 'B1', volumeId: null, order: 0, status: 'draft', body: '乙' });
    chapters.saveMetrics({ projectId: pid, chapterId: '1', chars: 1, paras: 1, sents: 1, avgSent: 1, sentCv: 0, avgPara: 1, sentsPerPara: 1, ttr: 0.1, bigramTtr: 0.1, triRepeat: 0, dialogRatio: 0, score: 11, computedAt: 1 });
    chapters.saveMetrics({ projectId: otherPid, chapterId: '1', chars: 1, paras: 1, sents: 1, avgSent: 1, sentCv: 0, avgPara: 1, sentsPerPara: 1, ttr: 0.1, bigramTtr: 0.1, triRepeat: 0, dialogRatio: 0, score: 22, computedAt: 1 });
    expect(chapters.getMetrics(pid, '1')?.score).toBe(11);
    expect(chapters.getMetrics(otherPid, '1')?.score).toBe(22);
  });

  it('改正文只作废本项目那章的指标', () => {
    chapters.insert({ id: '1', projectId: pid, title: 'A1', volumeId: null, order: 0, status: 'draft', body: '甲' });
    chapters.insert({ id: '1', projectId: otherPid, title: 'B1', volumeId: null, order: 0, status: 'draft', body: '乙' });
    const mk = (p: string): Record<string, unknown> => ({ projectId: p, chapterId: '1', chars: 1, paras: 1, sents: 1, avgSent: 1, sentCv: 0, avgPara: 1, sentsPerPara: 1, ttr: 0.1, bigramTtr: 0.1, triRepeat: 0, dialogRatio: 0, score: 5, computedAt: 1 });
    chapters.saveMetrics(mk(pid) as never);
    chapters.saveMetrics(mk(otherPid) as never);
    const m = chapters.get(pid, '1')!.meta;
    chapters.updateBody(pid, '1', '甲甲', m.rev);
    expect(chapters.getMetrics(pid, '1')).toBeNull();
    expect(chapters.getMetrics(otherPid, '1')?.score).toBe(5);
  });
});

describe('D. 章节号各自从 1 开始（第 17 条临时语义的回归钉）', () => {
  let db: DB;
  let projects: ProjectRepo;
  let chapters: ChapterRepo;
  let pid: string;
  let otherPid: string;

  beforeEach(() => {
    db = freshDb();
    projects = new ProjectRepo(db);
    chapters = new ChapterRepo(db, new DailyWriteRepo(db));
    pid = projects.create('A 书', '/tmp/a').id;
    otherPid = projects.create('B 书', '/tmp/b').id;
  });

  it('★ A 书已有 1/2/3，B 书新建第一章拿到的仍是 1（修复前是 4）', () => {
    chapters.createChapter(pid, { title: 'A1' });
    chapters.createChapter(pid, { title: 'A2' });
    chapters.createChapter(pid, { title: 'A3' });
    expect(chapters.createChapter(otherPid, { title: 'B1' }).id).toBe('1');
    expect(chapters.listMeta(pid).map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(chapters.listMeta(otherPid).map((c) => c.id)).toEqual(['1']);
  });

  it('两本书并行往下建，号互不干扰', () => {
    expect([chapters.createChapter(pid, {}).id, chapters.createChapter(otherPid, {}).id]).toEqual(['1', '1']);
    expect([chapters.createChapter(pid, {}).id, chapters.createChapter(otherPid, {}).id]).toEqual(['2', '2']);
  });

  it('本项目内的最大号 +1 仍然成立（含 10.5 这类小数插章号）', () => {
    chapters.insert({ id: '1', projectId: pid, title: '一', volumeId: null, order: 0, status: 'draft', body: '' });
    chapters.insert({ id: '10.5', projectId: pid, title: '插', volumeId: null, order: 1, status: 'draft', body: '' });
    expect(chapters.createChapter(pid, { title: '新' }).id).toBe('11.5');
  });

  it('别的项目占过的号不再影响本项目（旧逻辑的全局 taken 集合作废）', () => {
    chapters.insert({ id: '1', projectId: otherPid, title: '别人的第一章', volumeId: null, order: 0, status: 'draft', body: '' });
    expect(chapters.createChapter(pid, { title: '我的第一章' }).id).toBe('1');
  });

  it('日增量仍然只算到自己那本书上', () => {
    chapters.createChapter(pid, { title: 'A1' });
    const b = chapters.createChapter(otherPid, { title: 'B1' });
    chapters.updateBody(otherPid, b.id, '一二三', b.rev);
    const daily = new DailyWriteRepo(db);
    expect(daily.summary(otherPid).today).toBe(3);
    expect(daily.summary(pid).today).toBe(0);
  });
});
