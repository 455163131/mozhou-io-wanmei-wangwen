/**
 * 主进程 → 渲染层推送（架构 §2.3）。
 *
 * ★ **单向推送，只有本文件一个出口**。
 *   所有 agent:* / chapter:* / llm:* 事件都必须经这里发，
 *   不允许在业务代码里直接调 webContents.send —— 否则无法统一处理
 *   「窗口已销毁」「多窗口广播」这些边界。
 */
import type { BrowserWindow } from 'electron';
import type { IpcPushMap, IpcPushChannel } from '@shared/types/ipc';

export class PushChannel {
  private windows = new Set<BrowserWindow>();

  register(win: BrowserWindow): void {
    this.windows.add(win);
    win.on('closed', () => {
      this.windows.delete(win);
    });
  }

  /** 单向推送：只发序列化后的只读 DTO，不含类实例或函数 */
  send<K extends IpcPushChannel>(channel: K, payload: IpcPushMap[K]): void {
    for (const win of this.windows) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // 窗口正在销毁时 send 会抛；这属正常竞态，不影响其它窗口
      }
    }
  }

  /** 只发给某个窗口（用于定向响应） */
  sendTo<K extends IpcPushChannel>(win: BrowserWindow, channel: K, payload: IpcPushMap[K]): void {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // 同上：窗口销毁竞态
    }
  }

  clear(): void {
    this.windows.clear();
  }

  get windowCount(): number {
    return this.windows.size;
  }
}