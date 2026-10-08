/**
 * 三条工具调用路径（架构 §1.4.5 / T26）。
 *
 * | functionCalling | 执行路径 |
 * |---|---|
 * | native       | 标准 tools 参数 + tool_calls 响应 |
 * | prompted     | **文本协议**：把 schema 写进系统提示，要求输出 `<<TOOL:name{json}>>`；主进程用正则 + Zod 解析 |
 * | unsupported  | **降级为单步模式**：不做多轮规划，改为「用户选工具 → Agent 填参数 → 预览 → 执行」 |
 *
 * ★ unsupported 的降级**必须明示**（架构 §6.1 第 16 条）：
 *   顶栏和轨迹面板都要显示，不能只在日志里记一笔。
 *   用户选本地模型往往是出于隐私或成本，这种降级直接影响了他们的核心诉求能否成立。
 */
import { z } from 'zod';
import type { ToolSpec } from '@shared/types/tool';
import type { ToolCallingMode } from '@shared/types/provider';

/** prompted 路径的协议标记 */
export const TOOL_MARKER_OPEN = '<<TOOL:';
export const TOOL_MARKER_CLOSE = '>>';

/** 工具名白名单：只接受注册表里有的名字，防止模型编造工具 */
function buildNameSet(specs: ToolSpec[]): Set<string> {
  return new Set(specs.map((s) => s.name));
}

/**
 * 生成 prompted 文本协议的说明段，注入系统提示。
 *
 * 设计要点：
 *   - 给出**恰好一个**输出格式，不给「示例仅供参考」这类模糊话——本地模型对格式敏感
 *   - 明确说不支持的场景（多工具并行、嵌套调用）
 *   - 说明空输出是合法的（表示「本步不需要调工具」）
 */
export function buildPromptedProtocolPrompt(specs: ToolSpec[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('=== 工具调用协议（本模型不支持原生 tool_calls，使用文本协议）===');
  lines.push('当你要调用工具时，**只输出下面这一行**，不要有任何额外解释：');
  lines.push('');
  lines.push('<<TOOL:工具名{"参数名":"参数值"}>>');
  lines.push('');
  lines.push('可用工具：');
  for (const s of specs) {
    const params = s.params
      .map((p) => {
        const enumPart = p.enum ? `（可选值：${p.enum.join(' | ')}）` : '';
        const req = p.required ? '必填' : '选填';
        return `${p.name}: ${p.type} ${req} ${enumPart} —— ${p.description}`;
      })
      .join('\n');
    lines.push(`\n【${s.name}】${s.displayName}`);
    lines.push(`  用途：${s.description}`);
    lines.push(`  参数：\n${params.split('\n').map((l) => `    ${l}`).join('\n')}`);
  }
  lines.push('');
  lines.push('规则：');
  lines.push('- 参数值必须是合法 JSON（双引号、无注释、无尾逗号）');
  lines.push('- 一次只调一个工具。下一个工具在下一轮再调。');
  lines.push('- 如果本步不需要调工具（已经想清楚了），只输出一句话说明你的判断，不要输出协议行。');
  lines.push('- 不要在协议行之外添加 markdown 代码块标记。');
  lines.push('=== 协议结束 ===');
  return lines.join('\n');
}

/** 从模型输出中提取全部协议行 */
export function extractProtocolCalls(text: string): Array<{ name: string; argsRaw: string }> {
  const out: Array<{ name: string; argsRaw: string }> = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(TOOL_MARKER_OPEN, i);
    if (start < 0) break;
    const nameStart = start + TOOL_MARKER_OPEN.length;
    const braceStart = text.indexOf('{', nameStart);
    const end = text.indexOf(TOOL_MARKER_CLOSE, braceStart < 0 ? nameStart : braceStart);
    if (end < 0) break;

    const name = text.slice(nameStart, braceStart < 0 ? end : braceStart).trim();
    const argsRaw = braceStart < 0 ? '{}' : text.slice(braceStart, end).trim();
    out.push({ name, argsRaw });
    i = end + TOOL_MARKER_CLOSE.length;
  }
  return out;
}

/** 用 Zod 解析参数 —— 逐项点名错误路径（复刻原型 dmObjArr 的能力） */
function parseArgsStrict(
  argsRaw: string,
  spec: ToolSpec,
): { ok: true; args: Record<string, unknown> } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(argsRaw || '{}');
  } catch (e) {
    return {
      ok: false,
      errors: [`参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}`],
    };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, errors: ['参数必须是 JSON 对象'] };
  }

  const errors: string[] = [];
  const obj = json as Record<string, unknown>;

  for (const p of spec.params) {
    const v = obj[p.name];
    if (p.required && (v === undefined || v === null)) {
      errors.push(`缺少必填参数 ${p.name}：${p.description}`);
      continue;
    }
    if (v === undefined || v === null) {
      if (p.default !== undefined) obj[p.name] = p.default;
      continue;
    }
    if (p.enum && !p.enum.includes(v as string)) {
      errors.push(`参数 ${p.name} 取值非法：${JSON.stringify(v)}，可选值：${p.enum.join(' | ')}`);
    }
    if (p.type === 'string' && typeof v !== 'string') {
      errors.push(`参数 ${p.name} 应为字符串，实际为 ${typeof v}`);
    }
    if (p.type === 'string[]' && !Array.isArray(v)) {
      errors.push(`参数 ${p.name} 应为字符串数组`);
    }
    if (p.type === 'number' && typeof v !== 'number') {
      errors.push(`参数 ${p.name} 应为数字`);
    }
  }

  // 未声明的参数直接报错——模型多传字段通常是误解了工具语义
  const known = new Set(spec.params.map((p) => p.name));
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) {
      errors.push(`未知参数 ${k}。可用参数：${[...known].join(', ')}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, args: obj };
}

/**
 * 解析模型的工具调用意图（文本协议路径）。
 * 失败时返回逐项点名错误，供 Agent 自我纠正——**不重发整个请求**。
 */
export function parsePromptedCalls(
  text: string,
  specs: ToolSpec[],
): {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  errors: string[];
} {
  const names = buildNameSet(specs);
  const raw = extractProtocolCalls(text);
  const errors: string[] = [];

  if (raw.length === 0) {
    // 没有协议行：模型可能是想直接说话，由调用方判断这是不是合法的「不需要工具」
    return { calls: [], errors: [] };
  }

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const r of raw) {
    const spec = specs.find((s) => s.name === r.name);
    if (!spec) {
      errors.push(
        `不存在的工具「${r.name}」。可用工具：${[...names].join(', ')}。` +
          `不要猜测工具名。`,
      );
      continue;
    }
    const parsed = parseArgsStrict(r.argsRaw, spec);
    if (parsed.ok) {
      calls.push({ name: r.name, args: parsed.args });
    } else {
      for (const e of parsed.errors) errors.push(`工具 ${r.name}：${e}`);
    }
  }

  return { calls, errors };
}

/**
 * 把 ToolSpec 转成 OpenAI tools 参数格式（native 路径）。
 */
export function toOpenAiTools(specs: ToolSpec[]): unknown[] {
  return specs.map((s) => ({
    type: 'function',
    function: {
      name: s.name,
      description: s.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          s.params.map((p) => [
            p.name,
            {
              type: p.type === 'string[]' ? 'array' : p.type,
              ...(p.type === 'string[]' ? { items: { type: 'string' } } : {}),
              description: p.description,
              ...(p.enum ? { enum: p.enum } : {}),
            },
          ]),
        ),
        required: s.params.filter((p) => p.required).map((p) => p.name),
      },
    },
  }));
}

/** 该模式下 Agent 能否自主规划 */
export function canPlanAutonomously(mode: ToolCallingMode): boolean {
  return mode !== 'unsupported';
}

/** Zod schema：由 ToolSpec 生成，供 sandbox 二次校验（不信任模型输出） */
export function zodSchemaFor(spec: ToolSpec): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of spec.params) {
    let zt: z.ZodTypeAny;
    switch (p.type) {
      case 'string':
        zt = z.string();
        break;
      case 'number':
        zt = z.number();
        break;
      case 'boolean':
        zt = z.boolean();
        break;
      case 'string[]':
        zt = z.array(z.string());
        break;
      case 'number[]':
        zt = z.array(z.number());
        break;
      case 'object':
      default:
        zt = z.record(z.unknown());
        break;
    }
    if (p.enum && p.enum.length > 0) {
      zt = z.enum(p.enum as [string, ...string[]]);
    }
    if (!p.required) {
      zt = zt.optional();
    }
    shape[p.name] = zt;
  }
  return z.object(shape).strict();
}