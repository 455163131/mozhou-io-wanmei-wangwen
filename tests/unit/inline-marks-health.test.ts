/**
 * §4 第 20 条② —— 体检命中画到正文上（渲染层映射）。
 *
 * 第 7 条那条红线在这里一字不动地复用：**核心不是"画得出"，而是"什么时候不许画"**。
 * 体检这条链的 `at` 是第 11、12 条修准的，但它同样是"检测那一刻"的坐标——
 * 自动保存与手改都会让它漂，所以每条命中落图前按同一个 excerpt 口径重算逐字回验。
 *
 * 与 AI 味那份的三处不同，都在本文件钉住：
 *   1. 输入没有 `length` 就没有区间——`length === 0` 是生产端在明说"这条指标定位不了"
 *      （TTR 那类全书统计），必须跳过，不能猜一个长度；
 *   2. 两个来源的区间会重叠（段落级命中天然盖住句子里的标志词），合并后
 *      **以更细的 AI 味档位着色**，否则整段被统计命中涂掉，真正要改的词就看不见了；
 *   3. 原因文案带上判定行的 label/value/unit，作者才知道"这段为什么被标"。
 */
import { describe, it, expect } from 'vitest';
import {
  marksFromHits,
  marksFromLocations,
  mergeMarks,
  segmentsOf,
  type InlineMark,
} from '@renderer/components/editor/inline-marks';
import { locateChapterIssues, type ReadOnlyDeps } from '@main/tools/impl/analyze';
import { excerptAround } from '@shared/util/text-zh';
import { detectFlavor } from '@shared/ai-flavor/engine';
import type { LocatedIssue } from '@shared/types/health';
import type { ToolContext } from '@shared/types/tool';

const CTX: ToolContext = {
  runId: 'test',
  stepNo: 1,
  dryRun: true,
  requireCheckpoint: async () => '',
  signal: new AbortController().signal,
  logger: () => {},
};

const body = '他顿了一下。她抬起头看他很久没有说话的那句话被风吹散了。\n\n第三段。';

/** 造一条生产端形状的命中：默认 excerpt 按当前正文算，所以默认"可画" */
function loc(over: Partial<LocatedIssue> = {}, text = body): LocatedIssue {
  const at = over.at ?? text.indexOf('顿了一下');
  const length = over.length ?? '顿了一下'.length;
  const base: LocatedIssue = {
    metric: 'avgPara',
    label: '段落均长',
    level: 'warn',
    value: 15.5,
    unit: '字',
    band: [1, 5],
    at,
    length,
    excerpt: length > 0 ? excerptAround(text, at, length) : '',
    note: '段落长度影响段落级指标',
  };
  // over 放最后：显式给了 excerpt/level 就以它为准
  return { ...base, ...over };
}

describe('A. 合法命中 → 区间', () => {
  it('start/end 取 at/length，档位沿用判定行', () => {
    const marks = marksFromLocations([loc()], body);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      start: body.indexOf('顿了一下'),
      end: body.indexOf('顿了一下') + 4,
      level: 'warn',
    });
  });

  it('原因文案给「体检｜指标名 + 值 + 单位」和定位说明', () => {
    const marks = marksFromLocations([loc()], body);
    expect(marks[0].title).toContain('体检');
    expect(marks[0].title).toContain('段落均长');
    expect(marks[0].title).toContain('15.5');
    expect(marks[0].title).toContain('段落长度影响段落级指标');
  });
});

describe('B. ★ 不许画的那几种', () => {
  it('正文改过 → excerpt 对不上 → 一条都不画', () => {
    const h = loc();
    const edited = `${body.slice(0, 5)}她转身走了。\n\n${body.slice(5)}`;
    expect(marksFromLocations([h], edited)).toHaveLength(0);
  });

  it('只在前面插一个回车（去空白字数没变）也拦得下', () => {
    const original = '他顿了一下。她抬头。';
    const h = loc({ at: 0, length: 4 }, original);
    expect(marksFromLocations([h], original)).toHaveLength(1);
    const edited = `\n${original}`;
    expect(edited.replace(/\s/g, '').length).toBe(original.length);
    expect(marksFromLocations([h], edited)).toHaveLength(0);
  });

  it('length=0（该指标定位不了）不画，也不许猜一个长度', () => {
    expect(marksFromLocations([loc({ length: 0, at: 0 })], body)).toHaveLength(0);
  });

  it('excerpt 为空 / 越界 / 非整数 / 全空白，一律丢掉', () => {
    expect(marksFromLocations([loc({ excerpt: '' })], body)).toHaveLength(0);
    expect(marksFromLocations([loc({ at: body.length - 1, length: 9 })], body)).toHaveLength(0);
    expect(marksFromLocations([loc({ at: -3 })], body)).toHaveLength(0);
    expect(marksFromLocations([loc({ at: 1.5 })], body)).toHaveLength(0);
    const ws = '第一段\n   \n第二段';
    expect(marksFromLocations([loc({ at: 4, length: 3 }, ws)], ws)).toHaveLength(0);
  });

  it('at/length 落在正文里但逐字对不上 excerpt → 丢（excerpt 才是凭据）', () => {
    // 构造"区间合法、excerpt 是旧稿"的命中：坐标没越界，所以只能靠回验拦
    const stale = { ...loc(), excerpt: '……不是这段……' };
    expect(marksFromLocations([stale], body)).toHaveLength(0);
  });
});

describe('C. ★ 两个来源叠在一起时的着色权', () => {
  const fine = '他顿了一下，然后抬起头看她，眼中闪过一丝复杂的情绪。';

  /** 取一条真引擎给出的命中（不手改 offset，否则 excerpt 就对不上了） */
  function realFlavorMark(): InlineMark {
    const report = detectFlavor(fine, '1');
    expect(report.hits.length, '这段该有 AI 味命中').toBeGreaterThan(0);
    const marks = marksFromHits(report.hits, fine);
    expect(marks.length).toBeGreaterThan(0);
    return marks[0];
  }

  it('AI 味区间与体检区间重叠 → 并成一条，档位取 AI 味那一边', () => {
    const flavorMark = realFlavorMark();
    // 段落级体检命中天然盖住整行，包括句子里的 AI 味标志词
    const healthMark = marksFromLocations([loc({ at: 0, length: fine.length }, fine)], fine);
    expect(healthMark[0].level).toBe('warn');
    const merged = mergeMarks([flavorMark, ...healthMark]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ start: 0, end: fine.length });
    expect(
      merged[0].level,
      '粗粒度的统计命中不该把 AI 味命中涂成自己的颜色',
    ).toBe(flavorMark.level);
  });

  it('合并后两边的原因都留着', () => {
    const flavorMark = realFlavorMark();
    const healthMark = marksFromLocations([loc({ at: 0, length: fine.length }, fine)], fine);
    const merged = mergeMarks([flavorMark, ...healthMark]);
    expect(merged[0].title).toContain('体检');
    expect(merged[0].title).toContain(flavorMark.title);
  });

  it('体检自己的两条重叠命中也合并（同一段被两个指标各报一次只画一条线）', () => {
    const marks = marksFromLocations(
      [
        loc({ metric: 'avgPara', at: 0, length: 12 }, body),
        loc({ metric: 'sentsPerPara', at: 0, length: 8 }, body),
      ],
      body,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].end).toBe(12);
  });

  it('risk 比 warn 重（两条统计命中重叠时取更重的档位）', () => {
    const marks = marksFromLocations(
      [loc({ level: 'warn', at: 0, length: 8 }, body), loc({ level: 'risk', at: 2, length: 8 }, body)],
      body,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].level).toBe('risk');
  });
});

describe('D. ★ 与真生产端对表（不靠我照抄形状）', () => {
  const LONG = '这一段的字数被刻意拉长到足以让段落均长越过基线上限很多很多。';
  const novel = `他顿了一下。\n\n${LONG}`;
  const deps: ReadOnlyDeps = {
    getBodies: async () => new Map([['c1', novel]]),
    chapterTitle: () => '第一章',
    allChapterIds: async () => ['c1'],
    baseline: () => ({
      source: 'test',
      metrics: {
        avgPara: {
          label: '段落均长',
          unit: '字',
          p05: 1,
          p25: 1,
          p50: 3,
          p75: 5,
          p95: 5,
          mean: 3,
          dir: 'both' as const,
        },
      },
      markerDensity: { '顿/停了一下': { p50: 0, p95: 0 } },
    }),
  };

  it('生产端给出的每条有位置的命中都能落到图上', async () => {
    const res = await locateChapterIssues({ chapterId: 'c1' }, CTX, deps);
    expect(res.ok).toBe(true);
    const issues = res.data?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    const marks = marksFromLocations(issues, novel);
    expect(marks.length).toBeGreaterThan(0);
    for (const l of issues) {
      if (l.length === 0) continue;
      expect(
        marks.some((m) => m.start <= l.at && m.end >= l.at + l.length),
        `${l.metric}@${l.at} 没画出来`,
      ).toBe(true);
    }
  });

  it('定位完又改了正文 → 漂移的坐标一条都不画', async () => {
    const res = await locateChapterIssues({ chapterId: 'c1' }, CTX, deps);
    const issues = res.data?.issues ?? [];
    const edited = `${novel.slice(0, 3)}她转身走了。\n\n${novel.slice(3)}`;
    expect(marksFromLocations(issues, edited)).toHaveLength(0);
  });

  it('拼回正文必须逐字相等（镜像层少一个字整篇就错位）', async () => {
    const res = await locateChapterIssues({ chapterId: 'c1' }, CTX, deps);
    const marks = marksFromLocations(res.data?.issues ?? [], novel);
    expect(segmentsOf(novel, marks).map((s) => s.text).join('')).toBe(novel);
  });
});
