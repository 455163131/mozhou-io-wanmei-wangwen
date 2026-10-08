/**
 * 四层闸门（架构 §1.4.1）。
 *
 * 每层都必须产出**可读的终止原因**——架构原话：「每层都要产出可读的终止原因」。
 * 只返回一个布尔值是不够的：用户看到「已停止」不知道是超预算还是撞循环，
 * 下次还是不知道该怎么调预算。
 *
 * ⚠️ 闸门终止**不回滚**已完成改动。理由（架构 §1.4.1 关键决策）：
 *   Agent 可能已经改好了 7 章，第 8 章超预算——全盘回滚等于白烧钱。
 *   改为：保留改动 + 撤销按钮常驻 + 轨迹面板明示「因预算停止，已改动 N 处」。
 */
import type { BudgetLimits, RunStats, TerminationReason } from '@shared/types/agent';
import { MAX_NO_PROGRESS, MAX_VALIDATION_FAILURE } from '@shared/constants/budget';

/** 闸门④ 的循环判定结果由 LoopDetector 给出，此处只接收结论 */
export interface LoopVerdict {
  kind: 'repeat-arg' | 'oscillation' | 'no-effect';
  toolName?: string;
  times?: number;
  argsHash?: string;
  pattern?: string;
  unchangedSteps?: number;
}

export class BudgetGuard {
  private steps = 0;
  private stalls = 0;
  private consecutiveFailures = 0;
  /** 连续参数校验失败次数（与执行失败分开统计） */
  private validationFailures = 0;
  private lastValidationErrors: string[] = [];
  private lastError = '';
  private localWallMs = 0;

  constructor(private readonly limits: BudgetLimits) {}

  get stepCount(): number {
    return this.steps;
  }

  get stallCount(): number {
    return this.stalls;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }

  /** 闸门① 步数上限 */
  checkSteps(): TerminationReason | null {
    this.steps += 1;
    if (this.steps > this.limits.maxSteps) {
      return { code: 'MAX_STEPS', used: this.steps, limit: this.limits.maxSteps };
    }
    return null;
  }

  /**
   * 闸门② token / 成本上限。
   * 本地模型 maxCostCny 恒不触发（pricing 为 0），退化为 token + 本机耗时双约束。
   */
  checkBudget(stats: RunStats, isLocal: boolean): TerminationReason | null {
    if (stats.tokensIn + stats.tokensOut >= this.limits.maxTokens) {
      return {
        code: 'BUDGET_EXCEEDED',
        spentCny: stats.costCny,
        limitCny: this.limits.maxCostCny,
        spentTokens: stats.tokensIn + stats.tokensOut,
      };
    }
    if (!isLocal && stats.costCny >= this.limits.maxCostCny) {
      return {
        code: 'BUDGET_EXCEEDED',
        spentCny: stats.costCny,
        limitCny: this.limits.maxCostCny,
        spentTokens: stats.tokensIn + stats.tokensOut,
      };
    }
    // 本机耗时：防本地模型跑几小时不收敛
    this.localWallMs = stats.wallMs;
    if (isLocal && this.localWallMs >= this.limits.maxWallMs) {
      return {
        code: 'BUDGET_EXCEEDED',
        spentCny: 0,
        limitCny: 0,
        spentTokens: stats.tokensIn + stats.tokensOut,
      };
    }
    return null;
  }

  /** 闸门③ 无进展检测：连续 N 次 progress==='none' */
  recordProgress(progress: 'positive' | 'partial' | 'none' | 'negative'): TerminationReason | null {
    if (progress === 'none') {
      this.stalls += 1;
    } else {
      this.stalls = 0;
    }
    if (this.stalls >= MAX_NO_PROGRESS) {
      return { code: 'NO_PROGRESS', stalls: this.stalls };
    }
    return null;
  }

  /** 闸门④ 循环检测（判据由 LoopDetector 给出） */
  checkLoop(verdict: LoopVerdict | null): TerminationReason | null {
    if (!verdict) return null;
    if (verdict.kind === 'repeat-arg') {
      return {
        code: 'LOOP_REPEAT_ARG',
        toolName: verdict.toolName ?? 'unknown',
        times: verdict.times ?? 0,
        argsHash: verdict.argsHash ?? '',
      };
    }
    if (verdict.kind === 'oscillation') {
      return { code: 'LOOP_STATE_OSCILLATION', pattern: verdict.pattern ?? '' };
    }
    return { code: 'LOOP_NO_EFFECT', unchangedSteps: verdict.unchangedSteps ?? 0 };
  }

  /** 闸门⑤ 连续失败 */
  recordToolResult(ok: boolean, errorMessage?: string): TerminationReason | null {
    if (ok) {
      this.consecutiveFailures = 0;
      this.validationFailures = 0;
      return null;
    }
    this.consecutiveFailures += 1;
    this.lastError = errorMessage ?? '未知错误';
    if (this.consecutiveFailures >= 3) {
      return {
        code: 'CONSECUTIVE_FAILURE',
        failures: this.consecutiveFailures,
        lastError: this.lastError,
      };
    }
    return null;
  }

  /**
   * ★ 校验失败专用闸门（架构的 10 种终止原因之一，此前未接线）。
   *
   *为什么要单独一条：参数校验失败（Zod / 模型返回非法结构）与「工具执行失败」
   *是**性质不同**的两件事——
   *   · 校验失败 = 模型没按 schema 填参数，**回喂逐项点名错误让它自纠**是最有效的修法；
   *   · 执行失败 = 工具本身出问题（IO 失败、正文为空），重试同样输入只会同样失败。
   * 混在 CONSECUTIVE_FAILURE 里会导致：模型收到笼统的「连续失败」，
   * 不知道是自己参数写错了，于是一错再错。
   */
  recordValidationFailure(errors: string[]): TerminationReason | null {
    this.validationFailures += 1;
    this.lastValidationErrors = errors;
    if (this.validationFailures >= MAX_VALIDATION_FAILURE) {
      return {
        code: 'VALIDATION_FAILED',
        // ★ 带上具体错误路径，让用户与模型都能知道「哪里填错了」
        errors: errors.slice(0, 10),
      };
    }
    return null;
  }

  get validationFailureCount(): number {
    return this.validationFailures;
  }

  /** 最近一次校验失败的具体错误路径（进轨迹面板） */
  get lastValidation(): string[] {
    return this.lastValidationErrors;
  }

  reset(): void {
    this.steps = 0;
    this.stalls = 0;
    this.consecutiveFailures = 0;
    this.validationFailures = 0;
    this.lastValidationErrors = [];
    this.lastError = '';
    this.localWallMs = 0;
  }

  /** 剩余预算，供 UI 预算仪表显示 */
  remaining(stats: RunStats, isLocal: boolean): {
    stepsLeft: number;
    tokensLeft: number;
    costLeftCny: number;
  } {
    return {
      stepsLeft: Math.max(0, this.limits.maxSteps - this.steps),
      tokensLeft: Math.max(0, this.limits.maxTokens - (stats.tokensIn + stats.tokensOut)),
      costLeftCny: isLocal ? Number.POSITIVE_INFINITY : Math.max(0, this.limits.maxCostCny - stats.costCny),
    };
  }
}