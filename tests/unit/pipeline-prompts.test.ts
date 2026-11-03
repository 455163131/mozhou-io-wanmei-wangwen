import { describe, it, expect } from 'vitest';
import { composeConceptPrompt, composeArchitectPrompt, composeWriterPrompt } from '@main/pipeline/prompts';
import type { PipelineCtx } from '@shared/types/pipeline';

const ctx: PipelineCtx = { genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 1200000, premise: '少年拾玉佩藏时间秘境', canon: ['玉佩内时间流速 3000:3'] };

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
