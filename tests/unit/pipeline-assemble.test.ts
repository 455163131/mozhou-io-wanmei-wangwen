// tests/unit/pipeline-assemble.test.ts
import { describe, it, expect } from 'vitest';
import { assembleWriterContext, estimateTokens } from '@main/pipeline/assemble';
import type { PipelineCtx } from '@shared/types/pipeline';

const base: PipelineCtx = { genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 1200000, premise: 'p', canon: ['铁律一'] , planItem: { title: '雾中拾玉', hook: '玉佩里传出心跳声' } };
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
});
