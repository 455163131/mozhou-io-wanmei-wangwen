/**
 * 全书统计的唯一取数点（§4 第 30 条）。
 *
 * ★ 修复前 `aiFlavor.dashStats()` 在渲染层被调四次、散在三个组件里，
 *   每个都自己 useState、自己 catch。结果是"底栏显示 0 而侧栏显示 289"：
 *   没有一处是权威，也就没有一处负责刷新。
 *   现在取数只有这里一个入口，状态放 `useDashStore`，
 *   **谁改了稿子谁负责叫它**——由 App 以 chapters 为依赖触发、由 Agent 改稿事件触发。
 */
import { bridge, errorText, hasBridge } from './use-mz-bridge';
import { useDashStore } from '../store';
import type { DashStats } from '@shared/types/ipc';

let inflight: Promise<void> | null = null;

/**
 * 重算全书统计。
 * ★ 失败必须把 dash 置 null，而不是"什么都不做"——留着上一本书的数字，
 *   底栏就会在切换项目/主进程报错之后继续报一个看起来很像真的假数。
 */
export async function refreshDash(): Promise<void> {
  if (!hasBridge()) {
    useDashStore.getState().setDash(null);
    return;
  }
  // 合并并发：chapters 一变就可能连着来两次（保存 + 回读），别打两次 IPC
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next: DashStats = await bridge().aiFlavor.dashStats();
      useDashStore.getState().setDash(next);
      useDashStore.getState().setError(null);
    } catch (e) {
      useDashStore.getState().setDash(null);
      useDashStore.getState().setError(errorText(e));
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 底栏与三个视图共用的读数 */
export function useDash(): DashStats | null {
  return useDashStore((s) => s.dash);
}
