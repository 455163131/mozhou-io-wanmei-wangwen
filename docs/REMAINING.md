# 遗留问题与待验证清单

> 分三类：**实现缺口**（没做的功能）、**待验证**（架构 §5.2 要求实跑的项）、**实现过程中发现并修复的自身 bug**（供复盘）。

---

## 一、实现缺口（未做的功能）

### ✅ 1.1–1.3 已修复（2026-10-07 补完）

三条阻断/严重缺口已实现，新增 `main/agent/goal-evaluator.ts`（275 行）：

- **1.1 评估器** — 结构化 `GoalSpec` 五种类型（`health_score` / `metric_below` / `metric_above` / `no_conflicts` / `custom`），`parseGoal()` 做文本→结构化解析，**每步重新读 DB 重算指标**（不复用缓存，防假成功）。「未达成」与「达成」同等重要：`toEvaluation()` 按 delta 把 progress 分成 positive/partial/none/negative，供循环决定重试还是收手。
- **1.2 `VALIDATION_FAILED`** — `BudgetGuard` 新增独立计数器 `validationFailures`（上限 2），与 `consecutiveFailures` 分开。`AgentLoop` 按错误码分流：`E_INVALID_ARGS` / `E_TOOL_NOT_FOUND` 走校验通道，未达上限时把逐项错误回喂让模型自纠，达上限则终止并带 `errors`（如 `args.chapterNo: expected number, got string`）。
- **1.3 native tool_calls** — **真相是 (a) 接线漏了**：client 层一直完整（`buildBody` 发 tools、`parseJson` 解析 `tool_calls`），但 `doSelect` 从未传 `req.tools`，导致 `client.ts:196` 的 `if` 恒假。已在 `doSelect` 按三条路径分流，`native` 分支传 `tools` + `tool_choice:'auto'` 并读 `res.toolCalls[0]`；模型编造工具名时明确报错而不静默取第一个。

### ✅ 1.4 账本走内存、未接 DB —— 已修复（2026-10-09，见 PROJECT-STATUS.md §4 第 13 条）

**原现状**：`services.ts` 的 `memCharacters` / `memNumbers` 等是内存 `Map`，`ledger_*` 表已建但未读写。

**★ 2026-10-09 复核修正（此前低估了）**：全仓 **没有任何一处向这四个 Map 写入**
（`mem*.set(...)` 零命中；`ledger_*` 表只有 `db/migrate.ts` 的 DDL，无 repo）。
`characters()/numbers()/timeline()/foreshadows()` 只有读侧，调用方是
`ipc/register.ts`、`tools/impl/ledger-query.ts`（`query_ledger`）与 `services.ts` 自己。

**影响**：不是「重启后账本丢失」，而是**账本在当前构建里恒为空**——
会话内也拿不到任何人物/数字/时间线/伏笔，`query_ledger` 永远返回空集合，
跨章一致性对账（S2）因此整条链路无数据来源。
连带影响：判据 B 的状态指纹虽已接上账本（见 §4 第 9 条，已修），
在写入侧补齐之前仍然检测不到任何账本变化。

**修复内容**（按原计划「先补写入路径，再谈持久化」一次做完）：新增 `db/repos/ledger-repo.ts`
接上四张 `ledger_*` 表；四个内存 Map 彻底退场，读写一律走 repo；`conflicts()` 接上此前零调用方的
`detectConflicts`；新增 Agent 工具 `update_ledger`（每条必须带出处，工具会真去那一章逐字核验引文，
核验不过整批不写）；`ledger:upsert` 从回显桩改为真落库，契约四处同步。
测试 +43 条（`ledger-repo` 18 / `ledger-update-tool` 13 / `ledger-write-wiring` 12）。

**仍然缺的**（不属于本条，别当成已完工）：`LoreView` 没有用户手工登记入口，写入侧只有 Agent 工具；
`ledger_conflicts` 表仍是空壳 DDL（冲突改为按最新账本现算，避免留下过期的「待裁决」记录）。

### 1.5 T11 / T12 / T22–T25 / T28 未做

| 任务 | 内容 | 现状 |
|---|---|---|
| T11 | 章节树拖拽分组 | ✅ 拖拽已接（章拖到章=改全局序，章拖到卷名=换卷，见 §4 第 4 条）；修复当时因全书没有建章入口（§4 第 17 条）真实数据上无可拖对象，**该前提已随第 17 条解除**（2026-10-09 手动建章接通，拖拽与日增量都可实测了） |
| T12 | CodeMirror 6 | textarea（V1 未验证，见下） |
| T22 | 风格指纹 UI + 情节记忆 | `rebuildBaseline()` 已实现，无 UI 入口 |
| T23 | 导出页 + 拆书页 | 导出走 IPC `export:run`，无页面 |
| T24 | 错误边界 + 未闭合 run 提示 | 未闭合 run 检测已做，无 UI 弹窗 |
| T25 | 大文件实测 | 参数已按§1.9 设定，**未实测** |
| T28 | 打包 | `electron-builder.yml` 已写，**未实跑** |

---

## 二、待验证（架构 §5.2 要求实跑，当前无法在本环境完成）

| # | 待验证项 | 为什么没验 | 建议验证方式 |
|---|---|---|---|
| **V1** | CodeMirror 6 在 10 万字中文长文的滚动 FPS 与 IME 延迟 | 架构要求 T12 开工前验证；本实现用 textarea 未引入 CM6 | 造 10 万字文件，`npm i @codemirror/*`，测滚动 FPS 与 keydown→paint |
| **V13** | Ollama / LM Studio 的 function calling 支持度 | 本机未装这两个运行时 | 各发 3 种请求（tools / prompted / 流式），记录原始返回 |
| **V14** | 本地模型实际上下文窗口 | 同上 | 读 `/api/tags`、`/v1/models` |
| **V8** | better-sqlite3 在Electron 下的 ABI 兼容 | 未打包 | `npm run pack:win` 后启动，查是否需重建原生模块 |
| **V6** | 未签名 exe 的杀软误报率 | 未打包 | 产物用 360/腾讯/火绒实扫 |
| **V9** | electron-vite 下 preload 的 ESM/CJS 形态 | 配置已设 CJS，未实跑启动 | `npm run dev`，看console 打印的 `typeof window.mz` |
| **V10** | 100 万字项目的 SQLite 性能 | 未造大数据 | 造 500 章 × 2500 字 fixture，测查询与备份耗时 |
| **V15** | checkpoint 深度 50 / 64MB 在全量使用时够不够 | 未跑 500 章批量修正 | 同上，看LRU 淘汰频率 |
| **V16** | 副作用检测误判率 | 只写了 3 个用例 | 20 组「改前 ok→改后越界」+ 20 组「改前已超标→改后更差」 |
| **V17** | 回滚后正文逐字一致 | ✅ **已验**：20 轮字节级比对通过 | 已完成 |
| **V4** | 循环检测阈值（窗口 8 / 重复 3）是否合适 | 只用了构造样例 | 用真实长篇跑，看误报率 |
| **V5** | 历史压缩用规则还是模型 | 选了规则压缩 | 跑真实长篇看轨迹可读性 |

---

## 三、实现过程中发现并修复的自身 bug（供复盘）

这几个是**写测试时暴露出来的真bug**，不是测试写错。记录在此以便回看。

### 3.1 循环检测判据 B 的振荡条件永不成立

**现象**：`[h1,h2,h1,h2,h1,h2]` 应判振荡，但 `recordState()` 一直返回 null。

**根因**：原条件要求 `repeats >= min(period*3, len) && repeats >= 4`。period=2 时需要 `repeats >= 6`，但窗口上限是 8，序列长度最多 8 时 `repeats` 到不了 6 —— **该分支永远不可达**。且 `no-effect` 的判定被前置的 `length < 6` 门槛挡住，需6 步相同才触发，而设计意图是 3 步。

**修复**：改为「周期 p 严格重复 + 完整周期数 ≥ 3」，并把 `no-effect` 判定提到长度门槛之前。

### 3.2 checkpoint 淘汰后读不回来（违反「LRU ≠ 删除」）

**现象**：`mgr.read(id)` 对已淘汰的 checkpoint 返回 `null`。

**根因**：`find()` 只查内存栈，而被淘汰的已从栈里移除。等于「淘汰 = 删除」，直接违反架构 §6.1 第 13 条。

**修复**：新增 `allKnown()` 合并内存栈与 run 序列，并新增 `checkpointsToUndo()`——**回滚也必须包含已淘汰项**，否则正文会停在中间态，比不回滚更难理解。

### 3.3 归档文件里 `tier` 写的是 `'memory'`

**现象**：从磁盘读回的 checkpoint `tier` 仍是 `'memory'`，且没有 `archiveFile`。

**根因**：`archive()` 先 `JSON.stringify(ck)` 落盘，之后才 `{...ck, tier:'archive'}`。落盘的是**改tier 之前的副本**。

**修复**：先构造 archived 对象再落盘。

### 3.4 `pruneArchive()` 丢弃了传入的时间参数

**现象**：注入「未来 100 天」期望清空过期存档，实际删除 0 个。

**根因**：`manager.pruneArchive()` 的签名**没有参数**，直接调`store.pruneArchive()` 用默认 `Date.now()`。

**修复**：签名加 `now?: number` 并透传。

### 3.5 `Map.values().flat()` 不存在

**现象**：`this.byRun.values.flat is not a function`。

**根因**：`Map.values()` 返回迭代器，没有 `.flat()`。需 `Array.from()` 先转数组。

### 3.6 vitest 静默漏跑测试（最危险的一类）

**现象**：`npm test` 显示「1 文件 / 19 用例全通过」，实际有 44 个用例。

**根因**：vitest 的 `include` 用 `resolve()` 产出的 Windows 反斜杠路径，被glob 当转义字符；改成绝对路径后又会在 root 下二次解析。

**修复**：`root: __dirname` +相对 glob `tests/**/*.test.ts`。

**为什么这条最危险**：测试「全部通过」比测试失败更糟——集成测试根本没执行，CI 绿灯但覆盖率是 0。

### 3.7 测试结果随机漂移（44 / 59 / 60 / 78 用例，同一份代码）

**现象**：修完 3.6 后仍不稳定。连续 6 轮跑出：4 文件×3 轮正常 → 第 6 轮掉到 2 文件，并伴随 `Unhandled Error`。

**根因**：`Error: EPERM: operation not permitted, open 'C:\Users\...\Temp\xxx\ssr\...'`，
栈顶是 `node-brokered-fs-shim.cjs` —— 本机WorkBuddy 环境对文件系统的代理层。
vitest 默认把 SSR 转换缓存写到**系统 tmpdir**，并发写该缓存时命中shim 的竞态，
该错误表现为「Unhandled Error → 整轮中断 → 只跑到部分文件」。
**与项目代码无关**，但在 CI 上会表现为随机飘红。

**修复**（`vitest.config.ts`）：
1. `cacheDir` 固定到项目内 `.tmp/vitest-cache`，绕开系统 tmpdir；
2. `pool:'forks'` + `singleFork:true` 强制串行，避免并发写缓存。

**验证**：连续 8 轮均为 4 文件 / 78 用例 / 0 error。

> **给后续维护者**：若将来又出现「同一命令用例数不同」，先确认 `Test Files` 数量——
> 文件数变少 = 被中断，不是测试通过。`Errors N errors` 那行是唯一线索。

### 3.8 vitest 的 unhandled error 让「用例数」失去确定性（与 3.7 同源，先记于此）

**现象**：同一份代码连续跑，`npm test` 分别报出 **53 / 60 / 78** 三个不同的用例数。

**根因**：vitest 并行跑测试文件时，多个 worker 争用 WorkBuddy 沙箱的 fs shim 写 SSR 缓存，触发 `EPERM`。该错误是**unhandled**的——它不在任何用例的断言里，而是**在随机时刻中断整个测试进程**。表现为「有的文件跑了、有的没跑」，且每次不一样。

**修复**：`cacheDir` 固定到项目内 + `pool:'forks'` + `singleFork:true` 串行执行。修复后连跑 5 次稳定 78/78。

**为什么这条比3.6 更危险**：3.6 是「少跑一个文件」，还能通过对比文件列表发现；这条是「同一个命令每次结果不同」，会让**用例数本身失去作为验收依据的资格**——团队负责人要求「声明用例数 = 实际执行数」正是针对这类情况。

---

## 四、跨文件耦合点（改动时需同步）

| 位置 | 耦合原因 |
|---|---|
| `services.ts` 的 `baseline` getter | 同时服务规则引擎、工具、健康面板。改基线口径要同步这四处 |
| `agent/host.ts` 的 `registryDeps()` | 与 `registry` 共用同一份依赖装配，避免两处漂移 |
| `tools/impl/fix.ts` 的 `ruleTargets()` 与 `agent/side-effect.ts` 的 `RULE_TARGETS` | **两份重复的规则→指标映射表**。新增规则时必须同步改两处，否则副作用检测会漏判或误判。建议后续合并到 `fix-rules.ts` 单一来源 |
| `constants/metrics.ts` 的 `LAYER_METRICS` 与 `metrics-engine` 的 `MARKERS` | 前者是展示分组，后者是算法定义。新增 marker 需同步（审查发现 MZ-009 即此类漏网） |