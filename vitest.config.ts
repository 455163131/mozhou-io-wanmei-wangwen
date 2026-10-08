import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * vitest 配置。
 *
 * ★★ 关于 include 的两处坑（都曾导致「测试全过但根本没跑」）★★
 *
 * 1. **不能依赖默认 include**：vitest 默认只扫项目根下的 *.test.ts，
 *    放在 tests/ 子目录里的用例会被静默漏掉（实测只跑到 1 个文件 19 个用例）。
 *
 * 2. **必须用正斜杠的相对 glob**：Windows 上 resolve() 产出反斜杠，
 *    会被 tinyglobby/picomatch 当转义字符；改成绝对路径后 vitest 2.x 又会
 *    相对 root 再解析一次，结果同样漏跑。
 *
 * ★★ 关于 cacheDir 的设置 ★★
 *
 * vitest 默认把 SSR 转换缓存写到**系统 tmpdir**。在本机的 WorkBuddy 环境里，
 * fs 被 shim 代理（node-brokered-fs-shim.cjs），并发写该缓存会偶发
 * `EPERM: operation not permitted`（实测约 1/6 概率），该错误表现为
 * 「Unhandled Error → 整轮测试中断 → 只跑到部分文件」，看起来像测试不稳定，
 * 实际与代码无关。故把 cacheDir 固定到项目内。
 *
 * ★★ 关于 `cache: false`（测试计数确定性，D6）★★
 *
 * 本项目**多次**被「用例数不可信」坑过，而用例数是所有验收的基准，必须确定性：
 *   - 早先 WorkBuddy fs shim 的 EPERM 竞态导致用例数随机漂移（实测 78/59/60）；
 *   - 后又出现「缓存残留引用了上一轮已删除的探针文件」→ 首次 `vitest run`
 *     偶现 15 files / 269 tests，清掉 `.tmp/vitest-cache` 后才稳定回 14 / 268。
 * 第二个问题的根因是**vitest 的模块/结果缓存跨轮持久化**：删掉某个测试文件后，
 * 缓存里仍留有条目，导致收集结果一次性异常。
 *
 * 故这里显式 `cache: false` **关闭 vitest 缓存**，让每轮都从零收集、从零转换——
 * 收集结果不再受上一轮残留影响，用例数在 `npm test` / `npx vitest run` 两条入口
 * 下都确定。代价是每次多花一点转换时间（当前 14 files 约 4s，可接受）。
 * 注意：`cacheDir` 仍保留，用于兜住 Vite 侧的缓存写入不落到系统 tmpdir（EPERM 规避）。
 */
export default defineConfig({
  cacheDir: resolve(__dirname, '.tmp/vitest-cache'),
  test: {
    environment: 'node',
    root: __dirname,
    include: ['tests/**/*.test.ts'],
    // ★★ 探针排除（D7）：下划线前缀 = 临时/探索性脚本，默认不纳入收集 ★★
    //
    // 本项目已 **四次** 被「用例数被临时文件扰动」坑过：
    //   1. fs shim 的 EPERM 竞态 → 78/59/60 随机漂移；
    //   2. vitest 缓存残留引用已删探针 → 15/269；
    //   3. 主理人把探针与全量并行跑 → 误报 260/264；
    //   4. QA 写探针期间他人跑全量 → 报告 301（快照污染）。
    // 探针统一用 `_` 前缀命名（_qa_*.test.ts / _probe*.test.ts），跑完即删；
    // 默认收集排除它们后，任何人往 tests/ 丢临时文件都不会再扰动用例数。
    // 需要跑探针时显式指定路径：npx vitest run tests/unit/_xxx.test.ts
    // 权衡：漏删的探针不再被默认执行——但探针本就是探索性的，
    // 正式用例一律不带下划线前缀，不会漏掉真测试。
    exclude: ['**/node_modules/**', '**/_*.test.ts'],
    reporters: 'verbose',
    // ★ 关闭 vitest 缓存 → 收集结果确定（详见文件头 D6 说明）。
    cache: false,
    // 单线程跑：避免并发写缓存触发上述 shim 竞态。
    // 用例数随功能增长（当前 15 文件 / 277 个），串行的耗时可接受，换来确定性。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },

    /**
     * ★★ 覆盖率：让「用例全绿但根本没测到」这件事可见 ★★
     *
     * 引入前本项目**完全没有覆盖率工具**（无 coverage 配置、无 test:coverage 脚本、
     * 无 @vitest/coverage-v8 依赖）。于是「281 全绿」这个数字不含任何覆盖率语义：
     * 实测 src/main 有 15 个文件从未被任何测试加载、16 个仅被传递加载而自身行为
     * 无断言，渲染层 3308 行是配置级不可能被测（environment:'node' 且无 jsdom）。
     *
     * 后果是具体的：9 个阻断级缺陷全部位于「装配层」——算法都对，但没接上。
     * ipc/register.ts(775行)、services.ts(692行)、tools/sandbox.ts(281行，
     * 文件头自称「唯一防线」)、fs/project-fs.ts(resolveInProject 是唯一的
     * 目录穿越防线)、llm/keyring.ts、security.ts 此前全是零覆盖。
     *
     * 阈值刻意设得**低于当前实际值**：先让门能过、把趋势锁住（只许涨不许跌），
     * 再随装配层测试补齐逐步上调。一上来设高阈值只会让人加 --no-verify。
     *
     * ⚠️ 已知环境限制（2026-10-09 实测）：在本机 WorkBuddy 沙箱下 `npm run test:coverage`
     *   会以 Unhandled Rejection 失败——v8 provider 往临时目录写 coverage-N.json 时
     *   报 ENOENT，**预先创建该目录也无效**。这与本文件头部记录的 fs shim 问题同源
     *   （`node-brokered-fs-shim.cjs` 代理层），不是配置错误：同样的配置在正常终端
     *   与 CI 下可用。故 `npm test`（不带 --coverage）仍是本机的验收命令，
     *   覆盖率门请在 CI 或本地正常终端执行。
     */
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // ★ 必须用绝对路径：写成相对路径时报告目录会相对 root 二次解析，
      //   与本项目 include 那条「必须用正斜杠相对 glob」的坑同源。
      //   注：vitest 2.1 的 CoverageV8Options **没有** tempDirectory 选项
      //   （v8 provider 固定用 `<reportsDirectory>/.tmp`），故此处不设。
      reportsDirectory: resolve(__dirname, '.tmp/coverage'),
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/renderer/**', // environment:'node' 下无法执行，计入只会得到恒 0 的噪声
        'src/main/index.ts', // 顶层副作用入口，依赖 Electron app 生命周期
        'src/main/menu.ts',
      ],
      // 起点阈值（2026-10-09 实测后设定）：只许涨不许跌
      thresholds: {
        lines: 45,
        functions: 45,
        branches: 35,
        statements: 45,
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      // 渲染层的纯逻辑（zustand store 等）不含 DOM，可在 environment:'node' 下直接测。
      // 组件级测试仍需 jsdom + @testing-library，那是另一件事（见 docs/REMAINING.md）。
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
});
