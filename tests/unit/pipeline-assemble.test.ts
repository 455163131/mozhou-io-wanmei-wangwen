// tests/unit/pipeline-assemble.test.ts
import { describe, it, expect } from 'vitest';
import { assembleWriterContext, estimateTokens, fitCraftSkillEntries } from '@main/pipeline/assemble';
import type { PipelineCtx } from '@shared/types/pipeline';

const base: PipelineCtx = { genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 1200000, premise: 'p', canon: ['铁律一'] , planItem: { title: '雾中拾玉', hook: '玉佩里传出心跳声' }, language: 'zh', foreshadowLines: [], castLines: [] };
const budget = { window: 128000, outputReserve: 4000 };

describe('装配器', () => {
  it('保护层（canon/章纲/项目参数）始终全文进入 user', () => {
    const { user } = assembleWriterContext(base, budget);
    expect(user).toContain('铁律一');
    expect(user).toContain('玉佩里传出心跳声');
  });
  it('canon 超保护配额 → 硬失败直报真因，不静默裁剪', () => {
    const big = Array.from({ length: 400 }, (_, i) => `铁律${i}：` + 'x'.repeat(60));
    expect(() => assembleWriterContext({ ...base, canon: big }, { window: 8000, outputReserve: 4000 }))
      .toThrowError(/E_PROTECTED_OVERBUDGET|超保护配额/);
  });
  it('可压缩栏位裁剪留 trace（被裁内容与原因可回查）', () => {
    const longPrev = '前文摘要。'.repeat(4000);
    const { trace, user } = assembleWriterContext({ ...base, prevEnding: longPrev }, { window: 9000, outputReserve: 4000 });
    const t = trace.find(x => x.slot === 'prevEnding' && x.action !== 'kept');
    expect(t).toBeTruthy();
    expect(t!.reason.length).toBeGreaterThan(0);
    expect(estimateTokens(user)).toBeLessThanOrEqual(9000 - 4000);
  });
  it('craftSkills 槽：命中触发词时正文进 user，紧预算时按 rank 裁剪留 trace', () => {
    const ctx = { ...base, planItem: { title: '开篇', hook: '章末钩子：心跳声' } };
    const { user } = assembleWriterContext(ctx, { window: 128000, outputReserve: 4000 });
    expect(user).toContain('章末钩子三件套');
    const tight = assembleWriterContext({ ...ctx, prevEnding: 'x'.repeat(20000) }, { window: 9000, outputReserve: 4000 });
    expect(tight.trace.some(t => t.slot === 'craftSkills' || t.slot === 'prevEnding')).toBe(true);
  });
  it('P2-B T7：foreshadow/cast 槽在预算内各记一条 kept trace（装配可视化面板零改动即见）', () => {
    const ctx = {
      ...base,
      foreshadowLines: ['【伏笔】秘境钥匙（埋第1章·权重A）：主线'],
      castLines: ['林晚：右手受伤｜知：玉佩是钥匙｜不知：未登记'],
    };
    const { user, trace } = assembleWriterContext(ctx, budget);
    expect(user).toContain('【伏笔台账】');
    expect(user).toContain('【伏笔】秘境钥匙（埋第1章·权重A）：主线');
    expect(user).toContain('【人物近况】');
    expect(user).toContain('林晚：右手受伤｜知：玉佩是钥匙｜不知：未登记');
    const slots = trace.map((t) => t.slot);
    expect(slots).toContain('foreshadow');
    expect(slots).toContain('cast');
    for (const s of ['foreshadow', 'cast']) {
      expect(trace.find((t) => t.slot === s)!.action).toBe('kept');
    }
  });
  it('R25：craftSkills 硬顶按条目边界整条丢弃末位命中，不拦腰截半条指令', () => {
    const parts = ['第一条完整指令甲', '第二条完整指令乙', '第三条完整指令丙'];
    // 硬顶恰好装得下前两条（'\n\n' 连接）→ 第三条整条丢弃
    const cap = parts[0].length + 2 + parts[1].length;
    const fitted = fitCraftSkillEntries(parts, cap);
    expect(fitted.text).toBe(`${parts[0]}\n\n${parts[1]}`);
    expect(fitted.text).not.toContain('第三');
    expect(fitted.droppedCount).toBe(1);
    // 连首条都装不下 → 整槽丢弃（空文本），绝不切出半条
    const none = fitCraftSkillEntries(parts, 3);
    expect(none.text).toBe('');
    expect(none.droppedCount).toBe(3);
    // 装得下全部 → 一条不丢
    const all = fitCraftSkillEntries(parts, 9999);
    expect(all.text).toBe(parts.join('\n\n'));
    expect(all.droppedCount).toBe(0);
  });
});
