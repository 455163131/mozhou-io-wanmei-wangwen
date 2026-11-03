// tests/unit/platforms-en.test.ts
//
// P1-B T3：海外平台规则包 + PipelineCtx.language + prompt 英文适配。
// 断言口径来自 task-3-brief.md 的 Interfaces 与 Step 1 原稿。
import { describe, it, expect } from 'vitest';
import { composeWriterPrompt, composeConceptPrompt } from '@main/pipeline/prompts';
import { PLATFORM_RULES } from '@shared/constants/platforms';
import type { PipelineCtx } from '@shared/types/pipeline';

const zh: PipelineCtx = { genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 1200000, premise: 'p', canon: [], language: 'zh' };
const en: PipelineCtx = { ...zh, platform: 'Webnovel', language: 'en', platformRule: PLATFORM_RULES.find(p => p.id === 'webnovel') };

describe('海外/英文适配', () => {
  it('en 写手 system 含英文工艺块且仍逐字节稳定', () => {
    const a = composeWriterPrompt({ ...en, chapterNo: 2 });
    const b = composeWriterPrompt({ ...en, chapterNo: 9 });
    expect(a).toBe(b);
    expect(a).toMatch(/English/);
    expect(a).toContain('1.5k');  // 平台甜区注记进 system 平台段
  });
  it('zh 写手 system 不含英文工艺块（既有稳定测试不回归）', () => {
    expect(composeWriterPrompt(zh)).not.toMatch(/translationese/);
  });
  it('en 构思要求英文产出', () => {
    expect(composeConceptPrompt(en)).toMatch(/English/);
  });
  it('海外三平台规则包字段齐全', () => {
    const os = PLATFORM_RULES.filter(p => p.market === 'overseas');
    expect(os).toHaveLength(3);
    os.forEach(p => expect(p.contentNotes.length).toBeGreaterThan(0));
  });
});
