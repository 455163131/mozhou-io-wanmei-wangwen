/**
 * 主进程入口（架构 T01）。
 *
 * 顺序很重要：单实例锁 → app.whenReady → 服务装配 → 建窗 → 注册 IPC。
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createWindow } from './window';
import { registerAllIpc } from './ipc/register';
import { AppServices } from './services';
import { closeDatabase } from './db/database';
import { buildMenu } from './menu';

// ★ 单实例锁：第二次启动时聚焦已有窗口，而不是开第二个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void main();
}

async function main(): Promise<void> {
  await app.whenReady();

  let services: AppServices | null = null;
  try {
    services = new AppServices();
  } catch (e) {
    // DB 初始化失败是致命问题：早失败好过带着半个状态继续跑
    console.error('[main] 服务初始化失败：', e);
    app.quit();
    return;
  }

  let win: BrowserWindow | null = null;
  win = createWindow(services);
  buildMenu(win);
  registerAllIpc(services, () => win);

  app.on('activate', () => {
    // macOS：点 Dock 图标时若没有窗口则新建
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow(services!);
      buildMenu(w);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // ★ L3 备份时机之一：应用正常退出（架构 §1.8）
  closeDatabase();
});

export { join };