/**
 * ★ `locate_issues` 的段落偏移必须逐字可寻。
 *
 * 为什么单独开一个文件：
 *
 *   修复前 `analyze.ts` 段落分支（`avgPara` / `sentsPerPara`）里的 `offset` 是死变量：
 *   `paras.map((p) => ({ p, at: offset }))` 从不累加，于是每段的 `at` 恒为 0；
 *   真正给出的位置靠 `body.indexOf(x.p)` 兜底，而 `indexOf` **永远从 0 开始找**。
 *
 *   对唯一文字这碰巧是对的，对**重复段落**就是错的：同一段落出现两次，
 *   两条命中都指向第一次出现处。而 `locate_issues` 的 `at` 是给
 *   `replace_phrase` 和 UI 高亮用的（工具 3 的 doc 原话：「逐字可寻的偏移」），
 *   偏移指错 → 改错地方 / 高亮错地方。
 *
 *   本文件用「同一段落重复出现」的文本把这个缺陷钉住：三条命中必须落在
 *   三个**互不相同**、且各自确实是段落起点的偏移上。
 */
import { describe, it, expect } from 'vitest';
import { locateIssues, type ReadOnlyDeps } from '@main/tools/impl/analyze';
import type { ToolContext } from '@shared/types/tool';

/** 段落起点：按 split('\n') 的口径累加（每段 + 1 个换行符） */
function paraOffsets(parts: string[]): number[] {
  const at: number[] = [];
  let o = 0;
  for (const p of parts) {
    at.push(o);
    o += p.length + 1;
  }
  return at;
}

function depsFor(parts: string[]): { deps: ReadOnlyDeps; body: string } {
  const body = parts.join('\n');
  const deps: ReadOnlyDeps = {
    getBodies: async () => new Map([['c1', body]]),
    chapterTitle: () => '第一章',
    allChapterIds: async () => ['c1'],
    baseline: () => ({ source: 'test', metrics: {}, markerDensity: {} }),
  };
  return { deps, body };
}

const CTX: ToolContext = {
  runId: 'test',
  stepNo: 1,
  dryRun: true,
  requireCheckpoint: async () => '',
  signal: new AbortController().signal,
  logger: () => {},
};

// 同一段落（DUP）出现在第 2 与第 4 段；MID 最长排第一。
// 按长度取前三 → 命中 DUP@第2段、MID@第3段、DUP@第4段。
const DUP = '这是一段在两处重复出现的长段落。';
const MID = '中间这段更长一些，用来把第二次出现的位置往后推得足够远。';
const PARTS = ['开场短段', DUP, MID, DUP];

async function run(metric: string) {
  const { deps, body } = depsFor(PARTS);
  const res = await locateIssues({ metric, chapterIds: ['c1'] }, CTX, deps);
  expect(res.ok, `locate_issues(${metric}) 失败：${res.error?.message}`).toBe(true);
  return { body, locations: res.data?.locations ?? [] };
}

describe('★ 段落定位：重复段落不许都指向第一次出现处', () => {
  it('avgPara：三条命中的偏移互不相同', async () => {
    const { locations } = await run('avgPara');
    expect(locations).toHaveLength(3);
    const ats = locations.map((l) => l.at);
    expect(new Set(ats).size, `偏移重复：${ats.join(',')}`).toBe(3);
  });

  it('avgPara：偏移精确等于各段落真实起点', async () => {
    const { body, locations } = await run('avgPara');
    const expected = paraOffsets(PARTS);
    // 被选中的三段：DUP(索引1)、MID(索引2)、DUP(索引3)
    expect(locations.map((l) => l.at).sort((a, b) => a - b)).toEqual(
      [expected[1], expected[2], expected[3]].sort((a, b) => a - b),
    );
    for (const l of locations) {
      const hit = PARTS.filter((p) => p === DUP || p === MID).find(
        (p) => body.slice(l.at, l.at + p.length) === p,
      );
      expect(hit, `at=${l.at} 处不是被选中段落的起点`).toBeTruthy();
    }
  });

  it('sentsPerPara：与 avgPara 同一分支，偏移同样精确', async () => {
    const { locations } = await run('sentsPerPara');
    const expected = paraOffsets(PARTS);
    expect(locations.map((l) => l.at).sort((a, b) => a - b)).toEqual(
      [expected[1], expected[2], expected[3]].sort((a, b) => a - b),
    );
  });
});

/**
 * ★ 句子分支（§4 第 12 条）：同一个缺陷的另一半。
 *
 * `avgSent` / `sentCv` 用的也是 `body.indexOf(s)` 反查（修复前 analyze.ts:254），
 * 而 `indexOf` 永远从 0 起找，所以**同一段落内重复的句子**两条命中指向同一个位置。
 *
 * §4 原文的另一半猜测是对的，这里用实测把它钉住（node 复核过 split 边界）：
 * `split(/(?<=[。！？…])/)` 是**在终止符之后**断开，换行符归**下一个**片段，
 * 于是跨段的重复句文字自带 `\n` 前缀、整段文本唯一 → indexOf 恰好给对位置。
 * 所以这个缺陷只在段内重复时暴露。跨段那一半守住的是**累加口径**：逐片段累加必须
 * 等于逐片段反查（最后一条用例）。至于片段自带的那个 `\n`，§4 第 20 条②起不再算进
 * 命中区间——它是上一句的行尾，不是这一句的开头。
 *
 * 语义上不需要新决策：修复前的代码本来就把同一句的两次出现各报一条
 * （只是两条都指向首次出现处），本条只把 `at` 改对，命中条数与排序口径不变。
 * 累加口径与段落分支差 1：句子片段自带终止符、片段之间没有被吃掉的分隔符，
 * 所以只加 `s.length`；段落分支按 `\n` 连接要加 `p.length + 1`。
 */
function sentOffsets(parts: string[]): number[] {
  const at: number[] = [];
  let o = 0;
  for (const s of parts) {
    at.push(o);
    o += s.length;
  }
  return at;
}

async function runSentOn(body: string, metric: string) {
  const deps: ReadOnlyDeps = {
    getBodies: async () => new Map([['c1', body]]),
    chapterTitle: () => '第一章',
    allChapterIds: async () => ['c1'],
    baseline: () => ({ source: 'test', metrics: {}, markerDensity: {} }),
  };
  const res = await locateIssues({ metric, chapterIds: ['c1'] }, CTX, deps);
  expect(res.ok, `locate_issues(${metric}) 失败：${res.error?.message}`).toBe(true);
  return { body, locations: res.data?.locations ?? [] };
}

// 全部句子在同一段落内（body 里没有 \n）：DUP 出现在第 2 与第 4 句。
const SENT_MID = '中间这句最长，用来占住排序第一位。';
const SENT_DUP = '这句在同一段里重复出现两次。';
const SENT_SHORT = '短句。';
const SENTS = [SENT_MID, SENT_DUP, SENT_SHORT, SENT_DUP];

async function runSent(metric: string) {
  return runSentOn(SENTS.join(''), metric);
}

describe('★ 句子定位：段内重复句不许都指向第一次出现处', () => {
  it('avgSent：同一句的两次命中落在各自的真实起点', async () => {
    const { body, locations } = await runSent('avgSent');
    const expected = sentOffsets(SENTS);
    const dupHits = locations.filter((l) => body.slice(l.at, l.at + SENT_DUP.length) === SENT_DUP);

    expect(dupHits.length, '重复句应被命中两次').toBe(2);
    // 修复前两条都是 17（indexOf 从 0 起找，两次都回指首次出现处）
    expect(dupHits.map((l) => l.at).sort((a, b) => a - b)).toEqual(
      [expected[1], expected[3]].sort((a, b) => a - b),
    );
    expect(new Set(locations.map((l) => l.at)).size, '偏移重复').toBe(locations.length);
  });

  it('avgSent：每条命中的 at 处逐字等于被选中的句子', async () => {
    const { body, locations } = await runSent('avgSent');
    for (const l of locations) {
      const hit = [SENT_MID, SENT_DUP, SENT_SHORT].find(
        (s) => body.slice(l.at, l.at + s.length) === s,
      );
      expect(hit, `at=${l.at} 处不是任何一句的起点`).toBeTruthy();
    }
  });

  it('sentCv：与 avgSent 同一分支，偏移同样精确', async () => {
    const { body, locations } = await runSent('sentCv');
    const expected = sentOffsets(SENTS);
    const dupHits = locations.filter((l) => body.slice(l.at, l.at + SENT_DUP.length) === SENT_DUP);
    expect(dupHits.map((l) => l.at).sort((a, b) => a - b)).toEqual(
      [expected[1], expected[3]].sort((a, b) => a - b),
    );
  });

  it('跨段重复句：片段自带 \\n 前缀使文本唯一，累加不许弄坏原本对的那半边', async () => {
    // 断言用 indexOf 独立反查真位置——这里能信，正是因为三个片段文本互不相同
    // （换行归下一片段）。护栏没松：仍是「逐片段累加 = 逐片段反查」，只是每个位置
    // 各自减掉它自己的前导空白长度。
    const body = `${SENT_DUP}\n过渡一句。\n${SENT_DUP}\n`;
    const frags = [SENT_DUP, '\n过渡一句。', `\n${SENT_DUP}`];
    const { locations } = await runSentOn(body, 'avgSent');

    expect(frags.map((f) => body.indexOf(f))).toEqual([0, SENT_DUP.length, SENT_DUP.length + 6]);
    expect(locations.map((l) => l.at).sort((a, b) => a - b)).toEqual(
      // ★ §4 第 20 条②改口径：换行符不属于句子。波浪线要从句子第一个字起笔，
      //   从 `…两次。\n` 的那个 \n 起笔会画在上一句行尾，看着像标错了地方。
      frags
        .map((f) => body.indexOf(f) + (f.length - f.trimStart().length))
        .sort((a, b) => a - b),
    );
    const trimmed = frags.map((f) => f.trim());
    for (const l of locations) {
      const hit = trimmed.find((t) => body.slice(l.at, l.at + t.length) === t);
      expect(hit, `at=${l.at} 处不是任何一句（去前导空白后）的起点`).toBeTruthy();
      expect(body[l.at], `at=${l.at} 落在换行/空白上，镜像层的线会从上一行起笔`).not.toBe('\n');
    }
  });
});
