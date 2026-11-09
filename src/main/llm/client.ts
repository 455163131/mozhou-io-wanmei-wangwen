/**
 * LLM 客户端（架构 T14）。
 *
 * 原生 fetch + 自建薄客户端，**不用 openai SDK**。理由（架构 §4.2）：
 * 国产模型与本地运行时全兼容 OpenAI 协议但流式字段/错误码/工具调用支持度有差异，
 * SDK 的强类型假设会让差异无处安放。我们要的三样只有：
 * POST /chat/completions、SSE 解析、AbortController 超时。
 *
 * ★ Electron 主进程用 Node fetch 直连，不经浏览器，**没有 CORS 问题**——
 *   所以不需要原型里那个 101 行代理。
 */
import type { ChatRequest, ChatResponse, LlmProvider, ToolCallingMode } from '@shared/types/provider';
import type { ToolSpec } from '@shared/types/tool';
import { parsePromptedCalls, toOpenAiTools, buildPromptedProtocolPrompt } from './tool-calling';

/** 退避重试：网络失败/5xx 重试 3 次，超时 2 次，鉴权失败 0 次（架构 §1.4.3） */
const RETRY_LIMITS = {
  network: 3,
  timeout: 2,
  server: 3,
  auth: 0,
  rate: 2,
  invalidJson: 2,
};

export class LlmError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'server' | 'auth' | 'rate' | 'aborted' | 'badResponse',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  /** 是否值得重试：鉴权失败不重试（重试同样的 Key 只会同样失败） */
  get retryable(): boolean {
    switch (this.kind) {
      case 'network':
        return RETRY_LIMITS.network > 0;
      case 'timeout':
        return RETRY_LIMITS.timeout > 0;
      case 'server':
        return RETRY_LIMITS.server > 0;
      case 'rate':
        return RETRY_LIMITS.rate > 0;
      case 'auth':
        return false;
      default:
        return false;
    }
  }
}

export interface LlmClientConfig {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  /**
   * 静态 Key。**优先用 apiKeyProvider**——静态值在客户端构造时快照，
   * 用户之后在设置里改 Key、或 Key 过期重填，都不会生效。
   */
  apiKey?: string;
  /**
   * 动态取 Key（每次请求时解析）。
   * ★ 生产路径必须走这个：Key 存在 safeStorage 里，构造 LlmClient 时不取出，
   *   请求时才一次性解密，明文在主进程内的存活时间最短。
   *   同时保证「用户在设置里改了 Key」立刻对后续请求生效，无需重建客户端。
   */
  apiKeyProvider?: () => Promise<string | undefined> | string | undefined;
  /** 工具调用路径 */
  mode: ToolCallingMode;
  /** 全部可用工具（prompted 路径要注入 schema） */
  tools: ToolSpec[];
  /** 单次请求超时 */
  timeoutMs?: number;
}

/**
 * 短产出路径的调用预算（抽脑洞 / 拆书精读：一句话到一段 JSON，不是写一章）。
 * ★ 单一来源：两条路径共用这两个数，改一处即同改——此前它们各自吃客户端缺省的
 *   120s×4 次尝试，端点黑洞时最坏 ≈8 分钟才落演示兜底（老板报障「抽半天没反应」）。
 */
export const SHORT_OUTPUT_BUDGET = { timeoutMs: 30_000, maxRetries: 1 } as const;

export interface LlmStats {
  requests: number;
  retries: number;
  totalMs: number;
}

export class LlmClient {
  private stats: LlmStats = { requests: 0, retries: 0, totalMs: 0 };

  constructor(private cfg: LlmClientConfig) {}

  updateConfig(patch: Partial<LlmClientConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  getStats(): LlmStats {
    return { ...this.stats };
  }

  /**
   * 解析本次请求要用的 Key。顺序：apiKeyProvider（动态）→ cfg.apiKey（静态）。
   *
   * ★ provider 声明需要 Key 却取不到时，**在这里就抛 auth 错**，而不是发出一个
   *   不带 Authorization 头的请求去换一个难以归因的 401。
   *   修复前的形态正是后者：services.ts 构造客户端时从不传 Key，
   *   导致六家云 provider 的 Agent 请求全部无鉴权头 → 401，
   *   而用户在设置里「测试连接」却是通的（那条路径单独取了 Key）。
   */
  private async resolveApiKey(): Promise<string | undefined> {
    const key = this.cfg.apiKeyProvider
      ? await this.cfg.apiKeyProvider()
      : this.cfg.apiKey;
    if (!key && this.cfg.provider.requiresKey) {
      throw new LlmError(
        'auth',
        `未配置 ${this.cfg.provider.name} 的 API Key，请求未发出。请在「设置 → 模型」中填写后重试。`,
      );
    }
    return key || undefined;
  }

  /** 发起一次对话请求（含退避重试）。★ 调用点可用 req.maxRetries 收敛重试预算（0=只试一次）。 */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    let attempt = 0;
    let lastErr: LlmError | undefined;
    const maxRetries = req.maxRetries ?? 3;

    while (attempt <= maxRetries) {
      try {
        return await this.chatOnce(req);
      } catch (e) {
        if (e instanceof LlmError && !e.retryable) throw e;
        lastErr = e instanceof LlmError ? e : new LlmError('network', String(e));
        // 鉴权/用户取消不重试
        if (lastErr.kind === 'auth' || lastErr.kind === 'aborted') throw lastErr;
        attempt++;
        this.stats.retries++;
        if (attempt > maxRetries) break;
        // ★ H2：告诉调用方「下一次是第 attempt+1 次尝试」——重试发生在客户端内部，
        //   不告知的话进度播报器会把被 abort 的尝试字符也累加进来（谎报「已接收」）。
        req.onRetry?.(attempt + 1);
        // 指数退避：500ms / 1s / 2s
        const delay = 500 * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
    throw lastErr ?? new LlmError('network', 'LLM 请求失败');
  }

  private async chatOnce(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.cfg.timeoutMs ?? 120_000;

    // 合并调用方的 signal 与超时 signal
    const onAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) throw new LlmError('aborted', '调用方已取消');
      req.signal.addEventListener('abort', onAbort, { once: true });
    }
    /**
     * ★ 审查修复波 F1：计时器可续期（arm）。
     * 修复前是一次性 `setTimeout(abort, timeoutMs)`，覆盖**整个**流式读取——
     * A 批给短产出路径压的 30s 因此变成「总时长 30 秒」：健康的慢思考模型
     * （reasoning 动辄超过 30s）会在流跑到一半时被腰斩 → timeout 可重试 →
     * 第二次从零重发 → 约 61 秒必落演示兜底。E 批「想看见模型在想什么」的
     * 那类模型，恰好是 A 批最先误杀的那类。
     * 现在：流式路径每读到一个分片就 arm() 续命（口径=**多久没动静**），
     * 黑洞/卡流仍按 timeoutMs 到点即失败（一个字节都没有时不会续期）；
     * 非流式路径不续命（body 一次性读完，续命没有意义，保持总时长语义）。
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };
    arm();

    try {
      const body = this.buildBody(req);
      // 每次请求都重新解析 Key：用户改配置后立刻生效，无需重建客户端
      const apiKey = await this.resolveApiKey();
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw this.httpError(res.status, res.statusText, await res.text().catch(() => ''));
      }

      const wallMs = Date.now() - started;
      this.stats.requests++;
      this.stats.totalMs += wallMs;

      if (req.stream) {
        return await this.parseStream(res, wallMs, req.onDelta, arm);
      }
      const json = (await res.json()) as Record<string, unknown>;
      return this.parseJson(json, wallMs);
    } catch (e) {
      // controller.abort() 触发时区分「调用方取消」与「超时」；超时文案说空闲口径
      // （流式路径的 timeoutMs 是「多久没动静」，非流式是总时长——两者都由这条抛出）
      if (e instanceof Error && e.name === 'AbortError') {
        if (req.signal?.aborted) throw new LlmError('aborted', '已被取消');
        throw new LlmError('timeout', `请求超时（${timeoutMs}ms 内无响应）`);
      }
      if (e instanceof LlmError) throw e;
      throw new LlmError('network', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 组装请求体。按三条路径分别处理工具 */
  private buildBody(req: ChatRequest): Record<string, unknown> {
    const messages: unknown[] = [];

    // prompted 路径：把协议说明拼进 system
    if (this.cfg.mode === 'prompted') {
      const protocol = buildPromptedProtocolPrompt(this.cfg.tools);
      const sysIdx = req.messages.findIndex((m) => m.role === 'system');
      if (sysIdx >= 0) {
        messages.push({
          ...req.messages[sysIdx],
          content: `${req.messages[sysIdx].content}${protocol}`,
        });
        for (let i = 0; i < req.messages.length; i++) {
          if (i !== sysIdx) messages.push(this.toWireMessage(req.messages[i]));
        }
      } else {
        messages.push({ role: 'system', content: protocol });
        for (const m of req.messages) messages.push(this.toWireMessage(m));
      }
    } else {
      for (const m of req.messages) messages.push(this.toWireMessage(m));
    }

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 4096,
      stream: req.stream ?? false,
    };

    // native 路径才发 tools 参数；prompted 路径发了也没用（探测已确认它会忽略）
    if (this.cfg.mode === 'native' && req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      // tool_choice 由调用方指定（默认 'auto'，让模型自主选工具——这正是 Agent 的核心）
      body.tool_choice = req.tool_choice ?? 'auto';
    }
    return body;
  }

  private toWireMessage(m: ChatRequest['messages'][number]): Record<string, unknown> {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      }));
    }
    if (m.toolCallId) out.tool_call_id = m.toolCallId;
    return out;
  }

  private httpError(status: number, statusText: string, bodyText: string): LlmError {
    if (status === 401 || status === 403) {
      return new LlmError('auth', `鉴权失败（${status}）：请检查 API Key`, status);
    }
    if (status === 429) {
      return new LlmError('rate', `触发限流（${status}）`, status);
    }
    if (status >= 500) {
      return new LlmError('server', `上游错误 ${status} ${statusText}`, status);
    }
    // 4xx 里最有用的其实是 body 里的厂商错误码
    const snippet = bodyText.slice(0, 300);
    return new LlmError('badResponse', `请求被拒（${status}）：${snippet}`, status);
  }

  /** 解析非流式响应 */
  private parseJson(json: Record<string, unknown>, wallMs: number): ChatResponse {
    const choices = json.choices as Array<{
      message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      finish_reason?: string;
    }> | undefined;
    const choice = choices?.[0];
    const msg = choice?.message;
    const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };

    // native 路径：解析 tool_calls
    if (this.cfg.mode === 'native' && Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
      const toolCalls = msg.tool_calls.map((t) => ({
        id: t.id,
        name: t.function.name,
        args: safeParseArgs(t.function.arguments),
      }));
      return {
        content: msg?.content ?? '',
        toolCalls,
        usage: {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
          wallMs,
        },
        finishReason: choice?.finish_reason ?? null,
        viaTextProtocol: false,
      };
    }

    // prompted 路径：从文本里解析协议行
    const content = msg?.content ?? '';
    if (this.cfg.mode === 'prompted') {
      const parsed = parsePromptedCalls(content, this.cfg.tools);
      return {
        content,
        toolCalls: parsed.calls.map((c, i) => ({ id: `text_${i}`, name: c.name, args: c.args })),
        usage: {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
          wallMs,
        },
        finishReason: choice?.finish_reason ?? null,
        viaTextProtocol: true,
      };
    }

    return {
      content,
      toolCalls: [],
      usage: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, wallMs },
      finishReason: choice?.finish_reason ?? null,
      viaTextProtocol: false,
    };
  }

  /**
   * 解析 SSE 流。累积 delta.content 与 delta.tool_calls。
   * ★ E批「模型思考过程可见」：每片增量原样转发给 onDelta（调用方自选消费，
   *   累积语义与既有完全一致，不传 onDelta 的老调用方零影响）。思考流字段
   *   厂商有差异：DeepSeek 官方是 `reasoning_content`，部分代理网关转发成
   *   `reasoning`——两名都认，但**绝不混进 content**（思考不是正文，混进去
   *   会污染 extractJson 的输入）。
   */
  private async parseStream(
    res: Response,
    wallMs: number,
    onDelta?: (d: { content?: string; reasoning?: string }) => void,
    /** ★ F1：读到任何分片就续命（空闲超时口径）；缺省不续命（总时长语义） */
    onActivity?: () => void,
  ): Promise<ChatResponse> {
    if (!res.body) {
      throw new LlmError('badResponse', '响应无 body，无法流式解析');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: string | null = null;
    let usageIn = 0;
    let usageOut = 0;

    // tool_calls 分片累积：index -> {id, name, args}
    const pending = new Map<number, { id: string; name: string; args: string }>();

    // ★ H1：事件体解析抽成闭包——读流循环与尾缓冲 flush 走同一套口径（不复制第二份）
    let sawDone = false;
    const consumeEvent = (chunk: string): void => {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        // ★ H1-2：[DONE] 是终帧，直接断流。旧口径 continue 下去，keep-alive 网关
        //   不关连接时只能干等到超时→重试→落演示兜底——正文其实早就到手了。
        if (payload === '[DONE]') {
          sawDone = true;
          return;
        }
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // 厂商偶发发非 JSON 心跳帧，跳过而不中断整个流
          continue;
        }
        // ★ H1-3：流中 error 帧不是心跳。吞掉它只会让上屏的回落真因变成「未过
        //   Schema 契约」这种假话——provider 说了什么就报什么（server 口径，
        //   与 http 层同一条重试规则）。
        const streamErr = evt.error as { message?: unknown; code?: unknown } | undefined;
        if (streamErr !== undefined && streamErr !== null) {
          const raw = typeof streamErr.message === 'string' && streamErr.message ? streamErr.message : JSON.stringify(streamErr);
          throw new LlmError('server', `流式响应报错：${raw}`);
        }
        const choice = (evt.choices as Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>)?.[0];

        if (choice?.delta?.content) content += choice.delta.content;

        // E批：增量转发（正文 + 思考流）。只转发本片真有的字段，不造空串。
        if (onDelta) {
          const dc = choice?.delta?.content;
          const dr = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
          if (dc || dr) {
            onDelta({
              ...(dc ? { content: dc } : {}),
              ...(dr ? { reasoning: dr } : {}),
            });
          }
        }

        if (Array.isArray(choice?.delta?.tool_calls)) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = pending.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            pending.set(idx, cur);
          }
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;

        const u = evt.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (u?.prompt_tokens) usageIn = u.prompt_tokens;
        if (u?.completion_tokens) usageOut = u.completion_tokens;
      }
    };

    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      // ★ F1：只要还在收到字节，就把超时计时器往后推——慢不等于死
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      // ★ H1-1：行尾归一。SSE 规范承认 \r\n，旧口径只认 \n\n，CRLF 端点整条流
      //   一个事件都解析不出来（content 恒空 → 假回落）。在**整段 buffer** 上做，
      //   所以一片尾裸 \r + 下片头 \n 这种跨片切分也能补齐。
      buffer = buffer.replace(/\r\n/g, '\n');

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0 && !sawDone) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        consumeEvent(chunk);
      }
    }

    // ★ H1-4：收尾。decoder 冲掉跨片切开的半个多字节字符，剩下的尾帧（服务端发完
    //   最后一帧直接关流、没补空行，很常见）也必须解析，否则最后一段正文静默丢失。
    if (!sawDone) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, '\n');
      const rest = buffer.trim();
      if (rest) consumeEvent(rest);
    }

    await reader.cancel().catch(() => undefined);

    const toolCalls = [...pending.values()]
      .filter((t) => t.name)
      .map((t, i) => ({ id: t.id || `s_${i}`, name: t.name, args: safeParseArgs(t.args) }));

    // 流式下工具调用也要走 prompted 解析（本地模型可能在文本里输出协议行）
    if (this.cfg.mode === 'prompted' && toolCalls.length === 0) {
      const parsed = parsePromptedCalls(content, this.cfg.tools);
      return {
        content,
        toolCalls: parsed.calls.map((c, i) => ({ id: `text_${i}`, name: c.name, args: c.args })),
        usage: { input: usageIn, output: usageOut, wallMs },
        finishReason,
        viaTextProtocol: true,
      };
    }

    return {
      content,
      toolCalls,
      usage: { input: usageIn, output: usageOut, wallMs },
      finishReason,
      viaTextProtocol: this.cfg.mode === 'prompted',
    };
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { toOpenAiTools };