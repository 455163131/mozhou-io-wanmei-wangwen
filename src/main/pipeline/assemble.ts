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
import type { PipelineCtx, TrimTrace } from '@shared/types/pipeline';
import { MzError } from '@shared/types/ipc';
import { matchSkills } from '@main/pipeline/craft-skills';
import { WEIGHT_VALUE } from '@shared/ledger-metrics';

/* ── 对外类型 ──────────────────────────────────────────────────── */

// ★ D批 D1：TrimTrace 单源上移到 @shared/types/pipeline（IPC 契约 write-draft res
//   与装配器产出共用同一份定义）。这里 re-export 保持既有 importer（tools.ts）兼容。
export type { TrimTrace };

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

/**
 * 写作工艺槽（craftSkills）的硬顶（tokens）。
 * 命中条目的正文合计超过硬顶时按条目边界整条丢弃末位命中（R25），并留一条 trace。
 */
export const CRAFT_SKILLS_CAP_TOKENS = 1200;

/**
 * 伏笔台账槽（foreshadow）的硬顶（tokens）。P2-B T7，craftSkills 同档：
 * 台账是欠读者的债，但正文衔接优先——硬顶只收条目边界（R25 同纪律），
 * 且 ctx 侧行已按权重 A→C 排好，「保头丢尾」天然先落 C 档。
 */
export const FORESHADOW_CAP_TOKENS = 1200;

/** 人物近况槽（cast）的硬顶（tokens）。P2-B T7，同档同纪律（按行边界丢末位人物）。 */
export const CAST_CAP_TOKENS = 1200;

/**
 * R25：硬顶的条目边界收敛——保留靠前的条目，末位装不下的**整条丢弃**。
 * 此前的裸字符切分会把一条指令拦腰截半，半条指令比没有更糟（模型会执行
 * 残缺的规则）；宁可少一条完整的，不要多半条碎的。craftSkills（'\n\n' 段）、
 * foreshadow / cast（'\n' 行）三槽共用。
 * @param parts 逐条渲染好的文本（craftSkills 段 / 伏笔行 / 人物行）
 * @param capChars 硬顶（字符数）
 * @param sep 条目连接符（口径必须与对应栏位的渲染一致，否则长度算错）
 */
export function fitCraftSkillEntries(parts: string[], capChars: number, sep: string = '\n\n'): { text: string; droppedCount: number } {
  const kept: string[] = [];
  let len = 0;
  for (const p of parts) {
    const next = kept.length === 0 ? p.length : len + sep.length + p.length;
    if (next > capChars) break;
    kept.push(p);
    len = next;
  }
  return { text: kept.join(sep), droppedCount: parts.length - kept.length };
}

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
  slot: 'prevEnding' | 'synopsis' | 'hooks' | 'craftSkills' | 'foreshadow' | 'cast';
  /** 栏位级牺牲顺序：小者先被牺牲（hooks 最先，foreshadow 最后） */
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

/**
 * foreshadow 槽的条目级牺牲 rank：从行内「·权重X）：」标签还原。
 * 行模板的正主在 ctx.ts（同一份契约的两半，p2b-acceptance 逐字钉住）；
 * 正则锚到模板后缀（·前缀 + ）：后缀）——伏笔**名**里含「权重A）」
 * 不能 spoof rank。认不出的标签兜底中性 B——与 ledger-metrics 对脏 weight 的兜底同形。
 */
function foreshadowRank(text: string): number {
  const w = /·权重([ABC])）：/u.exec(text)?.[1];
  return WEIGHT_VALUE[(w ?? 'B') as 'A' | 'B' | 'C'];
}

/* ── 主入口 ────────────────────────────────────────────────────── */

/**
 * 装配写手的 user 消息。
 *
 * 装填顺序（保护块固定四段，随后是可压缩栏位）：
 *   项目参数行 → canon 逐条 → 本章章纲 → 章末钩子铁律提醒
 *   → 上章结尾 → 剧情梗概 → 脑洞分支 → 写作工艺（craftSkills）
 *   → 人物近况（cast）→ 伏笔台账（foreshadow）（P2-B T7，台账两源只进 user）
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
      sacrificeRank: 4,
      header: '【上章结尾】',
      items: [{ text: body, rank: 0 }],
      originalTokens: before,
      touched,
    });
  }

  if (ctx.concept?.synopsis) {
    slots.push({
      slot: 'synopsis',
      sacrificeRank: 3,
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

  // craftSkills：按「本章章纲标题 + 章末钩子 + 题材」做触发词匹配，仅注入写手
  // （roles 含 'writer' 的命中条目）。硬顶 CRAFT_SKILLS_CAP_TOKENS，超出按条目
  // 边界整条丢弃末位命中（R25）并留痕。
  {
    const craftMatchText = `${ctx.planItem?.title ?? ''}${ctx.planItem?.hook ?? ''}${ctx.genre}`;
    const matched = matchSkills(craftMatchText, 'writer');
    if (matched.length) {
      const parts = matched.map((s) => `◆ ${s.title}\n${s.body}`);
      let text = parts.join('\n\n');
      const before = estimateTokens(text);
      let touched = false;
      const capChars = Math.floor(CRAFT_SKILLS_CAP_TOKENS / 0.6);
      if (text.length > capChars) {
        // R25：条目边界收敛——注册序靠前的命中条目优先保留，末位装不下的整条丢弃，
        // 绝不拦腰截断半条指令。
        const fitted = fitCraftSkillEntries(parts, capChars);
        text = fitted.text;
        touched = true;
        if (text) {
          trace.push({
            slot: 'craftSkills',
            action: 'compressed',
            before,
            after: estimateTokens(text),
            reason: `超出 ${CRAFT_SKILLS_CAP_TOKENS} tokens 硬顶，按条目边界整条丢弃末位 ${fitted.droppedCount} 条命中（不拦腰截断指令）`,
          });
        } else {
          trace.push({
            slot: 'craftSkills',
            action: 'dropped',
            before,
            after: 0,
            reason: `首条命中即超 ${CRAFT_SKILLS_CAP_TOKENS} tokens 硬顶，按条目边界无可保留，整槽丢弃`,
          });
        }
      }
      if (text) {
        slots.push({
          slot: 'craftSkills',
          sacrificeRank: 2,
          header: '【写作工艺·本章命中的可执行指令】',
          items: [{ text, rank: 0 }],
          originalTokens: before,
          touched,
        });
      }
    }
  }

  // foreshadow：伏笔台账的未偿条目（P2-B T7）。ctx 侧已滤掉 resolved、跳过坏 ref、
  // 按权重 A→C 排序；条目级 rank 从行内「权重X」标签还原，rank 小者先丢——
  // 与 hooks 同口径（C 档先落，A 档活到最后）。硬顶 FORESHADOW_CAP_TOKENS
  // 按条目边界丢末位（R25 同纪律，不截半条债）。空账 → 一行诚实占位（canon 空态同型）。
  if (ctx.foreshadowLines.length === 0) {
    const ph = '本书暂无未偿伏笔。';
    slots.push({
      slot: 'foreshadow',
      sacrificeRank: 6,
      header: '【伏笔台账】',
      items: [{ text: ph, rank: 0 }],
      originalTokens: estimateTokens(ph),
      touched: false,
    });
  } else {
    const lines = ctx.foreshadowLines;
    const before = estimateTokens(lines.join('\n'));
    const fitted = fitCraftSkillEntries(lines, Math.floor(FORESHADOW_CAP_TOKENS / 0.6), '\n');
    if (fitted.droppedCount > 0) {
      trace.push(
        fitted.text
          ? {
              slot: 'foreshadow',
              action: 'compressed',
              before,
              after: estimateTokens(fitted.text),
              reason: `超出 ${FORESHADOW_CAP_TOKENS} tokens 硬顶，按条目边界整条丢弃末位 ${fitted.droppedCount} 条伏笔（A→C 排序下即 C 档先落，不拦腰截半条债）`,
            }
          : {
              slot: 'foreshadow',
              action: 'dropped',
              before,
              after: 0,
              reason: `首条伏笔即超 ${FORESHADOW_CAP_TOKENS} tokens 硬顶，按条目边界无可保留，整槽丢弃`,
            },
      );
    }
    if (fitted.text) {
      slots.push({
        slot: 'foreshadow',
        sacrificeRank: 6,
        header: '【伏笔台账】',
        items: lines.slice(0, lines.length - fitted.droppedCount).map((text) => ({ text, rank: foreshadowRank(text) })),
        originalTokens: before,
        touched: fitted.droppedCount > 0,
      });
    }
  }

  // cast：人物近况（P2-B T7）。单条多行块（每人一行：最新快照｜知｜不知），
  // 槽级牺牲 rank 5（排在 prevEnding 之后、foreshadow 之前——人物边界先让位给
  // 未偿债务，但都比脑洞/工艺/梗概活得久）。硬顶按行边界丢末位人物。空账占位行。
  if (ctx.castLines.length === 0) {
    const ph = '本书暂无人物近况记录。';
    slots.push({
      slot: 'cast',
      sacrificeRank: 5,
      header: '【人物近况】',
      items: [{ text: ph, rank: 1 }],
      originalTokens: estimateTokens(ph),
      touched: false,
    });
  } else {
    const lines = ctx.castLines;
    const before = estimateTokens(lines.join('\n'));
    const fitted = fitCraftSkillEntries(lines, Math.floor(CAST_CAP_TOKENS / 0.6), '\n');
    if (fitted.droppedCount > 0) {
      trace.push(
        fitted.text
          ? {
              slot: 'cast',
              action: 'compressed',
              before,
              after: estimateTokens(fitted.text),
              reason: `超出 ${CAST_CAP_TOKENS} tokens 硬顶，按行边界整行丢弃末位 ${fitted.droppedCount} 个人物近况`,
            }
          : {
              slot: 'cast',
              action: 'dropped',
              before,
              after: 0,
              reason: `首行即超 ${CAST_CAP_TOKENS} tokens 硬顶，按行边界无可保留，整槽丢弃`,
            },
      );
    }
    if (fitted.text) {
      slots.push({
        slot: 'cast',
        sacrificeRank: 5,
        header: '【人物近况】',
        items: [{ text: fitted.text, rank: 1 }],
        originalTokens: before,
        touched: fitted.droppedCount > 0,
      });
    }
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

    if (victim.slot === 'hooks' || victim.slot === 'foreshadow') {
      // 整条牺牲：先丢条目级 rank 最小者（hooks=末位脑洞分支；foreshadow=权重最低
      // 的伏笔条目——R25 同款纪律，半条债比没有这条债更糟，绝不拦腰截行）。
      let idx = 0;
      for (let i = 1; i < victim.items.length; i++) {
        if (victim.items[i].rank < victim.items[idx].rank) idx = i;
      }
      victim.items.splice(idx, 1);
      victim.touched = true;
      trace.push({
        slot: victim.slot,
        action: 'dropped',
        before: beforeTokens,
        after: slotTokens(victim),
        reason:
          victim.slot === 'hooks'
            ? '总预算超额，按牺牲顺序丢弃末位脑洞分支'
            : '总预算超额，按牺牲顺序整条丢弃权重最低的伏笔条目',
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
