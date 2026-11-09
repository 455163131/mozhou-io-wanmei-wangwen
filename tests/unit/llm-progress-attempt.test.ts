/**
 * ★ 裁决修复波 H2：重试边界的播报要真（审查 F9 + 建议#1，判**必修**）。
 *
 * 修复前的实测事实：
 *   1. `LlmClient.chat` 的重试循环住在客户端内部，服务层看不到 ⇒ 播报器的
 *      `charsSeen`/`thoughtBuf` **跨尝试累加不清零**：第一次尝试收到 8000 字被
 *      abort、第二次重头收 200 字，界面上却写「已接收 8200 字」——把没收到的
 *      字符数报给了用户；`thought` 尾片段还可能把两次尝试的思考拼在一起。
 *   2. `LlmProgress.phase` 的联合里明明有 `'retry'`（provider.ts），全链路却
 *      **永不发射**——类型承诺了一个不会出现的阶段；`attempt` 也恒写死 1，
 *      注释还写着「看不到就不报」，其实是客户端看得到却不往外说。
 *
 * 修复口径：`ChatRequest.onRetry(第 N 次尝试)` 由客户端在退避前回调；
 * 播报器收到即**清零计数**并真发 `phase:'retry'`，此后所有事件的 `attempt`
 * 都是真实尝试号。诚实纪律不变：没收到的字一个不报，attempt 只报发生过的。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LlmClient, LlmError } from '@main/llm/client';
import { findProvider } from '@shared/constants/providers';
import { createLlmProgressEmitter } from '@main/inspiration/llm-progress';
import type { ChatRequest, LlmProgress } from '@shared/types/provider';

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

describe('H2-1 客户端把重试边界告知调用方', () => {
  it('第一次尝试可重试失败、第二次成功 ⇒ onRetry 收到尝试号 2', async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      if (n === 1) throw new Error('ECONNRESET');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      };
    }) as unknown as typeof fetch;
    const seen: number[] = [];
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 1,
      onRetry: (attempt: number) => seen.push(attempt),
    };
    const res = await makeClient().chat(req);
    expect(res.content).toBe('ok');
    expect(seen, '客户端重试却不告知调用方，播报器无从清零').toEqual([2]);
  });

  it('一次成功时不回调 onRetry（不许无中生有报重试）', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
    })) as unknown as typeof fetch;
    const seen: number[] = [];
    await makeClient().chat({
      messages: [{ role: 'user', content: 'hi' }],
      onRetry: (attempt: number) => seen.push(attempt),
    });
    expect(seen).toEqual([]);
  });

  it('最后一次尝试失败不再回调（不报根本不会发生的第 N 次）', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const seen: number[] = [];
    await expect(
      makeClient().chat({
        messages: [{ role: 'user', content: 'hi' }],
        maxRetries: 1,
        onRetry: (attempt: number) => seen.push(attempt),
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(seen, 'maxRetries=1 ⇒ 只有第二次尝试值得回调一次').toEqual([2]);
  });
});

describe('H2-2 播报器：重试即清零，attempt 报真值', () => {
  it('retry(2) 发 phase:retry 并把 charsSeen 归零；后续事件 attempt=2', () => {
    const events: LlmProgress[] = [];
    const p = createLlmProgressEmitter('idea', (e) => events.push(e));
    p.start();
    p.onDelta({ content: 'x'.repeat(500) });
    const beforeRetry = events.at(-1)!.charsSeen;
    expect(beforeRetry).toBe(500);

    p.retry(2);
    const retryEvent = events.at(-1)!;
    expect(retryEvent.phase, '类型里有 retry 却永不发射 = 空头承诺').toBe('retry');
    expect(retryEvent.attempt).toBe(2);
    expect(retryEvent.charsSeen, '第一次尝试没收成的字不许算进第二次').toBe(0);

    p.onDelta({ content: 'ab' });
    p.done();
    const last = events.at(-1)!;
    expect(last.charsSeen, '第二次尝试只收到 2 字，就不许报 502').toBe(2);
    expect(last.attempt).toBe(2);
  });

  it('未 retry 时 attempt 恒 1（不谎报重试）', () => {
    const events: LlmProgress[] = [];
    const p = createLlmProgressEmitter('teardown', (e) => events.push(e));
    p.start();
    p.onDelta({ reasoning: '想' });
    p.done();
    expect(events.every((e) => e.attempt === 1)).toBe(true);
  });

  it('retry 同时清掉思考尾片段（第二次的 thought 不许掺上一次的残句）', () => {
    const events: LlmProgress[] = [];
    const p = createLlmProgressEmitter('idea', (e) => events.push(e));
    p.start();
    p.onDelta({ reasoning: '甲'.repeat(300) });
    p.retry(2);
    expect(events.at(-1)!.thought, 'retry 载荷不该带着上一次的思考尾').toBeUndefined();
    p.onDelta({ reasoning: '乙' });
    expect(events.at(-1)!.thought).toBe('乙');
  });
});
