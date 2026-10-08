/**
 * 专家团记录持久化。
 *
 * ★ 拆两张表的理由：意见单独存表后可独立聚合，
 *   回答「哪个角色最常提哪类问题」「什么意见最终被采纳」，
 *   这些是后续做权重自动调优的数据基础。
 */
import type { Database } from 'better-sqlite3';
import type {
  DimensionVerdict,
  ExpertOpinion,
  ExpertRoleKey,
  ReviewStage,
} from '@shared/types/expert';

export interface ReviewRecord {
  id: string;
  projectId: string;
  stage: ReviewStage;
  targetIds: string[];
  roles: ExpertRoleKey[];
  verdicts: DimensionVerdict[];
  summary: unknown;
  providerId?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costCny: number;
  durationMs: number;
  status: 'ok' | 'partial' | 'failed' | 'aborted';
  error?: string;
  createdAt: number;
}

export class ExpertReviewRepo {
  constructor(private readonly db: Database) {}

  /**
   * 写入一次评审及其全部意见。
   * 整体一个事务：不允许出现「有评审记录但意见丢了」的半截状态。
   */
  save(rec: ReviewRecord): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO expert_reviews
             (id, project_id, stage, target_ids, roles, verdicts, summary,
              provider_id, model, tokens_in, tokens_out, cost_cny, duration_ms,
              status, error, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          rec.id,
          rec.projectId,
          rec.stage,
          JSON.stringify(rec.targetIds),
          JSON.stringify(rec.roles),
          JSON.stringify(rec.verdicts),
          JSON.stringify(rec.summary),
          rec.providerId ?? null,
          rec.model ?? null,
          rec.tokensIn,
          rec.tokensOut,
          rec.costCny,
          rec.durationMs,
          rec.status,
          rec.error ?? null,
          rec.createdAt,
        );

      const ins = this.db.prepare(
        `INSERT INTO expert_opinions
           (id, review_id, role, dimension, severity, verdict, weight,
            cross_boundary, adopted, evidence, suggestion, raw)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const v of rec.verdicts) {
        for (const op of v.opinions) {
          ins.run(
            `${rec.id}:${op.role}:${v.dimension}:${op.suggestion.slice(0, 24)}`,
            rec.id,
            op.role,
            v.dimension,
            op.severity,
            op.verdict,
            op.effectiveWeight ?? 0.8,
            op.crossBoundary ? 1 : 0,
            // 裁决结果映射到 adopted：accept=1，reject=0，defer=NULL（待作者裁决）
            v.decision === 'accept' ? 1 : v.decision === 'reject' ? 0 : null,
            op.evidence,
            op.suggestion,
            null,
          );
        }
      }
    });
    tx();
  }

  /** 某项目的评审历史，倒序 */
  listByProject(projectId: string, limit = 20): ReviewRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM expert_reviews
         WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * 作者对某维度的最终裁决（处理 defer 项）。
   *
   * ★ 这是「弃权是一等公民」的闭环：裁决引擎给出 defer 后，
   *   必须有一个入口让作者拍板，且这个决定要留痕——
   *   后续做权重调优时，「作者怎么判的」是最有价值的标签。
   */
  decide(reviewId: string, dimension: string, decision: 'accept' | 'reject'): void {
    this.db
      .prepare(
        `UPDATE expert_opinions SET adopted = ?
         WHERE review_id = ? AND dimension = ?`,
      )
      .run(decision === 'accept' ? 1 : 0, reviewId, dimension);
  }

  /** 单次评审的完整意见（分析采纳率用） */
  opinionsOf(reviewId: string): ExpertOpinion[] {
    const rows = this.db
      .prepare(
        `SELECT role, dimension, severity, verdict, weight, cross_boundary, evidence, suggestion
         FROM expert_opinions WHERE review_id = ? ORDER BY severity DESC`,
      )
      .all(reviewId) as Record<string, unknown>[];
    return rows.map((r) => ({
      role: r.role as ExpertOpinion['role'],
      dimension: r.dimension as ExpertOpinion['dimension'],
      severity: r.severity as ExpertOpinion['severity'],
      verdict: r.verdict as ExpertOpinion['verdict'],
      effectiveWeight: r.weight as number,
      crossBoundary: r.cross_boundary === 1,
      evidence: (r.evidence as string) ?? '',
      suggestion: (r.suggestion as string) ?? '',
    }));
  }

  /**
   * 维度维度的统计：每个维度被提了多少次、多少次真被采纳。
   * 这是权重调优的输入——长期被采纳率低的角色可以降权。
   */
  dimensionStats(projectId: string): {
    dimension: string;
    total: number;
    accepted: number;
    deferred: number;
  }[] {
    return this.db
      .prepare(
        `SELECT o.dimension AS dimension,
                COUNT(*) AS total,
                SUM(CASE WHEN o.adopted = 1 THEN 1 ELSE 0 END) AS accepted,
                SUM(CASE WHEN o.adopted IS NULL THEN 1 ELSE 0 END) AS deferred
         FROM expert_opinions o
         JOIN expert_reviews r ON r.id = o.review_id
         WHERE r.project_id = ?
         GROUP BY o.dimension
         ORDER BY total DESC`,
      )
      .all(projectId) as {
      dimension: string;
      total: number;
      accepted: number;
      deferred: number;
    }[];
  }

  private toRecord(r: Record<string, unknown>): ReviewRecord {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      stage: r.stage as ReviewStage,
      targetIds: JSON.parse(r.target_ids as string),
      roles: JSON.parse(r.roles as string),
      verdicts: JSON.parse(r.verdicts as string),
      summary: JSON.parse(r.summary as string),
      providerId: (r.provider_id as string) ?? undefined,
      model: (r.model as string) ?? undefined,
      tokensIn: r.tokens_in as number,
      tokensOut: r.tokens_out as number,
      costCny: r.cost_cny as number,
      durationMs: r.duration_ms as number,
      status: r.status as ReviewRecord['status'],
      error: (r.error as string) ?? undefined,
      createdAt: r.created_at as number,
    };
  }
}
