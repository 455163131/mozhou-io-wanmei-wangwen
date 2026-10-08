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

/**
 * 提到模块级：`before-quit` 处理器在 main() 之外，需要能拿到 services 才能做退出备份。
 * 修复前它是 main() 的局部变量，退出路径因此只调了 closeDatabase()，
 * 注释里承诺的「L3 备份时机之一：应用正常退出」从未发生。
 */
let servicesRef: AppServices | null = null;

/** 退出备份只做一次；第二次进 before-quit 时直接放行，否则会死循环 */
let quitBackupDone = false;

/** 数据库只关一次（before-quit 可能被走两遍：拦一次做备份，再放行） */
let dbClosed = false;

/**
 * 退出备份的兜底超时。
 * 全量备份要读全书正文（3.75MB 级），正常几百毫秒；但磁盘异常、网盘同步盘
 * 卡死等情况下可能永远不返回。**宁可少一份备份，也不能让用户关不掉应用。**
 */
const QUIT_BACKUP_TIMEOUT_MS = 8_000;

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

  let services: AppServices;
  try {
    services = new AppServices();
  } catch (e) {
    // DB 初始化失败是致命问题：早失败好过带着半个状态继续跑
    console.error('[main] 服务初始化失败：', e);
    app.quit();
    return;
  }
  servicesRef = services;

  let win: BrowserWindow | null = null;
  win = createWindow(services);
  buildMenu(win);
  registerAllIpc(services, () => win);

  app.on('activate', () => {
    // macOS：点 Dock 图标时若没有窗口则新建
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow(services);
      buildMenu(w);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  const services = servicesRef;

  // ★ L3 备份时机之一：应用正常退出（架构 §1.8）。
  //   未打开项目时没什么可备份，直接放行。
  if (!services?.project || quitBackupDone) {
    shutdownDb();
    return;
  }

  // 拦住本次退出，做完备份再重新 quit()。
  // 第二次进本处理器时 quitBackupDone 已为 true，走上面的放行分支。
  e.preventDefault();
  quitBackupDone = true;

  let settled = false;
  const finish = (reason: string): void => {
    if (settled) return;
    settled = true;
    if (reason !== 'ok') console.error(`[main] 退出备份未完成（${reason}），仍然退出。`);
    shutdownDb();
    app.quit();
  };

  // 兜底超时：备份卡死也不能让用户关不掉应用
  const timer = setTimeout(() => finish('超时'), QUIT_BACKUP_TIMEOUT_MS);
  // 不阻止进程退出
  timer.unref?.();

  void services
    .backupNow('app-exit')
    .then((stats) => {
      if (stats) console.log(`[main] 退出备份完成：${stats.path}（${stats.bytes} 字节）`);
      finish('ok');
    })
    .catch((err) => {
      console.error('[main] 退出备份失败：', err);
      finish('异常');
    });
});

function shutdownDb(): void {
  if (dbClosed) return;
  dbClosed = true;
  closeDatabase();
}

// 崩溃兜底：渲染进程/子进程挂掉时给出可诊断的日志，而不是留一个白屏。
// 修复前这两个事件完全没处理，渲染进程崩溃后用户只看到白屏且无从得知原因。
// ★ app 的 render-process-gone 是 (event, webContents, details) 三参，
//   与 webContents 上同名事件的 (event, details) 二参不同，别照抄。
app.on('render-process-gone', (_e, _wc, details) => {
  console.error('[main] 渲染进程异常退出：', details.reason, details.exitCode);
});
app.on('child-process-gone', (_e, details) => {
  console.error('[main] 子进程异常退出：', details.type, details.reason, details.exitCode);
});

export { join };
