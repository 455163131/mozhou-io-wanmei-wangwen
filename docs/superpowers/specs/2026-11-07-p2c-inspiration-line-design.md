# P2-C 灵感线四页 — Design Spec

> brainstorming 阶段产物（architectural path）。上游：`../plans/` 同级 DRD `C:\Users\Administrator\Documents\Qoder\2026-11-03\cfab122c\output\墨书写作坊重设计\strategize\drd.md`（§3.2 流水线、§4.2① 灵感河、§4.3 四页、§7 取舍）。下游：writing-plans 据本文出实施计划。
> 一句话：把 DRD §4.3 的**扫榜热榜 / 抽脑洞 / 拆书报告 / 选题库**四个「设计中」占位落成真实 mode 页，配一条「卡片 → 收藏/灵感库 → 选题库 → 立项」回流主线，最大化复用既有引擎（digest 拆书 / metrics 结构统计 / premise 派生 / ForeshadowView 接线模式），守住 R45 写手字节稳定与「不虚报」红线。

**Repo:** `C:\Users\Administrator\WorkBuddy\2026-10-07-19-01-04\MozhouAgent`，分支 `p2c-inspiration-line`，基线 master `5e0e692`（P2-B 已并入）。

---

## 1. 已裁决的三个设计叉（用户拍板，附理由与代价）

**F1 — 导演台「灵感河拖拽立项」延后。** P2-C 只做四个独立 mode 页，卡片走**按钮**「收藏 / 套用」回流选题库→立项。拖拽立项改的是导演台 GenView（现无灵感河栏、premise 只读、三栏布局），独立成后续增强片更聚焦。*代价若错：DRD §4.2①/§7「采纳灵感河拖拽」本期不兑现，留待后续片；按钮套用已覆盖「套用回流主线」的功能实质。*

**F2 — 抽脑洞 / 拆书八维走全量新 LLM 角色 + 无 Key 演示兜底。** 新增「脑洞生成」（24 方向种子池 + 反重复，温度 1.05）与「拆书八维精读」两个 LLM 角色，各带明示「演示」的确定性兜底。匹配 DRD 能力可见（原则#2）+ 确定性优先（原则#4）。*代价若错：两个新角色进 overlay 体系，注册面增多（见 §6）；无 Key 演示产物质量有限但明示不虚报。*

**F3 — 扫榜热榜直抓公开榜单页（用户 informed 选择，覆盖 DRD「留待接入」）。** 番茄/晋江/起点无公开官方 API，直抓其公开榜单 HTML。**责任边界（硬约束，不可越）**：礼貌抓取（缓存 + 限速 + robots.txt 尊重 + 常规 UA），**绝不构建反爬绕过**（无 CAPTCHA 破解、无指纹伪装、无代理轮换）；被挡/改版/超时 → **如实报错 + 回落内置演示数据集**（明示「演示数据」），绝不编造热度数字（DRD §7）。实时数据明示「实时」，演示明示「演示」。*代价若错：抓取违反平台 ToS、随 exe 分发、平台改版即失效——用户已 informed 接受；礼貌 + 诚实兜底把风险与误导降到最低。*

---

## 2. 架构总览

灵感线是**全局（跨书）子系统**：卡片在「立项成书」之前就存在，故新表**不带 project_id**（选题在「已立项」态才链到一个 project）。这是对本仓「project-scoped」惯例的一处**有意偏离**——理由：灵感先于书；强行 project-scope 会让「待立项」卡片无家可归。

数据流主线（DRD §7「套用回流主线」）：

```
扫榜热榜 ─┐
抽脑洞   ─┼─→ 卡片(inspiration_cards) ─收藏→ 灵感库(collected=1)
拆书八维 ─┘                              └─套用→ 选题库(topics:待立项)
                                                    │ 立项(promote)
                                                    ▼
                                    建/开 project + 播 premise(已采纳构思草稿)
                                                    + topic 置「已立项」链 project_id
```

分层（照本仓既定）：纯数据/纯函数下沉 `src/shared`（种子池、结构统计口径、卡片类型），可被 node 环境单测直接覆盖（external-url.ts / ledger-metrics.ts 同源铁律）；抓取器/LLM 角色/Repo 在 `src/main`；四页在 `src/renderer/components/views`。

---

## 3. 数据层（v16 迁移，append-only）

延续 `src/main/db/migrate.ts` 的 `MIGRATIONS[]`（现最新 **v15** `add_ledger_char_states`）。P2-C 开 **v16**，一次迁移建三表（`CREATE TABLE IF NOT EXISTS` + 索引，镜像 v13/v15 风格注释；库列不加 CHECK，枚举收紧在应用写侧——v14 language 同口径）。

### 3.1 `inspiration_cards`（统一卡片模型，单一真相 原则#7）
```
id            TEXT PRIMARY KEY        -- 'ic-<ts36>-<rand>'，照 DraftRepo 生成式
kind          TEXT NOT NULL           -- 'trend' | 'idea' | 'teardown'（应用侧枚举收紧）
title         TEXT NOT NULL           -- 卡面标题（书名 / 脑洞一句话 / 拆书维度名）
payload       TEXT NOT NULL           -- JSON，按 kind 异形（见 §3.4）
source_label  TEXT NOT NULL           -- 来源标注：平台名 / 种子方向 / 拆书书名
collected     INTEGER NOT NULL DEFAULT 0  -- 0/1，1=已入灵感库
created_at    TEXT NOT NULL
```
索引：`(kind, created_at)`。**反重复**（抽脑洞）直接查 `kind='idea'` 历史卡，不另开表。

### 3.2 `topics`（选题库，生命周期三态互斥）
```
id              TEXT PRIMARY KEY      -- 'tp-<ts36>-<rand>'
title           TEXT NOT NULL
premise         TEXT NOT NULL         -- 一句话故事（立项时播进 project）
status          TEXT NOT NULL         -- '待立项' | '已立项' | '已放弃'（互斥，应用侧收紧；修正豆包矛盾标签 DRD §4.3）
project_id      TEXT                  -- 可空；仅「已立项」链到 projects(id)
source_card_id  TEXT                  -- 可空；来自哪张 inspiration_cards
created_at      TEXT NOT NULL
updated_at      TEXT NOT NULL
```
索引：`(status, updated_at)`。状态机**单向**：待立项→已立项 / 待立项→已放弃（照 DraftRepo 单向状态机口径）；已立项/已放弃为终态（已放弃可否复活留 writing-plans 定，默认终态）。

### 3.3 `teardown_reports`（拆书报告）
```
id              TEXT PRIMARY KEY      -- 'td-<ts36>-<rand>'
book_title      TEXT NOT NULL
structure_json  TEXT NOT NULL         -- 零token结构统计（distillReferenceWork+analyze 产物）
dimensions_json TEXT                  -- 可空；八维 AI 精读结果，精读前为 NULL
created_at      TEXT NOT NULL
```
索引：`(created_at)`。每一维可「存入灵感库」→ 落 `inspiration_cards(kind='teardown')`。

### 3.4 payload JSON 形状（按 kind，zod 校验收口在 IPC 边界）
- `trend`：`{ platform, author?, heat?, rank?, tags?: string[], url?, live: boolean }`（`live` 区分实时/演示；`heat` 仅在有据时填，演示集自带明示数值但 `live:false`）。
- `idea`：`{ direction, premise, hook?, genre?, temperature: 1.05, live: boolean }`（`direction` = 抽中的种子方向；`live` 区分 LLM 生成/演示兜底）。
- `teardown`：`{ dimension, summary, bookTitle, reportId }`（`dimension` = 八维之一）。

### 3.5 三个 Repo（照 DraftRepo/LedgerRepo 形状）
`InspirationRepo` / `TopicRepo` / `TeardownRepo`，构造吃 `db`，方法：
- InspirationRepo：`insert(card)`、`listByKind(kind)`、`listCollected()`、`setCollected(id, bool)`、`remove(id)`、`ideaHistory(): string[]`（反重复用：返回既有 idea 卡的 direction+premise 摘要）。
- TopicRepo：`insert(topic)`、`listByStatus(status?)`、`get(id)`、`setStatus(id, status)`（单向校验）、`linkProject(id, projectId)`。
- TeardownRepo：`insert(report)`、`get(id)`、`list()`、`setDimensions(id, dims)`。

---

## 4. 四页（UI + 后端 + IPC + 数据流）

四页统一照 **ForeshadowView/CharacterView 既定模式**（P2-B T4/T6）：`.module.css` + tokens.css 单一来源、`createSequencer()` 竞态守卫（切换/重拉即作废旧响应）、pid 无关（全局子系统，不随 project 切换重载）、诚实空态（未登记/—/本书暂无 同型文案）、实底按钮进 SOLID_BUTTON_CENSUS 棘轮。

### 4.1 扫榜热榜（TrendingView）
- **UI**：平台 Tab（番茄/晋江/起点）+ 3×3 书卡网格 + 数值化热度指数 + 每卡「收藏 / 套用」；顶部明示当前数据态徽标（**实时** / **演示数据**）；抓取失败显真因 + 「回落演示」提示。
- **后端**：`src/main/inspiration/chart-scraper.ts` —— `DataSource` 接口 `{ fetch(platform): Promise<{entries: ChartEntry[]; source:'live'|'demo'; error?: string}> }`；`LiveChartSource`（礼貌直抓：`fetch` + 内存/磁盘缓存 TTL + 限速 + robots.txt 检查 + 常规 UA；每平台一解析器，best-effort，解析失败/被挡→抛真因）；`DemoChartSource`（`chart-demo.ts` 内置明示演示集）。**无反爬绕过**（F3 硬约束）。
- **IPC**：`trending:fetch(platform)` → `{entries, source, error?}`；收藏 → `inspiration:collect`；套用 → `topic:create-from-card`。
- **诚实**：热度数字仅在 `live` 或演示集自带时显示，演示态全程明示；绝不编造（DRD §7）。

### 4.2 抽脑洞（IdeaDrawView）
- **UI**：抽卡区（一张脑洞卡：方向 + 一句话 premise + hook + 题材）+ 抽卡计数 + 「收藏 / 套用立项」+ 演示态徽标；反重复提示（不重复近期方向）。
- **后端**：24 方向种子池 `src/shared/inspiration/seed-pool.ts`（纯数据，24 条创作方向）；**新 LLM 角色「脑洞生成」** `composeIdeaPrompt`（温度 1.05 = DRD 反重复铁律）：抽一方向（避开 `ideaHistory()` 近期方向）→ LLM 扩成脑洞卡。**无 Key 演示兜底**：从种子池确定性取一方向 + 模板化扩写，`live:false` 明示演示。
- **IPC**：`idea:draw` → `{card, source:'live'|'demo'}`（落 `inspiration_cards kind='idea'`）；收藏/套用同上。

### 4.3 拆书报告（TeardownView）
- **UI**：输入区（粘贴文本 / 选已导入书）→ **零token结构统计秒出**（字数/章节/节奏/对话比/句长分布/钩子/角色…）→ 「按需 AI 精读八维」按钮 → 八维卡（定位/结构/节奏/爽点钩子/伏笔/人物/文风/可借鉴），每维「存入灵感库」；演示态徽标。
- **后端**：**复用 `src/main/tools/impl/digest.ts:distillReferenceWork`**（已是零-LLM 拆书：Bench/judgePattern/HOOK_PATTERNS/countHooks/extractRoles/buildKb/LCS 合规守卫）**+ `src/shared/metrics-engine.ts:analyze()`**（chars/paras/sents/avgSent/dialogRatio/ttr/分布/chapterOpenType）做结构统计——**零 token，原则#4**。**新 LLM 角色「拆书八维精读」** `composeTeardownPrompt`：按需对全文/采样精读八维。无 Key 演示兜底：八维回退到结构统计可确定的维度 + 明示「演示·未精读」。
- **IPC**：`teardown:structure({title,text})` → 零token统计（落 `teardown_reports.structure_json`）；`teardown:read(reportId)` → 八维（落 `dimensions_json`）；`teardown:save-dimension(reportId, dimension)` → 落 `inspiration_cards kind='teardown'`。

### 4.4 选题库（TopicLibraryView）
- **UI**：三态分栏/筛选（待立项 / 已立项 / 已放弃，互斥标签）+ 选题卡（标题 + 一句话故事 + 来源 + 操作）；待立项卡「立项」「放弃」；已立项卡显示链接的 project（可跳）。
- **后端**：TopicRepo 生命周期。**立项（promote）**：建/开 project（`project:pick-dir`+`project:open` 既有流，或 writing-plans 定的最简入口）+ **播 premise**：写一条「已采纳构思草稿」（`DraftRepo.insert` + `setStatus('adopted')`，其 logline = topic.premise），复用 `ctx.ts:110-111` 既有 `premise ← adopted concept logline` 派生——**不加 premise 列、不改 projects schema、单一真相一致**；+ `topic.setStatus('已立项')` + `linkProject`。
- **IPC**：`topic:list(status?)`、`topic:promote(id, dir?)`、`topic:abandon(id)`、`topic:create-from-card(cardId)`（套用入口）。

---

## 5. 套用 / 收藏 流（按钮，拖拽延后 F1）
- **收藏**：任意卡（trend/idea/teardown 维）→ `inspiration:collect(cardId)` 置 `collected=1` → 灵感库（选题库页或各页「已收藏」筛选可见）。
- **套用**：任意卡 → `topic:create-from-card(cardId)` → 在选题库建一条「待立项」topic（title/premise 取自卡片）→ 用户在选题库 promote 立项。
- 不实现导演台灵感河拖拽（F1 延后）。

---

## 6. 两个新 LLM 角色 + overlay 接线（注册面，Explore 已定位）
新角色 **脑洞生成（idea）** 与 **拆书八维（teardown）** 进 overlay 体系，需同步改：
1. `src/main/pipeline/prompts.ts`：`composeIdeaPrompt` / `composeTeardownPrompt`（照 composeConceptPrompt 形状 + `withOverlay()`）。
2. `src/main/pipeline/overlay.ts:26` `PromptOverlayRole` 联合 + `'idea'|'teardown'`。
3. `src/shared/types/ipc.ts:381` `OverlayRole` 联合（**与 #2 是重复联合——本仓多副本病；要求 sentinel/单测钉两处逐字相等**）。
4. `src/main/pipeline/overlay-ipc.ts:37` `OVERLAY_ROLES` 运行时白名单。
5. `src/main/pipeline/tools.ts:85` `TEMPERATURE` map：`idea: 1.05`（DRD 反重复铁律，与既有 concept 同档）、`teardown: 0.7`（八维精读取稳，与 architect 同档）。
6. overlay 文件路径 `<dataDir>/prompt-overlays/<role>.md`（文件式，**无需迁移**）。

**R45 安全（硬约束）**：新角色**绝不触碰写手 compose 路径**——写手 system 在同本书内逐字节恒定（prompts.ts:11-21 缓存纪律、ctx.ts:21 R45、pipeline-prompts.test.ts case4 钉）。idea/teardown 是独立 compose 函数，不进写手 system。

**无全局 mock（Explore 关键发现）**：本仓无 canned-response mock 模式，唯一无 Key 路径是真实本地 provider（ollama/lmstudio/custom）。故 idea/teardown 各自带**明示演示兜底**（无 Key/未配置 → 不联网，回退确定性演示产物，`live:false`），与扫榜演示兜底同口径，满足 DRD §5「无 Key 全流程可跑·演示数据明示」。测试经结构化 `PipelineLlm` 接口（tools.ts:38-44）注入 fake。

---

## 7. 接线 + 门禁（照 P2-B/ForeshadowView 既定模式）
- `src/shared/constants/modes.ts`：`WorkMode` 联合 +4（`trends`/`idea`/`teardown`/`topics`）+ `MODE_LABELS` 四字档（扫榜热榜/抽脑洞/拆书报告/选题库，184px 宽度账内）。
- `src/renderer/App.tsx`：NAV_GROUPS 灵感组 soon 项（:139-142 `soon-trends/brainstorm/teardown/topics`）→ `{kind:'mode'}`（icon path 原样保留）；import 四 view（:45 区）；modeHost 分派 `{mode==='trends' && <TrendingView/>}` 等（:583 区）；onRun `case 'mode:trends'` 等（:623 区）。
- `src/renderer/components/common/CommandPalette.tsx`：4 新 `{id:'mode:x', label:'切换到 X', group:'模式'}`（:74-89）。
- **soon 计数 6→2**：`tests/unit/p2ui-t4-smoke-fixes.test.ts:867` 钉（转正 4 项后剩 长期记忆/导出中心）。
- **shell-r1-wiring**：`tests/integration/shell-r1-wiring.test.ts:140-152` mode↔view 分派 + palette id 集 **16→20**；label 单一来源钉 :230-266。
- **SOLID_BUTTON_CENSUS** 棘轮：`p2ui-t4-smoke-fixes.test.ts:251/:418`，四页新实底按钮入册（级联感知负对照 R42 模式）。
- **IPC 四处齐改 + sentinel**：`shared/types/ipc.ts`(IpcInvokeMap+IPC_CHANNELS) / `preload/api.ts`(方法+INVOKE_CHANNELS) / `preload/index.ts` / `main/ipc/register.ts`，`tests/integration/pipeline-ipc-sentinel.test.ts:23` CH 数组同步加列（现 19 → +新通道）。新通道（草拟，writing-plans 定稿）：`trending:fetch`、`idea:draw`、`teardown:structure`、`teardown:read`、`teardown:save-dimension`、`inspiration:list`、`inspiration:collect`、`inspiration:remove`、`topic:list`、`topic:create-from-card`、`topic:promote`、`topic:abandon`（约 +12，invoke 80→~92；实测四处声明逐字相等再落文档，别抄预估）。
- tokens.css 单一来源；sequencer 竞态守卫；诚实空态；zod 校验收口 IPC 边界（DRD §5 质量守卫）。

---

## 8. 错误处理 + 诚实原则
- 扫榜抓取失败/被挡/改版/超时 → 如实报错（原则#6）+ 回落演示集（明示「演示数据」）；**绝不绕反爬、绝不编造热度**（F3 + DRD §7）。
- LLM 无 Key/未配置/401/超时 → 演示产物明示「演示」或直报真因，不拟人化（原则#6）。
- 拆书零token结构统计先行（原则#4），八维精读按需，不每次烧 token（DRD 反参照「不做每次检索都调 LLM」）。
- 立项失败（建 project / 播 premise）直报真因，topic 状态不误置。
- 所有「演示 / 实时 / 未精读 / 未登记」态明示标记，不虚报完成（DRD §5 质量守卫）。

---

## 9. 测试策略
- **shared 纯函数单测**：种子池（24 条、去重口径）、结构统计口径（若下沉 shared）、卡片 payload zod schema、premise 派生复用点。
- **Repo 单测**（真内存库 `new Database(':memory:')+migrate`）：三 Repo CRUD + 状态机单向 + 反重复 ideaHistory + v16 迁移钉（表存在/幂等/跨项目无关）。
- **抓取器单测**：注入 fake fetch，钉「礼貌」（缓存命中/限速/robots 拒绝路径）+ 解析失败→真因→演示兜底 + `live`/`demo` 标记 + **无反爬绕过**（负对照：不提供指纹/代理/CAPTCHA 钩子）。
- **新角色 prompt 单测**：composeIdeaPrompt/composeTeardownPrompt 形状 + overlay 附加 + **R45 负对照**（写手 system 字节不变）+ idea/teardown overlay 重复联合两处逐字相等钉。
- **IPC sentinel**：新通道四处齐改 + CH 数组同步。
- **接线钉**（源码扫描，R46 同型，本仓无 jsdom 组件测试设施）：四页 soon→mode、modeHost 分派、palette 命令、soon 计数 6→2、census 棘轮。
- **验收测试** `tests/integration/p2c-acceptance.test.ts`：四页端到端（真库）——扫榜演示兜底明示、抽脑洞反重复、拆书零token先行+八维按需+存灵感库、选题库三态互斥+立项播 premise 复用派生。
- 门禁：全量 `npm test`、coverage 只涨、三 tsconfig `node scripts/smoke.mjs`、`npm run lint` 0 错。

---

## 10. 任务拆分草图（writing-plans 细化为 bite-sized TDD 步骤）
- **T1 数据层**：v16 迁移（三表）+ 三 Repo + shared 卡片/topic 类型 + zod + IPC 通道（inspiration/topic 基础）+ sentinel + Repo 单测。
- **T2 扫榜热榜**：DataSource 接口 + LiveChartSource（礼貌抓取，无反爬）+ DemoChartSource + chart-demo 数据 + `trending:fetch` + TrendingView + 抓取器单测 + 接线。
- **T3 抽脑洞**：seed-pool（shared）+ composeIdeaPrompt 角色 + 演示兜底 + `idea:draw` + 反重复 + IdeaDrawView + prompt/反重复单测 + 接线。
- **T4 拆书报告**：复用 digest/analyze 零token结构统计 + composeTeardownPrompt 八维角色 + 演示兜底 + `teardown:structure/read/save-dimension` + TeardownView + 单测 + 接线。
- **T5 选题库**：TopicRepo 生命周期 + `topic:*` + 立项播 premise（复用 adopted-concept 派生）+ TopicLibraryView + 状态机/立项单测 + 接线。
- **T6 新角色 overlay 接线**：PromptOverlayRole/OverlayRole 重复联合同步 + OVERLAY_ROLES + TEMPERATURE + overlay 文件路径 + 重复联合 sentinel 钉（若 T3/T4 未含则并此）。
- **T7 装配/验收/文档**：p2c-acceptance 端到端 + soon 计数 6→2 + shell-r1 id 集 16→20 + census 棘轮 + PROJECT-STATUS/HANDOVER 入账（实测计数）+ SDD ledger 裁决。

依赖：T1 是 T2-T5 的数据底座；T6 与 T3/T4 角色定义耦合（可并入或紧随）；T7 收口。串行执行（同触 modes.ts/App.tsx/CommandPalette/sentinel/soon 计数）。

---

## 11. 全局约束（carry forward，每个任务隐含遵守）
- 迁移**只增不改**：v16 新表，旧迁移不碰；库列不加 CHECK，枚举收紧应用写侧。
- IPC 四处齐改铁律 + sentinel CH 数组同步；实测四处声明逐字相等再落文档。
- 正文只经 `ChapterRepo.updateBody` 写——本片**零正文写入**（拆书读粘贴/导入文本，不改在库正文）。
- **R45 写手 system 字节稳定**：新角色绝不进写手 compose 路径。
- 显示名唯一来源 `modes.ts`（WorkMode + MODE_LABELS，四字档）。
- 诚实原则：演示/实时/未精读/未登记全程明示，绝不编造热度/不虚报完成。
- 样式单一来源 tokens.css；新实底按钮进 SOLID_BUTTON_CENSUS 棘轮。
- 纯数据/纯函数下沉 `src/shared`（可 node 单测）；渲染接线用源码扫描钉（R46，无 jsdom 设施）。
- **扫榜责任边界（F3 硬约束）**：礼貌抓取（缓存/限速/robots/常规 UA），**绝无反爬绕过**（无 CAPTCHA 破解/指纹伪装/代理轮换）；被挡→如实报错+演示兜底。
- 测试命令：全量 `npm test`；单文件 `npm test -- <path>`（不带 run）；三 tsconfig `node scripts/smoke.mjs`；better-sqlite3 为 Electron ABI，bare node/npx vitest 会 ERR_DLOPEN（npm test 包装器设 ELECTRON_RUN_AS_NODE）。
- Git 身份只许 `git -c user.name=墨舟 -c user.email=mozhou@localhost commit`；**不 push、不 merge**（老板决定）。
- **禁止前台测试**（老板明令）：视觉取证只走 CDP 后台捕获（`--remote-debugging-port` + `Page.captureScreenshot`），不抢焦点不物理悬停；测试不写真实 %APPDATA% 库（走 `:memory:` 或 portable exe dataDir）。
- 许可红线：扫榜解析器/演示数据/角色提示词均**原创措辞**；拆书复用本仓自有 digest/metrics（非 AGPL WritingStudio 代码）；不移植任何商业项目逐字文本。

---

## 12. 不在本片（Out of Scope）
- 导演台灵感河左栏 + 拖拽立项（F1 延后，后续 GenView 增强片）。
- 长期记忆三栏（DRD §4.3，资产线，非灵感线；仍 soon）。
- 风格卡库 / 模板中心（DRD §4.3 灵感组另两项，本片只做导航既列的四页）。
- 导出中心 / 发布排期（= P2-D）。
- 扫榜反爬绕过 / 真实榜单 API 采购（F3 责任边界外）。
- 拆书 LCS 合规守卫之外的版权内容存储（拆书只存结构统计 + 八维摘要，不整本复制范文）。

---

## 13. 复用地图（Explore 实测，writing-plans 据此接线）
| 能力 | 复用点 | file:line |
|---|---|---|
| LLM 调用 | `LlmClient.chat(req)` | `src/main/llm/client.ts:121`；ChatRequest `src/shared/types/provider.ts:109-124` |
| 角色注入 fake | 结构化 `PipelineLlm` 接口 | `src/main/pipeline/tools.ts:38-44` |
| 角色 prompt + overlay | `composeConceptPrompt`/`withOverlay` | `src/main/pipeline/prompts.ts:121/:34-38` |
| overlay 角色注册面 | PromptOverlayRole / OverlayRole / OVERLAY_ROLES / TEMPERATURE | `overlay.ts:26` / `ipc.ts:381` / `overlay-ipc.ts:37` / `tools.ts:85` |
| 写手字节稳定（勿碰） | 缓存纪律 + R45 | `prompts.ts:11-21` / `ctx.ts:21` / `pipeline-prompts.test.ts` case4 |
| 项目创建 | `project:open`→`openProject`→`ProjectRepo.create` | `ipc.ts:97` / `services.ts:144-183` / `chapter-repo.ts:471-480` |
| premise 派生（套用播种复用） | `premise ← adopted concept logline` | `ctx.ts:110-111` |
| 立项参数 | `project:set-gen`→`setPipelineParams` | `GenView.tsx:218` / `register.ts:207-232` / `chapter-repo.ts:554-576` |
| 零token拆书（复用！） | `distillReferenceWork` + hooks/roles/kb/LCS | `src/main/tools/impl/digest.ts:50/:149-190/:194/:213/:263` |
| 结构统计（复用！） | `analyze(text): AnalyzeResult` | `src/shared/metrics-engine.ts:119-181` |
| 草稿状态机（立项播种复用） | `DraftRepo.insert/setStatus('adopted')` | `src/main/db/repos/draft-repo.ts:44/:83-95` |
| Repo 形状 | DraftRepo / LedgerRepo | `draft-repo.ts:40-41` / `ledger-repo.ts:67-68` |
| 迁移模式 | `MIGRATIONS[]`，最新 v15 | `src/main/db/migrate.ts:9-15/:529-563` |
| mode 页接线模板 | ForeshadowView 端到端 | `modes.ts:22/:30-42` / `App.tsx:139-142/:583/:623` / `CommandPalette.tsx:74-89` |
| 门禁钉 | soon=6 / census / shell-r1 id=16 / sentinel CH=19 | `p2ui-t4-smoke-fixes.test.ts:867/:251/:418` / `shell-r1-wiring.test.ts:140-152` / `pipeline-ipc-sentinel.test.ts:23` |
