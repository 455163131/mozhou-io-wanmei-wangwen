/**
 * ★ 引号区间表与逐位扫描的**等价性**测试。
 *
 * `inQuote(text, idx)` 每次调用都从 0 扫到 idx，单次 O(n)；而调用方几乎都在
 * 循环里按位置反复调它（replayer 对每条 edit、phrase 对每个匹配、
 * fix-families / suggestions 同理）→ 整体 O(n²)，且发生在回滚这类
 * 用户等待最敏感的路径上。
 *
 * 优化方案是「一次扫描建区间表 + 二分查询」（O(n + m·log m)）。
 * 而这类优化最大的风险不是慢，是**语义悄悄漂移**——引号判定一旦不一致，
 * 后果是「人物台词被改了」或「该改的没改」，都是用户能直接看错的稿件问题。
 *
 * 所以本文件的做法是：对每一段语料、**每一个偏移**，断言两种实现结果完全相同。
 * 不是抽样，是穷举。
 */
import { describe, it, expect } from 'vitest';
import {
  inQuote,
  buildQuoteRanges,
  inQuoteRanges,
  stripWhitespace,
  countChars,
} from '@shared/util/text-zh';

/** 覆盖各种引号形态的语料。每一段都会做全偏移穷举比对 */
const CORPUS: Array<{ name: string; text: string }> = [
  { name: '空串', text: '' },
  { name: '无引号', text: '他走了很远的路，一句话也没说。' },
  { name: '成对弯引号', text: '他停下。“你来了。”她点点头。' },
  { name: '成对直角引号', text: '他停下。「你来了。」她点点头。' },
  { name: '两种引号混用', text: '“第一句。”他说。「第二句。」她答。' },
  { name: '未闭合（文末）', text: '他停下。“你来了，可是' },
  { name: '未闭合（遇换行截断）', text: '他停下。“你来了\n下一段没有引号。' },
  { name: '多余闭引号', text: '没有开引号。”就这样。' },
  { name: '连续开引号（嵌套）', text: '““双层””结束。' },
  { name: '引号跨多段', text: '“第一段\n第二段\n第三段”收尾。' },
  { name: '引号紧邻', text: '“”「」' },
  { name: '换行重置后重开', text: '“未闭合\n“重新开始的引号。”' },
  { name: '仅换行', text: '\n\n\n' },
  { name: '引号在首字符', text: '“开头的引号，后面是内容。' },
  { name: '引号在末字符', text: '内容在最后。“' },
  {
    name: '长篇混合（含数字与英文）',
    text: [
      '第三章 · 2026 年 10 月',
      '他把那把尺子搁在桌上，一寸不到。',
      '“你确定是这样吗？”她问，声音很轻。',
      '他没有回答。心里想的是另一件事——那件事和 1998 年有关。',
      '「我知道了。」他终于说。',
      '然后两个人都没再开口。',
    ].join('\n'),
  },
];

describe('★ buildQuoteRanges + inQuoteRanges 与 inQuote 逐位等价', () => {
  for (const { name, text } of CORPUS) {
    it(`全偏移穷举：${name}`, () => {
      const q = buildQuoteRanges(text);
      // 穷举 [0, length] —— 含 length 这个「恰好在文末之后」的边界
      for (let i = 0; i <= text.length; i++) {
        const expected = inQuote(text, i);
        const actual = inQuoteRanges(q, i);
        expect(actual, `偏移 ${i}（${JSON.stringify(text.slice(Math.max(0, i - 3), i + 3))}）`).toBe(
          expected,
        );
      }
    });
  }

  it('区间表自身性质：升序、互不重叠、左闭右开', () => {
    for (const { text } of CORPUS) {
      const { ranges } = buildQuoteRanges(text);
      for (let i = 0; i < ranges.length; i++) {
        const [s, e] = ranges[i];
        expect(s, 'start 不得为负').toBeGreaterThanOrEqual(0);
        // end 是「查询偏移」区间的右开界，未闭合时可到 text.length + 1
        expect(e, 'end 不得越界').toBeLessThanOrEqual(text.length + 1);
        expect(e, '区间不得为空').toBeGreaterThan(s);
        if (i > 0) {
          expect(s, '区间必须严格升序且不重叠').toBeGreaterThanOrEqual(ranges[i - 1][1]);
        }
      }
    }
  });

  it('★ 区间语义：start 在开引号之后，end 在闭引号之后一位', () => {
    const text = '前“内容”后';
    const q = buildQuoteRanges(text);
    expect(q.ranges).toHaveLength(1);
    const [s, e] = q.ranges[0];
    const open = text.indexOf('“');
    const close = text.indexOf('”');
    expect(s).toBe(open + 1); // idx 必须严格大于开引号位置
    expect(e).toBe(close + 1); // idx === 闭引号位置时 inQuote 仍为 true（它扫的是 [0,idx)）
    // 想取「引号内的文字」要 slice(start, end - 1)
    expect(text.slice(s, e - 1)).toBe('内容');
    // 闭引号本身：inQuote 判 true（还没扫到闭合），闭引号之后一位判 false
    expect(inQuoteRanges(q, close)).toBe(true);
    expect(inQuote(text, close)).toBe(true);
    expect(inQuoteRanges(q, close + 1)).toBe(false);
    expect(inQuote(text, close + 1)).toBe(false);
    // 开引号本身：两者都判 false
    expect(inQuoteRanges(q, open)).toBe(false);
    expect(inQuote(text, open)).toBe(false);
  });

  it('★ 换行截断未闭合引号（引号不跨段，与原型口径一致）', () => {
    const text = '“未闭合的内容\n第二段是干净的';
    const q = buildQuoteRanges(text);
    expect(q.ranges).toHaveLength(1);
    const nl = text.indexOf('\n');
    expect(q.ranges[0][1]).toBe(nl + 1); // idx === 换行处仍算引号内，之后一位就不算了
    expect(inQuoteRanges(q, nl)).toBe(true);
    expect(inQuoteRanges(q, nl + 1)).toBe(false); // 第二段不受影响
  });

  it('大文本下二分查询仍与线性扫描一致（防止只在短样本上碰巧相等）', () => {
    const unit = '他说“这句话在引号里”，然后继续走。';
    const text = unit.repeat(2000); // 约 3.4 万字
    const q = buildQuoteRanges(text);
    expect(q.ranges.length).toBe(2000);
    // 在若干代表性偏移上逐一比对（全量穷举 3.4 万次线性扫描太慢，故取样）
    const probes = [
      0,
      1,
      2,
      text.indexOf('“'),
      text.indexOf('“') + 1,
      text.indexOf('”'),
      text.indexOf('”') + 1,
      Math.floor(text.length / 2),
      Math.floor(text.length / 2) + 1,
      text.length - 1,
      text.length,
    ];
    for (const i of probes) {
      expect(inQuoteRanges(q, i), `偏移 ${i}`).toBe(inQuote(text, i));
    }
  });

  it('负偏移与越界偏移不抛异常', () => {
    const q = buildQuoteRanges('“内容”');
    expect(() => inQuoteRanges(q, -1)).not.toThrow();
    expect(() => inQuoteRanges(q, 10_000)).not.toThrow();
    expect(inQuoteRanges(q, 10_000)).toBe(false);
  });
});

describe('text-zh 其它纯函数的既有口径不被破坏', () => {
  it('stripWhitespace 去掉所有空白（与 Python re.sub(r"\\s","") 同口径）', () => {
    expect(stripWhitespace(' 他 走 了\n\t。 ')).toBe('他走了。');
    expect(stripWhitespace('')).toBe('');
  });

  it('countChars 是去空白后的长度', () => {
    expect(countChars('他 走 了\n')).toBe(3);
    expect(countChars('   ')).toBe(0);
  });
});
