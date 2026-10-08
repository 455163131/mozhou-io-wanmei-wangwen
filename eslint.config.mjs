/**
 * ESLint 扁平配置（ESLint 9）。
 *
 * ★★ 为什么这个文件很重要 ★★
 * 修复前项目**没有任何 lint 配置**（package.json 无 eslint 依赖、无 lint 脚本），
 * 但源码里已经出现了 `// eslint-disable-next-line no-console` 注释 ——
 * 说明有人以为它有。
 *
 * 缺 lint 的直接后果是可见的：渲染层那批 `useEffect` 依赖数组缺失
 * （HealthPanel.tsx:46、HistoryTimeline.tsx:20、App.tsx:84）无人发现，
 * 因为 `react-hooks/exhaustive-deps` 从来没跑过。这类缺陷 typecheck 抓不到、
 * 281 个用例也抓不到（渲染层 0 覆盖），只有 lint 能在写下的当刻就报出来。
 *
 * 分级原则：
 *   · **error** = 会产生错误行为的（hooks 依赖、未处理的 Promise、可疑相等）
 *   · **warn**  = 会侵蚀可维护性但不立刻出错的（any、空 catch、未用变量）
 * 先让全仓能跑通、把问题**暴露出来**，再逐步把 warn 收敛成 error。
 * 一上来全设 error 会让 lint 直接不可用（几百条红），团队只会加 --no-verify。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      '.tmp/**',
      // esbuild 生成的中间产物，不是源码
      'scripts/.*-bundle.mjs',
      'scripts/.corpus-path',
      // vitest 异常退出残留
      'vitest.config.ts.timestamp-*.mjs',
      // 临时探针（与 vitest 的 `**/_*.test.ts` 排除约定一致）
      'tests/**/_*.test.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 主进程 / preload / shared：Node 环境 ──
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
  },

  // ── shared 层的分层铁律（机器化检查）──
  // ★ 只作用于 shared：main 与 preload **本来就该** import node:* 与 electron，
  //   把规则套到它们头上会产生几十条假阳性，反而让真问题被淹没。
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      // shared 禁止 import Node / Electron / 原生模块。
      // 这条此前只靠人肉 grep 与 scripts/smoke.mjs 的静态检查守着。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'electron', 'better-sqlite3', 'fs', 'path', 'crypto', 'os'],
              message:
                'shared 层禁止 import Node/Electron/原生模块（分层铁律）。' +
                '若确需哈希等能力，把实现放到 main/util/ 下——参考 util/hash.ts 的拆法。',
            },
          ],
        },
      ],
      // shared 禁 DOM（与 smoke.mjs 的「shared 零 DOM」检查对齐）
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'shared 层禁止 DOM 引用（分层铁律）' },
        { name: 'window', message: 'shared 层禁止 DOM 引用（分层铁律）' },
      ],
    },
  },

  // ── 渲染层：浏览器环境 + React Hooks 规则 ──
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // ★ 设为 error 而非 warn：本项目渲染层的既有缺陷（依赖数组缺失导致
      //   订阅不更新、面板永远空态、统计永久陈旧）全部属于这一类。
      //   这是引入 lint 最主要的动机，不能只是警告。
      'react-hooks/exhaustive-deps': 'error',
      // 渲染层绝不允许出现裸 ipcRenderer —— 必须走 window.mz（hooks/use-mz-bridge）
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*'],
              message:
                '渲染层禁止直接 import electron。所有主进程通信必须走 ' +
                'hooks/use-mz-bridge 的 bridge()/onAgentEvent()（preload 白名单是唯一收口）。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'ipcRenderer', message: '禁止裸用 ipcRenderer，请走 window.mz' },
      ],
    },
  },

  // ── 全仓通用规则 ──
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    rules: {
      // 可疑相等：== 与 null 的隐式转换是既有 bug 源之一
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // any 会侵蚀 IPC 契约（本项目已依赖 zod，可用 z.infer 代替）
      '@typescript-eslint/no-explicit-any': 'warn',
      // 空 catch 是「静默吞错」的直接来源。本项目已确认多处：
      // checkpoint/store.ts 读回失败 return null、services.ts 的 void e、
      // keyring.ts 解密失败返回 undefined —— 全都让防线无声失效。
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // 非空断言把「可能为 null」的责任推给运行时（services.ts 的 `services!` 即此类）
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // 浮点误等
      'no-floating-decimal': 'error',
      // 未 await 的 Promise：本项目大量 `void fn()` 是刻意的，故只对裸调用告警
      '@typescript-eslint/no-floating-promises': 'off',
      // ★ CJK 代码库里，注释与字符串中的全角空格 / 零宽字符常常是**刻意**的
      //   （排版对齐、生成标记示例）。只禁止出现在标识符与代码结构中。
      'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true }],
    },
  },

  // 测试文件放宽：断言里常用 any / 非空断言
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': 'off',
    },
  },

  // 配置文件与脚本
  {
    files: ['*.config.ts', '*.config.mjs', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      // 构建/校验脚本要解析子进程输出，剥 ANSI 颜色码（\x1b[...m）是常规操作，
      // 不是「用户输入进了正则」那类风险。业务代码（src/）仍受该规则约束。
      'no-control-regex': 'off',
      // ★ 与 src/tests 那份保持一致：这些脚本的注释里含有生成标记示例，
      //   内含零宽字符与全角空格（CJK 排版），是刻意写法而非笔误。
      //   注意本块的 files 不含 src/**，故必须在此重复声明，否则规则不生效。
      'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true }],
    },
  },
);
