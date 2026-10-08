/**
 * 工具执行沙箱（架构 §1.3 铁律 / T18）。
 *
 * ★ 本文件是「唯一防线」的执行点。三件事必须在这里、且只能在这里做：
 *
 *   1. **Zod 重新校验 args** —— 不信任渲染层、不信任模型。
 *      架构原话：渲染层传来的 args 主进程重新校验。
 *
 *   2. **执行前强制落 checkpoint** —— 写工具在改动任何正文前必须落快照，
 *      **失败即拒绝执行**。这是 fail-safe 的唯一正确形式：
 *      绝不是「继续执行并记录警告」——那等于没有防线。
 *
 *   3. **catch 内先回滚再 rethrow** —— 架构 §6 第 4 条：
 *      「不要指望 finally——异常可能发生在任何一步」。
 *
 * 另：preview 与 execute 走**同一条路径**，只用 ctx.dryRun 区分。
 * 这是杜绝「预览说改 3 处、实际改了 4 处」的结构性保证。
 */
import type { ToolContext, ToolResult, ToolSpec } from '@shared/types/tool';
import { zodSchemaFor } from '../llm/tool-calling';
import { decideWrite } from './write-policy';
import type { WritePolicyConfig } from '@shared/types/tool';
import { MzError } from '@shared/types/ipc';

export interface SandboxDeps {
  /** 强制落快照；失败会抛，调用方不得 catch 后继续 */
  requireCheckpoint: (chapters: readonly string[]) => Promise<string>;
  /** 回滚到某 checkpoint（catch 内用） */
  rollbackTo?: (checkpointId: string) => Promise<void>;
  /** 需要用户确认时的回调；返回 true = 已放行 */
  requestApproval?: (info: { toolName: string; danger: number; reason: string }) => Promise<boolean>;
}

export interface SandboxOptions {
  runId: string;
  stepNo: number;
  dryRun: boolean;
  writePolicy: WritePolicyConfig;
  signal: AbortSignal;
  logger: (msg: string) => void;
  deps: SandboxDeps;
}

export interface ExecuteOutcome {
  result: ToolResult;
  /** 实际采取的动作 */
  action: 'execute' | 'preview-only' | 'need-approval' | 'blocked' | 'rejected';
  /** 执行时用到的 checkpoint（供提交与回滚） */
  checkpointId?: string;
}

export async function executeTool(
  spec: ToolSpec,
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>,
  rawArgs: unknown,
  opts: SandboxOptions,
): Promise<ExecuteOutcome> {
  const started = Date.now();

  // ── 0. 取消检查：用户叫停后不应再执行 ──
  if (opts.signal.aborted) {
    return {
      action: 'rejected',
      result: {
        ok: false,
        durationMs: Date.now() - started,
        error: { code: 'E_TOOL_REFUSED', message: '已被叫停，未执行', retryable: false },
      },
    };
  }

  // ── 1. Zod 重新校验（不信任模型与渲染层）──
  const schema = zodSchemaFor(spec);
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    // ★ 逐项点名错误路径（复刻原型 dmObjArr 的E.push('m4.techniques[0].name') 形态）
    const errors = parsed.error.issues.map((i) => {
      const path = i.path.join('.');
      return `${path || '(根)'}: ${i.message}`;
    });
    return {
      action: 'rejected',
      result: {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_INVALID_ARGS',
          message: `参数校验未通过：\n${errors.map((e) => `  · ${e}`).join('\n')}`,
          retryable: true,
          // ★ 把错误回喂让模型自纠，**不重发整个请求**，只让它改参数
          hint: `可用参数：${spec.params.map((p) => `${p.name}(${p.required ? '必填' : '选填'})`).join(', ')}`,
        },
      },
    };
  }
  const args = parsed.data as Record<string, unknown>;

  // ── 2. 写策略判定 ──
  const decision = decideWrite(spec, opts.writePolicy);
  if (decision.action === 'blocked') {
    return {
      action: 'blocked',
      result: {
        ok: false,
        durationMs: Date.now() - started,
        error: { code: 'E_PERMISSION_DENIED', message: decision.reason, retryable: false },
      },
    };
  }

  // dryRun 覆盖：预览模式下永不落盘
  const effectiveDryRun = opts.dryRun || decision.action === 'preview-only';

  if (decision.action === 'need-approval') {
    if (!opts.deps.requestApproval) {
      return {
        action: 'rejected',
        result: {
          ok: false,
          durationMs: Date.now() - started,
          error: {
            code: 'E_PERMISSION_DENIED',
            message: decision.reason,
            retryable: false,
            hint: '当前无用户确认通道。请在设置里把写策略改为 auto-with-undo，或在 UI 中确认。',
          },
        },
      };
    }
    const allowed = await opts.deps.requestApproval({
      toolName: spec.name,
      danger: spec.danger,
      reason: decision.reason,
    });
    if (!allowed) {
      return {
        action: 'rejected',
        result: {
          ok: false,
          durationMs: Date.now() - started,
          error: { code: 'E_PERMISSION_DENIED', message: '用户拒绝了该工具调用。', retryable: false },
        },
      };
    }
  }

  // ── 3. ★执行前强制落 checkpoint（fail-safe）──
  let checkpointId: string | undefined;
  /** 当前快照已覆盖的章节。ctx.requireCheckpoint 靠它判断能否复用既有快照 */
  const coveredChapters = new Set<string>();
  if (spec.writes && spec.reversible && !effectiveDryRun) {
    const chapters = extractChapterIds(args);
    if (chapters.length > 0) {
      try {
        checkpointId = await opts.deps.requireCheckpoint(chapters);
        for (const c of chapters) coveredChapters.add(c);
      } catch (e) {
        // ★★★ 快照失败 = 拒绝执行。不是「继续执行并记录警告」。
        // 这是决策 1 把 preview 降级后唯一的防线，
        // 一旦它变成「尽力而为」，用户原稿就失去了最后保障。
        const reason = e instanceof Error ? e.message : String(e);
        return {
          action: 'rejected',
          result: {
            ok: false,
            durationMs: Date.now() - started,
            error: {
              code: 'E_CHECKPOINT_FAILED',
              message: `拒绝执行：${reason}`,
              retryable: false,
              hint: '这是 fail-safe 设计——没有快照就不改稿。请检查项目目录是否可写、磁盘空间是否充足。',
            },
          },
        };
      }
    }
  }

  // ── 4. 构造执行上下文并调用 ──
  const ctx: ToolContext = {
    runId: opts.runId,
    stepNo: opts.stepNo,
    dryRun: effectiveDryRun,
    // 工具内部若也要落快照，走同一个回调（sandbox 已落过则复用）
    requireCheckpoint: async (chs) => {
      // ★ 只复用「已覆盖这些章节」的快照。
      //   修复前只要 checkpointId 存在就直接返回旧 id，于是工具想为**其它章节**
      //   落快照时拿到的是不相关的旧快照 —— 那些章节在**无快照**状态下被改写，
      //   直接破坏本文件开头声明的 fail-safe 铁律（「改了但没快照」必须被禁止）。
      const uncovered = chs.filter((c) => !coveredChapters.has(c));
      if (uncovered.length === 0 && checkpointId) return checkpointId;
      if (checkpointId) {
        throw new Error(
          `工具请求为未纳入本次快照的章节落快照：${uncovered.join(', ')}。` +
          `已存在的快照 ${checkpointId} 只覆盖 ${[...coveredChapters].join(', ') || '（空）'}。` +
          `这是工具声明（ToolSpec）与实现不一致，为避免「改了但没快照」已拒绝执行。`,
        );
      }
      checkpointId = await opts.deps.requireCheckpoint(chs);
      for (const c of chs) coveredChapters.add(c);
      return checkpointId;
    },
    signal: opts.signal,
    logger: opts.logger,
  };

  let result: ToolResult;
  // ★ 记录「是否真的回滚成功」。修复前只要 checkpointId 存在，错误消息就断言
  //   「已自动回滚，正文已复原」—— 但回滚还需要 deps.rollbackTo 存在且非 dryRun，
  //   两个条件任一不满足时根本没回滚，却对用户做了虚假的安全承诺。
  let rolledBack = false;
  try {
    result = await handler(args, ctx);
  } catch (e) {
    // ── 5. ★catch 内先回滚再 rethrow ──
    // 架构 §6 第 4 条：不要指望 finally——异常可能发生在任何一步。
    if (checkpointId && opts.deps.rollbackTo && !effectiveDryRun) {
      try {
        await opts.deps.rollbackTo(checkpointId);
        rolledBack = true;
      } catch (rollbackErr) {
        // 回滚本身失败是更严重的问题：必须让用户知道正文状态不确定
        return {
          action: 'rejected',
          checkpointId,
          result: {
            ok: false,
            durationMs: Date.now() - started,
            error: {
              code: 'E_CHECKPOINT_FAILED',
              message:
                `工具执行异常：${e instanceof Error ? e.message : String(e)}\n` +
                `⚠️ 自动回滚也失败了：${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}\n` +
                `正文状态不确定，请用「改动历史」手动回滚到 checkpoint ${checkpointId} 之前。`,
              retryable: false,
            },
          },
        };
      }
    }
    // 回滚成功后再抛：让调用方知道「工具失败，但正文已复原」
    return {
      action: 'rejected',
      checkpointId,
      result: {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_INTERNAL',
          message:
            `工具执行异常：${e instanceof Error ? e.message : String(e)}` +
            (rolledBack
              ? '（已自动回滚，正文已复原）'
              : checkpointId
                ? `（⚠️ 未能自动回滚，请用「改动历史」手动回滚到 checkpoint ${checkpointId} 之前）`
                : ''),
          retryable: false,
        },
      },
    };
  }

  // ── 6. 执行失败但已有落盘：按 retryable 决定是否回滚 ──
  if (!result.ok && checkpointId && !effectiveDryRun && spec.writes && opts.deps.rollbackTo) {
    const retryable = result.error?.retryable ?? false;
    if (!retryable) {
      // 不可重试的错误（如校验器拒绝）：回滚，避免留下半成品
      try {
        await opts.deps.rollbackTo(checkpointId);
        result = {
          ...result,
          error: result.error
            ? { ...result.error, message: `${result.error.message}（已自动回滚，正文已复原）` }
            : undefined,
        };
      } catch {
        // 回滚失败：如实告知，不静默
        result = {
          ok: false,
          durationMs: Date.now() - started,
          error: {
            code: 'E_CHECKPOINT_FAILED',
            message: `${result.error?.message ?? '工具失败'}；⚠️ 自动回滚失败，请手动检查。`,
            retryable: false,
          },
        };
      }
    }
  }

  return {
    action: decision.action === 'preview-only' ? 'preview-only' : 'execute',
    result,
    checkpointId,
  };
}

/** 从 args 里抽出章节 id 列表（各工具参数名不同） */
function extractChapterIds(args: Record<string, unknown>): string[] {
  const v = args.chapterIds ?? args.chapterId;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

export { MzError };