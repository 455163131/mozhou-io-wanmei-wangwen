/**
 * run 的读侧（§4 第 26 条）。
 *
 * 只回答两个问题：**上次有没有 run 没走到收尾**、**这句提示报过没有**。
 *
 * ★ 为什么单独建一个 repo：`services.ts` 里的 `saveRun` 是内联 SQL，而 AppServices
 *   在 `ELECTRON_RUN_AS_NODE` 下根本造不出来（它 import electron 的 `app`），
 *   于是那段检测口径以前**一行测试都写不了**——也正是它能空转到今天的原因。
 *   本文件只吃注入的 db 句柄，可以直接喂真 `:memory:` 迁移库断言。
 */
import type { Database } from 'better-sqlite3';
import type { RunStats } from '@shared/types/agent';

/** 提示要说的三件事：哪条 run、停在第几步、保住了多少改动 */
export interface UnclosedRun {
  runId: string;
  goal: string;
  stats: RunStats;
  keptChanges: number;
}

const ZERO_STATS: RunStats = {
  steps: 0,
  tokensIn: 0,
  tokensOut: 0,
  costCny: 0,
  wallMs: 0,
  toolCalls: 0,
  edits: 0,
  checkpoints: 0,
};

export class RunRepo {
  constructor(private readonly db: Database) {}

  /**
   * 本项目没走到收尾、且还没提示过的 run（新的在前）。
   * 口径是 `status <> 'terminated'`——**不看 ended_at**，因为被强杀的 run
   * 连结束时刻都不知道；也**不改 status**，那条 run 确实没收尾，历史里就该这么记着。
   */
  listUnclosed(projectId: string): UnclosedRun[] {
    const rows = this.db
      .prepare(
        "SELECT id, goal, stats_json, kept_changes FROM runs " +
          "WHERE project_id = ? AND status <> 'terminated' AND unclosed_reported_at IS NULL " +
          'ORDER BY started_at DESC',
      )
      .all(projectId) as Array<{
      id: string;
      goal: string;
      stats_json: string | null;
      kept_changes: number;
    }>;
    return rows.map((r) => ({
      runId: r.id,
      goal: r.goal,
      stats: parseStats(r.stats_json),
      keptChanges: r.kept_changes,
    }));
  }

  /**
   * 记下「这句提示已经说过了」。一次性——否则强杀一次，此后每次开项目都弹同一条，
   * 比不弹更糟：用户会以为每次都崩了一回。
   * 只碰这一行、只碰还没记过的行；重复调用不改写第一次的时刻。
   */
  markReported(runId: string, now: number): void {
    this.db
      .prepare('UPDATE runs SET unclosed_reported_at = ? WHERE id = ? AND unclosed_reported_at IS NULL')
      .run(now, runId);
  }
}

/** stats_json 缺失或来自旧结构时给零值：一条旧行不该让项目打不开，也不该编一个好看的数 */
function parseStats(json: string | null): RunStats {
  if (!json) return { ...ZERO_STATS };
  try {
    return { ...ZERO_STATS, ...(JSON.parse(json) as Partial<RunStats>) };
  } catch {
    return { ...ZERO_STATS };
  }
}
