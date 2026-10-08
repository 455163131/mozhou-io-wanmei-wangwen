/**
 * 撤销 / 回滚工具（架构 §1.6 工具 13-14）。
 *
 * ★ 叫停 ≠ 回滚（架构 §6.1 第 12 条）：
 *   叫停 = 停止下一步、保留已改（在 AgentHost 里，不在本文件）
 *   回滚 = 撤销改动（本文件）
 *   两者在 UI 上必须是两个独立控件。
 */
import type { ToolContext, ToolResult } from '@shared/types/tool';
import type { RollbackResult } from '@shared/types/checkpoint';
import { MzError } from '@shared/types/ipc';

export interface UndoDeps {
  undoToCheckpoint: (checkpointId: string, force: boolean) => Promise<RollbackResult>;
  rollbackRule: (checkpointId: string, chapterId: string, newBody: string) => Promise<{ restored: boolean; body: string }>;
  getBody: (chapterId: string) => Promise<string | null>;
}

export async function undoToCheckpoint(
  args: { checkpointId: string },
  _ctx: ToolContext,
  deps: UndoDeps,
): Promise<ToolResult<RollbackResult>> {
  const started = Date.now();
  if (!args.checkpointId) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: '缺少 checkpointId。',
        retryable: true,
        hint: '从轨迹面板或「改动历史」里取目标步骤对应的 checkpointId。',
      },
    };
  }

  try {
    // force=false：若有手动修改冲突，Replayer 会抛 E_ROLLBACK_CONFLICT，
    // 由上层弹确认框后带 force=true 重试
    const result = await deps.undoToCheckpoint(args.checkpointId, false);
    return {
      ok: true,
      data: result,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    if (e instanceof MzError && e.code === 'E_ROLLBACK_CONFLICT') {
      // 逐项点名，让 Agent/用户知道会丢什么
      const detail = e.detail as { lostManualEdits?: number; lostEdits?: unknown[] } | undefined;
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_ROLLBACK_CONFLICT',
          message: e.message,
          retryable: false,
          hint:
            `将丢失 ${detail?.lostManualEdits ?? '若干'} 处你在此期间的其它手动修改。` +
            `请向用户展示这些位置，让用户决定是否强制回滚。`,
        },
      };
    }
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_CHECKPOINT_FAILED',
        message: e instanceof Error ? e.message : String(e),
        retryable: false,
      },
    };
  }
}

export async function rollbackSideEffect(
  args: { checkpointId: string; chapterId: string; ruleId: string },
  _ctx: ToolContext,
  deps: UndoDeps,
): Promise<ToolResult<{ restored: boolean; body: string }>> {
  const started = Date.now();
  if (!args.checkpointId || !args.chapterId || !args.ruleId) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: '缺少必填参数：checkpointId / chapterId / ruleId。',
        retryable: true,
      },
    };
  }

  // checkpointId 用于定位要撤销的那次改动；当前实现的回滚由 Replayer 依据 patch 原文完成，
  // 故此处只需确认它存在即可
  void args.checkpointId;

  const current = await deps.getBody(args.chapterId);
  if (current === null) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: `章节不存在：${args.chapterId}`,
        retryable: false,
      },
    };
  }

  // 系统在副作用复检时会自动算好正文并直接回滚；
  // Agent 手动调用时需要传入 newBody —— 但我们不提供该参数，
  // 故此处退化为「标记为待回滚」，由 Replayer 依据 checkpoint 原文还原。
  const result = await deps.rollbackRule(args.checkpointId, args.chapterId, current);
  return { ok: true, data: result, durationMs: Date.now() - started };
}