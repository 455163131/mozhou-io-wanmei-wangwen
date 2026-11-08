/**
 * 抽脑洞服务（P2-C T4）。
 *
 * 一抽 = 选方向（反重复）→ 组 system（composeIdeaPrompt + idea 覆盖层）→ LLM 产出
 * → zod 契约校验 → 落 kind='idea' 卡。任何一环失败（无 Key / 请求错 / 产出坏）
 * 都**如实回落演示占位**：从种子池取方向 + 模板化 premise，live:false、source:'demo'，
 * 绝不把演示冒充模型产出（DRD §7 诚实纪律，同 chart-source 的扫榜兜底）。
 *
 * ★ 全局子系统：卡片在立项之前就存在，不键 project；repo 由调用方注入（生产走
 *   services.inspirationRepo，测试走 :memory: 库）。llm 只消费 PipelineLlm.chat 子集。
 * ★ 反重复（终审修复波 B）：避开集 = listByKind('idea') 的 sourceLabel（**实际抽中方向**
 *   的权威落点）**∪** ideaHistory 的 payload.direction（LLM 回显，合法回显同样喂回），
 *   两路并集喂回 drawDirection——连抽自然避开旧方向，回显漂移也不失守。
 */
import type { InspirationRepo } from '../db/repos/inspiration-repo';
import { TEMPERATURE, type PipelineLlm } from '../pipeline/tools';
import { SHORT_OUTPUT_BUDGET } from '../llm/client';
import { createLlmProgressEmitter, progressCause } from './llm-progress';
import type { PromptOverlay, PromptOverlayRole } from '../pipeline/overlay';
import { composeIdeaPrompt } from '../pipeline/prompts';
import { extractJson } from '../agent/host';
import { drawDirection } from '@shared/inspiration/seed-pool';
import { IdeaSchema, type IdeaPayload, type InspirationCard } from '@shared/types/inspiration';
import type { LlmProgress } from '@shared/types/provider';

/** 抽脑洞依赖契约（生产由 services.ideaDeps() 装配；测试可注入假 llm/repo/rand）。 */
export interface IdeaDeps {
  llm: PipelineLlm;
  repo: InspirationRepo;
  /** idea 角色覆盖层（缺省 null = 内置温度 + system 零追加）；容忍同步实现。 */
  getOverlay?: (role: PromptOverlayRole) => PromptOverlay | null | Promise<PromptOverlay | null>;
  /** 方向随机源（缺省 Math.random；测试注入定值验反重复）。 */
  rand?: () => number;
  /**
   * 等待进度播报（E批「模型思考过程可见」；生产接 push.send('llm:progress')）。
   * 缺省不播——老调用方零影响。事件全部来自真实观测，见 LlmProgress 诚实纪律注。
   */
  onProgress?: (p: LlmProgress) => void;
}

export interface IdeaDrawResult {
  card: InspirationCard;
  source: 'live' | 'demo';
}

/**
 * 抽一张脑洞卡。LLM 成功且过契约 → source='live'；否则演示兜底 source='demo'。
 * 两条路径都落库（演示卡也进 ideaHistory，反重复对演示方向同样生效）。
 */
export async function drawIdea(deps: IdeaDeps): Promise<IdeaDrawResult> {
  const { llm, repo } = deps;
  const rand = deps.rand ?? Math.random;
  // 避开集两路并集（终审修复波 B）：sourceLabel 是实际抽中方向的权威落点，
  // payload.direction 是 LLM 回显——合法回显（如演示池内方向）也值得避开，
  // 但漂移回显（模型自造词）绝不能顶掉权威值挡路。
  const avoided = [
    ...repo.ideaHistory().map((h) => h.direction),
    ...repo.listByKind('idea').map((c) => c.sourceLabel),
  ];
  const dir = drawDirection(avoided, rand);
  const overlay = (await deps.getOverlay?.('idea')) ?? null;
  const system = composeIdeaPrompt(dir, overlay);
  const temperature = overlay?.temperature ?? TEMPERATURE.idea;

  // E批「模型思考过程可见」：等待过程如实播报（start → thinking/writing → done/fallback），
  // 全部字段来自真实观测——elapsedMs 实测、charsSeen 实数、thought 是 provider 真回了
  // reasoning_content 才有的尾部片段（没回就缺席，绝不编造）。
  const progress = createLlmProgressEmitter('idea', deps.onProgress);
  progress.start();
  try {
    const res = await llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `方向：${dir}。产出一个脑洞，只输出 JSON。` },
      ],
      temperature,
      // ★ 紧预算（老板报障「抽半天没反应」的修复点）：一句话脑洞不值得等 120s×4 次。
      //   到点即抛 → 下面的演示兜底立刻接手，用户最多等半分钟就看到结果与真因。
      timeoutMs: SHORT_OUTPUT_BUDGET.timeoutMs,
      maxRetries: SHORT_OUTPUT_BUDGET.maxRetries,
      // ★ E批：走流式——parseStream 照旧累积完整 content（JSON 完整性不变），
      //   同时把增量经 onDelta 报出来，等待期不再是黑箱。
      stream: true,
      onDelta: (d) => progress.onDelta(d),
    });
    const parsed = IdeaSchema.safeParse(extractJson(res.content));
    if (!parsed.success) throw new Error('脑洞产出未过 IdeaSchema 契约');
    const out = parsed.data;
    const payload: IdeaPayload = {
      direction: out.direction,
      premise: out.premise,
      hook: out.hook,
      genre: out.genre,
      temperature,
      live: true,
    };
    const card = repo.insert({ kind: 'idea', title: out.premise, payload, sourceLabel: dir });
    progress.done();
    return { card, source: 'live' };
  } catch (e) {
    // 诚实兜底：无 Key / 请求失败 / 产出坏 → 演示占位，明示 live:false，绝不虚报为模型产出。
    // ★ E批：fallback 事件带真因（异常原文），界面上的「已回落演示数据」不再是黑箱。
    progress.fallback(progressCause(e));
    const payload: IdeaPayload = {
      direction: dir,
      premise: `【演示】围绕「${dir}」的一句话故事（未配置模型，演示占位）`,
      temperature: TEMPERATURE.idea,
      live: false,
    };
    const card = repo.insert({ kind: 'idea', title: payload.premise, payload, sourceLabel: dir });
    return { card, source: 'demo' };
  }
}