/**
 * 窗口创建（架构 T01）。
 *
 * ★ 安全配置（架构 §1.1分层铁律）：
 *   contextIsolation: true —— 渲染层无法访问 Node
 *   sandbox: true         —— 渲染进程跑在沙箱里
 *   nodeIntegration: false—— 渲染层没有 require
 *
 * ⚠️【待验证 V9】sandbox:true 下preload 必须是 CJS 产物。
 *   electron.vite.config.ts 已把 preload 输出格式设为 cjs。
 */
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { applyCsp } from './security';
import { APP_BRAND_NAME } from '@shared/constants/brand';
import type { AppServices } from './services';

export function createWindow(services: AppServices): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    backgroundColor: '#0E1116',
    title: APP_BRAND_NAME,
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  // 注册到推送通道，事件才能送达
  services.push.register(win);

  applyCsp(win);

  win.once('ready-to-show', () => {
    win.show();
    // 开发期打印 bridge 形状，验证 V9（架构 §1.2）
    if (process.env['NODE_ENV'] === 'development') {
      void win.webContents
        .executeJavaScript('typeof window.mz + " | keys=" + Object.keys(window.mz || {}).length')
        .then((r: string) => console.log('[preload] window.mz =>', r))
        .catch((e: unknown) => console.error('[preload] bridge 不可用：', e));
    }
  });

  // 开发模式加载 dev server，生产加载打包产物
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // ★ 外链与导航策略**只在 security.ts 里注册一次**。
  //   修复前这里还额外注册了一个 will-navigate：放行任意 file://、
  //   其余 URL 不经协议校验直送 shell.openExternal（Windows 上 search-ms: 等
  //   自定义协议可拉起可执行程序）。它注册在 applyCsp 之后，两个都会触发，
  //   于是 security.ts 的严格策略形同虚设。

  return win;
}