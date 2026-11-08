/**
 * ★ 调用预算钉（老板报障：「抽脑洞抽半天没反应」）。
 *
 * 根因（只读诊断实测）：LlmClient 单次超时缺省 120s 且 services.ts 构造时从不传
 * timeoutMs，重试循环最多 4 次尝试 ⇒ 端点黑洞时最坏 ≈8 分钟才抛进 catch；而
 * idea-service / teardown-service 的演示兜底**只活在 catch 里**，悬挂期间永不回落。
 * 界面只有「抽卡中…」，8 分钟静默在体感上就是死了。
 *
 * 本文件钉四件事（先红后绿）：
 *   A. 单次请求可按调用点传 `timeoutMs`（短产出不用等 120s）；
 *   B. 重试次数可按调用点传 `maxRetries`（0 = 只试一次，不放大黑洞）；
 *   C. 抽脑洞/拆书精读这两条**短产出**路径必须传紧预算（≤30s、≤1 次重试）；
 *   D. 扫榜直抓的 fetch **永远带超时 signal**（此前只有调用方传入才有，缺省永挂）。
 *
 * 负对照：把 C 的传参删掉、或把 D 的 signal 拿掉，本文件即红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { LlmClient, LlmError } from '@main/llm/client';
import { findProvider } from '@shared/constants/providers';
import type { ChatRequest } from '@shared/types/provider';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { TeardownRepo } from '@main/db/repos/teardown-repo';
import { drawIdea } from '@main/inspiration/idea-service';
import { teardownStructure, teardownRead } from '@main/inspiration/teardown-service';
import { LiveChartSource } from '@main/inspiration/chart-source';

/** 永不 resolve、只在 signal abort 时按 AbortError 拒绝的假 fetch（模拟端点黑洞） */
function blackHoleFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal;
      if (!sig) return; // 没有 signal ⇒ 永挂（正是缺陷形态）
      if (sig.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      sig.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    })) as typeof fetch;
}

/** 每次都网络失败的假 fetch，并记录尝试次数 */
function failingFetchCounter(): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  return {
    impl: (async () => {
      n++;
      throw new Error('ECONNRESET');
    }) as typeof fetch,
    calls: () => n,
  };
}

function makeClient(cfgTimeoutMs?: number): LlmClient {
  const provider = findProvider('deepseek');
  if (!provider) throw new Error('deepseek provider 缺失');
  return new LlmClient({
    provider,
    baseUrl: 'https://example.invalid/v1',
    model: provider.defaultModel ?? 'x',
    mode: 'native',
    tools: [],
    apiKey: 'test-key',
    ...(cfgTimeoutMs ? { timeoutMs: cfgTimeoutMs } : {}),
  });
}

let origFetch: typeof globalThis.fetch;
beforeEach(() => {
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('A/B. LlmClient 调用点预算', () => {
  it('req.timeoutMs 生效：黑洞端点在调用点预算内抛 timeout，不等 cfg 的长超时', async () => {
    globalThis.fetch = blackHoleFetch();
    const client = makeClient(60_000); // 客户端级仍长
    const t0 = Date.now();
    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 40,
      maxRetries: 0,
    };
    await expect(client.chat(req)).rejects.toBeInstanceOf(LlmError);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('maxRetries=0 ⇒ 只发一次请求（默认口径是 4 次尝试）', async () => {
    const f = failingFetchCounter();
    globalThis.fetch = f.impl;
    const client = makeClient();
    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hi' }], maxRetries: 0 }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(f.calls()).toBe(1);
  });

  it('不传 maxRetries 时保持既有 4 次尝试口径（不许顺手改全局重试策略）', async () => {
    const f = failingFetchCounter();
    globalThis.fetch = f.impl;
    const client = makeClient();
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(f.calls()).toBe(4);
  });
});

describe('C. 短产出路径必须传紧预算', () => {
  let db: ReturnType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
  });

  it('drawIdea 传给 llm.chat 的请求带 timeoutMs≤30s 且 maxRetries≤1', async () => {
    const repo = new InspirationRepo(db);
    let seen: ChatRequest | null = null;
    const llm = {
      chat: async (req: ChatRequest) => {
        seen = req;
        throw new Error('auth');
      },
    };
    await drawIdea({ llm, repo });
    expect(seen, 'idea-service 没有把请求对象传下去').not.toBeNull();
    expect(seen!.timeoutMs, '抽脑洞未设单次超时（黑洞时最坏 8 分钟）').toBeLessThanOrEqual(30_000);
    expect(seen!.maxRetries, '抽脑洞未收敛重试次数').toBeLessThanOrEqual(1);
  });

  it('teardownRead 传给 llm.chat 的请求带 timeoutMs≤30s 且 maxRetries≤1', async () => {
    const td = new TeardownRepo(db);
    const { reportId } = await teardownStructure('第一章 测试\n' + '他走进房间。'.repeat(20), '范文', td);
    let seen: ChatRequest | null = null;
    const llm = {
      chat: async (req: ChatRequest) => {
        seen = req;
        throw new Error('auth');
      },
    };
    await teardownRead({ reportId, llm, repo: td });
    expect(seen).not.toBeNull();
    expect(seen!.timeoutMs, '拆书精读未设单次超时').toBeLessThanOrEqual(30_000);
    expect(seen!.maxRetries, '拆书精读未收敛重试次数').toBeLessThanOrEqual(1);
  });
});

describe('D. 扫榜直抓 fetch 永远带超时 signal', () => {
  it('调用方不传 signal 时，fetchImpl 仍收到一个会到点 abort 的 signal', async () => {
    let gotSignal: AbortSignal | undefined;
    const src = new LiveChartSource({
      fetchTimeoutMs: 30,
      robotsChecker: async () => true,
      fetchImpl: ((_url: string, init?: RequestInit) => {
        gotSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          const sig = init?.signal;
          if (!sig) return;
          sig.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
      }) as typeof fetch,
    });
    const t0 = Date.now();
    // 超时是诚实失败：抛真因（IPC 层原样交给 UI 显示），不静默当网络错、不冒充演示数据
    await expect(src.fetch('番茄')).rejects.toThrow(/抓取超时/);
    expect(gotSignal, '扫榜 fetch 未带 signal（黑洞时永挂）').toBeInstanceOf(AbortSignal);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
