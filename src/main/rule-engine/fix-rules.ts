/**
 * FIX_RULES 规则表（架构 T07）。
 *
 * ⚠️⚠️ **两个必须知道的坑（团队负责人已实测纠正）**：
 *
 * 1. **规则不是 8 条是 13 条。** `auto:true` 的规则里，
 *    **F1–F5 五条是由 `fixFromSuggestionRule()` 工厂函数生成的**，
 *    源码里**不以 `{id:'F1'}` 字面量出现**——它是
 *    `fixFromSuggestionRule('F1','R1','观感替代','表达层',[...])` 的**调用参数**。
 *    所以 `grep "id: 'F"` 只能数出 8 条（F6–F13），会漏掉 F1–F5。
 *    而 F1（观感替代）与 F4（动作三板斧）恰好是 PRD 样例里
 *    Agent 自主选择的那两条规则，漏了会导致工具派生测试失败。
 *
 * 2. **N 类是 N1–N4 四条齐全**，不是只有 N1/N2。
 *    （产品经理曾误判 N3/N4 不存在，实测是漏了。）
 *
 * 规则结构：
 *   - auto=false 时必须填 why，说明为什么不能自动改（诚实登记，不做假按钮）。
 *     这 4 条 why 会进系统提示作为**负面知识**——否则模型会尝试你明确关闭过的能力。
 *   - fix(text, ctx) 返回 { text, changes:[Edit] }
 *   - applies(text, ctx) 可选：按「原章偏离」判定该规则是否需要出手
 */
import type { Edit } from '@shared/types/tool';
import {
  fixMergeShortSentences,
  fixSplitLongSentences,
  fixRhythmSpread,
  fixMergeParas,
  fixSplitLongParas,
  fixDoubleWords,
  fixFamilies,
} from './fix-families';
import { genSuggestions, positionInQuote } from './suggestions';
import { inQuote } from '@shared/util/text-zh';

/** 规则执行上下文：只依赖「原章偏离」，与 UI 状态无关 */
export interface FixContext {
  /** 原章各指标的值 */
  a: Record<string, number>;
  /** 原章各指标的偏离度（0 = 达标）。★ 只有幅度、没有方向 */
  devs: Record<string, number>;
  /**
   * 偏离**方向**：该指标低于基线区间下界时的偏离幅度，否则为 0。
   * 判据写成 `!!ctx.low.avgSent` 即「句长偏短」。
   * marker 型指标语义是「越低越好」，故其 low 恒为 0。
   */
  low: Record<string, number>;
  /**
   * 偏离**方向**：该指标高于基线区间上界时的偏离幅度，否则为 0。
   * 判据写成 `!!ctx.high.avgPara` 即「段落偏长」。
   */
  high: Record<string, number>;
  /** 每千字标记密度 */
  per1000: Record<string, number>;
}

export interface FixRule {
  id: string;
  label: string;
  layer: string;
  /** 负责的指标 key 或 'marker:名称' */
  targets: string[];
  /**
   * 副作用检测要额外盯的指标：本规则虽不以它们为目标，但改动可能波及。
   * 缺省 = `targets`。
   *
   * ★ 为什么要有这个字段：此前这份「波及面」在 `tools/impl/fix.ts` 与
   *   `agent/side-effect.ts` 各手抄了一份映射表，两份**已经分叉**——
   *   F6 一份写 `dialogRatio`、一份写 `openType`（真相是 openType），
   *   而未知规则一律 `?? []`，等于副作用闸门 fail-open。
   *   现在两边都改为调 `sideEffectTargetsOf()`，只此一份。
   */
  sideEffectTargets?: string[];
  auto: boolean;
  /** auto:false 时必填 */
  why?: string;
  applies?: (text: string, ctx: FixContext) => boolean;
  /** auto:false 的规则没有 fix（它们是负面知识，不是工具） */
  fix?: (text: string, ctx: FixContext) => { text: string; changes: Edit[] };
}

/** 没有规则负责时的兜底说明（诚实登记，不假装有办法） */
export const FIX_NONE_WHY =
  '该指标暂无「可保证不损伤事实」的规则化改法，需作者手动处理。';

/**
 * ★ 工厂函数：把既有 R1–R6 建议包装进同一注册表（复用逻辑，不重写）。
 * F1–F5 由它生成，故源码里无 `{id:'F1'}` 字面量。
 */
export function fixFromSuggestionRule(
  id: string,
  code: string,
  label: string,
  layer: string,
  targets: string[],
): FixRule {
  return {
    id,
    label,
    layer,
    targets,
    auto: true,
    fix(text: string): { text: string; changes: Edit[] } {
      // 倒序应用：前面的改动会让后面的偏移失效，倒序可避开
      const list = genSuggestions(text)
        .filter((s) => s.rule === code && s.before !== s.after)
        .sort((a, b) => b.start - a.start);

      let out = text;
      const changes: Edit[] = [];
      for (const s of list) {
        // 引号内为人物语言，一律不动
        if (positionInQuote(text, s.start)) continue;
        // 偏移已被前面的改动挪动 → 跳过（不猜测，只在能确认对齐时才改）
        if (out.slice(s.start, s.start + s.before.length) !== s.before) continue;
        out = out.slice(0, s.start) + s.after + out.slice(s.start + s.before.length);
        changes.push({
          before: s.before,
          after: s.after,
          at: s.start,
          note: `${label}：${s.note}`,
          ruleId: id,
        });
      }
      return { text: out, changes: changes.reverse() };
    },
  };
}

export const FIX_RULES: FixRule[] = [
  // ── F1–F5：工厂生成（源码里不以字面量出现）──
  fixFromSuggestionRule('F1', 'R1', '观感替代', '表达层', ['marker:看了X遍/X久/X会儿']),
  fixFromSuggestionRule('F2', 'R2', '停顿替代', '表达层', ['marker:顿/停了一下']),
  fixFromSuggestionRule('F3', 'R3', '置物句去重', '表达层', ['marker:把X放在/搁在/摊在/摆在']),
  fixFromSuggestionRule('F4', 'R4', '动作三板斧', '表达层', ['marker:抬起头/低头']),
  fixFromSuggestionRule('F5', 'R5', '留白替代', '表达层', ['marker:没说话/没答/没出声']),

  // ── F6–F13：字面量 ──
  {
    id: 'F6',
    label: '章首公式',
    layer: '结构层',
    targets: ['openType'],
    auto: true,
    applies: (t) => {
      const f = (t.split('\n')[0] || '').trim();
      return /^[一二三四五六七八九十百千零两0-9]+(月|号|日|年|点)/.test(f) && f.length < 24;
    },
    fix(text) {
      const list = genSuggestions(text)
        .filter((s) => s.rule === 'R6' && s.before !== s.after)
        .sort((a, b) => b.start - a.start);
      let out = text;
      const changes: Edit[] = [];
      for (const s of list) {
        if (out.slice(s.start, s.start + s.before.length) !== s.before) continue;
        out = out.slice(0, s.start) + s.after + out.slice(s.start + s.before.length);
        changes.push({
          before: s.before,
          after: s.after,
          at: s.start,
          note: `章首公式：${s.note}`,
          ruleId: 'F6',
        });
      }
      return { text: out, changes: changes.reverse() };
    },
  },
  {
    id: 'F7',
    label: '句长调整',
    layer: '结构层',
    targets: ['avgSent'],
    // 切句/合并会同时改变句长离散度，故副作用检测也要盯 sentCv
    sideEffectTargets: ['avgSent', 'sentCv'],
    auto: true,
    applies: (_t, ctx) => !!ctx.devs.avgSent,
    // 双向：句长偏长就切句，偏短就合并
    fix: (t, ctx) => (ctx.low.avgSent ? fixMergeShortSentences(t) : fixSplitLongSentences(t)),
  },
  {
    id: 'F8',
    label: '长短交错',
    layer: '结构层',
    targets: ['sentCv'],
    auto: true,
    applies: (_t, ctx) => !!ctx.devs.sentCv && !!ctx.low.sentCv,
    fix: (t) => fixRhythmSpread(t),
  },
  {
    id: 'F9',
    label: '段落合并',
    layer: '结构层',
    targets: ['sentsPerPara'],
    auto: true,
    applies: (_t, ctx) => !!ctx.devs.sentsPerPara && !!ctx.low.sentsPerPara,
    fix: (t) => fixMergeParas(t),
  },
  {
    id: 'F10',
    label: '长段切分',
    layer: '结构层',
    targets: ['avgPara'],
    auto: true,
    applies: (_t, ctx) => !!ctx.devs.avgPara && !!ctx.high.avgPara,
    fix: (t) => fixSplitLongParas(t),
  },
  {
    id: 'F11',
    label: '叠词降重',
    layer: '表达层',
    targets: ['marker:一X一X 叠词'],
    auto: true,
    applies: (_t, ctx) => !!ctx.devs['marker:一X一X 叠词'],
    fix: (t) => fixDoubleWords(t),
  },
  {
    id: 'F12',
    label: '用字重复降重',
    layer: '素材层',
    targets: ['ttr', 'bigramTtr'],
    auto: true,
    applies: (_t, ctx) => !!(ctx.devs.ttr || ctx.devs.bigramTtr),
    fix: (t) => fixFamilies(t, ['same']),
  },
  {
    id: 'F13',
    label: '3-gram 重复降重',
    layer: '素材层',
    targets: ['triRepeat'],
    // 轮换「放在/搁在」这类置物动词会牵动对应 marker 密度
    sideEffectTargets: ['triRepeat', 'marker:把X放在/搁在/摊在/摆在'],
    auto: true,
    applies: (_t, ctx) => !!ctx.devs.triRepeat,
    fix: (t) => fixFamilies(t, ['place', 'inch']),
  },

  // ── N1–N4：不可自动修正，显式登记 + 说明为什么（诚实性关键）──
  // 这 4 条的 why 会进系统提示作为负面知识。
  {
    id: 'N1',
    label: '对白段占比异常',
    layer: '叙事层',
    targets: ['dialogRatio'],
    auto: false,
    why: '对白段占比只能靠增删对话内容来调，属创作决策；自动改写会破坏人物语言与潜台词，必须作者处理。',
  },
  {
    id: 'N2',
    label: '一致性冲突（年龄 / 时间线 / 伏笔）',
    layer: '一致性层',
    targets: ['conflict'],
    auto: false,
    why: '系统无法判断哪个值才是对的（是人物卡登记错了，还是正文写错了），必须作者裁决。',
  },
  {
    id: 'N3',
    label: '叙事层（说教化倾向 / 支线丰富度）',
    layer: '叙事层',
    targets: ['narrative'],
    auto: false,
    why: '需要作者的结构性判断，不是局部改写能解决的。',
  },
  {
    id: 'N4',
    label: '专有名词 / 数字重复',
    layer: '素材层',
    targets: ['name', 'number'],
    auto: false,
    why: '人名、地名、金额、日期、吨位、张数等是事实锚点，系统一律不改动；重复度过高需作者自己调整叙述方式。',
  },
];

// ───────────────────────── 查询helper ─────────────────────────

/** 某指标由哪些规则负责 */
export function fixRulesFor(key: string): FixRule[] {
  return FIX_RULES.filter((r) => r.targets.indexOf(key) >= 0);
}

export function ruleById(id: string): FixRule | undefined {
  return FIX_RULES.find((r) => r.id === id);
}

/**
 * 副作用检测该盯哪些指标 —— **单一真源**。
 *
 * `tools/impl/fix.ts` 的 `ruleTargets()` 与 `agent/side-effect.ts` 的
 * `targetsOfRule()` 都必须走这里，不得再各存一份手抄表。
 *
 * @returns 未知 ruleId 返回空数组。调用方须注意：空数组意味着「无可检测项」，
 *   副作用闸门会因此放行——这是 fail-open。所以新增规则时务必登记 targets。
 */
export function sideEffectTargetsOf(ruleId: string): string[] {
  const rule = ruleById(ruleId);
  if (!rule) return [];
  return rule.sideEffectTargets ?? rule.targets;
}

/** auto:true 的规则（= 可派生成工具的规则），共 13 条 */
export function autoRules(): FixRule[] {
  return FIX_RULES.filter((r) => r.auto);
}

/** auto:false 的规则（= 负面知识），共 4 条 */
export function negativeRules(): FixRule[] {
  return FIX_RULES.filter((r) => !r.auto);
}

/** 负面知识文本：进系统提示，防止模型尝试已关闭的能力 */
export function negativeKnowledge(): string {
  return negativeRules()
    .map((r) => `- 【${r.label}】${r.why}`)
    .join('\n');
}

/** 某规则当前为何不适用（给 Agent 看的可读理由） */
export function notApplicableWhy(_rule: FixRule): string {
  return (
    `规则已登记，但当前正文未命中可安全改写的片段` +
    `（重复度未达阈值，或片段含人名/地名/数字被保护）。`
  );
}

export { inQuote };

// 重新导出，便于 derive-from-rules 单点import
export { FIX_FAMILIES } from './fix-families';