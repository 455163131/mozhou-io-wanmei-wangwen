/**
 * window.mz 的类型化封装（架构 §1.2）。
 *
 * 渲染层唯一与主进程通信的入口。**没有它就没有 window.mz**——
 * 这本身就是一层保护：渲染层代码里不可能出现裸 ipcRenderer。
 */
import type { MzBridge } from '../../preload/api';
import type {
  IpcPushChannel,
  IpcPushMap,
} from '../../shared/types/ipc';

declare global {
  interface Window {
    mz: MzBridge;
  }
}

/** 取 bridge；不可用时给出可操作的错误而非 undefined（便于定位 V9 类问题） */
export function bridge(): MzBridge {
  const b = window.mz;
  if (!b) {
    throw new Error(
      'window.mz 不存在。preload 未加载成功——请检查 electron.vite.config.ts 的 preload 输出格式是否为 CJS' +
        '（sandbox:true 要求 preload 为 CommonJS）。',
    );
  }
  return b;
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.mz;
}

/**
 * 订阅 Agent 事件。
 * @returns 取消订阅函数（组件卸载时必须调用，否则会内存泄漏 + 重复渲染）
 */
export function onAgentEvent<K extends IpcPushChannel>(
  channel: K,
  handler: (payload: IpcPushMap[K]) => void,
): () => void {
  if (!hasBridge()) return () => undefined;
  return window.mz.agent.on(channel, handler);
}

/** IPC 错误在渲染层的形态：主进程返回的对象带 __mzError */
export interface MzIpcError {
  __mzError: string;
  message: string;
  detail?: unknown;
}

export function isMzError(e: unknown): e is MzIpcError {
  return (
    typeof e === 'object' &&
    e !== null &&
    '__mzError' in e &&
    typeof (e as { __mzError: unknown }).__mzError === 'string'
  );
}

/** 把 IPC 错误转成可读文案 */
export function errorText(e: unknown): string {
  if (isMzError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 错误码 → 用户该做什么（不只弹 toast，要给动作指引） */
export const ERROR_GUIDANCE: Record<string, string> = {
  E_REVISION_CONFLICT: '章节已被其它地方改动，请重新加载后再试。',
  E_ROLLBACK_CONFLICT: '回滚会覆盖你在此期间的其它修改，请确认后再继续。',
  E_CHECKPOINT_FAILED: '无法建立快照，已拒绝执行以保护你的原稿。请检查项目目录是否可写。',
  E_RUN_CONFLICT: '已有 Agent 在执行中，请先叫停或等待它结束。',
  E_BUDGET_EXCEEDED: '预算已用尽，Agent 已停止。已做的改动保留，可继续或回滚。',
  E_LOOP_DETECTED: '检测到 Agent 陷入循环，已停止以免继续烧钱。',
  E_LLM_AUTH: '模型鉴权失败，请检查 API Key。',
  E_TOOLCALL_UNSUPPORTED: '当前模型不支持工具调用，已切换为单步模式。',
  E_PERMISSION_DENIED: '该操作回滚代价过高，需要你亲自确认。',
  E_NOT_PROJECT_FILE: '路径越界，出于安全考虑已拒绝。',
};