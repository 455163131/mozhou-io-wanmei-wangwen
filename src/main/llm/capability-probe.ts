/**
 * Provider 能力探测（架构 §1.4.5 / T26）。
 *
 * ⚠️ **【待验证 V13】必须实跑，不能照抄文档** —— Ollama / LM Studio 的
 * function calling 支持度与实际行为差异较大（版本差异）。
 * 验证方法：对两个本地运行时各发 3 种请求（标准 tools / prompted 文本协议 / 流式），
 * 记录实际返回。
 *
 * 探测策略：先发标准 tools 请求看是否返回 tool_calls；
 * 失败则不发 prompted（省一次往返），直接标unsupported。
 * 流式与上下文长度独立探测。
 */
import type { LlmProvider, ProviderCapabilities } from '@shared/types/provider';

export interface ProbeResult {
  capabilities: ProviderCapabilities;
  /** 每项探测的原始结论，供 UI「重新检测」页展示，不藏细节 */
  details: Array<{ probe: string; ok: boolean; note: string }>;
  at: number;
}

/** 发一个最小工具调用请求，看是否返回 tool_calls 结构 */
async function probeFunctionCalling(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<{ ok: boolean; note: string }> {
  const tool = {
    type: 'function' as const,
    function: {
      name: 'ping',
      description: '回显用工具',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '调用 ping 工具' }],
        tools: [tool],
        tool_choice: 'auto',
        max_tokens: 64,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) {
      return { ok: false, note: `HTTP ${res.status} ${res.statusText}` };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
    };
    const hasToolCalls = Array.isArray(json.choices?.[0]?.message?.tool_calls);
    return {
      ok: hasToolCalls,
      note: hasToolCalls ? '返回了 tool_calls 结构' : '未返回 tool_calls（可能静默忽略 tools 参数）',
    };
  } catch (e) {
    return { ok: false, note: `请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 流式探测：发一个 max_tokens=1 的流式请求，看是否收到 data: 帧 */
async function probeStreaming(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<{ ok: boolean; note: string }> {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: true,
      }),
      signal,
    });
    if (!res.ok) return { ok: false, note: `HTTP ${res.status}` };
    if (!res.body) return { ok: false, note: '无响应体' };
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value ?? new Uint8Array());
    const hasDataFrame = text.includes('data:');
    return {
      ok: hasDataFrame,
      note: hasDataFrame ? '收到 SSE data: 帧' : '未收到 SSE 帧',
    };
  } catch (e) {
    return { ok: false, note: `请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 上下文窗口：Ollama /api/tags、LM Studio /v1/models；失败用保守默认值 */
async function probeContextWindow(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; note: string; value: number }> {
  // Ollama 原生端口（去掉 /v1 后缀）
  const ollamaRoot = baseUrl.replace(/\/v1\/?$/, '');
  try {
    const res = await fetch(`${ollamaRoot}/api/tags`, { signal });
    if (res.ok) {
      const json = (await res.json()) as { models?: Array<{ name?: string; details?: { parameter_size?: string } }> };
      const first = json.models?.[0];
      if (first?.name) {
        return { ok: true, note: `Ollama /api/tags 读到模型 ${first.name}`, value: 8_192 };
      }
    }
  } catch {
    // 继续尝试下一个来源
  }
  try {
    const res = await fetch(`${baseUrl}/models`, { signal });
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string; context_length?: number }> };
      const first = json.data?.[0];
      if (first?.context_length) {
        return {
          ok: true,
          note: `模型元数据 context_length=${first.context_length}`,
          value: first.context_length,
        };
      }
    }
    return { ok: false, note: '无法读到上下文长度，用保守默认 8192', value: 8_192 };
  } catch (e) {
    return {
      ok: false,
      note: `探测失败，用保守默认 8192（${e instanceof Error ? e.message : String(e)}）`,
      value: 8_192,
    };
  }
}

/** 探测完整能力集 */
export async function probeCapabilities(
  provider: LlmProvider,
  opts: { model: string; apiKey?: string; timeoutMs?: number },
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const details: ProbeResult['details'] = [];

  try {
    const fc = await probeFunctionCalling(
      provider.defaultBaseUrl,
      opts.model,
      opts.apiKey,
      controller.signal,
    );
    details.push({ probe: 'functionCalling', ok: fc.ok, note: fc.note });

    const st = await probeStreaming(
      provider.defaultBaseUrl,
      opts.model,
      opts.apiKey,
      controller.signal,
    );
    details.push({ probe: 'streaming', ok: st.ok, note: st.note });

    const ctx = await probeContextWindow(provider.defaultBaseUrl, controller.signal);
    details.push({ probe: 'contextWindow', ok: ctx.ok, note: ctx.note });

    return {
      capabilities: {
        // ★ 不支持原生 tool_calls 时**不降级到 prompted**，直接标 unsupported。
        //   理由：prompted 路径要求模型能稳定输出指定格式的文本，
        //   而一个连 tools 参数都忽略的运行时很可能也做不到。
        //   这比「先试 prompted 再看」更诚实——能力不足就明说，不假装能行。
        functionCalling: fc.ok ? 'native' : 'unsupported',
        streaming: st.ok,
        maxContextTokens: ctx.value,
      },
      details,
      at: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}