// tests/unit/teardown-repo.test.ts —— 报告 insert/get/list + setDimensions
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { TeardownRepo } from '@main/db/repos/teardown-repo';

let db: ReturnType<typeof Database>;
let repo: TeardownRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new TeardownRepo(db); });

describe('TeardownRepo', () => {
  it('insert 落 structure，dimensions 初始 null', () => {
    const r = repo.insert({ bookTitle: '范文', structure: { bench: { chars: 100 } } });
    expect(r.dimensions).toBeNull();
    expect(repo.get(r.id)?.bookTitle).toBe('范文');
  });
  it('setDimensions 写八维并回读', () => {
    const r = repo.insert({ bookTitle: '范文', structure: {} });
    const dims = { 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' };
    expect(repo.setDimensions(r.id, dims).dimensions).toEqual(dims);
  });
});
