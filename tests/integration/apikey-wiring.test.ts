/**
 * ★ LLM API Key 的「生产装配」测试。
 *
 * 为什么单独开一个文件（写法参照 budget-wiring.test.ts）：
 *
 *   既有测试里 `makeClient()` 一律直接传 `apiKey: 'sk-test'`——它验证的是
 *   「拿到 Key 之后请求对不对」，**没有验证「生产路径上 Key 从哪来」**。
 *   而真实缺陷恰好在后半句：
 *
 *     · `LlmClient` 只从 `cfg.apiKey` 读 Key；
 *     · `services.ts` 构造 `LlmClient` 时**从不传 apiKey**；
 *     · `getApiKeyForFetch()` 的唯一调用者是 `llm:test`（连通测试）那条 IPC。
 *
 *   → 用户在设置里填了 Key、safeStorage 也存进去了、「测试连接」还显示成功，
 *     但 Agent 主链路发出的每个请求都**不带 Authorization 头** → 六家云 provider 全部 401。
 *     故障表现为「配置成功但 Agent 不可用」，极难归因。
 *
 *   修复方式：LlmClient 增加 `apiKeyProvider`，**每次请求时动态解析**；
 *   services.ts 注入 `() => getApiKeyForFetch()`。
 *   动态解析的额外收益：用户改 Key 后立刻生效，无需重建客户端；
 *   明文在主进程内的存活时间也最短（构造时不取出）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmClient, LlmError } from '@main/llm/client';
import { findProvider, PROVIDERS } from '@shared/constants/providers';

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 拦截 fetch，记录真实发出的 url / headers / body（含 finally 还原，不污染环境） */
async function captureFetch(
  run: () => Promise<unknown>,
  respond: () => Response = () => plainResponse('ok'),
): Promise<SentRequest[]> {
  const sent: SentRequest[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string, init: RequestInit) => {
    sent.push({
      url: String(u),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return respond();
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
  }
  return sent;
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

const REQ = {
  messages: [{ role: 'user' as const, content: '你好' }],
  stream: false,
};

function makeClient(
  providerId: string,
  extra: Partial<ConstructorParameters<typeof LlmClient>[0]> = {},
): LlmClient {
  const p = findProvider(providerId)!;
  return new LlmClient({
    provider: p,
    baseUrl: p.defaultBaseUrl,
    model: 'test-model',
    mode: 'native',
    tools: [],
    timeoutMs: 5000,
    ...extra,
  });
}

describe('★ apiKeyProvider：动态 Key 真的进了 Authorization 头', () => {
  it('apiKeyProvider 返回的 Key 被用作 Bearer token', async () => {
    const c = makeClient('deepseek', { apiKeyProvider: async () => 'sk-from-keyring' });
    const sent = await captureFetch(() => c.chat(REQ));
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['Authorization']).toBe('Bearer sk-from-keyring');
  });

  it('同步形式的 apiKeyProvider 同样生效', async () => {
    const c = makeClient('deepseek', { apiKeyProvider: () => 'sk-sync' });
    const sent = await captureFetch(() => c.chat(REQ));
    expect(sent[0].headers['Authorization']).toBe('Bearer sk-sync');
  });

  it('★ 两次请求之间 Key 变了，第二次立刻用新 Key（无需重建客户端）', async () => {
    let current = 'sk-old';
    const c = makeClient('deepseek', { apiKeyProvider: () => current });

    const first = await captureFetch(() => c.chat(REQ));
    expect(first[0].headers['Authorization']).toBe('Bearer sk-old');

    current = 'sk-new'; // 模拟用户在设置里重填了 Key
    const second = await captureFetch(() => c.chat(REQ));
    expect(second[0].headers['Authorization']).toBe('Bearer sk-new');
  });

  it('静态 apiKey 仍然生效（向后兼容：既有测试与 llm:test 路径依赖它）', async () => {
    const c = makeClient('deepseek', { apiKey: 'sk-static' });
    const sent = await captureFetch(() => c.chat(REQ));
    expect(sent[0].headers['Authorization']).toBe('Bearer sk-static');
  });

  it('apiKeyProvider 优先于静态 apiKey（动态才是生产路径）', async () => {
    const c = makeClient('deepseek', {
      apiKey: 'sk-static',
      apiKeyProvider: () => 'sk-dynamic',
    });
    const sent = await captureFetch(() => c.chat(REQ));
    expect(sent[0].headers['Authorization']).toBe('Bearer sk-dynamic');
  });
});

describe('★ 需要 Key 却取不到：必须明确报错，而不是发一个注定 401 的请求', () => {
  it('requiresKey=true 且无 Key → 抛 auth 错，且 fetch 根本没被调用', async () => {
    const c = makeClient('deepseek', { apiKeyProvider: () => undefined });
    const sent = await captureFetch(async () => {
      await expect(c.chat(REQ)).rejects.toBeInstanceOf(LlmError);
    });
    // 关键：请求没发出去。修复前会发出一个无 Authorization 头的请求换回 401，
    // 用户看到的是「模型鉴权失败」而非「你没填 Key」，归因方向完全不同。
    expect(sent).toHaveLength(0);
  });

  it('错误信息里点名了厂商与去处（可操作，而非裸 401）', async () => {
    const c = makeClient('openrouter', { apiKeyProvider: () => undefined });
    await captureFetch(async () => {
      let err: unknown;
      try {
        await c.chat(REQ);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LlmError);
      const e = err as LlmError;
      expect(e.kind).toBe('auth');
      expect(e.message).toContain('OpenRouter');
      expect(e.message).toContain('设置');
      expect(e.retryable).toBe(false); // 重试同样的空 Key 只会同样失败
    });
  });

  it('本地 provider（requiresKey=false）无 Key 也能发请求，且不带 Authorization 头', async () => {
    const c = makeClient('ollama');
    const sent = await captureFetch(() => c.chat(REQ));
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['Authorization']).toBeUndefined();
  });

  it('自定义 provider 无 Key 同样放行（自建端点常常不要鉴权）', async () => {
    const c = makeClient('custom', { baseUrl: 'http://127.0.0.1:9999/v1' });
    const sent = await captureFetch(() => c.chat(REQ));
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['Authorization']).toBeUndefined();
  });
});

describe('★ provider.defaultModel：兜底模型必须来自厂商自身', () => {
  it('云端厂商都有本厂商的默认模型（不再是 deepseek-chat 一家通用）', () => {
    const deepseek = findProvider('deepseek')!;
    expect(deepseek.defaultModel).toBe('deepseek-chat');

    const openrouter = findProvider('openrouter')!;
    expect(openrouter.defaultModel).toBeTruthy();
    // OpenRouter 按「厂商/模型」路由，默认值必须带路由前缀
    expect(openrouter.defaultModel).toContain('/');
    // ★ 关键回归：不能再把 DeepSeek 的裸模型名当作 OpenRouter 的默认值
    expect(openrouter.defaultModel).not.toBe('deepseek-chat');
  });

  it('本地与自定义 provider 刻意不给默认模型（猜一个必然 404）', () => {
    for (const id of ['ollama', 'lmstudio', 'custom']) {
      expect(findProvider(id)!.defaultModel ?? '').toBe('');
    }
  });

  it('defaultModel 若存在，必须是该厂商可用的形态（不含空格等明显错误）', () => {
    for (const p of PROVIDERS) {
      if (p.defaultModel) {
        expect(p.defaultModel.trim()).toBe(p.defaultModel);
        expect(p.defaultModel).not.toContain(' ');
      }
    }
  });
});

describe('★ 装配哨兵：services.ts 必须把 keyring 接进 LlmClient', () => {
  /**
   * 为什么是源码文本断言而不是直接实例化 AppServices：
   * services.ts 顶层 import 了 electron 的 `app`，而测试跑在
   * `ELECTRON_RUN_AS_NODE=1` 下（见 scripts/test.cmd），此时 electron 导出的是
   * 可执行文件路径字符串而非 API，`app.getPath()` 无法工作，AppServices 构造不起来。
   *
   * 这条哨兵盯的是**接线本身**：只要有人把 apiKeyProvider 从构造参数里删掉，
   * 就会立刻红——而这正是本次修复前的缺陷形态（281 个用例全绿也发现不了）。
   */
  it('LlmClient 的构造参数里含 apiKeyProvider，且取自 keyring', () => {
    const src = readFileSync(join(__dirname, '../../src/main/services.ts'), 'utf8');
    const ctor = src.slice(src.indexOf('new LlmClient({'));
    const ctorBody = ctor.slice(0, ctor.indexOf('});'));

    // ★ 只断言**代码行**，不断言整段文本：解释性注释里提到 'deepseek-chat'
    //   是正当的（说明此前错在哪），不该让哨兵误报。
    const lineOf = (prop: string): string => {
      const line = ctorBody.split('\n').find((l) => new RegExp(`^\\s*${prop}:`).test(l));
      expect(line, `构造参数里找不到 ${prop}:`).toBeTruthy();
      return line as string;
    };

    const keyLine = lineOf('apiKeyProvider');
    expect(keyLine).toContain('getApiKeyForFetch');

    // 兜底模型必须走 provider.defaultModel，不能再硬编码某一家的模型名
    const modelLine = lineOf('model');
    expect(modelLine).toContain('this.provider.defaultModel');
    expect(modelLine).not.toContain("'deepseek-chat'");
  });

  it('keyring 导出的 getApiKeyForFetch 确实是 services 引入的那个符号', () => {
    const src = readFileSync(join(__dirname, '../../src/main/services.ts'), 'utf8');
    const importLine = src
      .split('\n')
      .find((l) => l.includes('getApiKeyForFetch') && l.includes('import'));
    expect(importLine).toBeTruthy();
    expect(importLine).toContain('./llm/keyring');
  });
});
