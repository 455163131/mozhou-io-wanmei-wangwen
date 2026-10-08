/**
 * 专家团 LLM 执行器测试（阶段二）。
 *
 * ★ 用假 LLM 验证编排逻辑，不发真实网络请求：
 *   要验的是「一个专家挂了怎么办」「预算超了怎么办」「模型返回垃圾怎么办」，
 *   这些都是编排问题，与模型质量无关。
 */
import { describe, it, expect, vi } from 'vitest';
import { LlmError } from '@main/llm/client';
import { parseJsonLenient, runExpertReview, describeFailures } from '@main/expert/reviewer';
import { DEFAULT_EXPERT_CONFIG } from '@shared/types/expert';
import type { LlmProvider } from '@shared/types/provider';

// ── 测试替身 ─────────────────────────────────────────────────────────

const provider = (free: boolean): LlmProvider =>
  ({
    id: 'test',
    displayName: 'test',
    baseUrl: 'http://127.0.0.1:1234/v1',
    functionCalling: 'native',
    pricing: { inputPerMTok: free ? 0 : 1, outputPerMTok: free ? 0 : 2 },
  }) as unknown as LlmProvider;

const config = { ...DEFAULT_EXPERT_CONFIG, enabled: true };

const BODY = '他一步一步走过来，月光洒在窗台上。「我不生气。」她说。';

/** 假 LLM：按调用顺序返回预设响应 */
function fakeLlm(responses: (string | Error)[]) {
  let i = 0;
  const calls: { messages: unknown; temperature?: number }[] = [];
  return {
    calls,
    chat: vi.fn(async (req: { messages: unknown; temperature?: number }) => {
      calls.push({ messages: req.messages, temperature: req.temperature });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return {
        content: r,
        toolCalls: [],
        usage: { input: 100, output: 50, wallMs: 10 },
        finishReason: 'stop',
        viaTextProtocol: false,
      };
    }),
  };
}

const validJson = JSON.stringify([
  {
    dimension: 'pacing',
    severity: 'major',
    verdict: 'suggest',
    evidence: '他一步一步走过来',
    suggestion: '删掉「一步一步」',
  },
]);

// ── 宽松 JSON 解析 ───────────────────────────────────────────────────

describe('宽松 JSON 解析（模型常裹围栏/带废话）', () => {
  it('标准 JSON', () => {
    expect(parseJsonLenient('{"a":1}')).toEqual({ a: 1 });
  });

  it('★ ```json 围栏', () => {
    expect(parseJsonLenient('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('★ 裸围栏（无 json 标记）', () => {
    expect(parseJsonLenient('```\n[1,2]\n```')).toEqual([1, 2]);
  });

  it('★ JSON 前面有解释文字', () => {
    expect(parseJsonLenient('好的，我的意见如下：\n[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('完全不是 JSON → 抛错而不是返回垃圾', () => {
    expect(() => parseJsonLenient('我不知道该说什么')).toThrow();
  });
});

// ── 正常评审 ─────────────────────────────────────────────────────────

describe('单专家评审', () => {
  it('★ 解析合法意见并标注角色与越界状态', async () => {
    const llm = fakeLlm([validJson]);
    const out = await runExpertReview('chapter', ['37'], ['prose'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => BODY,
    });
    expect(out.opinions).toHaveLength(1);
    expect(out.opinions[0].role).toBe('prose');
    expect(out.opinions[0].dimension).toBe('pacing');
    // prose.ignore 含 pacing → 应标记越界
    expect(out.opinions[0].crossBoundary).toBe(true);
    expect(out.failed).toHaveLength(0);
  });

  it('★ temperature ≤ 0.3（评审要稳定，不要创造性发挥）', async () => {
    const llm = fakeLlm([validJson]);
    await runExpertReview('chapter', ['37'], ['prose'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => BODY,
    });
    expect(llm.calls[0].temperature).toBeLessThanOrEqual(0.3);
  });

  it('★ 空章节正文直接跳过，不浪费 LLM 调用', async () => {
    const llm = fakeLlm([validJson]);
    const out = await runExpertReview('chapter', ['37'], ['prose'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => '   ',
    });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(out.opinions).toHaveLength(0);
  });
});

// ── 逐项点名校验失败 ─────────────────────────────────────────────────

describe('模型返回不合规时的处理', () => {
  it('★ 部分条目不合法 → 保留合法的，不整批丢弃', async () => {
    const llm = fakeLlm([
      JSON.stringify([
        { dimension: 'pacing', severity: 'major', verdict: 'suggest', evidence: 'x', suggestion: 'y' },
        { dimension: '不存在的维度', severity: 'major', verdict: 'suggest', evidence: 'x', suggestion: 'y' },
      ]),
    ]);
    const out = await runExpertReview('chapter', ['37'], ['structure'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => BODY,
    });
    expect(out.opinions).toHaveLength(1);
    expect(out.opinions[0].dimension).toBe('pacing');
  });

  it('★ 全部条目不合法 → 该专家标记失败，不污染意见池', async () => {
    const llm = fakeLlm([JSON.stringify([{ foo: 'bar' }])]);
    const out = await runExpertReview('chapter', ['37'], ['structure'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => BODY,
    });
    expect(out.opinions).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].reason).toContain('返回结构不合法');
  });

  it('★ evidence 为空被拒（必须有原文依据，不许编造）', async () => {
    const llm = fakeLlm([
      JSON.stringify([
        { dimension: 'pacing', severity: 'major', verdict: 'suggest', evidence: '', suggestion: 'y' },
      ]),
    ]);
    const out = await runExpertReview('chapter', ['37'], ['structure'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => BODY,
    });
    expect(out.opinions).toHaveLength(0);
    expect(out.failed[0].reason).toContain('evidence');
  });
});

// ── 降级：一个失败不拖垮整团 ─────────────────────────────────────────

describe('★ 部分失败不拖垮整团', () => {
  it('六专家挂一个 → 五个的意见照常返回', async () => {
    const llm = fakeLlm([
      validJson, // structure ok
      new LlmError('auth', 'API Key 无效'), // character 挂
      validJson, // dialogue ok
      validJson, // prose ok
      validJson, // reader ok
      validJson, // genre ok
    ]);
    const out = await runExpertReview(
      'chapter',
      ['37'],
      ['structure', 'character', 'dialogue', 'prose', 'reader', 'genre'],
      { llm, provider: provider(false), config, getChapterBody: () => BODY },
    );
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].role).toBe('character');
    expect(out.opinions.length).toBeGreaterThan(0);
  });

  it('★ 失败说明包含角色中文名与原因（UI 要能直接展示）', () => {
    const note = describeFailures([
      { role: 'character', reason: 'auth: Key 无效' },
    ]);
    expect(note).toContain('人物塑造师');
    expect(note).toContain('Key 无效');
    expect(note).toContain('意见不完整');
  });

  it('无失败时降级说明为空串', () => {
    expect(describeFailures([])).toBe('');
  });

  it('★ 同一角色失败多次只提示一次', () => {
    const note = describeFailures([
      { role: 'prose', reason: 'timeout' },
      { role: 'prose', reason: 'timeout' },
    ]);
    expect(note.match(/文字 editors/g)).toHaveLength(1);
  });
});

// ── 预算 ─────────────────────────────────────────────────────────────

describe('预算控制', () => {
  it('★ 达到 token 上限后停止发起新调用（标记截断）', async () => {
    const tight = {
      ...config,
      budget: { ...config.budget, maxTokens: 150 }, // 每次调用消耗 150 token
    };
    const llm = fakeLlm([validJson]);
    const out = await runExpertReview(
      'chapter',
      ['37'],
      ['structure', 'character', 'dialogue', 'prose', 'reader', 'genre'],
      { llm, provider: provider(false), config: tight, getChapterBody: () => BODY },
    );
    // 至少发起 1 次，第 2 次就该被预算拦住
    expect(llm.chat.mock.calls.length).toBeLessThan(6);
    expect(out.budgetTruncated).toBe(true);
  });

  it('★ 本地模型（零价）不走成本闸，只看 token（否则会误截断）', async () => {
    const llm = fakeLlm([validJson]);
    const out = await runExpertReview(
      'chapter',
      ['37'],
      ['structure', 'character', 'dialogue'],
      { llm, provider: provider(true), config, getChapterBody: () => BODY },
    );
    // 3 个角色 × 100+50 token = 450，远低于 60000 上限
    expect(out.budgetTruncated).toBe(false);
    expect(llm.chat.mock.calls.length).toBe(3);
  });
});

// ── 并发与角色选择 ───────────────────────────────────────────────────

describe('并发与角色选择', () => {
  it('★ 只评审请求的角色（按需加载的兑现）', async () => {
    const llm = fakeLlm([validJson]);
    await runExpertReview('outline', ['37'], ['structure', 'genre'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => BODY,
    });
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('★ 多章节 × 多专家 = 调用次数正确', async () => {
    const llm = fakeLlm([validJson]);
    await runExpertReview('chapter', ['1', '2'], ['structure', 'prose'], {
      llm,
      provider: provider(false),
      config,
      getChapterBody: () => BODY,
    });
    expect(llm.chat).toHaveBeenCalledTimes(4); // 2 专家 × 2 章
  });

  it('★ 并发有上限，不会一次性打满 provider', async () => {
    const llm = fakeLlm([validJson]);
    let inflight = 0;
    let maxInflight = 0;
    llm.chat.mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return {
        content: validJson,
        toolCalls: [],
        usage: { input: 1, output: 1, wallMs: 5 },
        finishReason: 'stop',
        viaTextProtocol: false,
      };
    });
    await runExpertReview(
      'chapter',
      ['1'],
      ['structure', 'character', 'dialogue', 'prose', 'reader', 'genre'],
      { llm, provider: provider(false), config, getChapterBody: () => BODY },
    );
    expect(maxInflight).toBeLessThanOrEqual(3);
  });
});
