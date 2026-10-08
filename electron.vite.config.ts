import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { PROD_CSP } from './src/shared/constants/csp';

/**
 * 生产构建时往 index.html 注入 CSP `<meta>`。
 *
 * ★ 为什么必须在构建期注入、而不能只靠主进程的响应头：
 *   `session.webRequest.onHeadersReceived` **对 `file://` 不触发**，
 *   而生产正是用 `win.loadFile()` 加载打包产物。只靠响应头的话，
 *   **生产环境完全没有 CSP**（修复前就是这个状态），只有开发期才生效。
 *
 * ★ 为什么开发期不注入：
 *   @vitejs/plugin-react 会往 index.html 注入**内联**的 react-refresh 前导脚本，
 *   严格 CSP 会拦掉它 → 组件抛「can't detect preamble」→ React 不挂载 → 黑屏
 *   （2026-10-08 真机首启实测）。开发期改走响应头 CSP（dev server 是 http，
 *   头部会生效），放开 script 的 'unsafe-inline'，其余指令与生产一致。
 */
function cspMetaPlugin(): Plugin {
  return {
    name: 'mz-csp-meta',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        // ctx.server 存在 = 正在跑 dev server，跳过注入
        if (ctx.server) return html;
        const tag = `  <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />\n`;
        return html.includes('</head>') ? html.replace('</head>', `${tag}  </head>`) : html;
      },
    },
  };
}

/**
 * 三段构建配置（main / preload / renderer）。
 * electron-vite 用一份配置管三段，省掉自己拼 rollup 的功夫（架构 §4.6）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      // 主进程与 preload 产出 CJS：Electron 的 sandbox:true 下 preload 必须是 CJS，
      // 且 contextIsolation 要求 preload 不能用 ESM 语法（架构 §1.2 待验证项 V9）
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    plugins: [react(), cspMetaPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
});