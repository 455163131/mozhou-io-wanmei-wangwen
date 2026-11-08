/**
 * preload 白名单 API（架构 §1.2 / T03）。
 *
 * ★★★ 安全边界 ★★★
 *   **绝不暴露 ipcRenderer 本身**。一旦裸奔，渲染层可调用任意主进程通道，
 *   tool:* 的权限声明与写策略全部失效。
 *
 *   暴露的是**按用例命名的业务方法**，不是引擎内部函数：
 *   - 渲染层拿不到 mzAnalyze / planFixes / FIX_RULES 任何内部函数
 *   - 渲染层拿不到 LLM apiKey 的读取（只有 hasKey 布尔值与掩码 displayKey）
 *   - 渲染层拿不到 db.query（schema 一变渲染层就崩）
 *   - 任何文件写入都走 project.*，主进程强制在项目根目录内做路径规范化
 */
import type {
  IpcInvokeMap,
  IpcPushMap,
  IpcChannel,
  IpcPushChannel,
  OverlayRole,
} from '@shared/types/ipc';
import type { LedgerEntries, LedgerQuery } from '@shared/types/ledger';
import type { DraftStatus } from '@shared/types/pipeline';

/** 白名单 API 的形状。由 MzBridge 暴露到 window.mz。 */
export interface MzBridge {
  // 应用
  getPaths(): Promise<IpcInvokeMap['app:getPaths']['res']>;
  window(action: 'minimize' | 'maximize' | 'close'): Promise<void>;

  // 项目
  project: {
    /** 原生目录选择器；取消返回 null（不是抛错） */
    pickDir(): Promise<IpcInvokeMap['project:pick-dir']['res']>;
    open(dir: string): Promise<IpcInvokeMap['project:open']['res']>;
    close(): Promise<void>;
    list(): Promise<IpcInvokeMap['project:list']['res']>;
    save(): Promise<IpcInvokeMap['project:save']['res']>;
    volumes(): Promise<IpcInvokeMap['project:volumes']['res']>;
    createVolume(title: string): Promise<IpcInvokeMap['project:create-volume']['res']>;
    reorderVolumes(ids: string[]): Promise<IpcInvokeMap['project:reorder-volumes']['res']>;
    /** 千字单价（元），0 = 清空；稿费预估的唯一输入 */
    setPrice(pricePerK: number): Promise<IpcInvokeMap['project:set-price']['res']>;
    /** 生成流水线的立项参数（T6/R3）；返回写库后的真值（渲染层无独立读通道，以此对齐表单）。
     *  P1-B T3：language 可选（'zh'|'en'），缺省不改原值。 */
    setGen(
      projectId: string,
      genre: string,
      platform: string,
      chapterWords: number,
      language?: 'zh' | 'en',
    ): Promise<IpcInvokeMap['project:set-gen']['res']>;
  };

  // 章节
  chapter: {
    list(): Promise<IpcInvokeMap['chapter:list']['res']>;
    get(chapterId: string): Promise<IpcInvokeMap['chapter:get']['res']>;
    update(chapterId: string, body: string, expectedRev: number): Promise<IpcInvokeMap['chapter:update']['res']>;
    /** 新建一章。章节号由主进程算，这里只给标题和归属卷 */
    create(payload: IpcInvokeMap['chapter:create']['req']): Promise<IpcInvokeMap['chapter:create']['res']>;
    reorder(ids: string[]): Promise<IpcInvokeMap['chapter:reorder']['res']>;
    setVolume(chapterId: string, volumeId: string | null): Promise<IpcInvokeMap['chapter:set-volume']['res']>;
    /** 改标题：只改 title，不动正文与 rev（见 IpcInvokeMap['chapter:set-title'] 的注释） */
    setTitle(chapterId: string, title: string): Promise<IpcInvokeMap['chapter:set-title']['res']>;
    /** 导入 chapters/*.md 旧稿。不传路径：目录固定是当前项目的 chapters/ */
    importMarkdown(): Promise<IpcInvokeMap['chapter:import-md']['res']>;
  };

  // 体检（只读）
  health: {
    analyze(chapterIds?: string[]): Promise<IpcInvokeMap['health:analyze']['res']>;
    report(chapterIds?: string[]): Promise<IpcInvokeMap['health:report']['res']>;
    locate(metric: string, chapterIds?: string[]): Promise<IpcInvokeMap['health:locate']['res']>;
    /** 编辑器行内标注：一次拿全这一章可定位的偏差项（§4 第 20 条②） */
    locateChapter(chapterId: string): Promise<IpcInvokeMap['health:locate-chapter']['res']>;
    rules(layer?: string): Promise<IpcInvokeMap['health:rules']['res']>;
  };

  // 账本
  ledger: {
    query(kind?: LedgerQuery['kind'], subject?: string): Promise<IpcInvokeMap['ledger:query']['res']>;
    upsert(entries: LedgerEntries): Promise<IpcInvokeMap['ledger:upsert']['res']>;
    /** ★P2-B T3 手改：白名单合并更新（character/foreshadow），违规抛错不返布尔 */
    patch(req: IpcInvokeMap['ledger:patch']['req']): Promise<IpcInvokeMap['ledger:patch']['res']>;
    /** 删一条账；不存在返回 {ok:false} 不抛 */
    remove(req: IpcInvokeMap['ledger:remove']['req']): Promise<IpcInvokeMap['ledger:remove']['res']>;
  };

  // ── 章×人物状态矩阵（★P2-B T5）：v15 快照的读写入口 ──
  charstate: {
    /** 项目全部快照（章号升序）；projectId 必须等于当前打开项目（canon:list 同款守卫） */
    list(projectId: string): Promise<IpcInvokeMap['charstate:list']['res']>;
    /** 写一格（同人同章覆盖）；空快照/非法章号 → E_INVALID_ARGS */
    set(req: IpcInvokeMap['charstate:set']['req']): Promise<IpcInvokeMap['charstate:set']['res']>;
  };

  // 工具
  tool: {
    list(): Promise<IpcInvokeMap['tool:list']['res']>;
    preview(toolName: string, args: Record<string, unknown>): Promise<IpcInvokeMap['tool:preview']['res']>;
    execute(toolName: string, args: Record<string, unknown>): Promise<IpcInvokeMap['tool:execute']['res']>;
  };

  // Agent
  agent: {
    run(payload: IpcInvokeMap['agent:run']['req']): Promise<IpcInvokeMap['agent:run']['res']>;
    abort(runId: string): Promise<void>;
    pause(runId: string): Promise<void>;
    resume(runId: string): Promise<void>;
    state(runId?: string): Promise<IpcInvokeMap['agent:state']['res']>;
    history(limit?: number): Promise<IpcInvokeMap['agent:history']['res']>;
    /** 订阅事件；返回取消订阅函数。回调只拿到只读 DTO */
    on<K extends IpcPushChannel>(
      channel: K,
      handler: (payload: IpcPushMap[K]) => void,
    ): () => void;
  };

  // Checkpoint / 改动历史
  checkpoint: {
    list(runId?: string): Promise<IpcInvokeMap['checkpoint:list']['res']>;
    undo(checkpointId: string, force?: boolean): Promise<IpcInvokeMap['checkpoint:undo']['res']>;
  };

  // LLM
  llm: {
    status(): Promise<IpcInvokeMap['llm:status']['res']>;
    configure(payload: IpcInvokeMap['llm:configure']['req']): Promise<IpcInvokeMap['llm:configure']['res']>;
    test(): Promise<IpcInvokeMap['llm:test']['res']>;
  };

  // 风格指纹
  style: {
    profile(): Promise<IpcInvokeMap['style:profile']['res']>;
    rebuild(chapterIds?: string[]): Promise<IpcInvokeMap['style:rebuild']['res']>;
  };

  // 导出
  exportArtifact(payload: IpcInvokeMap['export:run']['req']): Promise<IpcInvokeMap['export:run']['res']>;

  // ── 专家团（阶段三：UI 手动触发入口，不依赖 Agent）──
  expert: {
    /** 手动触发一次评审 */
    review(
      stage: IpcInvokeMap['expert:review']['req']['stage'],
      chapterIds: string[],
      roles?: string[],
    ): Promise<IpcInvokeMap['expert:review']['res']>;
    history(limit?: number): Promise<IpcInvokeMap['expert:history']['res']>;
    opinions(reviewId: string): Promise<IpcInvokeMap['expert:opinions']['res']>;
    /** 作者对 defer 项做最终裁决 */
    decide(reviewId: string, dimension: string, decision: 'accept' | 'reject'): Promise<void>;
    config(): Promise<IpcInvokeMap['expert:config']['res']>;
    configure(config: unknown): Promise<IpcInvokeMap['expert:configure']['res']>;
    roles(): Promise<IpcInvokeMap['expert:roles']['res']>;
  };

  // ── AI 味检测（独立板块，与专家团零耦合）──
  aiFlavor: {
    /** 检测指定章节（不传则全项目） */
    scan(chapterIds?: string[]): Promise<IpcInvokeMap['aiFlavor:scan']['res']>;
    latest(chapterId: string): Promise<IpcInvokeMap['aiFlavor:latest']['res']>;
    trend(chapterId: string, limit?: number): Promise<IpcInvokeMap['aiFlavor:trend']['res']>;
    /** 改写：auto-rule=本地规则 / agent=交给主 Agent */
    rewrite(payload: IpcInvokeMap['aiFlavor:rewrite']['req']): Promise<IpcInvokeMap['aiFlavor:rewrite']['res']>;
    rewriteHistory(chapterId: string): Promise<IpcInvokeMap['aiFlavor:rewriteHistory']['res']>;
    config(): Promise<IpcInvokeMap['aiFlavor:config']['res']>;
    configure(config: unknown): Promise<IpcInvokeMap['aiFlavor:configure']['res']>;
    /** 板块说明（含「写作体检而非 AI 判决」的免责声明） */
    about(): Promise<IpcInvokeMap['aiFlavor:about']['res']>;
    /** 仪表盘聚合统计（真实数据） */
    dashStats(): Promise<IpcInvokeMap['dash:stats']['res']>;
    /** 当前生效基线（用户自建优先，否则内置默认） */
    baseline(): Promise<IpcInvokeMap['aiFlavor:baseline']['res']>;
    /** 用当前项目语料重建用户基线（样本不足则不保存） */
    rebuildBaseline(chapterIds?: string[]): Promise<IpcInvokeMap['aiFlavor:rebuildBaseline']['res']>;
  };

  // ── P0 生成流水线（T5）：产物只进草稿隔离区，采纳才入正稿 ──
  pipeline: {
    runConcept(projectId: string): Promise<IpcInvokeMap['pipeline:run-concept']['res']>;
    /** 不传 volumeIndex = 全书规划；传了 = 续写该卷章纲（需已有采纳的卷纲） */
    runOutline(projectId: string, volumeIndex?: number): Promise<IpcInvokeMap['pipeline:run-outline']['res']>;
    writeDraft(
      projectId: string,
      chapterNo: number,
      planItem: { title: string; hook: string },
    ): Promise<IpcInvokeMap['pipeline:write-draft']['res']>;
    listDrafts(projectId: string, status?: DraftStatus): Promise<IpcInvokeMap['pipeline:list-drafts']['res']>;
    /** 采纳：kind=chapter 时正文经 updateBody 入正稿并返回 chapterId；concept/outline 仅标记 adopted */
    adoptDraft(draftId: string): Promise<IpcInvokeMap['pipeline:adopt-draft']['res']>;
    discardDraft(draftId: string): Promise<IpcInvokeMap['pipeline:discard-draft']['res']>;
    /** 订阅生成进度推送（pipeline:progress）；返回取消订阅函数 */
    onProgress(handler: (payload: IpcPushMap['pipeline:progress']) => void): () => void;
  };

  // ── 世界观铁律 canon（P1-A T2）：保护层真数据源 ──
  canon: {
    list(projectId: string): Promise<IpcInvokeMap['canon:list']['res']>;
    /** 空文本 → E_INVALID_ARGS（detail.retryable=false，不画重试按钮） */
    add(projectId: string, text: string): Promise<IpcInvokeMap['canon:add']['res']>;
    /** 不存在返回 {ok:false} 而不抛 */
    remove(projectId: string, id: string): Promise<IpcInvokeMap['canon:remove']['res']>;
  };

  // ── 提示词覆盖层（P2-A T3）：内置基线 + 覆盖层，删文件即恢复默认 ──
  overlay: {
    /** 读角色覆盖层。文件不存在 = 默认态；template = 默认模板（「恢复默认」预览用） */
    get(role: OverlayRole): Promise<IpcInvokeMap['overlay:get']['res']>;
    /** 保存。temperature=null = 沿用内置；非 0~2 → E_INVALID_ARGS（retryable:false） */
    save(
      role: OverlayRole,
      temperature: number | null,
      additional: string,
    ): Promise<IpcInvokeMap['overlay:save']['res']>;
    /** 删文件恢复默认。existed=false = 文件本来就不在（幂等） */
    remove(role: OverlayRole): Promise<IpcInvokeMap['overlay:remove']['res']>;
  };

  // ── 工艺技能表（P2-A T3）：浏览 + 命中预览（纯判定与装配器同一内核）──
  skills: {
    list(): Promise<IpcInvokeMap['skills:list']['res']>;
    /** 命中预览：role 只开放 writer/architect，其余 E_INVALID_ARGS */
    match(
      text: string,
      role: IpcInvokeMap['skills:match']['req']['role'],
    ): Promise<IpcInvokeMap['skills:match']['res']>;
  };

  // ── 扫榜热榜（P2-C T2）：礼貌直抓，失败如实回落演示集（source/error 说明真因）──
  trending: {
    fetch(platform: IpcInvokeMap['trending:fetch']['req']['platform']): Promise<IpcInvokeMap['trending:fetch']['res']>;
  };

  // ── 灵感卡片池（P2-C T2）：全局子系统，不要求已打开项目 ──
  inspiration: {
    /** kind=三类按类取；'collected'=选题池；缺省=三类合并（新在前） */
    list(kind?: IpcInvokeMap['inspiration:list']['req']['kind']): Promise<IpcInvokeMap['inspiration:list']['res']>;
    /** 收藏进选题池；卡不存在 → E_NOT_FOUND */
    collect(cardId: string): Promise<IpcInvokeMap['inspiration:collect']['res']>;
    /** 删卡（幂等：不存在回 false） */
    remove(cardId: string): Promise<IpcInvokeMap['inspiration:remove']['res']>;
  };

  // ── 选题（P2-C T2）：卡片套用入口 ──
  topic: {
    /** 卡片 → 待立项选题（premise 按 kind 派生，sourceCardId 挂钩） */
    createFromCard(cardId: string): Promise<IpcInvokeMap['topic:create-from-card']['res']>;
  };

  // ── 抽脑洞（P2-C T4）：选方向→LLM→落 idea 卡；无 Key/失败如实回落演示占位 ──
  idea: {
    /** 抽一张脑洞卡（回卡自带 id，收藏/套用直接拿它）；source 明示 live/demo */
    draw(): Promise<IpcInvokeMap['idea:draw']['res']>;
  };

  // ── 拆书报告（P2-C T5）：结构统计零token秒出 + 八维精读按需 + 一维存灵感库 ──
  teardown: {
    /** 结构统计（不碰 LLM，秒出）；title 允许空串（主进程兜「未命名范文」） */
    structure(
      title: string,
      text: string,
    ): Promise<IpcInvokeMap['teardown:structure']['res']>;
    /** 八维精读（live=模型产出 / demo=演示兜底，dims 里未精读维度标「演示·未精读」） */
    read(reportId: string): Promise<IpcInvokeMap['teardown:read']['res']>;
    /** 一维存灵感库（kind='teardown' 卡，回卡自带 id）；重复调用会落重复卡——UI 侧持会话防连点 */
    saveDimension(
      reportId: string,
      dimension: string,
    ): Promise<IpcInvokeMap['teardown:save-dimension']['res']>;
  };
}

/** 全部 invoke 通道（与 shared/types/ipc.ts 同源，禁止手写字符串） */
export const INVOKE_CHANNELS: IpcChannel[] = [
  'app:getPaths',
  'app:window',
  'project:pick-dir',
  'project:open',
  'project:close',
  'project:list',
  'project:save',
  'project:volumes',
  'project:create-volume',
  'project:reorder-volumes',
  'project:set-price',
  'project:set-gen',
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
  // 专家团
  'expert:review',
  'expert:history',
  'expert:opinions',
  'expert:decide',
  'expert:config',
  'expert:configure',
  'expert:roles',
  // AI 味检测
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
  'inspiration:list',
  'inspiration:collect',
  'inspiration:remove',
  'topic:create-from-card',
  // P2-C 灵感线（T4）：抽脑洞
  'idea:draw',
  // P2-C 灵感线（T5）：拆书报告三通道
  'teardown:structure',
  'teardown:read',
  'teardown:save-dimension',
];

/** 全部订阅通道 */
export const SUBSCRIBE_CHANNELS: IpcPushChannel[] = [
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
];