/**
 * Provider 抽象层类型（架构 §1.4.5）。
 * 目标：新增一个厂商只需在清单里加一行 + probe 实测能力，不改 Agent 引擎任何代码。
 */

export type ToolCallingMode = 'native' | 'prompted' | 'unsupported';

export interface ProviderPricing {
  /** 元 / 百万 token。本地模型为 0 */
  inputPerMTok: number;
  outputPerMTok: number;
  currency: 'CNY';
}

export interface ProviderCapabilities {
  functionCalling: ToolCallingMode;
  streaming: boolean;
  maxContextTokens: number;
}

export interface LlmProvider {
  id: string;
  name: string;
  /** 本地模型为 false */
  requiresKey: boolean;
  /** 默认 baseUrl，可被用户覆盖 */
  defaultBaseUrl: string;
  /**
   * 用户未显式填模型时的兜底值。
   * ★ 必须是**本厂商**的模型名。缺省或空串表示「无合理默认，必须由用户填写」
   *   ——本地运行时装了什么模型只有用户知道。
   *   此前没有这个字段，services.ts 只能硬编码 'deepseek-chat' 当六家通用兜底，
   *   切到 OpenRouter 却没填模型时会把 DeepSeek 的模型名发过去，必然失败。
   */
  defaultModel?: string;
  pricing: ProviderPricing;
  capabilities: ProviderCapabilities;
  /**
   * 本地模型需要探测云端才有的能力。
   * 结果缓存进 settings，仅首次配置或用户手动「重新检测」时执行。
   */
  probe?: () => Promise<Partial<ProviderCapabilities>>;
}

/**
 * ★ Key 凭据文件的真实状态（§4 第 14 条②）。
 *
 * safeStorage 的密钥按机器 / 按 Windows 用户（DPAPI），所以「有文件」不等于「能用」：
 * 便携包换机器后旧 llm-credentials.bin 必然解不开。修复前只有 hasKey 一个布尔，
 * 「从没配过」和「配过但解不开」都显示成"未配置"，用户完全不知道问题出在哪。
 */
export type CredentialState =
  /** 解得开，可用 */
  | 'ok'
  /** 根本没有凭据文件：用户确实还没配 Key */
  | 'none'
  /** 文件在但解不开 —— 换机器 / 换 Windows 用户，必须让用户重新输入 */
  | 'needs-reentry'
  /** 读不出字节或加密后端不可用 —— 原因未知，不能谎报成"换机器了" */
  | 'unreadable';

/** provider 的可配置项（不含 Key —— Key 走 keyring，渲染层永远拿不到明文） */
export interface ProviderSettings {
  providerId: string;
  baseUrl: string;
  model: string;
  /** Key 是否已配置（主进程只回这个布尔值与掩码） */
  hasKey: boolean;
  /** 掩码后的 Key，如 sk-a•••xyz；绝不是明文 */
  displayKey: string;
  /** hasKey 为 false 时区分「没配过」和「配过但解不开」 */
  keyState: CredentialState;
  capabilities: ProviderCapabilities;
  /** 上次能力探测时间；0 = 从未探测 */
  probedAt: number;
}

/**
 * ★ 四态能力明示（架构 §1.4.5）。顶栏必须按这四态显示，不能都显示「已连接」。
 * 顺序即严重度递增。
 */
export type LlmUiState =
  /** 云端 + native：完整 Agent */
  | { kind: 'cloud-native'; providerName: string }
  /** 云端 + prompted：完整 Agent，但稳定性略低，需提示 */
  | { kind: 'cloud-prompted'; providerName: string }
  /** 本地 + prompted：完整 Agent，明示可能失败较多 */
  | { kind: 'local-prompted'; providerName: string }
  /** 本地 + unsupported：★能力降级，禁用自主规划，必须明示 */
  | { kind: 'local-unsupported'; providerName: string }
  /** 未配置：规则模式可用（这是可用状态，不是错误） */
  | { kind: 'unconfigured' };

export interface LlmStatus {
  configured: boolean;
  isLocal: boolean;
  uiState: LlmUiState;
  settings: ProviderSettings | null;
}

/** 一次调用的用量。cost.ts 依此累加 token 与金额 */
export interface LlmUsage {
  input: number;
  output: number;
  wallMs: number;
}

/** 一次对话请求 */
export interface ChatRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    toolCallId?: string;
  }>;
  tools?: unknown[];
  /** native 路径的强制策略；'auto' 让模型自己决定（架构 §1.4.5） */
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 强制非流式：规划/评估需要完整 JSON，流式拼接反而更麻烦 */
  stream?: boolean;
  /**
   * 单次请求超时（毫秒）。缺省用客户端级 `timeoutMs`，再缺省 120s。
   * ★ 为什么要按调用点传：120s×4 次尝试对「写一章」是合理保险，对「抽一个脑洞」
   *   是灾难——端点黑洞时用户要等 ≈8 分钟才看到演示兜底（老板报障「抽半天没反应」
   *   的根因）。短产出路径自己声明紧预算，不动全局缺省。
   */
  timeoutMs?: number;
  /**
   * 重试次数上限（0 = 只试一次）。缺省 3（既有口径：共 4 次尝试）。
   * 与 timeoutMs 同理：重试是给偶发抖动的，不是给黑洞端点放大等待的。
   */
  maxRetries?: number;
  /**
   * 流式增量回调（E批「模型思考过程可见」）。仅 stream:true 时生效：
   * parseStream 每收到一片 delta 就转发一次——content 是正文增量，
   * reasoning 是思考流增量（DeepSeek-R1 式 reasoning_content，部分代理
   * 网关字段名是 reasoning，客户端两名都认）。回调在主进程内同步执行，
   * **不经 IPC**（IPC 出口在服务层的 onProgress，见 LlmProgress）。
   */
  onDelta?: (d: { content?: string; reasoning?: string }) => void;
}

/**
 * 短产出路径（抽脑洞 / 拆书精读）的等待进度事件（E批「模型思考过程可见」）。
 *
 * 老板报障：「只是按钮显示抽卡中，卡一晚上我也不知道他到底在干什么」。
 * 本 DTO 就是答案：等了多久、第几次尝试、收到了多少字、模型正在思考还是
 * 正在产出、以及——provider 真的回了 reasoning_content 时——思考的尾部片段。
 *
 * ★ 诚实纪律（DRD §7）：
 *   - 每个字段都来自真实观测（elapsedMs 是测的、charsSeen 是数出来的），
 *     没有任何推测值；
 *   - thought 只是**尾部片段**（≤200 字，推送载荷限长），不是完整思考，
 *     渲染层必须如实标注「片段」；
 *   - provider 没回思考流时 thought 恒缺席，渲染层明示「该模型未返回思考
 *     内容」，绝不编造；
 *   - fallback 的 note 携带**真因**（异常原文），演示兜底不许看起来像模型产出。
 */
export interface LlmProgress {
  /** 哪条短产出路径：抽脑洞 / 拆书精读 */
  scope: 'idea' | 'teardown';
  /**
   * start=已发起等待模型 / thinking=reasoning 增量到达中 / writing=正文增量
   * 到达中 / retry=一次重试开始 / done=live 产出完成 / error=出错（无兜底路径）
   * / fallback=已如实回落演示数据（note 带真因）
   */
  phase: 'start' | 'thinking' | 'writing' | 'retry' | 'done' | 'error' | 'fallback';
  /** 第几次尝试（从 1 起）。服务层经 PipelineLlm 看不到客户端内部重试时恒 1，不谎报 */
  attempt: number;
  /** 自发起调用起的实测毫秒数（不是估的） */
  elapsedMs: number;
  /** 已流回的字符数（思考 + 正文，收到多少数多少） */
  charsSeen: number;
  /** 思考流尾部片段（≤200 字）；provider 未返回 reasoning_content 时缺席 */
  thought?: string;
  /** 补充说明；fallback 时**必须**携带真因 */
  note?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage: { input: number; output: number; wallMs: number };
  /** provider 返回的原生 finish_reason，用于区分「自然结束」与「被长度截断」 */
  finishReason: string | null;
  /** 是否经过了 prompted 文本协议解析（供UI 提示稳定性） */
  viaTextProtocol: boolean;
}