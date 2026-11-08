// tests/unit/chart-parse.test.ts
import { describe, it, expect } from 'vitest';
import { parseChartHtml } from '@main/inspiration/chart-parse';

describe('parseChartHtml', () => {
  it('番茄榜单 HTML 解析出条目（rank/title/author，heat 无据则 null）', () => {
    const html = `<div class="rank-item"><span class="num">1</span><a href="/book/1">测试书名</a><span class="author">作者甲</span></div>`;
    const out = parseChartHtml('番茄', html);
    expect(out[0]).toMatchObject({ rank: 1, title: '测试书名', author: '作者甲', platform: '番茄', live: true });
    expect(out[0].heat).toBeNull(); // 页面无热度数字 → null，绝不编造
  });
  it('无法识别的结构 → 抛真因（不静默回空）', () => {
    expect(() => parseChartHtml('晋江', '<html>无关</html>')).toThrowError(/解析|未识别|榜单/);
  });
});
