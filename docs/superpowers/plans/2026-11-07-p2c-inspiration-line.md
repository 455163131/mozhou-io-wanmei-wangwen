# P2-C 灵感线四页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DRD §4.3 的扫榜热榜 / 抽脑洞 / 拆书报告 / 选题库四个「设计中」占位落成真实 mode 页，配「卡片→收藏/灵感库→选题库→立项」回流主线。

**Architecture:** 灵感线是**全局（跨书）子系统**——新表不带 project_id（选题在「已立项」态才链 project）。复用既有引擎：拆书零token结构统计直接调 `digest.ts:distillReferenceWork`+`metrics-engine.ts:analyze()`；立项播 premise 走新增 `projects.premise` 列（见 PD-1）；四页接线照 ForeshadowView/CharacterView 既定模式。新增「脑洞生成」「拆书八维」两个 LLM 角色进 overlay 体系，**绝不触碰写手 system 字节稳定（R45）**；扫榜礼貌直抓公开榜单页 + 演示兜底，**绝无反爬绕过**（F3 硬约束）。

**Tech Stack:** Electron 33 + React 18 + Zustand + better-sqlite3 + zod + vitest；纯数据/纯函数放 `src/shared`（node 环境可直接单测）。

**Spec:** `docs/superpowers/specs/2026-11-07-p2c-inspiration-line-design.md`（本文据其细化；执行者同时读 spec 与本文）。DRD：`C:\Users\Administrator\Documents\Qoder\2026-11-03\cfab122c\output\墨书写作坊重设计\strategize\drd.md` §3.2/§4.2①/§4.3/§7。

**Repo:** `C:\Users\Administrator\WorkBuddy\2026-10-07-19-01-04\MozhouAgent`，分支 `p2c-inspiration-line`，基线 master `5e0e692`（spec commit `23bb320`）。

## Global Constraints

- 迁移**只增不改**：v16 建三灵感表、v17 加 `projects.premise` 列；旧迁移不碰；库列不加 CHECK，枚举收紧在应用写侧（v14 language 同口径）。
- IPC 四处齐改铁律：`shared/types/ipc.ts`（IpcInvokeMap + IPC_CHANNELS）、`preload/api.ts`（方法 + INVOKE_CHANNELS）、`preload/index.ts`、`main/ipc/register.ts`（`handle('…')`），且 `tests/integration/pipeline-ipc-sentinel.test.ts:23` 的 `CH` 数组同步加列（现 19 条 → 本片 +12 = 31；invoke 80 → 92，**实测四处声明逐字相等再落文档，别抄本计划预估**）。
- 正文只经 `ChapterRepo.updateBody` 写——本片**零正文写入**（拆书读粘贴/导入文本，不改在库正文）。
- **R45 写手 system 字节稳定**：新角色 idea/teardown 是独立 compose 函数，**绝不进写手 compose 路径**（prompts.ts:11-21 缓存纪律、ctx.ts:21、pipeline-prompts.test.ts case4 钉）。
- 显示名唯一来源 `src/shared/constants/modes.ts`：新 mode 进 `WorkMode` 联合 + `MODE_LABELS`，label 四字档（扫榜热榜/抽脑洞/拆书报告/选题库，184px 宽度账内）。
- **诚实原则**：演示/实时/未精读/未登记全程明示标记；扫榜热度数字仅在有据时显示，**绝不编造**（DRD §7「拒绝无依据的热度数字」）；失败直报真因（原则#6），不拟人化。
- **扫榜责任边界（F3 硬约束，不可越）**：礼貌抓取（缓存 + 限速 + robots.txt 尊重 + 常规 UA）；**绝无反爬绕过**（无 CAPTCHA 破解、无指纹伪装、无代理轮换）；被挡/改版/超时 → 如实报错 + 回落演示集（明示「演示数据」）。
- 样式单一来源 tokens.css；新增实底按钮进 SOLID_BUTTON_CENSUS 棘轮（级联感知负对照 R42 模式）。
- 纯数据/纯函数下沉 `src/shared`（种子池、卡片/topic zod schema、结构统计口径）；渲染接线用源码扫描钉（R46，本仓无 jsdom 组件测试设施）。
- 无全局 LLM mock：idea/teardown 各带**明示「演示」的确定性兜底**（无 Key/未配置 → 不联网，回退演示产物，`live:false`），测试经 `PipelineLlm` 结构化接口（tools.ts:38-44）注入 fake。
- 测试命令：全量 `npm test`；单文件 `npm test -- <path>`（**不带 run**）；三 tsconfig `node scripts/smoke.mjs`；better-sqlite3 为 Electron ABI，bare node/npx vitest 会 ERR_DLOPEN（npm test 包装器设 ELECTRON_RUN_AS_NODE）。
- Git 身份只许 `git -c user.name=墨舟 -c user.email=mozhou@localhost commit`；**不 push、不 merge**（老板决定）。
- **禁止前台测试**（老板明令）：视觉取证只走 CDP 后台捕获（`--remote-debugging-port` + `Page.captureScreenshot`），不抢焦点不物理悬停；测试不写真实 %APPDATA% 库（走 `:memory:` 或 portable exe dataDir）。
- 许可红线：扫榜解析器/演示数据/角色提示词/种子池均**原创措辞**；拆书复用本仓自有 digest/metrics（非 AGPL WritingStudio 代码）；不移植任何商业项目逐字文本。

## 规划裁决（PD）

**PD-1（premise 播种改走新列，覆盖 spec §4.4 的「已采纳构思草稿」法）**：spec 原议「立项时写一条 adopted concept 草稿、复用 ctx premise←concept.logline 派生、不加列」。读码后发现该法有副作用——`ConceptSchema` 要求 titles/synopsis/goldenFinger/hooks 等字段，播一条假 adopted concept 会在 GenView 草稿列表里露出伪造草稿、并以空字段喂架构师/写手。而 ctx.ts:110 注释本就写「premise 尚无独立入口」，DRD §4.2① 立项表单把「一句话故事」列为一等输入。故改为 **v17 `ALTER TABLE projects ADD COLUMN premise TEXT NOT NULL DEFAULT ''`**（与 v12/v14 对 projects 的 ALTER 同型）+ `ProjectRepo.setPremise/getPremise` + ctx.ts:111 改 `premise: projPremise || concept?.logline || ''`（空列回退 logline，**既有书向后兼容、写手 system 字节稳定不破**——premise 是书级常量，立项时设一次）。*代价若错：多一列 + 改 ctx 一行 + Project 读侧；比伪造草稿干净且补上 DRD 的「一句话故事独立入口」缺口。* **此裁决在计划批准门向老板显式标注。**

## 文件结构（新建/改动一览）

**新建（src/main）**：`inspiration/chart-source.ts`（DataSource 接口 + LiveChartSource 礼貌抓取）、`inspiration/chart-demo.ts`（演示集）、`inspiration/chart-parse.ts`（三平台解析器，纯函数可测）、`inspiration/idea-service.ts`（脑洞抽取 + 反重复 + 演示兜底）、`inspiration/teardown-service.ts`（结构统计复用 + 八维精读 + 演示兜底）、`inspiration/topic-service.ts`（选题库生命周期 + 立项播 premise）、`db/repos/inspiration-repo.ts`、`db/repos/topic-repo.ts`、`db/repos/teardown-repo.ts`。
**新建（src/shared）**：`types/inspiration.ts`（InspirationCard/Topic/TeardownReport/ChartEntry/IdeaOut/TeardownDims + zod）、`inspiration/seed-pool.ts`（24 方向，纯数据）。
**新建（src/renderer）**：`components/views/TrendingView.tsx`+`.module.css`、`IdeaDrawView.tsx`+`.module.css`、`TeardownView.tsx`+`.module.css`、`TopicLibraryView.tsx`+`.module.css`。
**新建（tests）**：`unit/inspiration-repo.test.ts`、`unit/topic-repo.test.ts`、`unit/teardown-repo.test.ts`、`unit/chart-source.test.ts`、`unit/chart-parse.test.ts`、`unit/seed-pool.test.ts`、`unit/idea-service.test.ts`、`unit/teardown-service.test.ts`、`unit/inspiration-overlay-roles.test.ts`、`integration/p2c-acceptance.test.ts`；改动 `integration/pipeline-ipc-sentinel.test.ts`、`integration/shell-r1-wiring.test.ts`、`unit/p2ui-t4-smoke-fixes.test.ts`（soon 计数 + census）。
**改动（既有）**：`db/migrate.ts`（v16+v17）、`db/repos/chapter-repo.ts`（ProjectRepo.setPremise/getPremise + pipelineParams 含 premise）、`pipeline/ctx.ts`（premise 派生 PD-1）、`pipeline/prompts.ts`（composeIdeaPrompt/composeTeardownPrompt）、`pipeline/overlay.ts`（PromptOverlayRole +idea+teardown）、`pipeline/overlay-ipc.ts`（OVERLAY_ROLES）、`pipeline/tools.ts`（TEMPERATURE +idea+teardown）、`shared/types/ipc.ts`（OverlayRole 联合 + 12 通道 + IPC_CHANNELS）、`preload/api.ts`、`preload/index.ts`、`main/ipc/register.ts`、`main/services.ts`（注册新 handler 依赖）、`shared/constants/modes.ts`、`renderer/App.tsx`、`renderer/components/common/CommandPalette.tsx`、`docs/PROJECT-STATUS.md`、`docs/HANDOVER-P0.md`。

## 预检（任务间文件交集 → 串并行）

- **T1** 数据层独占（migrate v16 + 3 repos + shared types），与其余零交集，可先行。
- **T3/T4/T5/T6** 各加一 mode：同触 `modes.ts`(WorkMode+MODE_LABELS)、`App.tsx`(NAV_GROUPS 灵感组 soon→mode + modeHost 分派 + onRun case)、`CommandPalette.tsx`(mode:* 命令)、`p2ui-t4-smoke-fixes.test.ts:867`(soon 计数 6→5→4→3→2)、`shell-r1-wiring.test.ts:140-152`(id 集 16→17→18→19→20)。**必须串行**，每任务把自己那项 soon 转正 + 同步两处计数钉。
- **T4/T5** 同触 overlay 角色注册面（`overlay.ts:PromptOverlayRole`、`ipc.ts:OverlayRole` 重复联合、`overlay-ipc.ts:OVERLAY_ROLES`、`tools.ts:TEMPERATURE`、`prompts.ts`）。串行（T4 加 idea 并立重复联合 sentinel 钉，T5 加 teardown 扩之）。
- **T2** 扫榜后端（chart-source/demo/parse + trending:fetch + inspiration collect/list/remove + topic:create-from-card 通道）→ **T3** 消费之。T2 先于 T3。
- **T6** 立项依赖 T1 的 TopicRepo + v17 premise 列 + ctx 改造；消费 T3/T4/T5 产出的卡片（topic:create-from-card 在 T2 开通道，T6 实装 promote）。
- **T7** 收口依赖 T1-T6 全部落地。
- 执行序：**T1 → T2 → T3 → T4 → T5 → T6 → T7**（全串行；灵感组 soon 计数与 overlay 角色面是串行约束源）。

---

### Task 1: 数据层（v16 三灵感表 + 三 Repo + shared 类型）

**Files:**
- Modify: `src/main/db/migrate.ts`（MIGRATIONS 末尾加 v16，现最新 v15 在 :529-563）
- Create: `src/shared/types/inspiration.ts`
- Create: `src/main/db/repos/inspiration-repo.ts`、`src/main/db/repos/topic-repo.ts`、`src/main/db/repos/teardown-repo.ts`
- Test: `tests/unit/inspiration-repo.test.ts`、`tests/unit/topic-repo.test.ts`、`tests/unit/teardown-repo.test.ts`

**Interfaces:**
- Consumes: `Migration`/`MIGRATIONS`/`migrate`/`currentVersion`（migrate.ts:9-15/566/581）；`MzError`（@shared/types/ipc）；DraftRepo 形状（draft-repo.ts:40-105，生成式 id + 单向状态机模板）。
- Produces:
  - 类型（`@shared/types/inspiration`）：`CardKind='trend'|'idea'|'teardown'`；`TopicStatus='待立项'|'已立项'|'已放弃'`；`InspirationCard{id,kind,title,payload,sourceLabel,collected,createdAt}`；`Topic{id,title,premise,status,projectId:string|null,sourceCardId:string|null,createdAt,updatedAt}`；`TeardownReport{id,bookTitle,structure,dimensions:TeardownDims|null,createdAt}`；payload zod：`TrendPayloadSchema`/`IdeaPayloadSchema`/`TeardownPayloadSchema`（形状见 spec §3.4）。
  - `InspirationRepo`：`insert(c:{kind,title,payload,sourceLabel}):InspirationCard`、`listByKind(kind):InspirationCard[]`、`listCollected():InspirationCard[]`、`setCollected(id,boolean):InspirationCard`、`remove(id):boolean`、`get(id):InspirationCard|null`、`ideaHistory():{direction:string;premise:string}[]`（反重复用，取 kind='idea' 的 payload.direction+premise）。
  - `TopicRepo`：`insert(t:{title,premise,sourceCardId?:string|null}):Topic`（默认 status='待立项'）、`listByStatus(s?:TopicStatus):Topic[]`、`get(id):Topic|null`、`setStatus(id,s:TopicStatus):Topic`（单向：待立项→已立项|已放弃；终态再转抛 `E_TOPIC_STATE`）、`linkProject(id,projectId):Topic`。
  - `TeardownRepo`：`insert(r:{bookTitle,structure}):TeardownReport`、`get(id)`、`list():TeardownReport[]`、`setDimensions(id,dims:TeardownDims):TeardownReport`。

- [ ] **Step 1: 写失败测试（三 Repo + v16 迁移）**

```ts
// tests/unit/topic-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { TopicRepo } from '@main/db/repos/topic-repo';

let db: ReturnType<typeof Database>;
let repo: TopicRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new TopicRepo(db); });

describe('v16 迁移 + TopicRepo', () => {
  it('v16 后 topics 表存在且 user_version>=16', () => {
    expect(currentVersion(db)).toBeGreaterThanOrEqual(16);
    const cols = db.prepare("PRAGMA table_info('topics')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['id', 'title', 'premise', 'status', 'project_id', 'source_card_id', 'created_at', 'updated_at']),
    );
  });
  it('insert 默认待立项；listByStatus 过滤；新在前', () => {
    const a = repo.insert({ title: 'A', premise: '一句话A' });
    const b = repo.insert({ title: 'B', premise: '一句话B' });
    expect(a.status).toBe('待立项');
    expect(repo.listByStatus('待立项').map((t) => t.title)).toEqual(['B', 'A']);
  });
  it('状态机单向：待立项→已立项 ok；已立项→已放弃 抛 E_TOPIC_STATE', () => {
    const t = repo.insert({ title: 'C', premise: 'p' });
    expect(repo.setStatus(t.id, '已立项').status).toBe('已立项');
    expect(() => repo.setStatus(t.id, '已放弃')).toThrowError(/E_TOPIC_STATE|不允许/);
  });
  it('linkProject 写 project_id 并回读', () => {
    const t = repo.insert({ title: 'D', premise: 'p' });
    expect(repo.linkProject(t.id, 'proj-x').projectId).toBe('proj-x');
  });
});
```

```ts
// tests/unit/inspiration-repo.test.ts —— 卡片 CRUD + collected + 反重复历史
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';

let db: ReturnType<typeof Database>;
let repo: InspirationRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new InspirationRepo(db); });

describe('InspirationRepo', () => {
  it('insert 落库 collected=0；listByKind 只回该 kind', () => {
    repo.insert({ kind: 'trend', title: '书1', payload: { platform: '番茄', live: false }, sourceLabel: '番茄' });
    repo.insert({ kind: 'idea', title: '脑洞1', payload: { direction: '重生复仇', premise: 'p', temperature: 1.05, live: false }, sourceLabel: '重生复仇' });
    expect(repo.listByKind('trend')).toHaveLength(1);
    expect(repo.listByKind('idea')).toHaveLength(1);
    expect(repo.listByKind('trend')[0].collected).toBe(0);
  });
  it('setCollected 翻转收藏；listCollected 只回已收藏', () => {
    const c = repo.insert({ kind: 'trend', title: '书2', payload: { platform: '晋江', live: true }, sourceLabel: '晋江' });
    repo.setCollected(c.id, true);
    expect(repo.listCollected().map((x) => x.id)).toEqual([c.id]);
  });
  it('ideaHistory 回 direction+premise 摘要（反重复用）', () => {
    repo.insert({ kind: 'idea', title: 'i', payload: { direction: '系统流', premise: '觉醒系统', temperature: 1.05, live: true }, sourceLabel: '系统流' });
    expect(repo.ideaHistory()).toEqual([{ direction: '系统流', premise: '觉醒系统' }]);
  });
  it('remove 存在回 true 不存在回 false', () => {
    const c = repo.insert({ kind: 'teardown', title: '维', payload: { dimension: '节奏', summary: 's', bookTitle: 'b', reportId: 'r' }, sourceLabel: 'b' });
    expect(repo.remove(c.id)).toBe(true);
    expect(repo.remove('nope')).toBe(false);
  });
});
```

```ts
// tests/unit/teardown-repo.test.ts —— 报告 insert/get/list + setDimensions
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { TeardownRepo } from '@main/db/repos/teardown-repo';

let db: ReturnType<typeof Database>;
let repo: TeardownRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new TeardownRepo(db); });

describe('TeardownRepo', () => {
  it('insert 落 structure，dimensions 初始 null', () => {
    const r = repo.insert({ bookTitle: '范文', structure: { bench: { chars: 100 } } });
    expect(r.dimensions).toBeNull();
    expect(repo.get(r.id)?.bookTitle).toBe('范文');
  });
  it('setDimensions 写八维并回读', () => {
    const r = repo.insert({ bookTitle: '范文', structure: {} });
    const dims = { 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' };
    expect(repo.setDimensions(r.id, dims).dimensions).toEqual(dims);
  });
});
```

- [ ] **Step 2: 跑红** — `npm test -- tests/unit/topic-repo.test.ts tests/unit/inspiration-repo.test.ts tests/unit/teardown-repo.test.ts`，预期 FAIL（表/repo 未定义）。

- [ ] **Step 3: 实现**
  - `src/shared/types/inspiration.ts`：导出上述类型 + zod schema。payload 用 `z.object` 按 kind：`TrendPayloadSchema=z.object({platform:z.string(),author:z.string().optional(),heat:z.number().optional(),rank:z.number().optional(),tags:z.array(z.string()).optional(),url:z.string().optional(),live:z.boolean()})`；`IdeaPayloadSchema=z.object({direction:z.string(),premise:z.string(),hook:z.string().optional(),genre:z.string().optional(),temperature:z.number(),live:z.boolean()})`；`TeardownPayloadSchema=z.object({dimension:z.string(),summary:z.string(),bookTitle:z.string(),reportId:z.string()})`。`TeardownDims=z.object({定位:z.string(),结构:z.string(),节奏:z.string(),爽点钩子:z.string(),伏笔:z.string(),人物:z.string(),文风:z.string(),可借鉴:z.string()})`（导出 `TeardownDims` 类型 = `z.infer`）。`structure` 列存 `unknown`（JSON），类型 `TeardownReport.structure: unknown`。
  - `migrate.ts` v16（接 v15 后，:563 之前插一项）：`{version:16,name:'add_inspiration_tables',up(db){db.exec(\`CREATE TABLE IF NOT EXISTS inspiration_cards(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,payload TEXT NOT NULL,source_label TEXT NOT NULL,collected INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_insp_kind ON inspiration_cards(kind,created_at); CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,title TEXT NOT NULL,premise TEXT NOT NULL,status TEXT NOT NULL,project_id TEXT,source_card_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_topic_status ON topics(status,updated_at); CREATE TABLE IF NOT EXISTS teardown_reports(id TEXT PRIMARY KEY,book_title TEXT NOT NULL,structure_json TEXT NOT NULL,dimensions_json TEXT,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_teardown_created ON teardown_reports(created_at);\`)}}`。注释镜像 v15 风格（全局子系统不带 project_id 的理由、不加 CHECK 口径同 v14）。`created_at` 用 TEXT（ISO）或 INTEGER（Date.now()）——**统一用 INTEGER**（与 drafts/ledger 同口径），类型 createdAt:number；测试断言相应调整（上面测试未钉 created_at 类型，实现取 INTEGER）。
  - 三 Repo：照 DraftRepo 形状（`constructor(private readonly db:Database){}`、生成式 id `ic-`/`tp-`/`td-` 前缀 + `Date.now().toString(36)` + 随机、裸 SQL prepare、toX 行映射、JSON 列 parse/stringify）。`TopicRepo.setStatus` 单向校验照 DraftRepo.setStatus（draft-repo.ts:87-95）：仅 `待立项→已立项|已放弃`，否则抛 `new MzError('E_TOPIC_STATE', …)`；`linkProject` 仅 update project_id。`InspirationRepo.ideaHistory` 查 `kind='idea'` 行、parse payload、map 出 {direction,premise}。
  - 注：`E_TOPIC_STATE` 是新错误码——若 `ToolErrorCode`/`MzError` code 联合是封闭集，需在 `@shared/types/ipc` 或 tool 错误码处加该码（实现时查 MzError 构造签名，若 code 是 string 则无需改类型）。

- [ ] **Step 4: 跑绿** — 同 Step 2 命令，预期 PASS；再 `npm test`（全量）确认 v16 不破坏 upgrade-realdb-smoke 等既有迁移测试。

- [ ] **Step 5: 提交** — `git -c user.name=墨舟 -c user.email=mozhou@localhost commit -m "feat(inspiration): v16 三灵感表 + 卡片/选题/拆书 Repo + shared 类型"`

---

### Task 2: 扫榜后端（DataSource + 礼貌直抓 + 演示兜底 + 通道）

**Files:**
- Create: `src/main/inspiration/chart-source.ts`、`src/main/inspiration/chart-demo.ts`、`src/main/inspiration/chart-parse.ts`
- Modify: `src/shared/types/inspiration.ts`（加 `ChartEntry`/`Platform`）、`src/shared/types/ipc.ts`、`src/preload/api.ts`、`src/preload/index.ts`、`src/main/ipc/register.ts`、`src/main/services.ts`
- Test: `tests/unit/chart-parse.test.ts`、`tests/unit/chart-source.test.ts`、改动 `tests/integration/pipeline-ipc-sentinel.test.ts`

**Interfaces:**
- Consumes: T1 `InspirationRepo`；`MzError`。
- Produces:
  - `Platform='番茄'|'晋江'|'起点'`；`ChartEntry{rank:number;title:string;author:string;platform:Platform;heat:number|null;tags:string[];url:string;live:boolean}`（`heat:null`=无据不编造；`live`=实时/演示标记）。
  - `ChartFetchResult{entries:ChartEntry[];source:'live'|'demo';error?:string}`。
  - `interface ChartDataSource{fetch(platform:Platform,opts?:{signal?:AbortSignal}):Promise<ChartFetchResult>}`。
  - `parseChartHtml(platform:Platform,html:string):ChartEntry[]`（纯函数，抛真因于解析失败）。
  - `DEMO_CHARTS:Record<Platform,ChartEntry[]>`（chart-demo.ts，全部 `live:false`）。
  - `LiveChartSource implements ChartDataSource`（构造吃 `{fetchImpl?,now?,cacheTtlMs?,robotsChecker?}` 便于注入测试）；`DemoChartSource implements ChartDataSource`；`makeChartSource(deps):ChartDataSource`（live 优先、失败回落 demo 并带 error）。
  - IPC：`trending:fetch(platform):ChartFetchResult`、`inspiration:list(kind?):InspirationCard[]`、`inspiration:collect(cardId):InspirationCard`、`inspiration:remove(cardId):boolean`、`topic:create-from-card(cardId):Topic`（套用入口，落待立项 topic）。

- [ ] **Step 1: 写失败测试（解析纯函数 + 礼貌/兜底/无反爬）**

```ts
// tests/unit/chart-parse.test.ts
import { describe, it, expect } from 'vitest';
import { parseChartHtml } from '@main/inspiration/chart-parse';

describe('parseChartHtml', () => {
  it('番茄榜单 HTML 解析出条目（rank/title/author，heat 无据则 null）', () => {
    const html = `<div class="rank-item"><span class="num">1</span><a href="/book/1">测试书名</a><span class="author">作者甲</span></div>`;
    const out = parseChartHtml('番茄', html);
    expect(out[0]).toMatchObject({ rank: 1, title: '测试书名', author: '作者甲', platform: '番茄', live: true });
    expect(out[0].heat).toBeNull(); // 页面无热度数字 → null，绝不编造
  });
  it('无法识别的结构 → 抛真因（不静默回空）', () => {
    expect(() => parseChartHtml('晋江', '<html>无关</html>')).toThrowError(/解析|未识别|榜单/);
  });
});
```

```ts
// tests/unit/chart-source.test.ts —— 礼貌 + 演示兜底 + 无反爬负对照
import { describe, it, expect, vi } from 'vitest';
import { LiveChartSource, DemoChartSource, makeChartSource } from '@main/inspiration/chart-source';

describe('ChartSource', () => {
  it('DemoChartSource 回演示集且 source=demo、live=false', async () => {
    const r = await new DemoChartSource().fetch('番茄');
    expect(r.source).toBe('demo');
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.every((e) => e.live === false)).toBe(true);
  });
  it('LiveChartSource 命中缓存不二次 fetch（限速/缓存）', async () => {
    const fetchImpl = vi.fn(async () => new Response('<div class="rank-item"><span class="num">1</span><a href="/b/1">书名</a><span class="author">甲</span></div>', { status: 200 }));
    const src = new LiveChartSource({ fetchImpl: fetchImpl as unknown as typeof fetch, cacheTtlMs: 60_000 });
    await src.fetch('番茄'); await src.fetch('番茄');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('robots 禁止 → 不抓取，回落演示并带 error（礼貌）', async () => {
    const fetchImpl = vi.fn();
    const src = new LiveChartSource({ fetchImpl: fetchImpl as unknown as typeof fetch, robotsChecker: async () => false });
    const r = await src.fetch('起点');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.source).toBe('demo');
    expect(r.error).toMatch(/robots|禁止/);
  });
  it('抓取抛错/非200 → makeChartSource 回落 demo + error 直报真因（不编造）', async () => {
    const live = { fetch: async () => { throw new Error('ECONNREFUSED'); } };
    const src = makeChartSource({ live: live as never, demo: new DemoChartSource() });
    const r = await src.fetch('晋江');
    expect(r.source).toBe('demo');
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
  it('无反爬绕过负对照：源码不含指纹伪装/代理轮换/CAPTCHA 钩子', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main/inspiration/chart-source.ts', 'utf8');
    expect(src).not.toMatch(/captcha|solveCaptcha|fingerprint|spoof|proxyPool|rotateProxy|stealth/i);
  });
});
```

- [ ] **Step 2: 跑红** — `npm test -- tests/unit/chart-parse.test.ts tests/unit/chart-source.test.ts`，预期 FAIL（模块未定义）。

- [ ] **Step 3: 实现**
  - `chart-parse.ts`：`parseChartHtml(platform,html)` 三平台各一套选择器/正则（**原创解析，措辞自写**），抽 rank/title/author/url/tags；**heat 仅在页面确有可信热度数字时填，否则 null**（DRD §7）；识别不出任何条目 → 抛 `Error('榜单解析失败：<platform> 未识别到条目')`（不静默回空，原则#6）。纯函数，不碰网络。
  - `chart-demo.ts`：`DEMO_CHARTS` 三平台各 ~9 条**原创虚构**演示条目（书名/作者全原创，`live:false`，heat 给明示演示数值或 null），文件头注释标「演示数据·非真实榜单·DRD §7 不虚报」。
  - `chart-source.ts`：`ChartDataSource` 接口；`DemoChartSource.fetch` 回 `{entries:DEMO_CHARTS[platform],source:'demo'}`；`LiveChartSource` 构造注入 `{fetchImpl=globalThis.fetch, now=Date.now, cacheTtlMs=300_000, robotsChecker}`——fetch 前查 robots（`robotsChecker(url)` 默认实现拉 `/robots.txt` 判 Disallow，注入可覆写）、查内存缓存（TTL 内不重抓）、限速（同平台最小间隔，简单 last-fetch 时间戳守卫）、常规 UA（**不伪装指纹**）；解析失败/非200/被挡 → 抛真因。`makeChartSource({live,demo})`：try live → 失败 catch 真因 → 回 `{...demo结果, source:'demo', error:String(err)}`。**全程无 CAPTCHA/指纹/代理绕过**（F3）。
  - IPC 四处齐改 + sentinel：`trending:fetch`/`inspiration:list`/`inspiration:collect`/`inspiration:remove`/`topic:create-from-card` 五通道。`register.ts` handler：`trending:fetch`→`makeChartSource(...).fetch(platform)`（source 由 services 注入，见下）；`inspiration:*`→`new InspirationRepo(db)` 对应方法；`topic:create-from-card`→读卡 payload 取 title/premise → `new TopicRepo(db).insert({title,premise,sourceCardId:cardId})`（premise：trend 卡用 `书名＋tags`，idea 卡用 payload.premise，teardown 卡用 summary——实现按 kind 取）。`services.ts` 注入 chart source（生产 `makeChartSource({live:new LiveChartSource(),demo:new DemoChartSource()})`）。`pipeline-ipc-sentinel.test.ts:23` CH 数组 += 这 5 通道（19→24）。
  - zod：`trending:fetch` 入参 platform 过 `z.enum(['番茄','晋江','起点'])`；`topic:create-from-card` 入参 cardId string。

- [ ] **Step 4: 跑绿** — Step 2 命令 PASS；`npm test -- tests/integration/pipeline-ipc-sentinel.test.ts` PASS（CH=24，四处声明含 5 新通道）；`node scripts/smoke.mjs` 3/3。

- [ ] **Step 5: 提交** — `git -c … commit -m "feat(inspiration): 扫榜后端——礼貌直抓(无反爬)+演示兜底+解析纯函数+5通道"`

---

### Task 3: 扫榜热榜页（TrendingView + trends mode 接线 + 收藏/套用）

**Files:**
- Create: `src/renderer/components/views/TrendingView.tsx`、`TrendingView.module.css`
- Modify: `src/shared/constants/modes.ts`、`src/renderer/App.tsx`、`src/renderer/components/common/CommandPalette.tsx`、`tests/unit/p2ui-t4-smoke-fixes.test.ts`（soon 6→5 + census）、`tests/integration/shell-r1-wiring.test.ts`（id 16→17）
- Test: 改动上述两钉文件（源码扫描钉，R46）

**Interfaces:**
- Consumes: T2 `trending:fetch`/`inspiration:collect`/`topic:create-from-card` 通道（经 `bridge()`）；`createSequencer`（renderer/lib/sequenced）；`ChartEntry`/`ChartFetchResult` 类型；ForeshadowView 接线模式（modes/App/CommandPalette/soon 计数/census）。
- Produces: `WorkMode` 含 `'trends'`；`MODE_LABELS.trends='扫榜热榜'`；TrendingView 组件。

- [ ] **Step 1: 写失败测试（接线钉，照 foreshadow-view-wiring.test.ts 同型）**

```ts
// tests/integration/trending-view-wiring.test.ts（新建，源码扫描钉）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/TrendingView.tsx', 'utf8');

describe('扫榜热榜页接线', () => {
  it('modes.ts 注册 trends + 四字 label', () => {
    expect(modes).toMatch(/'trends'/);
    expect(modes).toMatch(/trends:\s*'扫榜热榜'/);
  });
  it('App.tsx 灵感组 soon-trends 转正为 mode 且分派 TrendingView', () => {
    expect(app).not.toMatch(/soon-trends/);           // soon 占位已移除
    expect(app).toMatch(/id:\s*'trends'/);
    expect(app).toMatch(/mode\s*===\s*'trends'\s*&&\s*<TrendingView/);
    expect(app).toMatch(/case\s*'mode:trends'/);
  });
  it('CommandPalette 有 mode:trends 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:trends'/);
  });
  it('TrendingView 走 sequencer + 演示/实时明示 + 收藏/套用', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/演示数据|实时/);            // 数据态徽标
    expect(view).toMatch(/inspiration\.collect|collect/);
    expect(view).toMatch(/createTopicFromCard|套用/);
  });
});
```

```ts
// 改 tests/unit/p2ui-t4-smoke-fixes.test.ts:867 soon 计数 6→5（扫榜热榜转正）
// 改 tests/integration/shell-r1-wiring.test.ts:140-152 mode id 集 16→17（加 trends）
```

- [ ] **Step 2: 跑红** — `npm test -- tests/integration/trending-view-wiring.test.ts tests/unit/p2ui-t4-smoke-fixes.test.ts tests/integration/shell-r1-wiring.test.ts`，预期 FAIL。

- [ ] **Step 3: 实现**
  - `modes.ts`：`WorkMode` 联合 + `| 'trends'`；`MODE_LABELS` + `trends:'扫榜热榜'`（四字档）。
  - `App.tsx`：NAV_GROUPS 灵感组 `{kind:'soon',id:'soon-trends',…}`（:139）→ `{kind:'mode',id:'trends',label:MODE_LABELS.trends,d:<原 icon path 原样保留>}`；顶部 import TrendingView（:45 区）；modeHost 加 `{mode==='trends' && <TrendingView/>}`（:583 区）；onRun 加 `case 'mode:trends': setMode('trends'); break;`（:623 区）。
  - `CommandPalette.tsx`：COMMANDS + `{id:'mode:trends',label:\`切换到 ${MODE_LABELS.trends}\`,group:'模式',alias:'sao bang re bang'}`（:74-89 区）。
  - `TrendingView.tsx`（照 ForeshadowView 结构）：平台 Tab（番茄/晋江/起点）→ 切换即 `bridge().trending.fetch(platform)`（sequencer 守卫，旧响应作废）；顶部数据态徽标（`result.source==='live'?'实时':'演示数据'`，error 时显真因 + 「已回落演示」）；3×3 书卡网格（rank/title/author/heat——`heat===null` 显「热度未提供」不编造/tags）；每卡「收藏」（`inspiration.collect`）+「套用」（`topic.createFromCard` → 提示已入选题库待立项）；`.module.css` 全走 tokens.css 变量（墨蓝底/香槟金 CTA/青色数据，DRD §4.4）；实底按钮登记进 SOLID_BUTTON_CENSUS。空/失败诚实态。
  - soon 计数钉 6→5、shell-r1 id 集 16→17、census 棘轮 +N（按新实底按钮数）。

- [ ] **Step 4: 跑绿** — Step 2 命令 PASS；`npm run lint` 0 错。

- [ ] **Step 5: 提交** — `git -c … commit -m "feat(inspiration): 扫榜热榜页（平台Tab+3×3书卡+实时/演示明示+收藏/套用）+ trends mode 接线"`

---

### Task 4: 抽脑洞（种子池 + idea 角色 + 反重复 + 演示兜底 + 页）

**Files:**
- Create: `src/shared/inspiration/seed-pool.ts`、`src/main/inspiration/idea-service.ts`、`src/renderer/components/views/IdeaDrawView.tsx`+`.module.css`
- Modify: `src/main/pipeline/prompts.ts`（composeIdeaPrompt）、`src/main/pipeline/overlay.ts:26`（PromptOverlayRole +idea）、`src/shared/types/ipc.ts:381`（OverlayRole +idea）、`src/main/pipeline/overlay-ipc.ts:37`（OVERLAY_ROLES +idea）、`src/main/pipeline/tools.ts:85`（TEMPERATURE +idea:1.05）、`src/shared/types/inspiration.ts`（IdeaOut）、IPC 四处（idea:draw）、`modes.ts`/`App.tsx`/`CommandPalette.tsx`（idea mode）、两钉文件（soon 5→4、id 17→18）
- Test: `tests/unit/seed-pool.test.ts`、`tests/unit/idea-service.test.ts`、`tests/unit/inspiration-overlay-roles.test.ts`、`tests/integration/idea-view-wiring.test.ts`

**Interfaces:**
- Consumes: T1 InspirationRepo（ideaHistory 反重复 + insert）；`PipelineLlm`（tools.ts:38-44）；`withOverlay`/`PromptOverlay`（overlay.ts）；`extractJson`（agent/host）；`composeConceptPrompt` 形状（prompts.ts:121 模板）。
- Produces:
  - `SEED_DIRECTIONS:string[]`（24 条原创方向）+ `drawDirection(history:string[],rand:()=>number):string`（避开 history 近期方向，纯函数可测）。
  - `composeIdeaPrompt(direction:string,overlay?:PromptOverlay|null):string`（system，withOverlay 收尾）。
  - `IdeaOut{direction,premise,hook?,genre?}` + `IdeaSchema`（zod）。
  - `drawIdea(deps:{llm:PipelineLlm;repo:InspirationRepo;getOverlay?;rand?;now?}):Promise<{card:InspirationCard;source:'live'|'demo'}>`（LLM 生成→zod→insert kind='idea'；无 Key/失败→演示兜底：从种子池取方向 + 模板化 premise，`live:false`）。
  - IPC `idea:draw():{card,source}`。`WorkMode` 含 `'idea'`；`MODE_LABELS.idea='抽脑洞'`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/seed-pool.test.ts
import { describe, it, expect } from 'vitest';
import { SEED_DIRECTIONS, drawDirection } from '@shared/inspiration/seed-pool';

describe('seed-pool', () => {
  it('24 条方向、无重复', () => {
    expect(SEED_DIRECTIONS).toHaveLength(24);
    expect(new Set(SEED_DIRECTIONS).size).toBe(24);
  });
  it('drawDirection 避开 history（反重复铁律）', () => {
    const history = SEED_DIRECTIONS.slice(0, 23); // 只剩最后一条没抽过
    expect(drawDirection(history, () => 0.5)).toBe(SEED_DIRECTIONS[23]);
  });
  it('history 覆盖全部 24 → 重置后可再抽（不卡死）', () => {
    expect(SEED_DIRECTIONS).toContain(drawDirection(SEED_DIRECTIONS, () => 0.5));
  });
});
```

```ts
// tests/unit/idea-service.test.ts —— LLM 生成 + 演示兜底 + 反重复落库
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { drawIdea } from '@main/inspiration/idea-service';

let db: ReturnType<typeof Database>; let repo: InspirationRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new InspirationRepo(db); });

describe('drawIdea', () => {
  it('LLM 出合法 JSON → 落 idea 卡 source=live', async () => {
    const llm = { chat: async () => ({ content: JSON.stringify({ direction: '重生复仇', premise: '被害者重生归来', hook: 'h', genre: '现代言情' }), usage: { input: 1, output: 1 } }) };
    const r = await drawIdea({ llm, repo });
    expect(r.source).toBe('live');
    expect(r.card.kind).toBe('idea');
    expect(repo.listByKind('idea')).toHaveLength(1);
  });
  it('LLM 抛错（无 Key）→ 演示兜底 source=demo、live=false、仍落库', async () => {
    const llm = { chat: async () => { throw new Error('auth'); } };
    const r = await drawIdea({ llm, repo });
    expect(r.source).toBe('demo');
    expect((r.card.payload as { live: boolean }).live).toBe(false);
  });
  it('反重复：连抽两次方向不同（ideaHistory 喂回 drawDirection）', async () => {
    const llm = { chat: async () => ({ content: JSON.stringify({ direction: 'X', premise: 'p' }), usage: { input: 1, output: 1 } }) };
    await drawIdea({ llm, repo, rand: () => 0 });
    const second = await drawIdea({ llm, repo, rand: () => 0 });
    expect(repo.ideaHistory().length).toBe(2);
    expect(second.card).toBeTruthy();
  });
});
```

```ts
// tests/unit/inspiration-overlay-roles.test.ts —— 重复联合两处逐字相等（本仓多副本病钉）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('overlay 角色重复联合同步', () => {
  it('overlay.ts PromptOverlayRole 与 ipc.ts OverlayRole 成员一致', () => {
    const overlay = readFileSync('src/main/pipeline/overlay.ts', 'utf8');
    const ipc = readFileSync('src/shared/types/ipc.ts', 'utf8');
    const a = overlay.match(/PromptOverlayRole\s*=\s*([^;]+);/)?.[1] ?? '';
    const b = ipc.match(/OverlayRole\s*=\s*([^;]+);/)?.[1] ?? '';
    const norm = (s: string) => s.split('|').map((x) => x.replace(/['\s]/g, '')).filter(Boolean).sort();
    expect(norm(a)).toEqual(norm(b));
    expect(norm(a)).toEqual(expect.arrayContaining(['concept', 'architect', 'writer', 'idea', 'teardown']));
  });
  it('OVERLAY_ROLES 运行时白名单含 idea/teardown', () => {
    const oipc = readFileSync('src/main/pipeline/overlay-ipc.ts', 'utf8');
    expect(oipc).toMatch(/OVERLAY_ROLES[\s\S]*idea[\s\S]*teardown|teardown[\s\S]*idea/);
  });
});
```

- [ ] **Step 2: 跑红** — `npm test -- tests/unit/seed-pool.test.ts tests/unit/idea-service.test.ts tests/unit/inspiration-overlay-roles.test.ts`，预期 FAIL。

- [ ] **Step 3: 实现**
  - `seed-pool.ts`：`SEED_DIRECTIONS` 24 条**原创**方向标签（如 重生复仇/系统流/无限流/末世求生/洪荒封神/都市异能/悬疑推理/科幻星际/历史架空/武侠仙侠/游戏竞技/灵异志怪/穿越种田/宫斗宅斗/军事谍战/体育竞技/美食经营/直播文娱/刑侦探案/修真长生/机甲战争/诡秘复苏/乡土现实/星际贸易）；`drawDirection(history,rand)`：过滤掉 history 中近期方向，剩池里 `rand()` 取一；剩池空（全抽过）→ 重置用全池（不卡死）。纯函数。
  - `prompts.ts`：`composeIdeaPrompt(direction,overlay?)` —— 原创 system：定位「你是网文脑洞发生器，围绕「${direction}」方向产出一个新鲜、可立项的脑洞：一句话 premise + 开篇 hook + 题材；反套路、反重复，避免与近期已抽方向雷同。只输出符合契约的纯 JSON。」+ `withOverlay(…, overlay)` 收尾（照 composeConceptPrompt 形状，prompts.ts:121-158）。**不进写手路径**。
  - overlay 角色面：`overlay.ts:26` `PromptOverlayRole='concept'|'architect'|'writer'|'idea'`（T5 再加 teardown）；`ipc.ts:381` `OverlayRole` 同步加 `'idea'`；`overlay-ipc.ts:37` `OVERLAY_ROLES` 加 `'idea'`；`tools.ts:85` `TEMPERATURE` 加 `idea:1.05`。
  - `idea-service.ts`：`drawIdea(deps)`：`dir=drawDirection(repo.ideaHistory().map(h=>h.direction), deps.rand??Math.random)`；`system=composeIdeaPrompt(dir, await deps.getOverlay?.('idea')??null)`；try `llm.chat({messages:[{role:'system',content:system},{role:'user',content:\`方向：${dir}。产出一个脑洞，只输出 JSON。\`}],temperature:overlay?.temperature??1.05})` → `extractJson` → `IdeaSchema.safeParse` → 成功 insert kind='idea' payload{direction,premise,hook,genre,temperature,live:true} 回 source='live'；catch/parse 失败 → 演示兜底：insert payload{direction:dir,premise:`【演示】围绕「${dir}」的一句话故事（未配置模型，演示占位）`,temperature:1.05,live:false} 回 source='demo'（**明示演示，不虚报**）。
  - IPC `idea:draw` 四处齐改 + sentinel CH 24→25；handler→`drawIdea({llm:services.llm,repo:new InspirationRepo(db),getOverlay:services.getOverlay})`。
  - `IdeaDrawView.tsx`（照 ForeshadowView）：抽卡区（一张大卡：方向 + premise + hook + 题材 + live/demo 徽标）+「再抽一张」+ 抽卡计数 + 「收藏 / 套用立项」；演示态明示；sequencer 守卫；tokens.css；实底按钮入 census。
  - `modes.ts`+idea/抽脑洞；`App.tsx` soon-brainstorm（:140）→mode idea + 分派 + onRun；`CommandPalette` mode:idea；soon 5→4、id 17→18、census +N。

- [ ] **Step 4: 跑绿** — Step 2 命令 PASS；`npm test -- tests/integration/pipeline-ipc-sentinel.test.ts tests/unit/pipeline-prompts.test.ts`（确认 R45 写手 system 字节不变钉仍绿）；`npm test -- tests/integration/idea-view-wiring.test.ts`（新建，照 Step1 trending 钉同型，钉 idea 接线）；smoke 3/3。

- [ ] **Step 5: 提交** — `git -c … commit -m "feat(inspiration): 抽脑洞——24方向种子池+反重复+idea角色(overlay/R45安全)+演示兜底+页"`

---

### Task 5: 拆书报告（零token结构统计复用 + 八维角色 + 演示兜底 + 页）

**Files:**
- Create: `src/main/inspiration/teardown-service.ts`、`src/renderer/components/views/TeardownView.tsx`+`.module.css`
- Modify: `prompts.ts`（composeTeardownPrompt）、`overlay.ts`/`ipc.ts`/`overlay-ipc.ts`/`tools.ts`（teardown 角色，TEMPERATURE 0.7）、`shared/types/inspiration.ts`（TeardownDims 已有于 T1）、IPC 四处（teardown:structure/read/save-dimension）、`modes.ts`/`App.tsx`/`CommandPalette.tsx`（teardown mode）、两钉（soon 4→3、id 18→19）
- Test: `tests/unit/teardown-service.test.ts`、`tests/integration/teardown-view-wiring.test.ts`、改 `tests/unit/inspiration-overlay-roles.test.ts`（teardown 已在 T4 钉，确认仍绿）

**Interfaces:**
- Consumes: **`distillReferenceWork(args:{title,text,mode?},_ctx,_deps):Promise<ToolResult<DigestResult>>`（digest.ts:50）** + **`analyze(text):AnalyzeResult`（metrics-engine.ts:119）** 做零token结构统计；T1 TeardownRepo + InspirationRepo；`PipelineLlm`；`withOverlay`。
- Produces:
  - `teardownStructure(title,text):{reportId,structure}`（**零 token**：调 distillReferenceWork + analyze，落 teardown_reports.structure_json，秒出）。
  - `composeTeardownPrompt(overlay?):string`（八维精读 system）。
  - `teardownRead(deps:{reportId,llm,repo,getOverlay?}):Promise<{dims:TeardownDims;source:'live'|'demo'}>`（按需 LLM 精读八维→落 dimensions_json；无 Key→演示兜底：八维回退到结构统计可确定维度 + 明示「演示·未精读」）。
  - `saveDimension(deps:{reportId,dimension,repos}):InspirationCard`（一维存入灵感库 kind='teardown'）。
  - IPC `teardown:structure({title,text})`、`teardown:read(reportId)`、`teardown:save-dimension({reportId,dimension})`。`WorkMode` 含 `'teardown'`；`MODE_LABELS.teardown='拆书报告'`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/teardown-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { TeardownRepo } from '@main/db/repos/teardown-repo';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { teardownStructure, teardownRead, saveDimension } from '@main/inspiration/teardown-service';

let db: ReturnType<typeof Database>; let td: TeardownRepo; let ins: InspirationRepo;
const SAMPLE = '第一章 测试\n' + '他走进房间，看见桌上有一封信。'.repeat(40);
beforeEach(() => { db = new Database(':memory:'); migrate(db); td = new TeardownRepo(db); ins = new InspirationRepo(db); });

describe('teardown', () => {
  it('structure 零token：不调 LLM 即出结构统计并落库', async () => {
    const r = await teardownStructure(SAMPLE, '范文'); // 入参不含 llm → 证明零 token
    expect(r.reportId).toBeTruthy();
    expect(td.get(r.reportId)?.structure).toBeTruthy();
    expect(td.get(r.reportId)?.dimensions).toBeNull(); // 未精读
  });
  it('read 八维：LLM 出合法 JSON → 落 dimensions source=live', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文');
    const dims = { 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' };
    const llm = { chat: async () => ({ content: JSON.stringify(dims), usage: { input: 1, output: 1 } }) };
    const r = await teardownRead({ reportId, llm, repo: td });
    expect(r.source).toBe('live');
    expect(td.get(reportId)?.dimensions).toEqual(dims);
  });
  it('read 无 Key → 演示兜底 source=demo，dimensions 明示未精读', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文');
    const llm = { chat: async () => { throw new Error('auth'); } };
    const r = await teardownRead({ reportId, llm, repo: td });
    expect(r.source).toBe('demo');
  });
  it('saveDimension 把一维存入灵感库 kind=teardown', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文');
    const llm = { chat: async () => ({ content: JSON.stringify({ 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' }), usage: { input: 1, output: 1 } }) };
    await teardownRead({ reportId, llm, repo: td });
    const card = saveDimension({ reportId, dimension: '节奏', td, ins });
    expect(card.kind).toBe('teardown');
    expect(ins.listByKind('teardown')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑红** — `npm test -- tests/unit/teardown-service.test.ts`，预期 FAIL。

- [ ] **Step 3: 实现**
  - `teardown-service.ts`：
    - `teardownStructure(text,title)`：**零 token**——`const dr=await distillReferenceWork({title,text},toolCtx,{currentProjectId:()=>null})`（构造最小 ToolContext，照 digest 的只读契约）+ `const a=analyze(text)`；`structure={bench:dr.ok?dr.data.bench:null,struct:dr.ok?dr.data.struct:null,hooks:dr.ok?dr.data.hooks:[],roles:dr.ok?dr.data.roles:[],analyze:{chars:a.chars,paras:a.paras,sents:a.sents,dialogRatio:a.raw.dialogRatio,avgSent:a.raw.avgSent,openType:a.openType}}`；`td.insert({bookTitle:title,structure})` 回 {reportId,structure}。**不调 llm**。
    - `composeTeardownPrompt(overlay?)`：原创 system「你是拆书精读师，对给定范文产出八维拆解：定位/结构/节奏/爽点钩子/伏笔/人物/文风/可借鉴。每维一句话，基于文本证据，不空泛。只输出符合契约的纯 JSON。」+ withOverlay。**不进写手路径**。
    - `teardownRead({reportId,llm,repo,getOverlay?})`：取 report.structure 拼 user（结构统计摘要 + 范文采样）；try llm.chat(temperature 0.7)→extractJson→TeardownDimsSchema.safeParse→`repo.setDimensions(reportId,dims)` 回 source='live'；catch→演示兜底：从 structure 可确定维度拼一份 dims（不能确定的维度填「演示·未精读」），`setDimensions` 回 source='demo'。
    - `saveDimension({reportId,dimension,td,ins})`：取 report.dimensions[dimension] → `ins.insert({kind:'teardown',title:\`${dimension}·${bookTitle}\`,payload:{dimension,summary,bookTitle,reportId},sourceLabel:bookTitle})`。
  - overlay 角色面 +teardown（`overlay.ts:26`/`ipc.ts:381`/`overlay-ipc.ts:37`/`tools.ts:85` TEMPERATURE teardown:0.7）。
  - IPC teardown:structure/read/save-dimension 四处齐改 + sentinel CH 25→28；handler 接 services.llm + repos。
  - `TeardownView.tsx`（照 ForeshadowView）：输入区（textarea 粘贴 / 选已导入书下拉——选书走既有 chapter/project 读，**只读不改正文**）→「结构统计（秒出·零token）」按钮显 bench/struct/hooks/roles/analyze → 「AI 精读八维（按需）」按钮 → 八维卡（live/demo 徽标）每维「存入灵感库」；演示/未精读明示；sequencer；tokens.css；实底按钮入 census。
  - `modes.ts`+teardown/拆书报告；`App.tsx` soon-teardown（:141）→mode + 分派 + onRun；`CommandPalette` mode:teardown；soon 4→3、id 18→19、census +N。

- [ ] **Step 4: 跑绿** — Step 2 PASS；`npm test -- tests/unit/inspiration-overlay-roles.test.ts tests/integration/pipeline-ipc-sentinel.test.ts tests/unit/pipeline-prompts.test.ts`（R45 写手钉仍绿、重复联合含 teardown、CH=28）；`tests/integration/teardown-view-wiring.test.ts`（新建钉）；smoke 3/3。

- [ ] **Step 5: 提交** — `git -c … commit -m "feat(inspiration): 拆书报告——复用digest/analyze零token结构统计+八维角色+演示兜底+存灵感库+页"`

---

### Task 6: 选题库 + 立项（v17 premise 列 + ctx 改造 + 生命周期 + 页）

**Files:**
- Modify: `src/main/db/migrate.ts`（v17 ALTER projects ADD premise）、`src/main/db/repos/chapter-repo.ts`（ProjectRepo.setPremise/getPremise + pipelineParams 含 premise）、`src/main/pipeline/ctx.ts:111`（PD-1 premise 派生）、`src/shared/types/ipc.ts`+preload+register（topic:list/promote/abandon）、`modes.ts`/`App.tsx`/`CommandPalette.tsx`（topics mode）、两钉（soon 3→2、id 19→20）
- Create: `src/renderer/components/views/TopicLibraryView.tsx`+`.module.css`
- Test: `tests/unit/topic-promote.test.ts`、`tests/integration/topic-view-wiring.test.ts`、改 `tests/integration/pipeline-ctx-canon.test.ts`（premise 派生新口径）

**Interfaces:**
- Consumes: T1 TopicRepo；`ProjectRepo.create(name,rootDir,targetWords)`（chapter-repo.ts:471）+ `setPipelineParams`（:554）；`buildPipelineCtx`（ctx.ts）；`project:open`/`project:pick-dir` 既有立项流（ipc.ts:97）。
- Produces:
  - v17 迁移；`ProjectRepo.setPremise(projectId,premise):void` + `getPremise(projectId):string`；`pipelineParams` 返回含 `premise`（或独立 getter，实现取一，**ctx 读侧统一**）。
  - `promoteTopic(deps:{topicId,repo:TopicRepo,projects:ProjectRepo,createProjectDir?}):{projectId,topic}`（建/开 project + setPremise(topic.premise) + topic.setStatus('已立项') + linkProject）。
  - IPC `topic:list(status?)`、`topic:promote(topicId,dir?)`、`topic:abandon(topicId)`。`WorkMode` 含 `'topics'`；`MODE_LABELS.topics='选题库'`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/topic-promote.test.ts —— 立项播 premise（PD-1）+ 生命周期
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { TopicRepo } from '@main/db/repos/topic-repo';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import { promoteTopic } from '@main/inspiration/topic-service';
import { buildPipelineCtx } from '@main/pipeline/ctx';

let db: ReturnType<typeof Database>; let topics: TopicRepo; let projects: ProjectRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); topics = new TopicRepo(db); projects = new ProjectRepo(db); });

describe('v17 premise 列 + 选题库立项', () => {
  it('v17 后 projects 有 premise 列', () => {
    expect(currentVersion(db)).toBeGreaterThanOrEqual(17);
    const cols = (db.prepare("PRAGMA table_info('projects')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('premise');
  });
  it('promote 建项目 + 播 premise + topic 置已立项链 project', async () => {
    const t = topics.insert({ title: '重生归来', premise: '被害者重生复仇' });
    const proj = projects.create('重生归来', '/tmp/x');
    const r = await promoteTopic({ topicId: t.id, repo: topics, projects, projectId: proj.id });
    expect(projects.getPremise(r.projectId)).toBe('被害者重生复仇');
    expect(topics.get(t.id)?.status).toBe('已立项');
    expect(topics.get(t.id)?.projectId).toBe(r.projectId);
  });
  it('ctx premise 优先取项目列，空列回退 adopted concept logline（向后兼容）', async () => {
    const proj = projects.create('书', '/tmp/y');
    projects.setPremise(proj.id, '显式一句话故事');
    const ctx = await buildPipelineCtx(db, proj.id);
    expect(ctx.premise).toBe('显式一句话故事');
  });
  it('abandon 置已放弃；已放弃为终态', () => {
    const t = topics.insert({ title: '弃', premise: 'p' });
    expect(topics.setStatus(t.id, '已放弃').status).toBe('已放弃');
    expect(() => topics.setStatus(t.id, '待立项')).toThrowError(/E_TOPIC_STATE|不允许/);
  });
});
```

- [ ] **Step 2: 跑红** — `npm test -- tests/unit/topic-promote.test.ts`，预期 FAIL（v17/premise/promote 未定义）。

- [ ] **Step 3: 实现**
  - `migrate.ts` v17（接 v16 后）：`{version:17,name:'add_project_premise',up(db){db.exec(\`ALTER TABLE projects ADD COLUMN premise TEXT NOT NULL DEFAULT '';\`)}}`。注释标 PD-1 理由（补 DRD「一句话故事独立入口」缺口；空列回退 logline 向后兼容；premise 书级常量不破 R45 写手字节稳定）。
  - `chapter-repo.ts` ProjectRepo：`setPremise(projectId,premise)`（UPDATE projects SET premise=?,updated_at=?；校验 string）+ `getPremise(projectId):string`（SELECT premise，缺省 ''）。`pipelineParams` 可选含 premise（实现取独立 getter 更省改动——ctx 读 `projects.getPremise`）。
  - `ctx.ts:111`：`premise: new ProjectRepo(db).getPremise(projectId) || concept?.logline || ''`（PD-1；既有书 premise 列空 → 回退 logline，**向后兼容、写手 system 不破**）。
  - `topic-service.ts`：`promoteTopic({topicId,repo,projects,projectId?})`：取 topic（须待立项，否则抛 E_TOPIC_STATE）；projectId 缺省时由调用方先建（register handler 走 project:open 流建项目再传 projectId）；`projects.setPremise(projectId,topic.premise)` + `repo.setStatus(topicId,'已立项')` + `repo.linkProject(topicId,projectId)` 回 {projectId,topic}。
  - IPC topic:list/promote/abandon 四处齐改 + sentinel CH 28→31；`topic:promote` handler：若无 projectId 则先 `services.openProject(dir)` 或 `projects.create(name,dir)` 建项目（dir 来自入参或 project:pick-dir），再 promoteTopic。
  - `TopicLibraryView.tsx`（照 ForeshadowView）：三态筛选/分栏（待立项/已立项/已放弃，互斥标签）+ 选题卡（title/premise/来源/操作）；待立项卡「立项」（topic:promote，需选/建项目目录——走 project:pick-dir）+「放弃」（topic:abandon，useConfirm）；已立项卡显链接 project（可跳写作坊）；演示/空诚实态；sequencer；tokens.css；实底按钮入 census。
  - `modes.ts`+topics/选题库；`App.tsx` soon-topics（:142）→mode + 分派 + onRun；`CommandPalette` mode:topics；soon **3→2**（剩 长期记忆/导出中心）、id **19→20**、census +N。

- [ ] **Step 4: 跑绿** — Step 2 PASS；`npm test -- tests/integration/pipeline-ctx-canon.test.ts tests/integration/pipeline-ipc-sentinel.test.ts tests/unit/pipeline-prompts.test.ts`（ctx premise 新口径、CH=31、R45 写手钉仍绿）；`tests/integration/topic-view-wiring.test.ts`（新建钉）；`npm test`（全量，确认 v17 + upgrade-realdb-smoke 绿）；smoke 3/3。

- [ ] **Step 5: 提交** — `git -c … commit -m "feat(inspiration): 选题库三态生命周期 + v17 premise 列 + 立项播 premise(PD-1) + 页"`

---

### Task 7: 验收 + 文档收口

**Files:**
- Create: `tests/integration/p2c-acceptance.test.ts`
- Modify: `tests/unit/p2ui-t4-smoke-fixes.test.ts`（soon 计数终值 = 2 复核 + census 终值）、`tests/integration/shell-r1-wiring.test.ts`（id 集终值 = 20 复核）、`docs/PROJECT-STATUS.md`、`docs/HANDOVER-P0.md`
- Test: 上述

**Interfaces:**
- Consumes: T1-T6 全部（四页 + 数据层 + 两角色 + 立项流）。
- Produces: 端到端验收钉 + 文档入账。

- [ ] **Step 1: 写验收测试（真库端到端，照 p2b-acceptance 同型）**

```ts
// tests/integration/p2c-acceptance.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { TopicRepo } from '@main/db/repos/topic-repo';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import { promoteTopic } from '@main/inspiration/topic-service';
import { drawIdea } from '@main/inspiration/idea-service';

let db: ReturnType<typeof Database>;
beforeEach(() => { db = new Database(':memory:'); migrate(db); });

describe('P2-C 灵感线端到端', () => {
  it('①抽脑洞演示兜底→落 idea 卡（明示演示）', async () => {
    const ins = new InspirationRepo(db);
    const llm = { chat: async () => { throw new Error('auth'); } }; // 无 Key
    const r = await drawIdea({ llm, repo: ins });
    expect(r.source).toBe('demo');
    expect((r.card.payload as { live: boolean }).live).toBe(false);
  });
  it('②卡片套用→选题库待立项→立项播 premise→已立项链 project', async () => {
    const ins = new InspirationRepo(db); const topics = new TopicRepo(db); const projects = new ProjectRepo(db);
    const card = ins.insert({ kind: 'idea', title: '重生', payload: { direction: '重生复仇', premise: '被害者重生复仇', temperature: 1.05, live: true }, sourceLabel: '重生复仇' });
    const topic = topics.insert({ title: card.title, premise: (card.payload as { premise: string }).premise, sourceCardId: card.id });
    const proj = projects.create('重生', '/tmp/z');
    const r = await promoteTopic({ topicId: topic.id, repo: topics, projects, projectId: proj.id });
    expect(projects.getPremise(r.projectId)).toBe('被害者重生复仇');
    expect(topics.get(topic.id)?.status).toBe('已立项');
  });
  it('③收藏入库→灵感库可见', () => {
    const ins = new InspirationRepo(db);
    const c = ins.insert({ kind: 'trend', title: '书', payload: { platform: '番茄', live: false }, sourceLabel: '番茄' });
    ins.setCollected(c.id, true);
    expect(ins.listCollected().map((x) => x.id)).toEqual([c.id]);
  });
  it('④选题库三态互斥：待立项/已立项/已放弃不重叠', () => {
    const topics = new TopicRepo(db);
    const a = topics.insert({ title: 'a', premise: 'p' });
    const b = topics.insert({ title: 'b', premise: 'p' });
    topics.setStatus(a.id, '已立项'); topics.setStatus(b.id, '已放弃');
    expect(topics.listByStatus('待立项')).toHaveLength(0);
    expect(topics.listByStatus('已立项').map((t) => t.id)).toEqual([a.id]);
    expect(topics.listByStatus('已放弃').map((t) => t.id)).toEqual([b.id]);
  });
});
```

- [ ] **Step 2: 跑红/绿** — `npm test -- tests/integration/p2c-acceptance.test.ts`（T1-T6 已实现则应直接绿；若红，回查对应任务缺口）。

- [ ] **Step 3: 终值复核 + 文档**
  - 复核 soon 计数钉 = **2**（长期记忆/导出中心）、shell-r1 mode id 集 = **20**、SOLID_BUTTON_CENSUS = 终值（四页实底按钮全入册）、sentinel CH = **31**、invoke 通道实测数（**跑一遍四处声明逐字数：IpcInvokeMap 键 = IPC_CHANNELS 项 = INVOKE_CHANNELS 项 = register handle() 数，四处逐字相等再写**，别抄预估 92）。
  - `docs/PROJECT-STATUS.md`：交互面 + 四页条目；计数 80→实测、16→20 命令、迁移 v15→v17、soon 6→2。
  - `docs/HANDOVER-P0.md`：加 §12（P2-C 灵感线四页：三叉裁决 F1/F2/F3、PD-1 premise 列、扫榜责任边界、两新角色 R45 安全、复用 digest/analyze）。
  - SDD ledger（`.superpowers/sdd/<p2c plan>/progress.md`，controller owns）：记 F1/F2/F3 + PD-1 + 各任务 deferred minor。

- [ ] **Step 4: 全量门禁** — `npm test`（全量，期望 ≥1455 + P2-C 新增全绿/1 skip）；`node scripts/smoke.mjs` 3/3；`npm run lint` 0 错 0 警；coverage 只涨不跌（行 ≥66.74%/函数 ≥81.86%）。

- [ ] **Step 5: 提交** — `git -c … commit -m "test(inspiration): P2-C 端到端验收 + 终值复核 + 文档入账"`

---

## Self-Review 记录

**1. 规格覆盖（spec → 任务）**：spec §3 数据层→T1；§4.1 扫榜→T2(后端)+T3(页)；§4.2 抽脑洞→T4；§4.3 拆书→T5；§4.4 选题库+§5 套用/收藏回流→T2(通道)+T3(收藏/套用 UI)+T6(立项)；§6 两新角色+overlay→T4(idea)+T5(teardown)；§7 接线门禁→T3/T4/T5/T6(各页)+T7(终值)；§8 错误诚实→各任务演示兜底/真因/不虚报；§9 测试→各任务 Step1 + T7 验收；F1 灵感河延后→不在任何任务（Out of Scope）；F2 全量角色→T4/T5；F3 直抓+无反爬→T2（chart-source 负对照钉）；PD-1 premise 列→T6。**全覆盖。**
**2. 占位扫描**：无 TBD/TODO；测试步给了可跑断言；实现步给了精确符号/字段/校验/落点。视图组件（TrendingView/IdeaDrawView/TeardownView/TopicLibraryView）以「照 ForeshadowView 结构 + 精确要素清单」描述（全码 600-800 行/页不宜 inline，与 P2-B 计划 T4/T6 同口径——SDD 实现者据要素清单 + 模板视图落地，源码扫描钉守接线）。
**3. 类型一致性**：`InspirationCard/Topic/TeardownReport/ChartEntry/IdeaOut/TeardownDims` T1/T2/T4 定义、下游消费签名回查一致；`drawDirection(history,rand)`/`drawIdea(deps)`/`teardownStructure(text,title)`/`teardownRead(deps)`/`saveDimension(deps)`/`promoteTopic(deps)` 跨任务引用拼写一致；`ProjectRepo.getPremise/setPremise` T6 定义、ctx + promote 消费一致；overlay 角色 idea(T4)+teardown(T5) 在 PromptOverlayRole/OverlayRole/OVERLAY_ROLES/TEMPERATURE 四处同步，重复联合钉 T4 立 T5 扩。
**4. 待老板批准门显式确认**：PD-1（premise 列覆盖 spec 的草稿播种法）——已在「规划裁决」与 T6 标注，批准计划时一并确认。
