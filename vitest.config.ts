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
