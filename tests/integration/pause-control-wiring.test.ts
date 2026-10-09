/**
 * §4 第 25 条：第 24 条把暂停闸门接通了，但**用户按不到**——
 *
 * ★ 实测到的修复前事实：
 *   - `grep -rni pause src/renderer` **零命中**：`preload/index.ts:114` 的桥、
 *     `register.ts:449` 的 handler、`host.ts` 的闸门全都齐了，界面上一颗按钮都没有。
 *   - 更糟的是**状态报不回来**：`useAgentStore.setStatus`（`store/index.ts:196/257`）
 *     全仓**零调用方**，`status` 只在 `setRun` 里写死 `'planning'`、
 *     在 `setTermination` 里写死 `'terminated'`。也就是说渲染层对
 *     「暂停中」这个 RunStatus 成员**既没有来源也没有出口**。
 *   - 14 条 push 通道里没有任何一条带 run 阶段，所以就算加了按钮，
 *     点了之后界面也只会显示「正在跑」。
 *
 * 本文件钉的是**通道与调用点**：清单三处齐不齐、loop 报不报、host 转不转、
 * 渲染层订阅不订阅、按钮调不调。行为本身由 `pause-gate-wiring.test.ts` D 组
 * （真 AgentHost + 真 AgentLoop）负责，两边不重复。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { IPC_PUSH_CHANNELS, type IpcPushMap } from '@shared/types/ipc';
import { SUBSCRIBE_CHANNELS } from '../../src/preload/api';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const loopSrc = read('../../src/main/agent/loop.ts');
const hostSrc = read('../../src/main/agent/host.ts');
const streamSrc = read('../../src/renderer/hooks/use-agent-stream.ts');
const panelSrc = read('../../src/renderer/components/agent/AgentPanel.tsx');
const storeSrc = read('../../src/renderer/store/index.ts');
const ipcSrc = read('../../src/shared/types/ipc.ts');

/** `IpcPushMap` 的键（接口是纯类型，只能按声明行提取） */
function pushMapKeys(): string[] {
  const i = ipcSrc.indexOf('export interface IpcPushMap');
  const j = ipcSrc.indexOf('export const IPC_PUSH_CHANNELS');
  if (i < 0 || j < 0 || j <= i) throw new Error('IpcPushMap 段落定位失败，测试自身要修');
  return [...ipcSrc.slice(i, j).matchAll(/^ {2}'([a-z:-]+)':/gm)].map((m) => m[1]!);
}

describe('A. 通道清单必须三处齐备（少一处就是运行时静默丢弃）', () => {
  it('agent:phase 在类型、主进程清单、preload 订阅白名单里都存在', () => {
    // 这一行本身是编译期钉子：IpcPushMap 里没有这个键就过不了 typecheck
    type PhasePayload = IpcPushMap['agent:phase'];
    const probe: PhasePayload = { runId: 'r1', phase: 'paused' };
    expect(probe.runId).toBe('r1');
    expect(IPC_PUSH_CHANNELS as readonly string[]).toContain('agent:phase');
    // preload 的 SUBSCRIBE_SET 是**硬闸**：不在表里 subscribe 直接抛错
    expect(SUBSCRIBE_CHANNELS as readonly string[]).toContain('agent:phase');
  });

  it('三份清单必须一模一样长（第 22 条③的口径教训：数字要能自己核对）', () => {
    const keys = pushMapKeys();
    expect(keys.length).toBeGreaterThan(10);
    expect([...IPC_PUSH_CHANNELS].sort()).toEqual([...keys].sort());
    expect([...SUBSCRIBE_CHANNELS].sort()).toEqual([...keys].sort());
  });
});

describe('B. 主进程必须真的把阶段报出来', () => {
  it('loop 只在「挂住」与「放走」两处报 phase，一处都不许多', () => {
    // 只数真正的 emit 调用；类型声明里那个 `type: 'phase'` 是联合类型的成员，不是事件
    const emits = [...loopSrc.matchAll(/\.emit\(\{ type: 'phase'/g)].length;
    expect(emits, 'phase 事件多了就是刷屏噪声，少了就是又变空线').toBe(2);
  });

  it('host 必须把 loop 事件转成 agent:phase 推给渲染层', () => {
    expect(hostSrc).toMatch(/case 'phase':/);
    expect(hostSrc).toMatch(/emit\('agent:phase'/);
  });
});

describe('C. 渲染层必须订阅并落到 store（setStatus 此前零调用方）', () => {
  it('use-agent-stream 订阅 agent:phase 并调 setStatus', () => {
    expect(streamSrc).toMatch(/onAgentEvent\('agent:phase'/);
    expect(streamSrc).toMatch(/setStatus\(/);
    // 取消订阅也必须登记，否则热重载会叠出双份监听
    expect(streamSrc).toMatch(/offPhase\(\)/);
  });

  it('store 的 setStatus 必须真有调用方（不许又留一条只定义不用的线）', () => {
    // 修复前的形状：store 里声明 + 实现都在，src 全仓 grep 不到第三个调用点
    expect(storeSrc).toMatch(/setStatus: \(st\) =>/);
    const callers = read('../../src/renderer/hooks/use-agent-stream.ts');
    expect(callers, 'setStatus 仍然只定义不用').toMatch(/setStatus\(/);
  });
});

describe('D. 面板上必须真有两颗按钮，且三态不许合并', () => {
  it('AgentPanel 必须调用 pause 与 resume', () => {
    expect(panelSrc).toMatch(/agent\.pause\(/);
    expect(panelSrc).toMatch(/agent\.resume\(/);
  });

  it('叫停与暂停是两个不同的动作，图标与按钮各一套', () => {
    expect(panelSrc).toMatch(/styles\.abortBtn/);
    expect(panelSrc).toMatch(/styles\.pauseBtn/);
    // ⏸ 归暂停；叫停不再借用 ⏸（两颗按钮同一个图标＝用户按错哪个都一样）
    expect(panelSrc).not.toMatch(/⏸ 叫停/);
    expect(panelSrc).toMatch(/⏸ 暂停/);
  });

  it('新按钮的样式类必须真的存在（第 20 条①栽过的静默失效）', () => {
    const css = read('../../src/renderer/components/agent/AgentPanel.module.css');
    expect(css).toMatch(/\.pauseBtn\s*\{/);
  });

  it('按钮状态必须来自报回来的真值，而不是本地猜', () => {
    expect(panelSrc).toMatch(/=== 'paused'/);
  });
});
