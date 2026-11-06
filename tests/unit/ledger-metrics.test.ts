// tests/unit/ledger-metrics.test.ts
import { describe, it, expect } from 'vitest';
import { debtSeries, ledgerStatus, excerptAround, OVERDUE_GAP_CHAPTERS, WEIGHT_VALUE } from '../../src/shared/ledger-metrics';
import type { Foreshadow } from '../../src/shared/types/ledger';

const f = (over: Partial<Foreshadow>): Foreshadow => ({
  id: 'x', plantedAt: { chapterId: 'c1', offset: 0, quote: 'q' }, plantedQuote: 'q',
  resolvedAt: null, status: 'unresolved', ...over,
});

describe('WEIGHT_VALUE', () => {
  it('A=3 B=2 C=1，缺省按 B（Agent 旧行无 weight 不炸账）', () => {
    expect(WEIGHT_VALUE.A).toBe(3);
    expect(WEIGHT_VALUE[f({}).weight ?? 'B']).toBe(2);
  });
});

describe('debtSeries', () => {
  const noMap = new Map([['c1', 1], ['c5', 5]]);
  const pNo = (x: Foreshadow) => noMap.get(x.plantedAt.chapterId) ?? null;
  const rNo = (x: Foreshadow) => (x.resolvedAt ? noMap.get(x.resolvedAt.chapterId) ?? null : null);
  it('章末口径：埋设章章末即计 A 权重，后续章保持', () => {
    const s = debtSeries([f({ weight: 'A' })], pNo, rNo, 3);
    expect(s).toEqual([3, 3, 3]);
  });
  it('回收在第 5 章：第 5 章章末起归零', () => {
    const s = debtSeries([f({ weight: 'B', resolvedAt: { chapterId: 'c5', offset: 0, quote: 'r' } })], pNo, rNo, 6);
    expect(s).toEqual([2, 2, 2, 2, 0, 0]);
  });
  it('定位不到章号（坏 ref）的条目整条跳过，不虚增', () => {
    expect(debtSeries([f({})], () => null, () => null, 3)).toEqual([0, 0, 0]);
  });
});

describe('ledgerStatus', () => {
  it('resolved → green', () => {
    expect(ledgerStatus(f({ status: 'resolved' }), 1, 100)).toBe('green');
  });
  it('未超期 unresolved/suspected → yellow', () => {
    expect(ledgerStatus(f({}), 90, 100)).toBe('yellow');
  });
  it(`未偿且距埋设 ≥${OVERDUE_GAP_CHAPTERS} 章 → red`, () => {
    expect(ledgerStatus(f({}), 100 - OVERDUE_GAP_CHAPTERS, 100)).toBe('red');
  });
  it('latest 早于埋设（草稿章）不判红', () => {
    expect(ledgerStatus(f({}), 50, 10)).toBe('yellow');
  });
});

describe('excerptAround', () => {
  it('以 offset+quote 为中心取 ±radius，越界钳位不抛', () => {
    const body = 'A'.repeat(100) + '钩子' + 'B'.repeat(100);
    expect(excerptAround(body, 100, '钩子', 10)).toBe('A'.repeat(10) + '钩子' + 'B'.repeat(10));
    expect(excerptAround(body, 1, 'A', 5)).toBe(body.slice(0, 7));
  });
  it('offset 超界（正文被改写后）回空串——调用侧显示诚实 miss 态', () => {
    expect(excerptAround('短', 999, 'x')).toBe('');
  });
});
