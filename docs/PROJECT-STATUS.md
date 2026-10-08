# 木萱网文写作台 项目情况通报

> 面向兄弟单位的共享文档 · 更新日期 2026-10-09 · 版本 0.1.0
> 一句话定位：**九 Agent 网文写作桌面应用**——本地优先、数据自持、AI 全流程辅助创作。

---

## 一、当前状态总览

| 事项 | 状态 |
|---|---|
| 核心链路 | ✅ 全通：五模式 UI + 57 条 invoke 通道 + 14 条订阅通道 + SQLite 持久化（迁移到 v8）+ Agent 循环 |
| AI 味检测 | ✅ 10 维度引擎 + 语料基线校准（715 章真实语料）+ 用户自建基线 |
| 专家团评审 | ✅ 6 角色（结构/人物/对白/文字/读者/类型）+ 冲突并列 + 作者裁决 |
| 模型接入 | ✅ 6 家 Provider（DeepSeek/OpenRouter/本地等）+ safeStorage 加密 Key + 连接测试 |
| 检查点回滚 | ✅ Agent 每步快照，改动历史可回滚 |
| 便携版 | ⚠️ `release/` 里现存的 `墨舟写作台-0.1.0-portable.exe`（74MB，2026-10-08 07:56 打）**两处过时**：① 是 §4 第 8 条修复**之前**的产物，数据仍写 %APPDATA%；② 文件名带着第 6 条修复**之前**的旧 productName。重新打包后产物名变为 `木萱网文写作台-0.1.0-portable.exe`，须按第六节 `npx electron-builder --win portable --x64`，且重新打包后需实测（见第 14 条） |
| 测试基线 | ✅ **654 用例全绿（40 文件，2026-10-09 05:53 实测**，含第 6 条 brand-naming 7 条 + 第 5 条 app-icon 9 条 + 第 4 条 volume-order 15 条与 wiring 22 条 + 第 13 条 ledger-repo 18 条、ledger-update-tool 13 条与 write-wiring 12 条 + 第 3 条 daily-write-repo 34 条与 wiring 16 条 + 第 17 条 chapter-create 19 条与 wiring 15 条）+ 验收脚本 9 项。**必须走 `npm test`**，见第五节。旧文档的「281」「527」「570」「620」是修复前的口径 |
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
| 项目 | `project:open/close/list/save/volumes/create-volume/reorder-volumes/set-price` | 项目生命周期、分卷与卷序重排、千字单价 |
| 章节 | `chapter:list/get/create/update/reorder/set-volume` | 章节元数据与正文（乐观锁 rev）、★新建（章节号由主进程算，请求体故意不收 id）、章序重排、换卷 |
| Agent | `agent:run/abort/state/history` | Agent 循环（runId + 事件推送）|
| 检查点 | `checkpoint:list/undo` | 改动历史与回滚 |
| AI 味 | `aiFlavor:scan/latest/trend/rewrite/config/baseline/rebuildBaseline` | 检测/改写/基线 |
| 专家团 | `expert:roles/review/history/decide/config` | 角色注册表/评审/裁决 |
| 模型 | `llm:status/configure/test` | Provider 状态/配置/连通测试 |
| 设定 | `ledger:query` / `ledger:upsert` | 设定账本读（人物/数字锚点/时间线/伏笔/冲突）与写（entries → 四类计数）|
| 仪表盘 | `dash:stats` | 全书统计（日增量/状态计数/卷进度/检查点数/LLM 用量/稿费预估）|
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
| 3 | ~~日增量数据源缺失~~ ✅ **已修（2026-10-09，日增量与稿费部分）** | 原条目说「需发布平台接入或日增量追踪表」，两个选项里**后者根本不需要平台**：修复前 `dashStats()`（`services.ts:815`）的返回里没有任何按日字段，而库里每章只有 `updated_at` 一个瞬时戳——改一次覆盖一次，"今天写了多少字"在**数据结构上就问不出来**（不是没算，是没地方查）。仪表盘因此挂了一句「今日新增/连更/稿费需要发布平台数据，后续接入」，把一件本地能做的事推给了外部。本次：① **迁移 v8** 建 `daily_writes(project_id, day, delta_chars, updated_at)`，主键即最高频查询形状故不再另建索引；同时给 `projects` 加 `price_per_k`（默认 0 = 未配置）。② ★**记账点放在 `ChapterRepo.updateBody`/`insert` 内部**，不放在调用方——本仓库反复出现的事故形状就是"逻辑对、喂给它的是空气"，挂在调用方意味着 7 个 `updateBody` 调用点（`ipc/register.ts:186` + `services.ts:189/215/240/262/449/735`）各自记得调一次，漏一个只少一天且不报错。记的是**净增**（新字数 − 旧字数，可为负），`delta=0` 不落行，rev 冲突在记账之前就抛了所以失败的保存不留账。③ `DailyWriteRepo` 是 `ChapterRepo` 构造参数的**默认值**（`new DailyWriteRepo(db)`），不给"忘了传"留机会；`services.ts` 里再显式传一次，组合根与默认值同一口径。④ 连更口径：**今天为 0 时从昨天起算**（刚过零点还没动笔不该报"连更 0 天"吓唬作者），只数净增 > 0 的天。日期按**本地时区**切（按 UTC 切会让国内用户每天 08:00 才换天）。⑤ 契约扩到 `DashStats.daily/pricePerK/monthPay`，新通道 `project:set-price` 按第五节坑 3 同步满四处；仪表盘加了今日净增/连更/本月净增三张卡 + 近 7 天柱条 + 单价输入框。测试 `tests/unit/daily-write-repo.test.ts` 34 条（真 `:memory:` 库）+ `tests/integration/daily-delta-wiring.test.ts` 16 条装配哨兵。**未做 / 需要老板知道**：① **追读率仍然没有**，也不打算用代理指标冒充——那是读者行为数据，本地只有稿子没有读者，仪表盘上如实标注未接入；② 稿费预估的口径是「本月净增千字 × 用户自填单价」，与任何平台的实际结算无关，界面上写明了这一点；③ ★**修复当时在真实数据上看不到数字**：那时全书没有建章入口，`chapters` 表恒为空，没有正文可保存就没有净增。单测能过是因为测试自己建章造数据。**现已解除**——第 17 条（2026-10-09）通了手动建章，有章就能写正文，净增也就有了真来源 | ~~中~~ — |
| 4 | ~~分卷创建/拖拽排序~~ ✅ **已修（2026-10-09）** | 原写「规划视图只读展示，无 IPC」说轻了——真正的病灶是 `ProjectRepo.insertVolume`（`db/repos/chapter-repo.ts:349`）**全仓零调用方**：UI 没入口、IPC 没通道、Agent 没工具，又是本仓库反复出现的「逻辑对、喂给它的是空气」。四层一起接通：① **repo** 新增 `createVolume`（`title.trim()` 拒空，ord 由 `SELECT COALESCE(MAX(ord),-1)+1` 让库自己算，调用方不数）、`reorderVolumes`、`ChapterRepo.reorder`、`ChapterRepo.setVolume`；重排统一「整表全给 + 单事务 + `ord` = 数组下标」，`assertExactIdSet` 拒绝漏条/越界/重复（列表过期时报错，而不是把顺序改乱）；★重排**只写 `ord`**，不碰 `rev`/`updated_at`——拖一下不该把编辑器的乐观锁搅乱。② **IPC** 四条新通道 `project:create-volume`/`project:reorder-volumes`/`chapter:reorder`/`chapter:set-volume`，按第五节坑 3 同步满四处（类型表 + 两份白名单 + preload 桥 + 主进程 handle）；写通道未打开项目时抛结构化 `E_INVALID_ARGS`，不学读通道（`chapter:list` 那类返回 `[]`）的静默口径。③ **渲染层**：规划视图加了真建卷输入框与卷卡拖拽（`views/PlanView.tsx`），章节树加了「章拖到章=改全局序、章拖到卷名=换卷」（`chapter-tree/ChapterTree.tsx`）；两处都是**乐观生效 → 以主进程返回的整表覆盖 → 失败自动回读**，不会出现"看着改了、其实库里没改"。④ **测试**：`tests/unit/volume-order.test.ts`（15 条，真 `:memory:` 库，含「拖十次之后仍是 0..n-1」「重排不许顺手改正文与 rev」「跨项目 id 拒绝」「`ON DELETE SET NULL`」）+ `tests/integration/volume-order-wiring.test.ts`（22 条装配哨兵，钉住通道/白名单/handle/渲染层真调用/回写 store）。**未做**：卷的建与拖可实测，**修复当时章节树的拖拽在真实数据上没有可拖的对象**——因为全书根本没有建章节的入口；第 17 条（2026-10-09）已通手动建章，这条现在可实测了 | ~~低~~ — |
| 5 | ~~应用图标~~ ✅ **已修（2026-10-09）** | `build/` 目录此前**根本不存在**（`ls build` → No such file or directory），electron-builder 找不到 `build/icon.ico` 只在日志里 warn 一句、照样出货，于是任务栏/桌面/卸载列表一路是 Electron 默认图标——第 6 条把品牌名统一了，图标却还是别人的。新增 `scripts/make-icon.mjs`：**零第三方依赖**纯数学光栅化（仓库无 sharp/pngjs/canvas，不想为一个图标拉原生模块），画「墨底圆角方 + 宣纸色笔锋 + 朱砂印」三要素，与渲染层「素笺·朱批」同一套色；16/24/32/48/64/128/256 七档**按档重画**（直接缩放 256 会让 16 档的细笔画糊成灰），4×4 超采样抗锯齿，手写 ICO 容器（32 位 BGRA + `biHeight=2×高` + 全 0 AND 掩码，透明度只由 alpha 承担）。产物 `build/icon.ico`（364 KiB）**已提交**——`build/` 不在 .gitignore 里，实测 `git check-ignore` 返回 1。补 `tests/integration/app-icon.test.ts`（9 条，全部围绕"Windows 能不能正确读出来"：容器头、尺寸覆盖、目录项自洽、DIB 头字段、掩码全 0、非纯色且圆角外真透明）。已肉眼核验 16/32/256 三档渲染（笔锋与红印在小尺寸下仍可读）。**未做**：重新打包验证图标真的出现在 exe 上（打包要下载 electron-builder 二进制，留作下一步）| ~~低~~ — |
| 6 | ~~品牌命名统一~~ ✅ **已修（2026-10-09，老板定夺：对外统一为「木萱网文写作台」）** | 修复前同一个产品对外**三套名字**：`electron-builder.yml:2` productName 与窗口/页面/菜单写「墨舟写作台」，侧栏 mark 的 `title` 写「文枢」，Mac 应用菜单第一项 `label: app.name` 直接显示内部标识 `mozhou-agent`。新增单一来源 `src/shared/constants/brand.ts:APP_BRAND_NAME`，`window.ts`、`menu.ts`（含 `关于${APP_BRAND_NAME}`）、`App.tsx` 全部取该常量，`index.html` 与 `electron-builder.yml` 因是静态文件/打包配置只能各写一份，由测试钉住一致性。**★ 故意不改的三处**（已写进 brand.ts 注释并被测试钉住）：`package.json name=mozhou-agent`（决定 userData 目录名，跟着改会让老用户一打开就找不到书稿）、`appId=com.mozhou.writer`（NSIS 靠它识别同一应用，改了会变"新装一份"）、Agent 自我身份「墨舟写作 Agent」与备份/AI 味文案里的笔名「墨舟」。补 `tests/integration/brand-naming.test.ts`（7 条）| ~~低~~ — |
| 7 | 审稿模式行内标注 | 现为报告式；行内 wavy 标注需把命中 offset 映射回编辑器 | 高 |
| 8 | ~~便携版数据目录~~ ✅ **已修（2026-10-09）** | `electron-builder.yml:21` 打了 `portable` 目标，但主进程从没读过启动器注入的 `PORTABLE_EXECUTABLE_DIR`（= exe 所在目录）→ 数据永远写 `%APPDATA%\mozhou-agent`（本条原写「`%APPDATA%\墨舟写作台`」是**错的**，实测目录名来自 `package.json` 的 `name`，与 productName 无关），「便携」名不副实。新增纯函数 `src/main/data-dir.ts:portableDataDir()`（只吃 env，可注入测试），入口 `index.ts` 在**第一个 `app.getPath('userData')` 被读之前** `app.setPath`。四个消费点（`services.ts:85` db、`:92` 备份、`keyring.ts:21` 凭据、`ipc/register.ts:61` `app:getPaths`）实测全部走同一个 getter，所以改一处全体生效、无需逐个加分支；递归建目录 + `try/catch` 兜底，写保护介质上退回默认目录而不是双击没反应。未设变量的 NSIS 版/开发模式返回值恒为 `null`，行为零变化。补 `tests/integration/portable-data-dir.test.ts`（10 条：6 行为 + 4 装配哨兵，含「设置必须早于 `new AppServices()`」的顺序断言）。**遗留见第 14 条** | ~~低~~ — |
| 14 | **便携版换目录后的旧数据与旧凭据（新发现，待定夺）** | ① 已在用旧便携版的用户升级到本次修复后的构建，exe 旁边会新建一个空的 `mozhou-data`，书稿仍留在上一台机器的 %APPDATA% 里 → 表现为「项目列表空了」，需要一份「把旧 userData 整体搬到 exe 旁」的说明或一次性迁移（迁移涉及覆盖既有 db，不能顺手做）。② `safeStorage` 的密钥是**按机器/按用户**的（DPAPI），便携包换机器后旧 `llm-credentials.bin` 必然解不开；已实测降级路径是安全的（`keyring.ts:51-53` catch 后返回 `undefined`，不崩），但用户需重输一次 Key | 低-中 |
| 9 | ~~账本摘要未并入状态指纹~~ ✅ **已修（2026-10-09）** | `services.ts` 的 `computeStateHash()` 调 `ledgerDigest([])` 传空数组，注释承诺的「只改账本也能被检测到」从未生效 → 判据 B 会把「只改账本」误判为 `no-effect`。已抽出 `util/hash.ts:ledgerStateEntries()` 把四类账本摊平接进指纹，补 `tests/integration/ledger-statehash-wiring.test.ts`（7 条：4 条行为 + 3 条装配哨兵）。**当时**写入侧还缺失（本条修完暂无可观测行为变化）；第 13 条已把写入侧接通，指纹现在吃的是真账本 | ~~低~~ — |
| 13 | ~~账本无任何写入路径~~ ✅ **已修（2026-10-09）** | 复核 §1.4 时确认的三个"零调用方"全部实测过：`memCharacters/memNumbers/memTimeline/memForeshadows` 四个 Map **只有 get、没有 `.set()`**；`db/migrate.ts` version 3 建的 `ledger_*` 五张表没有任何 repo；`handle('ledger:upsert', ...)` 是**回显桩**（把入参 `p.character` 原样返回，对外宣称"已登记"、落库 0 条）；连 `detectConflicts()` 都零调用方。后果比原文档写的「重启丢失」严重——账本**会话内也恒为空**，`query_ledger` 永远返回空集合，S2 跨章一致性对账无数据来源。本次四层补齐：① 新增 `db/repos/ledger-repo.ts`——实体整体 JSON 存 `payload`，同时把 name/subject/when/status/planted_chapter 拆成真实列（只存 payload 等于白建索引），主键 `id` ⇒ upsert 即覆盖，一类一条事务，`assertIdNotTakenByOtherProject` 拦住"把别项目的条目搬过来"；② `services.ts` 四个内存 Map 彻底退场，读写一律走 `ledgerRepo`，新增 `upsertLedger()`，**`conflicts()` 终于接上 `detectConflicts`**（此前恒返回写死的 `[]`）；③ 新增 Agent 工具 `update_ledger`（`tools/impl/ledger-update.ts`）——这是"真有人写"的那半边：id 一律系统生成（模型自编 id 会让同一人物变成两条事实）、**每条必须带出处** `refs:[{chapterId,quote}]`，工具会真去读那一章确认引文逐字存在并回填 offset，核验不过**整批一条不写**，同名人物复用旧 id 所以重复登记幂等；④ IPC 四处同步改契约：`ledger:upsert` 从 `{character}` 改为 `{entries: LedgerEntries}` → `LedgerCounts`，preload 桥加 `upsert()`。测试：`tests/unit/ledger-repo.test.ts` 18 条 + `tests/unit/ledger-update-tool.test.ts` 13 条 + `tests/integration/ledger-write-wiring.test.ts` 12 条装配哨兵。**未做 / 需要老板知道**：`ledger_conflicts` 表仍然没人写——冲突改为按最新账本**现算**（存下来会留下一份过期的"待裁决"记录去打扰用户），所以那张表目前是空壳 DDL；`ledger-query.ts` 的 `makeRef()` 仍零调用方（它服务的是"只有偏移没有引文"的场景，本条用不上，没为它硬造调用点）；`LoreView` 界面还没有"手工登记"入口，用户侧写入口只有 Agent 工具 | ~~中~~ — |
| 10 | ~~事件载荷硬编码~~ ✅ **已修（2026-10-09）** | `loop.ts` 的 `agent:tool-call` 写死 `danger: 1` 与 `writePolicy: 'auto-with-undo'`，与实际 `spec.danger` / 本次 run 解析出的策略无关 → ★2~★5 一律报成 ★1、用户切过的策略一律报成老板默认值。已按 `setIdempotentTools` 的既有注入模式补 `loop.setToolReport(toolSpecs, writePolicy.policy)`，事件字段类型收紧为 `ToolDanger \| null` / `WritePolicy \| null`（未注入时如实给 null，绝不编数字），`ipc.ts` 契约同步。**更正本条原写的「界面显示不真实」**：全仓 grep 确认渲染层没有任何订阅方（`preload/api.ts:195` 只是把通道名加进白名单），所以此前无用户可见的错误显示——但虚假载荷确实每条都跨过了一条白名单 IPC 通道，任何未来接入方一上手就拿到错值。补 `tests/integration/tool-call-payload.test.ts`（5 条，起真 AgentHost + 真 registry，断言对外事件本身） | ~~低~~ — |
| 11 | ~~`locate_issues` 段落定位错位~~ ✅ **已修（2026-10-09）** | `analyze.ts` 段落分支（`avgPara`/`sentsPerPara`）的 `offset` 是死变量（`map` 从不累加），位置全靠 `body.indexOf(段落)` 兜底 → 重复段落的两条命中都落到**首次出现处**，后续 `replace_phrase` 会改错地方。已改为按文档顺序逐段累加、删掉 `indexOf` 兜底，并补 `tests/unit/locate-offset.test.ts`（3 条） | ~~低~~ — |
| 12 | ~~句子分支同病~~ ✅ **已修（2026-10-09）** | 紧挨着 #11 的 `avgSent`/`sentCv` 分支仍是 `body.indexOf(s)` 从 0 反查（修复前 `analyze.ts:254`）。实测 body=`B+A+A+B`（B 长 17、A 长 4）时返回 `at = 0, 0, 17`，第二条 B（真实位置 25）指向了 0。已改为按 `split` 顺序逐句累加。**原条目里两句猜测，一句应验、一句需要澄清**：① 「跨行重复句因片段自带 `\n` 前缀而不会撞车」**成立**——`split(/(?<=[。！？…])/)` 在终止符之后断开，换行归**下一个**片段，所以跨段重复句的片段文本唯一、`indexOf` 恰好给对位置（node 复核过边界），这一半边本来就对，因此新增一条护栏用例钉住「修句子分支不许弄坏跨段那半边」；② 「需先确认是否要保住段内重复只报一次的语义」**不必再等决策**——修复前代码本就把同一句的两次出现各报一条，本次只改 `at`，命中条数与排序口径一字未动。累加口径与段落分支差 1（句子片段之间没有被吃掉的分隔符，只加 `s.length`）。补 4 条用例进 `tests/unit/locate-offset.test.ts`（红阶段实测：两条 DUP 都是 17） | ~~低~~ — |
| 17 | ~~全书没有任何「新建章节」的入口~~ ✅ **已修（2026-10-09，手动建章路径）** | 证据链（每条都实测过，不是推断）：`ChapterRepo.insert`（`db/repos/chapter-repo.ts:188`）**全仓零调用方**——`grep -rn "\.insert(" src` 返回空；整个 `src/` 里 `INSERT INTO chapters` 只有 `:194` 这一处，且在 insert 内部；`src/main/tools/impl/` 七个 Agent 工具（analyze/digest/fix/ledger-query/phrase/scan/undo）没有一个能建章；`services.openProject()` 只 `ensureDir(join(rootDir,'chapters'))`（`services.ts:126`），**从不**把该目录里的 .md 读回库；备份还原同样落不到 insert。净效果：**`chapters` 表恒为空** → 章节树、编辑器、体检、AI 味统计、规划视图的全部聚合在真实使用中拿不到任何数据（单测能过是因为测试自己调 insert 造了数据）。第 4 条补的是「序与卷」，这条补的是「章从哪来」。**本次接通的是"手动新建"这一条路**（三选一里最小的那条，导入 .md 与 Agent 建章工具见第 18、19 条）：① **repo** 新增 `ChapterRepo.createChapter(projectId, {title, volumeId})`（`chapter-repo.ts:235`）——★**章节号（就是主键 id）由主进程算**，口径是"本项目可解析为数字的最大号 + 1"（不是条数 + 1，删过一章不该把号退回去；楔子/番外这类非数字 id 不参与算号），入参里根本没有 id：让界面传主键，双击就是两条同号章或一次主键冲突。`ord` 取 `MAX(ord)+1` 追加到全书末尾，空标题允许（先建章再想名字是常态），状态直接给 `draft`（点建章是要开始写，不是立大纲占位），`chapters` + `chapter_bodies` 两行同事务落盘（只写前者是"有章无文"的半状态）。归属卷做了两道闸：卷不存在被外键拦、**别项目的卷直接拒**（不写库）。② **IPC** 新通道 `chapter:create`（req 只有 `title`/`volumeId`，res 是 `ChapterMeta`），按第五节坑 3 同步满四处；未打开项目时抛结构化 `E_INVALID_ARGS`，建章计入 `backup.noteEdit()`（改了结构就该把自动备份叫醒）。③ **渲染层**：章节树加了标题框 + 「新建章节」（跟着当前章所在卷走；没分卷就落「未分卷」），建完**整表回读 + 选中新章**；空态文案从「打开或新建一个项目开始」——那句把没有章的人堵回了原地——改成真的给出入口。④ **测试**：`tests/unit/chapter-create.test.ts` 19 条（真 `:memory:` 库，含"两本书不撞号""空章不产生日净增""建完 `reorder` 不会报列表过期"）+ `tests/integration/chapter-create-wiring.test.ts` 15 条装配哨兵（钉住通道/两份白名单/handle/★请求体无 id/`p.id` 未被当主键/preload 两层/渲染层真调用）。**实测副作用**：`grep -rn "\.insert(" src` 现在恰好一条命中（`createChapter` 内部），第 3 条里"日增量在真实数据上看不到数字"的前提随之解除——有章就能写正文，净增也就有了来源 | ~~中~~ — |
| 18 | **章节号跨书不隔离：`chapters.id` 是单列主键，第二本书只能接着编号** | 修第 17 条时撞出来的。`chapters` 的 `id TEXT PRIMARY KEY`（`migrate.ts:39`）既是主键又是给用户看的章节号（`第${c.id}章`、`context-builder.ts:71` 的提示词、导出文件名都用它），所以它**不是** `(project_id, id)` 复合键。后果：A 书写到第 2 章后，B 书点「新建章节」拿到的是 3，不是 1——两本书各自从 1 开始这个直觉在 schema 层就不成立。本次的处理是"跳过已被占用的号"而不是撞车报错（`chapter-create.test.ts` 钉死了这个语义），所以**不炸，但号不体面**。真修要换主键：`chapters` 重建为复合主键、`chapter_bodies` 等 2 张以 `REFERENCES chapters(id)` 的子表跟着补 `project_id`、`chapter-repo.ts:109/132/149/314/325` 那 5 处按裸 id 查改 chapters 的语句（`:301` 已经带上了 `project_id`）与 IPC/preload/渲染层传来的裸 `chapterId` 都要带上项目维度——比一条通道大一个量级，需要单独立项，不适合顺手改 | 中 |
| 19 | **建完的章改不了标题；打开项目仍不读 `chapters/*.md`** | 第 17 条留的两处口径边界，都实测确认：① 全仓没有任何 `UPDATE chapters SET title`，标题只能在**建的那一刻**通过 `chapter:create` 给，之后想改名没有入口（编辑器只写正文，`updateBody` 不碰 title）；② `services.openProject()` 仍然只 `ensureDir(join(rootDir,'chapters'))`（`services.ts:137`），不会把目录里已有的 .md 稿子读回库，所以"导入旧稿"这条路依然不存在。前者是一条小通道（`chapter:set-title`，四处同步 + 复用重排那套不碰 `rev` 的判断），后者要先定口径（同名冲突、编码、是否覆盖库里已有的正文），不建议盲做 | 中 |

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
npm test             # 654 用例（必须用这个，见第五节坑 1）
npm run typecheck    # 三段 tsc
npx electron-vite build          # 三段构建
node scripts\make-icon.mjs       # 重画 build/icon.ico（图标改动时才需要）
npx electron-builder --win portable --x64   # 便携版（带镜像变量）
```

**验收四关**（改完必须全过）：`typecheck 0 错` → `npm run lint`（0 error，warning 不新增）→ `npm test 654 全绿` → `node scripts\verify-flavor-acceptance.mjs`（9 项校准验收，退出码接 CI）。

> ⚠️ `npm run test:coverage` 在本机 WorkBuddy 沙箱下会因 v8 provider 写临时文件失败而报错，
> 与代码无关（详见 `vitest.config.ts` 内注释）。覆盖率门请在 CI 或正常终端执行。

**一键脚本**：项目根 `dev.cmd`（启动）、`verify.cmd`（验收）——双击即用，自动切目录。

---

## 七、协作流程约定

1. 认领第四节任一项 → 在本知识库对应条目下留言/或联系项目负责人
2. 改动分层守规矩：业务逻辑在 `src/main/services.ts` + 各领域目录；渲染层只走 `window.mz`，不碰裸 ipcRenderer
3. 交付标准 = 第六节验收四关全绿 + 更新本文档状态表（含用例数等实测数字，别留旧口径）
4. 设计定稿：`novel-workbench-ui/index.html`（水墨金五模式）是 UI 唯一视觉规范
