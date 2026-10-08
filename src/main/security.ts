/**
 * 安全策略（架构 §1.1、security.ts）。
 * CSP 设置 + 外部链接拦截 + 权限收紧。
 */
import { shell, session, type BrowserWindow } from 'electron';

/**
 * Content Security Policy。
 * 渲染层不允许加载远程内容——所有资源都是本地打包的。
 * LLM 请求由主进程发出，渲染层**完全不发跨域请求**（架构 §4.2），
 * 所以 connect-src 可以收得很紧。
 */
const CSP = [
  "default-src 'self'",
  // ★ 开发期必须放行内联脚本（2026-10-08 真机首启实测）：
  //   vite 的 @vitejs/plugin-react 会在 index.html 注入**内联**的 react-refresh 前导脚本，
  //   `script-src 'self'` 会拦掉它 → 所有组件模块抛「can't detect preamble」→ React 不挂载 → 黑屏。
  //   生产构建没有内联脚本，维持严格 'self' 不变。
  `script-src 'self'${process.env['ELECTRON_RENDERER_URL'] ? " 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'", // CSS Modules 需要内联 style（动态宽度等）
  "img-src 'self' data:",
  "font-src 'self'",
  // ★ 渲染层不直连任何外部 API，故 connect-src 只允许本地 IPC 相关的 self
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function applyCsp(win: BrowserWindow): void {
  void session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  // 只允许 window.open 打开外部链接到系统浏览器，**绝不在应用内导航**
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 阻止导航到外部页面
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
    if (url.startsWith('https://')) void shell.openExternal(url);
  });

  // 禁止权限请求（如摄像头、麦克风）——写作工具不需要
  void session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

/** 允许的 preload 桥接检查：确认 window.mz 的形状 */
export function describeBridge(win: BrowserWindow): Promise<string> {
  return win.webContents
    .executeJavaScript('typeof window.mz + " | " + Object.keys(window.mz || {}).join(",")')
    .then((r: string) => r)
    .catch((e: unknown) => `ERR: ${e instanceof Error ? e.message : String(e)}`);
}