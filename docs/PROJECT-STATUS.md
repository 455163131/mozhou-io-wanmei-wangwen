# 文枢（墨舟写作台）项目情况通报

> 面向兄弟单位的共享文档 · 更新日期 2026-10-08 · 版本 0.1.0
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
| 便携版 | ✅ `墨舟写作台-0.1.0-portable.exe`（74MB 免安装，双击即用）|
| 测试基线 | ✅ 445 用例全绿（25 文件，2026-10-09 实测。旧文档的「281」是 10-08 前的口径，其后修复提交新增了大量用例）+ 验收脚本 9 项。**必须走 `npm test`**，见第五节 |
| UI 设计定稿 | ✅ 「文枢」水墨金风格（五模式外壳已移植进 React 渲染层）|

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
| 4 | 分卷创建/拖拽排序 | 规划视图只读展示，无 IPC | 低 |
| 5 | 应用图标 | 缺 `build/icon.ico`（当前用默认图标） | 低 |
| 6 | 品牌命名统一 | UI 品牌「文枢」vs exe 名「墨舟写作台」，待定夺 | 低 |
| 7 | 审稿模式行内标注 | 现为报告式；行内 wavy 标注需把命中 offset 映射回编辑器 | 高 |
| 8 | 便携版数据目录 | 便携 exe 数据仍写 %APPDATA%，需识别 `PORTABLE_EXECUTABLE_DIR` | 低 |
| 9 | 账本摘要未并入状态指纹 | `services.ts` 的 `computeStateHash()` 调 `ledgerDigest([])` 传空数组，注释承诺的「只改账本也能被检测到」从未生效 → 判据 B 可能把"只改账本"误判为 `no-effect` | 低 |
| 10 | 事件载荷硬编码 | `loop.ts` 的 `agent:tool-call` 写死 `danger: 1` 与 `writePolicy: 'auto-with-undo'`，与实际 `spec.danger` / `opts.writePolicy` 无关 → 界面显示的"回滚成本/写策略"不真实 | 低 |
| 11 | ~~`locate_issues` 段落定位错位~~ ✅ **已修（2026-10-09）** | `analyze.ts` 段落分支（`avgPara`/`sentsPerPara`）的 `offset` 是死变量（`map` 从不累加），位置全靠 `body.indexOf(段落)` 兜底 → 重复段落的两条命中都落到**首次出现处**，后续 `replace_phrase` 会改错地方。已改为按文档顺序逐段累加、删掉 `indexOf` 兜底，并补 `tests/unit/locate-offset.test.ts`（3 条） | ~~低~~ — |
| 12 | **句子分支同病（新发现，未修）** | 紧挨着 #11 的 `avgSent`/`sentCv` 分支仍是 `body.indexOf(s)` 从 0 反查。跨行重复句恰好因片段自带 `\n` 前缀而不会撞车，但**同一段落内的重复句会**：实测 body=`B+A+A+B`（B 长 17、A 长 4）时返回 `at = 0, 0, 17`，第二条 B（真实位置 25）指向了 0。修法与 #11 一致（改为累加偏移），但需先确认是否要保住「同一句在段内重复时只报一次」的语义 | 低 |

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
npm test             # 445 用例（必须用这个，见第五节坑 1）
npm run typecheck    # 三段 tsc
npx electron-vite build          # 三段构建
npx electron-builder --win portable --x64   # 便携版（带镜像变量）
```

**验收四关**（改完必须全过）：`typecheck 0 错` → `npm run lint`（0 error，warning 不新增）→ `npm test 445 全绿` → `node scripts\verify-flavor-acceptance.mjs`（9 项校准验收，退出码接 CI）。

> ⚠️ `npm run test:coverage` 在本机 WorkBuddy 沙箱下会因 v8 provider 写临时文件失败而报错，
> 与代码无关（详见 `vitest.config.ts` 内注释）。覆盖率门请在 CI 或正常终端执行。

**一键脚本**：项目根 `dev.cmd`（启动）、`verify.cmd`（验收）——双击即用，自动切目录。

---

## 七、协作流程约定

1. 认领第四节任一项 → 在本知识库对应条目下留言/或联系项目负责人
2. 改动分层守规矩：业务逻辑在 `src/main/services.ts` + 各领域目录；渲染层只走 `window.mz`，不碰裸 ipcRenderer
3. 交付标准 = 第六节验收四关全绿 + 更新本文档状态表（含用例数等实测数字，别留旧口径）
4. 设计定稿：`novel-workbench-ui/index.html`（水墨金五模式）是 UI 唯一视觉规范
