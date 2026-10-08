/**
 * AI 味基线板块 · 持久化。
 *
 * ★ 与 `FlavorRepo`（扫面 / 改写 / 配置）同属 AI 味板块，但**各自独立**：
 *   基线库只存「用户用自己的语料算出来的基线」；内置默认基线是编译期常量
 *   （`DEFAULT_FLAVOR_BASELINE`），根本不进库。
 *   调用方取基线时：先 `latest(projectId)`，为空则回退到 `DEFAULT_FLAVOR_BASELINE`——
 *   「有没有用户基线」这个判断留在调用方，仓储层不做隐式回退（避免调用方以为存过）。
 */
import type { Database } from 'better-sqlite3';
import type { FlavorBaseline } from '@shared/ai-flavor/baseline';
import { nextId } from '@shared/util/id';

/**
 * 库中一条基线 = 基线本体 + 存储元信息。
 * 是 `FlavorBaseline` 的**超集**，故可直接当 `FlavorBaseline` 用；
 * 额外带 `id`，是为了让 UI 能拿 `list()` 的结果去 `remove(id)`。
 */
export interface StoredFlavorBaseline extends FlavorBaseline {
  /** 库内主键（删除时需要） */
  id: string;
  projectId: string;
  /** 入库时间（区别于基线本体的 `at`：`at` 是基线生成时刻，此处是落库时刻） */
  createdAt: number;
}

export class FlavorBaselineRepo {
  constructor(private readonly db: Database) {}

  /**
   * 保存一条（用户）基线，返回库内主键。
   * ★ 不做 upsert：基线是「某时刻某语料的快照」，多条历史本身有价值
   *   （可对比「换语料前后基线怎么变」），故每次都插新行。
   */
  save(projectId: string, baseline: FlavorBaseline): string {
    const id = nextId('flb');
    this.db
      .prepare(
        `INSERT INTO flavor_baselines
           (id, project_id, corpus, chapters, total_chars, engine_version, source, data, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        projectId,
        baseline.corpus,
        baseline.chapters,
        baseline.totalChars,
        baseline.engineVersion,
        baseline.source,
        JSON.stringify(baseline),
        Date.now(),
      );
    return id;
  }

  /**
   * 该项目最新一条用户基线（无则 null，由调用方回退到 DEFAULT_FLAVOR_BASELINE）。
   *
   * ★ 为什么要带 `rowid DESC`：`created_at` 是毫秒时间戳，同一毫秒内连存两条会**并列**，
   *   此时仅按 `created_at DESC` 排序结果不确定（SQLite 可能按插入顺序返回），
   *   `latest()` 会取到**旧的那条**。这是实跑复现出来的 bug，不是理论风险。
   *   rowid 随插入单调递增，用它做次级排序键即可稳定取到真正最后插入的一条。
   */
  latest(projectId: string): StoredFlavorBaseline | null {
    const row = this.db
      .prepare(
        `SELECT * FROM flavor_baselines
         WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? this.toModel(row) : null;
  }

  /** 历史列表（新的在前） */
  list(projectId: string, limit = 20): StoredFlavorBaseline[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flavor_baselines
         WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(projectId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.toModel(r));
  }

  /** 按主键删除；返回是否确实删掉了一行 */
  remove(id: string): boolean {
    const info = this.db.prepare('DELETE FROM flavor_baselines WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** 行 → 模型。JSON 解析失败时抛错（宁可暴露坏数据，也不静默返回半个基线） */
  private toModel(row: Record<string, unknown>): StoredFlavorBaseline {
    const base = JSON.parse(row.data as string) as FlavorBaseline;
    return {
      ...base,
      id: row.id as string,
      projectId: row.project_id as string,
      createdAt: row.created_at as number,
    };
  }
}
