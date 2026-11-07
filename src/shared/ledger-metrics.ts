/**
 * 台账度量纯函数（P2-B，Task 4/5/6/7 的共同地基）。
 *
 * ★ 分层铁律：本文件是纯 string/number 计算，不 import Node/Electron/DOM，
 *   只允许 import ./types/ledger 的类型（见 external-url.ts 同款理由——
 *   放在 shared 才能被 node 环境 vitest 直接覆盖，债务曲线这类
 *   "账面数字"必须有回归护栏）。
 *
 * 章号定位（SourceRef.chapterId → 故事章号）由调用侧注入：
 *   debtSeries 接受 plantedChapterNo / resolvedChapterNo 两个访问器，
 *   本模块不认识 SQLite，也不认识 chapters 表。定位不到的坏 ref 返回 null，
 *   对应条目整条跳过——宁可少计债，不虚增（账面虚高会误导作者补写）。
 */
import type { Foreshadow } from './types/ledger';

/**
 * 伏笔重要性 → 债务权重。
 * 缺省按 B：Agent 维护的旧行没有 weight 字段，炸账或按 0 计都会
 * 让历史项目的债务曲线突变（UI 空态在 Task 4/6 处理，这里只保证算得动）。
 */
export const WEIGHT_VALUE: Record<'A' | 'B' | 'C', number> = { A: 3, B: 2, C: 1 };

/** 未偿伏笔距埋设超过该章数即判红（逾期线，作者可据此排回收优先级） */
export const OVERDUE_GAP_CHAPTERS = 20;

/**
 * 未偿债务曲线（R48 裁决：章末口径）。
 * 下标 i 的项 = 第 i+1 章**写完时点**的未偿债务分：
 *   - 埋设章章末即计债（读者读完那一章，钩子已经挂上）；
 *   - 回收章章末归零（当章回收当章销账，不留"半章债"）。
 * 逐条判 plantedNo <= k 且（未回收 或 resolvedNo > k）；
 * plantedNo 为 null（坏 ref）整条跳过，不虚增。
 */
export function debtSeries(
  foreshadows: Foreshadow[],
  plantedChapterNo: (f: Foreshadow) => number | null,
  resolvedChapterNo: (f: Foreshadow) => number | null,
  maxChapter: number,
): number[] {
  const series: number[] = [];
  for (let k = 1; k <= maxChapter; k++) {
    let sum = 0;
    for (const f of foreshadows) {
      const plantedNo = plantedChapterNo(f);
      if (plantedNo === null) continue;
      if (plantedNo > k) continue;
      const resolvedNo = resolvedChapterNo(f);
      if (resolvedNo === null || resolvedNo > k) {
        sum += WEIGHT_VALUE[f.weight ?? 'B'];
      }
    }
    series.push(sum);
  }
  return series;
}

/**
 * 单条伏笔的红黄绿状态（台账行内色点用）。
 * 判定顺序刻意先排除 resolved，再排除"定位不到"：
 *   - plantedNo 为 null → yellow。定位不到埋设章就没有"距埋设多少章"，
 *     拿假数据判红是对作者的不诚实（对齐"系统不裁决"的台账基调）。
 *   - latestNo < plantedNo → yellow。草稿章号可能领先于埋设章（分卷/插章），
 *     此时"gap 为负"不该算逾期。
 */
export function ledgerStatus(
  f: Foreshadow,
  plantedNo: number | null,
  latestNo: number,
): 'green' | 'yellow' | 'red' {
  if (f.status === 'resolved') return 'green';
  if (plantedNo === null) return 'yellow';
  if (latestNo >= plantedNo && latestNo - plantedNo >= OVERDUE_GAP_CHAPTERS) return 'red';
  return 'yellow';
}

/**
 * 以 offset+quote 为中心取 ±radius 的原文窗口（证据摘录卡用）。
 * 钳位两头不抛：offset 落在正文边缘时截到边界，宁可短窗不可错位。
 * offset 超出正文长度 → 回空串：正文被改写过，旧引用已失效，
 * 调用侧据空串显示"定位失败"诚实态，而不是硬凑一段误导性的上下文。
 * 空/纯白 quote 同判（终审修复波 B）：手录行（manual-add/markResolved）
 * 没有登记证据原文，offset 0 会取到章首窗口冒充「埋设/回收原文」——
 * 回空串让调用侧的诚实 miss 态可达，不编造内容当事实。
 */
export function excerptAround(body: string, offset: number, quote: string, radius: number = 60): string {
  if (!quote.trim() || offset < 0 || offset >= body.length) return '';
  const start = Math.max(0, offset - radius);
  const end = Math.min(body.length, offset + quote.length + radius);
  return body.slice(start, end);
}
