/**
 * 全书批量扫描（架构 §1.6 工具 6 / T25）。
 *
 * 大文件策略（架构 §1.9）：
 *   - 批大小 20 章（约 50 万字），**绝不一次读全书**
 *   - 并发 2（保守值，更多可能触发 better-sqlite3 主线程阻塞）
 *   - 批读完释放引用（Map 置空让 GC 回收）
 *   - 指标全部缓存（500 章仅 0.25MB），避免重复计算
 *   - 验收：全书 500 章扫描 < 60s，主进程堆峰值 < 512MB
 */
import type { ToolContext, ToolResult } from '@shared/types/tool';
import type { ScanBatch } from '@shared/types/project';
import { SCAN_BATCH_SIZE, SCAN_CONCURRENCY } from '@shared/constants/metrics';
import { analyze, judge, isSufficient, healthScore } from '@shared/metrics-engine';
import type { BaselineLike } from '../../rule-engine/plan-fixes';

export interface ScanDeps {
  allChapterIds: () => Promise<string[]>;
  getBodies: (chapterIds: string[]) => Promise<Map<string, string>>;
  baseline: () => BaselineLike;
  /** 指标缓存写入（可空：没开项目时跳过） */
  saveMetrics?: (chapterId: string, score: number, raw: Record<string, number>, chars: number, paras: number, sents: number) => void;
}

export interface ScanResult {
  batches: ScanBatch[];
  totalChapters: number;
  avgScore: number;
  /** 表现最差的章（按健康分升序） */
  worstChapters: Array<{ chapterId: string; score: number; issueCount: number }>;
  elapsedMs: number;
}

export async function scanProject(
  args: { threshold?: number },
  ctx: ToolContext,
  deps: ScanDeps,
): Promise<ToolResult<ScanResult>> {
  const started = Date.now();
  const ids = await deps.allChapterIds();
  if (ids.length === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: '项目里还没有章节，无法扫描。',
        retryable: false,
      },
    };
  }

  const baseline = deps.baseline();
  const threshold = args.threshold;
  const batches: ScanBatch[] = [];
  const perChapter: Array<{ chapterId: string; score: number; issueCount: number }> = [];

  // 分批：每批 SCAN_BATCH_SIZE 章
  for (let i = 0; i < ids.length; i += SCAN_BATCH_SIZE) {
    if (ctx.signal.aborted) {
      // 用户叫停：已完成批次保留，停止后续
      break;
    }
    const batchIds = ids.slice(i, i + SCAN_BATCH_SIZE);
    const bodies = await deps.getBodies(batchIds);

    const issues: ScanBatch['issues'] = [];
    let scoreSum = 0;
    let counted = 0;

    // 批内按并发 2 处理（Node 侧无渲染压力，但 SQLite 写入仍是同步的）
    for (let j = 0; j < batchIds.length; j += SCAN_CONCURRENCY) {
      const group = batchIds.slice(j, j + SCAN_CONCURRENCY);
      for (const id of group) {
        const body = bodies.get(id);
        if (body === undefined) continue;
        const a = analyze(body);
        const sufficient = isSufficient(a.chars);
        const items = judge({
          raw: a.raw,
          per1000: a.per1000,
          metrics: baseline.metrics,
          markerDensity: baseline.markerDensity,
        });
        const score = healthScore(items, sufficient);
        const bad = items.filter((x) => x.level !== 'ok');

        scoreSum += score;
        counted++;
        perChapter.push({ chapterId: id, score, issueCount: bad.length });

        deps.saveMetrics?.(id, score, a.raw as unknown as Record<string, number>, a.chars, a.paras, a.sents);

        if (threshold === undefined || score < threshold) {
          for (const x of bad) {
            // items 已过滤掉 ok，故此处 level 必为 warn | risk
            issues.push({
              chapterId: id,
              key: x.key,
              label: x.label,
              value: x.value,
              band: x.band,
              level: x.level as 'warn' | 'risk',
            });
          }
        }
      }
      // 每组之间让出事件循环，避免长时间同步阻塞导致 UI 无响应
      await new Promise((r) => setImmediate(r));
    }

    batches.push({
      range: { from: batchIds[0], to: batchIds[batchIds.length - 1] },
      chapterIds: batchIds,
      avgScore: counted ? scoreSum / counted : 0,
      issues,
    });

    // ★ 批读完释放引用：正文永不做「一次读全书」
    for (const id of batchIds) bodies.delete(id);
  }

  const avgScore =
    perChapter.length > 0 ? perChapter.reduce((s, c) => s + c.score, 0) / perChapter.length : 0;

  return {
    ok: true,
    data: {
      batches,
      totalChapters: perChapter.length,
      avgScore,
      worstChapters: perChapter.slice().sort((a, b) => a.score - b.score).slice(0, 10),
      elapsedMs: Date.now() - started,
    },
    durationMs: Date.now() - started,
  };
}

/** 构造扫描批次（导出供 UI 断点续跑复用） */
export function buildBatches(ids: string[], size = SCAN_BATCH_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}