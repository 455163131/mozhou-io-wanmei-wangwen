/**
 * 基线仓储回归测试（真实内存库，不 mock）。
 *
 * ★ 为什么必须连真库跑：本用例守护的是一个**实跑复现出来的 bug**——
 *   `created_at` 是毫秒时间戳，同一毫秒内连存两条会并列，此时
 *   `ORDER BY created_at DESC` 结果不确定，`latest()` 会取到**旧的那条**。
 *   用 mock 测不出这种「同毫秒并列」的真实行为，只有真库能暴露。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { FlavorBaselineRepo } from '@main/db/repos/flavor-baseline-repo';
import { DEFAULT_FLAVOR_BASELINE } from '@shared/ai-flavor/baseline';

const PID = 'proj_test';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('FlavorBaselineRepo · 基于真库的回归', () => {
  let db: DB;
  let repo: FlavorBaselineRepo;
  beforeEach(() => {
    db = freshDb();
    repo = new FlavorBaselineRepo(db);
  });

  it('迁移到 v7 且建出 flavor_baselines 表与索引', () => {
    expect(currentVersion(db)).toBe(7);
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flavor_baselines'")
      .get();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_flavor_baselines_project'")
      .get();
    expect(tbl).toBeTruthy();
    expect(idx).toBeTruthy();
  });

  it('空项目：latest 为 null、list 为空、remove 不存在返回 false', () => {
    expect(repo.latest(PID)).toBeNull();
    expect(repo.list(PID)).toHaveLength(0);
    expect(repo.remove('nope')).toBe(false);
  });

  it('★ 同毫秒连存两条，latest 必须取到最后插入的一条（次序稳定）', () => {
    // 连续两次 save 极大概率落在同一毫秒——正是历史 bug 的触发条件
    const userA = { ...DEFAULT_FLAVOR_BASELINE, corpus: '语料A', source: 'user' as const };
    const userB = { ...DEFAULT_FLAVOR_BASELINE, corpus: '语料B', source: 'user' as const };
    const idA = repo.save(PID, userA);
    const idB = repo.save(PID, userB);

    const latest = repo.latest(PID);
    expect(latest?.id).toBe(idB);
    expect(latest?.corpus).toBe('语料B');

    const list = repo.list(PID, 10);
    expect(list.map((b) => b.id)).toEqual([idB, idA]);
  });

  it('save 返回 flb_ 前缀主键，且展开后仍是完整 FlavorBaseline', () => {
    const id = repo.save(PID, { ...DEFAULT_FLAVOR_BASELINE, source: 'user' });
    expect(id.startsWith('flb_')).toBe(true);
    const got = repo.latest(PID);
    expect(got?.id).toBe(id);
    expect(got?.projectId).toBe(PID);
    expect(typeof got?.createdAt).toBe('number');
    expect(got?.metrics.sent_cv.p50).toBe(0.558);
    expect(Object.keys(got?.metrics ?? {})).toHaveLength(11);
  });

  it('项目隔离：不同 project_id 互不可见', () => {
    repo.save('p1', { ...DEFAULT_FLAVOR_BASELINE, source: 'user' });
    expect(repo.latest('p2')).toBeNull();
    expect(repo.list('p2')).toHaveLength(0);
  });

  it('remove 生效并返回 true，删后 latest 回退到上一条', () => {
    const idA = repo.save(PID, { ...DEFAULT_FLAVOR_BASELINE, corpus: 'A', source: 'user' });
    const idB = repo.save(PID, { ...DEFAULT_FLAVOR_BASELINE, corpus: 'B', source: 'user' });
    expect(repo.remove(idB)).toBe(true);
    expect(repo.latest(PID)?.id).toBe(idA);
    expect(repo.remove(idB)).toBe(false); // 已删，再删返回 false
  });

  it('重复 migrate 幂等：版本不再前进，数据不丢', () => {
    repo.save(PID, { ...DEFAULT_FLAVOR_BASELINE, source: 'user' });
    migrate(db);
    expect(currentVersion(db)).toBe(7);
    expect(repo.list(PID)).toHaveLength(1);
  });
});
