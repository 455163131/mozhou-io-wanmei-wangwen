# P2-D 导出与发布线 — 设计 spec

日期：2026-11-08 · 状态：**老板已批准（2026-11-08，含四节设计与 7 任务拆分预览）**
分支：`p2d-export-publish`（**stacked on `p2c-inspiration-line` HEAD `0b6bf34`**——v17 迁移与 CH=31 是 P2-D 起点；P2-C 合并 master 与否由老板另行决定，两分支各自可终审）
上游契约：DRD §输出（导出中心/发布排期）、§红线（不自动发布提交，只到排期）、§能力可见（每能力必有 UI 入口）。

## 0. 四叉裁决（老板已选）

| 叉 | 裁决 |
|---|---|
| 清洗口径 | **确定性清洗 + 逐章 diff 人工批准**；不引入 LLM 改写；不碰 rule-engine（那是质检/缝合面） |
| 导出实现 | **零新依赖手写**：node:zlib deflateRaw + 自实现 CRC32 的 ZIP 容器；EPUB/DOCX 手拼 XML。禁止新增 npm 依赖 |
| 页面范围 | **两页**：导出中心（soon-export 转正）+ 发布排期（新 mode）。统计账本合并页不做（YAGNI，dash 已实装） |
| 排期形态 | **按项目绑定平台**：一书多平台排期卡；队列由纯函数即时推导不存库；状态机 待排→暂存→已发布（人工标记）；暂存写 `<项目根>/staging/<platformId>/`（★2 项目内） |

## 1. 现状与缺口（断头路拆除对象）

- `export:run`（[register.ts:672](../../src/main/ipc/register.ts) 一带，P0 时代）：kind=md/csv/**假zip**（zip 实为 txt 拼接，注释自陈「不引压缩库」）；无 scope、无预览、无历史；**渲染层零消费者**（grep `src/renderer` 无 `export.run` 命中）；文件名硬拼 `${project.name}_${kind}`。
- 发布线：**零实现**。可用地基：`PLATFORM_RULES` 六平台（P1-B，含 chapterWords 双口径语义注记 R26、contentNotes 原创惯例）；`volumes` 表与 `ChapterMeta.volumeId/order`；`atomicWrite/ensureDir/resolveInProject`（src/main/fs/project-fs）；`ChapterStatus`（todo/draft/revised/done）；R26 分口径计数口径在 tools.ts:356（zh=去空白字符数 / en=`\S+` 连串词数）。
- 导航 soon 现 2 条（长期记忆/导出中心）；mode id 集 20；WorkMode 13 种；sentinel CH=31。

## 2. 数据层（v18，append-only）

```
export_history (id TEXT PK, project_id TEXT NOT NULL, format TEXT NOT NULL,
  scope TEXT NOT NULL, targets_json TEXT NOT NULL, dest TEXT NOT NULL,
  path TEXT, bytes INTEGER, status TEXT NOT NULL, error TEXT,
  created_at INTEGER NOT NULL)           -- INTEGER 时间列，口径同 R1/v16
publish_plans (id TEXT PK, project_id TEXT NOT NULL, platform TEXT NOT NULL,
  cadence TEXT NOT NULL, interval_days INTEGER NOT NULL,
  start_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
publish_staging (id TEXT PK, plan_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
  content_hash TEXT NOT NULL, staged_at INTEGER NOT NULL,
  published_at INTEGER,                 -- null=未标发布（人工标记才写）
  UNIQUE(plan_id, chapter_id))
```

- `cadence ∈ 'daily'|'every2'|'weekly'|'custom'`；custom 时 `interval_days` 生效（daily=1/every2=2/weekly=7 为常量派生）。
- `publish_plans.platform` 存 **PlatformRule.id**（稳定小写英文，如 'webnovel'），不存展示名——读写侧匹配一律按 id（ctx 的平台规则匹配允许 name-or-id 是历史口径，发布线新表不继承这层含糊）。
- `publish_plans.status ∈ 'active'|'paused'|'archived'`。
- 迁移 v18 `add_export_publish`：三表 + 索引（export_history.project_id、publish_plans.project_id、publish_staging.plan_id）；**不改任何既有 v1..v17 块**。
- Repo 三件（src/main/db/repos/）：`ExportHistoryRepo`（insert/listRecent(limit)）、`PublishPlanRepo`（upsert/list/get/setStatus，platform 值须命中 PLATFORM_RULES 白名单——写侧校验，库列不加 CHECK，口径同 v14）、`StagingRepo`（upsertStaged/get/listByPlan/markPublished(planId,chapterId)——**published_at 只从 null→now，重复 mark 幂等回原值；mark 前置：该 (plan,chapter) 必须已 staged，否则 E_STAGING_STATE**）。
- ⚠️ **排期队列不存库**：章会增删改，存队列必过期——队列=纯函数推导（§5），staging 只记「哪些章以哪份内容进过暂存」。

## 3. 类型与共享契约（src/shared/types/export.ts + publish.ts）

```ts
ExportFormat = 'txt'|'md'|'epub'|'docx'|'zip'
ExportScope  = { kind:'book' } | { kind:'volume', volumeId:string } | { kind:'chapters', chapterIds:string[] }
ExportRunReq  = { format:ExportFormat; scope:ExportScope; dest:'project'|'external'; baseName?:string }  // baseName 缺省=project.name，仍过 resolveInProject 防穿越
ExportRunRes  = { path:string; bytes:number }
ExportPreviewRes = { bytes:number; toc:Array<{label:string; chars:number}>; sample:string; warnings:string[] }
ExportHistoryRow = { id; projectId; format; scope; dest; path; bytes|null; status:'ok'|'fail'; error|null; createdAt }
PublishPlan = { id; projectId; platform; cadence; intervalDays; startAt; status; createdAt; updatedAt }
PublishQueueItem = { chapterId; ord /*队列内序，1 起*/; title; status; plannedAt:number|null /*epoch ms*/; size:number; sizeUnit:'字'|'words'; minSize:number; meetsSize:boolean }
StageOutcome = { staged: Array<{chapterId, path, contentHash, edits:number}>; skipped: Array<{chapterId, reason}> }
```

zod 边界（IPC 门口校验，坏值 E_INVALID_ARGS）：format/scope/plan 字段枚举逐一；`baseName` 拒含路径分隔符与 `..`。

## 4. 导出后端（src/main/export/，零新依赖）

- `zip-writer.ts`：`buildZip(entries: Array<{name:string; data:Buffer; stored?:boolean}>): Buffer`——local header + data（deflateRawSync；`stored:true` 走 stored，EPUB mimetype 规范用）+ central directory + EOCD；**CRC32 自实现（表法）**；时间字段固定 DOS epoch-safe 值（不引时区不确定性）。往返自证：同模块附 `inflateEntry`（zlib.inflateRawSync）仅供测试与自检。
- `book-doc.ts`：章节序列 → `ChaptersDoc = { title, author, lang, toc:[{label, body, anchor}], chapters:[…] }` 中间表示（HTML 转义在此，杜绝注入式坏 XML——参考重设计教训：转义缺陷会静默毁容器）。
- `txt-md.ts`：TXT（`第N章 标题\n\n正文` + 空行分隔）/ MD（`## ` 前缀）单文件。
- `epub-builder.ts`：`mimetype`(stored, `application/epub+zip`, 首条目) + `container.xml` + `content.opf`(manifest/spine/toc) + `toc.ncx` + `OEBPS/chapter-N.xhtml`（XHTML 段落化：正文按空行切 `<p>`，全量转义）。OPF 元素顺序与必需属性按 EPUB3 最小集（dc:identifier=plan-independent uuid、dc:language=book lang）。
- `docx-builder.ts`：`[Content_Types].xml` + `_rels/.rels` + `word/document.xml`（`<w:p><w:r><w:t>` 段落，转义）+ `word/styles.xml` 最小。
- `export-service.ts`：`runExport(deps, req)`——按 scope 解析章集（volume=该卷内按 order；book=全量；chapters=显式 id 缺任一 → E_NOT_FOUND 列缺号）→ 构建（zip=各章 `.txt` 条目 + `manifest.txt`；epub/docx 失败真因上抛）→ 写盘（project=rootDir；external=documents 根；文件名 `${baseName}.${ext}`，zip 容器经 resolveInProject）→ **成功/失败都写 export_history**（失败行 path/bytes null + error 真因）。`previewExport`：同链构建但不写盘，回真实 bytes/toc/sample(首章前 120 字)/warnings（如「本卷无章」「含 todo 章 N 个——导出照含，历史行如实记 status」）。
- 旧 `export:run` 内联逻辑删除（csv 分支随断头路退役——统计 CSV 无任何钉与消费者，YAGNI 保它；`csvEscape` 若无它用即移除）。**kind 集变化是契约变更**：ExportPayload 旧形废除，新 req 形如上（四处同改：ipc.ts/api.ts/index.ts/register.ts + sentinel）。

## 5. 发布线纯函数（src/shared/publish/）

- `clean.ts`：`cleanForPublish(text, market:'cn'|'overseas'): { cleaned:string; edits: CleanEdit[] }`。规则（确定性、幂等：clean(cleaned)===cleaned）：
  1. 剥零宽/控制字符（`\u200B-\u200D\uFEFF`、保留 `\n\t`）；
  2. 剥生成残留：水平线 `^\s*([-*_]\s*){3,}$`、代码围栏 ` ``` ` 行、markdown 强调 `**x**/__x__` → `x`（仅成对且非空）；
  3. 行尾空白剥；连续空行 >2 → 2（cn 段间一空行惯例压到 ≤1？——否：cn 惯例=段间空行保留单空行，>2 压 2 为通用底线，平台注记另列人工项）；
  4. overseas 额外：`<br>`/HTML 标签行残留剥除（RoyalRoad 富文本粘贴常见）。
  `CleanEdit = { rule:string; at:number; before:string; after:string }`——diff 预览与 edits 计数（staging hash 前记录 edits 数入 StageOutcome）。
- `metrics.ts`：`countUnits(text, lang)`——zh=去空白字符数 / en=非空白连串数，**口径对齐 tools.ts:356**（实现者须对读并把同源注释挂上；两处分叉未来 P3 合并，本批钉「同语义」测试）。
- `schedule.ts`：
  - `resolveIntervalDays(cadence, intervalDays)`；
  - `buildQueue(plan, chapters /*按队列序*/): PublishQueueItem[]`——第 i 章（仅 status ∈ revised/done 入队；todo/draft 出 warnings 不入）`plannedAt = startAt + i*interval*86400000`（epoch-day 算术，无 DST 概念）；
  - `validateChapter(plan, rule:PlatformRule|undefined, item)`：机检=体量阈值（rule.chapterWords 按 market 口径；无匹配 rule → 只出「平台规则未在册」提示不装机检）；`contentNotes` 作人工清单呈现，**不产机检结论**（诚实边界）。

## 6. IPC 通道（四处齐改 + sentinel 逐批）

| 通道 | req | res | 批次 | CH |
|---|---|---|---|---|
| `export:run`（重建） | ExportRunReq(zod) | ExportRunRes | T3 | 31→33 |
| `export:preview` | {format,scope} | ExportPreviewRes | T3 | |
| `export:history` | {limit?} | ExportHistoryRow[] | T3 | |
| `publish:plan-save` | PublishPlan 形(zod 白名单 platform/cadence) | PublishPlan | T6 | 33→37 |
| `publish:plan-list` | void | PublishPlan[] | T6 | |
| `publish:stage` | {planId, chapterIds, approvals: Array<{chapterId, acceptedRules?}>} | StageOutcome | T6 | |
| `publish:mark-published` | {planId, chapterId} | StagingRow | T6 | |

- handler 业务口径全在 `src/main/publish/publish-ipc.ts` / export-service（register 一行委托，口径同 canon/overlay/inspiration）。
- `publish:stage` 语义：对每章取 body → `cleanForPublish` → **只允许「本轮 diff 已被人批准」的章**写暂存（UI 逐章「批准」后传 chapterIds；未批的进 skipped reason='未批准清洗'）→ 写 `<rootDir>/staging/<platformId>/<零填充章号>_<安全标题>.txt`（文件名过安全化+resolveInProject 双闸）→ upsertStaging(contentHash=sha256(cleaned), staged_at)。同章重复 stage = 覆盖暂存文件 + 更新 hash/staged_at，published_at 非 null 时**拒**（E_STAGING_STATE：已发布章不许悄悄换稿——诚实红线）。
- **红线负对照钉（T4 立、T7 复扫）**：`src/main/export/**`、`src/shared/publish/**`、`publish-ipc.ts` 源码断言不含 `fetch|http\.request|https\.request|net\.|child_process|exec\(`——本地暂存+人工发布，零外发；同时断言不含 `updateBody|writeBody`——发布线永不碰正文。

## 7. 两页 UI（模式接线照 P2-C 已验形状）

- **ExportView（mode 'export'，MODE_LABELS.export='导出中心'，四字档）**：左=范围卡（全书/分卷下拉（volumes）/自选章多选）×格式五选（txt/md/epub/docx/zip）→「预览（真字节）」（export:preview，sequencer 守卫）→「导出」（成功显路径+字节，失败显真因）；下=历史表（export:history，status 点色：ok 绿/fail 红+error 悬浮真因）。soon-export 行原地转正（icon path 保留），onRun 并入合并 case，不占数字快捷键。
- **PublishView（mode 'publish'，MODE_LABELS.publish='发布排期'）**：平台排期卡列表（plan-list；新建=从 PLATFORM_RULES 选平台+起始日+节奏）→ 卡内队列（buildQueue 推导：章号/标题/应发日/体量机检 meetsSize 标记/人工 checklist 折叠）→「逐章清洗预览」（cleanForPublish diff，逐章批准 checkbox）→「暂存已批准 N 章」→ staging 行状态（待排=未入队/未暂存，暂存=已写文件，已发布=人工标记按钮 useConfirm）。平台 contentNotes 原文展示为「人工核对清单（平台惯例，非机检）」。
- 棘轮终值：soon `.toBe(1)`/GTE(1)（剩长期记忆）；id 集 20→22（+mode:export +mode:publish）；SOLID_BUTTON_CENSUS +ExportView#btnPrimary +PublishView#btnPrimary（金实底×accent-ink，(0,3,1) hover 覆盖族照旧）；WorkMode 15；tokens 单一来源零裸色零裸 px；两页全局动作按钮全带 pending-disable；数据变更类回调 sequencer/会话闸照 T5/T6 修复波口径。

## 8. 错误处理与诚实

- 导出失败（含构建异常/写盘 EACCES）：history 行 status=fail + error 真因；UI 显「导出失败：<真因>」不粉饰。
- scope 解析不到章：E_NOT_FOUND（volume 空/章缺号列缺号清单）。
- 预览与导出字节一致性：**同一构建函数**，预览即真字节，禁止两套估算。
- 清洗 diff：每处 before/after 可见，规则名可追溯；staging 记录 contentHash——「暂存的是哪一份」可审计。
- 已发布标记不可逆换稿：mark-published 后 stage 拒（要改必须新平台卡/新章号语义？——否：拒即拒，error 说明「已发布章换稿请人工处理，工具不悄悄改历史」）。

## 9. 测试

- 单元：zip 往返（stored+deflate 双分支、CRC 自证、中文文件名 UTF-8 flag）；epub/docx 结构断言不引 XML 解析依赖——经 `inflateEntry` 往返解出各条目后做字符串级断言（标签配对计数、必需元素存在、mimetype 首条目 stored），口径同 chart-parse 的手写断言风格；clean 幂等与逐规则；countUnits 与 tools.ts:356 语义同钉；buildQueue 序/日期/跳过 todo；validateChapter 双口径。
- Repo：三 repo :memory:（含 mark/stage 状态机全路径）。
- IPC：zod 边界（E_INVALID_ARGS 族）+ E_STAGING_STATE + 假 export_service 注入。
- Wiring：两页源码扫描钉（R46）+ modes/App/palette 三处 + 棘轮四钉。
- 负对照：红线 regex 钉（§6）。
- 端到端验收（T7）：造书→分卷→导出 epub 往返解包→history ok；plan→stage 批准流→文件在 staging→mark→重复 stage 拒；失败导出 history fail 带真因。
- 门禁：全量/lint 0/0/smoke 3/3/coverage exit 0；sentinel CH 终值 37。

## 10. 任务拆分（7 串行，SDD 执行）

T1 v18+三 Repo+共享类型+zod（CH 不动）→ T2 zip/容器写手四 builder+book-doc（纯函数+单测，无 IPC）→ T3 export-service+三通道重建+sentinel 31→33 → T4 publish 纯函数三件+负对照钉 → T5 导出中心页+转正接线+棘轮（soon 2→1, id 20→21）→ T6 PublishView+publish 四通道+sentinel 33→37+棘轮（id 21→22）→ T7 端到端验收+文档入账（PROJECT-STATUS/HANDOVER §13）+终值复核。

串行约束源：modes/App/两钉/sentinel CH；services.ts 装配点。deferred minors 台账延续 P2-C ledger 口径。
