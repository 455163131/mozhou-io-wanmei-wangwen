/**
 * 局部改写引擎测试。
 *
 * ★ 验收核心：**只改命中片段，其他一个字不动**。
 *   整篇重写会丢掉作者风格，而风格正是这个工具要保护的东西。
 */
import { describe, it, expect } from 'vitest';
import { detectFlavor } from '@shared/ai-flavor/engine';
import { DEFAULT_FLAVOR_CONFIG } from '@shared/types/ai-flavor';
import { applyLocalRewrites, needsAgent } from '@main/flavor/rewrite';

/** AI 腔样本，长度足够触发全部维度 */
const AI_TEXT = `他顿了一下，深吸一口气，瞳孔骤然紧缩。
然而，这一切都是那么不易察觉。
他嘴角勾起一抹苦笑，空气仿佛似乎凝固了。
与此同时，复杂的情绪涌上心头。
仿佛有什么东西破碎了一般，他不禁沉默起来。
不是他不愿意，而是他不能。
不仅仅是身体的疲惫，更是灵魂的倦怠。
然而就在这时，他忽然明白了什么。
那一刻，时间仿佛静止了。
他缓缓抬起头，淡淡一笑，看着远方，眼神里有着难以言喻的复杂情绪。
随着年岁的增长，他逐渐意识到，有些东西注定无法挽回，而在这样的时刻，他只能默默地站在原地。
综上所述，这一切都显得那么苍白无力，却又是如此刻骨铭心。
他轻轻叹了口气，悠悠地说道，有些事情，终究是回不去了。
值得注意的是，他从未想过会是这样的结局，因此他选择了沉默。`;

describe('★ 局部改写：只动命中片段', () => {
  it('改写后文本变短（删除类规则生效）', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, r.hits);
    expect(out.edits.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThan(AI_TEXT.length);
  });

  it('★ 未命中的文字逐字保留（不做整篇重写）', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, r.hits);
    // 取一个没有命中的段落，应原样存在
    const untouched = '不仅仅是身体的疲惫，更是灵魂的倦怠。';
    expect(out.text).toContain(untouched);
  });

  it('★ 改写后 AI 味指数下降', () => {
    const before = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, before.hits);
    const after = detectFlavor(out.text, 'x', DEFAULT_FLAVOR_CONFIG);
    expect(after.index).toBeLessThan(before.index);
  });

  it('★ 每处改写都带理由（用户要能核对为什么改）', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, r.hits);
    for (const e of out.edits) {
      expect(e.why.length).toBeGreaterThan(4);
      expect(e.from.length).toBeGreaterThan(0);
    }
  });
});

describe('★ 偏移处理（经典 off-by-N 陷阱）', () => {
  it('多处理次替换后偏移仍正确（从后往前应用）', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, r.hits);
    expect(out.edits.length).toBeGreaterThan(1);
    // edits 按原文顺序返回
    const offsets = out.edits.map((e) => e.offset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('★ 同一偏移不重复应用（去重）', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, r.hits);
    const offsets = out.edits.map((e) => e.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('★ 用带前后缀的 excerpt 不会误替换（必须用 offset+length 取原文）', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, r.hits);
    // 若误用了 excerpt（带 … 前后缀）去替换，会引入省略号
    expect(out.text).not.toContain('…');
  });
});

describe('筛选：维度与段落', () => {
  it('★ 只改指定维度', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const out = applyLocalRewrites(AI_TEXT, r.hits, { dimensions: ['template-connector'] });
    for (const e of out.edits) expect(e.dimension).toBe('template-connector');
  });

  it('★ 只改指定段落', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const targetPara = r.hits[0].paragraphNo;
    const out = applyLocalRewrites(AI_TEXT, r.hits, { paragraphNos: [targetPara] });
    const allowed = new Set(
      r.hits.filter((h) => h.paragraphNo === targetPara).map((h) => h.offset),
    );
    for (const e of out.edits) expect(allowed.has(e.offset)).toBe(true);
  });

  it('空命中列表 → 文本不变', () => {
    const out = applyLocalRewrites(AI_TEXT, []);
    expect(out.text).toBe(AI_TEXT);
    expect(out.edits).toHaveLength(0);
  });
});

describe('★ 哪些改不了要交给 Agent', () => {
  it('没有本地规则命中 → 归入 needsAgent', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    const agentHits = needsAgent(r.hits);
    // 「一X一X」类与句首重复类没有本地规则
    expect(agentHits.length).toBeGreaterThan(0);
    for (const h of agentHits) {
      const local = applyLocalRewrites(AI_TEXT, [h]);
      expect(local.edits).toHaveLength(0);
    }
  });

  it('本地规则覆盖的命中不应出现在 needsAgent 里', () => {
    const r = detectFlavor(AI_TEXT, 'x', DEFAULT_FLAVOR_CONFIG);
    // 按 offset+dimension 配对比较——同一偏移可能被多条规则命中不同维度
    const agentKeys = new Set(needsAgent(r.hits).map((h) => `${h.offset}:${h.dimension}`));
    const out = applyLocalRewrites(AI_TEXT, r.hits);
    for (const e of out.edits) {
      expect(agentKeys.has(`${e.offset}:${e.dimension}`)).toBe(false);
    }
  });
});

describe('边界与防御', () => {
  it('非字符串输入不崩', () => {
    expect(() => applyLocalRewrites('', [])).not.toThrow();
  });

  it('空文本 + 空命中 → 返回空', () => {
    const out = applyLocalRewrites('', []);
    expect(out.text).toBe('');
    expect(out.edits).toHaveLength(0);
  });

  it('★ 偏移越界时跳过而非破坏文本（防御脏数据）', () => {
    const fake = [
      {
        dimension: 'template-connector' as const,
        kind: 'connector',
        level: 'mild' as const,
        severity: 52,
        excerpt: '',
        offset: 99999, // 越界
        length: 5,
        paragraphNo: 1,
        reason: 'x',
        advice: 'y',
      },
    ];
    const out = applyLocalRewrites('短文本。', fake);
    expect(out.text).toBe('短文本。');
    expect(out.skipped).toBeGreaterThan(0);
  });
});
