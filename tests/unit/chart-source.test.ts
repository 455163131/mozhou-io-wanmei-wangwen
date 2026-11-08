// tests/unit/chart-source.test.ts —— 礼貌 + 演示兜底 + 无反爬负对照
import { describe, it, expect, vi } from 'vitest';
import { LiveChartSource, DemoChartSource, makeChartSource } from '@main/inspiration/chart-source';

describe('ChartSource', () => {
  it('DemoChartSource 回演示集且 source=demo、live=false', async () => {
    const r = await new DemoChartSource().fetch('番茄');
    expect(r.source).toBe('demo');
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.every((e) => e.live === false)).toBe(true);
  });
  it('LiveChartSource 命中缓存不二次 fetch（限速/缓存）', async () => {
    const fetchImpl = vi.fn(async () => new Response('<div class="rank-item"><span class="num">1</span><a href="/b/1">书名</a><span class="author">甲</span></div>', { status: 200 }));
    const src = new LiveChartSource({ fetchImpl: fetchImpl as unknown as typeof fetch, cacheTtlMs: 60_000 });
    await src.fetch('番茄'); await src.fetch('番茄');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('robots 禁止 → 不抓取，回落演示并带 error（礼貌）', async () => {
    const fetchImpl = vi.fn();
    const src = new LiveChartSource({ fetchImpl: fetchImpl as unknown as typeof fetch, robotsChecker: async () => false });
    const r = await src.fetch('起点');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.source).toBe('demo');
    expect(r.error).toMatch(/robots|禁止/);
  });
  it('抓取抛错/非200 → makeChartSource 回落 demo + error 直报真因（不编造）', async () => {
    const live = { fetch: async () => { throw new Error('ECONNREFUSED'); } };
    const src = makeChartSource({ live: live as never, demo: new DemoChartSource() });
    const r = await src.fetch('晋江');
    expect(r.source).toBe('demo');
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
  it('无反爬绕过负对照：源码不含指纹伪装/代理轮换/CAPTCHA 钩子', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main/inspiration/chart-source.ts', 'utf8');
    expect(src).not.toMatch(/captcha|solveCaptcha|fingerprint|spoof|proxyPool|rotateProxy|stealth/i);
  });
});
