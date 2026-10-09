/**
 * §4 第 27 条：`StepStatus` 的 **`running` 与 `rolled-back` 两个值全仓没有产出方**。
 *
 * ★ 实测到的修复前事实（`grep "status: 'running'" src/main` / `grep "'rolled-back'" src/main` 均零命中）：
 *   - `loop.ts` 只在 `pushStep()` 里落 StepRecord，而 `pushStep` 是**工具跑完之后**才调的。
 *     于是「正在跑的那一步」在 `RunState.steps` 里根本不存在——用户盯着轨迹面板看 Agent 干活时，
 *     当前这一步要等它跑完才凭空出现。`AgentPanel.tsx:73` 的 `'running'` 分支、
 *     `AgentPanel.module.css:177` 的 `.step.running` 样式，从第 22 条②画好那天起就没被渲染过一次。
 *   - `StepStatus` 的 `'rolled-back'` 同样零产出方。回滚有三条**活的**入口：
 *     `register.ts:471`（用户点「回滚」）、`services.ts:284`（`undo` 工具，Agent 自己撤）、
 *     `sandbox.ts:222/269`（工具异常/失败自动撤）——三条全部直接调 `replayer.undoTo`，
 *     **没有一条碰过 StepRecord.status**。正文被撤回了，轨迹里那几步仍然是绿色 ✓，
 *     看上去改动还在。这是本项目最典型的那类误导：界面在陈述一件已经不成立的事。
 *   - 顺带：`host.ts:748` 的 `rollbackTo()` 全仓**零调用方**——本来最该做这件事的那个方法，
 *     谁都没调它。
 *
 * 这是本项目反复出现的**装配层失败模式**：类型说得出（5 个 StepStatus）、
 * 渲染层画得出（5 个分支 + 5 条样式），中间那根线从来没接。
 *
 * ★ 红证据（防止断言写成空话）——修好后把三根新接的线各自临时拔掉重跑本文件：
 *   - 拔 `loop.ts` 的 `this.pushRunningStep(stepNo, call)` → A 组 3 条全红：
 *     `expected [] to have a length of 1`（steps 里没有 running）、
 *     `expected [ Array(1) ] to have a length of 2 but got 1`（只推了一次事件）、
 *     `expected 0 to be greater than 0`（异常路径压根没有记录可收尾）。
 *   - 拔 `host.ts` 的 `this.markStepsRolledBack(result.undoneCheckpointIds)` → B1 红：
 *     `正文撤了，轨迹还说改动在（绿色 ✓）: expected 'succeeded' to be 'rolled-back'`。
 *     B2／B3 是负对照，拔掉后仍绿——这正是它们该做的。
 *   - 把 store 的增量计数换回裸 `+=` → C2 红：`重推一次就把改动数翻倍: expected 4 to be 2`。
 *   - 拔 `use-agent-stream.ts` 里对 running 的早退 → D 组那条哨兵红：
 *     `没有对 running 早退: expected -1 to be greater than 0`。
 *   四处恢复后 md5 与拔掉前一致，16/16 绿。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { AgentLoop, type LoopDeps, type LoopEvent } from '@main/agent/loop';
import { AgentHost, type AgentHostDeps } from '@main/agent/host';
import { ToolRegistry, type ToolDeps } from '@main/tools/registry';
import { ToolDanger, type Edit, type ToolSpec, type ToolResult } from '@shared/types/tool';
import type { RunState, StepRecord } from '@shared/types/agent';
import type { RollbackResult } from '@shared/types/checkpoint';
import { DEFAULT_BUDGET } from '@shared/constants/budget';
import { DEFAULT_WRITE_POLICY } from '@shared/constants/checkpoint';
import { PROVIDERS } from '@shared/constants/providers';
import { useAgentStore } from '@renderer/store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EDIT: Edit = { before: '旧句', after: '新句', at: 0, note: '测试用的一处改动' };

// ───────────────────────── A 组：直接驱动 AgentLoop ─────────────────────────

interface LoopHarness {
  loop: AgentLoop;
  /** 已经推给渲染层的 step 事件（含重复推送——第 27 条要求同一步推两次） */
  stepEvents(): StepRecord[];
  /** 当前 RunState 里的步骤 */
  states(): StepRecord[];
  /** 工具真正开始执行了（此时 running 记录必须已经落地） */
  execStarted: Promise<void>;
  /** 放工具走完 */
  releaseExec(): void;
}

/**
 * @param opts.holdExec 把工具卡在 await 里，好观察「正在跑」这个中间态
 * @param opts.observeThrows observe 抛异常 → 走 loop 的 catch，用来验 running 不会被留在轨迹里
 */
function makeLoop(opts: { holdExec?: boolean; observeThrows?: boolean; achieveAt?: number } = {}): LoopHarness {
  const events: LoopEvent[] = [];
  let seq = 0;
  let release: () => void = () => undefined;
  const execStarted = new Promise<void>((r) => {
    release = r;
  });
  let holdResolve: () => void = () => undefined;
  const hold = new Promise<void>((r) => {
    holdResolve = r;
  });

  const deps: LoopDeps = {
    plan: async () => ({ goalRestated: '测试目标', steps: [{ index: 1, intent: '跑探针' }] }),
    // 每步参数不同：判据 A（同参数重复调用）不该抢在闸门⑤之前终止，
    // 否则 A3 测到的是循环检测而不是「running 记录有没有被收掉」。
    select: async (_p, _o, stepNo) => ({ id: `c${stepNo}`, name: 'probe', args: { n: stepNo } }),
    execute: async () => {
      release();
      if (opts.holdExec) await hold;
      return { ok: true, data: { done: true }, durationMs: 3 };
    },
    observe: async (call, result, stepNo) => {
      if (opts.observeThrows) throw new Error('observe 炸了');
      return {
        stepNo,
        toolName: call.name,
        kind: 'facts' as const,
        summary: '看到了',
        durationMs: 1,
        ok: result.ok,
      };
    },
    evaluate: async (_g, _o, stepNo) => ({
      progress: 'positive' as const,
      goalAchieved: stepNo >= (opts.achieveAt ?? 1),
      reason: '有进展',
    }),
    stateHash: async () => `h${seq++}`,
    emit: (e) => events.push(e),
    isAborted: () => false,
    isPaused: () => false,
    waitWhilePaused: async () => ({ aborted: false }),
    isLocal: false,
    maxHistory: 20,
  };

  const loop = new AgentLoop('run_A', '把第 1 章健康分提到 85', deps, { ...DEFAULT_BUDGET, maxSteps: 4 });

  return {
    loop,
    stepEvents: () =>
      events.filter((e) => e.type === 'step').map((e) => (e as { step: StepRecord }).step),
    states: () => loop.state.steps,
    execStarted,
    releaseExec: () => holdResolve(),
  };
}

describe('A. running：正在跑的那一步必须先在轨迹里出现（修复前 pushStep 只在跑完后落记录）', () => {
  it('工具执行中，RunState.steps 里已有一条 status=running 的同名步骤，且已推给渲染层', async () => {
    const h = makeLoop({ holdExec: true });
    const done = h.loop.run();
    await h.execStarted;

    const running = h.states().filter((s) => s.status === 'running');
    expect(running, '「正在跑」这个 StepStatus 没有产出方').toHaveLength(1);
    expect(running[0].stepNo).toBe(1);
    expect(running[0].toolName).toBe('probe');
    expect(
      h.stepEvents().filter((s) => s.status === 'running'),
      '只塞进 state 不推事件＝渲染层还是看不见',
    ).toHaveLength(1);

    h.releaseExec();
    await done;
  });

  it('跑完后同一个 stepNo 只有一条记录，且已换成终态；steps 计数不许被 running 那条多算', async () => {
    const h = makeLoop({ holdExec: true });
    const done = h.loop.run();
    await h.execStarted;
    h.releaseExec();
    await done;

    const steps = h.states();
    expect(steps, '同一步被追加了两次（running 一条 + 终态一条）').toHaveLength(1);
    expect(steps[0].status).toBe('succeeded');
    expect(steps[0].durationMs).toBe(3);
    // 推事件推了两次（running + 终态）是**故意的**：渲染层靠 stepNo 幂等合并
    expect(h.stepEvents().filter((s) => s.stepNo === 1)).toHaveLength(2);
    expect(h.loop.state.stats.steps, 'running 那条把 stats.steps 也加了 1').toBe(1);
  });

  it('observe 抛异常时，running 记录不许留在轨迹里当「还在跑」', async () => {
    const h = makeLoop({ observeThrows: true });
    const { reason } = await h.loop.run();

    expect(reason.code).toBe('CONSECUTIVE_FAILURE');
    expect(h.states().length).toBeGreaterThan(0);
    expect(
      h.states().filter((s) => s.status === 'running'),
      '异常路径把「正在跑」永久留在了轨迹里——run 都终止了还说在跑',
    ).toHaveLength(0);
    for (const s of h.states()) {
      expect(s.status, `第 ${s.stepNo} 步状态不真实`).toBe('failed');
      expect(s.errorMessage).toContain('observe');
    }
  });
});

// ───────────────────────── B 组：真 AgentHost + 回滚 ─────────────────────────

const CK1 = 'ck_1';

interface HostHarness {
  host: AgentHost;
  events: Array<{ channel: string; payload: Record<string, unknown> }>;
  runId(): string;
  start(): Promise<void>;
  waitTerminated(): Promise<boolean>;
  stepEvents(): StepRecord[];
  steps(): StepRecord[];
  /** 换掉 replayer 的返回值，用来验「只翻被撤的那些」 */
  setUndone(ids: string[]): void;
}

function makeHostHarness(): HostHarness {
  const registry = new ToolRegistry({} as unknown as ToolDeps);
  const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let runId = '';
  let hashSeq = 0;
  let undoneIds: string[] = [CK1];

  const spec: ToolSpec = {
    name: 'probe',
    displayName: '探针 probe',
    description: '仅用于测试：只读，但会回传一个带 checkpointId 的 changeSet。',
    params: [],
    danger: ToolDanger.Precise,
    reversible: false,
    maxAffectedBytes: 0,
    crossChapter: false,
    costHintMs: 1,
    idempotent: true,
    writes: false,
  };
  registry.registerExternal(spec.name, spec, async (): Promise<ToolResult> => {
    await sleep(2);
    return {
      ok: true,
      durationMs: 2,
      changeSet: {
        chapterId: '1',
        patches: [],
        edits: [EDIT],
        bytes: 8,
        checkpointId: CK1,
        dryRun: false,
      },
    };
  });

  const llm = {
    chat: async (req: { tools?: unknown[] }) => {
      if (Array.isArray(req.tools) && req.tools.length > 0) {
        return {
          content: '',
          toolCalls: [{ id: 't1', name: 'probe', args: {} }],
          usage: { input: 100, output: 50, wallMs: 5 },
          finishReason: 'tool_calls' as const,
        };
      }
      return {
        content: JSON.stringify({ goalRestated: '测试目标', steps: [{ index: 1, intent: '跑探针' }] }),
        toolCalls: [],
        usage: { input: 100, output: 50, wallMs: 5 },
        finishReason: 'stop' as const,
      };
    },
  };

  const deps = {
    registry,
    checkpoints: { requireCheckpoint: async () => CK1, commit: async () => undefined },
    replayer: {
      undoTo: async (): Promise<RollbackResult> => ({
        checkpointId: CK1,
        undone: 1,
        fromSeq: 1,
        toSeq: 1,
        lostManualEdits: 0,
        lostEdits: [],
        restoredChapters: ['1'],
        undoneCheckpointIds: undoneIds,
      }),
    },
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
      const id = (payload as { runId?: unknown }).runId;
      if (typeof id === 'string' && id) runId = id;
    },
    saveRun: (_s: RunState) => undefined,
  } as unknown as AgentHostDeps;

  const host = new AgentHost(deps);

  return {
    host,
    events,
    runId: () => runId,
    start: async () => {
      await host.start({ goal: '把第 1 章健康分提到 85', chapterIds: ['1'], budget: { maxSteps: 1 } });
    },
    waitTerminated: async () => {
      const t0 = Date.now();
      while (!events.some((e) => e.channel === 'agent:terminated')) {
        if (Date.now() - t0 > 3000) return false;
        await sleep(5);
      }
      return true;
    },
    stepEvents: () =>
      events
        .filter((e) => e.channel === 'agent:step')
        .map((e) => (e.payload as { step: StepRecord }).step),
    steps: () => host.getState(runId)?.steps ?? [],
    setUndone: (ids) => {
      undoneIds = ids;
    },
  };
}

describe('B. rolled-back：回滚落地后，被撤的那些步骤必须翻成 rolled-back', () => {
  it('回滚后那条带 checkpointId 的步骤状态变 rolled-back，并重推给渲染层', async () => {
    const h = makeHostHarness();
    await h.start();
    expect(await h.waitTerminated(), 'run 没跑到终止').toBe(true);
    expect(h.steps().map((s) => s.checkpointId), '前置条件：这一步得真有 checkpointId').toEqual([CK1]);
    expect(h.steps()[0].status).toBe('succeeded');

    const before = h.stepEvents().length;
    await h.host.rollbackTo(CK1, true);

    expect(h.steps()[0].status, '正文撤了，轨迹还说改动在（绿色 ✓）').toBe('rolled-back');
    const pushed = h.stepEvents().slice(before);
    expect(pushed, '只改内存不推事件＝界面永远不知道').toHaveLength(1);
    expect(pushed[0].stepNo).toBe(1);
    expect(pushed[0].status).toBe('rolled-back');
  });

  it('没被撤的 checkpoint 对应的步骤不许被顺手改掉', async () => {
    const h = makeHostHarness();
    await h.start();
    expect(await h.waitTerminated()).toBe(true);
    h.setUndone(['ck_别的']);

    const before = h.stepEvents().length;
    await h.host.rollbackTo(CK1, true);

    expect(h.steps()[0].status).toBe('succeeded');
    expect(h.stepEvents().slice(before), '把不相干的步骤也标成已回滚，是另一种谎报').toHaveLength(0);
  });

  it('重复回滚同一批 checkpoint 不许重复推事件', async () => {
    const h = makeHostHarness();
    await h.start();
    expect(await h.waitTerminated()).toBe(true);
    await h.host.rollbackTo(CK1, true);
    const before = h.stepEvents().length;
    await h.host.rollbackTo(CK1, true);
    expect(h.stepEvents().slice(before)).toHaveLength(0);
  });
});

// ───────────────────────── C 组：渲染层 store 的幂等 ─────────────────────────

/**
 * ★ 为什么必须一起改 store：第 27 条让同一步**推两次**（running → 终态，succeeded → rolled-back）。
 *   `appendStep` 的注释自称「幂等：同 stepNo 重复 push 时更新而非追加」，但 `stats.edits +=`
 *   与 `stats.checkpoints +=` 是**累加**，重推一次就把改动数翻倍。
 *   修复前这条不会被触发（每步只推一次），修完就是必然踩到——所以它是本条的一部分，不是顺手。
 */
describe('C. store：同一步重推不许把 edits / checkpoints 重复计数', () => {
  const running = (stepNo: number): StepRecord => ({
    stepNo,
    runId: 'run_C',
    phase: 'tool-call',
    status: 'running',
    toolName: 'probe',
    argsSummary: '{}',
    resultSummary: '正在执行…',
    durationMs: 0,
  });
  const final = (stepNo: number, status: StepRecord['status']): StepRecord => ({
    ...running(stepNo),
    status,
    durationMs: 3,
    edits: [EDIT, EDIT],
    checkpointId: CK1,
  });

  it('running → succeeded：一条记录，edits 计一次', () => {
    useAgentStore.getState().reset();
    useAgentStore.getState().appendStep(running(1));
    useAgentStore.getState().appendStep(final(1, 'succeeded'));
    const s = useAgentStore.getState();
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].status).toBe('succeeded');
    expect(s.stats.edits).toBe(2);
    expect(s.stats.checkpoints).toBe(1);
  });

  it('succeeded → rolled-back 重推：状态翻了，计数不许再翻', () => {
    useAgentStore.getState().reset();
    useAgentStore.getState().appendStep(running(1));
    useAgentStore.getState().appendStep(final(1, 'succeeded'));
    useAgentStore.getState().appendStep(final(1, 'rolled-back'));
    const s = useAgentStore.getState();
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].status).toBe('rolled-back');
    expect(s.stats.edits, '重推一次就把改动数翻倍').toBe(2);
    expect(s.stats.checkpoints, '重推一次就把快照数翻倍').toBe(1);
  });

  it('不同步骤照常累加（别把幂等做成「只认第一条」）', () => {
    useAgentStore.getState().reset();
    useAgentStore.getState().appendStep(final(1, 'succeeded'));
    useAgentStore.getState().appendStep(final(2, 'failed'));
    const s = useAgentStore.getState();
    expect(s.steps).toHaveLength(2);
    expect(s.stats.edits).toBe(4);
    expect(s.stats.checkpoints).toBe(2);
    expect(s.stats.steps).toBe(2);
  });
});

// ───────────────────────── D 组：装配哨兵 ─────────────────────────

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 去掉行注释后再匹配，免得断言匹配到自己写的解释 */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

describe('D. 哨兵：三条回滚入口都必须经过 host（否则 rolled-back 又被绕过）', () => {
  it('RollbackResult 必须报出「到底撤了哪几个 checkpoint」', () => {
    const src = read('../../src/shared/types/checkpoint.ts');
    expect(src, '只有 undone 计数的话，host 无从知道该翻哪几条 StepRecord').toMatch(
      /undoneCheckpointIds\s*:\s*string\[\]/,
    );
    const rep = codeOnly(read('../../src/main/checkpoint/replayer.ts'));
    expect(rep.match(/undoneCheckpointIds/g)?.length ?? 0, 'undoTo 两个返回分支都得带上').toBeGreaterThanOrEqual(2);
  });

  it('checkpoint:undo 不许再自己直连 replayer（那正是 rolled-back 零产出方的原因）', () => {
    const src = codeOnly(read('../../src/main/ipc/register.ts'));
    const block = src.slice(src.indexOf("'checkpoint:undo'"), src.indexOf("'checkpoint:undo'") + 400);
    expect(block).toMatch(/agentHost\.rollbackTo/);
    expect(block, '绕过 host 就没人翻 StepRecord.status').not.toMatch(/replayer\.undoTo/);
  });

  it('undo 工具的 undoToCheckpoint 同样必须经过 host', () => {
    const src = codeOnly(read('../../src/main/services.ts'));
    const i = src.indexOf('undoToCheckpoint:');
    const block = src.slice(i, i + 300);
    expect(block).toMatch(/agentHost\.rollbackTo/);
    expect(block, '两条入口各发一次 checkpoint:rolled-back＝渲染层重复刷新').not.toMatch(/checkpoint:rolled-back/);
  });

  it('host 里 rollbackTo 之后必须去翻步骤状态', () => {
    const src = codeOnly(read('../../src/main/agent/host.ts'));
    const i = src.indexOf('async rollbackTo(');
    expect(i, 'rollbackTo 不见了').toBeGreaterThan(0);
    expect(src.slice(i, i + 700)).toMatch(/markStepsRolledBack/);

    const j = src.indexOf('private markStepsRolledBack(');
    expect(j, '翻状态的方法不见了').toBeGreaterThan(0);
    const body = src.slice(j, j + 1000);
    expect(body).toMatch(/status: 'rolled-back'/);
    expect(body, '只改内存不推事件＝界面永远不知道').toMatch(/emit\('agent:step'/);
    expect(body, '已经是 rolled-back 的不许再推一次').toMatch(/=== 'rolled-back'/);
  });

  it('loop 必须在 execute 之前落一条 running，并且异常路径要把它收掉', () => {
    const src = codeOnly(read('../../src/main/agent/loop.ts'));
    expect(src).toMatch(/status: 'running'/);
    const execAt = src.indexOf('await this.deps.execute(');
    const runningAt = src.indexOf("status: 'running'");
    expect(runningAt, 'running 记录必须在 execute 之前就推出去').toBeGreaterThan(0);
    expect(src.lastIndexOf('pushRunningStep', execAt), 'execute 前没有 pushRunningStep 调用').toBeGreaterThan(0);
    expect(src).toMatch(/failRunningStep/);
  });

  it('渲染层：running 那条占位事件不许白跑一次体检重算', () => {
    const src = codeOnly(read('../../src/renderer/hooks/use-agent-stream.ts'));
    const i = src.indexOf("onAgentEvent('agent:step'");
    expect(i, 'agent:step 的订阅不见了').toBeGreaterThan(0);
    const block = src.slice(i, i + 700);
    expect(block).toMatch(/appendStep\(/);
    // ★ 每步现在推两次事件：占位那次正文一个字都没动，为它跑 health.analyze 纯属白烧。
    //   断言的是**顺序**（早退在刷新之前），只断言「出现过」会被一句注释糊过去。
    const guard = block.indexOf("status === 'running'");
    const refresh = block.indexOf('refreshChapterAnalysis(');
    expect(guard, '没有对 running 早退').toBeGreaterThan(0);
    expect(refresh).toBeGreaterThan(0);
    expect(guard, 'running 的早退必须在触发体检之前').toBeLessThan(refresh);
  });

  it('渲染层的两个分支与样式仍在（第 22 条②画的，本条才让它们真的能被渲染到）', () => {
    const tsx = read('../../src/renderer/components/agent/AgentPanel.tsx');
    expect(tsx).toMatch(/step\.status === 'running'/);
    expect(tsx).toMatch(/step\.status === 'rolled-back'/);
    const css = read('../../src/renderer/components/agent/AgentPanel.module.css');
    expect(css).toMatch(/\.step\.running\s*\{/);
    expect(css).toMatch(/\.step\.rolled-back\s*\{/);
  });
});
