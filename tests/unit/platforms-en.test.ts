// tests/unit/platforms-en.test.ts
//
// P1-B T3：海外平台规则包 + PipelineCtx.language + prompt 英文适配。
// 断言口径来自 task-3-brief.md 的 Interfaces 与 Step 1 原稿。
import { describe, it, expect } from 'vitest';
import { composeWriterPrompt, composeConceptPrompt, composeArchitectPrompt } from '@main/pipeline/prompts';
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

/* ── P1-B T4：R27 架构师 en 适配 / minor-3 构思单章 words / R28 稳定性钉死 ── */

const enArch: PipelineCtx = { genre: '古风玄幻', platform: 'Webnovel', chapterWords: 2000, targetWords: 400000, premise: 'p', canon: [], language: 'en', platformRule: PLATFORM_RULES.find(p => p.id === 'webnovel') };
const zhArch: PipelineCtx = { genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 1200000, premise: 'p', canon: [], language: 'zh' };

describe('R27 架构师 en 适配', () => {
  it('en 架构师 system 要求英文产出（volumes/goal/chapterPlan title/hook 一律英文）', () => {
    const p = composeArchitectPrompt(enArch);
    expect(p).toMatch(/English/);
    // volumes/goal/chapterPlan title/hook 四项都被点到
    expect(p).toContain('volumes');
    expect(p).toContain('goal');
    expect(p).toContain('title');
    expect(p).toContain('hook');
  });
  it('en 架构师单章字数单位改 words', () => {
    const p = composeArchitectPrompt(enArch);
    expect(p).toContain(`${enArch.chapterWords} words`);
    // en 不再出现「字」这个中文字数单位（压力密度行的「每千字一拍」也要改英文口径）
    expect(p).not.toContain('字内应布置');
  });
  it('zh 架构师保持「字」单位与原行为（逐字节不变）', () => {
    const p = composeArchitectPrompt(zhArch);
    expect(p).toContain(`${zhArch.chapterWords} 字`);
    expect(p).not.toContain('words');
    expect(p).not.toMatch(/English/);
  });
});

describe('minor-3 构思 en 单章单位改 words', () => {
  it('en 构思单章单位 words', () => {
    expect(composeConceptPrompt(en)).toContain(`${en.chapterWords} words`);
  });
  it('zh 构思单章单位仍是「字」（逐字不变）', () => {
    expect(composeConceptPrompt(zh)).toContain(`${zh.chapterWords} 字`);
    expect(composeConceptPrompt(zh)).not.toContain('words');
  });
});

describe('R28 zh+番茄 platformRule 注入国内注记的稳定性边界', () => {
  const zhFanqie: PipelineCtx = { ...zh, platform: '番茄', platformRule: PLATFORM_RULES.find(p => p.id === 'fanqie') };
  it('同书 chapterNo 变化 system 逐字节稳定', () => {
    const a = composeWriterPrompt({ ...zhFanqie, chapterNo: 3 });
    const b = composeWriterPrompt({ ...zhFanqie, chapterNo: 9 });
    expect(a).toBe(b);
  });
  it('国内注记确在 system（平台工艺注记段 + 番茄首条 contentNotes）', () => {
    const p = composeWriterPrompt(zhFanqie);
    expect(p).toContain('【平台工艺注记 · 番茄】');
    expect(p).toContain('免费阅读生态靠留存说话');
    // zh 仍不含英文工艺块
    expect(p).not.toMatch(/translationese/);
  });
});
