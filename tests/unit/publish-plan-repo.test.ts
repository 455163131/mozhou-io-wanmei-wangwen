// tests/unit/publish-plan-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { PublishPlanRepo } from '@main/db/repos/publish-plan-repo';

let db: ReturnType<typeof Database>; let plans: PublishPlanRepo;
const base = { projectId: 'p1', platform: 'webnovel', cadence: 'daily' as const, intervalDays: 1, startAt: 1730000000000 };
beforeEach(() => { db = new Database(':memory:'); migrate(db); plans = new PublishPlanRepo(db); });

describe('PublishPlanRepo', () => {
  it('新建回 active；同 id upsert 改值并动 updated_at，不并生新行', () => {
    const p = plans.upsert(base);
    const again = plans.upsert({ ...base, id: p.id, cadence: 'weekly', intervalDays: 7 });
    expect(again.id).toBe(p.id);
    expect(again.cadence).toBe('weekly');
    expect(plans.listByProject('p1')).toHaveLength(1);
  });
  it('platform 不在 PLATFORM_RULES 白名单 → E_INVALID_ARGS', () => {
    expect(() => plans.upsert({ ...base, platform: '某野鸡站' })).toThrowError(/E_INVALID_ARGS|平台/);
  });
  it('cadence 非 custom 时 intervalDays 由节奏派生（daily=1/every2=2/weekly=7）', () => {
    expect(plans.upsert({ ...base, cadence: 'every2' }).intervalDays).toBe(2);
  });
  it('archived 是终态：setStatus 回 active 被拒；archived 缺省不进 listByProject', () => {
    const p = plans.upsert(base);
    plans.setStatus(p.id, 'archived');
    expect(() => plans.setStatus(p.id, 'active')).toThrowError(/E_PLAN_STATE|终态|不允许/);
    expect(plans.listByProject('p1')).toHaveLength(0);
    expect(plans.listByProject('p1', true)).toHaveLength(1);
  });
  it('intervalDays custom 必须 ≥1', () => {
    expect(() => plans.upsert({ ...base, cadence: 'custom', intervalDays: 0 })).toThrowError(/E_INVALID_ARGS/);
  });
});
