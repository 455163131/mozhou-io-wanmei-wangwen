// tests/unit/chart-source.test.ts —— 礼貌 + 演示兜底 + 无反爬负对照
import { describe, it, expect, vi } from 'vitest';
import { LiveChartSource, DemoChartSource, makeChartSource, createRobotsTxtChecker, chartUserAgent } from '@main/inspiration/chart-source';

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

  // ★ 终审修复波 T2③-①：限速正路径（有过期缓存）——与上面失败路径成对。
  //   缓存过 TTL 但仍在最小间隔内：回**过期缓存**（source 仍如实 live），绝不重打网络。
  it('LiveChartSource：最小间隔内且有过期缓存 → 直接回缓存 live 结果，不二次打网络（限速正路径）', async () => {
    let clock = 1000;
    const html = '<div class="rank-item"><span class="num">1</span><a href="/b/1">书名</a><span class="author">甲</span></div>';
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const src = new LiveChartSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
      robotsChecker: async () => true,
      cacheTtlMs: 500, // TTL 故意小于限速窗：制造「缓存过期但仍在间隔内」的窗口
      minIntervalMs: 60_000,
    });
    const first = await src.fetch('番茄');
    expect(first.source).toBe('live');
    clock += 1000; // 缓存已过 TTL、限速闸仍关着
    const second = await src.fetch('番茄');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 宁回过期缓存，勿扰
    expect(second.source).toBe('live');
    expect(second.entries).toEqual(first.entries);
  });

  // ★ 终审修复波 T2③-②：decodeBody 的 charset 解码——晋江真身是 GBK，utf-8 直解会花屏。
  //   经 LiveChartSource.fetch 注入假 fetch 回 GBK 字节 + Content-Type charset=gbk，
  //   断言解析出的标题是正确的 CJK（「北京」GBK 字节 B1B1 BEB9）。
  it('LiveChartSource：Content-Type charset=gbk → GBK 字节正确解码为 CJK（晋江口径）', async () => {
    const gbkTitle = new Uint8Array([0xb1, 0xb1, 0xbe, 0xa9]); // 北京（GB2312/GBK：北=B1B1 京=BEA9）
    const pre = Buffer.from('<html><body><table><tr><td>《<a href="onebook.php?novelid=273">', 'ascii');
    const post = Buffer.from('</a>》</td></tr></table></body></html>', 'ascii');
    const body = new Uint8Array(pre.length + gbkTitle.length + post.length);
    body.set(pre, 0);
    body.set(gbkTitle, pre.length);
    body.set(post, pre.length + gbkTitle.length);
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=gbk' },
    }));
    const src = new LiveChartSource({ fetchImpl: fetchImpl as unknown as typeof fetch, robotsChecker: async () => true });
    const r = await src.fetch('晋江');
    expect(r.source).toBe('live');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].title).toBe('北京'); // utf-8 直解在此会变 U+FFFD 花屏
  });

  // ★ 终审修复波 T2②：UA 的 OS 段按 process.platform 如实派生——mac/linux 上不再
  //   谎报 Windows。工具身份段（MozhouAgent/0.1）任何平台都在场，不伪装、不规避。
  it('chartUserAgent：OS token 按平台如实派生，通用身份段恒在（跨平台不谎报）', () => {
    expect(chartUserAgent('win32')).toContain('Windows NT 10.0');
    expect(chartUserAgent('darwin')).toContain('Macintosh');
    expect(chartUserAgent('darwin')).not.toContain('Windows');
    expect(chartUserAgent('linux')).toContain('X11; Linux x86_64');
    expect(chartUserAgent('linux')).not.toContain('Windows');
    const other = chartUserAgent('freebsd');
    expect(other).not.toContain('Windows');
    expect(other).not.toContain('Macintosh');
    expect(other).not.toContain('X11');
    for (const p of ['win32', 'darwin', 'linux', 'freebsd']) {
      const ua = chartUserAgent(p);
      expect(ua).toContain('Mozilla/5.0');
      expect(ua).toContain('MozhouAgent/0.1');
      expect(ua).toContain('礼貌抓取');
    }
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
