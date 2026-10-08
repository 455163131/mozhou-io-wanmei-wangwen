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
import type { IpcInvokeMap, IpcPushMap, IpcChannel, IpcPushChannel } from '@shared/types/ipc';
import type { LedgerEntries, LedgerQuery } from '@shared/types/ledger';

/** 白名单 API 的形状。由 MzBridge 暴露到 window.mz。 */
export interface MzBridge {
  // 应用
  getPaths(): Promise<IpcInvokeMap['app:getPaths']['res']>;
  window(action: 'minimize' | 'maximize' | 'close'): Promise<void>;

  // 项目
  project: {
    open(dir: string): Promise<IpcInvokeMap['project:open']['res']>;
    close(): Promise<void>;
    list(): Promise<IpcInvokeMap['project:list']['res']>;
    save(): Promise<IpcInvokeMap['project:save']['res']>;
    volumes(): Promise<IpcInvokeMap['project:volumes']['res']>;
    createVolume(title: string): Promise<IpcInvokeMap['project:create-volume']['res']>;
    reorderVolumes(ids: string[]): Promise<IpcInvokeMap['project:reorder-volumes']['res']>;
  };

  // 章节
  chapter: {
    list(): Promise<IpcInvokeMap['chapter:list']['res']>;
    get(chapterId: string): Promise<IpcInvokeMap['chapter:get']['res']>;
    update(chapterId: string, body: string, expectedRev: number): Promise<IpcInvokeMap['chapter:update']['res']>;
    reorder(ids: string[]): Promise<IpcInvokeMap['chapter:reorder']['res']>;
    setVolume(chapterId: string, volumeId: string | null): Promise<IpcInvokeMap['chapter:set-volume']['res']>;
  };

  // 体检（只读）
  health: {
    analyze(chapterIds?: string[]): Promise<IpcInvokeMap['health:analyze']['res']>;
    report(chapterIds?: string[]): Promise<IpcInvokeMap['health:report']['res']>;
    locate(metric: string, chapterIds?: string[]): Promise<IpcInvokeMap['health:locate']['res']>;
    rules(layer?: string): Promise<IpcInvokeMap['health:rules']['res']>;
  };

  // 账本
  ledger: {
    query(kind?: LedgerQuery['kind'], subject?: string): Promise<IpcInvokeMap['ledger:query']['res']>;
    upsert(entries: LedgerEntries): Promise<IpcInvokeMap['ledger:upsert']['res']>;
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
}

/** 全部 invoke 通道（与 shared/types/ipc.ts 同源，禁止手写字符串） */
export const INVOKE_CHANNELS: IpcChannel[] = [
  'app:getPaths',
  'app:window',
  'project:open',
  'project:close',
  'project:list',
  'project:save',
  'project:volumes',
  'project:create-volume',
  'project:reorder-volumes',
  'chapter:list',
  'chapter:get',
  'chapter:update',
  'chapter:reorder',
  'chapter:set-volume',
  'health:analyze',
  'health:report',
  'health:locate',
  'health:rules',
  'ledger:query',
  'ledger:upsert',
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
  'chapter:changed',
  'project:opened',
  'project:closed',
  'llm:status',
  'checkpoint:rolled-back',
];