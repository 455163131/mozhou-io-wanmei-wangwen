# 木萱网文写作台 项目情况通报

> 面向兄弟单位的共享文档 · 更新日期 2026-10-09 · 版本 0.1.0
> 一句话定位：**九 Agent 网文写作桌面应用**——本地优先、数据自持、AI 全流程辅助创作。

---

## 一、当前状态总览

| 事项 | 状态 |
|---|---|
| 核心链路 | ✅ 全通：五模式 UI + 51 条 invoke 通道 + 14 条订阅通道 + SQLite 持久化 + Agent 循环 |
| AI 味检测 | ✅ 10 维度引擎 + 语料基线校准（715 章真实语料）+ 用户自建基线 |
| 专家团评审 | ✅ 6 角色（结构/人物/对白/文字/读者/类型）+ 冲突并列 + 作者裁决 |
| 模型接入 | ✅ 6 家 Provider（DeepSeek/OpenRouter/本地等）+ safeStorage 加密 Key + 连接测试 |
| 检查点回滚 | ✅ Agent 每步快照，改动历史可回滚 |
| 便携版 | ⚠️ `release/` 里现存的 `墨舟写作台-0.1.0-portable.exe`（74MB，2026-10-08 07:56 打）**两处过时**：① 是 §4 第 8 条修复**之前**的产物，数据仍写 %APPDATA%；② 文件名带着第 6 条修复**之前**的旧 productName。重新打包后产物名变为 `木萱网文写作台-0.1.0-portable.exe`，须按第六节 `npx electron-builder --win portable --x64`，且重新打包后需实测（见第 14 条） |
| 测试基线 | ✅ **527 用例全绿（33 文件，2026-10-09 05:05 实测**，含第 6 条 brand-naming 7 条 + 第 5 条 app-icon 9 条 + 第 4 条 volume-order 15 条与 wiring 22 条）+ 验收脚本 9 项。**必须走 `npm test`**，见第五节。旧文档的「281」是 10-08 前的口径 |
| UI 设计定稿 | ✅ 配色 v2.0「素笺·朱批」（浅色纸面 + 浓墨 + 朱砂单一强调，见 `styles/tokens.css:2`）；外壳为布局 v2（竖排模式导航 + 可折叠双栏）。旧设计代号「文枢」已**不再作为对外品牌**出现（第 6 条）|
| 对外品牌名 | ✅ 统一为「木萱网文写作台」，单一来源 `src/shared/constants/brand.ts`（第 6 条）。内部标识（`package.json name=mozhou-agent`、`appId=com.mozhou.writer`）与 Agent 笔名「墨舟」**故意保留** |

---

## 二、技术栈与架构分层

```
Electron 33.4.11  +  React 19  +  TypeScript 5.8  +  Zustand 5(persist)
持久化：better-sqlite3 11.10（按 Electron ABI 130 预编译）
构建：electron-vite（main / preload / renderer 三段） + electron-builder（nsis + portable）
```

| 层 | 目录 | 职责 |
|---|---|---|
| 主进程 | `src/main/` | services 聚合（DB/Agent 循环/LLM 客户端/专家团/AI 味引擎）+ IPC 注册 |
| 预加载 | `src/preload/` | `window.mz` 类型化桥（**渲染层唯一通信入口**，CJS 产物，sandbox 要求）|
| 渲染层 | `src/renderer/` | React 五模式外壳 + 各面板（CSS Modules，设计令牌 `styles/tokens.css`）|
| 共享 | `src/shared/` | IPC 类型契约（`types/ipc.ts`）、Provider 清单、AI 味引擎（纯函数）|

**五模式**：写作（章节树+编辑器+右栏五面板）/ 规划（卷进度）/ 设定（设定集）/ 审稿（AI 味报告）/ 仪表盘（真实统计）。

---

## 三、前后端契约：IPC 通道清单（节选）

| 域 | 通道 | 说明 |
|---|---|---|
| 项目 | `project:open/close/list/save/volumes` | 项目生命周期与分卷 |
| 章节 | `chapter:list/get/update` | 章节元数据与正文（乐观锁 rev）|
| Agent | `agent:run/abort/state/history` | Agent 循环（runId + 事件推送）|
| 检查点 | `checkpoint:list/undo` | 改动历史与回滚 |
| AI 味 | `aiFlavor:scan/latest/trend/rewrite/config/baseline/rebuildBaseline` | 检测/改写/基线 |
| 专家团 | `expert:roles/review/history/decide/config` | 角色注册表/评审/裁决 |
| 模型 | `llm:status/configure/test` | Provider 状态/配置/连通测试 |
| 设定 | `ledger:query` | 设定账本（人物/数字锚点/时间线/伏笔冲突）|
| 仪表盘 | `dash:stats` | 全书统计（状态计数/卷进度/检查点数/LLM 用量）|
| 导出 | `export:run` | 稿件导出 |

错误契约：主进程 `MzError` 统一为 `{__mzError: code, message}`，**preload 桥统一转成真 Error 抛出**（带 code/detail），调用方 try/catch 标准语义。

---

## 四、已知问题与协作点（欢迎认领）

> **2026-10-09 更新**：本节原有的第 1、2 条（native tool_calls 未接线、评估器简化）**早已修复**，
> 此前一直留在表里，与 `REMAINING.md` §1.1–1.3 的「已修复」记载互相矛盾——已移除，避免协作者重复劳动。
> 同时修复了**闸门②（token / 成本上限）在生产路径失效**的阻断级缺陷，详见下方第 0 条。

| # | 事项 | 说明 | 难度 |
|---|---|---|---|
| **0** | ~~闸门②（token/成本上限）生产路径失效~~ ✅ **已修（2026-10-09）** | `AgentLoop.stats` 的用量只有 `addUsage()` 会写，而生产代码从不调用它（真实用量走 `AgentHost.accrue()` → `costState`，两本账不相通）→ `checkBudget()` 恒读 0 → `maxCostCny` / `maxTokens` 形同虚设。已让 `accrue()` 同时喂两个账本，并补 `tests/integration/budget-wiring.test.ts`（4 条，覆盖"生产装配"而非闸门逻辑本身） | — |
| 3 | 日增量数据源缺失 | 仪表盘「今日新增/连更/稿费/追读率」需发布平台接入或日增量追踪表 | 中 |
| 4 | ~~分卷创建/拖拽排序~~ ✅ **已修（2026-10-09）** | 原写「规划视图只读展示，无 IPC」说轻了——真正的病灶是 `ProjectRepo.insertVolume`（`db/repos/chapter-repo.ts:349`）**全仓零调用方**：UI 没入口、IPC 没通道、Agent 没工具，又是本仓库反复出现的「逻辑对、喂给它的是空气」。四层一起接通：① **repo** 新增 `createVolume`（`title.trim()` 拒空，ord 由 `SELECT COALESCE(MAX(ord),-1)+1` 让库自己算，调用方不数）、`reorderVolumes`、`ChapterRepo.reorder`、`ChapterRepo.setVolume`；重排统一「整表全给 + 单事务 + `ord` = 数组下标」，`assertExactIdSet` 拒绝漏条/越界/重复（列表过期时报错，而不是把顺序改乱）；★重排**只写 `ord`**，不碰 `rev`/`updated_at`——拖一下不该把编辑器的乐观锁搅乱。② **IPC** 四条新通道 `project:create-volume`/`project:reorder-volumes`/`chapter:reorder`/`chapter:set-volume`，按第五节坑 3 同步满四处（类型表 + 两份白名单 + preload 桥 + 主进程 handle）；写通道未打开项目时抛结构化 `E_INVALID_ARGS`，不学读通道（`chapter:list` 那类返回 `[]`）的静默口径。③ **渲染层**：规划视图加了真建卷输入框与卷卡拖拽（`views/PlanView.tsx`），章节树加了「章拖到章=改全局序、章拖到卷名=换卷」（`chapter-tree/ChapterTree.tsx`）；两处都是**乐观生效 → 以主进程返回的整表覆盖 → 失败自动回读**，不会出现"看着改了、其实库里没改"。④ **测试**：`tests/unit/volume-order.test.ts`（15 条，真 `:memory:` 库，含「拖十次之后仍是 0..n-1」「重排不许顺手改正文与 rev」「跨项目 id 拒绝」「`ON DELETE SET NULL`」）+ `tests/integration/volume-order-wiring.test.ts`（22 条装配哨兵，钉住通道/白名单/handle/渲染层真调用/回写 store）。**未做**：卷的建与拖可实测，**章节树的拖拽目前在真实数据上没有可拖的对象**——因为全书根本没有建章节的入口，见第 17 条 | ~~低~~ — |
| 5 | ~~应用图标~~ ✅ **已修（2026-10-09）** | `build/` 目录此前**根本不存在**（`ls build` → No such file or directory），electron-builder 找不到 `build/icon.ico` 只在日志里 warn 一句、照样出货，于是任务栏/桌面/卸载列表一路是 Electron 默认图标——第 6 条把品牌名统一了，图标却还是别人的。新增 `scripts/make-icon.mjs`：**零第三方依赖**纯数学光栅化（仓库无 sharp/pngjs/canvas，不想为一个图标拉原生模块），画「墨底圆角方 + 宣纸色笔锋 + 朱砂印」三要素，与渲染层「素笺·朱批」同一套色；16/24/32/48/64/128/256 七档**按档重画**（直接缩放 256 会让 16 档的细笔画糊成灰），4×4 超采样抗锯齿，手写 ICO 容器（32 位 BGRA + `biHeight=2×高` + 全 0 AND 掩码，透明度只由 alpha 承担）。产物 `build/icon.ico`（364 KiB）**已提交**——`build/` 不在 .gitignore 里，实测 `git check-ignore` 返回 1。补 `tests/integration/app-icon.test.ts`（9 条，全部围绕"Windows 能不能正确读出来"：容器头、尺寸覆盖、目录项自洽、DIB 头字段、掩码全 0、非纯色且圆角外真透明）。已肉眼核验 16/32/256 三档渲染（笔锋与红印在小尺寸下仍可读）。**未做**：重新打包验证图标真的出现在 exe 上（打包要下载 electron-builder 二进制，留作下一步）| ~~低~~ — |
| 6 | ~~品牌命名统一~~ ✅ **已修（2026-10-09，老板定夺：对外统一为「木萱网文写作台」）** | 修复前同一个产品对外**三套名字**：`electron-builder.yml:2` productName 与窗口/页面/菜单写「墨舟写作台」，侧栏 mark 的 `title` 写「文枢」，Mac 应用菜单第一项 `label: app.name` 直接显示内部标识 `mozhou-agent`。新增单一来源 `src/shared/constants/brand.ts:APP_BRAND_NAME`，`window.ts`、`menu.ts`（含 `关于${APP_BRAND_NAME}`）、`App.tsx` 全部取该常量，`index.html` 与 `electron-builder.yml` 因是静态文件/打包配置只能各写一份，由测试钉住一致性。**★ 故意不改的三处**（已写进 brand.ts 注释并被测试钉住）：`package.json name=mozhou-agent`（决定 userData 目录名，跟着改会让老用户一打开就找不到书稿）、`appId=com.mozhou.writer`（NSIS 靠它识别同一应用，改了会变"新装一份"）、Agent 自我身份「墨舟写作 Agent」与备份/AI 味文案里的笔名「墨舟」。补 `tests/integration/brand-naming.test.ts`（7 条）| ~~低~~ — |
| 7 | 审稿模式行内标注 | 现为报告式；行内 wavy 标注需把命中 offset 映射回编辑器 | 高 |
| 8 | ~~便携版数据目录~~ ✅ **已修（2026-10-09）** | `electron-builder.yml:21` 打了 `portable` 目标，但主进程从没读过启动器注入的 `PORTABLE_EXECUTABLE_DIR`（= exe 所在目录）→ 数据永远写 `%APPDATA%\mozhou-agent`（本条原写「`%APPDATA%\墨舟写作台`」是**错的**，实测目录名来自 `package.json` 的 `name`，与 productName 无关），「便携」名不副实。新增纯函数 `src/main/data-dir.ts:portableDataDir()`（只吃 env，可注入测试），入口 `index.ts` 在**第一个 `app.getPath('userData')` 被读之前** `app.setPath`。四个消费点（`services.ts:85` db、`:92` 备份、`keyring.ts:21` 凭据、`ipc/register.ts:61` `app:getPaths`）实测全部走同一个 getter，所以改一处全体生效、无需逐个加分支；递归建目录 + `try/catch` 兜底，写保护介质上退回默认目录而不是双击没反应。未设变量的 NSIS 版/开发模式返回值恒为 `null`，行为零变化。补 `tests/integration/portable-data-dir.test.ts`（10 条：6 行为 + 4 装配哨兵，含「设置必须早于 `new AppServices()`」的顺序断言）。**遗留见第 14 条** | ~~低~~ — |
| 14 | **便携版换目录后的旧数据与旧凭据（新发现，待定夺）** | ① 已在用旧便携版的用户升级到本次修复后的构建，exe 旁边会新建一个空的 `mozhou-data`，书稿仍留在上一台机器的 %APPDATA% 里 → 表现为「项目列表空了」，需要一份「把旧 userData 整体搬到 exe 旁」的说明或一次性迁移（迁移涉及覆盖既有 db，不能顺手做）。② `safeStorage` 的密钥是**按机器/按用户**的（DPAPI），便携包换机器后旧 `llm-credentials.bin` 必然解不开；已实测降级路径是安全的（`keyring.ts:51-53` catch 后返回 `undefined`，不崩），但用户需重输一次 Key | 低-中 |
| 9 | ~~账本摘要未并入状态指纹~~ ✅ **已修（2026-10-09）** | `services.ts` 的 `computeStateHash()` 调 `ledgerDigest([])` 传空数组，注释承诺的「只改账本也能被检测到」从未生效 → 判据 B 会把「只改账本」误判为 `no-effect`。已抽出 `util/hash.ts:ledgerStateEntries()` 把四类账本摊平接进指纹，补 `tests/integration/ledger-statehash-wiring.test.ts`（7 条：4 条行为 + 3 条装配哨兵）。**但注意**：写入侧仍缺失，见第 13 条，故本条修完暂无可观测行为变化 | ~~低~~ — |
| 13 | **账本无任何写入路径（新发现，未修）** | 复核 §1.4 时确认：`memCharacters/memNumbers/memTimeline/memForeshadows` 四个 Map 全仓**只有读、没有 `.set()`**，`ledger_*` 五张表只有 `db/migrate.ts` 里的 DDL、没有 repo。后果比文档原写的「重启丢失」严重——账本**会话内也恒为空**，`query_ledger` 永远返回空集合，S2 跨章一致性对账无数据来源。详见 `REMAINING.md` §1.4（已同步修正） | 中 |
| 10 | ~~事件载荷硬编码~~ ✅ **已修（2026-10-09）** | `loop.ts` 的 `agent:tool-call` 写死 `danger: 1` 与 `writePolicy: 'auto-with-undo'`，与实际 `spec.danger` / 本次 run 解析出的策略无关 → ★2~★5 一律报成 ★1、用户切过的策略一律报成老板默认值。已按 `setIdempotentTools` 的既有注入模式补 `loop.setToolReport(toolSpecs, writePolicy.policy)`，事件字段类型收紧为 `ToolDanger \| null` / `WritePolicy \| null`（未注入时如实给 null，绝不编数字），`ipc.ts` 契约同步。**更正本条原写的「界面显示不真实」**：全仓 grep 确认渲染层没有任何订阅方（`preload/api.ts:195` 只是把通道名加进白名单），所以此前无用户可见的错误显示——但虚假载荷确实每条都跨过了一条白名单 IPC 通道，任何未来接入方一上手就拿到错值。补 `tests/integration/tool-call-payload.test.ts`（5 条，起真 AgentHost + 真 registry，断言对外事件本身） | ~~低~~ — |
| 11 | ~~`locate_issues` 段落定位错位~~ ✅ **已修（2026-10-09）** | `analyze.ts` 段落分支（`avgPara`/`sentsPerPara`）的 `offset` 是死变量（`map` 从不累加），位置全靠 `body.indexOf(段落)` 兜底 → 重复段落的两条命中都落到**首次出现处**，后续 `replace_phrase` 会改错地方。已改为按文档顺序逐段累加、删掉 `indexOf` 兜底，并补 `tests/unit/locate-offset.test.ts`（3 条） | ~~低~~ — |
| 12 | ~~句子分支同病~~ ✅ **已修（2026-10-09）** | 紧挨着 #11 的 `avgSent`/`sentCv` 分支仍是 `body.indexOf(s)` 从 0 反查（修复前 `analyze.ts:254`）。实测 body=`B+A+A+B`（B 长 17、A 长 4）时返回 `at = 0, 0, 17`，第二条 B（真实位置 25）指向了 0。已改为按 `split` 顺序逐句累加。**原条目里两句猜测，一句应验、一句需要澄清**：① 「跨行重复句因片段自带 `\n` 前缀而不会撞车」**成立**——`split(/(?<=[。！？…])/)` 在终止符之后断开，换行归**下一个**片段，所以跨段重复句的片段文本唯一、`indexOf` 恰好给对位置（node 复核过边界），这一半边本来就对，因此新增一条护栏用例钉住「修句子分支不许弄坏跨段那半边」；② 「需先确认是否要保住段内重复只报一次的语义」**不必再等决策**——修复前代码本就把同一句的两次出现各报一条，本次只改 `at`，命中条数与排序口径一字未动。累加口径与段落分支差 1（句子片段之间没有被吃掉的分隔符，只加 `s.length`）。补 4 条用例进 `tests/unit/locate-offset.test.ts`（红阶段实测：两条 DUP 都是 17） | ~~低~~ — |
| 17 | **全书没有任何「新建章节」的入口（修第 4 条时顺出来的，未修）** | 证据链（每条都实测过，不是推断）：`ChapterRepo.insert`（`db/repos/chapter-repo.ts:188`）**全仓零调用方**——`grep -rn "\.insert(" src` 返回空；整个 `src/` 里 `INSERT INTO chapters` 只有 `:194` 这一处，且在 insert 内部；`src/main/tools/impl/` 七个 Agent 工具（analyze/digest/fix/ledger-query/phrase/scan/undo）没有一个能建章；`services.openProject()` 只 `ensureDir(join(rootDir,'chapters'))`（`services.ts:126`），**从不**把该目录里的 .md 读回库；备份还原同样落不到 insert。净效果：**`chapters` 表恒为空** → 章节树、编辑器、体检、AI 味统计、规划视图的全部聚合在真实使用中拿不到任何数据（单测能过是因为测试自己调 insert 造了数据）。第 4 条补的是「序与卷」，这条补的是「章从哪来」，是独立的一块功能缺口，需要单独立项：导入 .md / 手动新建 / 给 Agent 一个建章工具，三选一或并行 | 中 |

---

## 五、协作必读：环境三大坑（踩过的，别再踩）

1. **better-sqlite3 = Electron ABI**：`node_modules` 里是按 Electron ABI 130 预编译的。**跑测试必须 `npm test`**（内部走 `scripts/test.cmd`：`ELECTRON_RUN_AS_NODE=1` + Electron 自带 Node 20.18.3）。直接 `npx vitest run` 会报 `NODE_MODULE_VERSION` 错——不是代码坏了。
2. **下载必须走 npmmirror**：electron / electron-builder 二进制直连 GitHub 会 ECONNRESET。镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
3. **改错误契约先查消费方**：preload 桥是唯一收口；新增 IPC 通道要同步四处（`shared/types/ipc.ts` 类型+白名单、`main/ipc/register.ts`、`preload/api.ts`+`index.ts`）。

---

## 六、如何运行与验收

```powershell
cd C:\Users\Administrator\WorkBuddy\2026-10-07-19-01-04\MozhouAgent
npm install          # 已装则跳过
npm run dev          # 开发模式（开发期 CSP 已放行 vite 内联脚本）
npm test             # 527 用例（必须用这个，见第五节坑 1）
npm run typecheck    # 三段 tsc
npx electron-vite build          # 三段构建
node scripts\make-icon.mjs       # 重画 build/icon.ico（图标改动时才需要）
npx electron-builder --win portable --x64   # 便携版（带镜像变量）
```

**验收四关**（改完必须全过）：`typecheck 0 错` → `npm run lint`（0 error，warning 不新增）→ `npm test 527 全绿` → `node scripts\verify-flavor-acceptance.mjs`（9 项校准验收，退出码接 CI）。

> ⚠️ `npm run test:coverage` 在本机 WorkBuddy 沙箱下会因 v8 provider 写临时文件失败而报错，
> 与代码无关（详见 `vitest.config.ts` 内注释）。覆盖率门请在 CI 或正常终端执行。

**一键脚本**：项目根 `dev.cmd`（启动）、`verify.cmd`（验收）——双击即用，自动切目录。

---

## 七、协作流程约定

1. 认领第四节任一项 → 在本知识库对应条目下留言/或联系项目负责人
2. 改动分层守规矩：业务逻辑在 `src/main/services.ts` + 各领域目录；渲染层只走 `window.mz`，不碰裸 ipcRenderer
3. 交付标准 = 第六节验收四关全绿 + 更新本文档状态表（含用例数等实测数字，别留旧口径）
4. 设计定稿：`novel-workbench-ui/index.html`（水墨金五模式）是 UI 唯一视觉规范
