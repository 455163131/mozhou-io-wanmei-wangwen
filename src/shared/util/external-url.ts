/**
 * 外部 URL 放行策略（纯函数，主进程两个入口共用）。
 *
 * ★ 为什么单独成文件：`shell.openExternal(url)` 会把 URL 交给操作系统处理，
 *   而 Windows 上有一批**可执行程序**的自定义协议（`search-ms:`、`ms-msdt:`、
 *   `ms-officecmd:` 等），一旦被拉起就可能落地远程代码。渲染层若被 XSS 攻破，
 *   「无白名单直送 openExternal」等于把这条路径直接交出去。
 *
 *   修复前 `security.ts` 与主进程窗口模块各注册了一个 `will-navigate`，
 *   后者更宽松（放行任意 `file://`，其余一律 openExternal 且不校验协议），
 *   两个都会触发 —— 严格的那个因此形同虚设。
 *
 * ★ 分层铁律：本文件是纯字符串判断，不 import Node/Electron，故放在 shared，
 *   可以被单元测试直接覆盖（安全边界必须有回归护栏）。
 */

/**
 * 允许交给系统浏览器打开的协议。
 * 刻意收窄到「人类点链接的正当意图」：网页与邮件。
 * 不放行 file:（本地文件不该由外链触发）、不放行任何自定义协议。
 */
const ALLOWED_EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const;

/**
 * 开发期允许在应用内导航的前缀（vite dev server）。
 * 生产构建下应为空——渲染层所有资源都是本地打包的，不该有任何外部导航。
 */
export interface NavigationPolicy {
  /** vite dev server 的 origin，如 http://localhost:5173；生产为 null */
  devServerOrigin: string | null;
}

/**
 * 该 URL 能否交给 `shell.openExternal`（系统浏览器/邮件客户端）。
 *
 * 判定顺序刻意保守：**先解析、解析失败即拒绝**，不用字符串前缀匹配。
 * `url.startsWith('https://')` 这类写法会被 `https:/\/\evil.com`、
 * `httpsx://`、含控制字符的变体绕过；`new URL()` 解析后比对 `protocol` 才可靠。
 */
export function isAllowedExternalUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false; // 解析不了 = 不是合法绝对 URL，一律拒绝
  }
  return (ALLOWED_EXTERNAL_PROTOCOLS as readonly string[]).includes(parsed.protocol);
}

/**
 * 该 URL 能否在**应用内**导航（即不拦截、不转外部浏览器）。
 *
 * 生产构建只允许加载打包产物本身（file: 下的 index.html）；
 * 开发期额外允许 vite dev server 的 origin。
 * 除此之外一律拒绝——尤其拒绝任意外部 `file:` 路径与全部远程页面。
 */
export function isAllowedInternalNavigation(
  raw: string,
  policy: NavigationPolicy,
  selfOrigin: string | null,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  // 应用内导航只可能是这两种协议：本地打包产物（file:）或 dev server（http:）。
  // 其余协议（含各类自定义协议）一律不允许在窗口里加载。
  if (parsed.protocol !== 'file:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // vite dev server：开发期热更新与模块加载都走它
  if (policy.devServerOrigin && raw.startsWith(policy.devServerOrigin)) return true;

  // 应用自身的页面（生产下是 file://.../renderer/index.html）
  if (selfOrigin && raw.startsWith(selfOrigin)) return true;

  // 生产构建：除自身外不允许任何应用内导航
  return false;
}

/**
 * 从渲染层传入的 baseUrl 是否可接受。
 *
 * ★ 这是 API Key 的外泄防线：`Authorization: Bearer <key>` 会发往 baseUrl，
 *   若允许 `http://`，Key 就是明文过网，且可被 MITM 改写响应。
 *   修复前 baseUrl 来自 IPC 且**零校验**，渲染层可把它指向任意 http 端点。
 *
 * 例外：本地运行时（Ollama / LM Studio）本来就是 http://127.0.0.1，
 * 这是正当用法，故放行**回环地址**的 http。
 */
export function isAllowedLlmBaseUrl(raw: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'baseUrl 不是合法的绝对 URL' };
  }

  if (parsed.protocol === 'https:') return { ok: true };

  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (isLoopback) return { ok: true };
    return {
      ok: false,
      reason:
        `拒绝非回环的 http:// 端点（${host}）：API Key 会明文过网且可被中间人改写。` +
        '本地模型请用 127.0.0.1 / localhost；云端服务必须用 https。',
    };
  }

  return { ok: false, reason: `不支持的协议：${parsed.protocol}（只允许 https，或本地 http 回环）` };
}
