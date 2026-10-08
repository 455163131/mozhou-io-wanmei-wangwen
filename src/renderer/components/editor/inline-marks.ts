/**
 * 审稿行内标注（§4 第 7 条）的纯映射层。
 *
 * textarea 里塞不进 HTML，所以行内 wavy 靠"背后一层同字体的镜像 div"实现：
 * 镜像层文字透明、只让 `text-decoration-color` 显色，textarea 叠在上面。
 * 两层能不能对齐，全靠这里的区间是对的，所以它必须是纯函数、可单测。
 *
 * ★ 核心不是"画得出"，而是"什么时候不许画"：`FlavorHit.offset` 是检测那一刻的坐标，
 *   正文一改就整体漂移，波浪线会指到别的句子上。这里用引擎自己的 excerpt 口径
 *   （`engine.ts:940 excerptOf`：命中前后各 12 字上下文，越界补 `…`）拿当前正文在同一
 *   位置重算一遍，逐字不一致就丢弃这条——对"只按了一个回车"这类去空白字数不变的
 *   改动同样有效，这是字数兜底做不到的。
 */
import { FLAVOR_DIMENSION_NAMES, type FlavorDimension } from '@shared/types/ai-flavor';

/**
 * 渲染层实际拿到的命中形状。
 * ★ 这里故意不收窄成 `FlavorHit`：`FlavorScanResult.hits`（`ipc.ts:342`）把
 *   dimension/level 写成了 `string`——那是"老报告反序列化不许报错"的宽松口径，
 *   映射层跟着放宽才能直接吃 IPC 返回值，而不是逼调用方 cast。
 */
export interface HitLike {
  dimension: string;
  kind: string;
  level: string;
  severity: number;
  excerpt: string;
  offset: number;
  length: number;
  paragraphNo: number;
  reason: string;
  advice: string;
}

/** 与 engine.ts:940 的 pad 默认值一致 */
const EXCERPT_PAD = 12;

/** 档位从重到轻；合并重叠区间时保留更重的那一档 */
const LEVEL_ORDER: Record<string, number> = {
  clean: 0,
  mild: 1,
  suspicious: 2,
  heavy: 3,
  severe: 4,
};

export interface InlineMark {
  /** 正文字符偏移，含 */
  start: number;
  /** 不含 */
  end: number;
  level: string;
  /** 原因文案：维度名 + 原因（多条合并时用「；」连着写）。textarea 盖在上面，`title` 悬停触发不了，所以由编辑器打在工具栏下方 */
  title: string;
}

/** 镜像层的一段：带 mark 的那段画波浪线，不带的原样输出 */
export interface InlineSegment {
  text: string;
  mark: InlineMark | null;
}

/** 按引擎口径重算某个位置在该文本里的 excerpt */
function excerptAt(text: string, start: number, len: number, pad = EXCERPT_PAD): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, start + len + pad);
  return `${s > 0 ? '…' : ''}${text.slice(s, e)}${e < text.length ? '…' : ''}`;
}

function heavier(a: string, b: string): string {
  return (LEVEL_ORDER[b] ?? 0) > (LEVEL_ORDER[a] ?? 0) ? b : a;
}

/**
 * 命中 → 不重叠、按起点升序的标注区间。
 * 不合格的命中**整条丢掉**而不是夹断：夹断等于把线画到邻句去。
 */
export function marksFromHits(
  hits: readonly HitLike[] | null | undefined,
  body: string,
): InlineMark[] {
  if (!hits?.length) return [];
  const kept: InlineMark[] = [];
  for (const h of hits) {
    const start = h.offset;
    const len = h.length;
    if (!Number.isInteger(start) || !Number.isInteger(len)) continue;
    if (start < 0 || len <= 0 || start + len > body.length) continue;
    if (!h.excerpt) continue; // 老报告或 includeExcerpts=false：没法逐字回验
    if (h.excerpt !== excerptAt(body, start, len)) continue; // 正文改过，坐标已漂
    const span = body.slice(start, start + len);
    if (!span.trim()) continue; // 全是空白，画上去只是噪声
    const dim = FLAVOR_DIMENSION_NAMES[h.dimension as FlavorDimension] ?? h.dimension;
    kept.push({ start, end: start + len, level: h.level, title: `${dim}｜${h.reason}（改法：${h.advice}）` });
  }

  kept.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: InlineMark[] = [];
  for (const m of kept) {
    const prev = merged[merged.length - 1];
    // 相接（prev.end === m.start）也合并：两段挨着的波浪线看着像一条断了的
    if (prev && m.start <= prev.end) {
      prev.end = Math.max(prev.end, m.end);
      prev.level = heavier(prev.level, m.level);
      if (!prev.title.includes(m.title)) prev.title = `${prev.title}；${m.title}`;
      continue;
    }
    merged.push({ ...m });
  }
  return merged;
}

/** 把正文切成「有标注 / 无标注」的连续段；拼回去逐字等于原文 */
export function segmentsOf(body: string, marks: readonly InlineMark[]): InlineSegment[] {
  if (!marks.length) return [{ text: body, mark: null }];
  const out: InlineSegment[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) out.push({ text: body.slice(cursor, m.start), mark: null });
    out.push({ text: body.slice(m.start, m.end), mark: m });
    cursor = m.end;
  }
  if (cursor < body.length) out.push({ text: body.slice(cursor), mark: null });
  return out;
}
