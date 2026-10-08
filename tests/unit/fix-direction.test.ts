/**
 * ★ 规则引擎的「偏离方向」测试。
 *
 * 为什么单独开一个文件：
 *
 *   修复前 `fixContext()` 把 `low` 与 `high` 都赋成了 `a.raw`（指标**实测值**），
 *   而 `deviation()` 只返回幅度、不返回方向。于是 F7~F10 四条自动规则的判据全部退化：
 *
 *     · F7 `ctx.low.avgSent ? 合并短句 : 切分长句`
 *       —— 实测句长恒非零，所以**永远走「合并短句」**。长句章不但没被切分，
 *          反而被继续合并，越改越糟。
 *     · F8 `!!devs.sentCv && !!low.sentCv`（长短交错）
 *       —— `!!low.sentCv` 退化成「sentCv 非零即真」。节奏**已经够乱**（sentCv 偏高）
 *          时仍去做「长短交错」，把节奏推得更乱。
 *     · F9 `!!devs.sentsPerPara && !!low.sentsPerPara`（段落合并）
 *       —— 同理，段落**已经过长**时仍去合并。
 *     · F10 `!!devs.avgPara && !!high.avgPara`（长段切分）
 *       —— 段落**本就偏短**时仍去切分，越切越碎。
 *
 *   即：四条规则在朝**错误方向**改写用户正文。这比不改更糟——用户看到
 *   「AI 帮我优化了」，实际文稿被推向更差的方向，而且改动是可落盘的。
 *
 * 本文件分两层测：
 *   A. `fixContext()` 从真实文本算出的 low/high **方向正确**；
 *   B. F7~F10 的 `applies`/`fix` 分支在给定方向下**选对了动作**。
 * 两层分开，才能在出错时立刻定位是「方向算错」还是「分支用错」。
 */
import { describe, it, expect } from 'vitest';
import { fixContext, type BaselineLike } from '@main/rule-engine/plan-fixes';
import { ruleById, type FixContext } from '@main/rule-engine/fix-rules';
import {
  fixMergeShortSentences,
  fixSplitLongSentences,
  fixMergeParas,
  fixSplitLongParas,
  fixRhythmSpread,
} from '@main/rule-engine/fix-families';
import { MARKER_KEYS } from '@shared/metrics-engine';
import type { MetricSpec } from '@shared/types/project';

/** 造一个区间明确的指标规格：p05=10、p95=20，中位 15 */
function spec(label: string, lo = 10, hi = 20): MetricSpec {
  return {
    label,
    unit: '',
    p05: lo,
    p25: lo + 2,
    p50: (lo + hi) / 2,
    p75: hi - 2,
    p95: hi,
    mean: (lo + hi) / 2,
    dir: 'both',
  };
}

/**
 * 受控基线：把参与判据的四个指标都设成 p05=10 / p95=20。
 * 这样「造一段句长≈5 的文本」必然偏低、「句长≈40」必然偏高，方向不含糊。
 */
function makeBaseline(): BaselineLike {
  const metrics: Record<string, MetricSpec> = {};
  for (const k of [
    'avgSent',
    'sentCv',
    'sentsPerPara',
    'avgPara',
    'ttr',
    'bigramTtr',
    'triRepeat',
    'dialogRatio',
    'chars',
    'paras',
    'sents',
    'openType',
  ]) {
    metrics[k] = spec(k);
  }
  const markerDensity: Record<string, { p50: number; p95: number }> = {};
  for (const k of MARKER_KEYS) markerDensity[k] = { p50: 1, p95: 5 };
  return { source: 'test', metrics, markerDensity };
}

const BL = makeBaseline();

/** 句长偏短：全是 2~4 字的短句 */
const SHORT_SENTENCES = Array(40).fill('他走了。').join('');
/** 句长偏长：一逗到底的超长句 */
const LONG_SENTENCES = Array(6)
  .fill('他走了很远很远的路，一路上想了很多事情，那些事情彼此纠缠在一起，谁也说不清到底该从哪一件开始想起，于是只好继续往前走。')
  .join('');

describe('A. fixContext 的方向计算', () => {
  it('★ 句长偏短时：low.avgSent > 0 且 high.avgSent === 0', () => {
    const ctx = fixContext(SHORT_SENTENCES, BL);
    expect(ctx.devs.avgSent).toBeGreaterThan(0);
    expect(ctx.low.avgSent).toBeGreaterThan(0);
    expect(ctx.high.avgSent).toBe(0);
  });

  it('★ 句长偏长时：high.avgSent > 0 且 low.avgSent === 0', () => {
    const ctx = fixContext(LONG_SENTENCES, BL);
    expect(ctx.devs.avgSent).toBeGreaterThan(0);
    expect(ctx.high.avgSent).toBeGreaterThan(0);
    expect(ctx.low.avgSent).toBe(0);
  });

  it('达标时 low/high/devs 三者全为 0（不会平白触发改写）', () => {
    // 造一段 avgSent 落在 [10,20] 的文本：每句约 15 字
    const inBand = Array(20)
      .fill('他走了很远的路，心里想着事。')
      .join('');
    const ctx = fixContext(inBand, BL);
    expect(ctx.devs.avgSent).toBe(0);
    expect(ctx.low.avgSent).toBe(0);
    expect(ctx.high.avgSent).toBe(0);
  });

  it('★ low 与 high 不可能同时非零（方向互斥）', () => {
    for (const text of [SHORT_SENTENCES, LONG_SENTENCES]) {
      const ctx = fixContext(text, BL);
      for (const key of Object.keys(ctx.devs)) {
        const both = ctx.low[key] > 0 && ctx.high[key] > 0;
        expect(both, `${key} 的 low 与 high 同时非零`).toBe(false);
      }
    }
  });

  it('★ low/high 非零时，devs 必须同值（幅度一致，只是方向不同）', () => {
    const ctx = fixContext(SHORT_SENTENCES, BL);
    for (const key of Object.keys(ctx.devs)) {
      if (ctx.low[key] > 0) expect(ctx.low[key]).toBe(ctx.devs[key]);
      if (ctx.high[key] > 0) expect(ctx.high[key]).toBe(ctx.devs[key]);
    }
  });

  it('devs 为 0 的指标，low/high 必须都是 0（达标就不该有方向）', () => {
    const ctx = fixContext(SHORT_SENTENCES, BL);
    for (const key of Object.keys(ctx.devs)) {
      if (ctx.devs[key] === 0) {
        expect(ctx.low[key], `${key}.low`).toBe(0);
        expect(ctx.high[key], `${key}.high`).toBe(0);
      }
    }
  });

  it('★ marker 型指标「越低越好」：只可能进 high，永不进 low', () => {
    // 造一段叠词密集的文本，把 marker 密度顶上去
    const markerHeavy = Array(30).fill('他一步一步地走，一眼一眼地看。').join('');
    const ctx = fixContext(markerHeavy, BL);
    for (const k of MARKER_KEYS) {
      const key = `marker:${k}`;
      expect(ctx.low[key], `${key} 不该被判为偏低`).toBe(0);
    }
  });

  it('修复前的形态（low === high === a）不再出现', () => {
    const ctx = fixContext(SHORT_SENTENCES, BL);
    // a 是实测值，几乎必然非零；low/high 只在偏离时才非零。
    // 若三者仍是同一个对象，这条断言会失败。
    expect(ctx.low).not.toBe(ctx.a);
    expect(ctx.high).not.toBe(ctx.a);
    expect(ctx.low).not.toBe(ctx.high);
    expect(ctx.low.avgSent).not.toBe(ctx.a.avgSent);
  });
});

describe('B. F7~F10 在给定方向下选对动作', () => {
  /** 直接构造 FixContext，把「方向算得对不对」与「分支用得对不对」隔离开 */
  function ctxWith(patch: Partial<FixContext>): FixContext {
    const zeros: Record<string, number> = {};
    return {
      a: { ...zeros },
      devs: { ...zeros },
      low: { ...zeros },
      high: { ...zeros },
      per1000: { ...zeros },
      ...patch,
    };
  }

  it('★ F7：句长偏短 → 走「合并短句」', () => {
    const f7 = ruleById('F7')!;
    const ctx = ctxWith({
      devs: { avgSent: 0.8 },
      low: { avgSent: 0.8 },
    });
    expect(f7.applies!(LONG_SENTENCES, ctx)).toBe(true);
    const out = f7.fix!(LONG_SENTENCES, ctx);
    expect(out.text).toBe(fixMergeShortSentences(LONG_SENTENCES).text);
  });

  it('★ F7：句长偏长 → 走「切分长句」（修复前这条永远走不到）', () => {
    const f7 = ruleById('F7')!;
    const ctx = ctxWith({
      devs: { avgSent: 0.8 },
      high: { avgSent: 0.8 },
    });
    expect(f7.applies!(LONG_SENTENCES, ctx)).toBe(true);
    const out = f7.fix!(LONG_SENTENCES, ctx);
    expect(out.text).toBe(fixSplitLongSentences(LONG_SENTENCES).text);
  });

  it('★ F8 长短交错：只在 sentCv 偏**低**（节奏太均匀）时出手', () => {
    const f8 = ruleById('F8')!;
    const lowCtx = ctxWith({ devs: { sentCv: 0.5 }, low: { sentCv: 0.5 } });
    const highCtx = ctxWith({ devs: { sentCv: 0.5 }, high: { sentCv: 0.5 } });

    expect(f8.applies!('', lowCtx)).toBe(true);
    // 节奏已经够乱时再去做「长短交错」= 把它推得更乱，必须不出手
    expect(f8.applies!('', highCtx)).toBe(false);
    expect(f8.fix!('abc', lowCtx).text).toBe(fixRhythmSpread('abc').text);
  });

  it('★ F9 段落合并：只在 sentsPerPara 偏**低**（段落太碎）时出手', () => {
    const f9 = ruleById('F9')!;
    const lowCtx = ctxWith({ devs: { sentsPerPara: 0.5 }, low: { sentsPerPara: 0.5 } });
    const highCtx = ctxWith({ devs: { sentsPerPara: 0.5 }, high: { sentsPerPara: 0.5 } });

    expect(f9.applies!('', lowCtx)).toBe(true);
    // 段落已经过长时再去合并 = 越合越长，必须不出手
    expect(f9.applies!('', highCtx)).toBe(false);
  });

  it('★ F10 长段切分：只在 avgPara 偏**高**（段落太长）时出手', () => {
    const f10 = ruleById('F10')!;
    const highCtx = ctxWith({ devs: { avgPara: 0.5 }, high: { avgPara: 0.5 } });
    const lowCtx = ctxWith({ devs: { avgPara: 0.5 }, low: { avgPara: 0.5 } });

    expect(f10.applies!('', highCtx)).toBe(true);
    // 段落本就偏短时再去切分 = 越切越碎，必须不出手
    expect(f10.applies!('', lowCtx)).toBe(false);
  });

  it('四条规则在「达标」（devs 全 0）时一律不出手', () => {
    const ctx = ctxWith({});
    for (const id of ['F7', 'F8', 'F9', 'F10']) {
      const rule = ruleById(id)!;
      expect(rule.applies!('', ctx), `${id} 不该在达标时出手`).toBe(false);
    }
  });

  it('F9/F10 的动作与方向匹配（合并 vs 切分不能弄反）', () => {
    const para = '第一句话。第二句话。第三句话。';
    const text = Array(6).fill(para).join('\n\n');
    const f9 = ruleById('F9')!;
    const f10 = ruleById('F10')!;
    expect(f9.fix!(text, ctxWith({ low: { sentsPerPara: 1 } })).text).toBe(
      fixMergeParas(text).text,
    );
    expect(f10.fix!(text, ctxWith({ high: { avgPara: 1 } })).text).toBe(
      fixSplitLongParas(text).text,
    );
  });
});
