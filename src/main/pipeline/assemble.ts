/**
 * 写手上下文装配器：把 PipelineCtx 装配成写手 LLM 的 user 消息（P0 生成流水线·数据面）。
 *
 * ★ 设计原则（装配透明 + 定稿主权）在本文件的落地：
 *   1. **保护层**（项目参数 / canon / 本章章纲 / 章末钩子铁律提醒）永远全文进入 user，
 *      不参与任何裁剪。保护层超出配额时硬失败（E_PROTECTED_OVERBUDGET，错误消息直报
 *      canon 条数 / token 数 / 配额数）——宁可报错，绝不静默丢 canon；
 *   2. **可压缩栏位**（上章结尾 / 剧情梗概 / 脑洞分支）按栏位预算裁剪，且每次裁剪
 *      都留下一条 TrimTrace：哪一栏、裁前裁后各多少 tokens、为什么裁。作者与审计代码
 *      可以据此完整回查「模型这一章到底看到了什么、没看到什么」；
 *   3. **system 不归本文件管**：调用方（Task 4 写手工具）用 composeWriterPrompt 生成。
 *      同一本书的 system 必须逐字节恒定才能命中 provider 的 prompt cache，章节级可变
 *      上下文全部只进 user——所以本装配器返回的 system 是空串占位，绝不掺入可变内容。
 *
 * ★ 机制与措辞的边界（AGPL 红线）：栏位预算、牺牲顺序（sacrificeRank 小者先丢）、
 *   裁剪留痕这三件机制参照了行业内公开的上下文预算做法；本文件的代码、注释与全部
 *   块文案均为原创中文措辞，未复制任何受版权保护的文本。
 */
import type { PipelineCtx } from '@shared/types/pipeline';
import { MzError } from '@shared/types/ipc';

/* ── 对外类型 ──────────────────────────────────────────────────── */

/** 一次裁剪动作的留痕：装配透明原则的载体，逐条可回查。 */
export type TrimTrace = {
  /** 栏位名（prevEnding / synopsis / hooks） */
  slot: string;
  /** kept=全文保留；compressed=被截断；dropped=被整条丢弃 */
  action: 'kept' | 'compressed' | 'dropped';
  /** 裁剪前该栏位的 token 估算 */
  before: number;
  /** 裁剪后该栏位的 token 估算 */
  after: number;
  /** 为什么裁、怎么裁的——说真话，不拟人化 */
  reason: string;
};

/** 装配预算：模型上下文窗口与单次输出预留。 */
export interface WriterBudget {
  /** 模型上下文窗口（tokens） */
  window: number;
  /** 给模型回复预留的额度（tokens） */
  outputReserve: number;
}

/** 装配结果。system 为空串占位，由调用方（Task 4）用 composeWriterPrompt 填入。 */
export interface AssembledWriterContext {
  system: string;
  user: string;
  trace: TrimTrace[];
}

/* ── 常量 ──────────────────────────────────────────────────────── */

/**
 * 保护层配额上限（tokens）。
 *
 * 简化版常量：理想形态是由预算分配器按「window − outputReserve − 可压缩栏位实际占用」
 * 动态划出保护配额，P0 先取固定值把行为钉死，P1 再动态化。
 * 实际生效配额还会与 window − outputReserve 取小——保护层比整个可用预算还大时，
 * 再多的常量配额也装不下，必须拦。
 */
export const PROTECTED_QUOTA = 8000;

/**
 * 上章结尾的硬顶（字符数）。
 * 衔接本章只需要上一章入章前的最后一段；超过硬顶时保留结尾、截去更早的前文。
 */
export const PREV_ENDING_CAP_CHARS = 260;

/* ── token 估算 ────────────────────────────────────────────────── */

/**
 * 文本 → token 的粗估（CJK 经验值）：中文正文约 1 字 ≈ 0.6 token（≈1.7 字/token）。
 * 混入的英文与数字按此口径会略微高估——用在预算上是安全方向的偏差，宁多算不爆窗。
 * 全流水线只允许这一个估算口径，禁止各处自带系数。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.6);
}

/* ── 可压缩栏位的内部表示 ──────────────────────────────────────── */

interface CompSlot {
  /** 栏位名，同时是 trace 里的 slot 字段 */
  slot: 'prevEnding' | 'synopsis' | 'hooks';
  /** 栏位级牺牲顺序：小者先被牺牲（hooks 最先，prevEnding 最后） */
  sacrificeRank: number;
  /** 块标题行 */
  header: string;
  /** 栏位内容：hooks 逐条（条目级 rank 小者先丢），其余栏位单条 */
  items: { text: string; rank: number }[];
  /** 装配开始时该栏位的 token 估算（trace 的 before 基准） */
  originalTokens: number;
  /** 是否发生过任何裁剪（决定终局 trace 记 kept 还是不再重复记录） */
  touched: boolean;
}

function renderSlot(s: CompSlot): string {
  if (!s.items.length) return '';
  const body =
    s.slot === 'hooks' ? s.items.map((it, i) => `${i + 1}. ${it.text}`).join('\n') : s.items.map((it) => it.text).join('\n');
  return `${s.header}\n${body}`;
}

function slotTokens(s: CompSlot): number {
  return estimateTokens(renderSlot(s));
}

/* ── 主入口 ────────────────────────────────────────────────────── */

/**
 * 装配写手的 user 消息。
 *
 * 装填顺序（保护块固定四段，随后是可压缩栏位）：
 *   项目参数行 → canon 逐条 → 本章章纲 → 章末钩子铁律提醒
 *   → 上章结尾 → 剧情梗概 → 脑洞分支
 *
 * 预算纪律：user 全文（含标题行与分隔符）不超过 window − outputReserve；
 * 保护层超配额直接抛错；可压缩栏位超额按牺牲顺序截断并逐次留痕。
 */
export function assembleWriterContext(ctx: PipelineCtx, budget: WriterBudget): AssembledWriterContext {
  const trace: TrimTrace[] = [];

  /* ── 第一步：保护层（永不裁剪） ── */

  const paramsBlock = [
    `【项目参数】题材：${ctx.genre}｜平台：${ctx.platform}｜单章目标：${ctx.chapterWords} 字｜全书目标：${ctx.targetWords} 字`,
    `【作者前提】${ctx.premise}`,
  ].join('\n');

  const canonBlock = ctx.canon.length
    ? ['【正史清单·canon】以下每条都是既定事实，正文不得与之相抵：', ...ctx.canon.map((c, i) => `${i + 1}. ${c}`)].join('\n')
    : '【正史清单·canon】本书暂无已录入条目。';

  const planBlock = ctx.planItem
    ? `【本章章纲】标题：${ctx.planItem.title}｜章末钩子：${ctx.planItem.hook}`
    : '【本章章纲】本章无章纲条目——按流水线纪律这不该发生，如实标注而非编造。';

  const hookRuleBlock = '【章末钩子·铁律提醒】本章最后一个场景必须收在章纲给定的钩子上：只把钩子亮出来，不在本章内解释它、解决它。';

  const protectedText = [paramsBlock, canonBlock, planBlock, hookRuleBlock].join('\n\n');
  const protectedTokens = estimateTokens(protectedText);
  const canonTokens = estimateTokens(canonBlock);

  const userBudget = Math.max(0, budget.window - budget.outputReserve);
  const quota = Math.min(PROTECTED_QUOTA, userBudget);
  if (protectedTokens > quota) {
    // 失败文案说真话：直报 canon 条数、token 数与生效配额，不拟人化、不含糊。
    throw new MzError(
      'E_PROTECTED_OVERBUDGET',
      `canon ${ctx.canon.length} 条共 ${canonTokens} tokens，保护层合计 ${protectedTokens} tokens，超保护配额 ${quota}：宁可报错，绝不静默丢 canon`,
    );
  }

  /* ── 第二步：可压缩栏位建槽（含 prevEnding 硬顶） ── */

  const slots: CompSlot[] = [];

  if (ctx.prevEnding && ctx.prevEnding.trim()) {
    const before = estimateTokens(ctx.prevEnding);
    let body = ctx.prevEnding;
    let touched = false;
    if (body.length > PREV_ENDING_CAP_CHARS) {
      // 保留结尾：与本衔接的关节在上一章末尾，截去的是离关节更远的头部。
      body = body.slice(-PREV_ENDING_CAP_CHARS);
      touched = true;
      trace.push({
        slot: 'prevEnding',
        action: 'compressed',
        before,
        after: estimateTokens(body),
        reason: `超出 ${PREV_ENDING_CAP_CHARS} 字硬顶，保留结尾衔接段，截去更早的前文`,
      });
    }
    slots.push({
      slot: 'prevEnding',
      sacrificeRank: 3,
      header: '【上章结尾】',
      items: [{ text: body, rank: 0 }],
      originalTokens: before,
      touched,
    });
  }

  if (ctx.concept?.synopsis) {
    slots.push({
      slot: 'synopsis',
      sacrificeRank: 2,
      header: '【剧情梗概（构思产出，供衔接参考）】',
      items: [{ text: ctx.concept.synopsis, rank: 0 }],
      originalTokens: estimateTokens(ctx.concept.synopsis),
      touched: false,
    });
  }

  if (ctx.concept?.hooks?.length) {
    const hooks = ctx.concept.hooks;
    slots.push({
      slot: 'hooks',
      sacrificeRank: 1,
      header: '【可用脑洞分支】',
      // 条目级牺牲序：末位分支 rank=1 最先丢，首位分支 rank 最大、活到最后。
      items: hooks.map((h, i) => ({ text: h, rank: hooks.length - i })),
      originalTokens: estimateTokens(hooks.join('\n')),
      touched: false,
    });
  }

  /* ── 第三步：总预算收敛（超额按牺牲顺序裁剪，逐次留痕） ── */

  const renderUser = (): string =>
    [protectedText, ...slots.map(renderSlot).filter((t) => t.length > 0)].join('\n\n');

  let overshoot = estimateTokens(renderUser()) - userBudget;
  while (overshoot > 0) {
    const victim = slots
      .filter((s) => s.items.length > 0)
      .slice()
      .sort((a, b) => a.sacrificeRank - b.sacrificeRank)[0];
    // 所有可压缩栏位都已清空仍超额是不可能的：配额检查保证 protectedTokens ≤ userBudget，
    // 栏位清空后 user 就只剩保护层。此 break 只是类型上的穷尽兜底。
    if (!victim) break;

    const beforeTokens = slotTokens(victim);

    if (victim.slot === 'hooks') {
      // 整条牺牲：先丢条目级 rank 最小者（即末位分支）。
      let idx = 0;
      for (let i = 1; i < victim.items.length; i++) {
        if (victim.items[i].rank < victim.items[idx].rank) idx = i;
      }
      victim.items.splice(idx, 1);
      victim.touched = true;
      trace.push({
        slot: 'hooks',
        action: 'dropped',
        before: beforeTokens,
        after: slotTokens(victim),
        reason: '总预算超额，按牺牲顺序丢弃末位脑洞分支',
      });
    } else {
      // 文本截断：按估算口径反算需要砍掉的字符数（+8 字符余量兜住取整误差）。
      const it = victim.items[0];
      const cutChars = Math.min(it.text.length, Math.ceil(overshoot / 0.6) + 8);
      const keepChars = it.text.length - cutChars;
      if (keepChars <= 0) {
        victim.items = [];
        victim.touched = true;
        trace.push({
          slot: victim.slot,
          action: 'dropped',
          before: beforeTokens,
          after: 0,
          reason: '总预算超额，截断后已无有效剩余，整栏丢弃',
        });
      } else {
        // prevEnding 截头保尾（衔接关节在尾部）；synopsis 截尾保头（梗概开头信息密度最高）。
        it.text = victim.slot === 'prevEnding' ? it.text.slice(-keepChars) : it.text.slice(0, keepChars);
        victim.touched = true;
        trace.push({
          slot: victim.slot,
          action: 'compressed',
          before: beforeTokens,
          after: slotTokens(victim),
          reason: '总预算超额，按牺牲顺序截尾',
        });
      }
    }

    overshoot = estimateTokens(renderUser()) - userBudget;
  }

  /* ── 第四步：终局 trace——没被裁过的栏位也记一笔 kept，回查时不留盲区 ── */

  for (const s of slots) {
    if (!s.touched) {
      trace.push({ slot: s.slot, action: 'kept', before: s.originalTokens, after: s.originalTokens, reason: '在预算内，全文保留' });
    }
  }

  return {
    // system 由调用方（Task 4）用 composeWriterPrompt(ctx) 生成并填入——
    // 装配器不产 system，从结构上杜绝「章节级可变内容混进 system 打碎 prompt cache」。
    system: '',
    user: renderUser(),
    trace,
  };
}
