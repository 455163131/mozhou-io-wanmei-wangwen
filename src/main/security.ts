/**
 * 安全策略（架构 §1.1、security.ts）。
 * CSP 设置 + 外部链接拦截 + 权限收紧。
 *
 * ★★ 本文件是所有「往外走」的出口的唯一收口点 ★★
 * `window.ts` 不得再自行注册 will-navigate / setWindowOpenHandler ——
 * 修复前它注册了第二个更宽松的处理器（放行任意 file://、其余 URL 无协议校验
 * 直送 shell.openExternal），且注册在本文件之后，两个都会触发，
 * 于是这里的严格策略形同虚设。
 */
import { shell, session, type BrowserWindow } from 'electron';
import { DEV_CSP, PROD_CSP } from '@shared/constants/csp';
import {
  isAllowedExternalUrl,
  isAllowedInternalNavigation,
} from '@shared/util/external-url';

/** onHeadersReceived 是 session 级的，只能注册一次（macOS activate 会多次建窗） */
let headersHandlerInstalled = false;

/**
 * 注入响应头 CSP。
 *
 * ⚠️ 仅对 **http(s)** 响应生效——生产构建用 `loadFile()` 走 `file://`，
 *   这里不会触发。生产的 CSP 由 index.html 的 `<meta http-equiv>` 承担
 *   （见 `shared/constants/csp.ts` 与 electron.vite.config.ts 的注入插件）。
 *   两处都要有，缺任一处就会出现「开发期有 CSP、生产期裸奔」。
 */
function installHeaderCsp(): void {
  if (headersHandlerInstalled) return;
  headersHandlerInstalled = true;

  // 开发期走 dev server（http），响应头 CSP 生效，且需放开 script 的 'unsafe-inline'
  // 供 react-refresh 前导脚本使用；生产走 file://，由 index.html 的 meta 承担。
  const csp = process.env['ELECTRON_RENDERER_URL'] ? DEV_CSP : PROD_CSP;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

/** 当前窗口的「自身 origin」，用于判断应用内导航是否指向自己 */
function selfOriginOf(win: BrowserWindow): string | null {
  try {
    const url = win.webContents.getURL();
    if (!url) return null;
    // file:// 下 origin 是 'null' 字符串，退回用目录前缀比对
    if (url.startsWith('file://')) return url.slice(0, url.lastIndexOf('/') + 1);
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function applyCsp(win: BrowserWindow): void {
  installHeaderCsp();

  const devServer = process.env['ELECTRON_RENDERER_URL'] ?? null;
  const policy = { devServerOrigin: devServer };

  // 只允许把白名单协议的 URL 交给系统浏览器，**绝不在应用内打开远程页面**
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[security] 已拒绝 window.open 的非白名单 URL：', url);
    }
    return { action: 'deny' };
  });

  // 阻止导航到外部页面
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedInternalNavigation(url, policy, selfOriginOf(win))) return;
    event.preventDefault();
    // 白名单内的转系统浏览器；其余（含自定义协议）直接丢弃并留痕
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[security] 已拒绝应用内导航，且协议不在外链白名单内：', url);
    }
  });

  // 禁止权限请求（如摄像头、麦克风）——写作工具不需要
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
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
