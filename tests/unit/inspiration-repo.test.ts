// tests/unit/inspiration-repo.test.ts —— 卡片 CRUD + collected + 反重复历史
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import type { TrendPayload } from '@shared/types/inspiration';

let db: ReturnType<typeof Database>;
let repo: InspirationRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new InspirationRepo(db); });

describe('InspirationRepo', () => {
  it('insert 落库 collected=0；listByKind 只回该 kind', () => {
    repo.insert({ kind: 'trend', title: '书1', payload: { platform: '番茄', live: false }, sourceLabel: '番茄' });
    repo.insert({ kind: 'idea', title: '脑洞1', payload: { direction: '重生复仇', premise: 'p', temperature: 1.05, live: false }, sourceLabel: '重生复仇' });
    expect(repo.listByKind('trend')).toHaveLength(1);
    expect(repo.listByKind('idea')).toHaveLength(1);
    expect(repo.listByKind('trend')[0].collected).toBe(0);
  });
  it('setCollected 翻转收藏；listCollected 只回已收藏', () => {
    const c = repo.insert({ kind: 'trend', title: '书2', payload: { platform: '晋江', live: true }, sourceLabel: '晋江' });
    repo.setCollected(c.id, true);
    expect(repo.listCollected().map((x) => x.id)).toEqual([c.id]);
  });
  it('ideaHistory 回 direction+premise 摘要（反重复用）', () => {
    repo.insert({ kind: 'idea', title: 'i', payload: { direction: '系统流', premise: '觉醒系统', temperature: 1.05, live: true }, sourceLabel: '系统流' });
    expect(repo.ideaHistory()).toEqual([{ direction: '系统流', premise: '觉醒系统' }]);
  });
  it('remove 存在回 true 不存在回 false', () => {
    const c = repo.insert({ kind: 'teardown', title: '维', payload: { dimension: '节奏', summary: 's', bookTitle: 'b', reportId: 'r' }, sourceLabel: 'b' });
    expect(repo.remove(c.id)).toBe(true);
    expect(repo.remove('nope')).toBe(false);
  });
});

/* ── 裁决修复波 H3：批量幂等落卡必须整批一个事务，并回报「新增/命中」两个数 ──
 * 修复前的实测事实：trending:import / trending:fetch 逐条 autocommit 调 upsertTrend，
 * 第 150 条抛错时前 149 张卡**已经落库**，而 UI 只看到一条失败红字——用户以为
 * 全没落；同时返回值只有一个 entries 数组，重复导入 200 条旧数据也报「已导入 200 条」，
 * 实则 0 新增。半截状态与误导计数一并修。 */
describe('upsertTrends 批量事务（H3）', () => {
  const trend = (title: string, key: string): { title: string; payload: TrendPayload; sourceLabel: string } => ({
    title,
    payload: { platform: '番茄', live: false, manual: true, sourceKey: key },
    sourceLabel: '番茄·手动导入',
  });

  it('全部新卡 → inserted 计数等于条数、deduped 为 0，cards 顺序与入参一致', () => {
    const r = repo.upsertTrends([trend('书A', 'k1'), trend('书B', 'k2')]);
    expect(r).toMatchObject({ inserted: 2, deduped: 0 });
    expect(r.cards.map((c) => c.title)).toEqual(['书A', '书B']);
    expect(repo.listByKind('trend')).toHaveLength(2);
  });

  it('重复导入同 key → inserted 0 / deduped 2，且返回的是**旧卡原样**（卡=首抓快照）', () => {
    const first = repo.upsertTrends([trend('书A', 'k1'), trend('书B', 'k2')]);
    const again = repo.upsertTrends([trend('书A热度新', 'k1'), trend('书B热度新', 'k2')]);
    expect(again).toMatchObject({ inserted: 0, deduped: 2 });
    expect(again.cards.map((c) => c.id)).toEqual(first.cards.map((c) => c.id));
    expect(again.cards.map((c) => c.title)).toEqual(['书A', '书B']);
    expect(repo.listByKind('trend')).toHaveLength(2);
  });

  it('中途抛错 → 整批回滚，库里一张卡都不留（半截落库就是数据状态错）', () => {
    const boom = trend('书C', 'k3');
    // 循环引用让 insert 里的 JSON.stringify 抛 TypeError——模拟第 3 条真炸
    (boom.payload as unknown as { self?: unknown }).self = boom.payload;
    expect(() =>
      repo.upsertTrends([trend('书A', 'k1'), trend('书B', 'k2'), boom]),
    ).toThrowError();
    expect(repo.listByKind('trend'), '事务没生效：前两条已经落库了').toHaveLength(0);
  });

  it('回滚后库里干净，重新导入正常条目可继续（不留脏半批）', () => {
    const boom = trend('书C', 'k3');
    (boom.payload as unknown as { self?: unknown }).self = boom.payload;
    expect(() => repo.upsertTrends([trend('书A', 'k1'), boom])).toThrowError();
    const ok = repo.upsertTrends([trend('书A', 'k1'), trend('书D', 'k4')]);
    expect(ok.inserted).toBe(2); // 上一批整体回滚，所以 k1 这里仍是新增
  });
});
