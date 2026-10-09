/**
 * §4 第 20 条② —— 体检命中的**可画坐标**（生产端）。
 *
 * 第 7 条给 AI 味命中画了行内波浪线，靠的是 `FlavorHit` 自带 `offset + length + excerpt`
 * 三件套：映射层按 excerpt 口径在当前位置重算一遍，逐字不一致就不画（第 11、12 条把
 * `locate_issues` 的 `at` 修准之后，体检这条链的坐标本身已经是可信的了）。
 *
 * ★ 缺口不在 `at`，在**没有 end**：`IssueLocation` 只有 `at` 与一段
 *   `snippetAround(body, at, radius)` 的短引文，radius 按分支分别是 14/18/20，
 *   既反推不出命中有多长，也没法在改动过的正文里逐字回验。所以本条先在生产端补
 *   `length` + `excerpt`（与 AI 味同一个 pad=12 口径），渲染层才有"不许画"的依据。
 *
 * 另外钉住两条边界，都是"看起来能画其实不该画"：
 *   · 统计型指标（TTR 那一类）本来就没有位置，`length` 必须是 0；
 *   · 给 Agent 的 `locate_issues` 载荷不许跟着长胖——多带的字段会原样进提示词。
 */
import { describe, it, expect } from 'vitest';
import {
  locateChapterIssues,
  locateIssues,
  type ReadOnlyDeps,
} from '@main/tools/impl/analyze';
import { excerptAround } from '@shared/util/text-zh';
import type { ToolContext } from '@shared/types/tool';

const CTX: ToolContext = {
  runId: 'test',
  stepNo: 1,
  dryRun: true,
  requireCheckpoint: async () => '',
  signal: new AbortController().signal,
  logger: () => {},
};

/** dir=both 的判定行：值落在 [p05,p95] 内即 ok */
function spec(label: string, unit: string, p05: number, p95: number) {
  const mid = (p05 + p95) / 2;
  return { label, unit, p05, p25: p05, p50: mid, p75: p95, p95, mean: mid, dir: 'both' as const };
}

const LONG = '这一段的字数被刻意拉长到足以让段落均长越过基线上限很多很多。';
const body = `他顿了一下。\n\n${LONG}`;

/** 让「段落均长」「用字多样性」「顿/停了一下」判成偏差，句均长留在健康区间 */
const DEPS: ReadOnlyDeps = {
  getBodies: async () => new Map([['c1', body]]),
  chapterTitle: () => '第一章',
  allChapterIds: async () => ['c1'],
  baseline: () => ({
    source: 'test',
    metrics: {
      avgPara: spec('段落均长', '字', 1, 5),
      avgSent: spec('句均长', '字', 1, 400),
      ttr: spec('用字多样性', '', 998, 999),
    },
    markerDensity: { '顿/停了一下': { p50: 0, p95: 0 } },
  }),
};

async function runAll(deps: ReadOnlyDeps = DEPS) {
  const res = await locateChapterIssues({ chapterId: 'c1' }, CTX, deps);
  expect(res.ok, `locateChapterIssues 失败：${res.error?.message}`).toBe(true);
  return res.data?.issues ?? [];
}

describe('A. 每条命中都带得上「逐字回验」的三件套', () => {
  it('★ excerpt 必须能用 excerptAround(body, at, length) 原样重算出来', async () => {
    const issues = await runAll();
    expect(issues.length).toBeGreaterThan(0);
    for (const loc of issues) {
      // 没有位置的命中也不许给回验凭据，否则渲染层会以为"能画"
      if (loc.length === 0) expect(loc.excerpt, `${loc.metric} 零宽却有 excerpt`).toBe('');
      else
        expect(
          loc.excerpt,
          `${loc.metric}@${loc.at} 的 excerpt 与 (at,length) 不自洽`,
        ).toBe(excerptAround(body, loc.at, loc.length));
    }
  });

  it('标记类命中：at/length 恰好框住标志词本身', async () => {
    const issues = await runAll();
    const marker = issues.filter((x) => x.metric === 'marker:顿/停了一下');
    expect(marker).toHaveLength(1);
    expect(body.slice(marker[0].at, marker[0].at + marker[0].length)).toBe('顿了一下');
  });

  it('段落类命中：at/length 恰好框住那一段，不把段间换行卷进来', async () => {
    const issues = await runAll();
    const para = issues.filter((x) => x.metric === 'avgPara');
    expect(para.length).toBeGreaterThan(0);
    let drawn = 0;
    for (const p of para) {
      if (p.length === 0) continue; // 空段落也在 top-3 里，但它画不出线
      drawn++;
      const span = body.slice(p.at, p.at + p.length);
      expect(span.includes('\n'), `段落命中里混进了换行：${JSON.stringify(span)}`).toBe(false);
      expect(['他顿了一下。', LONG]).toContain(span);
    }
    expect(drawn).toBeGreaterThan(0);
  });

  it('每条命中都带上判定行的 label/value/unit/band/level（渲染层要写成一句人话）', async () => {
    const issues = await runAll();
    for (const loc of issues) {
      expect(loc.label.length, `${loc.metric} 缺 label`).toBeGreaterThan(0);
      expect(typeof loc.value).toBe('number');
      expect(typeof loc.unit).toBe('string');
      expect(loc.band).toHaveLength(2);
      expect(loc.level, `${loc.metric} 不该是达标项`).not.toBe('ok');
      expect(loc.note.length, `${loc.metric} 缺 note`).toBeGreaterThan(0);
    }
  });

  it('★ 落在健康区间的指标一条都不产出（不许把达标项画上线）', async () => {
    const issues = await runAll();
    expect(issues.some((x) => x.metric === 'avgSent')).toBe(false);
  });
});

describe('B. 统计型指标没有位置，必须明说「不许画」', () => {
  it('ttr 这类兜底分支：length=0 且 excerpt 为空', async () => {
    const issues = await runAll();
    const ttr = issues.filter((x) => x.metric === 'ttr');
    expect(ttr).toHaveLength(1);
    expect(ttr[0].length).toBe(0);
    expect(ttr[0].excerpt).toBe('');
  });
});

describe('C. 第 11、12 条修好的偏移口径不许被这次改动弄坏', () => {
  const DUP = '这是一段在两处重复出现的长段落。';
  const MID = '中间这段更长一些，用来把第二次出现的位置往后推得足够远。';

  it('重复段落的两条命中落在各自的真实起点，不是都指第一次', async () => {
    const paraBody = ['开场短段', DUP, MID, DUP].join('\n');
    const deps: ReadOnlyDeps = {
      getBodies: async () => new Map([['c1', paraBody]]),
      chapterTitle: () => '第一章',
      allChapterIds: async () => ['c1'],
      baseline: () => ({
        source: 'test',
        metrics: {
          avgPara: spec('段落均长', '字', 1, 5),
          avgSent: spec('句均长', '字', 1, 400),
        },
        markerDensity: {},
      }),
    };
    const ats = (await runAll(deps))
      .filter((x) => x.metric === 'avgPara' && paraBody.slice(x.at, x.at + x.length) === DUP)
      .map((x) => x.at);
    expect(ats).toHaveLength(2);
    expect(new Set(ats).size, `偏移重复：${ats.join(',')}`).toBe(2);
    expect(ats.sort((a, b) => a - b)).toEqual([paraBody.indexOf(DUP), paraBody.lastIndexOf(DUP)]);
  });

  it('重复句子的两条命中同样互不相同', async () => {
    // 全部句子挤在同一段：段内重复才会暴露 indexOf 的老毛病（第 12 条）
    const sentBody = `短句。${DUP}${MID}${DUP}`;
    const deps: ReadOnlyDeps = {
      getBodies: async () => new Map([['c1', sentBody]]),
      chapterTitle: () => '第一章',
      allChapterIds: async () => ['c1'],
      baseline: () => ({
        source: 'test',
        metrics: {
          avgSent: spec('句均长', '字', 1, 5),
          avgPara: spec('段落均长', '字', 1, 400),
        },
        markerDensity: {},
      }),
    };
    const ats = (await runAll(deps))
      .filter((x) => x.metric === 'avgSent' && sentBody.slice(x.at, x.at + x.length) === DUP)
      .map((x) => x.at);
    expect(ats).toHaveLength(2);
    expect(new Set(ats).size, `偏移重复：${ats.join(',')}`).toBe(2);
  });
});

describe('D. 给 Agent 的 locate_issues 载荷不许跟着长胖', () => {
  it('仍是 chapterId/at/quote/note 四个键——多带的字段会原样进提示词', async () => {
    const r = await locateIssues({ metric: 'avgPara' }, CTX, DEPS);
    expect(r.ok, r.error?.message).toBe(true);
    const locs = r.data?.locations ?? [];
    expect(locs.length).toBeGreaterThan(0);
    for (const l of locs) expect(Object.keys(l).sort()).toEqual(['at', 'chapterId', 'note', 'quote']);
  });
});
