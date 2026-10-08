/**
 * 专家团 LLM 评审执行器（阶段二）。
 *
 * ★ 核心约束：**一个专家的失败不能拖垮整团**。
 *   六个专家里挂一个，不该让用户什么都拿不到。所以用 allSettled 语义
 *   逐个收集，部分失败时降级为「其余专家的意见 + 明确说明谁缺席」，
 *   而不是 Promise.all 一 reject 全盘皆输。
 *
 * ★ 预算独立：专家评审的 token/成本不计入 Agent 循环的池子，
 *   超预算时提前收手并如实告知，不静默截断。
 */
import { z } from 'zod';
import type { LlmClient } from '../llm/client';
import { LlmError } from '../llm/client';
import type { LlmProvider } from '@shared/types/provider';
import {
  EXPERT_ROLE_KEYS,
  REVIEW_DIMENSIONS,
  type ExpertOpinion,
  type ExpertRoleKey,
  type ExpertTeamConfig,
  type ReviewDimension,
  type ReviewStage,
  type RoleDefinition,
} from '@shared/types/expert';
import { buildRolePrompt, EXPERT_ROLES } from './roles';

// ── LLM 返回结构的校验 ───────────────────────────────────────────────

/**
 * ★ 用 Zod 而非手写判断：模型返回的字段名/类型都可能不符合预期，
 *   逐项点名错误比整体 try-catch 更能让调用方知道该怎么修。
 */
const OpinionSchema = z.object({
  dimension: z.enum(REVIEW_DIMENSIONS as [ReviewDimension, ...ReviewDimension[]]),
  severity: z.enum(['critical', 'major', 'minor', 'nit']),
  verdict: z.enum(['block', 'suggest', 'endorse', 'neutral']),
  evidence: z.string().min(1, 'evidence 不能为空：必须引用原文'),
  suggestion: z.string().min(1, 'suggestion 不能为空：要说清怎么改'),
});

/**
 * 宽松 JSON 解析：模型常把 JSON 包在 ```json 围栏里，或前后带解释文字。
 * 沿用原型 aiParseJson 的思路——但**只做包裹剥离**，不做语义兜底。
 */
export function parseJsonLenient(text: string): unknown {
  const trimmed = text.trim();
  // 剥 ```json ... ``` 围栏
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fence ? fence[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // 再试一次：截取首个 [ 或 { 到末尾（模型在JSON 前说了话的情况）
    const start = body.search(/[[{]/);
    if (start < 0) throw new Error('响应中找不到 JSON');
    const fromBracket = body.slice(start);
    const end = Math.max(fromBracket.lastIndexOf(']'), fromBracket.lastIndexOf('}'));
    if (end <= 0) throw new Error('JSON 未闭合');
    return JSON.parse(fromBracket.slice(0, end + 1));
  }
}

// ── 评审结果 ─────────────────────────────────────────────────────────

export interface ExpertReviewOutcome {
  opinions: ExpertOpinion[];
  /** 缺席的专家及原因（供 UI 显示「为什么只有 4 个意见」） */
  failed: { role: ExpertRoleKey; reason: string }[];
  usage: { input: number; output: number; wallMs: number; costCny: number };
  /** 因预算截断时为 true——此时意见不完整，必须告知用户 */
  budgetTruncated: boolean;
}

export interface ReviewerDeps {
  llm: Pick<LlmClient, 'chat'>;
  provider: LlmProvider;
  config: ExpertTeamConfig;
  getChapterBody: (id: string) => string;
}

// ── 单个专家评审 ─────────────────────────────────────────────────────

async function reviewOneRole(
  role: RoleDefinition,
  targetId: string,
  body: string,
  deps: ReviewerDeps,
  signal: AbortSignal,
): Promise<{ opinions: ExpertOpinion[]; usage: ReviewerUsage }> {
  const prompt = buildRolePrompt(role, `第 ${targetId} 章`);

  const res = await deps.llm.chat({
    messages: [{ role: 'user', content: `${prompt}\n\n【待评审正文】\n${body}` }],
    temperature: 0.3, // 评审要稳定，不要创造性发挥
    stream: false,
    signal,
  });

  // ★ 越界不丢弃：模型可能无视 prompt 去管别的维度。
  //   标记后交给裁决阶段降权（设计 §3.1），保留参考价值。
  const parsed = parseJsonLenient(res.content);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const opinions: ExpertOpinion[] = [];
  const rejected: string[] = [];

  for (const item of arr) {
    const r = OpinionSchema.safeParse(item);
    if (!r.success) {
      rejected.push(
        ...r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
      continue;
    }
    const o = r.data;
    const cross = role.ignore.includes(o.dimension);
    opinions.push({
      role: role.key,
      dimension: o.dimension,
      severity: o.severity,
      verdict: o.verdict,
      evidence: o.evidence,
      suggestion: o.suggestion,
      crossBoundary: cross,
    });
  }

  if (opinions.length === 0 && rejected.length > 0) {
    throw new Error(`返回结构不合法：${rejected.slice(0, 3).join('; ')}`);
  }

  // 本次调用的真实消耗与成本（本地模型 costCny 恒为 0）
  const p = deps.provider.pricing;
  const costCny =
    p.inputPerMTok === 0 && p.outputPerMTok === 0
      ? 0
      : (res.usage.input / 1e6) * p.inputPerMTok +
        (res.usage.output / 1e6) * p.outputPerMTok;

  return {
    opinions,
    usage: {
      input: res.usage.input,
      output: res.usage.output,
      wallMs: res.usage.wallMs,
      costCny,
    },
  };
}

/** 单次评审的资源消耗 */
export interface ReviewerUsage {
  input: number;
  output: number;
  wallMs: number;
  /** 元。本地模型恒为 0 */
  costCny: number;
}

// ── 编排：多专家 × 多章节 ─────────────────────────────────────────────

export async function runExpertReview(
  _stage: ReviewStage,
  chapterIds: string[],
  roles: ExpertRoleKey[],
  deps: ReviewerDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<ExpertReviewOutcome> {
  const activated = roles
    .map((k) => EXPERT_ROLES[k])
    .filter((r): r is RoleDefinition => Boolean(r));

  const opinions: ExpertOpinion[] = [];
  const failed: { role: ExpertRoleKey; reason: string }[] = [];
  let budgetTruncated = false;

  const usage = { input: 0, output: 0, wallMs: 0, costCny: 0 };
  const free = deps.provider.pricing.inputPerMTok === 0 &&
    deps.provider.pricing.outputPerMTok === 0;
  const { maxTokens, maxCostCny, timeoutMs } = deps.config.budget;

  // 整体超时闸：专家评审不能无限跑
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = opts.signal ?? controller.signal;

  // 并发上限 3：六个专家一起打provider 容易触发限流
  const queue = [...activated];
  // ★ 预算检查需要串行化：并发 worker 各自检查会同时通过初始检查，
  //   导致实际发起次数超预算。抽成同步函数由各 worker 在发起前调用。
  const budgetExceeded = (): boolean => {
    if (usage.input + usage.output >= maxTokens) return true;
    if (!free && usage.costCny >= maxCostCny) return true;
    return false;
  };
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const role = queue.shift();
      if (!role) return;
      if (signal.aborted) return;

      // 预算检查：超了就不再发起新调用（已有意见照常返回）
      if (budgetExceeded()) {
        budgetTruncated = true;
        return;
      }

      for (const chapterId of chapterIds) {
        const body = deps.getChapterBody(chapterId);
        if (!body.trim()) continue;
        try {
          const res = await reviewOneRole(role, chapterId, body, deps, signal);
          opinions.push(...res.opinions);
          // ★ 必须累加 usage，否则预算闸永远读到 0，等于没有闸门
          usage.input += res.usage.input;
          usage.output += res.usage.output;
          usage.wallMs += res.usage.wallMs;
          usage.costCny += res.usage.costCny;
        } catch (e) {
          // ★ 记录失败但不中断整团
          failed.push({
            role: role.key,
            reason:
              e instanceof LlmError
                ? `${e.kind}: ${e.message}`
                : e instanceof Error
                  ? e.message
                  : String(e),
          });
        }
      }
    }
  });

  await Promise.all(workers);
  clearTimeout(timer);

  return { opinions, failed, usage, budgetTruncated };
}

/**
 * 降级说明：把「谁缺席、为什么」变成一句人话。
 * 合并进报告摘要，避免用户在 UI 上误以为意见就是全部。
 */
export function describeFailures(failed: { role: ExpertRoleKey; reason: string }[]): string {
  if (failed.length === 0) return '';
  const byRole = new Map<string, string[]>();
  for (const f of failed) {
    const arr = byRole.get(f.role);
    if (arr) arr.push(f.reason);
    else byRole.set(f.role, [f.reason]);
  }
  const parts = [...byRole.entries()].map(([role, reasons]) => {
    const name = EXPERT_ROLES[role as ExpertRoleKey]?.displayName ?? role;
    return `${name}（${[...new Set(reasons)].slice(0, 2).join('；')}）`;
  });
  return `⚠ 以下专家未完成评审：${parts.join('、')}。意见不完整，请勿据此下完整结论。`;
}

export { EXPERT_ROLE_KEYS };
