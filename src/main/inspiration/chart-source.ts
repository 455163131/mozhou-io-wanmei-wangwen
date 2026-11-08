/**
 * 榜单数据源（P2-C T2）：礼貌直抓 + 演示兜底。
 *
 * ★★ F3 责任边界（硬约束）★★
 *   用户知情选择直抓公开榜单页，本模块只做**礼貌抓取**：
 *   - robots 先行：抓取前必查 Disallow 政策，禁止 → 不发请求，回落演示并带真因；
 *   - HTTP 缓存：TTL 内不重复抓（默认 5 分钟）；
 *   - 限速：同平台两次网络抓取之间留最小间隔（默认 60 秒），间隔内宁可回过期缓存；
 *   - 常规 UA：如实报明工具身份，单机低频访问；
 *   - 被挡 / 非 200 / 页面改版解析不出 → **诚实失败**：抛真因，由 makeChartSource
 *     回落演示集并把真因放进 error。全程不做任何形式的反爬对抗——不解验证码、
 *   - 不伪装浏览器指纹、不用代理池、不加 evasion 头、不重试轰炸（F3）。
 *
 * ★ robots 默认检查器的口径说明（简报测试钉死的取舍）：
 *   简报的缓存用例钉死「注入 fetchImpl 后两次 fetch 只许调它一次」，因此
 *   **默认** robotsChecker 不发网络请求，而是查下面这份带核验日期的离线政策
 *   快照（2026-11-07 逐站人工核验；未知站点一律按禁止处理 fail-closed）。
 *   需要运行时真拉 /robots.txt 的调用方，可注入 createRobotsTxtChecker()——
 *   它同样 fail-closed：robots 拉不到或读不懂 → 禁止。
 */
import type { ChartEntry, ChartFetchResult, Platform } from '@shared/types/inspiration';
import { CHART_SITES, parseChartHtml } from './chart-parse';
import { DEMO_CHARTS } from './chart-demo';

/** 榜单数据源接口：live 与 demo 两实现的共同形状 */
export interface ChartDataSource {
  fetch(platform: Platform, opts?: { signal?: AbortSignal }): Promise<ChartFetchResult>;
}

/** robots 放行检查器：true=允许抓取该 url，false=禁止（调用侧必须不发请求） */
export type RobotsChecker = (url: string) => Promise<boolean>;

/* ── robots 政策快照（2026-11-07 逐站核验；默认检查器数据源）────────── */

interface RobotsPolicy {
  /** robots.txt 当时能否读到真实文本（读不到 = 站点用脚本页挡了 robots 请求） */
  readable: boolean;
  /** 适用于 User-agent:* 的 Disallow 路径前缀；readable=false 时按全站禁止 */
  disallow: string[];
  checkedAt: string;
  note: string;
}

const ROBOTS_SNAPSHOT: Record<string, RobotsPolicy> = {
  'https://fanqienovel.com': {
    readable: true,
    disallow: [],
    checkedAt: '2026-11-07',
    note: 'robots.txt 全文即「User-agent:* Allow:/」，无 Disallow 条目',
  },
  'https://www.jjwxc.net': {
    readable: true,
    disallow: ['/sp'],
    checkedAt: '2026-11-07',
    note: 'robots.txt 仅 Disallow /sp；榜单路径 /topten.php 不在禁区',
  },
  'https://www.qidian.com': {
    readable: false,
    disallow: ['/'],
    checkedAt: '2026-11-07',
    note: 'robots.txt 不可读：站点对该请求返回脚本挑战页而非 robots 文本，按全站禁止处理（不做任何绕过）',
  },
};

/** 离线快照检查：未知站点 / robots 不可读 → 一律禁止（fail-closed） */
function snapshotRobotsCheck(url: string): { allowed: boolean; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `榜单地址不是合法 URL：${url}` };
  }
  const policy = ROBOTS_SNAPSHOT[parsed.origin];
  if (!policy) {
    return { allowed: false, reason: `未知站点 ${parsed.origin}：robots 政策未经核验，按禁止处理` };
  }
  if (!policy.readable) {
    return { allowed: false, reason: `${parsed.origin}：${policy.note}` };
  }
  if (policy.disallow.some((p) => p && parsed.pathname.startsWith(p))) {
    return { allowed: false, reason: `${parsed.origin} 的 robots.txt Disallow 覆盖 ${parsed.pathname}（核验于 ${policy.checkedAt}）` };
  }
  return { allowed: true, reason: policy.note };
}

/** 解析 robots.txt 文本：取 User-agent:* 段的 Disallow；文本不像 robots → 视为不可读 */
function robotsTextAllows(text: string, pathname: string): boolean {
  if (/^\s*<(?:!doctype|html)/i.test(text.trim().slice(0, 200))) return false; // 返回的是页面不是 robots 文本
  const disallow: string[] = [];
  let appliesToUs = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      // 新的一组开始：只有 * 组适用于本工具（不冒认任何具名 agent）
      appliesToUs = value === '*';
    } else if (field === 'disallow' && appliesToUs && value) {
      disallow.push(value);
    }
  }
  return !disallow.some((p) => pathname.startsWith(p));
}

/**
 * 运行时 robots 检查器工厂：真拉 <origin>/robots.txt，按 origin 缓存** robots 文本**
 * （不是首个 pathname 的布尔结论），每次调用按当前 pathname 重新判 Disallow——
 * 同站不同路径各自裁定（/topten.php 放行不代表 /sp 放行）。
 * fail-closed：网络失败 / 非 200 / 内容不是 robots 文本 → 一律禁止（不重试轰炸）。
 */
export function createRobotsTxtChecker(fetchImpl: typeof fetch = globalThis.fetch): RobotsChecker {
  const cache = new Map<string, string | null>(); // origin → robots 文本；null = 不可读（fail-closed）
  return async (url: string) => {
    const parsed = new URL(url);
    let text: string | null;
    if (cache.has(parsed.origin)) {
      text = cache.get(parsed.origin) ?? null;
    } else {
      try {
        const res = await fetchImpl(`${parsed.origin}/robots.txt`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain,*/*' },
        });
        text = res.ok ? await res.text() : null;
      } catch {
        text = null; // 拉不到 robots → 禁止（礼貌优先于功能）
      }
      cache.set(parsed.origin, text);
    }
    return text !== null && robotsTextAllows(text, parsed.pathname);
  };
}

/* ── 演示源 ────────────────────────────────────────────────────── */

/** 演示兜底源：只回 DEMO_CHARTS（全部 live:false），永不碰网络 */
export class DemoChartSource implements ChartDataSource {
  async fetch(platform: Platform): Promise<ChartFetchResult> {
    return { entries: DEMO_CHARTS[platform], source: 'demo' };
  }
}

/* ── 实时源（礼貌直抓）──────────────────────────────────────────── */

/**
 * UA 的 OS 段按运行平台**如实派生**（终审修复波 T2②）：旧实现不分平台一律写
 * Windows NT 10.0，等于在 mac/linux 上谎报运行环境。这里只做诚实化，不是规避——
 * 工具身份段（MozhouAgent/0.1 + 礼貌抓取声明）任何平台都在场且逐字不变。
 */
function osToken(platform: string): string {
  if (platform === 'win32') return 'Windows NT 10.0; Win64; x64';
  if (platform === 'darwin') return 'Macintosh';
  if (platform === 'linux') return 'X11; Linux x86_64';
  return 'generic'; // 其余平台不猜具体名：如实给通用 token
}

/** 组装如实 UA（platform 可注入便于单测钉；生产缺省 process.platform） */
export function chartUserAgent(platform: string = process.platform): string {
  return `Mozilla/5.0 (${osToken(platform)}) MozhouAgent/0.1 (个人桌面写作工具；礼貌抓取，单机低频)`;
}

/** 常规 UA：如实报明身份与运行平台，不伪装成任何浏览器/爬虫工具 */
const USER_AGENT = chartUserAgent();

export interface LiveChartSourceDeps {
  /** 注入的 fetch（测试用假实现，绝不碰真网络）；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 时钟注入（测试可控）；缺省 Date.now */
  now?: () => number;
  /** 页面缓存 TTL；缺省 5 分钟 */
  cacheTtlMs?: number;
  /** 同平台两次网络抓取的最小间隔；缺省 60 秒（间隔内回过期缓存，不打网络） */
  minIntervalMs?: number;
  /** robots 放行检查器；缺省查离线政策快照（见文件头说明），注入可覆写 */
  robotsChecker?: RobotsChecker;
  /**
   * 单次页面抓取的超时（毫秒）；缺省 15s。
   * ★ 修复前 fetch **只在调用方传 signal 时**才可中断——`fetchTrending` 从不传，
   *   于是站点黑洞（丢包不回 RST）时这次抓取永挂，扫榜页永远停在「抓取中」。
   *   礼貌抓取不设超时等于把自己的界面挂死，超时不是对抗性行为。
   */
  fetchTimeoutMs?: number;
}

interface CacheSlot {
  at: number;
  entries: ChartEntry[];
}

/** 合并调用方 signal 与超时 signal：任一触发即中断（Node 20+ 的 AbortSignal.any） */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  if (list.length === 0) return new AbortController().signal;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

/** 按 content-type / meta 声明的字符集解码正文（晋江是 GBK，utf-8 直解会花） */
async function decodeBody(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') ?? '';
  let charset = /charset=["']?([\w-]+)/i.exec(ct)?.[1]?.toLowerCase();
  if (!charset) {
    charset = /charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('ascii'))?.[1]?.toLowerCase();
  }
  if (charset && !/^utf-?8$/.test(charset)) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // 未知字符集名 → 回落 utf-8（解码结果是真话：花屏就解析失败抛真因）
    }
  }
  return buf.toString('utf8');
}

export class LiveChartSource implements ChartDataSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly minIntervalMs: number;
  private readonly robotsChecker: RobotsChecker | null;
  private readonly fetchTimeoutMs: number;
  private readonly cache = new Map<Platform, CacheSlot>();
  private readonly lastFetchAt = new Map<Platform, number>();

  constructor(deps: LiveChartSourceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.cacheTtlMs = deps.cacheTtlMs ?? 300_000;
    this.minIntervalMs = deps.minIntervalMs ?? 60_000;
    this.robotsChecker = deps.robotsChecker ?? null;
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? 15_000;
  }

  async fetch(platform: Platform, opts?: { signal?: AbortSignal }): Promise<ChartFetchResult> {
    const site = CHART_SITES[platform];

    // ① robots 先行：禁止 → 一个请求都不发，回落演示并带真因（礼貌，F3）
    const robots = await this.robotsAllowed(site.chartUrl);
    if (!robots.allowed) {
      return {
        entries: DEMO_CHARTS[platform],
        source: 'demo',
        error: `robots.txt 禁止抓取，已回落演示数据：${robots.reason}`,
      };
    }

    // ② 缓存：TTL 内直接回，不打网络
    const t = this.now();
    const cached = this.cache.get(platform);
    if (cached && t - cached.at < this.cacheTtlMs) {
      return { entries: cached.entries, source: 'live' };
    }

    // ③ 限速：最小间隔内不重抓——**无论有无缓存**都先闸（F3 限速不留空档）。
    //   有过期缓存宁可回它（宁慢勿扰）；无缓存则诚实抛限速真因，由 makeChartSource
    //   回落演示集。旧实现仅在 cached 存在时闸，失败路径（无缓存）会零间隔重打网络。
    const last = this.lastFetchAt.get(platform);
    if (last !== undefined && t - last < this.minIntervalMs) {
      if (cached) return { entries: cached.entries, source: 'live' };
      throw new Error(`榜单抓取限速（${platform}）：距上次抓取不足 ${Math.round(this.minIntervalMs / 1000)} 秒，稍后再试`);
    }

    // ④ 抓页面：常规 UA + 标准 Accept 头，无任何对抗性设置；失败抛真因。
    //   先记本次尝试时刻再发请求——失败也计入限速间隔，杜绝失败后零间隔重试。
    this.lastFetchAt.set(platform, t);
    let res: Response;
    try {
      res = await this.fetchImpl(site.chartUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        // ★ 调用方 signal 与超时 signal 合并：任一触发即中断（缺省也有超时，见 deps 注释）
        signal: combineSignals(opts?.signal, AbortSignal.timeout(this.fetchTimeoutMs)),
        redirect: 'follow',
      });
    } catch (e) {
      // 中断分两种：调用方取消（opts.signal）与本次抓取超时（内部 signal）——
      // 超时如实说超时，不冒充「站点拒绝」，也不静默当网络错。
      const name = e instanceof Error ? e.name : '';
      if ((name === 'AbortError' || name === 'TimeoutError') && !opts?.signal?.aborted) {
        throw new Error(
          `榜单抓取超时（${platform}）：${
            this.fetchTimeoutMs < 1000 ? `${this.fetchTimeoutMs} 毫秒` : `${Math.round(this.fetchTimeoutMs / 1000)} 秒`
          }内未响应，已放弃本次抓取`,
        );
      }
      throw new Error(`榜单抓取失败（${platform}）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      // 被挡（403/4xx/5xx）是诚实失败：直报状态码，不做任何绕过（F3）
      throw new Error(`榜单抓取失败（${platform}）：HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    }

    // ⑤ 解析：结构不认识 → parseChartHtml 自己抛真因（不静默回空）
    const html = await decodeBody(res);
    const entries = parseChartHtml(platform, html);

    this.cache.set(platform, { at: this.now(), entries });
    return { entries, source: 'live' };
  }

  private async robotsAllowed(url: string): Promise<{ allowed: boolean; reason: string }> {
    if (!this.robotsChecker) return snapshotRobotsCheck(url);
    try {
      const ok = await this.robotsChecker(url);
      return ok
        ? { allowed: true, reason: '' }
        : { allowed: false, reason: `robots 检查未放行 ${url}` };
    } catch (e) {
      // 检查器自己出错 → fail-closed：拿不准就不抓
      return { allowed: false, reason: `robots 检查失败（按禁止处理）：${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/* ── 组合源 ────────────────────────────────────────────────────── */

/**
 * live 优先、失败回落 demo 的组合源。
 * 回落时 error 原样携带真因（网络错/状态码/解析失败），绝不把演示数据
 * 悄悄冒充实时数据（source='demo' + live:false 双重明示）。
 */
export function makeChartSource(deps: { live: ChartDataSource; demo: ChartDataSource }): ChartDataSource {
  return {
    async fetch(platform: Platform, opts?: { signal?: AbortSignal }): Promise<ChartFetchResult> {
      try {
        return await deps.live.fetch(platform, opts);
      } catch (e) {
        const demo = await deps.demo.fetch(platform, opts);
        return { ...demo, source: 'demo', error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
