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
  pricing: ProviderPricing;
  capabilities: ProviderCapabilities;
  /**
   * 本地模型需要探测云端才有的能力。
   * 结果缓存进 settings，仅首次配置或用户手动「重新检测」时执行。
   */
  probe?: () => Promise<Partial<ProviderCapabilities>>;
}

/** provider 的可配置项（不含 Key —— Key 走 keyring，渲染层永远拿不到明文） */
export interface ProviderSettings {
  providerId: string;
  baseUrl: string;
  model: string;
  /** Key 是否已配置（主进程只回这个布尔值与掩码） */
  hasKey: boolean;
  /** 掩码后的 Key，如 sk-a•••xyz；绝不是明文 */
  displayKey: string;
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