/**
 * Provider 清单（架构 §1.4.5）。
 *
 * 云端 4 家 + 本地 2 家。新增厂商只需在此加一行 + probe 实测能力，
 * **不需要改 Agent 引擎任何代码** —— 这是 provider 抽象层的全部意义。
 */
import type { LlmProvider } from '../types/provider';

export const PROVIDERS: LlmProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    requiresKey: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    pricing: { inputPerMTok: 2, outputPerMTok: 8, currency: 'CNY' },
    capabilities: { functionCalling: 'native', streaming: true, maxContextTokens: 64_000 },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    requiresKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    // 按模型路由，单价不固定；此处为保守占位，实际按用户选的 model 覆盖
    pricing: { inputPerMTok: 5, outputPerMTok: 15, currency: 'CNY' },
    capabilities: { functionCalling: 'native', streaming: true, maxContextTokens: 32_000 },
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    requiresKey: true,
    defaultBaseUrl: 'https://api.opencode-zen.com/v1',
    pricing: { inputPerMTok: 5, outputPerMTok: 15, currency: 'CNY' },
    capabilities: { functionCalling: 'native', streaming: true, maxContextTokens: 32_000 },
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    // 本地模型恒0 —— cost.ts 先判 pricing===0 再累加，改记本机耗时
    pricing: { inputPerMTok: 0, outputPerMTok: 0, currency: 'CNY' },
    capabilities: {
      // 【待验证 V13】版本差异大，必须 probe 实测，不能照抄文档
      functionCalling: 'prompted',
      streaming: true,
      maxContextTokens: 8_192,
    },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    pricing: { inputPerMTok: 0, outputPerMTok: 0, currency: 'CNY' },
    capabilities: { functionCalling: 'prompted', streaming: true, maxContextTokens: 8_192 },
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    requiresKey: false,
    defaultBaseUrl: '',
    pricing: { inputPerMTok: 0, outputPerMTok: 0, currency: 'CNY' },
    capabilities: { functionCalling: 'prompted', streaming: true, maxContextTokens: 8_192 },
  },
];

export const DEFAULT_PROVIDER_ID = 'deepseek';

export function findProvider(id: string): LlmProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isLocalProvider(id: string): boolean {
  return id === 'ollama' || id === 'lmstudio';
}

/** 本地模型能力不足时的提示：必须明示，不许静默降级（架构 §1.4.5） */
export const LOCAL_MODEL_NOTICE =
  '本地模型自主决策能力较弱，建议用于规则执行而非复杂规划。';

/** prompted 文本协议的稳定性提示 */
export const PROMPTED_PROTOCOL_NOTICE =
  '工具调用走文本协议（而非原生 tools），解析失败率高于原生路径。';

/** unsupported 时的降级提示：这是能力降级，不是错误 */
export const UNSUPPORTED_NOTICE =
  '已切换为单步模式：工具需你手动选择，Agent 不再做自主规划。';