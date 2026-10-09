/**
 * §4 第 26 条：run 的状态**从来没被任何读路径拿到过**。
 *
 * ★ 实测到的修复前事实（不是推断，每条都跑过/数过）：
 *   - `host.ts:93` 的 `runStates = new Map<string, RunState>()` **全仓只读不写**
 *     （`grep -c "runStates\.set" src/main/agent/host.ts` = 0，只有 `:741` 的 get 与 `:749` 的 values）。
 *   - 于是两条对外承诺直接空转：
 *     ① `agent:state`（`register.ts:459` 的实现就是 `getState(p.runId)`）**恒返回 null**——
 *        连**正在跑**的那条 run 都读不到，因为带 runId 的分支走的是那张空 map；
 *     ② `agent:history`（`register.ts:460` 走 `listRuns()`）**恒返回空数组**。
 *   - 更糟的是 `register.ts:88` 那条**架构 T24 承诺**：「检测上次是否有未闭合的 run —— 必须提示，不静默」，
 *     它判据是 `listRuns().filter(r => r.status !== 'terminated')`。listRuns() 恒空 ⇒
 *     **这段提示永远不会发**。而且 `saveRun` 只在 `loop.run()` **返回之后**调一次
 *     （`host.ts:191`），应用被强杀时库里连一行都没有 ⇒ 就算改成读 DB 也没东西可读。
 *
 * 本文件跑**真 AgentHost + 真 AgentLoop**，断的是「读得到读不到」，
 * 不是断「map 有没有 set 过」。services 那半边（AppServices 在 ELECTRON_RUN_AS_NODE 下造不出来）
 * 用源码哨兵钉住 SQL 真的存在。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { AgentHost, type AgentHostDeps } from '@main/agent/host';
import { ToolRegistry, type ToolDeps } from '@main/tools/registry';
import { ToolDanger, type ToolSpec } from '@shared/types/tool';
import type { RunState, StepRecord } from '@shared/types/agent';
import { DEFAULT_WRITE_POLICY } from '@shared/constants/checkpoint';
import { PROVIDERS } from '@shared/constants/providers';

const USAGE = { input: 100, output: 50, wallMs: 5 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  host: AgentHost;
  startRun(): Promise<string>;
  waitSteps(n: number): Promise<boolean>;
  waitTerminated(): Promise<boolean>;
  steps(): StepRecord[];
  /** 每次 `deps.saveRun` 被调用时记下的快照（顺序就是调用顺序） */
  saves(): Array<{ status: string; steps: number }>;
  /** 已经收到过几次终止事件（连跑两条 run 时用它等第二条） */
  terminatedCount(): number;
}

function makeHost(): Harness {
  const registry = new ToolRegistry({} as unknown as ToolDeps);
  const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const saves: Array<{ status: string; steps: number }> = [];
  let hashSeq = 0;

  const spec: ToolSpec = {
    name: 'probe',
    displayName: '探针 probe',
    description: '仅用于测试：只读、幂等，好让 run 能自然跑到多步。',
    params: [],
    danger: ToolDanger.Precise,
    reversible: false,
    maxAffectedBytes: 0,
    crossChapter: false,
    costHintMs: 1,
    idempotent: true,
    writes: false,
  };
  registry.registerExternal(spec.name, spec, async () => {
    await sleep(4);
    return { ok: true, data: { done: true }, durationMs: 4 };
  });

  const llm = {
    chat: async (req: { tools?: unknown[] }) => {
      if (Array.isArray(req.tools) && req.tools.length > 0) {
        return {
          content: '',
          toolCalls: [{ id: 't1', name: 'probe', args: {} }],
          usage: { ...USAGE },
          finishReason: 'tool_calls' as const,
        };
      }
      return {
        content: JSON.stringify({ goalRestated: '测试目标', steps: [{ index: 1, intent: '跑探针' }] }),
        toolCalls: [],
        usage: { ...USAGE },
        finishReason: 'stop' as const,
      };
    },
  };

  const deps = {
    registry,
    checkpoints: { requireCheckpoint: async () => 'ck_probe', commit: async () => undefined },
    replayer: { undoTo: async () => undefined },
    llm,
    provider: PROVIDERS[0],
    toolCallingMode: 'native',
    writePolicy: { ...DEFAULT_WRITE_POLICY },
    projectId: () => 'proj_test',
    projectName: () => '测试项目',
    chapterIds: async () => ['1'],
    chapterTitle: (id: string) => `第${id}章`,
    getBodies: async () => new Map([['1', '很短的一段正文。']]),
    setBody: async () => undefined,
    baseline: () => ({ source: 'builtin', metrics: {}, markerDensity: {} }),
    stateHash: async () => `h${hashSeq++}`,
    conflicts: () => [],
    emit: (channel: string, payload: unknown) => {
      events.push({ channel, payload: payload as Record<string, unknown> });
    },
    // ★ 这条就是「崩溃留不留得下痕迹」的唯一出口：host 把它转给 services 落库
    saveRun: (state: RunState) => {
      saves.push({ status: state.status, steps: state.steps.length });
    },
  } as unknown as AgentHostDeps;

  const host = new AgentHost(deps);

  const waitFor = async (pred: () => boolean, ms = 3000): Promise<boolean> => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) return false;
      await sleep(5);
    }
    return true;
  };

  return {
    host,
    startRun: async () => {
      const r = await host.start({
        goal: '把第 1 章健康分提到 85',
        chapterIds: ['1'],
        budget: { maxSteps: 3 },
      });
      return r.runId;
    },
    waitSteps: (n) => waitFor(() => (host.getState()?.steps.length ?? 0) >= n),
    waitTerminated: () => waitFor(() => events.some((e) => e.channel === 'agent:terminated')),
    steps: () => host.getState()?.steps ?? [],
    saves: () => saves,
    terminatedCount: () => events.filter((e) => e.channel === 'agent:terminated').length,
  };
}

describe('A. 正在跑的 run 必须按 runId 读得到（agent:state 的实现路径）', () => {
  it('跑起来之后 getState(runId) 不许是 null，且拿到的就是这条 run', async () => {
    const h = makeHost();
    const runId = await h.startRun();
    expect(await h.waitSteps(1), 'run 连第一步都没跑出来').toBe(true);

    // 修复前：带 runId 的分支只查那张从没写过的 map ⇒ 恒 null
    const st = h.host.getState(runId);
    expect(st, 'agent:state 拿不到正在跑的 run').not.toBeNull();
    expect(st!.runId).toBe(runId);
    expect(st!.steps.length).toBeGreaterThanOrEqual(1);
    // startedAt 也要是真的：`loop.ts` 的 state getter 以前硬写 `startedAt: 0`，
    // 于是「这条 run 什么时候开的」在 RunState、runs 表和排序里都是空的
    expect(st!.startedAt, 'startedAt 恒 0＝开始时间从来没记过').toBeGreaterThan(0);

    h.host.abort(runId); // 收尾
    expect(await h.waitTerminated()).toBe(true);
  });

  it('按一个不存在的 runId 去读必须还是 null（不许改成"永远返回当前 run"）', async () => {
    const h = makeHost();
    const runId = await h.startRun();
    expect(await h.waitSteps(1)).toBe(true);
    expect(h.host.getState('run_不存在'), '拿别人的 id 读到当前 run＝串 run').toBeNull();
    h.host.abort(runId);
    expect(await h.waitTerminated()).toBe(true);
  });
});

describe('B. 跑完的 run 必须留在 listRuns 里（agent:history 的实现路径）', () => {
  it('run 结束后 listRuns() 必须含这条，且状态是 terminated', async () => {
    const h = makeHost();
    await h.startRun();
    expect(await h.waitTerminated(), 'run 没跑到终止').toBe(true);
    await sleep(10);

    // 修复前：恒 []，于是 T24 的未闭合检测与 agent:history 一起空转
    const all = h.host.listRuns();
    expect(all.length, '跑完的 run 一条都不在表里').toBeGreaterThanOrEqual(1);
    expect(all[0]!.status).toBe('terminated');
  });

  it('连跑两条时新的排在最前，且两条都还在（agent:history 的口径）', async () => {
    const h = makeHost();
    const first = await h.startRun();
    expect(await h.waitTerminated(), '第一条没跑到终止').toBe(true);
    await sleep(10);

    const second = await h.startRun();
    expect(await h.terminatedCount()).toBeGreaterThanOrEqual(1);
    // 等第二条也结束：terminatedCount 到 2
    const t0 = Date.now();
    while (h.terminatedCount() < 2 && Date.now() - t0 < 3000) await sleep(5);
    expect(h.terminatedCount(), '第二条没跑到终止').toBeGreaterThanOrEqual(2);
    await sleep(10);

    const all = h.host.listRuns();
    expect(all.map((r) => r.runId)).toContain(first);
    expect(all.map((r) => r.runId)).toContain(second);
    // startedAt 以前恒 0，按它排序等于按插入顺序倒着数都不稳；现在是真时间戳
    expect(all[0]!.runId, '列表顺序倒着来＝历史面板把最旧的当成最新').toBe(second);
    expect(all[0]!.startedAt).toBeGreaterThan(all[1]!.startedAt);
  });
});

describe('C. 开跑那一刻就得落一次 saveRun（强杀后库里得有东西可查）', () => {
  it('saveRun 至少两次，且第一次发生在任何步骤落账之前', async () => {
    const h = makeHost();
    await h.startRun();
    // ★ 关键在**顺序**：start 那一刻就得有一次，否则强杀的 run 连一行都没有
    await sleep(20);
    const first = h.saves();
    expect(first.length, '开跑时没落库＝崩溃无痕').toBeGreaterThanOrEqual(1);
    expect(first[0]!.steps, '第一次落库就该是空轨迹（真在开跑那一刻）').toBe(0);
    expect(first[0]!.status).not.toBe('terminated');

    expect(await h.waitTerminated()).toBe(true);
    await sleep(10);
    const done = h.saves();
    expect(done.length, '结束时没再落库').toBeGreaterThanOrEqual(2);
    expect(done[done.length - 1]!.status).toBe('terminated');
  });
});

describe('D. 装配哨兵：读侧的 SQL 与调用点不许又变回空气', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

  /** 只看 project:open 这一段——整份 register.ts 里有的是别的 handler，全文正则会自欺 */
  const openBlock = (src: string): string => {
    const a = src.indexOf("handle('project:open'");
    const b = src.indexOf("handle('project:close'");
    return a < 0 || b <= a ? '' : src.slice(a, b);
  };

  /**
   * 去掉行注释。★ 必要性不是洁癖：D 组要钉「载荷里不许出现某个终止码」，
   * 而解释为什么不用那个码的**注释**必然提到它的名字——不剥注释，
   * 这条钉会把自己写的说明书当成代码判红，逼大家把理由删掉。
   */
  const codeOnly = (block: string): string =>
    block
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

  it('services 必须委托给 RunRepo——内联 SQL 在那儿一行测试都写不了', () => {
    const src = read('../../src/main/services.ts');
    expect(src).toMatch(/new RunRepo\(/);
    expect(src).toMatch(/listUnclosedRuns\(\): UnclosedRun\[\]/);
    expect(src, '未闭合检测必须走 repo，别再退回进程内 map').toMatch(/this\.runs\.listUnclosed\(/);
    expect(src).toMatch(/this\.runs\.markReported\(/);
    // ★ 修复前的成因之一就是 SQL 埋在 AppServices 里：那个类 import 了 electron 的 app，
    //   在 ELECTRON_RUN_AS_NODE 下根本造不出来，于是这段口径从来没被断言过。
    expect(src, '检测口径不许又埋回测不到的地方').not.toMatch(/SELECT id, goal, stats_json/);
  });

  it('RunRepo 的口径：status 非 terminated **且**没报过，按项目隔离', () => {
    const src = read('../../src/main/db/repos/run-repo.ts');
    expect(src, '未闭合 = status <> terminated，这条口径不许被改写').toMatch(
      /FROM runs[\s\S]{0,260}status\s*<>\s*'terminated'/,
    );
    expect(src, '没报过才是提示对象').toMatch(/unclosed_reported_at IS NULL/);
    expect(src).toMatch(/WHERE\s+project_id\s*=\s*\?/);
    expect(src).toMatch(/UPDATE runs SET unclosed_reported_at/);
  });

  it('project:open 必须改成读库，而不是读那张进程内 map', () => {
    const src = read('../../src/main/ipc/register.ts');
    expect(src, 'listRuns() 只能看见本进程的 run，检测不了「上次」').not.toMatch(
      /listRuns\(\)\.filter/,
    );
    expect(src).toMatch(/services\.listUnclosedRuns\(\)/);
  });

  it('★★ 报过一次必须封账，否则每次开项目重复弹同一条', () => {
    const src = read('../../src/main/ipc/register.ts');
    const block = openBlock(src);
    expect(block, '提示发出去之后没写回＝每次开项目都弹').toMatch(/markUnclosedRunReported/);
    expect(block, '封账必须在 push 之后——先封账再发，发失败就永远不提示了').toMatch(
      /push\.send\([\s\S]{0,400}markUnclosedRunReported/,
    );
  });

  it('★ 未闭合提示不能再挂「连续多次工具失败」这个码', () => {
    const src = read('../../src/main/ipc/register.ts');
    // 这条检测以前**一次都没触发过**（判据恒空），所以它写的码从来没被看见。
    // 一旦真的能触发，CONSECUTIVE_FAILURE 会让面板打上「连续多次工具失败 / 最后错误：…」，
    // 而事实是进程被强杀——把用户的关软件说成工具的故障，是新一类误导。
    // 10 种终止码是架构承诺（§1.4.1），这里不为它新增第 11 种，改用 USER_ABORTED：
    // 面板渲染成「已被用户叫停 / 在第 N 步叫停。已做的改动都保留了」——两句都成立。
    const block = codeOnly(openBlock(src));
    expect(block.length, 'project:open 段落定位失败，测试自身要修').toBeGreaterThan(100);
    expect(block, '未闭合提示不许报成工具失败').not.toMatch(/CONSECUTIVE_FAILURE/);
    expect(block).toMatch(/code: 'USER_ABORTED'/);
  });

  it('host 的 runStates 必须有写点（只读不写就是本条的病根）', () => {
    const src = read('../../src/main/agent/host.ts');
    expect(src, 'runStates 又变回只写…不对，又变回只读不写了').toMatch(/runStates\.set\(/);
  });
});
