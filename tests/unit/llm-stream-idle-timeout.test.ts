/**
 * ★ 审查修复波 F1（严重）：流式改**空闲**超时。
 *
 * 实测到的修复前事实（审查报告原话）：A 批 ccb2ea2 给短产出路径压的
 * `timeoutMs=30_000` 是**总时长**超时——`client.ts:163` 的 `setTimeout(() =>
 * controller.abort(), timeoutMs)` 在 `parseStream` 读流期间仍按原计划计时。
 * 于是健康的慢思考模型（reasoning 动辄超过 30 秒）会在流跑到一半时被腰斩：
 * abort → `timeout` 属可重试（`client.ts:41`）→ 第二次从零重发 → 约 61 秒后
 * 必落演示兜底。**E 批「想看见模型在想什么」的那类模型，恰好是 A 批最先误杀的
 * 那类**——两条轴自己打架。
 *
 * 修复口径：流式路径改空闲超时（每读到一个分片就把计时器续期）；
 * 非流式路径保持总时长语义（body 一次性读完，续命没有意义）；
 * 黑洞端点（一个字节都不发）仍然到点即失败，A 批的「不卡一晚上」不许回退。
 *
 * 计时用真实短时长（几十毫秒级），断言的是「活流跑完 / 死流到点失败」这两件事实，
 * 不是某个内部字段。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LlmClient, LlmError } from '@main/llm/client';
import { findProvider } from '@shared/constants/providers';
import type { ChatRequest } from '@shared/types/provider';

const origFetch: typeof globalThis.fetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function makeClient(): LlmClient {
  const provider = findProvider('deepseek');
  if (!provider) throw new Error('deepseek provider 缺失');
  return new LlmClient({
    provider,
    baseUrl: 'https://example.invalid/v1',
    model: provider.defaultModel ?? 'x',
    mode: 'native',
    tools: [],
    apiKey: 'test-key',
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一帧正文/思考增量的 SSE 报文 */
function sseFrame(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 真 fetch 的语义：signal 一 abort，body 读取立刻按 AbortError 拒绝。假流必须照做，否则测的是假 fetch 不是被测代码。 */
function abortReject(signal?: AbortSignal | null): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const err = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (!signal) return;
    if (signal.aborted) {
      err();
      return;
    }
    signal.addEventListener('abort', err, { once: true });
  });
}

/**
 * 活流假 fetch：分 `frames` 片，每片间隔 `gapMs`，总时长 = frames×gapMs。
 * 片间隔一定 **小于** timeoutMs，总时长一定 **大于** timeoutMs——
 * 这正是「健康但慢」的形状：总时长超时口径必杀它，空闲超时口径必须放过它。
 */
function liveSlowStream(opts: { frames: number; gapMs: number }): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: async () => {
              if (i >= opts.frames) return { done: true, value: undefined };
              // 与真 fetch 同形：等待期间被 abort 就拒绝，而不是继续吐片
              await Promise.race([sleep(opts.gapMs), abortReject(signal)]);
              i++;
              return {
                done: false,
                value: sseFrame({ choices: [{ delta: { content: 'x' } }] }),
              };
            },
            cancel: async () => undefined,
          };
        },
      },
    });
  }) as unknown as typeof fetch;
}

/** 死流假 fetch：连接建立后一个字节都不发（黑洞端点的流式形状），但要响应 abort */
function stalledStream(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => abortReject(init?.signal),
          cancel: async () => undefined,
        }),
      },
    })) as unknown as typeof fetch;
}

describe('F1. 流式空闲超时', () => {
  it('活流：分片间隔 12ms、总时长 ~120ms 远超 timeoutMs=50 —— 必须整条跑完，不许被腰斩', async () => {
    globalThis.fetch = liveSlowStream({ frames: 10, gapMs: 12 });
    const client = makeClient();
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      timeoutMs: 50,
      maxRetries: 0,
    };
    const res = await client.chat(req);
    // 10 片 × 1 字：被总时长口径杀掉时这里根本走不到（会抛 timeout）
    expect(res.content).toBe('xxxxxxxxxx');
  });

  it('活流的每一片都把计时器续期：最后一片到达时距离上一次活动仍小于 timeoutMs', async () => {
    // gapMs 20 > timeoutMs 15 的话这片必死；这里 gap 15 < timeoutMs 45，但总时长 ~90ms > 45
    globalThis.fetch = liveSlowStream({ frames: 6, gapMs: 15 });
    const client = makeClient();
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      timeoutMs: 45,
      maxRetries: 0,
    };
    const res = await client.chat(req);
    expect(res.content).toBe('xxxxxx');
  });

  it('死流：连接开了却零字节 —— 仍按 timeoutMs 快速失败，A 批「不卡一晚上」不许回退', async () => {
    globalThis.fetch = stalledStream();
    const client = makeClient();
    const t0 = Date.now();
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      timeoutMs: 40,
      maxRetries: 0,
    };
    await expect(client.chat(req)).rejects.toBeInstanceOf(LlmError);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('超时真因要说清是「多久没收到东西」，不许只报总时长（空闲口径的文案跟着口径改）', async () => {
    globalThis.fetch = stalledStream();
    const client = makeClient();
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      timeoutMs: 40,
      maxRetries: 0,
    };
    const e = await client.chat(req).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(LlmError);
    expect((e as LlmError).message).toMatch(/无响应|未收到/);
  });

  it('非流式路径保持总时长语义：body 一次读完，中途不续命（不许把空闲超时铺到 JSON 路径）', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          // 真 fetch 语义：body 读取期间被 abort 就拒绝
          await Promise.race([sleep(60), abortReject(init?.signal)]);
          return { choices: [{ message: { content: 'ok' } }], usage: {} };
        },
      })) as unknown as typeof fetch;
    const client = makeClient();
    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 25, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});
