/**
 * 中文本处理工具。
 *
 * ★ 分层铁律：shared 层禁止 import Node/Electron，也**禁止任何 DOM 引用**。
 * 这里的函数全部是纯字符串处理，主进程与渲染层都能用。
 */

/** 三类中文引号：开 / 闭 */
const QUOTE_OPEN = ['\u201c', '\u300c'];
const QUOTE_CLOSE = ['\u201d', '\u300d'];

/** 去除所有空白字符（与Python 的 re.sub(r"\s","",text) 口径一致） */
export function stripWhitespace(s: string): string {
  return s.replace(/\s/g, '');
}

/** 判断某偏移是否落在中文引号内 —— 引号内是人物语言，是本书要「立」的核心资产，一律不改 */
export function inQuote(text: string, idx: number): boolean {
  let open = false;
  for (let i = 0; i < idx && i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      // 换行重置：引号不应跨段（原型口径，移植时保持一致）
      open = false;
    } else if (QUOTE_OPEN.includes(c)) {
      open = true;
    } else if (QUOTE_CLOSE.includes(c)) {
      open = false;
    }
  }
  return open;
}

/**
 * 引号区间表：一次扫描建表，之后每次查询 O(log n)。
 *
 * ★★ 为什么需要它（性能，O(n²) → O(n + m·log m)）★★
 * `inQuote(text, idx)` 每次都从 0 扫到 idx，单次就是 O(n)。而调用方几乎都在
 * **循环里按位置反复调它**：
 *   · `checkpoint/replayer.ts` 的 validateNoQuoteEdits 对每条 edit 调一次
 *   · `tools/impl/phrase.ts` 在 while 里对每个匹配位置调一次
 *   · `rule-engine/fix-families.ts`、`suggestions.ts` 同理
 * 10 万字章节 + 数百处编辑 = 10^7~10^8 次字符比较，而且发生在**回滚路径**
 * ——用户等待最敏感的地方。
 *
 * 用法：循环外 `const q = buildQuoteRanges(text)` 建一次表，循环内用
 * `inQuoteRanges(q, idx)` 查询。语义与 `inQuote` **逐位等价**（穷举测试锁定）。
 */
export interface QuoteRanges {
  /**
   * 「查询偏移」的命中区间 `[start, end)`，按 start 升序、互不重叠。
   *
   * ⚠️ 这不是「引号内文本」的字符跨度，而是**能让 inQuote 返回 true 的 idx 集合**。
   * 二者差一位，原因是 `inQuote(text, idx)` 扫描的是 `[0, idx)`：
   *   · 开引号在 p → idx 必须 > p 才扫得到它，故 start = p + 1
   *   · 闭合事件（闭引号或换行）在 q → idx 只要 ≤ q 就还没扫到闭合，仍是 true，
   *     故 end = q + 1
   *   · 直到文末都未闭合 → end = text.length + 1
   * 想取「引号内的文字」请用 `text.slice(start, end - 1)`。
   */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

/** 一次扫描全文，产出所有引号区间。口径与 inQuote 完全一致（含「换行重置」） */
export function buildQuoteRanges(text: string): QuoteRanges {
  const ranges: Array<[number, number]> = [];
  let open = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      // 换行重置：未闭合的引号到此为止。end = i + 1（idx === i 时还没扫到换行）
      if (open) ranges.push([start, i + 1]);
      open = false;
    } else if (!open && QUOTE_OPEN.includes(c)) {
      open = true;
      start = i + 1; // idx 必须严格大于开引号位置才算「在引号内」
    } else if (open && QUOTE_CLOSE.includes(c)) {
      ranges.push([start, i + 1]); // 同上：idx === i（闭引号本身）时仍判 true
      open = false;
    }
  }
  // 文末仍未闭合：扫描到 length 时 open 仍是 true
  if (open) ranges.push([start, text.length + 1]);
  return { ranges };
}

/** 二分查询某偏移是否在引号内。与 `inQuote(text, idx)` 等价 */
export function inQuoteRanges(q: QuoteRanges, idx: number): boolean {
  const ranges = q.ranges;
  if (ranges.length === 0) return false;
  // 找最后一个 start <= idx 的区间（区间有序且不重叠，故只需检查这一个）
  let lo = 0;
  let hi = ranges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][0] <= idx) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && idx < ranges[found][1];
}

/** 该位置是否是专有名词/数字锚点保护区 —— 事实锚点一律不改（N4 负面知识） */
const PROTECTED = /[0-9A-Za-z\u4e00-\u9fa5]/;

export function hasProtectedToken(s: string): boolean {
  return PROTECTED.test(s);
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字 →阿拉伯数字，支持到「千」级（覆盖「两千三百」这类表达） */
export function cnToNum(s: string): number {
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0;
  let section = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
    } else if (ch === '十') {
      section += (current === 0 ? 1 : current) * 10;
      current = 0;
    } else if (ch === '百') {
      section += (current === 0 ? 1 : current) * 100;
      current = 0;
    } else if (ch === '千') {
      section += (current === 0 ? 1 : current) * 1000;
      current = 0;
    } else if (ch === '万') {
      total += (section + current) * 10000;
      section = 0;
      current = 0;
    } else {
      return NaN;
    }
  }
  return total + section + current;
}

/** 是否为中文（含中文标点与汉字） */
export function isChinese(ch: string): boolean {
  return /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch);
}

/** 按中文字符计数（去空白后） */
export function countChars(text: string): number {
  return stripWhitespace(text).length;
}

/**
 * 提取可读的短引文（用于 locate_issues / SideEffect 展示）。
 * 不能太长——轨迹面板要一屏能读完。
 */
export function snippetAround(text: string, at: number, radius = 12): string {
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * 命中区间的原文片段：命中本身（`[start, start+len)`）前后各带 `pad` 个字符，越界补 `…`。
 *
 * ★ 这条口径**同时是"正文改过就不许画"的依据**，所以它是全仓唯一的一份：
 *   生产端 `shared/ai-flavor/engine.ts` 与 `main/tools/impl/analyze.ts` 用它写 excerpt，
 *   消费端 `renderer/components/editor/inline-marks.ts` 用当前正文在同一位置重算一遍，
 *   逐字不一致就丢弃那条。两边各写一份的话，只要 pad 或补省略号的条件漂了，
 *   回验就会**永远失败**（标注静默消失）或**永远通过**（波浪线画到别的句子上）。
 *
 * 与 snippetAround 的差别不是 pad 大小，而是**锚点**：这里 `start` 是命中的起点，
 * 片段要把整条命中框住（`start+len+pad`）；snippetAround 把 `at` 当中心，
 * 长命中会被截断，反推不出命中有多长，所以不能拿来做回验。
 */
export function excerptAround(text: string, start: number, len: number, pad = 12): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, start + len + pad);
  const head = s > 0 ? '…' : '';
  const tail = e < text.length ? '…' : '';
  return `${head}${text.slice(s, e)}${tail}`;
}

/** 参数摘要：截断长文本，避免把整章正文塞进轨迹面板 */
export function summarizeArg(v: unknown, maxLen = 60): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    const oneLine = v.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return String(v);
  }
}