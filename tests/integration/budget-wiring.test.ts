/**
 * ★ 预算闸的「生产装配」测试 —— 补上 277 个用例里唯一的那个盲区。
 *
 * 为什么单独开一个文件（而不是往 agent-loop.test.ts 里加一条）：
 *
 *   既有的 `③ BUDGET_EXCEEDED：token 超限` 用例是这么写的：
 *
 *       const loop = new AgentLoop(...);
 *       loop.addUsage(100, 100, 0, 0);   // ← 手动把用量推上去
 *       expect((await loop.run()).reason.code).toBe('BUDGET_EXCEEDED');
 *
 *   它验证的是「闸门逻辑对不对」，**没有验证「用量从哪来」**。
 *   而生产环境的真实缺陷恰好就在后半句：
 *
 *     · `AgentLoop.stats` 的 token/成本/耗时只有 `addUsage()` 会写；
 *     · 全仓生产代码**从不调用** `addUsage()`（只有上面那条测试调过）；
 *     · 真实用量走 `AgentHost.accrue()` → `costState`（给仪表盘），两本账互不相通。
 *
 *   → `loop.stats` 恒为 0 → `checkBudget()` 三个分支永远读 0 → **闸门②等于不存在**。
 *     用户在设置里填的 `maxCostCny: 5.0` / `maxTokens: 200_000` 是装饰品，
 *     唯一还能拦住 Agent 的只剩步数闸门（`maxSteps`）。
 *
 *   所以本文件的写法刻意与那条用例相反：**绝不调用 addUsage**，
 *   而是起一个真的 `AgentHost`，让它自己跑一轮，再看闸门有没有被喂到数据。
 */
import { describe, it, expect } from 'vitest';
import { AgentHost, type AgentHostDeps } from '@main/agent/host';
import { ToolRegistry, type ToolDeps } from '@main/tools/registry';
import { ToolDanger, type ToolSpec } from '@shared/types/tool';
import { DEFAULT_WRITE_POLICY } from '@shared/constants/checkpoint';
import { PROVIDERS } from '@shared/constants/providers';
import type { RunState, TerminationReason } from '@shared/types/agent';

/** 一个付费的云端 provider（本地 provider 成本恒 0，测不出成本闸门） */
const PAID = PROVIDERS.find((p) => p.pricing.inputPerMTok > 0)!;

const USAGE = { input: 800, output: 300, wallMs: 12 };

/** 只读、无参、幂等的探针工具：写工具会走 checkpoint 分支，徒增装配复杂度 */
const PROBE_SPEC: ToolSpec = {
  name: 'probe_read',
  displayName: '探针只读工具',
  description: '仅用于测试：不做任何事，直接返回成功。',
  params: [],
  danger: ToolDanger.Precise,
  reversible: false,
  maxAffectedBytes: 0,
  crossChapter: false,
  costHintMs: 1,
  idempotent: true,
  writes: false,
};

interface Harness {
  host: AgentHost;
  events: Array<{ channel: string; payload: unknown }>;
  saved(): RunState | null;
  /** 起一轮 run；budget 走 opts.budget（会被 merge 进 DEFAULT_BUDGET） */
  start(budget?: { maxTokens?: number; maxCostCny?: number }): Promise<void>;
}

/**
 * 装一个「最小可跑」的 AgentHost。
 *
 * ★ 关键：`llm` 是一个**假的 LlmClient**，每次 `chat()` 都返回固定 usage。
 *   除此之外全部走真实实现（真 AgentLoop、真 BudgetGuard、真 executeTool、真指标引擎）。
 */
function makeHost(): Harness {
  const registry = new ToolRegistry({} as unknown as ToolDeps);
  registry.registerExternal('probe_read', PROBE_SPEC, async () => ({
    ok: true,
    data: { done: true },
    durationMs: 1,
  }));

  const events: Array<{ channel: string; payload: unknown }> = [];
  let savedState: RunState | null = null;
  let hashSeq = 0;

  // 假 LLM：带 tools 的调用（选工具）返回 tool_calls；不带 tools 的（规划）返回计划 JSON
  const llm = {
    chat: async (req: { tools?: unknown[] }) => {
      if (Array.isArray(req.tools) && req.tools.length > 0) {
        return {
          content: '',
          toolCalls: [{ id: 't1', name: 'probe_read', args: {} }],
          usage: { ...USAGE },
          finishReason: 'tool_calls' as const,
        };
      }
      return {
        content: JSON.stringify({ goalRestated: '测试目标', steps: [{ index: 1, intent: '跑一次探针' }] }),
        toolCalls: [],
        usage: { ...USAGE },
        finishReason: 'stop' as const,
      };
    },
  };

  const deps = {
    registry,
    // 只读工具不会走到 checkpoint，这两个只是满足类型
    checkpoints: {
      requireCheckpoint: async () => 'ck_probe',
      commit: async () => undefined,
    },
    replayer: { undoTo: async () => undefined },
    llm,
    provider: PAID,
    toolCallingMode: 'native',
    writePolicy: { ...DEFAULT_WRITE_POLICY },
    projectId: () => 'proj_test',
    projectName: () => '测试项目',
    chapterIds: async () => ['1'],
    chapterTitle: (id: string) => `第${id}章`,
    getBodies: async () => new Map([['1', '很短的一段正文。']]),
    setBody: async () => undefined,
    baseline: () => ({ source: 'builtin', metrics: {}, markerDensity: {} }),
    // 指纹每步都变，避免判据 B 先以 no-effect 终止
    stateHash: async () => `h${hashSeq++}`,
    conflicts: () => [],
    emit: (channel: string, payload: unknown) => { events.push({ channel, payload }); },
    saveRun: (s: RunState) => { savedState = s; },
  } as unknown as AgentHostDeps;

  const host = new AgentHost(deps);
  return {
    host,
    events,
    saved: () => savedState,
    start: async (budget) => {
      await host.start({
        goal: '把第 1 章健康分提到 85',
        chapterIds: ['1'],
        ...(budget ? { budget } : {}),
      });
    },
  };
}

/** 等 run 结束：AgentHost.start() 是「立即返回 runId、后台跑」，故轮询终止事件 */
async function waitTerminated(h: Harness, timeoutMs = 8000): Promise<TerminationReason> {
  const t0 = Date.now();
  for (;;) {
    const ev = h.events.find((e) => e.channel === 'agent:terminated');
    if (ev) return (ev.payload as { reason: TerminationReason }).reason;
    if (Date.now() - t0 > timeoutMs) throw new Error('run 未在超时内终止；事件：' + h.events.map((e) => e.channel).join(','));
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('★ 闸门②的「生产装配」—— 用量必须真的被喂进 loop.stats', () => {
  it('跑一轮真实的 AgentHost：loop.stats 的 token/成本必须 > 0', async () => {
    const h = makeHost();
    await h.start();
    await waitTerminated(h);

    const state = h.saved();
    expect(state).not.toBeNull();

    // ★ 这三条断言就是本次修复的回归护栏。
    //   修复前：stats.tokensIn / costCny 恒为 0（accrue 只写 costState），本用例必红。
    expect(state!.stats.tokensIn).toBeGreaterThan(0);
    expect(state!.stats.tokensOut).toBeGreaterThan(0);
    expect(state!.stats.costCny).toBeGreaterThan(0);
    expect(state!.stats.wallMs).toBeGreaterThan(0);
  });

  it('仪表盘那本账与闸门这本账必须一致（不能各记各的）', async () => {
    const h = makeHost();
    await h.start();
    await waitTerminated(h);

    const dash = h.host.usage; // 给 dash:stats 用的进程级累计
    const state = h.saved();
    expect(dash).not.toBeNull();
    // 单 run 场景下两本账应完全相等；此前一个恒 0、一个有值
    expect(state!.stats.tokensIn).toBe(dash!.tokensIn);
    expect(state!.stats.tokensOut).toBe(dash!.tokensOut);
  });

  it('★ 极小 maxTokens 必须真的终止 run（且不靠手动 addUsage）', async () => {
    // 每次 LLM 调用 1100 tokens，上限设 1000 → 第一步内就该触发
    const h = makeHost();
    await h.start({ maxTokens: 1000 });
    const reason = await waitTerminated(h);

    expect(reason.code).toBe('BUDGET_EXCEEDED');
    expect(reason).toHaveProperty('spentTokens');
    // 终止原因里报的用量必须是真数字，而不是 0
    expect((reason as { spentTokens: number }).spentTokens).toBeGreaterThanOrEqual(1000);
  });

  it('★ 极小 maxCostCny 必须真的终止 run（管钱的那道闸）', async () => {
    // 800 in + 300 out：按 DeepSeek 价（2/8 元每百万）约 0.004 元/次
    const h = makeHost();
    await h.start({ maxCostCny: 0.0001 });
    const reason = await waitTerminated(h);

    expect(reason.code).toBe('BUDGET_EXCEEDED');
    expect((reason as { spentCny: number }).spentCny).toBeGreaterThan(0);
  });
});
