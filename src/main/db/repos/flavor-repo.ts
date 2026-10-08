/**
 * AI 味检测板块 · 持久化。
 *
 * ★ 独立板块的落地点：自有三张表（flavor_scans / flavor_rewrites / flavor_config），
 *   与专家团的 expert_reviews 完全无关。删掉本板块不必碰专家团的表。
 */
import type { Database } from 'better-sqlite3';
import type { FlavorConfig, FlavorReport } from '@shared/types/ai-flavor';
import { DEFAULT_FLAVOR_CONFIG } from '@shared/types/ai-flavor';

export interface FlavorScanRecord {
  id: string;
  projectId: string;
  chapterId: string;
  report: FlavorReport;
}

export interface FlavorRewriteRecord {
  id: string;
  projectId: string;
  chapterId: string;
  scanId?: string;
  path: 'auto-rule' | 'agent';
  runId?: string;
  changedCount: number;
  beforeIndex: number;
  afterIndex: number;
  delta: number;
  regressedDims: string[];
  edits: unknown;
  message: string;
}

export class FlavorRepo {
  constructor(private readonly db: Database) {}

  /** 保存一次检测 */
  saveScan(rec: FlavorScanRecord): void {
    const r = rec.report;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO flavor_scans
           (id, project_id, chapter_id, index_score, level, chars, paragraphs,
            hit_count, dominant_dim, sufficient, engine_version, dimensions,
            report, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rec.id,
        rec.projectId,
        rec.chapterId,
        r.index,
        r.level,
        r.chars,
        r.paragraphs,
        r.hits.length,
        r.dominantDimension,
        r.sufficient ? 1 : 0,
        r.engineVersion,
        JSON.stringify(r.dimensions),
        JSON.stringify(r),
        r.at,
      );
  }

  /** 最近一次检测（用于「上次是多少分」的对比） */
  latestScan(projectId: string, chapterId: string): FlavorReport | null {
    const row = this.db
      .prepare(
        `SELECT report FROM flavor_scans
         WHERE project_id = ? AND chapter_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, chapterId) as { report: string } | undefined;
    return row ? (JSON.parse(row.report) as FlavorReport) : null;
  }

  /**
   * 章节的分数趋势（最近的若干次）。
   * 用途：UI 上画「这章 AI 味有没有在降」。
   * ★ 只取口径相同的记录——引擎版本变了分数不可比，混在一起画会误导。
   */
  scoreTrend(
    projectId: string,
    chapterId: string,
    limit = 10,
  ): { index: number; level: string; at: number; engineVersion: string }[] {
    const rows = this.db
      .prepare(
        `SELECT index_score, level, created_at, engine_version FROM flavor_scans
         WHERE project_id = ? AND chapter_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, chapterId, limit) as Record<string, unknown>[];
    const cur = rows[0]?.engine_version;
    return rows
      .filter((r) => r.engine_version === cur) // 口径不同不可比
      .map((r) => ({
        index: r.index_score as number,
        level: r.level as string,
        at: r.created_at as number,
        engineVersion: r.engine_version as string,
      }))
      .reverse(); // 时间正序，便于直接画图
  }

  /** 保存改写记录（含前后分对比） */
  saveRewrite(rec: FlavorRewriteRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO flavor_rewrites
           (id, project_id, chapter_id, scan_id, path, run_id, changed_count,
            before_index, after_index, delta, regressed_dims, edits, message, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rec.id,
        rec.projectId,
        rec.chapterId,
        rec.scanId ?? null,
        rec.path,
        rec.runId ?? null,
        rec.changedCount,
        rec.beforeIndex,
        rec.afterIndex,
        rec.delta,
        JSON.stringify(rec.regressedDims),
        JSON.stringify(rec.edits),
        rec.message,
        Date.now(),
      );
  }

  /** 改写历史（UI 的「改动前后对比」列表） */
  listRewrites(
    projectId: string,
    chapterId: string,
    limit = 20,
  ): FlavorRewriteRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flavor_rewrites
         WHERE project_id = ? AND chapter_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, chapterId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      chapterId: r.chapter_id as string,
      scanId: (r.scan_id as string) ?? undefined,
      path: r.path as 'auto-rule' | 'agent',
      runId: (r.run_id as string) ?? undefined,
      changedCount: r.changed_count as number,
      beforeIndex: r.before_index as number,
      afterIndex: r.after_index as number,
      delta: r.delta as number,
      regressedDims: JSON.parse((r.regressed_dims as string) ?? '[]'),
      edits: JSON.parse((r.edits as string) ?? '[]'),
      message: (r.message as string) ?? '',
    }));
  }

  /** 读配置（不存在则返回默认值并落库） */
  loadConfig(projectId: string): FlavorConfig {
    const row = this.db
      .prepare('SELECT config FROM flavor_config WHERE project_id = ?')
      .get(projectId) as { config: string } | undefined;
    if (!row) return { ...DEFAULT_FLAVOR_CONFIG };
    // ★ 与默认值合并：新增维度时老配置不会缺字段
    return { ...DEFAULT_FLAVOR_CONFIG, ...(JSON.parse(row.config) as Partial<FlavorConfig>) };
  }

  saveConfig(projectId: string, config: FlavorConfig): void {
    this.db
      .prepare(
        `INSERT INTO flavor_config (project_id, config, updated_at)
         VALUES (?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET config = excluded.config,
                                              updated_at = excluded.updated_at`,
      )
      .run(projectId, JSON.stringify(config), Date.now());
  }

  /** 项目级维度命中统计（看这本稿子最常犯哪类 AI 腔） */
  dimensionStats(
    projectId: string,
  ): { dimension: string; total: number; avgIndex: number }[] {
    const rows = this.db
      .prepare(
        `SELECT dimensions, index_score FROM flavor_scans WHERE project_id = ?`,
      )
      .all(projectId) as { dimensions: string; index_score: number }[];
    const acc = new Map<string, { n: number; sum: number; idxSum: number }>();
    for (const r of rows) {
      const dims = JSON.parse(r.dimensions) as { dimension: string; score: number }[];
      for (const d of dims) {
        const cur = acc.get(d.dimension) ?? { n: 0, sum: 0, idxSum: 0 };
        cur.n += 1;
        cur.sum += d.score;
        cur.idxSum += r.index_score;
        acc.set(d.dimension, cur);
      }
    }
    return [...acc.entries()]
      .map(([dimension, v]) => ({
        dimension,
        total: v.n,
        avgIndex: Math.round(v.idxSum / Math.max(1, v.n)),
      }))
      .sort((a, b) => b.avgIndex - a.avgIndex);
  }
}
