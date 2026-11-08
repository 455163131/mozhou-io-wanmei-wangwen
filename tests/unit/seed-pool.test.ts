// tests/unit/seed-pool.test.ts
import { describe, it, expect } from 'vitest';
import { SEED_DIRECTIONS, drawDirection } from '@shared/inspiration/seed-pool';

describe('seed-pool', () => {
  it('24 条方向、无重复', () => {
    expect(SEED_DIRECTIONS).toHaveLength(24);
    expect(new Set(SEED_DIRECTIONS).size).toBe(24);
  });
  it('drawDirection 避开 history（反重复铁律）', () => {
    const history = SEED_DIRECTIONS.slice(0, 23); // 只剩最后一条没抽过
    expect(drawDirection(history, () => 0.5)).toBe(SEED_DIRECTIONS[23]);
  });
  it('history 覆盖全部 24 → 重置后可再抽（不卡死）', () => {
    expect(SEED_DIRECTIONS).toContain(drawDirection(SEED_DIRECTIONS, () => 0.5));
  });
});