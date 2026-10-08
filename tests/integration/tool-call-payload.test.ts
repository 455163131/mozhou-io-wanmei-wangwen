/**
 * ★ `agent:tool-call` 的 danger / writePolicy 必须是真值 —— 事件载荷装配测试。
 *
 * 为什么单独开一个文件：
 *
 *   修复前 `loop.ts` 发事件时把两个字段写死：
 *
 *       danger: 1,                      // = ToolDanger.Precise「快照可精确还原、零外溢」
 *       writePolicy: 'auto-with-undo',  // = 老板选的默认策略
 *
 *   而工具的 `spec.danger` 从 1 到 5（Spillover/CrossScope/Irreversible/Destructive），
 *   用户也可能在设置里把策略切成 preview-only 或 ask-per-tool。于是每个 run 的每一步
 *   都在**最低报回滚成本**（★2~★5 一律报成 ★1）、**谎报写策略**。
 *
 *   这与已修的闸门②（§4 第 0 条）、判据 B 账本（§4 第 9 条）是同一个失败模式：
 *   真值就在手边（registry 里有 spec、host 里已解析 writePolicy），发射点没去取。
 *
 * 本文件起**真的 AgentHost**（假 LlmClient 只负责选工具），
 * 断言的是对外事件载荷本身 —— 不测内部函数，测「渲染层会收到什么」。
 */
import { describe, it, expect } from 'vitest';
import { AgentHost, type AgentHostDeps } from '@main/agent/host';
import { ToolRegistry, type ToolDeps } from '@main/tools/registry';
import {
  ToolDanger,
  type ToolSpec,
  type WritePolicyConfig,
} from '@shared/types/tool';
import { DEFAULT_WRITE_POLICY } from '@shared/constants/checkpoint';
import { PROVIDERS } from '@shared/constants/providers';
import type { RunState } from '@shared/types/agent';

const USAGE = { input: 100, output: 50, wallMs: 5 };

/** 只读探针工具：写工具会走 checkpoint / 审批分支，徒增装配复杂度 */
function probeSpec(name: string, danger: ToolDanger): ToolSpec {
  return {
    name,
    displayName: `探针 ${name}`,
    description: '仅用于测试：不做任何事，直接返回成功。',
    params: [],
    danger,
    reversible: false,
    maxAffectedBytes: 0,
    crossChapter: false,
    costHintMs: 1,
    idempotent: true,
    writes: false,
  };
}

interface Harness {
  host: AgentHost;
  events: Array<{ channel: string; payload: Record<string, unknown> }>;
  /** 本次 run 收到的 tool-call 事件载荷 */
  toolCalls(): Array<Record<string, unknown>>;
  run(opts?: { budget?: { maxSteps?: number }; writePolicy?: WritePolicyConfig }): Promise<void>;
}

/**
 * 装一个跑单步的 AgentHost。`llm` 选工具时固定返回 spec 这个名字，
 * 其余全部走真实实现（真 registry、真 loop、真 sandbox、真事件转发）。
 */
function makeHost(spec: ToolSpec): Harness {
  const registry = new ToolRegistry({} as unknown as ToolDeps);
  registry.registerExternal(spec.name, spec, async () => ({ ok: true, data: { done: true }, durationMs: 1 }));

  const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let hashSeq = 0;

  const llm = {
    chat: async (req: { tools?: unknown[] }) => {
      if (Array.isArray(req.tools) && req.tools.length > 0) {
        return {
          content: '',
          toolCalls: [{ id: 't1', name: spec.name, args: {} }],
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
    // 每步指纹都变，避免判据 B 先以 no-effect 终止（那会让本用例测不到 tool-call 事件）
    stateHash: async () => `h${hashSeq++}`,
    conflicts: () => [],
    emit: (channel: string, payload: unknown) => {
      events.push({ channel, payload: payload as Record<string, unknown> });
    },
    saveRun: (_s: RunState) => undefined,
  } as unknown as AgentHostDeps;

  const host = new AgentHost(deps);
  const h: Harness = {
    host,
    events,
    toolCalls: () => events.filter((e) => e.channel === 'agent:tool-call').map((e) => e.payload),
    run: async (opts) => {
      await host.start({
        goal: '把第 1 章健康分提到 85',
        chapterIds: ['1'],
        ...(opts?.budget ? { budget: opts.budget } : {}),
        ...(opts?.writePolicy ? { writePolicy: opts.writePolicy } : {}),
      });
      // start() 立即返回、后台跑；轮询到 run 结束
      const t0 = Date.now();
      while (!events.some((e) => e.channel === 'agent:terminated')) {
        if (Date.now() - t0 > 8000) throw new Error('run 未终止；事件：' + events.map((e) => e.channel).join(','));
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
  return h;
}

describe('★ agent:tool-call 的 danger 必须是该工具声明的回滚成本', () => {
  it('跨章工具（CrossScope=3）不许被报成 ★1', async () => {
    const h = makeHost(probeSpec('probe_cross', ToolDanger.CrossScope));
    await h.run({ budget: { maxSteps: 1 } });

    const calls = h.toolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('probe_cross');
    // 修复前恒为 1：把「回滚粒度按章」的跨章操作报成「快照精确到字节、零外溢」
    expect(calls[0].danger).toBe(ToolDanger.CrossScope);
  });

  it('破坏性工具（Destructive=5）与外溢工具（Spillover=2）各报各的', async () => {
    const hi = makeHost(probeSpec('probe_destructive', ToolDanger.Destructive));
    await hi.run({ budget: { maxSteps: 1 } });
    expect(hi.toolCalls()[0].danger).toBe(ToolDanger.Destructive);

    const lo = makeHost(probeSpec('probe_spill', ToolDanger.Spillover));
    await lo.run({ budget: { maxSteps: 1 } });
    expect(lo.toolCalls()[0].danger).toBe(ToolDanger.Spillover);
  });

  it('★ 同一份代码，danger 随工具变（证明取的是 registry 而不是常量）', async () => {
    const precise = makeHost(probeSpec('probe_precise', ToolDanger.Precise));
    await precise.run({ budget: { maxSteps: 1 } });
    expect(precise.toolCalls()[0].danger).toBe(ToolDanger.Precise);

    const irr = makeHost(probeSpec('probe_irr', ToolDanger.Irreversible));
    await irr.run({ budget: { maxSteps: 1 } });
    expect(irr.toolCalls()[0].danger).toBe(ToolDanger.Irreversible);
  });
});

describe('★ agent:tool-call 的 writePolicy 必须是本次 run 生效的策略', () => {
  it('用户切成 ask-per-tool 后，事件里不许还写着 auto-with-undo', async () => {
    const h = makeHost(probeSpec('probe_ask', ToolDanger.Precise));
    await h.run({
      budget: { maxSteps: 1 },
      writePolicy: {
        policy: 'ask-per-tool',
        autoApproveThreshold: ToolDanger.Spillover,
        hardStopThreshold: ToolDanger.Irreversible,
      },
    });

    const calls = h.toolCalls();
    expect(calls).toHaveLength(1);
    // 修复前恒为 'auto-with-undo'（老板默认值被硬编码成唯一值）
    expect(calls[0].writePolicy).toBe('ask-per-tool');
  });

  it('用户切到 preview-only 后，事件里报的也必须是 preview-only', async () => {
    const h = makeHost(probeSpec('probe_preview', ToolDanger.Precise));
    await h.run({
      budget: { maxSteps: 1 },
      writePolicy: {
        ...DEFAULT_WRITE_POLICY,
        policy: 'preview-only',
      },
    });

    expect(h.toolCalls()[0].writePolicy).toBe('preview-only');
  });
});
