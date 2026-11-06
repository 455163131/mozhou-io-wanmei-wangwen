/**
 * I-1 竞态守卫的纯逻辑单测（P2-B 首批工单）。
 *
 * 本仓无 jsdom/组件测试环境，渲染层接线靠源码扫描钉（见 p2a-overlay-race.test.ts），
 * 而 sequencer 是不碰 DOM 的纯状态机——按内联-marks / pipeline-stage 的先例，
 * 它进 tsconfig.node 的 DOM-free include，这里跑真断言。
 */
import { describe, it, expect } from 'vitest';
import { createSequencer } from '../../src/renderer/lib/sequenced';

describe('createSequencer', () => {
  it('next 单调递增', () => {
    const s = createSequencer();
    expect([s.next(), s.next(), s.next()]).toEqual([1, 2, 3]);
  });
  it('后发的 next 使先前序号立即失效（旧响应必须被丢弃）', () => {
    const s = createSequencer();
    const a = s.next(); // 发起 A
    const b = s.next(); // 用户切到 B
    expect(s.isCurrent(a)).toBe(false);
    expect(s.isCurrent(b)).toBe(true);
  });
  it('0 永不是合法序号（未发起即判 stale）', () => {
    const s = createSequencer();
    expect(s.isCurrent(0)).toBe(false);
  });
});
