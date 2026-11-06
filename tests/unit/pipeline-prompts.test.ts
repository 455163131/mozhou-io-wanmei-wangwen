import { describe, it, expect } from 'vitest';
import { composeConceptPrompt, composeArchitectPrompt, composeWriterPrompt } from '@main/pipeline/prompts';
import type { PromptOverlay } from '@main/pipeline/overlay';
import type { PipelineCtx } from '@shared/types/pipeline';

const ctx: PipelineCtx = { genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 1200000, premise: '少年拾玉佩藏时间秘境', canon: ['玉佩内时间流速 3000:3'], language: 'zh' };

describe('prompt 合成器机制断言', () => {
  it('构思：缺项禁止自行补全 + 金手指必须有代价 + 3书名5分支硬约束', () => {
    const p = composeConceptPrompt(ctx);
    expect(p).toMatch(/不得自行补全|缺项/);
    expect(p).toMatch(/代价/);
    expect(p).toMatch(/3/); expect(p).toMatch(/5/);
    expect(p).toContain('纯 JSON');
  });
  it('架构师：卷纲+章纲双任务、hook 禁止空话、canon 注入', () => {
    const p = composeArchitectPrompt(ctx);
    expect(p).toMatch(/卷/); expect(p).toMatch(/章纲/);
    expect(p).toMatch(/禁止|不得/);
    expect(p).toContain('玉佩内时间流速 3000:3');
  });
  it('写手：六类场景各带状态变化 delta、章末钩子铁律、canon 注入、直接输出正文', () => {
    const p = composeWriterPrompt(ctx);
    const scenes = ['动作', '情感', '对话', '调查', '过渡', '揭示'];
    scenes.forEach(s => expect(p).toContain(s));
    expect(p).toMatch(/状态变化/);
    expect(p).toMatch(/章末|钩子/);
    expect(p).toContain('玉佩内时间流速 3000:3');
    expect(p).toMatch(/直接输出/);
  });
  it('写手 system 与章节号解耦（同书逐字节稳定，命中 prompt cache）', () => {
    const a = composeWriterPrompt({ ...ctx, chapterNo: 3 });
    const b = composeWriterPrompt({ ...ctx, chapterNo: 9 });
    expect(a).toBe(b);
  });
});

// P2-A T2：覆盖层接入合成器——附加要求原样追加 system 末尾（块头「【作者附加要求】」），
// 无覆盖层时输出与接入前逐字节等（既有回归口径不变）。
describe('覆盖层注入合成器（P2-A T2）', () => {
  it('三角色：附加要求逐字追加在 system 尾部（空行 + 块头 + 原文）', () => {
    const additional = '第一行要求\n  第二行带缩进。';
    expect(composeConceptPrompt(ctx, { role: 'concept', temperature: null, additional })).toBe(
      `${composeConceptPrompt(ctx)}\n\n【作者附加要求】\n${additional}`,
    );
    expect(composeArchitectPrompt(ctx, { role: 'architect', temperature: 0.2, additional })).toBe(
      `${composeArchitectPrompt(ctx)}\n\n【作者附加要求】\n${additional}`,
    );
    expect(composeWriterPrompt(ctx, { role: 'writer', temperature: 0.4, additional })).toBe(
      `${composeWriterPrompt(ctx)}\n\n【作者附加要求】\n${additional}`,
    );
  });

  it('无 overlay / null / additional trim 后为空 → 与现状逐字节等（快照式等值）', () => {
    for (const compose of [composeConceptPrompt, composeArchitectPrompt, composeWriterPrompt] as const) {
      const base = compose(ctx);
      expect(compose(ctx, undefined)).toBe(base);
      expect(compose(ctx, null)).toBe(base);
      expect(compose(ctx, { role: 'writer', temperature: 0.3, additional: '  \n\t ' })).toBe(base);
      expect(base).not.toContain('【作者附加要求】');
    }
  });

  it('additional 首尾空白在追加前 trim 掉', () => {
    expect(
      composeWriterPrompt(ctx, { role: 'writer', temperature: null, additional: '\n  留钩子  \n' }),
    ).toBe(`${composeWriterPrompt(ctx)}\n\n【作者附加要求】\n留钩子`);
  });

  it('写手 system 缓存纪律扩展形态：同书 + 同覆盖层内容，跨章号仍逐字节稳定', () => {
    const o: PromptOverlay = { role: 'writer', temperature: null, additional: '每章留钩。' };
    expect(composeWriterPrompt({ ...ctx, chapterNo: 3 }, o)).toBe(composeWriterPrompt({ ...ctx, chapterNo: 9 }, o));
  });
});
