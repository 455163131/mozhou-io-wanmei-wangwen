/**
 * 榜单 HTML 解析（P2-C T2）——纯函数，不碰网络。
 *
 * ★ 全部为**原创解析代码**（措辞自写、正则自写），未抄任何外部爬虫项目。
 * ★ R6 解析器保真口径：每平台按「简报合成样本 + 2026-11-07 实测页面结构」
 *   写主路径，另留少量常见变体兜底（best-effort）。真实平台改版识别不出
 *   任何条目时**抛真因**（原则#6 失败说真话），绝不静默回空数组——
 *   上层 makeChartSource 接住后如实回落演示集。
 * ★ heat（DRD §7）：只有页面确实携带带标签的可信热度数字（在读/热度/人气/
 *   月票等）才解析成数值，否则一律 null——不推算、不编造。
 */
import type { ChartEntry, Platform } from '@shared/types/inspiration';

/** 三平台榜单页地址（解析器补全相对链接时取 origin；抓取侧同源使用） */
export const CHART_SITES: Record<Platform, { origin: string; chartUrl: string }> = {
  番茄: { origin: 'https://fanqienovel.com', chartUrl: 'https://fanqienovel.com/rank' },
  晋江: { origin: 'https://www.jjwxc.net', chartUrl: 'https://www.jjwxc.net/topten.php?orderstr=1' },
  // 起点 robots.txt 不可读（返回脚本挑战页），默认策略按禁止处理——此地址仅在
  // 调用方显式注入放行检查器时才会被访问（见 chart-source.ts 的 F3 说明）。
  起点: { origin: 'https://www.qidian.com', chartUrl: 'https://www.qidian.com/rank/yuepiao/' },
};

/* ── 小工具（自写，不引第三方 HTML 库——少一个依赖少一分供应链风险）──── */

/** 去掉 HTML 标签，只留文本 */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/** 还原最常见的几个 HTML 实体（够榜单文本用，不求全） */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 标签内纯文本：去标签 + 解实体 + 收空白 */
function textOf(html: string): string {
  return decodeEntities(stripTags(html));
}

/** 相对链接补全成绝对链接（//开头补协议，/开头补 origin，其余原样） */
function absolutize(origin: string, href: string): string {
  const h = href.trim();
  if (h.startsWith('//')) return `https:${h}`;
  if (h.startsWith('/')) return `${origin}${h}`;
  if (/^https?:\/\//.test(h)) return h;
  return `${origin}/${h}`;
}

/**
 * 把「27.7万 / 1.2亿 / 3456」这类中文计数写法换算成整数。
 * 换算不了（没有数字）回 null——不硬凑。
 */
function parseCnCount(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(亿|万)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] === '亿' ? 100_000_000 : m[2] === '万' ? 10_000 : 1;
  return Math.round(n * unit);
}

/**
 * 从一段文本里找**带标签的**可信热度数字（在读/热度/人气/点击/月票/推荐票）。
 * 没有标签的裸数字不当热度——榜单上的裸数字可能是字数、章节数、日期（DRD §7）。
 */
function findLabeledHeat(text: string): number | null {
  const m = text.match(/(?:在读|热度|人气|总点击|点击|月票数?|推荐票)[：:\s]*(\d+(?:\.\d+)?\s*[亿万]?)/);
  return m ? parseCnCount(m[1]) : null;
}

/** 提取块内第一个「像书链」的 <a>：有 href、有非空文本 */
function firstBookAnchor(block: string, skipHrefRe?: RegExp): { href: string; text: string } | null {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const text = textOf(m[2]);
    if (!text) continue;
    if (skipHrefRe && skipHrefRe.test(m[1])) continue;
    return { href: m[1], text };
  }
  return null;
}

/** 提取块内指定 class 片段（class 包含某关键词的第一个元素的内容，标签级粗略截取） */
function classSlice(block: string, classKeyword: string): string | null {
  const m = block.match(new RegExp(`<(div|span|p|h1|h2|h3|h4|td|li|em|b)\\b[^>]*class=["'][^"']*${classKeyword}[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`, 'i'));
  return m ? m[2] : null;
}

/** 收集块内 class 含 tag 的元素文本为标签数组 */
function collectTags(block: string): string[] {
  const tags: string[] = [];
  const re = /<(?:span|a|em|i|b)\b[^>]*class=["'][^"']*(?:tag|label)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|a|em|i|b)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const t = textOf(m[1]);
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

/**
 * 榜内条目通用兜底：class 含 rank-item / rank-book-item 的 div|li 块。
 * ★ 不用「懒惰匹配到第一个闭合标签」——真实条目内有嵌套 div，会在半路截断；
 *   改用「本条目起始 → 下一条目起始」的兄弟切片，嵌套多深都完整。
 */
function genericItemBlocks(html: string): string[] {
  const startRe = /<(?:div|li)\b[^>]*class=["'][^"']*rank[-_](?:book[-_])?item[^"']*["'][^>]*>/gi;
  const starts: { from: number; to: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(html)) !== null) starts.push({ from: m.index, to: m.index + m[0].length });
  return starts.map((s, i) => html.slice(s.to, i + 1 < starts.length ? starts[i + 1].from : html.length));
}

/* ── 番茄 ──────────────────────────────────────────────────────── */

/**
 * 番茄主路径（2026-11-07 实测 fanqienovel.com/rank）：
 *   <div class="rank-book-item">
 *     <div class="book-item-index"><h1>01</h1>…
 *     <div class="title"><a href="/page/72…">书名</a></div>
 *     <div class="author"><a …><span>作者名</span></a></div>
 *     …<span class="book-item-count">在读：27.7万</span>
 * 变体兜底：简报合成样本 <div class="rank-item"><span class="num">1</span>…。
 */
function parseFanqie(html: string, origin: string): ChartEntry[] {
  const out: ChartEntry[] = [];
  const blocks = genericItemBlocks(html);
  blocks.forEach((block, i) => {
    // 书链：跳过作者页链接（/author-page/），第一个非空文本的 <a> 即书名
    const anchor = firstBookAnchor(block, /author-page|authorid/i);
    if (!anchor) return;
    // 排名：book-item-index 的 <h1>01</h1> / class 含 num|index 的数字 / 位置兜底
    let rank = i + 1;
    const idxSlice = classSlice(block, 'book-item-index') ?? classSlice(block, 'num');
    const rankText = idxSlice ? textOf(idxSlice) : '';
    const rankNum = rankText.match(/\d+/);
    if (rankNum) rank = Number(rankNum[0]);
    else {
      const h1 = block.match(/<h1[^>]*>\s*(\d+)\s*<\/h1>/i);
      if (h1) rank = Number(h1[1]);
    }
    const authorSlice = classSlice(block, 'author');
    const author = authorSlice ? textOf(authorSlice) : '';
    // 热度：仅认带标签的（实测「在读：27.7万」）；无标签裸数字不算（DRD §7）
    const heat = findLabeledHeat(textOf(block));
    out.push({
      rank,
      title: anchor.text,
      author: author.replace(/^作者[：:]\s*/, ''),
      platform: '番茄',
      heat,
      tags: collectTags(block),
      url: absolutize(origin, anchor.href),
      live: true,
    });
  });
  return out;
}

/* ── 晋江 ──────────────────────────────────────────────────────── */

/**
 * 晋江主路径（2026-11-07 实测 jjwxc.net/topten.php，GBK 编码由抓取侧解码）：
 *   <tr …>
 *     <td …>《<a href="onebook.php?novelid=273" …>书名</a>》</td>
 *     <td …><a href="oneauthor.php?authorid=32" …>作者</a></td>
 *     <td …>言情-近代现代</td>   ← 题材格，拆成 tags
 *     <td …>完结</td>
 * 榜单行不带名次数字，按出现次序记 rank；不带可信热度数字 → heat 恒 null。
 */
function parseJinjiang(html: string, origin: string): ChartEntry[] {
  const out: ChartEntry[] = [];
  const rows = html.split(/<tr\b/i).slice(1);
  rows.forEach((rawRow) => {
    const row = rawRow.split(/<\/tr>/i)[0];
    const book = row.match(/<a\b[^>]*href=["']([^"']*onebook\.php\?novelid=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!book) return;
    const author = row.match(/<a\b[^>]*href=["'][^"']*oneauthor\.php[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    // 题材格：形如「言情-近代现代」的单元格文本，拆成标签
    const tags: string[] = [];
    const cells = row
      .split(/<td\b/i)
      .slice(1)
      // 按 <td 切开的片段开头残留着属性串（width=…>），先掐掉第一个 > 之前的部分
      .map((c) => textOf(c.split(/<\/td>/i)[0].replace(/^[^<>]*>/, '')));
    for (const cell of cells) {
      const genre = cell.match(/^[\u4e00-\u9fa5]+(?:-[\u4e00-\u9fa5]+){1,2}$/);
      if (genre) tags.push(...cell.split('-').filter(Boolean));
    }
    out.push({
      rank: out.length + 1, // 页面不带名次数字，按榜内出现次序
      title: textOf(book[2]).replace(/^《|》$/g, ''),
      author: author ? textOf(author[1]) : '',
      platform: '晋江',
      heat: findLabeledHeat(textOf(row)), // 实测无热度标签 → null
      tags,
      url: absolutize(origin, book[1]),
      live: true,
    });
  });
  return out;
}

/* ── 起点 ──────────────────────────────────────────────────────── */

/**
 * 起点主路径（公开榜单页常见结构；本站 robots.txt 不可读，默认**不抓取**，
 * 此解析器仅在调用方显式放行时才会被用到）：
 *   <a href="//www.qidian.com/book/1000000000/">书名</a> …
 *   <p class="author"><a class="name">作者</a><a href="…">标签</a>…</p>
 * 月票榜的票数带「月票」标签时才计为 heat。
 */
function parseQidian(html: string, origin: string): ChartEntry[] {
  const out: ChartEntry[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"']*\/book\/(\d+)\/?[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const bookId = m[2];
    if (seen.has(bookId)) continue; // 同书多链（封面+书名）只记一次
    const title = textOf(m[3]);
    if (!title) continue;
    seen.add(bookId);
    // 作者与标签：书链之后最近的 author 段
    const tail = html.slice(m.index, m.index + 3000);
    const authorBlock = classSlice(tail, 'author') ?? '';
    const nameAnchor = authorBlock.match(/<a\b[^>]*class=["'][^"']*name[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? authorBlock.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const tags = collectTags(authorBlock);
    out.push({
      rank: out.length + 1, // 榜内次序；页面若带显式名次数字也不冒认
      title,
      author: nameAnchor ? textOf(nameAnchor[1]) : '',
      platform: '起点',
      heat: findLabeledHeat(textOf(tail.slice(0, 1500))),
      tags,
      url: absolutize(origin, m[1]),
      live: true,
    });
  }
  return out;
}

/* ── 总入口 ────────────────────────────────────────────────────── */

const PARSERS: Record<Platform, (html: string, origin: string) => ChartEntry[]> = {
  番茄: parseFanqie,
  晋江: parseJinjiang,
  起点: parseQidian,
};

/**
 * 按平台解析榜单 HTML。识别不出任何条目 → 抛真因（不静默回空，原则#6）。
 * 番茄/起点在专属路径落空时再试通用 rank-item 兜底，晋江反之。
 */
export function parseChartHtml(platform: Platform, html: string): ChartEntry[] {
  const origin = CHART_SITES[platform].origin;
  let entries = PARSERS[platform](html, origin);
  if (entries.length === 0 && platform !== '番茄') {
    // 变体兜底：不少榜单页用同款 rank-item 结构，试一次通用块解析
    entries = parseFanqie(html, origin).map((e) => ({ ...e, platform }));
  }
  if (entries.length === 0) {
    throw new Error(`榜单解析失败：${platform} 未识别到条目（页面结构可能已改版）`);
  }
  return entries;
}
