/**
 * native tool_calls 路径的**实测 body 输出**（团队负责人要求的唯一证据）。
 *
 * ★ 为什么必须实测而非读代码：
 *   上一轮双方对「native 到底接没接」给了相反结论——
 *   团队负责人 grep 到 client.ts 有 tools 就认为接线漏了，
 *   而实际上 doSelect 早已传入 tools。
 *   拦截 fetch 打印**真实发出的 body** 是唯一能定案的证据。
 *
 *本文件覆盖三条路径各自实际发出的 body。
 */
import { describe, it, expect } from 'vitest';
import { LlmClient } from '@main/llm/client';
import { findProvider } from '@shared/constants/providers';

interface Capture {
  sent: Array<Record<string, unknown>>;
}

/** 拦截 fetch，记录真实发出的 body */
async function capture(
  respond: (n: number) => Response,
  run: (c: Capture) => Promise<void>,
): Promise<Capture> {
  const sent: Array<Record<string, unknown>> = [];
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return respond(n++);
  }) as typeof fetch;
  try {
    await run({ sent });
  } finally {
    globalThis.fetch = orig;
  }
  return { sent };
}

function toolCallResponse(name: string, args: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function plainResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeClient(mode: 'native' | 'prompted' | 'unsupported', providerId = 'deepseek') {
  const p = findProvider(providerId)!;
  return new LlmClient({
    provider: p,
    baseUrl: p.defaultBaseUrl,
    model: 'test-model',
    apiKey: 'sk-test',
    mode,
    tools: [],
    timeoutMs: 5000,
  });
}

const TOOLS = [
  { type: 'function', function: { name: 'analyze_chapter', parameters: { type: 'object', properties: {} } } },
];

describe('★ native 路径实测：body 里必须真的有 tools', () => {
  it('【实测输出】native + 传 tools → body.tools 与 tool_choice 都在', async () => {
    const c = makeClient('native');
    let res: Awaited<ReturnType<LlmClient['chat']>> | null = null;

    const { sent } = await capture(
      () => toolCallResponse('analyze_chapter', '{"chapterIds":["37"]}'),
      async () => {
        res = await c.chat({
          messages: [{ role: 'user', content: '选工具' }],
          tools: TOOLS,
          tool_choice: 'auto',
          stream: false,
        });
      },
    );

    const body = sent[0];
    console.log('=== native 实测 body（摘要）===');
    console.log('  body.tools 存在:', Array.isArray(body['tools']), '| 数量:', (body['tools'] as unknown[])?.length);
    console.log('  body.tool_choice:', body['tool_choice']);
    console.log('  body.model:', body['model']);
    console.log('  第一个工具名:', (body['tools'] as Array<{ function: { name: string } }>)[0]?.function?.name);
    console.log('  解析到的 toolCalls:', res!.toolCalls.length, '→', res!.toolCalls[0]?.name);
    console.log('  viaTextProtocol:', res!.viaTextProtocol);

    expect(Array.isArray(body['tools'])).toBe(true);
    expect((body['tools'] as unknown[]).length).toBe(1);
    expect(body['tool_choice']).toBe('auto');
    expect(res!.toolCalls).toHaveLength(1);
    expect(res!.toolCalls[0].name).toBe('analyze_chapter');
    expect(res!.toolCalls[0].args).toEqual({ chapterIds: ['37'] });
    expect(res!.viaTextProtocol).toBe(false);
  });

  it('【实测输出】native + 不传 tools → body.tools 为 undefined（这正是上一轮的 bug）', async () => {
    const c = makeClient('native');
    const { sent } = await capture(
      () => plainResponse('（无工具调用）'),
      async () => {
        await c.chat({ messages: [{ role: 'user', content: '规划' }], stream: false });
      },
    );
    console.log('=== native 但不传 tools（对照）===');
    console.log('  body.tools =', sent[0]['tools']);
    console.log('  body.tool_choice =', sent[0]['tool_choice']);

    // ★ 这条是回归护栏：若将来有人在 native 路径漏传 tools，这里会立刻发现
    expect(sent[0]['tools']).toBeUndefined();
    expect(sent[0]['tool_choice']).toBeUndefined();
  });

  it('prompted 路径：不发 tools，协议说明进 system 消息', async () => {
    const c = makeClient('prompted', 'ollama');
    const { sent } = await capture(
      () => plainResponse('普通回答'),
      async () => {
        await c.chat({
          messages: [{ role: 'user', content: 'hi' }],
          tools: TOOLS,
          tool_choice: 'auto',
          stream: false,
        });
      },
    );
    const body = sent[0];
    const msgs = body['messages'] as Array<{ role: string; content: string }>;
    const sys = msgs.find((m) => m.role === 'system');
    console.log('=== prompted 实测===');
    console.log('  body.tools =', body['tools'], '（发了也没用，探测已确认它会忽略）');
    console.log('  system 含协议标记:', sys?.content.includes('<<TOOL:'));
    expect(body['tools']).toBeUndefined();
    expect(sys?.content).toContain('<<TOOL:');
  });

  it('unsupported 路径：client 不发 tools，交由上层降级', async () => {
    const c = makeClient('unsupported', 'lmstudio');
    const { sent } = await capture(
      () => plainResponse('回答'),
      async () => {
        await c.chat({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, stream: false });
      },
    );
    console.log('=== unsupported 实测 ===');
    console.log('  body.tools =', sent[0]['tools']);
    expect(sent[0]['tools']).toBeUndefined();
  });
});

describe('native 流式路径：tool_calls 分片累积', () => {
  it('【实测】SSE 分片返回的 tool_calls 能正确拼回完整参数', async () => {
    const c = makeClient('native');
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fix_expression","arguments":"{\\"chapter"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Ids\\":[\\"37\\"]}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
      'data: [DONE]',
    ].join('\n\n');

    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;
    try {
      const res = await c.chat({
        messages: [{ role: 'user', content: '选工具' }],
        tools: TOOLS,
        tool_choice: 'auto',
        stream: true,
      });
      console.log('=== native 流式实测 ===');
      console.log('  分片拼回的 tool:', res.toolCalls[0]?.name, '| args:', JSON.stringify(res.toolCalls[0]?.args));
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0].name).toBe('fix_expression');
      expect(res.toolCalls[0].args).toEqual({ chapterIds: ['37'] });
    } finally {
      globalThis.fetch = orig;
    }
  });
});