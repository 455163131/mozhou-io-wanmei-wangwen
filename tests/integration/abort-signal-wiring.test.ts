/**
 * §4 第 23 条：用户点了「中止」之后，那一步到底发生了什么。
 *
 * ★ 实测到的三条事实（修复前）：
 *   1. `host.ts:355` 传给 `executeTool()` 的是 `new AbortController().signal`——
 *      **一个全新的、永远不会 aborted 的信号**。于是 `sandbox.ts:66` 的
 *      「已被叫停，未执行」分支、以及长工具自己轮询的 `ctx.signal.aborted`
 *      （`scan.ts:60`、`client.ts:152/187` 同理）在 Agent 路径上**全是死路**：
 *      叫停只在下一次循环起点（`loop.ts:138`）被看见，正在跑的那一步照跑到底。
 *   2. 真跑到工具里，用户按下的中止**改不了任何状态**：写工具照样写落盘。
 *   3. 轨迹面板里这一步记的是 `succeeded`（或 `failed`），`StepStatus` 声明的
 *      `'aborted'` 全仓没有任何产出方；而 `AgentPanel.tsx:70` 的图标三元也没有
 *      `aborted` 分支，落到兜底的 `▶`——**中止显示成"正在跑"**。
 *
 * 这是本项目反复出现的**装配层失败模式**：闸门的逻辑是对的，喂给它的是空气。
 * 所以本文件测的不是「abort() 有没有被调用」，而是**信号有没有走到执行层**、
 * **步骤状态有没有真的变成 aborted**、**中止之后还花不花那一次 LLM 调用**。
 *
 * 用的是真的 AgentHost + 真的 AgentLoop + 真的 sandbox，只把 LLM 换成脚本化的假对象
 * （和 `tool-call-payload.test.ts` 同一套 harness）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { AgentHost, type AgentHostDeps } from '@main/agent/host';
import { ToolRegistry, type ToolDeps } from '@main/tools/registry';
import { ToolDanger, type ToolSpec, type ToolContext } from '@shared/types/tool';
import { DEFAULT_WRITE_POLICY } from '@shared/constants/checkpoint';
import { PROVIDERS } from '@shared/constants/providers';
import type { RunState, StepRecord } from '@shared/types/agent';

const USAGE = { input: 100, output: 50, wallMs: 5 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function probeSpec(name: string): ToolSpec {
  return {
    name,
    displayName: `探针 ${name}`,
    description: '仅用于测试：只读，不做任何事。',
    params: [],
    danger: ToolDanger.Precise,
    reversible: false,
    maxAffectedBytes: 0,
    crossChapter: false,
    costHintMs: 1,
    idempotent: true,
    writes: false,
  };
}

type Mode = 'none' | 'select' | 'handler';

interface Harness {
  host: AgentHost;
  steps(): StepRecord[];
  termination(): { code: string; atStep?: number } | null;
  /** 工具 handler 在自己被执行的那一刻看到的 `ctx.signal.aborted` */
  handlerSaw(): boolean | null;
  run(): Promise<void>;
}

/**
 * @param mode 'select' 在模型刚选好工具、还没进执行层时叫停；
 *             'handler' 在工具**正在跑**的时候叫停（长工具轮询 signal 的场景）。
 */
function makeHost(mode: Mode): Harness {
  const registry = new ToolRegistry({} as unknown as ToolDeps);
  const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let saw: boolean | null = null;
  let runId = '';
  let hashSeq = 0;

  registry.registerExternal('probe', probeSpec('probe'), async (_args: unknown, ctx: ToolContext) => {
    if (mode === 'handler') {
      host.abort(runId);
      await sleep(30); // 让 abort 落在信号上
    }
    saw = ctx.signal.aborted;
    return { ok: true, data: { done: true }, durationMs: 1 };
  });

  const llm = {
    chat: async (req: { tools?: unknown[] }) => {
      if (Array.isArray(req.tools) && req.tools.length > 0) {
        // 这一步是 select；叫停故意落在「选完工具、还没进执行层」这个缝里
        if (mode === 'select') host.abort(runId);
        return {
          content: '',
          toolCalls: [{ id: 't1', name: 'probe', args: {} }],
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
      const id = (payload as { runId?: string }).runId;
      if (typeof id === 'string' && id) runId = id;
    },
    saveRun: (_s: RunState) => undefined,
  } as unknown as AgentHostDeps;

  const host = new AgentHost(deps);

  return {
    host,
    steps: () =>
      events.filter((e) => e.channel === 'agent:step').map((e) => e.payload.step as StepRecord),
    termination: () => {
      const e = events.find((x) => x.channel === 'agent:terminated');
      return e ? (e.payload.reason as { code: string; atStep?: number }) : null;
    },
    handlerSaw: () => saw,
    run: async () => {
      await host.start({ goal: '把第 1 章健康分提到 85', chapterIds: ['1'], budget: { maxSteps: 2 } });
      const t0 = Date.now();
      while (!events.some((e) => e.channel === 'agent:terminated')) {
        if (Date.now() - t0 > 8000) {
          throw new Error('run 未终止；事件：' + events.map((e) => e.channel).join(','));
        }
        await sleep(10);
      }
    },
  };
}

describe('A. 叫停信号必须真的接到执行层（修复前喂的是全新未 abort 的 controller）', () => {
  it('工具正在跑时叫停，handler 自己轮询的 ctx.signal.aborted 必须变 true', async () => {
    const h = makeHost('handler');
    await h.run();
    // 修复前恒为 false：sandbox.ts:66 / scan.ts:60 那一类「自己看一眼信号就该早退」的
    // 检查，在 Agent 路径上从来没有真值可读。
    expect(h.handlerSaw(), 'Agent 执行层拿到的 signal 永远是没被 abort 的新对象').toBe(true);
  });

  it('没叫停时 ctx.signal.aborted 必须是 false（不许把闸门改成恒真）', async () => {
    const h = makeHost('none');
    await h.run();
    expect(h.handlerSaw()).toBe(false);
  });
});

describe('B. 叫停落在「选好工具、还没执行」这个缝里：不许照跑不误', () => {
  it('这一步记成 aborted，而不是照常执行完再报 succeeded', async () => {
    const h = makeHost('select');
    await h.run();
    const steps = h.steps();
    expect(steps.map((s) => s.status), '中止后仍产出了一个 succeeded 步骤＝工具照跑').toEqual([
      'aborted',
    ]);
    // 修复前的原文是「成功：{"x":false}」——用户叫停了，轨迹却说这一步成功了
    expect(steps[0].resultSummary).not.toMatch(/^成功/);
  });

  it('终止原因是 USER_ABORTED，且发生在中止那一步而不是下一轮', async () => {
    const h = makeHost('select');
    await h.run();
    expect(h.termination()?.code).toBe('USER_ABORTED');
    // 修复前 atStep=2：第 1 步跑完后回到循环开头才看见叫停（loop.ts:138）
    expect(h.termination()?.atStep, '叫停要落在实际被中止的那一步').toBe(1);
  });

  it('★ 中止的那一步不该带评估结论（压根没执行，评估无从谈起）', async () => {
    const h = makeHost('select');
    await h.run();
    // 修复前这里是 "第 1 章字数不足，指标尚未稳定，不能宣布达成"——
    // 一次没执行的工具，照样走了 evaluating 阶段并让模型（按真实数据）给了个说法。
    // 注：本项目的 evaluate 对「分数目标」是纯数据判定、不发 LLM 调用，
    // 所以这里断言的是**评估结论**而不是 LLM 调用次数，后者测不出这条装配。
    expect(h.steps()[0].rationale, '中止后仍走了评估').toBeUndefined();
  });

  it('负对照：不叫停时这一步就是 succeeded，评估照常发生', async () => {
    const h = makeHost('none');
    await h.run();
    const statuses = h.steps().map((s) => s.status);
    expect(statuses.length, 'run 一步都没跑出来').toBeGreaterThan(0);
    expect(statuses).not.toContain('aborted');
    expect(statuses[0]).toBe('succeeded');
    expect(h.steps()[0].rationale, '不叫停时评估被误跳过了').toBeDefined();
  });
});

describe('C. 轨迹面板必须认得 aborted（图标三元不许落到兜底的 ▶）', () => {
  // 行尾归一化：本机 worktree 是 CRLF，正则会因为 `;` 后面跟 `\r` 而匹配不上
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const panelSrc = read('../../src/renderer/components/agent/AgentPanel.tsx');

  it('statusIcon 的分支覆盖 StepStatus 全部五个成员', () => {
    const stmt = panelSrc.match(/const statusIcon =([\s\S]*?);\n/);
    expect(stmt, 'AgentPanel.tsx 里找不到 statusIcon 那个三元').not.toBeNull();
    for (const s of ['running', 'succeeded', 'failed', 'rolled-back', 'aborted']) {
      expect(stmt![1], `statusIcon 没有 ${s} 分支，会落到兜底的 ▶`).toContain(s);
    }
  });

  it('.step.aborted 的样式规则还在（第 22 条②补的那条，别被删了又静默）', () => {
    const css = read('../../src/renderer/components/agent/AgentPanel.module.css');
    expect(css).toMatch(/\.step\.aborted\s*\{[^}]+}/);
  });
});
