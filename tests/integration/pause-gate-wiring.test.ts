/**
 * §4 第 24 条：「暂停」这条通道以前**没有任何读取方**。
 *
 * ★ 实测到的修复前事实：
 *   - `host.ts` 的 `pause(runId)` 只做 `pausedRuns.add(runId)`，`resume()` 只做 delete；
 *     全仓**没有一处读 `pausedRuns`**（`LoopDeps` 里压根没有 `isPaused`），
 *     所以点暂停＝什么都不做：run 一步都不多停，照跑到自然终止。
 *   - `RunStatus` 里声明了 `'paused'`（`shared/types/agent.ts:25`），同样**零产出方**：
 *     `LoopPhase` 没有 paused 这一档，`loop.state.status` 永远报不出「暂停中」。
 *   - 三态控制里只有 abort（第 23 条接通）和 rollback 真的有效果。
 *
 * 这是本项目反复出现的**装配层失败模式**：类型说得出、通道也开着（`agent:pause` /
 * `agent:resume` 在 `IpcInvokeMap`、白名单、preload、`register.ts` 四处齐备），
 * 中间那根线从来没接。
 *
 * 本文件跑**真 AgentHost + 真 AgentLoop**（假 LlmClient 只负责选工具），
 * 断言的是「暂停后 run 到底停没停」「resume 后到底走没走」
 * 「暂停期间叫停会不会永久挂住」——不是断言 `pause()` 被调用过。
 *
 * ★ 红证据（防止断言写成空话）：把 `loop.ts` 的暂停块临时注释掉（＝回到修复前「没人读
 *   pausedRuns」）重跑本文件，A 组第一条与 B 组两条一起失败，失败值一律是
 *   `expected 3 to be 1`——run 在暂停后继续跑完了第 2、3 步。恢复后再跑 5/5 绿。
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
  startRun(): Promise<void>;
  /** 等第 n 步落了轨迹（返回是否等到） */
  waitSteps(n: number): Promise<boolean>;
  waitTerminated(): Promise<boolean>;
  toolCalls(): number;
  steps(): StepRecord[];
  status(): RunState['status'] | null;
  termination(): { code: string; atStep?: number } | null;
  resume(): void;
  abort(): void;
}

/**
 * @param pauseInFirstCall 在**第 1 步正在跑的时候**按暂停——等价于用户盯着轨迹点的这一下。
 *   为什么不「等第 1 步落账再暂停」：那样暂停落在闸门检查之后，第 2 步会合法地跑完才停，
 *   用例测到的是时序竞态而不是暂停本身。粒度本身由 A 组第二条负对照兜住。
 */
function makeHost(pauseInFirstCall = false): Harness {
  const registry = new ToolRegistry({} as unknown as ToolDeps);
  const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let calls = 0;
  let runId = '';
  let hashSeq = 0;

  const spec: ToolSpec = {
    name: 'probe',
    displayName: '探针 probe',
    description: '仅用于测试：只读，慢 6ms，好让「停没停」可观察。',
    params: [],
    danger: ToolDanger.Precise,
    reversible: false,
    maxAffectedBytes: 0,
    crossChapter: false,
    costHintMs: 1,
    idempotent: true, // 判据 A 对 idempotent 工具豁免，重复调用不会先以循环终止
    writes: false,
  };
  registry.registerExternal(spec.name, spec, async () => {
    calls += 1;
    // 走的是真通道：`agent:pause` 在 register.ts 里就是这一句 `s.agentHost.pause(p.runId)`
    if (pauseInFirstCall && calls === 1) host.pause(runId);
    await sleep(6); // 一步可测量的耗时：120ms 的窗口足够跑完 3 步，也足够看出「一步都没跑」
    return { ok: true, data: { done: true }, durationMs: 6 };
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
    // 每步指纹都变，避免判据 B 先以 no-effect 终止
    stateHash: async () => `h${hashSeq++}`,
    conflicts: () => [],
    emit: (channel: string, payload: unknown) => {
      events.push({ channel, payload: payload as Record<string, unknown> });
      const id = (payload as { runId?: string }).runId;
      if (typeof id === 'string' && id) runId = id;
    },
    saveRun: (_s: RunState) => undefined,
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
      await host.start({
        goal: '把第 1 章健康分提到 85',
        chapterIds: ['1'],
        budget: { maxSteps: 5 },
      });
    },
    waitSteps: (n) => waitFor(() => (host.getState()?.steps.length ?? 0) >= n),
    waitTerminated: () => waitFor(() => events.some((e) => e.channel === 'agent:terminated')),
    toolCalls: () => calls,
    steps: () => host.getState()?.steps ?? [],
    status: () => host.getState()?.status ?? null,
    termination: () => {
      const e = events.find((x) => x.channel === 'agent:terminated');
      return e ? (e.payload.reason as { code: string; atStep?: number }) : null;
    },
    resume: () => host.resume(runId),
    abort: () => host.abort(runId),
  };
}

describe('A. 暂停必须真的停在步与步之间（修复前 pausedRuns 没有任何读取方）', () => {
  it('第一步执行中暂停：第一步跑完就不许再跑第二步，状态报 paused', async () => {
    const h = makeHost(true);
    await h.startRun();
    expect(await h.waitSteps(1), 'run 连第一步都没跑出来').toBe(true);

    // 修复前这个窗口里 run 会一路跑到自然终止（NO_PROGRESS / MAX_STEPS）
    await sleep(150);
    expect(h.toolCalls(), '暂停后仍在跑工具＝pausedRuns 没闸门在读').toBe(1);
    expect(h.status(), 'RunStatus 里声明的 paused 没有产出方').toBe('paused');
    expect(h.steps().map((s) => s.status)).toEqual(['succeeded']);

    h.abort(); // 收尾，别把后面的用例和 E_RUN_CONFLICT 拖住
    expect(await h.waitTerminated()).toBe(true);
  });

  it('负对照：不暂停就一路跑到终止，状态从来不是 paused', async () => {
    const h = makeHost();
    await h.startRun();
    expect(await h.waitTerminated(), '不暂停的 run 没跑到终止').toBe(true);
    expect(h.toolCalls()).toBeGreaterThanOrEqual(2);
    expect(h.status()).not.toBe('paused');
    expect(h.termination()).not.toBeNull();
  });
});

describe('B. resume 必须真的把 run 放走（同一根线，反向）', () => {
  it('暂停 → resume → 继续跑第二步，并最终以非暂停原因收尾', async () => {
    const h = makeHost(true);
    await h.startRun();
    expect(await h.waitSteps(1)).toBe(true);

    await sleep(60);
    expect(h.toolCalls(), '没暂停住，后面的「resume 放走」也就无从证明').toBe(1);

    h.resume();
    expect(await h.waitTerminated(), 'resume 后 run 没有继续跑到终止').toBe(true);
    expect(h.toolCalls(), 'resume 后仍只有 1 次工具调用＝没放走').toBeGreaterThanOrEqual(2);
    expect(h.termination()?.code).not.toBe('USER_ABORTED');
  });

  it('★ 暂停期间叫停：不许永久挂在闸门上，必须以 USER_ABORTED 收尾', async () => {
    const h = makeHost(true);
    await h.startRun();
    expect(await h.waitSteps(1)).toBe(true);

    await sleep(60);
    expect(h.toolCalls(), '没暂停住，后面的「挂在闸门上」也就无从证明').toBe(1);

    h.abort();
    // 修复前这条是「假绿」——run 早就自己跑完了，终止原因不是 USER_ABORTED
    expect(await h.waitTerminated()).toBe(true);
    expect(h.termination()?.code, '挂在暂停里没醒').toBe('USER_ABORTED');
    expect(h.termination()?.atStep).toBe(2);
    expect(h.toolCalls(), '叫停后不许把暂停中的那一步补跑掉').toBe(1);
  });
});

describe('C. 装配哨兵：这根线以后不许再被拆回「只写不读」', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('host 里 pausedRuns 必须有人读，LoopDeps 必须有暂停闸门', () => {
    const hostSrc = read('../../src/main/agent/host.ts');
    const loopSrc = read('../../src/main/agent/loop.ts');
    expect(hostSrc, 'pausedRuns 又变回只写不读了').toMatch(/pausedRuns\.has\(/);
    expect(loopSrc, 'LoopDeps 没有 isPaused').toMatch(/isPaused:/);
    expect(loopSrc, 'LoopDeps 没有 waitWhilePaused').toMatch(/waitWhilePaused:/);
    // 类型口径：LoopPhase 必须有 paused 这一档，否则 RunStatus 的 paused 又是空头支票
    expect(loopSrc).toMatch(/'paused'/);
  });
});
