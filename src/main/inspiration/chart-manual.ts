/**
 * 榜单手动导入解析（C批）——纯函数，不碰网络、不碰库。
 *
 * ★ 原创解析代码（措辞自写、正则自写），未抄任何外部爬虫项目；万/亿换算自写，
 *   不 import chart-parse.ts 的私有工具（那边是 HTML 抓取口径，这边是粘贴文本口径，
 *   两套输入形状不同，强行复用只会互相牵制）。
 * ★ 诚实纪律（DRD §7）：手动导入条目 live 恒 false + manual 恒 true——
 *   UI 必须标「手动导入」，绝不标「实时」（没抓就是没抓），也绝不标「演示」
 *   （数据是用户自己贴的真榜单，不是演示集）。热度解析不出 → null，绝不编造。
 * ★ 失败说真话（原则#6）：识别不出任何书目 / 超上限 → 抛带真因的 Error，
 *   绝不静默回空数组让上层误以为「导入成功但没数据」。
 *
 * 输入形状：每行一本，分隔符逐行自适应（有 tab 按 TSV，否则按逗号 CSV）；
 * 列序固定 `排名,书名,作者,热度,链接,标签`，只有书名必填；含「书名/title」的
 * 表头行跳过；无分隔符的裸书名行按行序排名。上限 200 条 / 100000 字符。
 */
import type { ChartEntry, Platform } from '@shared/types/inspiration';

/** 条目数上限（粘贴一整站 HTML 也不许撑爆 IPC/落库循环） */
const MAX_ENTRIES = 200;
/** 输入字符上限（与 IPC zod 边界同值，两侧各拦一道） */
const MAX_CHARS = 100_000;

/**
 * 中文计数换算（自写）：「27.7万」→277000、「1.2亿」→120000000、「3456」→3456。
 * 找不到数字 → null（宁缺毋假，不硬凑）。
 */
function parseHeat(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(亿|万)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] === '亿' ? 100_000_000 : m[2] === '万' ? 10_000 : 1;
  return Math.round(n * unit);
}

/** 书名剥《》并 trim（与榜单展示口径一致：《》是装饰不是书名的一部分） */
function cleanTitle(s: string): string {
  return s.trim().replace(/^《|》$/g, '').trim();
}

/**
 * 解析手动粘贴的榜单文本。识别不出任何条目 / 超上限 → 抛真因。
 * 产出条目一律 { live: false, manual: true }——来源诚实，UI 据此标「手动导入」。
 */
export function parseManualChart(platform: Platform, text: string): ChartEntry[] {
  if (text.length > MAX_CHARS) {
    throw new Error(`手动导入超出上限：文本最长 ${MAX_CHARS} 字符`);
  }
  const out: ChartEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue; // 空行跳过
    // 表头行（含「书名」或 title）跳过——用户从表格软件复制常带表头
    if (line.includes('书名') || /title/i.test(line)) continue;

    // 分隔符逐行自适应：有 tab 按 TSV，否则有逗号按 CSV，再否则整行当裸书名
    const cols = line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : [line];
    const isBare = cols.length === 1;
    const title = cleanTitle(isBare ? (cols[0] ?? '') : (cols[1] ?? ''));
    if (!title) continue; // 只有书名必填；书名列空 → 该行不识别

    // 排名：列首整数优先，否则按已接受条目行序（1-based）；裸书名行恒按行序
    const rankMatch = isBare ? null : (cols[0] ?? '').trim().match(/^(\d+)/);
    const rank = rankMatch ? Number(rankMatch[1]) : out.length + 1;
    const author = isBare ? '' : (cols[2] ?? '').trim();
    const heat = isBare ? null : parseHeat((cols[3] ?? '').trim());
    // 链接只认 http(s):// 绝对地址——手动输入不来自平台站点，不对 origin 补全，
    // 相对路径/ftp/裸域名一律丢弃为空串（不替用户猜链接指向哪）。
    const rawUrl = isBare ? '' : (cols[4] ?? '').trim();
    const url = /^https?:\/\//.test(rawUrl) ? rawUrl : '';
    const tags = isBare ? [] : (cols[5] ?? '').split('|').map((t) => t.trim()).filter(Boolean);

    out.push({ rank, title, author, platform, heat, tags, url, live: false, manual: true });
    if (out.length > MAX_ENTRIES) {
      throw new Error(`手动导入超出上限：最多 ${MAX_ENTRIES} 条`);
    }
  }
  if (out.length === 0) {
    throw new Error('手动导入解析失败：未识别到任何书目（每行一本：排名,书名,作者,热度,链接,标签）');
  }
  return out;
}