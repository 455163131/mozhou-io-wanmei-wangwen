/**
 * 派生工具测试（架构 T27 明确要求）。
 *
 * ★★★ 本测试的核心价值在于**不能只测字面量** ★★★
 *
 * `auto:true` 的规则实际是 13 条（F1–F13），但其中 **F1–F5 由
 * `fixFromSuggestionRule()` 工厂函数生成**，源码里**不以 `{id:'F1'}` 字面量出现**
 * —— 它是 `fixFromSuggestionRule('F1','R1',...)` 的**调用参数**。
 *
 * 所以 `grep "id: 'F"` 只能数出 8 条（F6–F13），会漏掉 F1–F5。
 * 而 F1（观感替代）与 F4（动作三板斧）恰好是 PRD 样例里
 * Agent 自主选择的那两条规则 —— 漏了会导致本测试失败。
 *
 * 另：N 类是 N1–N4 **四条齐全**，不是只有 N1/N2。
 */
import { describe, it, expect } from 'vitest';
import {
  FIX_RULES,
  autoRules,
  negativeRules,
  fixFromSuggestionRule,
} from '@main/rule-engine/fix-rules';
import { FIX_FAMILIES } from '@main/rule-engine/fix-families';
import { deriveFixToolSpecs, rulesOfTool, negativeKnowledgeForPrompt } from '@main/tools/derive-from-rules';

describe('FIX_RULES 规则表完整性', () => {
  it('auto:true 恰好 13 条（F1–F13）', () => {
    const auto = autoRules();
    expect(auto).toHaveLength(13);
    const ids = auto.map((r) => r.id).sort();
    // 逐个列出而非用范围断言，确保 F1–F5 真的在列表里
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13']) {
      expect(ids, `缺少规则 ${id}`).toContain(id);
    }
  });

  it('★ F1–F5 由工厂生成，源码里无 {id:"F1"} 字面量——本测试证明它们确实存在', () => {
    // 这 5 条来自工厂，不走对象字面量。逐个验证可用：
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5']) {
      const r = FIX_RULES.find((x) => x.id === id);
      expect(r, `规则 ${id} 不存在（工厂生成的规则被漏掉了？）`).toBeDefined();
      expect(r!.auto).toBe(true);
      expect(typeof r!.fix).toBe('function');
    }
  });

  it('★ F1 与 F4 是 PRD 样例里 Agent 自主选择的那两条，必须覆盖', () => {
    const f1 = FIX_RULES.find((r) => r.id === 'F1');
    const f4 = FIX_RULES.find((r) => r.id === 'F4');
    expect(f1?.label).toBe('观感替代');
    expect(f1?.targets).toContain('marker:看了X遍/X久/X会儿');
    expect(f4?.label).toBe('动作三板斧');
    expect(f4?.targets).toContain('marker:抬起头/低头');
  });

  it('★ N 类是 N1–N4 四条齐全，且都带 why（负面知识）', () => {
    const neg = negativeRules();
    expect(neg).toHaveLength(4);
    for (const id of ['N1', 'N2', 'N3', 'N4']) {
      const r = neg.find((x) => x.id === id);
      expect(r, `缺少负面知识 ${id}`).toBeDefined();
      expect(r!.auto).toBe(false);
      // why 必须填 —— 这是「诚实登记，不做假按钮」的关键
      expect(r!.why, `${id} 缺 why，模型会尝试调用不存在的能力`).toBeTruthy();
      expect((r!.why ?? '').length).toBeGreaterThan(10);
      // auto:false 的规则不应有 fix
      expect(r!.fix).toBeUndefined();
    }
  });

  it('N1 的 why 说明「对白占比必须作者处理」（PRD 引用了这段原文）', () => {
    const n1 = FIX_RULES.find((r) => r.id === 'N1');
    expect(n1?.why).toContain('对白段占比');
    expect(n1?.why).toContain('必须作者处理');
  });

  it('每条 auto 规则都有 label / layer / targets', () => {
    for (const r of autoRules()) {
      expect(r.label, `${r.id} 缺 label`).toBeTruthy();
      expect(r.layer, `${r.id} 缺 layer`).toBeTruthy();
      expect(r.targets.length, `${r.id} targets 为空`).toBeGreaterThan(0);
      expect(typeof r.fix).toBe('function');
    }
  });
});

describe('FIX_FAMILIES 同义词族', () => {
  it('恰好 3 族：place / same / inch', () => {
    expect(FIX_FAMILIES).toHaveLength(3);
    expect(FIX_FAMILIES.map((f) => f.id).sort()).toEqual(['inch', 'place', 'same']);
  });

  it('★ 没有 verb 族——这是基于 715 章实测词频的刻意关闭，不可随意放开', () => {
    expect(FIX_FAMILIES.find((f) => f.id === 'verb')).toBeUndefined();
    for (const f of FIX_FAMILIES) {
      expect(f.variants, `${f.id} 的变体里出现了说/道/问/念`).not.toContain('说');
      expect(f.variants).not.toContain('道');
      expect(f.variants).not.toContain('问');
    }
  });

  it('★ fix_synonym_rotation 的工具描述里明确告知「没有 verb 族」', () => {
    const specs = deriveFixToolSpecs();
    const syn = specs.find((s) => s.name === 'fix_synonym_rotation');
    expect(syn).toBeDefined();
    expect(syn!.description).toContain('没有 verb 族');
    expect(syn!.description).toContain('刻意');
    // enum 里也不该有 verb
    const famParam = syn!.params.find((p) => p.name === 'families');
    expect(famParam?.enum).toBeDefined();
    expect(famParam!.enum).not.toContain('verb');
  });
});

describe('工具派生（架构 §1.5 五条转换规则）', () => {
  const specs = deriveFixToolSpecs();

  it('派生 4 个聚合工具', () => {
    expect(specs).toHaveLength(4);
    expect(specs.map((s) => s.name).sort()).toEqual([
      'fix_expression',
      'fix_repetition',
      'fix_structure',
      'fix_synonym_rotation',
    ]);
  });

  it('13 条 auto 规则全部被聚合工具覆盖（无一遗漏）', () => {
    const covered = new Set<string>();
    for (const name of ['fix_structure', 'fix_expression', 'fix_repetition']) {
      for (const id of rulesOfTool(name)) covered.add(id);
    }
    // 4 个聚合工具 + 3 族 = 应覆盖 F1–F13 全部
    for (const r of autoRules()) {
      expect(covered.has(r.id), `规则 ${r.id}（${r.label}）未被任何聚合工具覆盖`).toBe(true);
    }
  });

  it('聚合分组符合架构 §1.5 的表', () => {
    expect(rulesOfTool('fix_structure').sort()).toEqual(['F10', 'F6', 'F7', 'F8', 'F9']);
    expect(rulesOfTool('fix_expression').sort()).toEqual(['F1', 'F11', 'F2', 'F3', 'F4', 'F5']);
    expect(rulesOfTool('fix_repetition').sort()).toEqual(['F12', 'F13']);
  });

  it('每个工具都有 danger / reversible / costHintMs / idempotent', () => {
    for (const s of specs) {
      expect(s.danger).toBeGreaterThanOrEqual(1);
      expect(s.reversible).toBe(true);
      expect(s.costHintMs).toBeGreaterThan(0);
      expect(typeof s.idempotent).toBe('boolean');
      expect(s.params.length).toBeGreaterThan(0);
    }
  });

  it('结构层工具的 metrics enum 只含它真正负责的指标', () => {
    const st = specs.find((s) => s.name === 'fix_structure');
    const metrics = st!.params.find((p) => p.name === 'metrics');
    expect(metrics?.enum).toBeDefined();
    // F6→openType 不是 raw 指标，其余是 F7/F8/F9/F10 的 targets
    for (const m of ['avgSent', 'sentCv', 'avgPara', 'sentsPerPara']) {
      expect(metrics!.enum).toContain(m);
    }
  });
});

describe('负面知识进系统提示（架构 §6 第 7 条铁律）', () => {
  it('4 条 why 全部出现在提示词里', () => {
    const text = negativeKnowledgeForPrompt();
    for (const r of negativeRules()) {
      expect(text, `${r.id} 的 why 未进提示词`).toContain(r.why!.slice(0, 12));
    }
  });

  it('提示词含「不要尝试调用」的明确禁令', () => {
    const text = negativeKnowledgeForPrompt();
    expect(text).toContain('不要尝试');
    expect(text).toContain('必须作者处理');
  });
});

describe('工厂函数', () => {
  it('fixFromSuggestionRule 生成的规则结构正确', () => {
    const r = fixFromSuggestionRule('F99', 'R1', '测试', '表达层', ['marker:看了X遍/X久/X会儿']);
    expect(r.id).toBe('F99');
    expect(r.auto).toBe(true);
    expect(typeof r.fix).toBe('function');
  });

  it('★ 工厂生成的规则：引号内不改动（人物语言保护）', () => {
    const r = fixFromSuggestionRule('F1', 'R1', '观感替代', '表达层', ['marker:看了X遍/X久/X会儿']);
    const withQuote = '“他看了她三遍”然后走开了。';
    expect(typeof r.fix).toBe('function');
    const out = r.fix!(withQuote, {} as never);
    // 引号内的命中必须被跳过
    expect(out.text).toBe(withQuote);
    expect(out.changes).toHaveLength(0);
  });

  it('★ 工厂生成的规则：非引号内容正常改写', () => {
    const r = fixFromSuggestionRule('F1', 'R1', '观感替代', '表达层', ['marker:看了X遍/X久/X会儿']);
    const plain = '他看了三遍窗外的雨。';
    // r.fix 一定存在（工厂函数总会提供），此处断言以满足类型窄化
    expect(typeof r.fix).toBe('function');
    const out = r.fix!(plain, {} as never);
    expect(out.text).not.toBe(plain);
    expect(out.changes.length).toBeGreaterThan(0);
    // 改写位置必须能在原文逐字找到（C18 硬约束 a）
    for (const c of out.changes) {
      expect(plain.slice(c.at, c.at + c.before.length)).toBe(c.before);
    }
  });
});