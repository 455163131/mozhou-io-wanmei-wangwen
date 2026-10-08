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
