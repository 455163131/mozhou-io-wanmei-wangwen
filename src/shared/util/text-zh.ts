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