/**
 * ★ E批「模型思考过程可见」钉①：parseStream 必须把流式增量转发给 req.onDelta。
 *
 * 老板报障原话：「只是按钮显示抽卡中，卡一晚上我也不知道他到底在干什么」。
 * 修复前 parseStream 只把 delta.content 累积进内部字符串，调用方在流结束前
 * **一个字都看不到**；delta.reasoning_content（DeepSeek-R1 式思考流）则直接被丢弃。
 *
 * 本文件钉三件事（先红后绿）：
 *   A. delta.content 逐片转发给 onDelta({content})，累积语义不变（res.content 完整）；
 *   B. delta.reasoning_content 转发给 onDelta({reasoning})，且**绝不混进 res.content**；
 *   C. `reasoning` 别名字段同样接受（DeepSeek 与部分代理网关字段名有差异）。
 *
 * 负对照：把 parseStream 里的 onDelta 转发删掉，本文件即红。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LlmClient } from '@main/llm/client';
import { findProvider } from '@shared/constants/providers';

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

function sseResponse(frames: string[]): Response {
  return new Response([...frames, 'data: [DONE]'].join('\n\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

let origFetch: typeof globalThis.fetch;
function withFakeSse(frames: string[]): void {
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse(frames)) as typeof fetch;
}
afterEach(() => {
  if (origFetch) globalThis.fetch = origFetch;
});

describe('parseStream onDelta 转发', () => {
  it('A. content 增量逐片转发，累积语义不变（res.content 仍是完整拼接）', async () => {
    withFakeSse([
      'data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"1}"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const seen: Array<{ content?: string; reasoning?: string }> = [];
    const res = await makeClient().chat({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onDelta: (d) => seen.push(d),
    });
    expect(seen.map((d) => d.content).filter(Boolean)).toEqual(['{"a":', '1}']);
    expect(res.content).toBe('{"a":1}');
  });

  it('B. reasoning_content 转发为 reasoning，且绝不混进 res.content', async () => {
    withFakeSse([
      'data: {"choices":[{"delta":{"reasoning_content":"先想钩子"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"再想反转"}}]}',
      'data: {"choices":[{"delta":{"content":"正文"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const seen: Array<{ content?: string; reasoning?: string }> = [];
    const res = await makeClient().chat({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onDelta: (d) => seen.push(d),
    });
    expect(seen.map((d) => d.reasoning).filter(Boolean)).toEqual(['先想钩子', '再想反转']);
    // 思考流不是正文：混进去会污染 extractJson 的输入
    expect(res.content).toBe('正文');
  });

  it('C. `reasoning` 别名字段同样接受（厂商/代理网关字段名差异）', async () => {
    withFakeSse([
      'data: {"choices":[{"delta":{"reasoning":"别名思考"}}]}',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const seen: Array<{ content?: string; reasoning?: string }> = [];
    await makeClient().chat({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onDelta: (d) => seen.push(d),
    });
    expect(seen.map((d) => d.reasoning).filter(Boolean)).toEqual(['别名思考']);
  });

  it('不传 onDelta 时行为与既有完全一致（老调用方零影响）', async () => {
    withFakeSse([
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}',
      'data: {"choices":[{"delta":{"content":"答"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ]);
    const res = await makeClient().chat({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(res.content).toBe('答');
  });
});
