/**
 * §4 第 26 条：run 的**读侧**（未闭合检测 + 一次性提示）。
 *
 * ★ 实测到的修复前事实：
 *   - `runs` 表只在 `loop.run()` **返回之后**被写一次（`host.ts` 的 saveRun），
 *     所以应用被强杀时那一行**根本不存在**——「上次有 run 没走到收尾」在数据上无痕。
 *   - `project:open` 里那段 T24「未闭合必须提示，不静默」判据是
 *     `agentHost.listRuns().filter(r => r.status !== 'terminated')`，而那张进程内 map
 *     **全仓只读不写** ⇒ 判据恒空 ⇒ 提示一次都没发过；何况进程内的 map 本来也看不见「上次」。
 *   - `RunState.startedAt` 在 `loop.ts` 的 state getter 里**硬写 0**，
 *     于是 started_at 全靠落库那一刻补 Date.now()，历史列表按它排序等于在排一堆零。
 *
 * 语义选择（写下来免得后人以为随手如此）：
 *   · 「未闭合」= `status <> 'terminated'`。**不**把报过的那行改成 terminated——
 *     那条 run 确实没走到收尾，历史里就该留着一个非 terminated 的状态。
 *   · 「报过没报过」单独记在 `unclosed_reported_at`（迁移 v10）。
 *     用它而不是复用 ended_at：ended_at 的语义是「run 什么时候结束」，
 *     而强杀的 run 结束时刻是**未知的**，把我们「哪天注意到的」写进去是造一个假时间。
 *   · 一次性提示：报过之后不再重复弹。否则强杀一次，此后每次开项目都弹同一条，
 *     比不弹更糟——用户会以为每次都崩了一回。
 *   · stats_json 解不开时给**零值**而不是抛：这条只服务于一句提示，
 *     不该因为一条旧行结构不全就打不开项目。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import { RunRepo } from '@main/db/repos/run-repo';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/** 直接按 runs 的列写一行，绕过 host（这里要验的是读侧口径，不是循环） */
function insertRun(
  db: DB,
  over: {
    id: string;
    project: string;
    status?: string;
    startedAt?: number;
    stats?: string | null;
    kept?: number;
  },
): void {
  db.prepare(
    'INSERT INTO runs(id, project_id, goal, status, termination, stats_json, kept_changes, started_at, ended_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    over.id,
    over.project,
    `目标：${over.id}`,
    over.status ?? 'executing',
    over.status === 'terminated' ? JSON.stringify({ code: 'MAX_STEPS', used: 3, limit: 3 }) : null,
    over.stats === undefined ? JSON.stringify({ steps: 2, tokensIn: 10, tokensOut: 5 }) : over.stats,
    over.kept ?? 1,
    over.startedAt ?? 1000,
    over.status === 'terminated' ? 2000 : null,
  );
}

describe('A. 什么算「未闭合」', () => {
  let db: DB;
  let repo: RunRepo;
  let p1: string;
  let p2: string;
  beforeEach(() => {
    db = freshDb();
    const pr = new ProjectRepo(db);
    p1 = pr.create('书一', '/tmp/p1').id;
    p2 = pr.create('书二', '/tmp/p2').id;
    repo = new RunRepo(db);
  });

  it('status 不是 terminated 的查得到，terminated 的一条都不回', () => {
    insertRun(db, { id: 'r_open', project: p1, status: 'executing' });
    insertRun(db, { id: 'r_done', project: p1, status: 'terminated' });
    const got = repo.listUnclosed(p1);
    expect(got.map((r) => r.runId)).toEqual(['r_open']);
  });

  it('只回本项目，别项目的未闭合不许串过来', () => {
    insertRun(db, { id: 'r_p2', project: p2, status: 'idle' });
    insertRun(db, { id: 'r_p1', project: p1, status: 'idle' });
    expect(repo.listUnclosed(p1).map((r) => r.runId)).toEqual(['r_p1']);
    expect(repo.listUnclosed(p2).map((r) => r.runId)).toEqual(['r_p2']);
  });

  it('新的在前（历史提示该说最近那次中断）', () => {
    insertRun(db, { id: 'r_old', project: p1, startedAt: 1000 });
    insertRun(db, { id: 'r_new', project: p1, startedAt: 2000 });
    expect(repo.listUnclosed(p1).map((r) => r.runId)).toEqual(['r_new', 'r_old']);
  });

  it('没打开过项目 / 库里没行时返回空数组而不是抛', () => {
    expect(repo.listUnclosed('p_none')).toEqual([]);
  });
});

describe('B. 报过一次就不许再报（一次性提示）', () => {
  let db: DB;
  let repo: RunRepo;
  let p1: string;
  beforeEach(() => {
    db = freshDb();
    const pr = new ProjectRepo(db);
    p1 = pr.create('书一', '/tmp/p1').id;
    repo = new RunRepo(db);
  });

  it('markReported 之后 listUnclosed 不再回这一行', () => {
    insertRun(db, { id: 'r1', project: p1 });
    expect(repo.listUnclosed(p1).length).toBe(1);

    repo.markReported('r1', 5000);
    expect(repo.listUnclosed(p1)).toEqual([]);
  });

  it('只改这一行：同项目另一条未闭合的还得在', () => {
    insertRun(db, { id: 'r1', project: p1 });
    insertRun(db, { id: 'r2', project: p1 });
    repo.markReported('r1', 5000);
    expect(repo.listUnclosed(p1).map((r) => r.runId)).toEqual(['r2']);
  });

  it('重复标记是幂等的，且不把 status 伪造成 terminated', () => {
    insertRun(db, { id: 'r1', project: p1, status: 'executing' });
    repo.markReported('r1', 5000);
    repo.markReported('r1', 9000);
    const row = db.prepare('SELECT status, ended_at, unclosed_reported_at FROM runs WHERE id = ?').get('r1') as {
      status: string;
      ended_at: number | null;
      unclosed_reported_at: number | null;
    };
    // 那条 run 确实没走到收尾——历史上就该留着这个事实
    expect(row.status).toBe('executing');
    expect(row.ended_at, '不许把「注意到的时刻」伪造成结束时刻').toBeNull();
    expect(row.unclosed_reported_at).toBe(5000);
  });

  it('标记一个不存在的 runId 不抛、也不影响别的行', () => {
    insertRun(db, { id: 'r1', project: p1 });
    expect(() => repo.markReported('ghost', 1)).not.toThrow();
    expect(repo.listUnclosed(p1).length).toBe(1);
  });
});

describe('C. 读出来的字段必须够用且诚实', () => {
  let db: DB;
  let repo: RunRepo;
  let p1: string;
  beforeEach(() => {
    db = freshDb();
    const pr = new ProjectRepo(db);
    p1 = pr.create('书一', '/tmp/p1').id;
    repo = new RunRepo(db);
  });

  it('stats_json 正常时把 steps / edits 带出来（提示要说「停在第几步、改了多少」）', () => {
    insertRun(db, {
      id: 'r1',
      project: p1,
      stats: JSON.stringify({ steps: 7, tokensIn: 100, tokensOut: 50, costCny: 0.2, wallMs: 900, toolCalls: 6, edits: 3, checkpoints: 2 }),
      kept: 3,
    });
    const [r] = repo.listUnclosed(p1);
    expect(r!.stats.steps).toBe(7);
    expect(r!.stats.edits).toBe(3);
    expect(r!.keptChanges).toBe(3);
    expect(r!.goal).toContain('r1');
  });

  it('stats_json 是坏 JSON 或 null 时给零值，不抛也不编数', () => {
    insertRun(db, { id: 'r_bad', project: p1, stats: '{不是json' });
    insertRun(db, { id: 'r_null', project: p1, stats: null });
    const got = repo.listUnclosed(p1);
    expect(got.length).toBe(2);
    for (const r of got) {
      expect(r!.stats.steps).toBe(0);
      expect(r!.stats.costCny).toBe(0);
    }
  });

  it('缺字段的老结构补齐零值，已有字段照抄（提示不能因为版本差就崩）', () => {
    insertRun(db, { id: 'r_partial', project: p1, stats: JSON.stringify({ steps: 4 }) });
    const [r] = repo.listUnclosed(p1);
    expect(r!.stats.steps).toBe(4);
    expect(r!.stats.toolCalls).toBe(0);
    expect(r!.stats.checkpoints).toBe(0);
  });
});

describe('D. 迁移 v10 必须是加列，不动老数据', () => {
  it('跑完迁移的版本号至少 10，且 runs 有新列', () => {
    const db = freshDb();
    expect(currentVersion(db)).toBeGreaterThanOrEqual(10);
    const cols = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('unclosed_reported_at');
  });

  it('老库（v10 之前建的行）升级后 unclosed_reported_at 为 null ⇒ 仍会被提示一次', () => {
    const db = new Database(':memory:');
    // 手工造一个 v10 之前的 runs 表 + 一行未闭合数据
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, termination TEXT, stats_json TEXT,
        kept_changes INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, ended_at INTEGER
      );
      INSERT INTO runs(id, project_id, goal, status, kept_changes, started_at)
        VALUES('r_legacy','p1','旧行','executing',2,123);
      PRAGMA user_version = 9;
    `);
    migrate(db);
    const repo = new RunRepo(db);
    const got = repo.listUnclosed('p1');
    expect(got.map((r) => r.runId)).toEqual(['r_legacy']);
    expect(got[0]!.keptChanges).toBe(2);
    expect(currentVersion(db)).toBeGreaterThanOrEqual(10);
  });
});
