# 墨书 P0+P1-A 交接文档（跨会话/跨账号续作用）

> 分支：`p0-generation-pipeline`（自 master a4f1c65 切出，**23 commits**，未合并未推送）
> 仓库：C:\Users\Administrator\WorkBuddy\2026-10-07-19-01-04\MozhouAgent
> 日期：2026-11-04（过夜批更新：P1-B 完成+打包完成）。续作者先读本文，再读 `.superpowers/sdd/` 下三个计划的 progress.md（ledger，含全部裁决 R1-R30 与 deferred minors 分诊）。

## 1. P0 完成了什么

验收目标达成：**空库 → 生成构思 → 生成卷纲章纲 → 写第一章草稿 → 人工采纳入正稿**，全链路有集成测试钉死（tests/integration/p0-acceptance.test.ts，走真 IPC adoptDraft 路径）。

| Commit | 内容 |
|---|---|
| 3fe79ea | T1 drafts 隔离表 + DraftRepo（AI 产出先落草稿区，采纳才入正稿） |
| cd2f2f9 / 6d965f5 | T2 构思/架构师/写手 prompt 合成器（机制移植自 WritingStudio、措辞原创；6d965f5 为 AGPL 占位文案改写修复） |
| 29d6256 | T3 上下文装配器（保护层 canon 超预算硬失败、可压缩栏位裁剪留 trace） |
| ef022b5 | T4 三生成工具（registerExternal 挂载 + zod 契约校验 + 草稿隔离） |
| 39010b2 | T5 IPC 六通道 + progress 推送 + projects 参数列 v12 + budget 动态注入 |
| 70b5ec0 | T6 gen Mode UI（立项表单/分步执行/草稿采纳）+ project:set-gen 通道 |
| 470362b | T7 品牌统一为「墨书」+ GenView progress 按 projectId 过滤 |
| 5cd803c | T8 验收测试 |
| ffcbd10 | 终评修复：采纳回退建章+防跳章+错误码透传（C1/I1） |
| 3e06250 | R15/R16：建章基准改最大可解析章号+对齐断言+空洞号直报 |
| a96158d | 覆盖率门修复：reportsDirectory 移出 .tmp（与清理用例同目录相撞致 ENOENT） |
| 530c76e | 守卫式真实磁盘库升级冒烟（MZ_UPGRADE_SMOKE_DB） |
| 1d8d4e5 | P1-A T1：project_canon v13 + CanonRepo |
| 77a1ff2 | P1-A T2：canon IPC 三通道 + buildPipelineCtx 抽函数，canon 进装配真来源 |
| 60deb5c | P1-A T3：writeDraft 接 prevEnding 上章结尾衔接桥 |
| a5a9b19 | P1-A T4：GenView 铁律录入卡 + 验收断言 canon/prevEnding 进装配 |

测试现状：84 文件 / 1229 用例全绿（+1 skip 为守卫式冒烟无 env 时）；三 tsconfig typecheck 0 错；`npm run test:coverage` 过阈值（64.64/80.95/80.4/64.64 vs 门 45/35/45/45）。
**测试命令口径**：`npm test`（全量）或 `npm test -- <文件过滤>`；**禁止裸 `npx vitest`**——better-sqlite3 按 Electron ABI 编译，系统 Node 加载必挂 ERR_DLOPEN_FAILED（scripts/test.cmd 走 ELECTRON_RUN_AS_NODE）。

## 2. 关键架构事实（续作者必知）

- 草稿隔离红线：生成三工具只写 `drafts` 表（status pending）；正文入正稿唯一入口 `ChapterRepo.updateBody(pid, id, body, expectedRev)`（乐观锁+日增量记账在内）。任何绕过都是回归。
- IPC 四处契约铁律：shared/types/ipc.ts、preload/api.ts、preload/index.ts、main/ipc/register.ts 齐改 + tests/integration/pipeline-ipc-sentinel.test.ts 哨兵钉死（现 7 通道：6 pipeline + project:set-gen）。
- 迁移只增不改：当前 user_version=12（v11 drafts、v12 projects 参数列）。
- AGPL 红线：WritingStudio（D:\皖美AI写作坊\WritingStudio）只借机制不抄代码/措辞；prompts.ts 头注释有边界声明；终审抽查通过，但**三条场景 delta（调查/过渡/揭示）句式与参照源近改写，P1 需再拉开距离**。
- 品牌：APP_BRAND_NAME='墨书网文写作台'；「墨舟」仅存 brand.ts:5 决策注释；brand-naming.test.ts 钉死。
- 工作区有 14 个**他人遗留的 unstaged UI 文件**（tokens.css/ChapterTree.tsx/App.module.css 等）——不要裹挟进提交，不要顺手"清理"。

## 3. 裁决清单（Rulings，续作者重做前必读）

- R1 同目录新分支实施，不开 worktree（原生依赖二次安装成本高）
- R2 工具调用走导出的 pipelineHandlers(deps)，不依赖 registry 公共 invoke（不存在）
- R3 project:set-gen 无条件新增并扩哨兵
- R4 extractJson+zod 全 try/catch → E_PIPELINE_PARSE retryable
- R5 本 harness 无 model 参数，子代理继承会话模型
- R6 测试口径 npm test（Electron-as-Node）
- R7 架构师任务②续写章纲用局部 ChapterPlanSchema 校验后合并 volumes
- R8 生效保护配额=min(8000, window−outputReserve)，错误消息报生效值
- R9 prevEnding 截头保尾 slice(-260)（衔接关节在上章末尾）
- R10 projects 参数列迁移 v12 前移到 T5
- R11 budget 从 provider contextWindow 注入，禁硬编码窗口
- R12 gen 参数无读通道、挂载不回填（空表单=未设定诚实表达），P1 补 get 通道
- R13 GenView onProgress 按 projectId 过滤（T7 已落）
- R14 采纳回退建章三分支（==nextNo 建章 / >nextNo 防跳章 / 存在写 rev）
- R15 建章基准=最大可解析章号+1 + 对齐断言（3e06250 已落）
- R16 空洞号（删章/从未存在）→ E_PIPELINE_STATE 直报，retryable:false
- R17 SDD 工作区不删（跨账号续作需要 ledger/reports）

## 4. P1 待办（按终审分诊排序）

**已完成（P1-A，2026-11-04）**：canon 真数据源全链路（project_canon v13 + CanonRepo + IPC 三通道 + buildPipelineCtx 抽函数 + GenView 铁律录入卡，commits 1d8d4e5/77a1ff2/a5a9b19）；prevEnding 上章结尾衔接桥（60deb5c）；验收测试已钉 canon/prevEnding 进装配 user 消息。另：覆盖率门修复（a96158d，reportsDirectory 移出 .tmp，默认命令本沙箱全绿 64.64/80.95/80.4/64.64）；守卫式真实磁盘库升级冒烟（530c76e，MZ_UPGRADE_SMOKE_DB env，真 v10 空库→v12 验证过）。

**剩余**：
1. R15 残留：对齐断言触发时空壳错号章不回滚（真实 repo 不可达，纯防御；若加删章能力需补回滚）
2. 三条场景 delta（调查/过渡/揭示）再改写拉开与参照源距离（AGPL 卫生）
3. (project_id, status) 索引（随下次迁移顺带）
4. gen 参数 get 通道（R12）
5. canon 重试按钮 disabled 口径 / 本地预检硬编码 repo 文案双处漂移（P1A-T4 minors）
6. pipeline 六通道 assertCurrentProject 不带 retryable detail（与 canon 族口径统一）
7. 其余 deferred minors 全表见两份 ledger progress.md（E_PIPELINE_PARSE 码名、setStatus AND 守卫、NOT_FOUND 语义、busy 死键、source:'user' 枚举、preload 尾换行、rethrowWithRetryable 丢 stack 等——均不阻塞）
8. **P0-B 计划**：CodeMirror 6 替换 textarea（独立计划未写）
9. **P0-C 计划**：book-JSON 导入器（旧书库红线格式 → SQLite；独立计划未写）

## 5. 合并前必做（终审建议，尚未执行）

1. 手动冒烟：`npm run dev` → 空项目 → gen Mode 存参数 → 构思→采纳 → 卷纲章纲→采纳 → 写第1章→采纳 → 写作 Mode 验证章节树与正文；中途切书验证 progress 不串书；genre 留空验证"未设定"不撒谎
2. 老库升级冒烟：拿 user_version ≤10 的真实库启动一次，验证 v11/v12 迁移
3. `npm run test:coverage` 复核阈值（lines/functions/statements 45、branches 35）
4. 合并决策在人：分支未合并未推送（用户规矩：commit 授权、push 不授权）

## 6. 设计资产位置（本会话 earlier 阶段产物，不在本仓库）

- 方案：C:\Users\Administrator\Documents\Qoder\2026-11-03\cfab122c\output\墨书写作坊重设计\{analyze/project-brief.md, strategize/drd.md, review/review-report.md(原型评审 100 分), generate/craft-report.md}
- 高保真原型 8 页：同目录 generate\prototype\（index.html 入口；墨韵国风设计系统 assets/moshu.css）
- 豆包 UI 设计图 27 张：E:\C-Migrate\Desktop\墨书Agent-UI设计图\
- 提示词覆盖层 9 角色：C:\Users\Administrator\Documents\皖美AI写作坊提示词\

## 7. P1-B 完成（过夜批 2026-11-04）：商业资产融入 + 海外/英文

- **craft-skills**（1987809）：6 条原创工艺技能（因果句章纲/章末钩三件套/五感开场/潜台词对话/去AI句式/字数硬顶），按章纲触发词注入写手上下文可压缩槽（rank2、hardCap 1200、R25 条目边界整条丢弃）。机制参照 E:\AI项目\WinkNovel_Release 与 E:\NovelCraft，**文本原创**——终审对 E 盘原文实测零逐字命中
- **降级续写**（134c4a8）：首稿不足目标一半自动续写一次拼接（R24 最多 1 次、shortfall 交作者）；R26 en 按词数/zh 按字符数
- **海外/英文**（8991072/5cac296/ecfa685）：PLATFORM_RULES 六平台（番茄/起点/晋江 + Webnovel/Royal Road/KDP Serials，contentNotes 原创概括）；projects.language 列 v14；EN_CRAFT 英文工艺块+平台注记进写手 system（书籍级稳定）；concept/architect en 输出英文+words 单位；GenView 平台 optgroup+语言单选+en 词数文案
- **健康门禁**：coverage 门修复（a96158d）；smoke 3/3 绿（026a211 修注释误报，R29 checker 不放松）；esbuild 平台二进制 --no-save 补齐（R30，package.json 零改动）；eslint 变更文件 0 错
- **打包**：`npm run pack:win` 成功——release\墨书网文写作台-0.1.0-x64.exe（NSIS 86MB）+ -portable.exe（86MB）+ blockmap；better-sqlite3 按 Electron 33.4.11 x64 重编；无证书签名跳过
- 测试终态：88 文件 / 1260 用例全绿（+1 skip 守卫冒烟）；三 tsconfig typecheck 0 错

## 8. 醒来后三件事（2026-11-04 P2-UI 完成版）

**P2-UI 已完成**：31 commits（3d3c92c 用户外壳 WIP 基线 → 1631609 终审修复波）。墨韵国风进 app：ink 主题=墨蓝 #0F1626+香槟金 CTA+朱砂印 mark+衬线正文 16px/2.15；四组导航（创作/资产/灵感/输出+「设计中」soon 态）；PipelineBar 八节点；章节树四色状态点；审稿一级入口回补；MODE_LABELS 单一来源。**hover 同族缺陷战役 R37-R39**：global.css 特异性洗掉实底按钮反色字（1.25:1）——修 7 处含"确认回滚"钮，回归钉升级为派生式扫描，10 处全集入 SOLID_BUTTON_CENSUS 棘轮。**新皮肤首包**：release\墨书网文写作台-0.1.0-x64.exe / -portable.exe（13:28，86MB）；三张冒烟截图 `.superpowers/sdd/2026-11-04-p2ui-guofeng-reskin/shots2\`；冒烟夹具已清（dev 库 projects=0）；electron 杀净；测试终态 1312 用例全绿。

1. **目检新皮肤**：直接开 `release\墨书网文写作台-0.1.0-portable.exe` 或看 shots2 三张——**由你操作**。验证纪律（你明令）：你在用电脑时禁止前台测试（抢焦点/物理悬停/SetForegroundWindow），视觉核验只走 PrintWindow 后台抓窗或留给你
2. **合并决策**：31 commits 未合并未推送（master 的 14 个外壳文件已随 3d3c92c 入分支，工作区只剩 untracked docs）
3. **Phase 2 清单**（P2-UI 侧新增+既有）：soon 预算 +1.98px 脆账；paper dangerBtn 基态 3.69 例外；sem-err 族/border-faint 零引用待接；chart 系列可寻址；ambient 暗角设计决定；打包未签名杀软误报待实测；思源宋体随包字体决策（现落 SimSun）；architect skill 注入点；平台 select 历史值保留；表单回填；canon 重试口径；(project_id,status) 索引；E_PIPELINE_PARSE 码名；setStatus AND 守卫（全表见四份 ledger progress.md）

## 9. P2-UI 收尾 + P2-A 资产可见性（2026-11-06）

- **截断修复波**（6a23c1e + fb4a58d，R40-R42）：rail 展开档 168→184px（R41，168 在宋体下溢出）；R42 修 gap 死声明——裸 `.railSoon` 的同特异性 gap 被后写的 `.railBtn` 洗掉，级联胜者改为 `.railBtn.railSoon`，D 组预算测试升级为级联感知 + 变异取证。
- **P2-A 四任务**（a332e74→ba6ef99→8b554ee→7306ba8，R43 终审含并行 fb4a58d）：T1 `overlay.ts`（覆盖层文件读写+温度/附加要求段锚点，19 测试）；T2 `withOverlay` 接进 prompts（按角色分派，保持 await 通吃）；T3 `overlay-ipc`/`skills:list/match` 四件套接线；T4 **PromptView**（系统组入口：3 角色可编辑+6 角色诚实灰显+craft-skills 卡片+命中预览实时接 skills:match）。
- **终审判定：Merge-ready**（无 Critical；1374 passed/1 skip、coverage 65.55/81.35 过门、三 typecheck 0、lint 0、smoke 3/3、build 成功）。
  - **I-1（P2-B 首批工单）**：PromptView `openRole` 竞态——快速切角色时旧 `overlay:get` 后到会覆盖新角色表单，保存可把 A 角色文字写进 B 角色文件。3-5 行修复（请求序号守卫）。
  - I-2（**已收**）：PROJECT-STATUS 计数纠偏——invoke 61→**76**（终审说 66 也不准，四处声明实测逐字 76）、push 16→**17**、命令 13→**14**、迁移 v10→**v14**；P2-A 交互面条目已补。
- **新皮肤二包**：`release/repack-28/`（NSIS + portable，11:46），asar 内 grep 验证 `overlay:get`×4、级联胜者 `._railBtn._railSoon`、`layout-rail-expanded-w: 184px` 全在产物。**注意**：portable exe 的 dataDir 落在 exe 旁 `mozhou-data/`（data-dir.ts 的 PORTABLE_EXECUTABLE_DIR 机制），取证时写的测试覆盖层已随目录删除，包是干净的。
- **覆盖层真机取证（补上终审证据缺口）**：CDP 后台捕获（无前台抢焦点，遵守老板明令），5 张：`%TEMP%\moshu-shots\p2a-01..05`——页面全貌/表单填写/保存后「已覆盖 温度 0.85」徽标/命中预览「章末钩子三件套」/恢复默认二次确认框（已取消，未删文件）。落盘文件 `prompt-overlays/writer.md` 内容逐字节核验（温度行+## 附加要求段锚点齐全）。

## 10. 当前态一句话（2026-11-06）

HEAD **7306ba8**，分支 `p0-generation-pipeline` **38 commits 未合并未推送**（合并=老板决定）；工作区改动只有 docs（PROJECT-STATUS 计数纠偏+本文件）与 untracked `docs/superpowers/`。下一片：**P2-B 伏笔台账+人物记忆**，首批工单=I-1 openRole 竞态修复；前置条款：质检闭环落地时 EDIT_ROLES/SOON_ROLES/GenView ROLE_LABEL 三处角色词表必须收编为单一来源。之后依次 P2-C 灵感线四页、P2-D 导出与发布线。

## 11. P2-B 伏笔台账 + 人物记忆（2026-11-06）

- **七任务全部落地**（分支 p0-generation-pipeline，base 2f0e7c2 → HEAD）：
  - T1（741f75b→a695765）I-1 openRole 竞态修复 + `sequenced.ts` 请求序列器 + 扫描钉；
  - T2（dfec6d1）台账手录字段（name/weight/chain/goals/knows/notKnows/relations…全可选，旧行零迁移）+ `ledger-metrics.ts` 纯函数（WEIGHT_VALUE/debtSeries R48 章末口径/ledgerStatus/excerptAround）；
  - T3（6a9a587）`ledger:patch/remove` 手改通道——白名单+硬校验+项目域守卫，Agent 与作者共写一本账（R44）；
  - T4（bfdcdce + 修复波 a0b6ac8）**伏笔台账页**：债务趋势柱、红黄绿三档筛选、三级证据定位（章→摘录卡→编辑器）、项目切换重载与证据竞态守卫；
  - T5（a767794）迁移 **v15** `ledger_char_states`（章×人状态矩阵数据层）+ `charstate:set/list` 通道，remove 连带删快照（半删=事故）；
  - T6（bc9cf34）**人物记忆页**：人物卡+知识边界双栏（知/不知）+章×人矩阵+环形关系图；
  - T7（e89235a + 本 docs 提交）**装配消费接线**：`PipelineCtx` 增 `foreshadowLines/castLines`（ctx.ts 真读台账，坏 ref 整行跳、resolved 不入账）；assemble 新增 `foreshadow` 槽（条目级 rank=权重、牺牲序 6=活到最后）与 `cast` 槽（整块 rank 1、牺牲序 5），硬顶各 1200 tokens 复用 `fitCraftSkillEntries`（新增 sep 参数，R25 条目边界不截半条）；空账诚实占位（canon 同型）；`tests/integration/p2b-acceptance.test.ts` 四场景真库端到端（入账过滤/近况拼装/空账占位/预算挤压条目级丢弃顺序）。**台账页面自此不是装饰品**。
- **裁决 R44-R48**：正本在 `.superpowers/sdd/2026-11-06-p2b-ledgers-memory/progress.md`（controller 维护）——R44 不建平行账（复用 ledger_*，只有章×人矩阵开 v15 新表）；R45 T7 只动 user 侧装配、写手 system 字节稳定不碰；R46 渲染层接线用源码扫描钉、可测逻辑下沉 shared 纯函数；R47 计划文本缺陷按契约方向修正；R48 debtSeries 判章末口径。
- **实测计数（2026-11-06 P2-B 收口复测，四处声明逐字相等）**：invoke **80**（76→80，P2-B 新开 `ledger:patch`/`ledger:remove`/`charstate:set`/`charstate:list` 4 条）、push **17**（无新增）、命令面板 **16**（+2 页各一条）、迁移 **v15**；coverage 门 lines **66.73%**/functions **81.86%**（65.55→66.73 只涨未跌）；全量 **1453 passed / 1 skip**、三 tsconfig typecheck 0 错、lint 0 错 1 警（既有 PromptView non-null 警告，progress 已记）、smoke 3/3。
- **下一步**：**P2-C 灵感线四页**、**P2-D 导出与发布线**（既定顺序）；终审波输入继续累积（各 task report 的 minor deferred 全在 sdd ledger）。
