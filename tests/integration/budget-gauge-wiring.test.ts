/**
 * §4 第 32 条：Agent 跑到预算边界只会**突然停**，界面上看不到「还剩几步 / 多少
 * token / 多少钱」。
 *
 * ★ 实测到的修复前事实（三条，逐条对应本文件的 A/B/C 组）：
 *   1. `budget-guard.ts:184-194` 的 `remaining()` 注释写着「剩余预算，**供 UI
 *      预算仪表显示**」，`loop.ts:114-117` 的 `get limits()` 注释写着「预算上限，
 *      **供 UI 预算仪表展示**」——两级注释都写着给 UI，而
 *      `rg '\.remaining\('` 全仓只有 `loop.ts` 自己那处定义，**没有任何调用方**。
 *   2. 结构上根本过不去：`RunState` 没有预算字段，而 `agent:state`
 *      （拉通道）是唯一出口，偏偏 `rg '\.state\(' src/renderer` **零命中**——
 *      渲染层从头到尾没拉过一次。所以预算必须**推**，不能指望它来拉。
 *   3. `AgentPanel.tsx:284-294` 那句注释写着「预算仪表：实时可见」，实际显示的是
 *      **四个"已用"**（步数 / 工具调用 / 改动 / 耗时或花费），**一个"还剩"都没有**。
 *      `DEFAULT_BUDGET = { maxSteps: 24, maxTokens: 200_000, maxCostCny: 5.0,
 *      maxWallMs: 2h }`，用户每次开跑都不知道这些上限存在。
 *      而 `use-mz-bridge.ts:76` 的引导文案还写着「已做的改动保留，**可继续**」——
 *      **从没说还能继续多少**。
 *
 * 本文件钉的是**通道与调用点**（清单齐不齐、loop 报不报、host 转不转、渲染层
 * 订阅不订阅、仪表读不读真值），不重复验算法——`remaining()` 的数值边界由
 * `budget-guard.test.ts` 负责。
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
const panelCss = read('../../src/renderer/components/agent/AgentPanel.module.css');
const storeSrc = read('../../src/renderer/store/index.ts');
const typesSrc = read('../../src/shared/types/agent.ts');
const ipcSrc = read('../../src/shared/types/ipc.ts');

/** `IpcPushMap` 的键（接口是纯类型，只能按声明行提取） */
function pushMapKeys(): string[] {
  const i = ipcSrc.indexOf('export interface IpcPushMap');
  const j = ipcSrc.indexOf('export const IPC_PUSH_CHANNELS');
  if (i < 0 || j < 0 || j <= i) throw new Error('IpcPushMap 段落定位失败，测试自身要修');
  return [...ipcSrc.slice(i, j).matchAll(/^ {2}'([a-z:-]+)':/gm)].map((m) => m[1]!);
}

/** 取某段源码的局部窗口，避免「全文命中即通过」这种最容易骗过人的断言 */
function blockOf(src: string, anchor: string, len: number): string {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`锚点未找到：${anchor}`);
  return src.slice(i, i + len);
}

describe('A. 通道清单必须三处齐备（少一处就是运行时静默丢弃）', () => {
  it('agent:budget 在类型、主进程清单、preload 订阅白名单里都存在', () => {
    // 这一行本身是编译期钉子：IpcPushMap 里没有这个键就过不了 typecheck
    type BudgetPayload = IpcPushMap['agent:budget'];
    const probe: BudgetPayload = {
      runId: 'r1',
      budget: {
        maxSteps: 24,
        maxTokens: 200_000,
        maxCostCny: 5,
        maxWallMs: 7_200_000,
        stepsLeft: 20,
        tokensLeft: 190_000,
        costLeftCny: 4.5,
      },
    };
    expect(probe.budget.stepsLeft).toBe(20);
    expect(IPC_PUSH_CHANNELS as readonly string[]).toContain('agent:budget');
    // preload 的 SUBSCRIBE_SET 是**硬闸**：不在表里 subscribe 直接抛错
    expect(SUBSCRIBE_CHANNELS as readonly string[]).toContain('agent:budget');
  });

  it('三份清单必须一模一样长（第 22 条③的口径教训：数字要能自己核对）', () => {
    const keys = pushMapKeys();
    expect(keys).toContain('agent:budget');
    expect([...IPC_PUSH_CHANNELS].sort()).toEqual([...keys].sort());
    expect([...SUBSCRIBE_CHANNELS].sort()).toEqual([...keys].sort());
  });
});

describe('B. 主进程必须真的把预算算出来并报出去', () => {
  it('RunState 必须带上预算——否则它在结构上就出不了主进程', () => {
    // 修复前 RunState 的字段里没有任何预算，`agent:state` 拉走的也只是一堆"已用"
    const i = typesSrc.indexOf('export interface RunState');
    const block = blockOf(typesSrc, 'export interface RunState', 900);
    expect(i).toBeGreaterThan(0);
    expect(block).toMatch(/budget: RunBudget \| null/);
    // 上限与剩余必须在同一个类型里：仪表要显示「8 / 24」，只给剩余则分母无处来
    expect(blockOf(typesSrc, 'export interface RunBudget', 900)).toMatch(/maxSteps/);
    expect(blockOf(typesSrc, 'export interface RunBudget', 900)).toMatch(/stepsLeft/);
  });

  it('`Infinity` 必须在主进程就归一成 null，不许让渲染层猜', () => {
    // 本地模型 costLeftCny 是 Infinity，而 structured clone 会把 Infinity 变 null；
    // 这里显式做，是为了让「本地模型没有成本闸门」这件事在类型上就写死
    expect(blockOf(loopSrc, 'private budgetSnapshot()', 500)).toMatch(
      /Number\.isFinite\(left\.costLeftCny\) \? left\.costLeftCny : null/,
    );
  });

  it('loop 必须把 budget 挂进 state，并在报步数时顺手报一次预算', () => {
    // `state` 里带一份：`agent:state` 拉通道能拿到完整快照
    expect(blockOf(loopSrc, 'get state(): RunState', 700)).toMatch(/budget: this\.budgetSnapshot\(\)/);
    // `upsertStep` 里推一份：步事件正是用量会变的时刻（`addUsage` 一步能调好几次，
    // 挂那儿会一步推多帧）
    expect(blockOf(loopSrc, 'private upsertStep', 800)).toMatch(
      /\.emit\(\{ type: 'budget', runId: this\.runId, budget: this\.budgetSnapshot\(\) \}\)/,
    );
  });

  it('host 必须把 loop 事件转成 agent:budget 推给渲染层', () => {
    expect(hostSrc).toMatch(/case 'budget':/);
    expect(hostSrc).toMatch(/emit\('agent:budget'/);
  });
});

describe('C. 渲染层必须订阅、落到 store、并在仪表上读真值', () => {
  it('use-agent-stream 订阅 agent:budget 并调 setBudgetState，且登记退订', () => {
    expect(streamSrc).toMatch(/onAgentEvent\('agent:budget'/);
    expect(streamSrc).toMatch(/setBudgetState\(/);
    // 取消订阅也必须登记，否则热重载会叠出双份监听
    expect(streamSrc).toMatch(/offBudget\(\)/);
  });

  it('store 必须真有 budget 这一格，且 setBudgetState 有实现', () => {
    expect(storeSrc).toMatch(/budget: RunBudget \| null/);
    expect(storeSrc).toMatch(/setBudgetState: \(b\) =>/);
  });

  it('★ 终止时不许清空预算——那正是用户最需要看到它的一刻', () => {
    // `BUDGET_EXCEEDED` 砸下来的当下，用户要知道「刚才撞的是哪一档、还剩多少」；
    // 把仪表擦干净等于把解释一起擦掉。`reset()` 里清空是对的（换项目了），
    // `setTermination` 里清空就是错的。
    // ★ 锚点必须用**实现体**那行：接口签名区里的 `setTermination: (t: ...) => void;`
    //   会先被 `indexOf` 命中，量出来的是 10 行声明，断言等于没写。
    const term = blockOf(storeSrc, 'setTermination: (t, stats, kept) =>', 700);
    expect(term).not.toMatch(/s\.budget = null/);
    // 反向验：`setRun` 必须清——新 run 开跑时留着上一条的剩余量会显示错数
    expect(blockOf(storeSrc, 'setRun: (runId, goal) =>', 700)).toMatch(/s\.budget = null/);
  });

  it('AgentPanel 的仪表必须读主进程报回来的 budget，而不是 store 里那份手抄默认值', () => {
    const gauge = blockOf(panelSrc, 'function BudgetGauge()', 2400);
    expect(gauge).toMatch(/useAgentStore\(\(s\) => s\.budget\)/);
    // 真值来自 budget 的 max*：分母必须是主进程报的，不是 SettingsState.budget
    expect(gauge).toMatch(/budget\.maxSteps/);
    expect(gauge).toMatch(/budget\.maxTokens/);
    // 「已用 / 上限」这个形状才是修复前缺的东西（以前只有已用）
    expect(gauge).toMatch(/stats\.steps\} \/ \{budget\.maxSteps\}/);
  });

  it('没有活着的 run 时不许摆一副空刻度盘', () => {
    // budget 为 null 时说清楚「开跑后出现」，而不是渲染 0 / 24 骗人
    expect(blockOf(panelSrc, 'function BudgetGauge()', 2400)).toMatch(
      /if \(!budget\)[\s\S]{0,200}budgetHint/,
    );
  });

  it('逼近上限必须明说——这就是修复前缺的那句话', () => {
    const gauge = blockOf(panelSrc, 'function BudgetGauge()', 3000);
    expect(gauge).toMatch(/budgetWarn/);
    expect(gauge).toMatch(/接近上限/);
    expect(gauge).toMatch(/已达上限/);
    // 阈值必须是单调的两档，不许只做一档
    expect(gauge).toMatch(/worst >= 1 \? 'danger'/);
    expect(gauge).toMatch(/worst >= 0\.8 \? 'warn'/);
  });

  it('新加的样式类必须真的存在（第 20 条①栽过的静默失效）', () => {
    for (const cls of ['budgetHint', 'budgetCell', 'budgetLabel', 'budgetValue', 'budgetWarn']) {
      expect(panelCss, `.${cls} 在 CSS 里没有定义`).toMatch(new RegExp(`\\.${cls}\\s*\\{`));
    }
    // 两档色必须落在 token 上（裸 hex 会被 form-controls / theme-ink 测试判红）
    expect(panelCss).toMatch(/\[data-tone='warn'\]/);
    expect(panelCss).toMatch(/\[data-tone='danger'\]/);
  });
});
