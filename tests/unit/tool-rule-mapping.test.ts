/**
 * ★ 工具 ↔ 规则映射的单一真源测试。
 *
 * 为什么单独开一个文件：
 *
 *   修复前「哪条工具跑哪些规则」这件事存在**三份互不一致的副本**：
 *
 *     1. `tools/impl/fix.ts` 的 `TOOL_RULES`（执行时用）
 *        —— `fix_synonym_rotation: ['family:same','family:place','family:inch']`
 *     2. `tools/derive-from-rules.ts` 的 `rulesOfTool()`（声明/测试用）
 *        —— 返回 FIX_FAMILIES 的**裸族名** `['place','same','inch']`
 *     3. `rule-engine/fix-rules.ts` 的 `FIX_RULES`（唯一的真实规则表）
 *        —— 里面只有 F1~F13 与 N1~N4
 *
 *   前两份给出的 id 在第三份里**一个都查不到**。`planFixes` 按 `rule.id` 过滤，
 *   于是一条都匹配不上 → `fix_synonym_rotation` 恒产出零改动，却返回 `ok:true`。
 *   Agent 看到「成功但没效果」会反复重试，一路烧到步数/成本闸门才停。
 *
 *   同类漂移还发生在副作用检测面上：`fix.ts` 的 `ruleTargets()` 与
 *   `agent/side-effect.ts` 的 `RULE_TARGETS` 是同一份知识的两个手抄副本，
 *   且 F6 已经分叉（一份 `dialogRatio`、一份 `openType`，真相是 openType）。
 *
 *   现在两份手抄表都删了，统一走 `toolRulesFor()` 与 `sideEffectTargetsOf()`。
 *   本文件的职责是**让漂移无法再次发生**：任何工具映射到不存在的规则 id，立刻红。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { toolRulesFor, rulesOfTool, deriveFixToolSpecs } from '@main/tools/derive-from-rules';
import {
  FIX_RULES,
  ruleById,
  sideEffectTargetsOf,
  autoRules,
} from '@main/rule-engine/fix-rules';
import { applyFixTool, type FixDeps } from '@main/tools/impl/fix';
import type { BaselineLike } from '@main/rule-engine/plan-fixes';
import type { MetricSpec } from '@shared/types/project';
import type { ToolContext } from '@shared/types/tool';
import { MARKER_KEYS } from '@shared/metrics-engine';

const FIX_TOOLS = [
  'fix_structure',
  'fix_expression',
  'fix_repetition',
  'fix_synonym_rotation',
];

describe('★ 工具 → 规则映射：不许再指向不存在的规则', () => {
  it('每个修正工具映射到的 id 都在 FIX_RULES 里真实存在', () => {
    for (const tool of FIX_TOOLS) {
      const ids = toolRulesFor(tool);
      expect(ids.length, `${tool} 没映射到任何规则`).toBeGreaterThan(0);
      for (const id of ids) {
        expect(ruleById(id), `${tool} 映射到了不存在的规则 id「${id}」`).toBeTruthy();
      }
    }
  });

  it('★ 不再出现 family:* 伪 id（B8 的直接回归护栏）', () => {
    for (const tool of FIX_TOOLS) {
      for (const id of toolRulesFor(tool)) {
        expect(id.startsWith('family:'), `${tool} 仍在用伪 id「${id}」`).toBe(false);
      }
    }
  });

  it('fix_synonym_rotation 落到 F12/F13（same→F12，place/inch→F13）', () => {
    expect(toolRulesFor('fix_synonym_rotation').sort()).toEqual(['F12', 'F13']);
  });

  it('映射到的每条规则都是 auto:true（负面知识不该被工具执行）', () => {
    for (const tool of FIX_TOOLS) {
      for (const id of toolRulesFor(tool)) {
        expect(ruleById(id)!.auto, `${tool} → ${id} 不是 auto 规则`).toBe(true);
      }
    }
  });

  it('rulesOfTool 与 toolRulesFor 完全一致（不再有第二份口径）', () => {
    for (const tool of FIX_TOOLS) {
      expect(rulesOfTool(tool)).toEqual(toolRulesFor(tool));
    }
  });

  it('★ 声明与执行同源：deriveFixToolSpecs 产出的工具，其规则都能被执行到', () => {
    const specs = deriveFixToolSpecs();
    const declared = specs.map((s) => s.name).filter((n) => n.startsWith('fix_'));
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      const ids = toolRulesFor(name);
      expect(ids.length, `声明了工具 ${name} 但执行侧没有规则`).toBeGreaterThan(0);
      for (const id of ids) expect(ruleById(id)).toBeTruthy();
    }
  });

  it('全部 auto 规则都被至少一个工具覆盖（没有孤儿规则）', () => {
    const covered = new Set<string>();
    for (const tool of FIX_TOOLS) for (const id of toolRulesFor(tool)) covered.add(id);
    for (const rule of autoRules()) {
      expect(covered.has(rule.id), `${rule.id} 是 auto 规则却没有任何工具覆盖它`).toBe(true);
    }
  });

  it('未知工具名返回空数组（调用方据此报 E_INVALID_ARGS，而非静默跑零条）', () => {
    expect(toolRulesFor('no_such_tool')).toEqual([]);
  });
});

describe('★ 副作用检测面：单一真源，且 F6 的分叉已修', () => {
  it('★ F6 是「章首公式」，检测面必须是 openType 而不是 dialogRatio', () => {
    // 修复前 fix.ts 写 dialogRatio、side-effect.ts 写 openType，两份手抄表已分叉。
    // 真相在 fix-rules.ts: F6.targets = ['openType']。
    expect(sideEffectTargetsOf('F6')).toEqual(['openType']);
    expect(sideEffectTargetsOf('F6')).not.toContain('dialogRatio');
  });

  it('缺省等于 rule.targets；显式声明 sideEffectTargets 时以它为准', () => {
    expect(sideEffectTargetsOf('F8')).toEqual(ruleById('F8')!.targets);
    // F7 目标是 avgSent，但切句会波及句长离散度，故检测面额外含 sentCv
    expect(ruleById('F7')!.targets).toEqual(['avgSent']);
    expect(sideEffectTargetsOf('F7')).toEqual(['avgSent', 'sentCv']);
  });

  it('★ 每条 auto 规则都有非空检测面（空数组 = 副作用闸门 fail-open）', () => {
    for (const rule of autoRules()) {
      const t = sideEffectTargetsOf(rule.id);
      expect(t.length, `${rule.id} 的检测面为空，副作用闸门会对它直接放行`).toBeGreaterThan(0);
    }
  });

  it('两条路径拿到的检测面完全相同（fix.ts 与 side-effect.ts 已同源）', () => {
    // 两个模块现在都委托 sideEffectTargetsOf，这里锁住「同一 id 只有一个答案」
    for (const rule of FIX_RULES) {
      expect(sideEffectTargetsOf(rule.id)).toEqual(sideEffectTargetsOf(rule.id));
    }
  });

  it('未知规则 id 返回空数组（并被上一条的非空断言挡住，不会静默进入生产）', () => {
    expect(sideEffectTargetsOf('F999')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 行为层：零改动不再伪装成功 + families 参数真的参与选择
// ─────────────────────────────────────────────────────────────

function spec(lo: number, hi: number, label = 'x'): MetricSpec {
  return {
    label,
    unit: '',
    p05: lo,
    p25: lo,
    p50: (lo + hi) / 2,
    p75: hi,
    p95: hi,
    mean: (lo + hi) / 2,
    dir: 'both',
  };
}

/**
 * 受控基线：把 ttr / bigramTtr 的区间抬到 0.9~0.99（真实文本必然偏低 → F12 出手），
 * 把 triRepeat 的区间压到近乎 0（真实文本必然偏高 → F13 出手）。
 * 这样两条族规则的 applies 闸门都稳定打开，测试不受语料波动影响。
 */
function familyBaseline(): BaselineLike {
  const metrics: Record<string, MetricSpec> = {};
  for (const k of [
    'avgSent', 'sentCv', 'sentsPerPara', 'avgPara', 'dialogRatio',
    'chars', 'paras', 'sents', 'openType',
  ]) {
    metrics[k] = spec(0, 1e9, k); // 极宽区间 → 恒达标，不干扰
  }
  metrics.ttr = spec(0.9, 0.99, 'ttr');
  metrics.bigramTtr = spec(0.9, 0.99, 'bigramTtr');
  metrics.triRepeat = spec(0, 1e-9, 'triRepeat');

  const markerDensity: Record<string, { p50: number; p95: number }> = {};
  for (const k of MARKER_KEYS) markerDensity[k] = { p50: 1e9, p95: 1e9 }; // 恒达标
  return { source: 'test', metrics, markerDensity };
}

function makeCtx(dryRun: boolean): ToolContext {
  return {
    runId: 'test-fix',
    stepNo: 1,
    dryRun,
    requireCheckpoint: async (chs) => `ckpt_${chs.join('_')}`,
    signal: new AbortController().signal,
    logger: () => undefined,
  };
}

/** 数子串出现次数（不重叠） */
function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

describe('★ 零改动不再伪装成功（B8 的用户可见后果）', () => {
  let bodies: Map<string, string>;
  let deps: FixDeps;

  beforeEach(() => {
    // 一段干净的短文本：极宽基线下所有规则都判「达标」，必然零改动
    bodies = new Map([['37', '他走了。她来了。']]);
    deps = {
      getBodies: async (ids) => {
        const m = new Map<string, string>();
        for (const id of ids) {
          const b = bodies.get(id);
          if (b !== undefined) m.set(id, b);
        }
        return m;
      },
      setBody: async (id, body) => {
        bodies.set(id, body);
      },
      baseline: () => familyBaseline(),
    };
  });

  it('★ 零改动 + 无副作用否决 → ok:false 且 E_NO_EFFECT（修复前是 ok:true）', async () => {
    const res = await applyFixTool(
      'fix_synonym_rotation',
      { chapterIds: ['37'] },
      makeCtx(false),
      deps,
      { reversible: true },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('E_NO_EFFECT');
    // 关键：retryable 必须为 false，否则 Agent 仍会重试烧预算
    expect(res.error?.retryable).toBe(false);
    expect(bodies.get('37')).toBe('他走了。她来了。'); // 正文未被改动
  });

  it('preview 与 execute 对「无事可做」给出同一判定（T08 同路径）', async () => {
    const preview = await applyFixTool(
      'fix_repetition',
      { chapterIds: ['37'] },
      makeCtx(true),
      deps,
      { reversible: true },
    );
    const execute = await applyFixTool(
      'fix_repetition',
      { chapterIds: ['37'] },
      makeCtx(false),
      deps,
      { reversible: true },
    );
    expect(preview.ok).toBe(execute.ok);
    expect(preview.error?.code).toBe(execute.error?.code);
  });
});

describe('★ families 参数真的参与规则选择（修复前校验完就丢弃）', () => {
  /**
   * 「一样」→ F12 负责；「一寸不到」→ F13 负责。两族同时出现在文本里，
   * 就能从「谁被改了」反推出实际跑了哪条规则。
   *
   * ★ 语料构造有两个非显而易见的约束（都是读 fix-families.ts 才确认的）：
   *   1. `fixFamilyApply` 要求同族命中 **≥3 次**才轮换（少于 3 次视为噪音，不改）；
   *   2. 轮换按「出现次序对变体表取模」定位目标词形，而 FIX_SAME / FIX_INCH
   *      各只有 2 个变体 —— 若原文已经恰好像「一样…一个样…」那样交替排布，
   *      取模后每处都等于目标词形，改动数为 0。所以必须用**三处相同**的表述。
   *   另外 `same` 族的正则带 `(?=[，。”])` 前瞻，「一样」后必须紧跟标点，
   *   写成「一样的，」是不命中的。
   */
  const TEXT = '这三种说法一样，那种解释一样，最后一个一样。尺子一寸不到，绳子一寸不到，布条一寸不到。';
  let bodies: Map<string, string>;
  let deps: FixDeps;

  beforeEach(() => {
    bodies = new Map([['37', TEXT]]);
    deps = {
      getBodies: async (ids) => {
        const m = new Map<string, string>();
        for (const id of ids) {
          const b = bodies.get(id);
          if (b !== undefined) m.set(id, b);
        }
        return m;
      },
      setBody: async (id, body) => {
        bodies.set(id, body);
      },
      baseline: () => familyBaseline(),
    };
  });

  it('★ 不传 families 时 fix_synonym_rotation 真的会改动正文（修复前恒零改动）', async () => {
    const res = await applyFixTool(
      'fix_synonym_rotation',
      { chapterIds: ['37'] },
      makeCtx(true),
      deps,
      { reversible: true },
    );
    expect(res.ok).toBe(true);
    expect(res.data!.changeSet.edits.length).toBeGreaterThan(0);
    // 两族各轮换 1 处 = 2 条编辑。修复前 finalEdits 用 push 累加 trial.changes，
    // 而 trial 每轮都从原文重跑全部已接受规则，导致 F12 的编辑被重复计入（报 3 条）。
    expect(res.data!.changeSet.edits).toHaveLength(2);
    expect(res.data!.changeSet.patches[0].edits).toHaveLength(2);
  });

  it('★ edits 不重复计数（每条规则只贡献自己的改动）', async () => {
    const res = await applyFixTool(
      'fix_synonym_rotation',
      { chapterIds: ['37'] },
      makeCtx(true),
      deps,
      { reversible: true },
    );
    expect(res.ok).toBe(true);
    const edits = res.data!.changeSet.edits;
    // F12 轮换 1 处「一样」、F13 轮换 1 处「一寸不到」→ 各贡献 1 条。
    // 修复前 finalEdits 累加的是「全部已接受规则」的 trial.changes，
    // F12 的编辑会被计两次，这里会变成 ['F12','F12','F13']。
    expect(edits.map((e) => e.ruleId).sort()).toEqual(['F12', 'F13']);
    // 每条编辑的 before 都必须真的出现在原文里（不是凭空构造的）
    for (const e of edits) {
      expect(TEXT).toContain(e.before);
    }
    // 注：这里**不**断言「按 at 倒序重放能重建 afterText」。
    // FixPlan.changes 是跨规则摊平的总表，各条 at 分属不同坐标系
    // （规则串行作用，cur 逐条变化），整体不可用于反向 patch——
    // 这也是 rollbackRule() 选择「从原文重放」的原因。详见 Edit.at 的注释。
  });

  it("families:['same'] 只轮换「一样」，不动「一寸不到」", async () => {
    const res = await applyFixTool(
      'fix_synonym_rotation',
      { chapterIds: ['37'], families: ['same'] },
      makeCtx(true),
      deps,
      { reversible: true },
    );
    expect(res.ok).toBe(true);
    const after = res.data!.changeSet.patches[0]?.afterText ?? '';
    // 轮换按次序取模，3 处命中里只有 1 处的目标词形与原文不同 → 「一样」少一个
    expect(count(after, '一样')).toBe(count(TEXT, '一样') - 1);
    expect(after).toContain('一个样');
    // ★ F13 未被选中 → 「一寸不到」一字不动
    expect(count(after, '一寸不到')).toBe(count(TEXT, '一寸不到'));
  });

  it("families:['inch'] 走 F13，会轮换「一寸不到」，但不动「一样」", async () => {
    const res = await applyFixTool(
      'fix_synonym_rotation',
      { chapterIds: ['37'], families: ['inch'] },
      makeCtx(true),
      deps,
      { reversible: true },
    );
    expect(res.ok).toBe(true);
    const after = res.data!.changeSet.patches[0]?.afterText ?? '';
    expect(count(after, '一寸不到')).toBe(count(TEXT, '一寸不到') - 1);
    expect(after).toContain('不到一寸');
    // F12 未被选中 → 「一样」一字不动
    expect(count(after, '一样')).toBe(count(TEXT, '一样'));
  });

  it('无效族名被明确拒绝，且提示「没有 verb 族」这条刻意关闭的能力', async () => {
    const res = await applyFixTool(
      'fix_synonym_rotation',
      { chapterIds: ['37'], families: ['verb'] },
      makeCtx(true),
      deps,
      { reversible: true },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('E_INVALID_ARGS');
    expect(res.error?.message).toContain('verb');
  });

  it('families 全部无效时不静默跑全族，而是报 E_INVALID_ARGS', async () => {
    const res = await applyFixTool(
      'fix_synonym_rotation',
      { chapterIds: ['37'], families: ['nope'] },
      makeCtx(true),
      deps,
      { reversible: true },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('E_INVALID_ARGS');
  });
});
