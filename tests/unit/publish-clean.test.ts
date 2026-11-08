// tests/unit/publish-clean.test.ts
import { describe, it, expect } from 'vitest';
import { cleanForPublish } from '@shared/publish/clean';

describe('cleanForPublish 确定性清洗（主链四道 + overseas 第五道）', () => {
  it('①零宽/控制字符剥除（\n\t 保留）', () => {
    const r = cleanForPublish('第一段\u200B隐藏\uFEFF。\n\t缩进保留');
    expect(r.cleaned).toBe('第一段隐藏。\n\t缩进保留');
    expect(r.edits.some((e) => e.rule === 'zero-width')).toBe(true);
  });
  it('②水平线与代码围栏整行剥', () => {
    const r = cleanForPublish('上段\n---\n```json\n正文\n```\n下段');
    expect(r.cleaned).toBe('上段\n正文\n下段');
  });
  it('②markdown 强调成对剥离；不成对不动', () => {
    expect(cleanForPublish('他说**重点**了').cleaned).toBe('他说重点了');
    expect(cleanForPublish('半个**标记不动').cleaned).toBe('半个**标记不动');
  });
  it('③行尾空白剥；连续空行 >2 压 2', () => {
    const r = cleanForPublish('a   \nb\n\n\n\n\nc');
    expect(r.cleaned).toBe('a\nb\n\n\nc');
  });
  it('④overseas 剥 HTML 标签行残留；cn 不动标签', () => {
    expect(cleanForPublish('<br>换行', 'overseas').cleaned).toBe('换行');
    expect(cleanForPublish('<br>换行', 'cn').cleaned).toBe('<br>换行');
  });
  it('幂等：clean(clean(x)) === clean(x)（混样三市场全跑）', () => {
    const nasty = 'x\u200B\n---\n**a**\n\n\n\n\n<br>y  ';
    for (const m of ['cn', 'overseas'] as const) {
      const once = cleanForPublish(nasty, m);
      expect(cleanForPublish(once.cleaned, m).cleaned).toBe(once.cleaned);
      expect(cleanForPublish(once.cleaned, m).edits).toHaveLength(0);
    }
  });
  it('幂等·跨道重暴露族（T4 评审 Important-1）：整行强调包规则/围栏体，二次跑零编辑零变化', () => {
    // 这些形状在第一遍 md-emphasis 剥完后**裸露出整行规则/围栏**——
    // 已跑过的 horiz 道不回头的单遍管道会在二次跑产 edit 并改输出，破契约。
    const shapes = ['**---**', '__---__', '**```**', '正文\n**---**\n正文', 'a\n\n**---**\n\nb'];
    for (const m of ['cn', 'overseas'] as const) {
      for (const s of shapes) {
        const once = cleanForPublish(s, m);
        expect(cleanForPublish(once.cleaned, m).edits, `${m}/${JSON.stringify(s)}`).toHaveLength(0);
        expect(cleanForPublish(once.cleaned, m).cleaned).toBe(once.cleaned);
      }
    }
  });
  it('幂等·html-tags 复归一防线专钉（T4 评审 Minor-1：无复归一则此二形破约）', () => {
    const shapes = ['a  <br>  ', 'a\n\n<br>\n\n\n\nb'];
    for (const s of shapes) {
      const once = cleanForPublish(s, 'overseas');
      expect(cleanForPublish(once.cleaned, 'overseas').edits, JSON.stringify(s)).toHaveLength(0);
      expect(cleanForPublish(once.cleaned, 'overseas').cleaned).toBe(once.cleaned);
    }
  });
  it('幂等·html-tags→horiz 重暴露闭合（T7 携带修复：剥标签裸露整行规则，同型 md 道先例）', () => {
    // '<p>---</p>' 剥后剩 '---'、'a\n<br>---<br>' 剥后剩 'a\n---'——单遍管道里
    // horiz 道已跑过不回头，二次跑必产 edit 改输出；修复前这两形必红。
    const shapes = ['<p>---</p>', 'a\n<br>---<br>'];
    for (const s of shapes) {
      const once = cleanForPublish(s, 'overseas');
      expect(cleanForPublish(once.cleaned, 'overseas').edits, JSON.stringify(s)).toHaveLength(0);
      expect(cleanForPublish(once.cleaned, 'overseas').cleaned, JSON.stringify(s)).toBe(once.cleaned);
    }
    // 修复后语义真形：裸露的规则行在第一遍就被补跑的 horiz 道吃掉
    expect(cleanForPublish('<p>---</p>', 'overseas').cleaned).toBe('');
    expect(cleanForPublish('a\n<br>---<br>', 'overseas').cleaned).toBe('a\n');
    // cn 市场从不跑 html 道——这两形在 cn 下按现契约原样保留规则行（只钉 overseas 不是笔误）
    expect(cleanForPublish('<p>---</p>', 'cn').cleaned).toBe('<p>---</p>');
  });
  it('edits 携 before/after 可审', () => {
    const r = cleanForPublish('尾空白   ', 'cn');
    expect(r.edits[0].before).toBe('尾空白   ');
  });
});
