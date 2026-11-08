/**
 * 发布排期纯函数（P2-D T4）：节奏常量 + 队列推导 + 机检明细。
 *
 * 队列不入库——每次由「章节库内序 + 节奏」纯函数推导（spec §2），
 * 确定性无 DST：plannedAt 只做纯毫秒加法（startAt + (ord-1)×天×86400000），
 * 不碰本地日历运算，跨月/跨时区逐日不差。
 *
 * CADENCE_DAYS 单源在此（自 T1 publish-plan-repo 搬家收编，★注记已兑现删除）：
 * repo 侧改 `import { CADENCE_DAYS } from '@shared/publish/schedule'`，
 * shared→main 方向铁律不破（main 可以 import shared，反向不行）。
 */
import type { Cadence, PublishQueueItem } from '@shared/types/publish';
import type { ChapterMeta } from '@shared/types/project';
import type { PlatformRule } from '@shared/constants/platforms';
import { countUnits } from './metrics';

/** 节奏 → 间隔天数（一处来源）。custom 不在此表，走 intervalDays 入参。 */
export const CADENCE_DAYS = { daily: 1, every2: 2, weekly: 7 } as const;

const DAY_MS = 86400000;

/** 非 custom 走常量；custom 取下限 1（0/负数/小数一律不短于 1 天）。 */
export function resolveIntervalDays(cadence: Cadence, intervalDays: number): number {
  if (cadence === 'custom') return Math.max(1, Math.trunc(intervalDays));
  return CADENCE_DAYS[cadence];
}

/**
 * 由章节列表（调用方给 listMeta 库内序）推导发布队列。
 * 只有 revised/done 入队；todo/draft 跳过并进 warnings（带章号与标题可审）。
 * minSize 缺规则时为 0（=不装机检），meetsSize 相应恒 true，由 validateChapter 出「未在册」提示。
 */
export function buildQueue(
  opts: { startAt: number; cadence: Cadence; intervalDays: number },
  chapters: Array<{ meta: ChapterMeta; body: string }>,
  rule: PlatformRule | undefined,
  lang: 'zh' | 'en',
): { items: PublishQueueItem[]; warnings: string[] } {
  const days = resolveIntervalDays(opts.cadence, opts.intervalDays);
  const minSize = rule?.chapterWords ?? 0;
  const items: PublishQueueItem[] = [];
  const warnings: string[] = [];
  for (const { meta, body } of chapters) {
    if (meta.status !== 'revised' && meta.status !== 'done') {
      warnings.push(`未定稿跳过：章${meta.id} ${meta.title}`);
      continue;
    }
    const ord = items.length + 1;
    const { size, unit } = countUnits(body, lang);
    items.push({
      chapterId: meta.id,
      ord,
      title: meta.title,
      status: meta.status,
      plannedAt: opts.startAt + (ord - 1) * days * DAY_MS,
      size,
      sizeUnit: unit,
      minSize,
      meetsSize: minSize === 0 || size >= minSize,
    });
  }
  return { items, warnings };
}

/** 单章机检结论明细（buildQueue 已填 meetsSize，本函数供 UI 展明细文案）。 */
export function validateChapter(item: PublishQueueItem): string[] {
  if (item.minSize === 0) return ['平台规则未在册：体量目标与惯例请人工核对'];
  if (!item.meetsSize) return [`低于平台目标 ${item.minSize}${item.sizeUnit}`];
  return [];
}
