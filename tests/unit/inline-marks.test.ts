/**
 * 审稿行内标注的纯逻辑（§4 第 7 条）。
 *
 * 编辑框是 textarea，里面塞不进 HTML，所以行内 wavy 只能靠"背后一层同字体的镜像 div"
 * （文字透明 + 波浪线有色）。这一层对不对，取决于**偏移映射**这一件事——
 * 它是纯函数、可在无 DOM 下钉死，所以先只测它，组件那层另做装配哨兵。
 *
 * ★ 最要紧的不是"画得出来"，而是"什么时候不许画"：
 *   `FlavorHit.offset` 是**检测那一刻**那份正文的坐标。作者检测完又改了几个字，
 *   坐标整体漂移，波浪线会画到别的句子上——比没有标注更糟（人会照着错的位置改）。
 *   所以每条命中落图前要做**逐字回验**：按引擎的 excerpt 口径
 *   （`engine.ts:940 excerptOf`：命中前后各带 12 字上下文，超出边界补 `…`）
 *   用当前正文在同一位置重算一遍，两者不一致就说明这里及其之前的文本变了，丢掉这条。
 *   这条校验不要内容比对、不猜相似度、不"大概对齐"，且对"只按了一个回车"这种
 *   去空白字数不变的改动同样有效（字数比对拦不住它）。
 */
import { describe, it, expect } from 'vitest';
import { marksFromHits, segmentsOf } from '@renderer/components/editor/inline-marks';
import { detectFlavor } from '@shared/ai-flavor/engine';
import type { FlavorHit, FlavorLevel } from '@shared/types/ai-flavor';

const body = '他顿了一下。抬起头看她。她笑了笑。他顿了一下。';

/** 与 engine.ts:940 同口径的 excerpt，测试里独立写一遍，用来构造"漂移了"的反例 */
function excerptAt(text: string, start: number, len: number, pad = 12): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, start + len + pad);
  return `${s > 0 ? '…' : ''}${text.slice(s, e)}${e < text.length ? '…' : ''}`;
}

/** 造一条命中：默认带上按当前正文算出的合法 excerpt，所以默认是"可画"的 */
function hit(
  start: number,
  length: number,
  level: FlavorLevel = 'heavy',
  over: Partial<FlavorHit> = {},
  text = body,
): FlavorHit {
  return {
    dimension: 'marker-density',
    kind: 'marker',
    level,
    severity: 50,
    excerpt: excerptAt(text, start, length),
    offset: start,
    length,
    paragraphNo: 1,
    reason: 'AI 味标志词「顿了一下」',
    advice: '删掉或换具体动作',
    ...over,
  };
}

describe('A. 命中 → 标注区间', () => {
  it('每条合法命中变成一个区间，端点取 offset/length', () => {
    const at = body.indexOf('她笑了笑');
    const marks = marksFromHits([hit(at, 4)], body);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ start: at, end: at + 4 });
  });

  it('★ 越界与零宽的命中直接丢掉，不画到别处去', () => {
    const marks = marksFromHits(
      [hit(0, 4), hit(body.length - 1, 9), hit(5, 0), hit(-3, 4), hit(body.length + 10, 4)],
      body,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ start: 0, end: 4 });
  });

  it('整段都是空白的命中不画（波浪线画在看不见的字上没有意义）', () => {
    const wsBody = '第一行\n\n   \n第二行';
    expect(marksFromHits([hit(3, 5, 'heavy', {}, wsBody)], wsBody)).toHaveLength(0);
  });

  it('按起点升序返回（镜像层的渲染顺序即区间顺序）', () => {
    const marks = marksFromHits([hit(17, 5), hit(0, 5)], body);
    expect(marks.map((m) => m.start)).toEqual([0, 17]);
  });

  it('tooltip 给「维度名 + 原因」，悬停要能看懂为什么被标', () => {
    const marks = marksFromHits([hit(0, 5, 'heavy', { reason: '标志词密度偏高' })], body);
    expect(marks[0].title).toContain('标志词密度偏高');
    expect(marks[0].level).toBe('heavy');
  });
});

describe('B. ★ 逐字回验：正文改过就不许画', () => {
  it('excerpt 与当前正文同位置重算的结果不一致 → 丢弃这条', () => {
    const drifted = hit(0, 5, 'heavy', { excerpt: '他顿了一下。抬起头看' });
    expect(marksFromHits([drifted], body)).toHaveLength(0);
  });

  it('★ 只在前面插一个回车（去空白字数没变）也能被拦下', () => {
    const original = '他顿了一下。抬起头看她。她笑了笑。他顿了一下。';
    const h = hit(17, 5, 'heavy', {}, original);
    expect(marksFromHits([h], original)).toHaveLength(1);
    // 在第 10 个字前插两个换行：去空白字数不变，但后面的坐标整体右移
    const edited = `${original.slice(0, 10)}\n\n${original.slice(10)}`;
    expect(edited.replace(/\s/g, '').length).toBe(original.replace(/\s/g, '').length);
    expect(marksFromHits([h], edited)).toHaveLength(0);
  });

  it('excerpt 为空（includeExcerpts=false 的老报告）无法逐字回验 → 一条都不画', () => {
    const noEx = hit(0, 5, 'heavy', { excerpt: '' });
    expect(marksFromHits([noEx], body)).toHaveLength(0);
  });

});

describe('C. 重叠区间合并', () => {
  it('★ 相交的两条并成一条，档位取更重的那个', () => {
    const marks = marksFromHits([hit(0, 6, 'mild'), hit(3, 6, 'severe')], body);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ start: 0, end: 9, level: 'severe' });
  });

  it('相接（前一条终点==后一条起点）也合并，避免断续的两段波浪线', () => {
    const marks = marksFromHits([hit(0, 4), hit(4, 5)], body);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ start: 0, end: 9 });
  });

  it('两条互不相干的命中不合并', () => {
    const marks = marksFromHits([hit(0, 4), hit(17, 5)], body);
    expect(marks).toHaveLength(2);
  });

  it('合并后 tooltip 把两条原因都留着（不丢信息）', () => {
    const marks = marksFromHits(
      [hit(0, 6, 'mild', { reason: '句子节奏偏平' }), hit(3, 6, 'severe', { reason: '标志词密集' })],
      body,
    );
    expect(marks[0].title).toContain('句子节奏偏平');
    expect(marks[0].title).toContain('标志词密集');
  });
});

describe('D. 分段（镜像层直接 map 成 span）', () => {
  it('★ 拼回去必须逐字等于原文：少一个字整篇就错位', () => {
    const marks = marksFromHits([hit(3, 7), hit(17, 5)], body);
    expect(segmentsOf(body, marks).map((s) => s.text).join('')).toBe(body);
  });

  it('命中的片段带 mark，未命中的带 null', () => {
    const segs = segmentsOf(body, marksFromHits([hit(0, 5)], body));
    expect(segs[0].mark).not.toBeNull();
    expect(segs.at(-1)?.mark).toBeNull();
  });

  it('合并后的区间只产出一段带 mark 的文本', () => {
    const segs = segmentsOf(body, marksFromHits([hit(0, 4), hit(4, 5)], body));
    expect(segs.filter((s) => s.mark !== null)).toHaveLength(1);
  });

  it('没有标注时只有一段全文', () => {
    expect(segmentsOf(body, [])).toEqual([{ text: body, mark: null }]);
  });

  it('换行必须原样留在文本里（镜像层靠 pre-wrap 排版，压掉换行就全歪）', () => {
    const withNl = '第一段\n\n第二段';
    const segs = segmentsOf(withNl, marksFromHits([hit(0, 3, 'heavy', {}, withNl)], withNl));
    expect(segs.map((s) => s.text).join('')).toBe(withNl);
    expect(segs.some((s) => s.text.includes('\n'))).toBe(true);
  });
});

describe('E. ★ 与真引擎对表（不靠我照抄规则）', () => {
  const novel = [
    '他顿了一下，似乎想到了什么，然后抬起头看着她，眼中闪过一丝复杂的情绪。',
    '然而，事情并没有那么简单。不仅如此，他还意识到，这场风波才刚刚开始。',
    '她沉默了片刻，轻轻叹了口气，嘴角微微上扬，露出一个苦涩的笑容。',
    '空气中弥漫着一种说不出的压抑，仿佛 everything 都失去了颜色。',
  ].join('\n\n');

  it('引擎给出的每条命中都能落到图上（说明回验口径与引擎一致）', () => {
    const report = detectFlavor(novel, '1');
    expect(report.hits.length).toBeGreaterThan(0);
    const marks = marksFromHits(report.hits, novel);
    expect(marks.length).toBeGreaterThan(0);
    // 每条命中的起点都落在某个区间内（合并后允许变少，但不许丢位置）
    for (const h of report.hits) {
      expect(marks.some((m) => m.start <= h.offset && m.end >= h.offset + h.length)).toBe(true);
    }
  });

  it('检测完改了正文 → 漂移的坐标一条都不画', () => {
    const report = detectFlavor(novel, '1');
    const edited = `${novel.slice(0, 8)}她转身走了。\n\n${novel.slice(8)}`;
    expect(marksFromHits(report.hits, edited)).toHaveLength(0);
  });
});
