// tests/unit/staging-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { StagingRepo } from '@main/db/repos/staging-repo';

let db: ReturnType<typeof Database>; let st: StagingRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); st = new StagingRepo(db); });

describe('StagingRepo 状态机', () => {
  it('upsertStaged 新行 publishedAt=null；重复 stage 换 hash 不换 id', () => {
    const a = st.upsertStaged('pl-1', '3', 'hashA');
    const b = st.upsertStaged('pl-1', '3', 'hashB');
    expect(b.id).toBe(a.id);
    expect(b.contentHash).toBe('hashB');
    expect(st.listByPlan('pl-1')).toHaveLength(1);
  });
  it('markPublished：只从 null→now；重复调用幂等回原值', () => {
    st.upsertStaged('pl-1', '3', 'hashA');
    const m = st.markPublished('pl-1', '3');
    expect(m.publishedAt).not.toBeNull();
    expect(st.markPublished('pl-1', '3').publishedAt).toBe(m.publishedAt);
  });
  it('未暂存的章不许 mark → E_STAGING_STATE', () => {
    expect(() => st.markPublished('pl-1', '99')).toThrowError(/E_STAGING_STATE|未暂存/);
  });
  it('已发布章不许悄悄换稿 → upsertStaged 抛 E_STAGING_STATE', () => {
    st.upsertStaged('pl-1', '3', 'hashA');
    st.markPublished('pl-1', '3');
    expect(() => st.upsertStaged('pl-1', '3', 'hashC')).toThrowError(/E_STAGING_STATE|已发布/);
  });
});
