/**
 * Content Security Policy（纯常量，主进程与构建脚本共用）。
 *
 * ★ 为什么要放 shared 而不是只写在 `main/security.ts`：
 *   `session.webRequest.onHeadersReceived` 注入的响应头 CSP **对 `file://` 不触发**
 *   ——而生产构建正是用 `win.loadFile()` 加载 `file://.../renderer/index.html`。
 *   也就是说修复前**生产环境完全没有 CSP**，只有开发期（http dev server）才生效。
 *
 *   `file://` 下唯一可靠的注入点是 index.html 里的 `<meta http-equiv>`。
 *   但开发期 vite 的 @vitejs/plugin-react 会往 index.html 注入**内联**的
 *   react-refresh 前导脚本，严格 CSP 会拦掉它导致黑屏（2026-10-08 真机实测）。
 *
 *   故分两份：
 *     · `PROD_CSP`  —— 严格版，由 electron.vite.config.ts 的插件**仅在生产构建**
 *                      注入 index.html 的 meta；
 *     · 开发期     —— 走响应头 CSP（dev server 是 http，头部会生效），
 *                      由 `main/security.ts` 在 PROD_CSP 基础上放开 'unsafe-inline'。
 *
 * 分层铁律：本文件是纯字符串常量，不 import Node/Electron/DOM。
 */

/** 各条指令。分开写便于开发期精确替换其中一条（script-src） */
export const CSP_DIRECTIVES = {
  defaultSrc: "default-src 'self'",
  // 生产构建没有内联脚本，维持严格 'self'
  scriptSrc: "script-src 'self'",
  // CSS Modules 需要内联 style（动态宽度等）
  styleSrc: "style-src 'self' 'unsafe-inline'",
  imgSrc: "img-src 'self' data:",
  fontSrc: "font-src 'self'",
  // ★ 渲染层不直连任何外部 API（LLM 请求全在主进程发出，架构 §4.2），
  //   故 connect-src 收得极紧。
  connectSrc: "connect-src 'self'",
  objectSrc: "object-src 'none'",
  frameSrc: "frame-src 'none'",
  baseUri: "base-uri 'none'",
  formAction: "form-action 'none'",
} as const;

/** 生产用严格 CSP（写进 index.html 的 meta） */
export const PROD_CSP: string = Object.values(CSP_DIRECTIVES).join('; ');

/**
 * 开发用 CSP：仅把 script-src 放开 'unsafe-inline'（react-refresh 前导脚本），
 * 其余指令与生产完全一致——避免「开发期能跑、生产期才炸」的差异。
 */
export const DEV_CSP: string = Object.values({
  ...CSP_DIRECTIVES,
  scriptSrc: "script-src 'self' 'unsafe-inline'",
}).join('; ');
