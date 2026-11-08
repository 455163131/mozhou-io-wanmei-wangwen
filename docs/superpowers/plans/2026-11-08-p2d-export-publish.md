# P2-D 导出与发布线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆除导出断头路（真 zip/EPUB/DOCX + 范围三级 + 真字节预览 + 落库历史），并新建按项目绑定平台的发布排期线（确定性清洗+人工批准 → 队列推导 → 项目内暂存 → 人工标记已发布），全程零外发零自动提交。

**Architecture:** 零新依赖手写导出容器（node:zlib deflateRaw + 自实现 CRC32 的 ZIP；EPUB/DOCX 手拼 XML）；发布队列与清洗全在 `src/shared/publish/` 纯函数（渲染层与服务端跑同一份代码，预览即所得）；v18 三表（export_history / publish_plans / publish_staging）只记事实不记推导。IPC 四处齐改 + sentinel 逐批递增。两页照 P2-C 已验接线形状（源码扫描钉 R46、合并 onRun case、棘轮四钉）。

**Tech Stack:** Electron 33 + electron-vite + React 18 + Zustand + better-sqlite3 + zod + vitest（现状即全部，**禁止新增 npm 依赖**）。

**Spec:** `docs/superpowers/specs/2026-11-08-p2d-export-publish-design.md`（冲突以 spec 为准，除下方预检裁决明列者）

**分支：** `p2d-export-publish`（stacked on `p2c-inspiration-line` HEAD `0b6bf34`；spec 提交 `429e82e`）。

## Global Constraints

- **零新依赖**：package.json dependencies 逐字不变；zip/epub/docx 全走 node: 内置（zlib/crypto/path/fs）。
- **红线（DRD §1.15）**：发布线**不自动提交**——`src/main/export/**`、`src/shared/publish/**`、`src/main/publish/**` 源码负对照断言不含 `fetch(`、`node:http`/`node:https`/`node:net`、`child_process`、`exec(`；亦不含 `updateBody`/`writeBody`（导出/发布永不碰正文）。
- **迁移 append-only**：v18 接 v17 后，v1..v17 一根手指不碰；时间列 INTEGER（R1 口径）。
- **IPC 四处齐改**：ipc.ts（IpcInvokeMap+IPC_CHANNELS）/ api.ts（方法+INVOKE_CHANNELS）/ preload/index.ts / register.ts handle()；sentinel CH 逐任务递增并在数组上方加★注释行。T3 后 **33**，T6 后 **38**（本计划终值；spec 写 37 因预检 P2D-R1 增补 publish:queue——见下）。
- **R45 写手 system 字节稳定**：不触 prompts.ts/composeWriterPrompt。
- **MODE_LABELS 单一来源**（modes.ts，四字档）；tokens.css 单一来源，两页 CSS 零裸色、font-size/border-radius/padding/gap/margin 零裸 px；实底按钮入 SOLID_BUTTON_CENSUS（localeCompare 位）。
- **git 身份**：仅 `git -c user.name=墨舟 -c user.email=mozhou@localhost commit`；**永不 push、永不改 config**。
- **测试**：`npm test -- <path>`（禁裸 npx vitest）；coverage 走 `npm run test:coverage`；**绝不写真实 %APPDATA% 库**——:memory: + `mkdtempSync(join(tmpdir(),'mz-p2d-'))`；写临时文件后自行 rm 干净。
- **提交信息中文，前缀 feat/test/docs/fix(inspiration→p2d 用 export-publish)**。
- 每任务收尾四门：焦点测试绿 → 全量 `npm test` → `npm run lint` 0/0 → `node scripts/smoke.mjs` 3/3（T3/T6 另跑 coverage）。

## 预检裁决（controller，execution 前定；覆盖 spec 字面处已注明）

P2D-R1（spec §6/§10 CH=37 → **38**）：发布队列的体量机检对 en 书必须数**词**，而 `ChapterMeta.charCount` 是去空白**字符**数——渲染层拿不到正文就不许装算得出。故队列**服务端推导**：增 `publish:queue(planId)` 通道（deps 里 getBodies 一次批取，跑 shared 纯函数）。T6 通道数 4→5，sentinel 33→38，终值 38。代价若错：无——纯增量。
P2D-R2（spec §6 stage req 简化）：`publish:stage` req 收 `{planId, chapterIds}`——**提交即批准**（UI 逐章批准 checkbox 未勾的 id 不提交；服务端再校验 id ∈ 队列且未发布）。删去 `approvals` 字段：两套批准状态会漂移。幂等/诚实语义不变。
P2D-R3（页面作用域）：导出中心/发布排期**按项目**（openProject 键控，同 ForeshadowView R13 口径；未打开项目=诚实空态）。spec 的「全局子系统」纪律只属 P2-C 灵感线——导出/发布的对象是成书正文。PublishView 的 plan-list 返回「当前项目的 plans」。
P2D-R4（假 zip/csv 退役）：旧 `export:run` 内联逻辑整体删除（kind md/csv/zip-拼接 废除）；`csvEscape` 若全仓无其他消费者一并移除（实现者先 `grep -rn csvEscape src/` 核实再删）。历史表从 v18 起算，不迁旧账（旧通道无历史可迁）。
P2D-R5（startAt 语义）：排期起始日存**当日本地正午** ms（`new Date(y, m-1, d, 12).getTime()`）——epoch-day 加 86400000 永不跨 DST 漂日；UI date input 换算同式。

---

### Task 1: v18 三表 + 三 Repo + 共享类型（无 IPC）

**Files:**
- Create: `src/shared/types/export.ts`、`src/shared/types/publish.ts`、`src/main/db/repos/export-history-repo.ts`、`src/main/db/repos/publish-plan-repo.ts`、`src/main/db/repos/staging-repo.ts`
- Modify: `src/main/db/migrate.ts`（v17 块后追加 v18）
- Test: `tests/unit/export-history-repo.test.ts`、`tests/unit/publish-plan-repo.test.ts`、`tests/unit/staging-repo.test.ts`

**Interfaces:**
- Consumes: 无（地基）。
- Produces（T2-T7 全依赖）：
  - 类型见下方代码块逐字。
  - `ExportHistoryRepo`：`insert(r: ExportHistoryInsert): ExportHistoryRow`；`listRecent(limit?: number): ExportHistoryRow[]`（新在前）。
  - `PublishPlanRepo`：`upsert(p: PublishPlanInput): PublishPlan`；`get(id): PublishPlan | null`；`listByProject(projectId, includeArchived?): PublishPlan[]`；`setStatus(id, to): PublishPlan`。
  - `StagingRepo`：`upsertStaged(planId, chapterId, contentHash): StagingRow`（已发布拒→E_STAGING_STATE）；`get(planId, chapterId): StagingRow | null`；`listByPlan(planId): StagingRow[]`；`markPublished(planId, chapterId): StagingRow`（未暂存→E_STAGING_STATE；重复标记幂等）。

- [ ] **Step 1: 写失败测试（三文件，真 :memory: 库 + migrate）**

```ts
// tests/unit/export-history-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { ExportHistoryRepo } from '@main/db/repos/export-history-repo';

let db: ReturnType<typeof Database>; let hist: ExportHistoryRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); hist = new ExportHistoryRepo(db); });

describe('v18 + ExportHistoryRepo', () => {
  it('v18 落三表（PRAGMA 名册）', () => {
    expect(currentVersion(db)).toBeGreaterThanOrEqual(18);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(names).toContain('export_history');
    expect(names).toContain('publish_plans');
    expect(names).toContain('publish_staging');
  });
  it('ok 行：scope 以 JSON 往返，bytes/path 原样', () => {
    const r = hist.insert({ projectId: 'p1', format: 'epub', scope: { kind: 'volume', volumeId: 'v3' }, dest: 'project', path: '/x/书.epub', bytes: 1234, status: 'ok', error: null });
    expect(r.scope).toEqual({ kind: 'volume', volumeId: 'v3' });
    expect(hist.listRecent(10)).toHaveLength(1);
  });
  it('fail 行：path/bytes 为 null，error 真因保留', () => {
    hist.insert({ projectId: 'p1', format: 'zip', scope: { kind: 'book' }, dest: 'external', path: null, bytes: null, status: 'fail', error: 'EACCES 权限拒绝' });
    const row = hist.listRecent()[0];
    expect(row.status).toBe('fail');
    expect(row.error).toBe('EACCES 权限拒绝');
  });
  it('listRecent 新在前 + limit', () => {
    for (let i = 0; i < 3; i++) hist.insert({ projectId: 'p1', format: 'txt', scope: { kind: 'book' }, dest: 'project', path: `/a${i}.txt`, bytes: i, status: 'ok', error: null });
    const list = hist.listRecent(2);
    expect(list).toHaveLength(2);
    expect(list[0].bytes).toBe(2);
  });
});
```

```ts
// tests/unit/publish-plan-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { PublishPlanRepo } from '@main/db/repos/publish-plan-repo';

let db: ReturnType<typeof Database>; let plans: PublishPlanRepo;
const base = { projectId: 'p1', platform: 'webnovel', cadence: 'daily' as const, intervalDays: 1, startAt: 1730000000000 };
beforeEach(() => { db = new Database(':memory:'); migrate(db); plans = new PublishPlanRepo(db); });

describe('PublishPlanRepo', () => {
  it('新建回 active；同 id upsert 改值并动 updated_at，不并生新行', () => {
    const p = plans.upsert(base);
    const again = plans.upsert({ ...base, id: p.id, cadence: 'weekly', intervalDays: 7 });
    expect(again.id).toBe(p.id);
    expect(again.cadence).toBe('weekly');
    expect(plans.listByProject('p1')).toHaveLength(1);
  });
  it('platform 不在 PLATFORM_RULES 白名单 → E_INVALID_ARGS', () => {
    expect(() => plans.upsert({ ...base, platform: '某野鸡站' })).toThrowError(/E_INVALID_ARGS|平台/);
  });
  it('cadence 非 custom 时 intervalDays 由节奏派生（daily=1/every2=2/weekly=7）', () => {
    expect(plans.upsert({ ...base, cadence: 'every2' }).intervalDays).toBe(2);
  });
  it('archived 是终态：setStatus 回 active 被拒；archived 缺省不进 listByProject', () => {
    const p = plans.upsert(base);
    plans.setStatus(p.id, 'archived');
    expect(() => plans.setStatus(p.id, 'active')).toThrowError(/E_PLAN_STATE|终态|不允许/);
    expect(plans.listByProject('p1')).toHaveLength(0);
    expect(plans.listByProject('p1', true)).toHaveLength(1);
  });
  it('intervalDays custom 必须 ≥1', () => {
    expect(() => plans.upsert({ ...base, cadence: 'custom', intervalDays: 0 })).toThrowError(/E_INVALID_ARGS/);
  });
});
```

```ts
// tests/unit/staging-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { StagingRepo } from '@main/db/repos/staging-repo';

let db: ReturnType<typeof Database>; let st: StagingRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); st = new StagingRepo(db); });

describe('StagingRepo 状态机', () => {
  it('upsertStaged 新行 publishedAt=null；重复 stage 换 hash 不换 id', () => {
    const a = st.upsertStaged('pl-1', '3', 'hashA');
    const b = st.upsertStaged('pl-1', '3', 'hashB');
    expect(b.id).toBe(a.id);
    expect(b.contentHash).toBe('hashB');
    expect(st.listByPlan('pl-1')).toHaveLength(1);
  });
  it('markPublished：只从 null→now；重复调用幂等回原值', () => {
    st.upsertStaged('pl-1', '3', 'hashA');
    const m = st.markPublished('pl-1', '3');
    expect(m.publishedAt).not.toBeNull();
    expect(st.markPublished('pl-1', '3').publishedAt).toBe(m.publishedAt);
  });
  it('未暂存的章不许 mark → E_STAGING_STATE', () => {
    expect(() => st.markPublished('pl-1', '99')).toThrowError(/E_STAGING_STATE|未暂存/);
  });
  it('已发布章不许悄悄换稿 → upsertStaged 抛 E_STAGING_STATE', () => {
    st.upsertStaged('pl-1', '3', 'hashA');
    st.markPublished('pl-1', '3');
    expect(() => st.upsertStaged('pl-1', '3', 'hashC')).toThrowError(/E_STAGING_STATE|已发布/);
  });
});
```

- [ ] **Step 2: 跑红** — `npm test -- tests/unit/export-history-repo.test.ts tests/unit/publish-plan-repo.test.ts tests/unit/staging-repo.test.ts`，预期 FAIL（模块不存在 + PRAGMA 无表）。

- [ ] **Step 3: 实现**

```ts
// src/shared/types/export.ts —— 契约单份（口径同 pipeline.ts/inspiration.ts）
export type ExportFormat = 'txt' | 'md' | 'epub' | 'docx' | 'zip';
export type ExportScope =
  | { kind: 'book' }
  | { kind: 'volume'; volumeId: string }
  | { kind: 'chapters'; chapterIds: string[] };

export interface ExportRunReq {
  format: ExportFormat;
  scope: ExportScope;
  /** 'project' 写项目根（★2）；'external' 写文档目录根（★4，永不自动） */
  dest: 'project' | 'external';
  /** 缺省=书名；仍过安全化 + resolveInProject */
  baseName?: string;
}
export interface ExportRunRes { path: string; bytes: number }
export interface ExportPreviewRes {
  /** 真字节：与同参导出逐字相等（同一构建函数） */
  bytes: number;
  toc: Array<{ label: string; chars: number }>;
  sample: string;
  warnings: string[];
}
export interface ExportHistoryRow {
  id: string; projectId: string; format: ExportFormat; scope: ExportScope;
  dest: 'project' | 'external'; path: string | null; bytes: number | null;
  status: 'ok' | 'fail'; error: string | null; createdAt: number;
}
export type ExportHistoryInsert = Omit<ExportHistoryRow, 'id' | 'createdAt'>;
```

```ts
// src/shared/types/publish.ts
import type { ChapterStatus } from './project';

export type Cadence = 'daily' | 'every2' | 'weekly' | 'custom';
export type PlanStatus = 'active' | 'paused' | 'archived';

export interface PublishPlan {
  id: string; projectId: string;
  /** PlatformRule.id（小写英文，如 'webnovel'）——存 id 不存展示名 */
  platform: string;
  cadence: Cadence; intervalDays: number;
  /** 当日本地正午 ms（P2D-R5） */
  startAt: number;
  status: PlanStatus; createdAt: number; updatedAt: number;
}
export type PublishPlanInput = Omit<PublishPlan, 'id' | 'status' | 'createdAt' | 'updatedAt'> &
  { id?: string; status?: undefined };

export interface PublishQueueItem {
  chapterId: string; ord: number; title: string; status: ChapterStatus;
  plannedAt: number | null;
  size: number; sizeUnit: '字' | 'words';
  minSize: number; meetsSize: boolean;
}
export interface CleanEdit { rule: string; at: number; before: string; after: string }
export interface CleanResult { cleaned: string; edits: CleanEdit[] }
export interface StagedEntry { chapterId: string; path: string; contentHash: string; edits: number }
export interface SkippedEntry { chapterId: string; reason: string }
export interface StageOutcome { staged: StagedEntry[]; skipped: SkippedEntry[] }
export interface StagingRow { id: string; planId: string; chapterId: string; contentHash: string; stagedAt: number; publishedAt: number | null }
```

`migrate.ts` 在 v17 块的 `},` 之后、数组闭合 `];` 之前追加：

```ts
  {
    version: 18,
    name: 'add_export_publish',
    /**
     * ★ P2-D T1：导出与发布线三表（spec §2）。
     * export_history 只记事实（成功/失败都落，fail 行 path/bytes null + error 真因）；
     * publish_plans 记「哪本书按什么节奏发往哪个平台」；publish_staging 记
     * 「哪章以哪份内容进过暂存」——**排期队列不存**（章会增删改，队列=纯函数推导）。
     * 时间列 INTEGER（R1 口径）；append-only：v1..v17 不碰。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS export_history (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          format      TEXT NOT NULL,
          scope_json  TEXT NOT NULL,
          dest        TEXT NOT NULL,
          path        TEXT,
          bytes       INTEGER,
          status      TEXT NOT NULL,
          error       TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_exhist_project ON export_history(project_id, created_at);
        CREATE TABLE IF NOT EXISTS publish_plans (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL,
          platform      TEXT NOT NULL,
          cadence       TEXT NOT NULL,
          interval_days INTEGER NOT NULL,
          start_at      INTEGER NOT NULL,
          status        TEXT NOT NULL DEFAULT 'active',
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_project ON publish_plans(project_id, status);
        CREATE TABLE IF NOT EXISTS publish_staging (
          id           TEXT PRIMARY KEY,
          plan_id      TEXT NOT NULL,
          chapter_id   TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          staged_at    INTEGER NOT NULL,
          published_at INTEGER,
          UNIQUE(plan_id, chapter_id)
        );
        CREATE INDEX IF NOT EXISTS idx_stage_plan ON publish_staging(plan_id);
      `);
    },
  },
```

三 Repo 照 topic-repo 形状（`interface XxxRow` + `toXxx()` + 类薄封装，裸 SQL）。要点逐文件：
- `export-history-repo.ts`：id 前缀 `ex-`（同 P2-C `ic-` 生成法：`Date.now().toString(36)`+rand）；scope 存 `scope_json`（`JSON.stringify` 写、`JSON.parse` 读，读出 cast `ExportScope`）；`listRecent(limit=50)` `ORDER BY created_at DESC, rowid DESC`。
- `publish-plan-repo.ts`：import `PLATFORM_RULES`（`@shared/constants/platforms`）做白名单——`if (!PLATFORM_RULES.some((r) => r.id === p.platform)) throw new MzError('E_INVALID_ARGS', ...)`；cadence 非 custom → `intervalDays = CADENCE_DAYS[cadence]`（本文件内 `export const CADENCE_DAYS = { daily: 1, every2: 2, weekly: 7 } as const`，T4 schedule.ts import 它，一处来源）；custom 且 `<1` → E_INVALID_ARGS。`upsert`：有 id → `UPDATE ... WHERE id=?`（不存在抛 E_NOT_FOUND）+ `updated_at=now`；无 id → INSERT（status='active'）。`setStatus`：合法迁移 active↔paused、active|paused→archived；archived→任何 = `E_PLAN_STATE`（MzError）。`listByProject(projectId, includeArchived=false)` 缺省滤掉 archived，`ORDER BY created_at DESC`。
- `staging-repo.ts`：`upsertStaged`——先 `get`；行存在且 `published_at !== null` → `MzError('E_STAGING_STATE', '已发布章不许悄悄换稿…')`；存在未发布 → `UPDATE content_hash, staged_at` 回原 id；不存在 → INSERT（id `st-`）。`markPublished`——无行 → E_STAGING_STATE（'未暂存无所谓发布'）；已标 → 幂等回读；否则 `UPDATE published_at=now`。

- [ ] **Step 4: 跑绿** — Step 2 命令 PASS。全量 `npm test`（v18 不炸既有迁移钉：迁移是循环应用，currentVersion 钉多为 `>=`；若有钉死 `=== 17` 的测试文件，实现者 grep `17` 于 tests/ 迁移断言处核实并**只在该断言**改 18——先跑再动）。
- [ ] **Step 5: lint + smoke + 提交** — `feat(export-publish): v18 导出历史/排期计划/暂存三表 + 三 Repo + 共享契约`

---

### Task 2: 零依赖导出写手（zip 容器 + 四 builder）

**Files:**
- Create: `src/main/export/zip-writer.ts`、`src/main/export/book-doc.ts`、`src/main/export/txt-md.ts`、`src/main/export/epub-builder.ts`、`src/main/export/docx-builder.ts`
- Test: `tests/unit/zip-writer.test.ts`、`tests/unit/book-builders.test.ts`

**Interfaces:**
- Consumes: T1 类型（无强依赖，本任务纯字节级）。
- Produces（T3 依赖）：
  - `buildZip(entries: ZipEntry[]): Buffer`；`ZipEntry = { name: string; data: Buffer; stored?: boolean }`；`readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer; method: 0 | 8 }>`。
  - `ChaptersDoc`/`ChapterDoc`/`toChaptersDoc(input)/`escapeXml`/`parasOf(body): string[]`。
  - `txtDoc(doc): string`；`mdDoc(doc): string`。
  - `buildEpub(doc: ChaptersDoc): Buffer`；`buildDocx(doc: ChaptersDoc): Buffer`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/zip-writer.test.ts
import { describe, it, expect } from 'vitest';
import { buildZip, readZipEntries } from '@main/export/zip-writer';
import { deflateRawSync } from 'node:zlib';

describe('zip-writer（零依赖手写）', () => {
  it('CRC32 标准向量：crc32("123456789")=0xCBF43926（经往返条目校验）', () => {
    const z = buildZip([{ name: 'a.txt', data: Buffer.from('123456789') }]);
    const [e] = readZipEntries(z);
    expect(e.data.toString()).toBe('123456789');
    // 直接核 local header 里的 CRC 字段
    const crc = z.readUInt32LE(14);
    expect(crc).toBe(0xcbf43926);
  });
  it('deflate 条目确被压（method=8，compSize<uncompSize）', () => {
    const big = Buffer.from('啊'.repeat(5000));
    const z = buildZip([{ name: 'big.txt', data: big }]);
    const [e] = readZipEntries(z);
    expect(e.method).toBe(8);
    expect(z.length).toBeLessThan(big.length);
  });
  it('stored 条目原样存放（mimetype 场景），可带目录名', () => {
    const z = buildZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip'), stored: true },
      { name: 'META-INF/container.xml', data: Buffer.from('<x/>') },
    ]);
    const es = readZipEntries(z);
    expect(es[0].method).toBe(0);
    expect(es[0].data.toString()).toBe('application/epub+zip');
    expect(es[1].name).toBe('META-INF/container.xml');
  });
  it('中文名 UTF-8 标志位（bit11）置起且往返无损', () => {
    const z = buildZip([{ name: '第一章.txt', data: Buffer.from('x') }]);
    expect(z.readUInt16LE(6) & 0x0800).not.toBe(0);
    expect(readZipEntries(z)[0].name).toBe('第一章.txt');
  });
  it('空册 zip 仍合法（EOCD 签名 + 零条目）', () => {
    const z = buildZip([]);
    expect(z.length).toBe(22);
    expect(z.readUInt32LE(0)).toBe(0x06054b50);
    expect(readZipEntries(z)).toEqual([]);
  });
  it('确定性：同输入两次 buildZip 逐字节相等（DOS 时间固定 1980-01-01）', () => {
    const mk = () => buildZip([{ name: 'a', data: Buffer.from('aa') }]);
    expect(mk().equals(mk())).toBe(true);
  });
});
```

```ts
// tests/unit/book-builders.test.ts
import { describe, it, expect } from 'vitest';
import { readZipEntries } from '@main/export/zip-writer';
import { toChaptersDoc, escapeXml, parasOf } from '@main/export/book-doc';
import { txtDoc, mdDoc } from '@main/export/txt-md';
import { buildEpub, buildDocx } from '@main/export/epub-builder-helpers' /* ← 见下：两 builder 一文件即可?  否：拆 epub-builder.ts/docx-builder.ts */;
```

**（上面 import 是占位警示——实写两个 import 行：`import { buildEpub } from '@main/export/epub-builder'; import { buildDocx } from '@main/export/docx-builder';`，测试正文如下）**

```ts
describe('book-doc 与容器 builder', () => {
  const doc = toChaptersDoc({
    title: '测试<书> & "符号"',
    lang: 'zh',
    chapters: [
      { label: '第一章 起', body: '第一段。\n第二段。\n\n第三段（空行分开）。' },
      { label: '第二章 承', body: '独白。**残留**' },
    ],
  });
  it('escapeXml 五字符全覆盖，& 先行', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
  it('parasOf：连续换行压成段间隔，段内软换行保留', () => {
    expect(parasOf('a\n\n\nb')).toEqual(['a', 'b']);
  });
  it('txt：章标+空行+正文，章间分隔线', () => {
    const t = txtDoc(doc);
    expect(t).toContain('第一章 起');
    expect(t.split('\n---\n')).toHaveLength(2);
  });
  it('md：## 前缀', () => {
    expect(mdDoc(doc)).toContain('## 第一章 起');
  });
  it('epub：mimetype 首条目 stored；xhtml 段数=parasOf；标题转义；ncx 存在', () => {
    const es = readZipEntries(buildEpub(doc));
    expect(es[0].name).toBe('mimetype');
    expect(es[0].method).toBe(0);
    expect(es[0].data.toString()).toBe('application/epub+zip');
    const names = es.map((e) => e.name);
    expect(names).toContain('EPUB/content.opf');
    expect(names).toContain('EPUB/toc.ncx');
    expect(names).toContain('EPUB/chapter-1.xhtml');
    const x1 = es.find((e) => e.name === 'EPUB/chapter-1.xhtml')!.data.toString();
    expect((x1.match(/<p>/g) ?? []).length).toBe(3); // 三不是两：段= parasOf('第一段。\n第二段。\n\n第三段（空行分开）。') → ['第一段。 第二段。'?]
    const opf = es.find((e) => e.name === 'EPUB/content.opf')!.data.toString();
    expect(opf).toContain('测试&lt;书&gt; &amp;');
    expect(opf).not.toContain('<书>');
  });
  it('docx：document.xml 段落 <w:t> 计数=两段书合计；标题转义', () => {
    const es = readZipEntries(buildDocx(doc));
    const names = es.map((e) => e.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('word/document.xml');
    expect(names).toContain('word/styles.xml');
    const d = es.find((e) => e.name === 'word/document.xml')!.data.toString();
    const bodyParas = parasOf(doc.chapters[0].body).length + parasOf(doc.chapters[1].body).length;
    expect((d.match(/<w:t[ >]/g) ?? []).length).toBe(bodyParas);
  });
  it('确定性：同 doc 两次 buildEpub 逐字节相等', () => {
    expect(buildEpub(doc).equals(buildEpub(doc))).toBe(true);
  });
});
```

**实现者注意（测试即规格，别倒过来凑）**：epub 用例里 `<p>` 计数 `3` 是**待你按最终 parasOf 语义核定后如实修正的数字**——先写实现再跑测试；若语义是「软换行也切段」则 ch1=3 段 ch2=1 段。上面 xhtml 断言写的是「ch1 的段数」，**以实现语义为准修正断言值并在报告注明理由**（不许改实现去凑一个没想清楚数）。docx 断言已用 `parasOf` 现算，天然自洽。

- [ ] **Step 2: 跑红** — `npm test -- tests/unit/zip-writer.test.ts tests/unit/book-builders.test.ts` FAIL。

- [ ] **Step 3: 实现**

`zip-writer.ts`（完整给足）：

```ts
/**
 * 最小 ZIP 容器写手 + 读取器（P2-D T2，零依赖）。
 * local header(0x04034b50) + central directory(0x02014b50) + EOCD(0x06054b50)。
 * 压缩走 node:zlib deflateRaw；stored 供 EPUB mimetype 规范用。
 * DOS 时间固定 1980-01-01 00:00（确定性字节——同输入同 Buffer，hash 可审计）。
 * ★ 只读自身写入的结构（readZipEntries 不做通用容错）：往返自证够用，
 *   通用解压器的宽容不是本模块的责任面。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer; stored?: boolean }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01（(0<<9)|(1<<5)|1）
const NAME_FLAG = 0x0800; // UTF-8 名

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = e.stored ? e.data : deflateRawSync(e.data, { level: 9 });
    const method = e.stored ? 0 : 8;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(NAME_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(NAME_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer; method: 0 | 8 }> {
  const out: Array<{ name: string; data: Buffer; method: 0 | 8 }> = [];
  if (zip.length === 0) return out;
  let p = 0;
  while (p + 4 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const flags = zip.readUInt16LE(p + 6);
    const method = zip.readUInt16LE(p + 8) as 0 | 8;
    const compSize = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extraLen = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString(flags & NAME_FLAG ? 'utf8' : 'latin1');
    const dataStart = p + 30 + nameLen + extraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);
    out.push({ name, method, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p = dataStart + compSize;
  }
  return out;
}
```

（`readUInt16LE(p+6)` 是 local header 的 flags 偏移——30 字节结构：sig4/ver2/**flags2**@6/method2@8。若你核对规范后偏移有异，**以规范为准修代码并同步修测试里 `readUInt16LE(6)` 的断言**，别迁就错值。）

`book-doc.ts`：`ChapterDoc { label; body; anchor }`；`ChaptersDoc { title; author; lang: 'zh'|'en'; chapters }`；`escapeXml`（&→<→>→"→' 顺序实现）；`parasOf(body)`：`body.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean)`（段内软换行原样保留——xhtml 段内 `\n` 换 `<br/>`；**实现者以这条语义定 xhtml 断言真值**）；`toChaptersDoc`：`anchor = 'ch'+(i+1)`，author 缺省 `'作者'`。

`txt-md.ts`：`txtDoc`＝章块 `${label}\n\n${body}` 以 `'\n---\n'` join；`mdDoc`＝`## ${label}` 同 join。

`epub-builder.ts`：`buildEpub(doc)`——条目序：`mimetype`(stored) 首位；`META-INF/container.xml`；`EPUB/content.opf`（dc:title/creator/language=doc.lang、identifier urn:uuid **由 title 派生确定性 md5 风格**（node:crypto createHash('md5') 拼 uuid 形——非安全用途，只求确定性，注释注明）；manifest/spine 各章）；`EPUB/toc.ncx`（navMap 各章 point）；`EPUB/chapter-N.xhtml`（`parasOf` → `<p>`+段内`\n`→`<br/>`，全量 escapeXml）；`EPUB/style.css` 最小。全部经 `buildZip`。

`docx-builder.ts`：`buildDocx(doc)`——`[Content_Types].xml`、`_rels/.rels`、`word/document.xml`（标题段 `<w:p><w:pPr><w:pStyle w:val="Title"/>…` + 章 heading 段 + 正文段 `<w:p><w:r><w:t xml:space="preserve">…` 逐段）、`word/styles.xml`（Title/Heading1/Normal 三式）、`word/_rels/document.xml.rels`。经 `buildZip`。

- [ ] **Step 4: 跑绿**（含按最终 `parasOf` 语义核定后的断言修正记录）+ 全量 + lint + smoke。
- [ ] **Step 5: 提交** — `feat(export-publish): 零依赖导出写手——手写 zip 容器( CRC32/deflateRaw/stored/确定性 ) + txt/md/epub/docx builder`

---

### Task 3: export-service + 三通道重建（CH 31→33）

**Files:**
- Create: `src/main/export/export-ipc.ts`
- Modify: `src/main/ipc/register.ts`（:672 旧 export 块删除，三 handle 一行式）、`src/shared/types/ipc.ts`（'export:run' 换 req 形 + 'export:preview'/'export:history' 两枚进 IpcInvokeMap+IPC_CHANNELS；删 `ExportPayload`）、`src/preload/api.ts`（exportArtifact 签名类型走 IpcInvokeMap 自动跟形 + 新增 exportPreview/exportHistory + INVOKE_CHANNELS 两枚）、`src/preload/index.ts`（bridge 两方法）、`src/main/fs/project-fs.ts`（atomicWrite 的 content 形扩为 `string | Buffer`——实现者先读该函数确认 tmp+rename 对 Buffer 天然成立）、`tests/integration/pipeline-ipc-sentinel.test.ts`（CH +2 → 33，★注释）
- Test: `tests/unit/export-ipc.test.ts`

**Interfaces:**
- Consumes: T1 `ExportHistoryRepo`/类型；T2 全部 builder；`ChapterRepo.listMeta/getBodies/volumes`（chapter-repo.ts:85/:175/:604）；`resolveInProject/ensureDir/atomicWrite`。
- Produces:
  - `ExportIpcDeps = { getProject: () => { id: string; name: string; rootDir: string } | null; chapters: ChapterRepo; documentsDir: string; history: ExportHistoryRepo }`
  - `runExportIpc(deps, args: unknown): Promise<ExportRunRes>`；`previewExportIpc(deps, args): Promise<ExportPreviewRes>`；`historyIpc(deps, args): ExportHistoryRow[]`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/export-ipc.test.ts —— :memory: 真库 + mkdtemp 假项目根
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo } from '@main/db/repos/chapter-repo';
import { ExportHistoryRepo } from '@main/db/repos/export-history-repo';
import { runExportIpc, previewExportIpc, historyIpc, type ExportIpcDeps } from '@main/export/export-ipc';
import { readZipEntries } from '@main/export/zip-writer';

let db: ReturnType<typeof Database>; let chapters: ChapterRepo; let hist: ExportHistoryRepo;
let root: string; let docs: string; let deps: ExportIpcDeps;

function makeChapter(title: string, body: string, volumeId: string | null = null) {
  const id = String(chapters.listMeta('p1').length + 1);
  // 实现者按 ChapterRepo 真形创建（create(meta...) / updateBody），保证 status 可推到 done
  return id;
}

beforeEach(() => {
  db = new Database(':memory:'); migrate(db);
  chapters = new ChapterRepo(db); hist = new ExportHistoryRepo(db);
  root = mkdtempSync(join(tmpdir(), 'mz-p2d-root-')); docs = mkdtempSync(join(tmpdir(), 'mz-p2d-docs-'));
  deps = { getProject: () => ({ id: 'p1', name: '书', rootDir: root }), chapters, documentsDir: docs, history: hist };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(docs, { recursive: true, force: true }); });

describe('export-ipc', () => {
  it('txt 导出：文件落项目根，历史 ok 行 bytes=fs 实测', async () => {
    /* 建两章 done 正文 → await runExportIpc(deps, { format:'txt', scope:{kind:'book'}, dest:'project' })
       → expect(existsSync(res.path)).toBe(true); res.bytes === readFileSync(res.path).length;
         hist.listRecent()[0].status === 'ok' */
  });
  it('epub 导出：readZipEntries 往返含 mimetype stored 首条目', async () => { /* 同上，格式 epub，断言条目 */ });
  it('zip 导出：各章独立 txt 条目 + manifest.txt，非拼接', async () => {
    /* 断言 entries 名形如 0001_xxx.txt，且 entries.length === 章数+1 */
  });
  it('dest external 写 documentsDir 根', async () => { /* res.path 前缀 === docs */ });
  it('scope chapters 缺号 → E_NOT_FOUND 且历史落 fail 行带真因', async () => {
    /* await expect(runExportIpc(deps, {format:'txt',scope:{kind:'chapters',chapterIds:['999']},dest:'project'})).rejects.toThrow(/E_NOT_FOUND|不存在/);
       expect(hist.listRecent()[0].status).toBe('fail'); error 非空 */
  });
  it('baseName 路径穿越/分隔符 → E_INVALID_ARGS（不触盘）', async () => {
    /* runExportIpc(deps, {format:'txt',scope:{kind:'book'},dest:'project',baseName:'../evil'}) rejects /E_INVALID_ARGS/；root 内无 evil* */
  });
  it('preview 不写文件、bytes 与导出逐字相等（同一构建）', async () => {
    /* prev = await previewExportIpc(deps, req); 再 run 同参 → expect(prev.bytes).toBe(res.bytes);
       expect(existsSync(join(root,'书.txt'))).toBe(false) 于 preview 之后 */
  });
  it('未打开项目 → E_INVALID_ARGS', async () => {
    /* deps.getProject = () => null → rejects */
  });
  it('volume scope：只含该卷章（listMeta 序）', async () => { /* 两卷各一章，导 volume → txt 不含他卷标题 */ });
});
```

测试体给的意图级注释处，实现者**写全真代码**（不许留 TODO）；`makeChapter` 用 ChapterRepo 真签名（create → updateBody → status 'done' 推进路径照 chapter-repo 既有测试写法）。

- [ ] **Step 2: 跑红** — FAIL（模块不存在）。
- [ ] **Step 3: 实现**

`export-ipc.ts`：

```ts
/**
 * 导出三通道的业务实现（P2-D T3，spec §4/§6）。
 * scope 解析 → 中间文档 → 单点构建（预览与导出走同一函数，字节诚实同源）→
 * 安全化落名（★2/★4 目录语义照旧 ExportPayload.dest）→ 成败都入历史。
 * 红线：本模块零网络零正文写——写只发生在本项目根/文档根的导出新文件。
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { MzError } from '@shared/types/ipc';
import type { ExportFormat, ExportHistoryRow, ExportPreviewRes, ExportRunReq, ExportRunRes, ExportScope } from '@shared/types/export';
import { toChaptersDoc, type ChaptersDoc } from './book-doc';
import { txtDoc, mdDoc } from './txt-md';
import { buildEpub, buildDocx } from './epub-builder'; // ← buildDocx 实际在 docx-builder.ts，import 两行分开
import { buildZip } from './zip-writer';
// ChapterRepo / ExportHistoryRepo 按类型 import

const ScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('book') }),
  z.object({ kind: z.literal('volume'), volumeId: z.string().min(1) }),
  z.object({ kind: z.literal('chapters'), chapterIds: z.array(z.string().min(1)).min(1) }),
]);
const ReqSchema = z.object({
  format: z.enum(['txt', 'md', 'epub', 'docx', 'zip']),
  scope: ScopeSchema,
  dest: z.enum(['project', 'external']),
  baseName: z.string().min(1).max(80).optional(),
});

const EXT: Record<ExportFormat, string> = { txt: 'txt', md: 'md', epub: 'epub', docx: 'docx', zip: 'zip' };

function safeBaseName(raw: string): string {
  if (/[/\\]|\.\.|[\u0000-\u001f]/.test(raw)) throw new MzError('E_INVALID_ARGS', `导出文件名非法：${raw}`);
  return raw.trim();
}

function resolveTargets(deps: ExportIpcDeps, scope: ExportScope) {
  const metas = deps.chapters.listMeta(pidOf(deps));
  if (scope.kind === 'book') return metas;
  if (scope.kind === 'volume') return metas.filter((m) => m.volumeId === scope.volumeId); // 空卷 → 上层 E_NOT_FOUND
  const byId = new Map(metas.map((m) => [m.id, m]));
  const missing = scope.chapterIds.filter((id) => !byId.has(id));
  if (missing.length) throw new MzError('E_NOT_FOUND', `章节不存在：${missing.join('、')}`);
  const want = new Set(scope.chapterIds);
  return metas.filter((m) => want.has(m.id)); // 显式 id 也按库内序导出（章序是作品事实，不按请求序）
}

async function buildContent(deps: ExportIpcDeps, req: ExportRunReq): Promise<{ content: Buffer; toc: Array<{ label: string; chars: number }>; warnings: string[] }> {
  const targets = resolveTargets(deps, req.scope);
  if (targets.length === 0) throw new MzError('E_NOT_FOUND', '所选范围内没有章节');
  const bodies = deps.chapters.getBodies(pidOf(deps), targets.map((m) => m.id));
  const doc = toChaptersDoc({
    title: deps.getProject()!.name,
    chapters: targets.map((m) => ({ label: m.title || `第${m.id}章`, body: bodies.get(m.id) ?? '' })),
  });
  const warnings = targets.filter((m) => m.status === 'todo' || m.status === 'draft')
    .map((m) => `含未定稿章 ${m.title || m.id}（导出照含，历史行如实记）`);
  const toc = doc.chapters.map((c) => ({ label: c.label, chars: c.body.replace(/\s/g, '').length }));
  let content: Buffer;
  if (req.format === 'txt') content = Buffer.from(txtDoc(doc), 'utf8');
  else if (req.format === 'md') content = Buffer.from(mdDoc(doc), 'utf8');
  else if (req.format === 'epub') content = buildEpub(doc);
  else if (req.format === 'docx') content = buildDocx(doc);
  else content = buildZip([
    ...doc.chapters.map((c, i) => ({ name: `${String(i + 1).padStart(4, '0')}_${safeEntryLabel(c.label)}.txt`, data: Buffer.from(`${c.label}\n\n${c.body}`, 'utf8') })),
    { name: 'manifest.txt', data: Buffer.from(`《${doc.title}》导出包\n` + toc.map((t) => `- ${t.label}（${t.chars} 字）`).join('\n'), 'utf8') },
  ]);
  return { content, toc, warnings };
}
// sample: 首章正文剥空白后前 120 字。
// pidOf 只是类型面小工具：deps.getProject() 非空已由入口校验。
```

- `runExportIpc`：zod→（invalid() 口径同 inspiration-ipc）→ getProject null→E_INVALID_ARGS '未打开项目' → `try { const { content } = await buildContent(...) ; dir = dest==='external'? deps.documentsDir : project.rootDir; await ensureDir(dir); const fullPath = resolveInProject(dir, `${safeBaseName(req.baseName ?? project.name)}.${EXT[req.format]}`); await atomicWrite(fullPath, content); history.insert(ok 行 path=fullPath bytes=content.length); return {path,bytes} } catch (e) { history.insert(fail 行 path null bytes null error=真因); throw e; }`。
- `previewExportIpc`：同校验 + `buildContent` → 回 `{ bytes: content.length, toc, sample, warnings }`，**不写盘不入历史**（预览是只读动作）。
- `historyIpc`：`z.object({limit: z.number().int().min(1).max(200).optional()})` → `deps.history.listRecent(parsed.data.limit ?? 50)`。

IPC 四处 + sentinel：
- ipc.ts：`'export:run': { req: ExportRunReq; res: ExportRunRes }; 'export:preview': { req: Omit<ExportRunReq,'baseName'> & {baseName?: string}; res: ExportPreviewRes }; 'export:history': { req: {limit?: number}; res: ExportHistoryRow[] };`（preview req 直接复用 ExportRunReq 亦可——取**复用形**少一处漂移：`'export:preview': { req: ExportRunReq; res: ExportPreviewRes }`，dest 字段预览时被忽略，注释注明）。删 `ExportPayload`。IPC_CHANNELS 加两枚。
- api.ts：`exportArtifact(payload: IpcInvokeMap['export:run']['req'])` 自动跟形；新增 `exportPreview` / `exportHistory`；INVOKE_CHANNELS 加两枚。index.ts 两个转发。
- register.ts：删旧块（含 csvEscape 若 R4 核实无他用）；加 `exportDeps(s)` 装配 + 三 handle（一行委托，注释照 P2-C 风格）。
- sentinel：CH 数组尾加 `'export:preview', 'export:history'`（export:run 已在列），数组上方加 `// ★ P2-D T3：导出重建两枚新通道入列，总 33 通道——预览/历史与重建的 export:run 同受四处齐改铁律约束。`

- [ ] **Step 4: 跑绿** — 焦点 PASS；`npm test -- tests/integration/pipeline-ipc-sentinel.test.ts`（33 全绿）；全量（旧 export 通道若有测试钉——先 `grep -rn "export:run\|ExportPayload" tests/` 盘点，同批改形）；lint；smoke（typecheck 会抓 ExportPayload 残留引用）；coverage exit 0。
- [ ] **Step 5: 提交** — `feat(export-publish): 导出三通道重建——scope 三级/真字节预览/历史落库/假zip退役（CH 33）`

---

### Task 4: 发布纯函数（清洗/计数/队列）+ 红线负对照

**Files:**
- Create: `src/shared/publish/clean.ts`、`src/shared/publish/metrics.ts`、`src/shared/publish/schedule.ts`
- Test: `tests/unit/publish-clean.test.ts`、`tests/unit/publish-schedule.test.ts`、`tests/unit/publish-redline-negative.test.ts`

**Interfaces:**
- Consumes: T1 `PublishQueueItem/CleanResult/CleanEdit/Cadence`；`PlatformRule`；`CADENCE_DAYS`（publish-plan-repo 导出，一处来源）；tools.ts:356 的 R26 分口径语义（对齐不 import——main 侧不反依赖 shared 之外）。
- Produces（T6 依赖）：
  - `cleanForPublish(text: string, market: 'cn'|'overseas'): CleanResult`
  - `countUnits(text: string, lang: 'zh'|'en'): { size: number; unit: '字'|'words' }`
  - `resolveIntervalDays(cadence: Cadence, intervalDays: number): number`
  - `buildQueue(opts: { startAt: number; cadence: Cadence; intervalDays: number }, chapters: Array<{ meta: ChapterMeta; body: string }>, rule: PlatformRule | undefined, lang: 'zh'|'en'): { items: PublishQueueItem[]; warnings: string[] }`
  - `validateChapter(item: PublishQueueItem): string[]`（机检结论数组，buildQueue 内已填 meetsSize；本函数供 UI 展明细）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/publish-clean.test.ts
import { describe, it, expect } from 'vitest';
import { cleanForPublish } from '@shared/publish/clean';

describe('cleanForPublish 确定性四规则', () => {
  it('①零宽/控制字符剥除（\\n\\t 保留）', () => {
    const r = cleanForPublish('第一段\u200B隐藏\uFEFF。\n\t缩进保留');
    expect(r.cleaned).toBe('第一段隐藏。\n\t缩进保留');
    expect(r.edits.some((e) => e.rule === 'zero-width')).toBe(true);
  });
  it('②水平线与代码围栏整行剥', () => {
    const r = cleanForPublish('上段\n---\n```json\n正文\n```\n下段');
    expect(r.cleaned).toBe('上段\n正文\n下段');
  });
  it('②markdown 强调成对剥离；不成对不动', () => {
    expect(cleanForPublish('他说**重点**了').cleaned).toBe('他说启动了重点'.replace('启动了','重点')==='x'?'':'他说了重点了'.replace('了重点了','重点了'));
    // ↑ 实现者重写这行为直白断言：expect(cleanForPublish('他说**重点**了').cleaned).toBe('他说启动了重点'.length ? '他说重点了' : '');
    //   正解：expect(cleanForPublish('他说**重点**了').cleaned).toBe('他说重点了');
    expect(cleanForPublish('半个**标记不动').cleaned).toBe('半个**标记不动');
  });
  it('③行尾空白剥；连续空行 >2 压 2', () => {
    const r = cleanForPublish('a   \nb\n\n\n\n\nc');
    expect(r.cleaned).toBe('a\nb\n\n\nc');
  });
  it('④overseas 剥 HTML 标签行残留；cn 不动标签', () => {
    expect(cleanForPublish('<br>换行', 'overseas').cleaned).toBe('换行');
    expect(cleanForPublish('<br>换行', 'cn').cleaned).toBe('<br>换行');
  });
  it('幂等：clean(clean(x)) === clean(x)（混样三市场全跑）', () => {
    const nasty = 'x\u200B\n---\n**a**\n\n\n\n\n<br>y  ';
    for (const m of ['cn', 'overseas'] as const) {
      const once = cleanForPublish(nasty, m);
      expect(cleanForPublish(once.cleaned, m).cleaned).toBe(once.cleaned);
      expect(cleanForPublish(once.cleaned, m).edits).toHaveLength(0);
    }
  });
  it('edits 携 before/after 可审', () => {
    const r = cleanForPublish('尾空白   ', 'cn');
    expect(r.edits[0].before).toBe('尾空白   ');
  });
});
```

**上面 `②markdown` 用例里那行被涂改过的断言，实现者以注释里的「正解」写定稿（`'他说重点了'`）——测试代码不许带涂改痕迹进库。**

```ts
// tests/unit/publish-schedule.test.ts
import { describe, it, expect } from 'vitest';
import { countUnits } from '@shared/publish/metrics';
import { resolveIntervalDays, buildQueue, validateChapter } from '@shared/publish/schedule';
import { PLATFORM_RULES } from '@shared/constants/platforms';
import type { ChapterMeta } from '@shared/types/project';

function meta(id: string, status: ChapterMeta['status']): ChapterMeta {
  return { id, projectId: 'p1', title: `章${id}`, volumeId: null, order: Number(id), status, charCount: 0, rev: 1, updatedAt: 0 };
}

describe('publish 纯函数', () => {
  it('countUnits：zh 去空白字符数 / en 非空白连串数（R26 口径对齐 tools.ts:356）', () => {
    expect(countUnits('你 好\n世界', 'zh')).toEqual({ size: 4, unit: '字' });
    expect(countUnits('hello   world\nagain', 'en')).toEqual({ size: 3, unit: 'words' });
  });
  it('resolveIntervalDays：三常量 + custom 下限 1', () => {
    expect(resolveIntervalDays('weekly', 99)).toBe(7);
    expect(resolveIntervalDays('custom', 0)).toBe(1);
    expect(resolveIntervalDays('custom', 3)).toBe(3);
  });
  it('buildQueue：todo/draft 不入队进 warnings；应发日=起+序×间隔', () => {
    const start = new Date(2026, 10, 8, 12).getTime();
    const { items, warnings } = buildQueue(
      { startAt: start, cadence: 'every2', intervalDays: 2 },
      [
        { meta: meta('1', 'done'), body: '一二三' },
        { meta: meta('2', 'draft'), body: '跳过' },
        { meta: meta('3', 'revised'), body: '四五六七八九十一二三四五' },
      ],
      PLATFORM_RULES.find((r) => r.name === '晋江'), 'zh',
    );
    expect(warnings.join()).toContain('章2');
    expect(items.map((i) => i.chapterId)).toEqual(['1', '3']);
    expect(items[1].plannedAt).toBe(start + 86400000 * 2);
    expect(items[1].minSize).toBe(5000);
    expect(items[1].meetsSize).toBe(false);
  });
  it('overseas 规则走词口径：unit=words', () => {
    const rule = PLATFORM_RULES.find((r) => r.id === 'webnovel');
    const { items } = buildQueue({ startAt: 0, cadence: 'daily', intervalDays: 1 }, [{ meta: meta('1', 'done'), body: 'a b c d e f' }], rule, 'en');
    expect(items[0].sizeUnit).toBe('words');
    expect(items[0].size).toBe(6);
  });
  it('无匹配 rule：minSize=0、validateChapter 出「平台规则未在册」不装机检', () => {
    const { items } = buildQueue({ startAt: 0, cadence: 'daily', intervalDays: 1 }, [{ meta: meta('1', 'done'), body: 'x' }], undefined, 'zh');
    expect(items[0].minSize).toBe(0);
    expect(validateChapter(items[0]).join()).toContain('未在册');
  });
  it('确定性无 DST：跨月 31 日队列逐日不差', () => {
    const start = new Date(2026, 9, 31, 12).getTime(); // 10-31
    const cs = Array.from({ length: 3 }, (_, i) => ({ meta: meta(String(i + 1), 'done' as const), body: '文'.repeat(6000) }));
    const { items } = buildQueue({ startAt: start, cadence: 'daily', intervalDays: 1 }, cs, undefined, 'zh');
    const days = items.map((i) => new Date(i.plannedAt!).getDate());
    expect(days).toEqual([31, 1, 2]);
  });
});
```

```ts
// tests/unit/publish-redline-negative.test.ts —— 红线负对照（R46 源码扫描）
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 递归收集目录内 .ts 文件 */
function tsFiles(dir: string): string[] {
  let out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(tsFiles(p));
    else if (f.endsWith('.ts') || f.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const DIRS = ['src/main/export', 'src/shared/publish'];
// T6 会把 'src/main/publish' 追加进来——见 Task 6 Step 3。
const FORBIDDEN = [
  /fetch\(/, /require\(\s*['"]node:https?\s*['"]\s*\)/, /require\(\s*['"]node:net['"]\s*\)/,
  /from\s+['"]node:https?['"]/, /from\s+['"]node:net['"]/, /child_process/, /\bexec\(/,
  /updateBody/, /writeBody/,
];

describe('发布/导出红线：零外发零正文写（负对照钉）', () => {
  it('目录在册（哨兵别空转）', () => {
    expect(tsFiles('src/main/export').length).toBeGreaterThan(0);
    expect(tsFiles('src/shared/publish').length).toBeGreaterThan(0);
  });
  for (const dir of DIRS) {
    for (const f of tsFiles(dir)) {
      const src = readFileSync(f, 'utf8');
      for (const re of FORBIDDEN) {
        it(`${f.replace(/\\/g, '/')} 不含 ${re.source}`, () => {
          expect(src).not.toMatch(re);
        });
      }
    }
  }
});
```

- [ ] **Step 2: 跑红** — FAIL（模块不存在）。
- [ ] **Step 3: 实现**

`clean.ts`：四规则按序单遍实现，每规则一个私有 pass 函数产 `edits.push({rule, at: 起始索引, before: 命中片段原文, after: 替换后})`。规则名逐字：`'zero-width'`、`'horiz-rule'`（水平线+围栏行）、`'md-emphasis'`（`/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g` 成对才剥）、`'whitespace'`（行尾 `\s+$`→''；`\n{3,}`→`\n\n\n`——压至**最多两个换行**即留一空行间隔；用例 `a\nb\n\n\n\nc`→`a\nb\n\n\nc` 即此语义）、overseas 追加 `'html-tags'`（`/<[^>]*>/g`）。**顺序固定**（幂等证明依赖：后序规则不再引入前序可修形状）。文件头注释：确定性与「预览=服务端同函数」的契约声明 + 不处理全半角（平台注记人工项，YAGNI）。

`metrics.ts`：`countUnits` 两行真形；头注释挂 tools.ts:356 语义对齐声明（P2D 预检注：两处口径若漂移，本文件测试的中文/英文用例值即裁决所）。

`schedule.ts`：import `CADENCE_DAYS`（`@main/db/repos/publish-plan-repo`?——**不**：shared 不 import main。把 `CADENCE_DAYS` 挪定义于 `schedule.ts` 导出，T1 repo 改 import 它——shared→main 方向修正由本任务执行：publish-plan-repo.ts 改 `import { CADENCE_DAYS } from '@shared/publish/schedule'` 并删本地定义；两任务先后已序（T1 先本地常量、T4 收编），T4 的 diff 含这处搬家）。`buildQueue`：过滤 revised/done→按入参序（调用方给 listMeta 库内序）→ `ord` 从 1 → `countUnits(body, lang)`；`minSize = rule?.chapterWords ?? 0`；`meetsSize = minSize===0 || size>=minSize`；`plannedAt = startAt + (ord-1)*resolveIntervalDays(...)*86400000`；warnings 收集被跳过的 todo/draft（`未定稿跳过：章${id} ${title}`）。`validateChapter`：`meetsSize ? [] : [低于平台目标 ${minSize}${sizeUnit}]`；`minSize===0 → ['平台规则未在册：体量目标与惯例请人工核对']`。

- [ ] **Step 4: 跑绿** + 全量（CADENCE_DAYS 搬家不破 T1 钉）+ lint + smoke。
- [ ] **Step 5: 提交** — `feat(export-publish): 发布线纯函数——确定性清洗四规则/R26 双口径计数/队列推导 + 红线负对照钉`

---

### Task 5: 导出中心页（ExportView + export mode 转正；soon 2→1、id 20→21）

**Files:**
- Create: `src/renderer/components/views/ExportView.tsx`、`ExportView.module.css`
- Modify: `src/shared/constants/modes.ts`（+`| 'export'`、`export:'导出中心'`）、`src/renderer/App.tsx`（:159 soon-export→mode、import、modeHost `{mode==='export' && <ExportView/>}`（:597 区）、onRun :639 合并组尾加 `case 'mode:export':`）、`src/renderer/components/common/CommandPalette.tsx`（+mode:export，alias `'dao chu zhong xin export'`）、`tests/unit/p2ui-t4-smoke-fixes.test.ts`（soon 2→1 两行 :881-882 + 注释；census **CharacterView 与 ForeshadowView 之间**插 `'components/views/ExportView.module.css#btnPrimary'`）、`tests/integration/shell-r1-wiring.test.ts`（EXPECTED :150 加 `'mode:export'`→21 + 注释）
- Test: `tests/integration/export-view-wiring.test.ts`（新建）

**Interfaces:**
- Consumes: T3 三通道经 bridge（`exportArtifact/exportPreview/exportHistory`）；`project.volumes()`、store `project/chapters`；`createSequencer`。
- Produces: `WorkMode` 含 `'export'`；ExportView 组件。

- [ ] **Step 1: 写失败测试**（照 trending-view-wiring 同型的源码扫描钉）

```ts
// tests/integration/export-view-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/ExportView.tsx', 'utf8');

describe('导出中心页接线', () => {
  it('modes.ts 注册 export + 四字 label', () => {
    expect(modes).toMatch(/'export'/);
    expect(modes).toMatch(/export:\s*'导出中心'/);
  });
  it('App.tsx soon-export 转正且分派 ExportView', () => {
    expect(app).not.toMatch(/soon-export/);
    expect(app).toMatch(/id:\s*'export'/);
    expect(app).toMatch(/mode\s*===\s*'export'\s*&&\s*<ExportView/);
    expect(app).toMatch(/case\s*'mode:export'/);
  });
  it('CommandPalette 有 mode:export 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:export'/);
  });
  it('ExportView 走三通道 + 预览真字节 + 历史', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/exportArtifact/);
    expect(view).toMatch(/exportPreview/);
    expect(view).toMatch(/exportHistory/);
    expect(view).toMatch(/真字节|预览/);
    expect(view).toMatch(/未打开项目/);
  });
});
```

- [ ] **Step 2: 跑红** — 本钉 + 两棘轮 FAIL。
- [ ] **Step 3: 实现**

modes/App/CommandPalette 照 P2-C T3 已验形状（合并 case、icon path `'M12 3v10m0 0l-3-3m3 3l3-3M5 19h14'` 原样保留）。

ExportView 要素（照 TrendingView 结构，project-scoped——键 `project?.id`，未打开项目显「未打开项目——导出面向成书正文，请先开一本」诚实空态）：
- 配置区：范围三分支（全书 / 分卷（`bridge().project.volumes()` 下拉，卷空态诚实）/ 自选章（chapters 多选照 TeardownView 选书列表样式））；格式五选 tab 条（txt/md/epub/docx/zip，非实底档）；`baseName` 可选 input（placeholder=书名）。
- 「预览（真字节）」btn + 「导出」btnPrimary（入 census；disabled 链：busy/无有效范围/未打开项目）。preview 面板：bytes（千分位）+ toc 行 + sample 引文块 + warnings 黄字；导出成功 notice 显 path+bytes，失败 err 显真因。
- 历史表：exportHistory(50)——格式/范围描述（纯函数把 ExportScope 渲染成中文一句话：`全书/卷「X」/自选 N 章`）/状态点（ok sem-pass / fail sem-err + `title={error}`）/path/字节/时间。每次导出成功后 load 历史重取。
- 竞态：preview/export/history 各一条 sequencer 链或共用一条按 P2-C 口径（**一条 load + 一条 action**）；action 回调 pending-disable 全路径。
- CSS 全 tokens；`.btnPrimary` 金实底 + `(0,3,1)` hover 覆盖族照抄 ForeshadowView:242-259 注释结构。

- [ ] **Step 4: 跑绿** — Step 2 命令 PASS；全量 + lint + smoke。
- [ ] **Step 5: 提交** — `feat(export-publish): 导出中心页（范围三级×格式五种×真字节预览×历史表）+ export mode 转正`

---

### Task 6: publish-ipc 五通道 + PublishView（CH 33→38、id 21→22）

**Files:**
- Create: `src/main/publish/publish-ipc.ts`、`src/renderer/components/views/PublishView.tsx`、`.module.css`
- Modify: ipc.ts/api.ts/index.ts/register.ts（publish:plan-save/plan-list/queue/stage/mark-published 五通道四处）、sentinel（+5→38 + ★注释）、`tests/unit/publish-redline-negative.test.ts`（DIRS 加 `'src/main/publish'`——**先建目录内文件再加目录**，顺序在 Step 3 里）、modes.ts（+`'publish'`、`publish:'发布排期'`）、App.tsx（输出组 export 项后加 `{kind:'mode',id:'publish',label:MODE_LABELS.publish,d:'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z'}`（日历 icon 通用几何）、import/modeHost/onRun 合并组）、CommandPalette（+mode:publish alias `'fa bu pai qi publish schedule'`）、两棘轮（census 插 `'components/views/PublishView.module.css#btnPrimary'`——**PromptView 与 ReviewView 之间** localeCompare 位；EXPECTED +`'mode:publish'`→22）、services.ts（publishDeps() 活闭包照 ideaDeps 形）
- Test: `tests/unit/publish-ipc.test.ts`、`tests/integration/publish-view-wiring.test.ts`

**Interfaces:**
- Consumes: T1 三 Repo、T4 纯函数、`PLATFORM_RULES`、`sha256 = createHash('sha256')`。
- Produces: `PublishIpcDeps = { getProject: () => { id; name; rootDir; platform: string | null; language: 'zh'|'en' } | null; plans: PublishPlanRepo; staging: StagingRepo; chapters: ChapterRepo }`；五 handler。
  - **getProject 的 platform/language 字段**：实现者先读 ProjectRepo/project.ts 真形（platform 列 v12、language P1-B）取真字段名；若 project 行无 language 列（核实！缺省 'zh'——注释写明依据）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/publish-ipc.test.ts（:memory: + mkdtemp rootDir；五 handler 全路径）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// repos/migrate imports 照 export-ipc.test 形
// 用例意图（实现者写全代码）：
// ① savePlanIpc 坏 platform → E_INVALID_ARGS；好 plan 回带 id，listByProject 只见当前项目
// ② queueIpc：两章 done+一章 draft → items 两条带 plannedAt/minSize；warnings 含跳过章；plan 非本项目 → E_NOT_FOUND；未打开项目 → E_INVALID_ARGS
// ③ stageIpc：批准两章 → 文件落 <root>/staging/webnovel/ 下两 .txt（读回内容无 '**'、行尾无空白），StageOutcome.staged 各携 edits 数与 contentHash（sha256 hex 64 位形）；请求含 draft 章 → skipped reason 含「未定稿」
// ④ mark → 再 stage 同章 → E_STAGING_STATE；重复 mark 幂等
// ⑤ stage 幂等重跑（未 mark）：同文件覆盖、行数不增（readdirSync 计数）
```

```ts
// tests/integration/publish-view-wiring.test.ts —— 源码钉：
// modes 'publish' + publish:'发布排期'；App id:'publish' + <PublishView + case；
// palette mode:publish；view 含 createSequencer / plan-save|savePlan / queue / stage /
// mark|已发布 / contentNotes|人工 / cleanForPublish（客户端预览同源）/ 未打开项目。
```

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现**

`publish-ipc.ts`（zod 边界 + 业务全在此，register 一行式）：
- `savePlanIpc(deps, args)`：ReqSchema `{id?, projectId?, platform, cadence, intervalDays?, startAt}`——projectId **服务端取当前项目**（req 不收，杜绝越权他书）；`intervalDays` custom 才采信。repo.upsert。
- `listPlansIpc`：当前项目 → `plans.listByProject`（archived 由 req `{includeArchived?}` 透传）。
- `queueIpc(deps, {planId})`：plan=get→null/非本项目→E_NOT_FOUND；`chapters.listMeta` 全量 + `getBodies`；rule=`PLATFORM_RULES.find(r=>r.id===plan.platform)`；lang=project.language；`buildQueue` 结果 + plan 本体回 `{ plan, items, warnings }`。
- `stageIpc(deps, {planId, chapterIds})`：前置同上；先 `listByPlan` 建 published 集；逐 id：不在队列（status 非 revised/done）→ skipped「未定稿」；已发布 → skipped「已发布不许换稿」；body→`cleanForPublish(market)`（market 由 rule.market，无 rule → 'cn' 兜底并 warning）→ 路径 `staging/<platformId>/<pad4(章号)>_<safeTitle>.txt`（safeTitle=剥 `[\\/:*?"<>|\u0000-\u001f]`+空→'章'+id）→ `resolveInProject(rootDir, rel)` + ensureDir + atomicWrite → `staging.upsertStaged(planId, chapterId, sha256(cleaned))` → staged 条目 {path, contentHash, edits: clean.edits.length}。回 StageOutcome。
- `markPublishedIpc(deps, {planId, chapterId})`：plan 校验后 `staging.markPublished`。
- services.ts：`publishDeps()` 活闭包（三 repo 复用既有实例 + getProject 取当前项目行含 platform/language）。
- 四处 + sentinel 38 + **负对照 DIRS 增 `src/main/publish`**（publish-ipc.ts 无 fetch/exec——同时其**不 import chapterRepo.updateBody**：负对照 regex 已挡；测试文件里加一个 `it('publish-ipc.ts 负对照在列')` 防 T6 忘了扩 DIRS——目录非空哨兵自然挡）。
- PublishView 要素（project-scoped）：plan 卡列表（平台名+节奏+起始日+状态 chip）+ 新建表单（平台下拉 PLATFORM_RULES 六项、date input（本地正午换算 P2D-R5）、cadence 单选+custom 天数）；选中卡下方队列表面包（章序/标题/应发日/体量 `size+unit ≥ minSize` 机检点色/validateChapter 明细行）；warnings 黄条；contentNotes 折叠「人工核对清单（平台惯例，非机检）」原文列表；清洗预览：勾选章→行展开 before/after edits 表（客户端 `cleanForPublish(chapter.body, market)`——服务端 stage 时同函数同入参，预览即所得）；「暂存已勾选中已批准的 N 章」btnPrimary（批准=勾选+看过 diff 的会话闸，P2D-R2 提交即批准）；staged 行「标记已发布」btn（confirm 非 danger）；已发布行 chip 绿。空/失败诚实态全配。
- CSS 全 tokens；btnPrimary 入 census 位（Prompt 与 Review 之间）。

- [ ] **Step 4: 跑绿** — 焦点 + sentinel（38）+ 全量 + lint + smoke + coverage。
- [ ] **Step 5: 提交** — `feat(export-publish): 发布排期五通道（计划/队列/暂存/标记，服务端推导入队）+ PublishView + 红线目录扩列（CH 38）`

---

### Task 7: 端到端验收 + 终值复核 + 文档入账

**Files:**
- Create: `tests/integration/p2d-acceptance.test.ts`
- Modify: `docs/PROJECT-STATUS.md`、`docs/HANDOVER-P0.md`（§13）、（若发现 stale 钉的）对应测试文件
- Test: 上述

- [ ] **Step 1: 写验收测试**（真库端到端，全链）

```ts
// tests/integration/p2d-acceptance.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo } from '@main/db/repos/chapter-repo';
import { ExportHistoryRepo } from '@main/db/repos/export-history-repo';
import { PublishPlanRepo } from '@main/db/repos/publish-plan-repo';
import { StagingRepo } from '@main/db/repos/staging-repo';
import { runExportIpc, previewExportIpc } from '@main/export/export-ipc';
import { savePlanIpc, stageIpc, markPublishedIpc, queueIpc, type PublishIpcDeps } from '@main/publish/publish-ipc';
import { readZipEntries } from '@main/export/zip-writer';
import { cleanForPublish } from '@shared/publish/clean';

describe('P2-D 导出发布端到端', () => {
  // beforeEach：:memory: migrate；mkdtemp root；建三章（一章 markdown 残留 body、一章 draft、两章 done 带 ** 与零宽）；
  // 装配 exportDeps/publishDeps（getProject 带 platform:'webnovel', language:'en'）。

  // it①：预览与导出字节逐字等——previewExportIpc(txt, book) 后 runExportIpc 同参，expect(res.bytes === prev.bytes)。
  // it②：epub 全链——导出后 readZipEntries(FileBuffer)：mimetype 首位、xhtml 段无 '**'？（epub 不过清洗，断言**转义**：标题含 & 时 opf 无裸 &）。
  // it③：webnovel 排期全链——savePlanIpc(daily, 起日正午) → queueIpc（draft 章进 warnings 不入队）→
  //    stageIpc 批准 done 章 → 暂存文件读回：cleanForPublish 幂等（对暂存文件再跑一遍 edits===0）且无 '**'；
  //    markPublishedIpc → 再 stageIpc 同章 → skipped 含「已发布」。
  // it④：历史两条——ok（导出）+ fail（scope volume 不存在）且 fail.error 非空。
});
```

- [ ] **Step 2: 跑绿** — 若红，回查对应任务缺口（**不许改验收凑绿**，缺陷修在生产侧并记报告）。
- [ ] **Step 3: 终值复核（实测非抄数）** — soon 计数钉=**1**（只剩长期记忆）；id 集=**22**；census=**19**（T3-T7 时 17 + ExportView/PublishView 两枚 btnPrimary，逐字核在册）；sentinel CH=**38**；invoke 四处实测通道数逐字相等（跑数法同 P2-C T7：数 IpcInvokeMap 键/IPC_CHANNELS/INVOKE_CHANNELS/handle()，92+7=预期 99，**以实测为准写进文档**）。
- [ ] **Step 4: 文档** — PROJECT-STATUS：输出组两页条目 + 通道实测数（92→实测新值）+ v17→v18 + 用例总数实测 + soon 1 + 「导出历史/排期/暂存」三表入账；HANDOVER §13：P2-D 一页纸（四叉裁决、P2D-R1~R5、零依赖红线、不自动提交负对照、staging 路径规范）。
- [ ] **Step 5: 全量门禁 + 提交** — 四门 + coverage；`test(export-publish): P2-D 端到端验收 + 终值复核 + 文档入账`

---

## Self-Review 记录

1. **规格覆盖**：spec §2 数据→T1；§3 类型→T1；§4 写手→T2、服务→T3；§5 纯函数→T4（validateChapter 入 T4）；§6 通道→T3/T6（publish:queue 为 P2D-R1 增补，stage req 简化 P2D-R2）；§7 两页→T5/T6；§8 诚实→T3 fail 历史/T4 edits 审计/T7②④ 钉；§9 测试全覆盖 + 负对照→T4/T6；§10 拆分 7 任务一致（CH 37→38 见 R1）。**无缺口。**
2. **占位扫描**：T2 book-builders 测试有一处涂改注释、T6/T7 测试体给了意图级注释——均已显式要求实现者「写全真代码、以最终语义核定断言并记录理由」，非 TBD 遗留；这是源码级钉测试的诚实写法（不许留 `/* */` 进库）。
3. **类型一致**：`CADENCE_DAYS` 生于 T1 repo、T4 搬家至 schedule.ts（T4 步骤明列 repo 侧改动）；`ExportIpcDeps.getProject` 形（id/name/rootDir）与 `PublishIpcDeps.getProject`（+platform/language）是**两个形状**——T6 services 装配处注明 publish 用扩展形、export 不动；`buildQueue(opts,...)` 第一参匿名对象与 publish:queue handler 传参一致；StagingRepo 方法名四处（upsertStaged/markPublished/get/listByPlan）全文一致；`toChaptersDoc` 的 author 缺省仅 epub/docx 用，T3 装配处不传——签名 author optional 于 T2 定义。
