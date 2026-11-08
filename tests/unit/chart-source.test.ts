// tests/unit/chart-source.test.ts —— 礼貌 + 演示兜底 + 无反爬负对照
import { describe, it, expect, vi } from 'vitest';
import { LiveChartSource, DemoChartSource, makeChartSource, createRobotsTxtChecker } from '@main/inspiration/chart-source';

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
  it('LiveChartSource：非 200 → 抛真因带状态码（被挡诚实失败，不绕过）', async () => {
    const fetchImpl = vi.fn(async () => new Response('blocked', { status: 403, statusText: 'Forbidden' }));
    const src = new LiveChartSource({ fetchImpl: fetchImpl as unknown as typeof fetch, robotsChecker: async () => true });
    await expect(src.fetch('番茄')).rejects.toThrow(/HTTP 403/);
  });
  it('LiveChartSource：抓取失败后最小间隔内再调 → 限速抛真因，不二次打网络（F3 限速空档回归）', async () => {
    let clock = 1000;
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const src = new LiveChartSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
      robotsChecker: async () => true,
      minIntervalMs: 60_000,
    });
    await expect(src.fetch('番茄')).rejects.toThrow(/ECONNREFUSED/);
    clock += 1000; // 1 秒后再调：仍在 60 秒间隔内，且失败未留下缓存
    await expect(src.fetch('番茄')).rejects.toThrow(/限速/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 第二次绝不打网络
  });
});

describe('createRobotsTxtChecker（运行时 robots 检查器，生产注入）', () => {
  it('按 origin 缓存政策但逐 pathname 判定：/topten 放行后 /sp 仍禁止（path 盲缓存回归）', async () => {
    const fetchImpl = vi.fn(async () => new Response('User-agent: *\nDisallow: /sp\n', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const checker = createRobotsTxtChecker(fetchImpl as unknown as typeof fetch);
    expect(await checker('https://www.jjwxc.net/topten.php?orderstr=1')).toBe(true);
    expect(await checker('https://www.jjwxc.net/sp/foo')).toBe(false); // 旧实现缓存首个 pathname 的布尔 → 误放行
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 同 origin 只拉一次 robots
  });
  it('robots 返回脚本挑战页（非 robots 文本）→ fail-closed 禁止', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><html>challenge</html>', { status: 200 }));
    const checker = createRobotsTxtChecker(fetchImpl as unknown as typeof fetch);
    expect(await checker('https://www.qidian.com/rank/yuepiao/')).toBe(false);
  });
  it('robots 拉取抛错 → fail-closed 禁止（礼貌优先于功能）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const checker = createRobotsTxtChecker(fetchImpl as unknown as typeof fetch);
    expect(await checker('https://fanqienovel.com/rank')).toBe(false);
  });
});
