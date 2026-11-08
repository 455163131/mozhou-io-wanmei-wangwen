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
 * ★ 反重复：repo.ideaHistory() 的已抽方向喂回 drawDirection，连抽自然避开旧方向。
 */
import type { InspirationRepo } from '../db/repos/inspiration-repo';
import type { PipelineLlm } from '../pipeline/tools';
import type { PromptOverlay, PromptOverlayRole } from '../pipeline/overlay';
import { composeIdeaPrompt } from '../pipeline/prompts';
import { extractJson } from '../agent/host';
import { drawDirection } from '@shared/inspiration/seed-pool';
import { IdeaSchema, type IdeaPayload, type InspirationCard } from '@shared/types/inspiration';

/** 抽脑洞依赖契约（生产由 services.ideaDeps() 装配；测试可注入假 llm/repo/rand）。 */
export interface IdeaDeps {
  llm: PipelineLlm;
  repo: InspirationRepo;
  /** idea 角色覆盖层（缺省 null = 内置温度 + system 零追加）；容忍同步实现。 */
  getOverlay?: (role: PromptOverlayRole) => PromptOverlay | null | Promise<PromptOverlay | null>;
  /** 方向随机源（缺省 Math.random；测试注入定值验反重复）。 */
  rand?: () => number;
}

export interface IdeaDrawResult {
  card: InspirationCard;
  source: 'live' | 'demo';
}

/** 脑洞内置温度（同构思发散档；可被 idea 覆盖层「温度：」行覆盖）。 */
const IDEA_TEMPERATURE = 1.05;

/**
 * 抽一张脑洞卡。LLM 成功且过契约 → source='live'；否则演示兜底 source='demo'。
 * 两条路径都落库（演示卡也进 ideaHistory，反重复对演示方向同样生效）。
 */
export async function drawIdea(deps: IdeaDeps): Promise<IdeaDrawResult> {
  const { llm, repo } = deps;
  const rand = deps.rand ?? Math.random;
  const dir = drawDirection(repo.ideaHistory().map((h) => h.direction), rand);
  const overlay = (await deps.getOverlay?.('idea')) ?? null;
  const system = composeIdeaPrompt(dir, overlay);
  const temperature = overlay?.temperature ?? IDEA_TEMPERATURE;

  try {
    const res = await llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `方向：${dir}。产出一个脑洞，只输出 JSON。` },
      ],
      temperature,
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
    return { card, source: 'live' };
  } catch {
    // 诚实兜底：无 Key / 请求失败 / 产出坏 → 演示占位，明示 live:false，绝不虚报为模型产出。
    const payload: IdeaPayload = {
      direction: dir,
      premise: `【演示】围绕「${dir}」的一句话故事（未配置模型，演示占位）`,
      temperature: IDEA_TEMPERATURE,
      live: false,
    };
    const card = repo.insert({ kind: 'idea', title: payload.premise, payload, sourceLabel: dir });
    return { card, source: 'demo' };
  }
}