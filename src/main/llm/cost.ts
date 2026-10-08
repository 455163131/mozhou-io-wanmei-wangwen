/**
 * 成本计算（架构 §1.4.5）。
 *
 * ★ **必须先判 pricing===0 再走金额累加**，而不是先算金额再判（架构原话）。
 *
 *   本地模型（Ollama / LM Studio）单价为 0，若照常累加会得到 costCny = 0，
 *   闸门②的 maxCostCny 就永远不触发，Agent 可能跑到天亮。
 *   正确做法：本地模型改记「本机耗时」，闸门②退化为 token + 本机耗时双约束。
 *   本机耗时给了用户一个「为什么不用云端」的参照——他能看到自己的 CPU 烧了多久。
 */
import type { LlmProvider, LlmUsage } from '@shared/types/provider';

export interface CostState {
  tokensIn: number;
  tokensOut: number;
  /** 元。本地模型恒为 0 */
  costCny: number;
  /** 本机耗时（毫秒）。本地模型的「成本」参照 */
  localMs: number;
  /** 请求次数 */
  requests: number;
}

export function newCostState(): CostState {
  return { tokensIn: 0, tokensOut: 0, costCny: 0, localMs: 0, requests: 0 };
}

export function isFree(provider: LlmProvider): boolean {
  return provider.pricing.inputPerMTok === 0 && provider.pricing.outputPerMTok === 0;
}

/** 累加一次调用的 token 与成本 */
export function accrueCost(state: CostState, provider: LlmProvider, usage: LlmUsage): CostState {
  state.tokensIn += usage.input;
  state.tokensOut += usage.output;
  state.localMs += usage.wallMs;
  state.requests += 1;

  // ★ 先判零价，再累加金额。
  //   零价的含义是「这次调用不增加成本」，**不是**「把已累计的成本清零」。
  //   修复前这里写 `state.costCny = 0`：运行中一旦切到本地 provider
  //   （Ollama / LM Studio / custom 的 pricing 恒为 0），之前云端调用累计的
  //   花费会被直接抹掉 → `maxCostCny` 预算闸门读到的永远偏小，形同虚设。
  if (isFree(provider)) {
    return state;
  }

  state.costCny +=
    (usage.input / 1e6) * provider.pricing.inputPerMTok +
    (usage.output / 1e6) * provider.pricing.outputPerMTok;
  return state;
}

/** 估算一次调用的费用（用于 UI 预估，不计入累计） */
export function estimateCost(provider: LlmProvider, input: number, output: number): number {
  if (isFree(provider)) return 0;
  return (
    (input / 1e6) * provider.pricing.inputPerMTok +
    (output / 1e6) * provider.pricing.outputPerMTok
  );
}

/** 粗略 token 估算：中文 1 字 ≈ 0.67 token（1 token ≈ 1.5 字） */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 1.5);
}

/** 成本格式化：本地模型显示耗时而非金额 */
export function formatCost(state: CostState, provider: LlmProvider): string {
  if (isFree(provider)) {
    const hours = state.localMs / 3_600_000;
    if (hours >= 1) return `本机耗时 ${hours.toFixed(1)} 小时`;
    const minutes = state.localMs / 60_000;
    if (minutes >= 1) return `本机耗时 ${minutes.toFixed(1)} 分钟`;
    return `本机耗时 ${(state.localMs / 1000).toFixed(0)} 秒`;
  }
  return `¥${state.costCny.toFixed(4)}`;
}