// tests/unit/inspiration-repo.test.ts —— 卡片 CRUD + collected + 反重复历史
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';

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
