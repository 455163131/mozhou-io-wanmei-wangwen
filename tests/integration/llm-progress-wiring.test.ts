/**
 * ★ E批「模型思考过程可见」钉④：接线哨兵（R46 源扫描口径，照 longterm-view-wiring 模式）。
 *
 * 老板报障：「只是按钮显示抽卡中，卡一晚上我也不知道他到底在干什么」。
 * 修复链路：parseStream 转发增量 → 服务层 onProgress 播报 → push 'llm:progress'
 * → 渲染层 useLlmProgress → 两页状态条。任何一环没接上，用户看到的就还是
 * 干巴巴的「抽卡中…」——本文件逐环钉死。
 *
 * 诚实纪律锚：
 *   - 状态条不许捏造进度（没事件时说「连接模型」而不是假百分比）；
 *   - provider 没回 reasoning_content 时明示「该模型未返回思考内容」，绝不编思考；
 *   - fallback 必须把真因（note）显示出来；
 *   - 不回归 ccb2ea2：SHORT_OUTPUT_BUDGET 仍在两条短产出路径上传参。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { IPC_PUSH_CHANNELS, type IpcPushMap } from '@shared/types/ipc';
import { SUBSCRIBE_CHANNELS } from '../../src/preload/api';

const read = (rel: string): string => readFileSync(rel, 'utf8').replace(/\r\n/g, '\n');

const ipcSrc = read('src/shared/types/ipc.ts');
const providerSrc = read('src/shared/types/provider.ts');
const clientSrc = read('src/main/llm/client.ts');
const toolsSrc = read('src/main/pipeline/tools.ts');
const ideaSrc = read('src/main/inspiration/idea-service.ts');
const teardownSrc = read('src/main/inspiration/teardown-service.ts');
const servicesSrc = read('src/main/services.ts');
const hookSrc = read('src/renderer/hooks/use-llm-progress.ts');
const stripSrc = read('src/renderer/components/common/LlmProgressStrip.tsx');
const ideaView = read('src/renderer/components/views/IdeaDrawView.tsx');
const teardownView = read('src/renderer/components/views/TeardownView.tsx');

/** `IpcPushMap` 的键（接口是纯类型，只能按声明行提取；同 budget-gauge-wiring 口径） */
function pushMapKeys(): string[] {
  const i = ipcSrc.indexOf('export interface IpcPushMap');
  const j = ipcSrc.indexOf('export const IPC_PUSH_CHANNELS');
  if (i < 0 || j < 0 || j <= i) throw new Error('IpcPushMap 段落定位失败，测试自身要修');
  return [...ipcSrc.slice(i, j).matchAll(/^ {2}'([a-z:-]+)':/gm)].map((m) => m[1]!);
}

describe('A. 推送通道三处齐备（少一处就是运行时静默丢弃）', () => {
  it('llm:progress 在类型、主进程清单、preload 订阅白名单里都存在', () => {
    // 编译期钉子：IpcPushMap 里没有这个键就过不了 typecheck
    type ProgressPayload = IpcPushMap['llm:progress'];
    const probe: ProgressPayload = {
      scope: 'idea',
      phase: 'thinking',
      attempt: 1,
      elapsedMs: 1200,
      charsSeen: 42,
      thought: '尾部片段',
    };
    expect(probe.scope).toBe('idea');
    expect(IPC_PUSH_CHANNELS as readonly string[]).toContain('llm:progress');
    expect(SUBSCRIBE_CHANNELS as readonly string[]).toContain('llm:progress');
  });

  it('三份清单必须一模一样长（17→18，数字要能自己核对）', () => {
    const keys = pushMapKeys();
    expect(keys).toContain('llm:progress');
    expect(IPC_PUSH_CHANNELS).toHaveLength(18);
    expect([...IPC_PUSH_CHANNELS].sort()).toEqual([...keys].sort());
    expect([...SUBSCRIBE_CHANNELS].sort()).toEqual([...keys].sort());
  });
});

describe('B. 主进程链路：类型 → 客户端转发 → 服务播报 → push 出口', () => {
  it('LlmProgress 共享类型：scope/phase/attempt/elapsedMs/charsSeen 必备，thought/note 可选', () => {
    expect(providerSrc).toMatch(/export interface LlmProgress \{/);
    expect(providerSrc).toMatch(/scope: 'idea' \| 'teardown'/);
    expect(providerSrc).toMatch(/phase: 'start' \| 'thinking' \| 'writing' \| 'retry' \| 'done' \| 'error' \| 'fallback'/);
    expect(providerSrc).toMatch(/attempt: number/);
    expect(providerSrc).toMatch(/elapsedMs: number/);
    expect(providerSrc).toMatch(/charsSeen: number/);
    expect(providerSrc).toMatch(/thought\?: string/);
    expect(providerSrc).toMatch(/note\?: string/);
    // ChatRequest 增量回调
    expect(providerSrc).toMatch(/onDelta\?: \(d: \{ content\?: string; reasoning\?: string \}\) => void/);
  });

  it('parseStream 转发 content 与 reasoning_content（含 reasoning 别名），且不混进累积正文', () => {
    expect(clientSrc).toMatch(/reasoning_content/);
    expect(clientSrc).toMatch(/onDelta/);
  });

  it('PipelineLlm.chat 契约放行 stream + onDelta（结构接口不加就过不了 typecheck）', () => {
    const i = toolsSrc.indexOf('export interface PipelineLlm');
    expect(i).toBeGreaterThanOrEqual(0);
    const block = toolsSrc.slice(i, i + 900);
    expect(block).toMatch(/stream\?: boolean/);
    expect(block).toMatch(/onDelta\?:/);
  });

  it('drawIdea/teardownRead：stream:true + onDelta + onProgress 播报', () => {
    expect(ideaSrc).toMatch(/stream: true/);
    expect(ideaSrc).toMatch(/onDelta/);
    expect(ideaSrc).toMatch(/onProgress\?: \(p: LlmProgress\) => void/);
    expect(teardownSrc).toMatch(/stream: true/);
    expect(teardownSrc).toMatch(/onDelta/);
    expect(teardownSrc).toMatch(/onProgress\?: \(p: LlmProgress\) => void/);
  });

  it('不回归 ccb2ea2：两条短产出路径仍传 SHORT_OUTPUT_BUDGET 紧预算', () => {
    expect(ideaSrc).toMatch(/timeoutMs: SHORT_OUTPUT_BUDGET\.timeoutMs/);
    expect(ideaSrc).toMatch(/maxRetries: SHORT_OUTPUT_BUDGET\.maxRetries/);
    expect(teardownSrc).toMatch(/timeoutMs: SHORT_OUTPUT_BUDGET\.timeoutMs/);
    expect(teardownSrc).toMatch(/maxRetries: SHORT_OUTPUT_BUDGET\.maxRetries/);
  });

  it("services.ts 把 onProgress 接到唯一推送出口 push.send('llm:progress'", () => {
    const hits = servicesSrc.match(/this\.push\.send\('llm:progress'/g) ?? [];
    expect(hits.length, 'ideaDeps 与 teardownDeps 各接一次').toBeGreaterThanOrEqual(2);
  });
});

describe('C. 渲染层链路：hook 订阅 → 两页状态条 → 诚实文案', () => {
  it('use-llm-progress 订阅 llm:progress、按 scope 过滤、卸载清理', () => {
    expect(hookSrc).toMatch(/onAgentEvent\('llm:progress'/);
    expect(hookSrc).toMatch(/p\.scope !== scope/);
    expect(hookSrc).toMatch(/clearInterval/);
    // 渲染层自己走秒：两次事件之间数字也得动
    expect(hookSrc).toMatch(/setInterval/);
  });

  it('状态条文案诚实：等待秒数/阶段/已接收字数/思考缺席明示，绝无假百分比', () => {
    expect(stripSrc).toMatch(/已等待/);
    expect(stripSrc).toMatch(/连接模型/);
    expect(stripSrc).toMatch(/模型思考中/);
    expect(stripSrc).toMatch(/正在产出/);
    expect(stripSrc).toMatch(/已接收/);
    // provider 没回 reasoning_content 时如实说没有，绝不编造思考
    expect(stripSrc).toMatch(/该模型未返回思考内容/);
    // thought 只是尾部片段，不许冒充完整思考
    expect(stripSrc).toMatch(/非完整|片段/);
    expect(stripSrc).not.toMatch(/%/);
  });

  it('IdeaDrawView：busy 时挂状态条，演示兜底显示回落真因', () => {
    expect(ideaView).toMatch(/useLlmProgress\('idea', busy\)/);
    expect(ideaView).toMatch(/<LlmProgressStrip/);
    expect(ideaView).toMatch(/fallbackNote/);
    // 竞态纪律不回归：sequencer 仍在
    expect(ideaView).toMatch(/createSequencer/);
  });

  it('TeardownView：精读 busy 时挂状态条，演示兜底显示回落真因', () => {
    expect(teardownView).toMatch(/useLlmProgress\('teardown', busyRead\)/);
    expect(teardownView).toMatch(/<LlmProgressStrip/);
    expect(teardownView).toMatch(/fallbackNote/);
    expect(teardownView).toMatch(/createSequencer/);
  });
});
