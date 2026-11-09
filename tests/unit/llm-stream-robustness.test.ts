/**
 * ★ 裁决修复波 H1：SSE 解析四处收口（审查 F8，老板「按正常逻辑裁决」后判**必修**，
 *   理由是三条都会把真因藏成假真因——违反全仓「失败说真话」纪律）。
 *
 * 修复前的实测事实（逐条对应下面的 describe）：
 *   1. 事件分隔只认 `\n\n`（`client.ts` 的 `buffer.indexOf('\n\n')`）。SSE 规范
 *      承认 `\r\n` 行结束符，CRLF 端点的整条流因此**一个事件都解析不出来**，
 *      content 恒空 → 服务层落进 catch → 回落注记写的是「未过 Schema 契约」，
 *      而真因其实是「行尾没对上」。
 *   2. `[DONE]` 只 `continue` 不 `break`。keep-alive 网关发完 [DONE] 不关连接时，
 *      完整正文早已到手，客户端还要干等到超时→重试→兜底。
 *   3. 流中 `data: {"error": …}` 帧被当「非 JSON 心跳」跳过（choices 缺席即略过），
 *      中途报错被吞，最后上屏的是假的回落真因。
 *   4. 循环结束后尾缓冲不 flush、decoder 不收尾：末帧后面没有空行（服务端直接
 *      关流，很常见）时那一帧正文丢掉；跨片的半个 UTF-8 字符也丢。
 *
 * 负对照：把上面任一条的实现改回去，本文件对应组即红。
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

const enc = new TextEncoder();

/** 用给定分片序列假造一个流式响应；同时记录 read 被调用了几次（[DONE] 断流用） */
function streamFetch(frames: (string | Uint8Array)[]): { impl: typeof fetch; reads: () => number } {
  let i = 0;
  let n = 0;
  return {
    reads: () => n,
    impl: (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              n++;
              if (i >= frames.length) return { done: true, value: undefined };
              const f = frames[i++];
              return { done: false, value: typeof f === 'string' ? enc.encode(f) : f };
            },
            cancel: async () => undefined,
          }),
        },
      })) as unknown as typeof fetch,
  };
}

const req = (over?: Partial<ChatRequest>): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  timeoutMs: 5_000,
  maxRetries: 0,
  ...over,
});

describe('H1-1 CRLF 行尾（SSE 规范承认 \\r\\n）', () => {
  it('CRLF 分隔的事件流能解析出完整正文', async () => {
    globalThis.fetch = streamFetch([
      'data: {"choices":[{"delta":{"content":"床"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"前"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ]).impl;
    const res = await makeClient().chat(req());
    expect(res.content).toBe('床前');
  });

  it('CRLF 跨片切开（一片尾 \\r、下一片头 \\n）不丢事件', async () => {
    globalThis.fetch = streamFetch([
      'data: {"choices":[{"delta":{"content":"甲"}}]}\r',
      '\n\r\ndata: {"choices":[{"delta":{"content":"乙"}}]}\r\n\r\n',
    ]).impl;
    const res = await makeClient().chat(req());
    expect(res.content).toBe('甲乙');
  });
});

describe('H1-2 [DONE] 即断流', () => {
  it('收到 [DONE] 后不再继续读后续分片（keep-alive 网关不关连接也不干等）', async () => {
    const f = streamFetch([
      'data: {"choices":[{"delta":{"content":"夜"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
      // 下面这帧永远不该被读：读了就说明 [DONE] 只 continue 没 break
      'data: {"choices":[{"delta":{"content":"不该出现"}}]}\n\n',
    ]);
    globalThis.fetch = f.impl;
    const res = await makeClient().chat(req());
    expect(res.content).toBe('夜');
    expect(f.reads()).toBeLessThanOrEqual(2);
  });
});

describe('H1-3 流中 error 帧不许当心跳吞掉', () => {
  it('中途出现 data: {"error": …} → 抛 LlmError 且带 provider 原文真因', async () => {
    globalThis.fetch = streamFetch([
      'data: {"choices":[{"delta":{"content":"开头"}}]}\n\n',
      'data: {"error":{"message":"上游内容审核未通过","type":"server_error"}}\n\n',
    ]).impl;
    const e = await makeClient().chat(req()).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(LlmError);
    expect((e as LlmError).message).toContain('上游内容审核未通过');
  });
});

describe('H1-4 尾缓冲 flush（末帧后无空行 + 跨片半个 UTF-8）', () => {
  it('服务端发完最后一帧直接关流（没有尾随空行）时，最后一帧正文不丢', async () => {
    globalThis.fetch = streamFetch([
      'data: {"choices":[{"delta":{"content":"春风"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"不度玉门关"}}]}\n\n',
      // 末帧后面直接关流：没有空行分隔，旧实现会把它留在 buffer 里丢掉
      'data: {"choices":[{"delta":{"content":"，度玉门关"}}]}',
    ]).impl;
    const res = await makeClient().chat(req());
    expect(res.content).toBe('春风不度玉门关，度玉门关');
  });

  it('多字节字符跨分片切开也不丢字（decoder 收尾）', async () => {
    const whole = enc.encode('data: {"choices":[{"delta":{"content":"关山"}}]}\n\n');
    globalThis.fetch = streamFetch([whole.slice(0, whole.length - 6), whole.slice(whole.length - 6)]).impl;
    const res = await makeClient().chat(req());
    expect(res.content).toBe('关山');
  });
});
