/**
 * IPC 契约（架构 §2.3）。
 *
 * **铁律**：通道名集中在此定义，preload/channels.ts 从中取值，
 * 禁止在业务代码里手写字符串通道名。契约先冻结再写实现，否则后面全返工（T02 是架构级卡点）。
 */
import type { LlmStatus, LlmProgress } from './provider';
import type {
  Chapter,
  ChapterMeta,
  DailySummary,
  MdImportOutcome,
  Project,
  StyleProfile,
  Volume,
} from './project';
import type { ChapterAnalysis, HealthReport, IssueLocation, LocatedIssue, RuleInfo } from './health';
import type { ChangeSet, ToolSpec } from './tool';
import type { LedgerQuery, LedgerConflict, CharacterProfile, LedgerEntries, LedgerCounts, Foreshadow, CharState, TimelineEvent, NumberAnchor } from './ledger';
import type { Checkpoint, RollbackResult } from './checkpoint';
import type { RunState, RunBudget, TerminationReason, RunStats, StepRecord } from './agent';
import type { ToolDanger, WritePolicy, WritePolicyConfig } from './tool';
import type { Draft, DraftStatus, CanonEntry, TrimTrace } from './pipeline';
import type { CardKind, ChartFetchResult, InspirationCard, Platform, TeardownDims, TeardownStructure, Topic, TopicStatus } from './inspiration';
import type { ExportHistoryRow, ExportPreviewRes, ExportRunReq, ExportRunRes } from './export';
import type { PublishPlan, PublishPlanSaveReq, PublishQueueRes, StageOutcome, StagingRow } from './publish';

// ───────────────────────── 请求/响应载荷 ─────────────────────────

export interface OpenProjectPayload {
  /** 目录绝对路径；主进程会做路径规范化防目录穿越 */
  dir: string;
}

export interface SaveChapterPayload {
  chapterId: string;
  body: string;
  /** 乐观锁：不匹配则报 E_REVISION_CONFLICT */
  expectedRev: number;
}

export interface AgentRunPayload {
  goal: string;
  /** 限定范围；空 = 全项目 */
  chapterIds?: string[];
  /** 覆盖默认预算 */
  budget?: Partial<{
    maxSteps: number;
    maxTokens: number;
    maxCostCny: number;
    maxWallMs: number;
  }>;
  /** 覆盖写策略；不传用用户设置 */
  writePolicy?: WritePolicyConfig;
}

export interface UndoPayload {
  /** 回滚到该 checkpoint 之前 */
  checkpointId: string;
  /** 是否跳过「丢失手动修改」确认（UI 已确认过才传 true） */
  force?: boolean;
}

export interface ToolPreviewPayload {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ConfigureLlmPayload {
  providerId: string;
  baseUrl?: string;
  model?: string;
  /** 明文 Key，只在主进程落盘（safeStorage 加密），永不经 contextBridge 返回 */
  apiKey?: string;
  /** 是否重新探测能力 */
  reprobe?: boolean;
}

// ★ P2-D T3：旧 ExportPayload（kind md/csv/zip + 假 zip 拼接 + csv）随
//   export-ipc 重建退役（P2D-R4）——导出契约单份在 ./export.ts。

// ───────────────────────── invoke 通道 ─────────────────────────

/** 请求 → 响应 的类型映射。渲染层的 mz.xxx 方法由这张表推导，杜绝手写错配。 */
export interface IpcInvokeMap {
  'app:getPaths': { req: void; res: { userData: string; documents: string } };
  'app:window': { req: { action: 'minimize' | 'maximize' | 'close' }; res: void };

  /**
   * 弹原生目录选择器，返回选中的绝对路径；**用户按取消返回 null**。
   * ★ 取消是正常结果不是错误：res 带 null 就是为了逼调用方早退，
   *   而不是把 null 当目录丢给 project:open 去抛一个吓人的错。
   */
  'project:pick-dir': { req: void; res: string | null };
  'project:open': { req: OpenProjectPayload; res: Project };
  'project:close': { req: void; res: void };
  'project:list': { req: void; res: Project[] };
  'project:save': { req: void; res: Project };
  'project:volumes': { req: void; res: Volume[] };
  /** 新建一卷（ord 由主进程追加，渲染层不数） */
  'project:create-volume': { req: { title: string }; res: Volume };
  /**
   * 设千字单价（元），用于稿费预估。传 0 表示清空。
   * 非负有限数由主进程校验，渲染层不做校验逻辑。
   */
  'project:set-price': { req: { pricePerK: number }; res: Project };
  /**
   * 生成流水线的立项参数（T6/R3）：写 v12 补的 genre/platform/chapter_words 真列。
   * 数值口径在 ProjectRepo.setPipelineParams（拒非整数/负数），IPC 边界只做形状守卫。
   * res 回写库后的真值——渲染层没有独立的读通道，保存成功后以这份回读对齐表单。
   * P1-B T3：req 增可选 language（'zh'|'en'，写 v14 列）——缺省不改原值；
   * 枚举校验在 repo（setPipelineParams），边界只拦非枚举的透传值。
   */
  'project:set-gen': {
    req: { projectId: string; genre: string; platform: string; chapterWords: number; language?: 'zh' | 'en' };
    res: { genre: string; platform: string; chapterWords: number; language: 'zh' | 'en' };
  };
  /** 拖拽重排卷册：ids 必须是当前全部卷的一个排列 */
  'project:reorder-volumes': { req: { ids: string[] }; res: Volume[] };

  'chapter:list': { req: void; res: ChapterMeta[] };
  'chapter:get': { req: { chapterId: string }; res: Chapter };
  'chapter:update': { req: SaveChapterPayload; res: ChapterMeta };
  /**
   * 新建一章。★ 请求体里故意**没有章节号**：id 就是主键也是章节号，
   * 由主进程按"现有最大号 + 1"算——让界面传主键，双击就是两条同号章或撞主键。
   * 空标题允许（先建章再想名字是常态），界面按 `第N章` 兜底显示。
   */
  'chapter:create': {
    req: { title: string; volumeId: string | null };
    res: ChapterMeta;
  };
  /** 拖拽重排章节：只改 ord，不动正文与 rev */
  'chapter:reorder': { req: { ids: string[] }; res: ChapterMeta[] };
  /** 把章挪进某卷；volumeId=null 表示移出到「未分卷」 */
  'chapter:set-volume': {
    req: { chapterId: string; volumeId: string | null };
    res: ChapterMeta;
  };
  /**
   * 改章节标题（§4 第 19 条①）。
   * ★ 只改标题：**不动 `rev`**，也不动正文与 `updated_at`。
   *   改了 rev 会让编辑器里那份未保存的正文在下次保存时撞上乐观锁——
   *   用户感知就是"我改了个标题，怎么写不回去了"。空标题允许，界面按 `第N章` 兜底。
   */
  'chapter:set-title': {
    req: { chapterId: string; title: string };
    res: ChapterMeta;
  };
  /**
   * 导入 `chapters/*.md` 旧稿（§4 第 19 条②）。
   * ★ req 是 void：要扫的目录永远是**当前项目**的 `chapters/`，故意不给界面传路径——
   *   那等于开一个目录穿越的口子（见 `resolveInProject` 的防线）。
   *   非破坏性：库里已有同号就跳过、正文绝不覆盖，磁盘上的 .md 一个都不删不改。
   *   只在用户显式点「导入旧稿」时调用，打开项目时**不自动跑**。
   */
  'chapter:import-md': { req: void; res: MdImportOutcome };

  'health:analyze': { req: { chapterIds?: string[] }; res: ChapterAnalysis[] };
  'health:report': { req: { chapterIds?: string[] }; res: HealthReport };
  'health:locate': { req: { metric: string; chapterIds?: string[] }; res: IssueLocation[] };
  /**
   * 编辑器行内标注专用（§4 第 20 条②）：把**这一章**所有偏差项一次定位完。
   *
   * ★ 为什么不复用 `health:locate` 让渲染层按指标循环调：
   *   1. 判定（哪些项超标）与坐标必须出自**同一份正文快照**。分 N 次调的话中间
   *      自动保存一落盘，标注就会莫名消失——用户看到的是"我没改它，线没了"；
   *   2. `IssueLocation` 只有 `at` 没有长度，画不出区间，也没有能逐字回验的片段，
   *      所以这条通道回的是 `LocatedIssue`（at + length + excerpt）。
   *      那是 UI 形状，不该塞给 Agent——工具返回值会原样进提示词。
   *   3. 渲染层因此不需要知道"哪些指标可定位、radius 多少"，这些口径留在主进程。
   * 只读通道：不落 checkpoint、不写盘，与 `health:analyze` 同一档。
   */
  'health:locate-chapter': { req: { chapterId: string }; res: LocatedIssue[] };
  'health:rules': { req: { layer?: string }; res: RuleInfo[] };

  /** ★P2-B T4：res 补 foreshadows——伏笔台账页（mode:foreshadow）要读同一本账，
   *  不新开平行通道；kind 过滤语义不变（conflicts 按 kind 筛，其余全量回）。
   *  ★P2-E ②：res 再补 timeline/numbers——长期记忆页（mode:longterm）的事件流
   *  与数字锚点同样读这本账（repo 方法早在，只缺 IPC 出口），仍零新通道。 */
  'ledger:query': { req: LedgerQuery; res: { conflicts: LedgerConflict[]; characters: CharacterProfile[]; foreshadows: Foreshadow[]; timeline: TimelineEvent[]; numbers: NumberAnchor[] } };
  'ledger:upsert': { req: { entries: LedgerEntries }; res: LedgerCounts };
  // ── 手改通道（★P2-B T3：Agent 与作者共写一本账）───────────────────
  /**
   * 白名单合并更新（只开 character/foreshadow——number/timeline 是 Agent 的
   * 证据账，手改结构字段等于伪造出处）。res 固定 true：改没改成由抛错说话
   * （不存在 → E_NOT_FOUND，白名单/值域违规 → E_INVALID_ARGS），不返布尔让 UI 猜。
   */
  'ledger:patch': {
    req: { kind: 'character' | 'foreshadow'; id: string; patch: Record<string, unknown> };
    res: true;
  };
  /** 删一条账。四类全开；不存在返回 {ok:false} 不抛（与 canon:remove 同口径，删除是幂等收尾） */
  'ledger:remove': {
    req: { kind: 'character' | 'foreshadow' | 'number' | 'timeline'; id: string };
    res: { ok: boolean };
  };

  // ── 章×人物状态矩阵（★P2-B T5：v15 ledger_char_states 的读写入口）────────
  /** 项目全部快照，按章号升序（序在库侧定死）。req {projectId} 照 canon:list 口径：必须等于当前打开项目 */
  'charstate:list': { req: { projectId: string }; res: CharState[] };
  /** 写一章×一人快照（同人同章 upsert 覆盖，不增行）；projectId 由主进程从当前项目派生，不经界面传 */
  'charstate:set': { req: { characterId: string; chapterNo: number; snapshot: string }; res: CharState };

  'tool:list': { req: void; res: ToolSpec[] };
  'tool:preview': { req: ToolPreviewPayload; res: ChangeSet };
  'tool:execute': { req: ToolPreviewPayload; res: ChangeSet };

  'agent:run': { req: AgentRunPayload; res: { runId: string } };
  'agent:abort': { req: { runId: string }; res: void };
  'agent:pause': { req: { runId: string }; res: void };
  'agent:resume': { req: { runId: string }; res: void };
  'agent:state': { req: { runId?: string }; res: RunState | null };
  'agent:history': { req: { limit?: number }; res: RunState[] };

  'checkpoint:list': { req: { runId?: string }; res: Checkpoint[] };
  'checkpoint:undo': { req: UndoPayload; res: RollbackResult };

  'llm:status': { req: void; res: LlmStatus };
  'llm:configure': { req: ConfigureLlmPayload; res: LlmStatus };
  'llm:test': { req: void; res: { ok: boolean; message: string } };
  /** 仪表盘聚合统计（真实数据聚合，无 mock） */
  'dash:stats': { req: void; res: DashStats };

  'style:profile': { req: void; res: StyleProfile | null };
  'style:rebuild': { req: { chapterIds?: string[] }; res: StyleProfile };

  // ── P2-D 导出三通道（T3）：契约单源 @shared/types/export ──
  // preview 复用 ExportRunReq 形（少一处漂移）：dest 字段预览时被忽略，字节与 dest 无关。
  'export:run': { req: ExportRunReq; res: ExportRunRes };
  'export:preview': { req: ExportRunReq; res: ExportPreviewRes };
  'export:history': { req: { limit?: number }; res: ExportHistoryRow[] };

  // ── 专家团（阶段三：UI 手动触发入口）────────────────────────────────
  /** 手动触发一次专家团评审（不依赖 Agent） */
  'expert:review': {
    req: { stage: ExpertStage; chapterIds: string[]; roles?: string[] };
    res: { reviewId: string; report: unknown; failures: { role: string; reason: string }[] };
  };
  /** 评审历史 */
  'expert:history': { req: { limit?: number }; res: unknown[] };
  /** 单次评审的完整意见（裁决交互用） */
  'expert:opinions': { req: { reviewId: string }; res: unknown[] };
  /** 作者对某维度做最终裁决（defer 项的处理入口） */
  'expert:decide': {
    req: { reviewId: string; dimension: string; decision: 'accept' | 'reject' };
    res: void;
  };
  /** 专家团配置 */
  'expert:config': { req: void; res: unknown };
  'expert:configure': { req: { config: unknown }; res: unknown };
  /** 可用角色列表（UI 渲染勾选项） */
  'expert:roles': {
    req: void;
    res: { key: string; displayName: string; mission: string; defaultWeight: number }[];
  };

  // ── AI 味检测（独立板块，前缀 aiFlavor:）──────────────────────────
  /** 检测指定章节，返回完整报告（含分段得分与命中定位） */
  'aiFlavor:scan': {
    req: { chapterIds?: string[]; useCache?: boolean };
    res: FlavorScanResult[];
  };
  /** 读取某章最近一次检测结果 */
  'aiFlavor:latest': { req: { chapterId: string }; res: FlavorScanResult | null };
  /** 分数趋势（画曲线用） */
  'aiFlavor:trend': {
    req: { chapterId: string; limit?: number };
    res: { index: number; level: string; at: number }[];
  };
  /**
   * 执行改写。两条路径二选一：
   *   auto-rule = 本地规则改写（不调 LLM）
   *   agent     = 交给主 Agent 重新生成
   */
  'aiFlavor:rewrite': {
    req: {
      chapterId: string;
      path: 'auto-rule' | 'agent';
      dimensions?: string[];
      paragraphNos?: number[];
      /** true = 只返回结果不落盘（预览） */
      dryRun?: boolean;
    };
    res: {
      changedCount: number;
      beforeIndex: number;
      afterIndex: number;
      delta: number;
      newText: string;
      edits: { from: string; to: string; offset: number; why: string }[];
      rejected: { offset: number; reason: string }[];
      agentHandoff: { count: number; offsets: number[] };
      runId?: string;
      message: string;
    };
  };
  /** 改写历史（前后分对比） */
  'aiFlavor:rewriteHistory': { req: { chapterId: string }; res: unknown[] };
  /** 板块配置（维度开关、阈值、权重） */
  'aiFlavor:config': { req: void; res: unknown };
  'aiFlavor:configure': { req: { config: unknown }; res: unknown };
  /** 板块定位说明（写作体检而非 AI 判决） */
  'aiFlavor:about': { req: void; res: { disclaimer: string; engineVersion: string } };
  /** 当前生效的 AI 味基线（有用户基线用用户的，否则内置默认） */
  'aiFlavor:baseline': { req: void; res: FlavorBaselineInfo };
  /** 用当前项目语料**重建**用户基线并保存（样本不足则不保存，继续用默认） */
  'aiFlavor:rebuildBaseline': { req: { chapterIds?: string[] }; res: FlavorRebuildResult };

  // ── P0 生成流水线（T5：六通道 + pipeline:progress 推送）─────────────
  /**
   * 构思生成。产出**只进草稿隔离区**（定稿主权），采纳走 pipeline:adopt-draft。
   * 进度经 pipeline:progress 推送（step=concept），failed 的 detail 带真因。
   */
  'pipeline:run-concept': { req: { projectId: string }; res: { draftId: string } };
  /** 大纲生成：不传 volumeIndex = 任务①全书规划；传了 = 任务②续写该卷章纲（需已有采纳的卷纲，否则 E_PIPELINE_STATE） */
  'pipeline:run-outline': {
    req: { projectId: string; volumeIndex?: number };
    res: { draftId: string };
  };
  /**
   * 正文起草：chapterNo 必须是正整数（从 1 起算）；产出只进草稿区。
   * ★ D批 D1（channel RESHAPE，照 publish:queue res 加 staged 真源先例，CH 计数不动）：
   *   res 带上装配裁剪 trace——handler 唯一 ok:true 出口恒回传 TrimTrace[]
   *   （含 P1B-T2 降级续写路径：续写复用同一份装配，trace 不变），渲染层据此
   *   展示「装配裁剪审计」。retries/shortfall 仍只在 handler data 里，不上浮。
   */
  'pipeline:write-draft': {
    req: { projectId: string; chapterNo: number; planItem: { title: string; hook: string } };
    /**
     * ★ D批 RESHAPE 带 trace；★ 裁决修复波 H4 再上浮 retries/shortfall：
     *   handler（tools.ts 唯一 ok:true 出口）早就算好了「降级续写几次」「续写后
     *   是否仍不足目标一半」，IPC 不往上浮就是**能力存在却不暴露**——而 P1-B 的
     *   裁决写着「半章草稿交作者判断」，作者看不到 shortfall 就无从判断。
     */
    res: { draftId: string; trace: TrimTrace[]; retries: number; shortfall: boolean };
  };
  'pipeline:list-drafts': { req: { projectId: string; status?: DraftStatus }; res: Draft[] };
  /**
   * 采纳草稿（正文入正稿的**唯一入口**）：
   * kind=chapter → 无 chapterId 则建章，再经 updateBody 写入正文，返回 chapterId；
   * kind=concept/outline → 仅标记 adopted（作为后续步骤的输入源），chapterId 为 null。
   */
  'pipeline:adopt-draft': { req: { draftId: string }; res: { chapterId: string | null } };
  /** 弃稿：pending → discarded，单向终局，不可改判 */
  'pipeline:discard-draft': { req: { draftId: string }; res: { ok: true } };

  // ── 世界观铁律 canon（P1-A T2：三通道，保护层真数据源）──────────────
  /**
   * 铁律列表（按录入序）。projectId 必须与当前打开项目一致——
   * 不许拿 A 书的 id 读 B 书的铁律（与 pipeline 六通道同款守卫）。
   */
  'canon:list': { req: { projectId: string }; res: CanonEntry[] };
  /**
   * 新增铁律。trim/去空行/判空口径在 CanonRepo；空文本 → E_INVALID_ARGS，
   * detail 带 {retryable:false}（T1 评审 minor-1：渲染层据此不画重试按钮）。
   */
  'canon:add': { req: { projectId: string; text: string }; res: CanonEntry };
  /** 删除铁律。不存在返回 {ok:false} 而不抛（删除是幂等的收尾动作） */
  'canon:remove': { req: { projectId: string; id: string }; res: { ok: boolean } };

  // ── 提示词覆盖层与工艺技能表（P2-A T3：五通道）─────────────────────
  /**
   * 读角色覆盖层。文件不存在 = 默认态（exists:false，overlay:null，零 warning）。
   * template = serializeOverlay 生成的**默认模板**（温度留空、附加要求为空），
   * 供 UI「恢复默认」预览——它与当前存的覆盖层内容无关。
   */
  'overlay:get': { req: { role: OverlayRole }; res: OverlayGetResult };
  /**
   * 保存覆盖层。temperature=null = 沿用内置（合法态）；给了数值必须是 0~2，
   * 否则 E_INVALID_ARGS + detail {retryable:false}（与 canon 边界同口径）。
   */
  'overlay:save': {
    req: { role: OverlayRole; temperature: number | null; additional: string };
    res: { ok: true };
  };
  /** 删除覆盖层文件 = 恢复默认。existed=false 表示文件本来就不存在（幂等） */
  'overlay:remove': { req: { role: OverlayRole }; res: { existed: boolean } };
  /** craft-skills 全量（注册序即返回序，渲染层直接浏览六卡） */
  'skills:list': { req: void; res: CraftSkillInfo[] };
  /**
   * 命中预览：纯函数直暴露（渲染层输入框实时调）。role 只开放
   * 'writer' | 'architect'——polisher 零技能、concept 不适用触发词匹配，
   * 传别的 → E_INVALID_ARGS（R42：不开假入口）。
   */
  'skills:match': {
    req: { text: string; role: 'writer' | 'architect' };
    res: { ids: string[]; titles: string[] };
  };

  // ── P2-C 灵感线（T2：扫榜热榜 + 卡片/选题池五通道）─────────────────
  /**
   * 抓榜。数据源礼貌直抓（robots 先行/缓存/限速），失败**如实回落演示集**：
   * source='demo' 时 error 带真因，entries 全部 live:false——绝不冒充实时数据。
   * 全局通道：不要求已打开项目（灵感卡片在立项之前就存在）。
   */
  'trending:fetch': { req: { platform: Platform }; res: ChartFetchResult };
  /**
   * 手动导入榜单（C批）：粘贴文本/CSV（每行一本：排名,书名,作者,热度,链接,标签）。
   * 诚实第三态：res.source='manual'，entries 全部 live:false + manual:true——
   * UI 标「手动导入」，绝不标「实时/演示」。解析失败/超上限抛真因，不静默回空。
   * 全局通道：不要求已打开项目（灵感卡片在立项之前就存在）。
   */
  'trending:import': { req: { platform: Platform; text: string }; res: ChartFetchResult };
  /**
   * 卡片列表：kind=三类 → 按类取；kind='collected' → 选题池取数口；
   * 缺省 → 三类合并（新在前）。
   */
  'inspiration:list': { req: { kind?: CardKind | 'collected' }; res: InspirationCard[] };
  /** 收藏进选题池（setCollected(id,true)）；卡不存在 → E_NOT_FOUND */
  'inspiration:collect': { req: { cardId: string }; res: InspirationCard };
  /** 删卡（幂等：不存在回 false 不抛，canon:remove 同款口径） */
  'inspiration:remove': { req: { cardId: string }; res: boolean };
  /**
   * 套用入口：卡片 → 待立项选题。title/premise 按 kind 派生
   * （trend=书名＋tags 拼一句；idea=payload.premise；teardown=payload.summary），
   * sourceCardId 记来源卡。
   */
  'topic:create-from-card': { req: { cardId: string }; res: Topic };
  /**
   * 抽脑洞（P2-C T4）：选方向（反重复）→ LLM 产出 → zod → 落 kind='idea' 卡。
   * 无 Key/失败如实回落演示占位（source='demo'、payload.live=false），绝不冒充模型产出。
   * 全局通道：不要求已打开项目。回卡自带 id，收藏/套用直接拿它走 inspiration:collect /
   * topic:create-from-card。
   */
  'idea:draw': { req: void; res: { card: InspirationCard; source: 'live' | 'demo' } };
  /**
   * 拆书结构统计（P2-C T5）：**零 token**——复用 digest 蒸馏 + metrics-engine 统计
   * 秒出结构卡并落 teardown_reports。不碰 LLM、不写正文（选书走只读通道）。
   * 全局通道：不要求已打开项目。
   */
  'teardown:structure': { req: { title: string; text: string }; res: { reportId: string; structure: TeardownStructure } };
  /**
   * 八维精读（P2-C T5，按需花 token）：LLM+契约过 → source='live'；
   * 无 Key/产出坏 → 演示兜底 source='demo'（可确定维度走统计，其余标「演示·未精读」）。
   */
  'teardown:read': { req: { reportId: string }; res: { dims: TeardownDims; source: 'live' | 'demo' } };
  /** 一维存灵感库（P2-C T5）：kind='teardown' 卡，回卡自带 id（收藏/套用直接拿它） */
  'teardown:save-dimension': { req: { reportId: string; dimension: string }; res: InspirationCard };

  // ── P2-C 灵感线（T6）：选题库生命周期三通道 ────────────────────────
  /**
   * 选题列表（全局子系统，不要求已打开项目）。status 缺省 = 三态全量（新在前）；
   * 非法枚举在门口 E_INVALID_ARGS（topic-service zod，口径同 inspiration:list）。
   */
  'topic:list': { req: { status?: TopicStatus }; res: Topic[] };
  /**
   * 立项（P2-C T6 / R5 裁决）：handler **先建/开项目再播 premise**——
   * dir 来自入参，缺省走 project:pick-dir 式原生目录选择；随后复用
   * services.openProject 既有流拿 projectId，promoteTopic 置已立项 + linkProject。
   * ★ res 可为 null：用户取消目录选择是正常结果不是错误（project:pick-dir 同口径）。
   * ★ premiseKept（T7/BLOCK-T7 覆写守卫）：true = 该书已有非空不同 premise，
   *   本次**未覆写**（立项照常），UI 须如实提示「已有一句话故事，未覆盖」。
   */
  'topic:promote': {
    req: { topicId: string; dir?: string };
    res: { projectId: string; topic: Topic; premiseKept: boolean } | null;
  };
  /**
   * 放弃（危险动作，UI 走 useConfirm 二次确认）：待立项 → 已放弃。
   * 单向终局由 TopicRepo.setStatus 守卫——终态改判抛 E_TOPIC_STATE，不静默吞。
   */
  'topic:abandon': { req: { topicId: string }; res: Topic };

  // ── P2-D 发布排期五通道（T6）：契约单源 @shared/types/publish ──────────
  // 队列**服务端推导**入队（P2D-R1：体量机检吃正文，渲染层拿不到就不许装算得出）；
  // stage 的 chapterIds 即已批准集（P2D-R2），服务端独立再清洗后只写项目根
  // staging/<platformId>/ 下的暂存新文件——零网络、零正文写（红线负对照钉）。
  /** projectId 不在 req——服务端取当前项目，越权他书 by construction 不可能 */
  'publish:plan-save': { req: PublishPlanSaveReq; res: PublishPlan };
  'publish:plan-list': { req: { includeArchived?: boolean }; res: PublishPlan[] };
  /** T7 携带修复：res 加 staged 两字段投影（暂存/已发布 chip 的服务端真源）——现通道改形，CH 计数不动 */
  'publish:queue': { req: { planId: string }; res: PublishQueueRes };
  'publish:stage': { req: { planId: string; chapterIds: string[] }; res: StageOutcome };
  /** 人工标记发布（UI 走 useConfirm 非 danger 档）；未暂存 → E_STAGING_STATE */
  'publish:mark-published': { req: { planId: string; chapterId: string }; res: StagingRow };
}

/**
 * 覆盖层开放角色。与 @main/pipeline/overlay.PromptOverlayRole **结构同一**——
 * shared 不 import main（分层纪律），同名口径靠 register.ts 的 Handler 类型
 * 在编译期钉死：两处任一侧漂移，三 typecheck 立红。
 */
export type OverlayRole = 'concept' | 'architect' | 'writer' | 'idea' | 'teardown';

/** 覆盖层解析结果 DTO（同上映射：与 main 侧 PromptOverlay 结构同一） */
export interface PromptOverlayInfo {
  role: OverlayRole;
  /** null = 沿用程序内置温度 */
  temperature: number | null;
  additional: string;
}

/** overlay:get 响应 */
export interface OverlayGetResult {
  exists: boolean;
  overlay: PromptOverlayInfo | null;
  /** 加载侧真因告警（缺段/温度非法/读盘失败），UI 黄字直报，不静默吞 */
  warnings: string[];
  /** 默认模板文本（serializeOverlay 生成），供「恢复默认」预览 */
  template: string;
}

/** craft-skills 单卡 DTO（与 @main/pipeline/craft-skills.CraftSkill 结构同一） */
export interface CraftSkillInfo {
  id: string;
  title: string;
  triggers: string[];
  roles: ('writer' | 'architect' | 'polisher')[];
  body: string;
}

/** 当前生效的 AI 味基线摘要（渲染层展示用；不含完整分位数） */
/** 仪表盘聚合统计（全部来自真实数据：chapterRepo / checkpointManager / AgentHost 用量） */
export interface DashVolume {
  id: string;
  title: string;
  /** 该卷章节数 */
  chapters: number;
  /** 该卷总字数 */
  chars: number;
  /** 稳定稿（done+revised）字数占比 0~100 */
  progressPct: number;
}

export interface DashStats {
  totalChars: number;
  chapterCount: number;
  /** 四状态计数：todo(大纲) / draft(草稿) / revised(待审) / done(已发布) */
  byStatus: { todo: number; draft: number; revised: number; done: number };
  volumes: DashVolume[];
  /** 检查点（改动历史）总数 */
  checkpoints: number;
  /** 本次进程内 Agent 循环累计的 LLM 用量；未跑过为 null */
  llm: { requests: number; tokensIn: number; tokensOut: number; costCny: number } | null;
  /**
   * 日增量（§4 第 3 条）：今日/昨日净增、连更天数、近 7 天序列、本月净增。
   * 净增可为负——那天删了字，如实反映。
   */
  daily: DailySummary;
  /** 千字单价（元）；0 = 用户未设置 */
  pricePerK: number;
  /**
   * 本月稿费预估（元）= 本月净增千字 × 单价。
   * ★ 未设单价时为 0，渲染层据此显示「未设单价」而不是「¥0」。
   */
  monthPay: number;
}

export interface FlavorBaselineInfo {
  /** builtin = 内置默认基线；user = 用户自建基线 */
  source: 'builtin' | 'user';
  /** 来源文案（语料名 / 「你的语料（N 章）」） */
  corpus: string;
  /** 参与基线的章数（内置默认 = 715） */
  chapters: number;
  /** 基线是否因**特征提取口径**变更而过期（建议重建） */
  stale: boolean;
  /** 生成该基线时的特征提取口径版本 */
  engineVersion: string;
}

/** 重建用户基线的结果 */
export interface FlavorRebuildResult {
  /** 实际参与计算的有效章数 */
  used: number;
  /** 因样本不足被跳过的章数 */
  skipped: number;
  /** 是否已保存（有效章数 < 10 时不保存） */
  saved: boolean;
  /** 可向用户披露的提示 */
  warnings: string[];
  /** 重建后**当前生效**的基线摘要（若未保存，则仍是原基线） */
  info: FlavorBaselineInfo;
}

/** 专家团评审阶段（与 expert 模块的 ReviewStage 同源，此处避免跨模块 import） */
export type ExpertStage = 'outline' | 'chapter' | 'post-polish';

/** AI 味检测结果（渲染层可见的 DTO，与 shared/types/ai-flavor 的 FlavorReport 一致） */
export interface FlavorScanResult {
  chapterId: string;
  index: number;
  level: string;
  chars: number;
  paragraphs: number;
  sufficient: boolean;
  insufficientReason?: string;
  dominantDimension: string | null;
  engineVersion: string;
  at: number;
  // ── v2 校准新增（T04 UI 用；可选字段，老报告反序列化不报错）──
  /** 本次用的是哪份基线（'default' | 'user'） */
  baselineId?: string;
  /** 基线来源文案（如「你的语料（N 章，按章分位数）」） */
  baselineSource?: string;
  /** 基线由旧特征口径生成（不阻断，降置信） */
  baselineStale?: boolean;
  /** 参与总评的「已校准」维度权重占比（0~1） */
  calibratedRatio?: number;
  dimensions: {
    dimension: string;
    score: number;
    level: string;
    skipped: boolean;
    measured: number | null;
    baseline: number | null;
    note: string;
    /** 该维度本次是否用了已校准基线（回退默认的维度为 false） */
    calibrated?: boolean;
    /** 基线置信度（high | medium | low） */
    confidence?: string;
    /** 原始偏离度 d（单位：正常带宽度），供 UI 原样展示 */
    deviation?: number | null;
    /** 该维度的「正常带」[p05, p95]；零膨胀/未判分维度为 null */
    band?: [number, number] | null;
  }[];
  paragraphs_: {
    no: number;
    start: number;
    end: number;
    score: number;
    level: string;
    chars: number;
    hitCount: number;
    topDimension: string | null;
  }[];
  hits: {
    dimension: string;
    kind: string;
    level: string;
    severity: number;
    excerpt: string;
    offset: number;
    length: number;
    paragraphNo: number;
    reason: string;
    advice: string;
  }[];
}

/** 通道名常量（由IpcInvokeMap 派生，保证与类型同源） */
export const IPC_CHANNELS = [
  'app:getPaths',
  'app:window',
  'project:pick-dir',
  'project:open',
  'project:close',
  'project:list',
  'project:save',
  'project:volumes',
  'project:create-volume',
  'project:set-price',
  'project:set-gen',
  'project:reorder-volumes',
  'chapter:list',
  'chapter:get',
  'chapter:update',
  'chapter:create',
  'chapter:reorder',
  'chapter:set-volume',
  'chapter:set-title',
  'chapter:import-md',
  'health:analyze',
  'health:report',
  'health:locate',
  'health:locate-chapter',
  'health:rules',
  'ledger:query',
  'ledger:upsert',
  // 手改通道（★P2-B T3）
  'ledger:patch',
  'ledger:remove',
  // 章×人物状态矩阵（★P2-B T5）
  'charstate:list',
  'charstate:set',
  'tool:list',
  'tool:preview',
  'tool:execute',
  'agent:run',
  'agent:abort',
  'agent:pause',
  'agent:resume',
  'agent:state',
  'agent:history',
  'checkpoint:list',
  'checkpoint:undo',
  'llm:status',
  'llm:configure',
  'llm:test',
  'dash:stats',
  'style:profile',
  'style:rebuild',
  'export:run',
  // P2-D 导出重建（T3）两枚新通道（★P2D-R4：假 zip/csv 退役，预览与历史上线）
  'export:preview',
  'export:history',
  // 专家团（阶段三）
  'expert:review',
  'expert:history',
  'expert:opinions',
  'expert:decide',
  'expert:config',
  'expert:configure',
  'expert:roles',
  // AI 味检测（独立板块）
  'aiFlavor:scan',
  'aiFlavor:latest',
  'aiFlavor:trend',
  'aiFlavor:rewrite',
  'aiFlavor:rewriteHistory',
  'aiFlavor:config',
  'aiFlavor:configure',
  'aiFlavor:about',
  'aiFlavor:baseline',
  'aiFlavor:rebuildBaseline',
  // P0 生成流水线（T5）
  'pipeline:run-concept',
  'pipeline:run-outline',
  'pipeline:write-draft',
  'pipeline:list-drafts',
  'pipeline:adopt-draft',
  'pipeline:discard-draft',
  // 世界观铁律 canon（P1-A T2）
  'canon:list',
  'canon:add',
  'canon:remove',
  // 提示词覆盖层与工艺技能表（P2-A T3）
  'overlay:get',
  'overlay:save',
  'overlay:remove',
  'skills:list',
  'skills:match',
  // P2-C 灵感线（T2）
  'trending:fetch',
  // C批：榜单手动导入（诚实第三态 manual，契约见 IpcInvokeMap 同名条目）
  'trending:import',
  'inspiration:list',
  'inspiration:collect',
  'inspiration:remove',
  'topic:create-from-card',
  // P2-C 灵感线（T4）：抽脑洞
  'idea:draw',
  // P2-C 灵感线（T5）：拆书报告三通道（结构统计零token / 八维精读 / 存灵感库）
  'teardown:structure',
  'teardown:read',
  'teardown:save-dimension',
  // P2-C 灵感线（T6）：选题库生命周期三通道（取数 / 立项=建开项目+播premise / 放弃）
  'topic:list',
  'topic:promote',
  'topic:abandon',
  // P2-D 发布排期（T6）：计划两枚 + 队列推导一枚 + 暂存/标记两枚（服务端推导，零网络零正文写）
  'publish:plan-save',
  'publish:plan-list',
  'publish:queue',
  'publish:stage',
  'publish:mark-published',
] as const;

export type IpcChannel = keyof IpcInvokeMap;

export function isIpcChannel(name: string): name is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(name);
}

// ───────────────────────── 主进程 → 渲染层推送 ─────────────────────────

/**
 * 单向推送通道。只有 main/ipc/push.ts 一个出口（架构 §2.3）。
 * 回调只拿**已序列化的只读 DTO**，不含任何类实例或函数。
 */
export interface IpcPushMap {
  'agent:step': {
    runId: string;
    step: StepRecord;
  };
  'agent:tool-call': {
    runId: string;
    stepNo: number;
    toolName: string;
    /** 该工具在 registry 中声明的回滚成本；null = 宿主未注入（不谎报） */
    danger: ToolDanger | null;
    /** 本次 run 实际生效的写策略；null = 同上 */
    writePolicy: WritePolicy | null;
    argsSummary: string;
  };
  'agent:change': {
    runId: string;
    checkpointId: string;
    chapterId: string;
    edits: ChangeSet['edits'];
    bytes: number;
  };
  'agent:checkpoint': {
    runId: string;
    checkpointId: string;
    stepNo: number;
    toolName: string;
    affectedChapters: string[];
    bytes: number;
  };
  'agent:side-effect': {
    runId: string;
    toolName: string;
    metric: string;
    before: number;
    after: number;
    bound: number;
    rolledBack: boolean;
    explanation: string;
  };
  'agent:preview': { runId: string; changeSet: ChangeSet };
  'agent:terminated': {
    runId: string;
    reason: TerminationReason;
    stats: RunStats;
    keptChanges: number;
  };
  'agent:need-approval': {
    runId: string;
    toolName: string;
    danger: number;
    argsSummary: string;
    changeSetSummary: string;
  };
  'agent:plan': { runId: string; plan: RunState['plan'] };
  /**
   * ★ 第 32 条：预算快照。渲染层的预算仪表靠它。
   *
   * 修复前这套数只有 `agent:state` 一条路能出来，而那是**拉通道**——
   * 渲染层从头到尾一次都没调过（`rg '\.state\(' src/renderer` 零命中）。
   * 用户能看到 `BUDGET_EXCEEDED`，却看不到自己离它还有多远。
   */
  'agent:budget': { runId: string; budget: RunBudget };
  /**
   * ★ 第 25 条：run 的阶段变化。只在**进入 paused** 与**从 paused 放走**两个时刻发，
   *   不是每个阶段都刷——其余阶段本来就有各自的事件（plan / tool-call / step）。
   *   没有这条通道时渲染层无从得知「暂停中」：`setStatus` 在全仓零调用方，
   *   status 只会是 planning／terminated 两个写死值。
   */
  'agent:phase': { runId: string; phase: RunState['status'] };
  'chapter:changed': { chapterId: string; rev: number; source: 'agent' | 'user' };
  'project:opened': { projectId: string };
  'project:closed': { projectId: string };
  'llm:status': LlmStatus;
  'checkpoint:rolled-back': {
    checkpointId: string;
    undone: number;
    lostManualEdits: number;
  };
  /**
   * 生成流水线进度（T5）。六通道里三个生成动作 + adopt 各推 running/done/failed；
   * failed 的 detail 带真因（error.code + message），不拟人化、不含糊。
   * 只读通道（list）与 discard 不推进度。
   */
  'pipeline:progress': {
    projectId: string;
    step: 'concept' | 'outline' | 'draft' | 'adopt';
    state: 'running' | 'done' | 'failed';
    detail?: string;
  };
  /**
   * 短产出路径（抽脑洞/拆书精读）的等待进度（E批「模型思考过程可见」）。
   * 老板报障「卡一晚上不知道他在干什么」的答案：等待秒数/阶段/已收字数/
   * 思考尾部片段全在这份 DTO 里，字段全部来自真实观测（见 LlmProgress 的
   * 诚实纪律注）。服务层节流后推送（≤5 次/秒），不灌 IPC。
   */
  'llm:progress': LlmProgress;
}

export const IPC_PUSH_CHANNELS = [
  'agent:step',
  'agent:tool-call',
  'agent:change',
  'agent:checkpoint',
  'agent:side-effect',
  'agent:preview',
  'agent:terminated',
  'agent:need-approval',
  'agent:plan',
  'agent:phase',
  'agent:budget',
  'chapter:changed',
  'project:opened',
  'project:closed',
  'llm:status',
  'checkpoint:rolled-back',
  // P0 生成流水线（T5）
  'pipeline:progress',
  // E批：短产出路径的等待进度（模型思考过程可见）
  'llm:progress',
] as const;

export type IpcPushChannel = keyof IpcPushMap;

// ───────────────────────── 全局错误码 ─────────────────────────

/**
 * 错误码（架构 §2.3）。每个码对应渲染层的**确定动作**，不能只弹个 toast。
 */
export const ERROR_CODES = {
  /** 参数校验失败 → 回喂 Agent 自纠 */
  E_INVALID_ARGS: 'E_INVALID_ARGS',
  E_TOOL_NOT_FOUND: 'E_TOOL_NOT_FOUND',
  /** 未放行的高危工具 → 弹确认框 */
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  E_NOT_PROJECT_FILE: 'E_NOT_PROJECT_FILE',
  /** 乐观锁冲突 → 提示重载 */
  E_REVISION_CONFLICT: 'E_REVISION_CONFLICT',
  E_LLM_TIMEOUT: 'E_LLM_TIMEOUT',
  E_LLM_AUTH: 'E_LLM_AUTH',
  E_LLM_RATE: 'E_LLM_RATE',
  E_LLM_NETWORK: 'E_LLM_NETWORK',
  /** 合规守卫拦截 → 不重试 */
  E_COMPLIANCE_BLOCKED: 'E_COMPLIANCE_BLOCKED',
  E_BUDGET_EXCEEDED: 'E_BUDGET_EXCEEDED',
  E_LOOP_DETECTED: 'E_LOOP_DETECTED',
  /** 已有 run 在跑 → 拒绝新 run */
  E_RUN_CONFLICT: 'E_RUN_CONFLICT',
  /** ★ v1.1：快照落盘失败 → 拒绝执行（fail-safe） */
  E_CHECKPOINT_FAILED: 'E_CHECKPOINT_FAILED',
  E_SNAPSHOT_LIMIT: 'E_SNAPSHOT_LIMIT',
  /** 回滚会覆盖用户后续手动修改 → 弹确认框明示「将丢失 N 处」 */
  E_ROLLBACK_CONFLICT: 'E_ROLLBACK_CONFLICT',
  /** provider 不支持所需能力 → 切单步模式 + 明示 */
  E_PROVIDER_CAPABILITY: 'E_PROVIDER_CAPABILITY',
  /** 本地模型无工具调用能力 → 降级并明示（不静默） */
  E_TOOLCALL_UNSUPPORTED: 'E_TOOLCALL_UNSUPPORTED',
  /** 启动时发现上次 run 未正常结束 */
  E_RUN_UNCLOSED: 'E_RUN_UNCLOSED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 带错误码的异常，供 IPC 层序列化回传 */
export class MzError extends Error {
  constructor(
    readonly code: ErrorCode | string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'MzError';
  }
}

/** 终止原因 → 人话（UI 直接显示这段，不要让渲染层自己拼） */
export const TERMINATION_TEXT: Record<string, string> = {
  GOAL_ACHIEVED: '目标已达成',
  MAX_STEPS: '已达步数上限',
  BUDGET_EXCEEDED: '已达预算上限',
  NO_PROGRESS: '连续多步无进展',
  LOOP_REPEAT_ARG: '检测到重复调用同一工具',
  LOOP_STATE_OSCILLATION: '检测到状态来回振荡',
  LOOP_NO_EFFECT: '检测到连续多步无任何效果',
  CONSECUTIVE_FAILURE: '连续多次工具失败',
  USER_ABORTED: '已被用户叫停',
  VALIDATION_FAILED: '参数校验未通过',
};