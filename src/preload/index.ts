/**
 * preload 入口（架构 T03）。
 *
 * 用 contextBridge.exposeInMainWorld('mz', api) 暴露白名单 API。
 * ★ 关键约束（架构 §1.2）：
 *   - 只暴露 `invoke` 与 `on` 两个**受控原语**，不暴露 ipcRenderer
 *   - invoke 的通道名必须在白名单内（用 Set 校验，防止渲染层拼错或注入）
 *   - on 只允许订阅白名单内的推送通道，回调只拿序列化 DTO
 *
 * ⚠️【待验证 V9】sandbox:true + contextIsolation:true 下 preload 必须是 CJS。
 *   本项目 electron.vite.config.ts 已把 preload 构建为 CJS 产物。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { IpcInvokeMap, IpcPushMap, IpcPushChannel } from '@shared/types/ipc';
import { INVOKE_CHANNELS, SUBSCRIBE_CHANNELS, type MzBridge } from './api';

/** invoke 通道白名单：不在其中的直接拒绝，防止渲染层探测主进程能力 */
const INVOKE_SET = new Set<string>(INVOKE_CHANNELS);
const SUBSCRIBE_SET = new Set<string>(SUBSCRIBE_CHANNELS);

function invoke<K extends keyof IpcInvokeMap>(
  channel: K,
  payload?: IpcInvokeMap[K]['req'],
): Promise<IpcInvokeMap[K]['res']> {
  if (!INVOKE_SET.has(channel as string)) {
    // 不抛未知通道的存在性，而是回一个明确错误——不泄露主进程能力清单
    return Promise.reject(new Error(`不允许的 IPC 通道：${String(channel)}`));
  }
  return ipcRenderer.invoke(channel, payload).then((res) => {
    // ★ 主进程的 MzError 以 {__mzError} 形态「正常返回」而非 reject（register.ts 的 handle 包装）。
    //   必须在桥接层统一转成 throw——否则错误对象会顺着数据流污染 store：
    //   实测「改动历史」面板把非可迭代对象展开 → React 崩溃 → 黑屏（2026-10-08 真机首启）。
    //   转成真 Error 后，所有调用方的 try/catch 与 errorText 按标准语义工作。
    if (res !== null && typeof res === 'object' && '__mzError' in res) {
      const mz = res as { __mzError: string; message?: string; detail?: unknown };
      const err = new Error(mz.message || mz.__mzError) as Error & {
        code: string;
        detail?: unknown;
      };
      err.code = mz.__mzError;
      err.detail = mz.detail;
      throw err;
    }
    return res;
  }) as Promise<IpcInvokeMap[K]['res']>;
}

function subscribe<K extends IpcPushChannel>(
  channel: K,
  handler: (payload: IpcPushMap[K]) => void,
): () => void {
  if (!SUBSCRIBE_SET.has(channel as string)) {
    throw new Error(`不允许订阅的通道：${String(channel)}`);
  }
  // 包装一层：剥离 sender 事件对象，只把 payload 交给渲染层
  const listener = (_e: IpcRendererEvent, payload: IpcPushMap[K]): void => {
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: MzBridge = {
  getPaths: () => invoke('app:getPaths'),
  window: (action) => invoke('app:window', { action }),

  project: {
    pickDir: () => invoke('project:pick-dir'),
    open: (dir) => invoke('project:open', { dir }),
    close: () => invoke('project:close'),
    list: () => invoke('project:list'),
    save: () => invoke('project:save'),
    volumes: () => invoke('project:volumes'),
    createVolume: (title) => invoke('project:create-volume', { title }),
    reorderVolumes: (ids) => invoke('project:reorder-volumes', { ids }),
    setPrice: (pricePerK) => invoke('project:set-price', { pricePerK }),
    setGen: (projectId, genre, platform, chapterWords, language) =>
      invoke('project:set-gen', { projectId, genre, platform, chapterWords, language }),
  },

  chapter: {
    list: () => invoke('chapter:list'),
    get: (chapterId) => invoke('chapter:get', { chapterId }),
    update: (chapterId, body, expectedRev) =>
      invoke('chapter:update', { chapterId, body, expectedRev }),
    create: (payload) => invoke('chapter:create', payload),
    reorder: (ids) => invoke('chapter:reorder', { ids }),
    setVolume: (chapterId, volumeId) => invoke('chapter:set-volume', { chapterId, volumeId }),
    setTitle: (chapterId, title) => invoke('chapter:set-title', { chapterId, title }),
    importMarkdown: () => invoke('chapter:import-md'),
  },

  health: {
    analyze: (chapterIds) => invoke('health:analyze', { chapterIds }),
    report: (chapterIds) => invoke('health:report', { chapterIds }),
    locate: (metric, chapterIds) => invoke('health:locate', { metric, chapterIds }),
    locateChapter: (chapterId) => invoke('health:locate-chapter', { chapterId }),
    rules: (layer) => invoke('health:rules', { layer }),
  },

  ledger: {
    query: (kind, subject) => invoke('ledger:query', { kind: kind ?? 'all', subject }),
    upsert: (entries) => invoke('ledger:upsert', { entries }),
    // ★P2-B T3 手改通道：req 原样转发（白名单与值域校验全在主进程 repo，桥不加工）
    patch: (req) => invoke('ledger:patch', req),
    remove: (req) => invoke('ledger:remove', req),
  },

  // ── 章×人物状态矩阵（★P2-B T5）──
  charstate: {
    list: (projectId) => invoke('charstate:list', { projectId }),
    // req 原样转发（trim/章号/跨项目校验全在主进程 repo，桥不加工）
    set: (req) => invoke('charstate:set', req),
  },

  tool: {
    list: () => invoke('tool:list'),
    preview: (toolName, args) => invoke('tool:preview', { toolName, args }),
    execute: (toolName, args) => invoke('tool:execute', { toolName, args }),
  },

  agent: {
    run: (payload) => invoke('agent:run', payload),
    abort: (runId) => invoke('agent:abort', { runId }),
    pause: (runId) => invoke('agent:pause', { runId }),
    resume: (runId) => invoke('agent:resume', { runId }),
    state: (runId) => invoke('agent:state', { runId }),
    history: (limit) => invoke('agent:history', { limit }),
    on: subscribe,
  },

  checkpoint: {
    list: (runId) => invoke('checkpoint:list', { runId }),
    undo: (checkpointId, force) => invoke('checkpoint:undo', { checkpointId, force }),
  },

  llm: {
    status: () => invoke('llm:status'),
    configure: (payload) => invoke('llm:configure', payload),
    test: () => invoke('llm:test'),
  },

  style: {
    profile: () => invoke('style:profile'),
    rebuild: (chapterIds) => invoke('style:rebuild', { chapterIds }),
  },

  exportArtifact: (payload) => invoke('export:run', payload),
  exportPreview: (payload) => invoke('export:preview', payload),
  exportHistory: (limit) => invoke('export:history', { limit }),

  // ── 专家团（UI 手动触发，不依赖 Agent）──
  expert: {
    review: (stage, chapterIds, roles) => invoke('expert:review', { stage, chapterIds, roles }),
    history: (limit) => invoke('expert:history', { limit }),
    opinions: (reviewId) => invoke('expert:opinions', { reviewId }),
    decide: (reviewId, dimension, decision) =>
      invoke('expert:decide', { reviewId, dimension, decision }),
    config: () => invoke('expert:config'),
    configure: (config) => invoke('expert:configure', { config }),
    roles: () => invoke('expert:roles'),
  },

  // ── AI 味检测（独立板块）──
  aiFlavor: {
    scan: (chapterIds) => invoke('aiFlavor:scan', { chapterIds }),
    latest: (chapterId) => invoke('aiFlavor:latest', { chapterId }),
    trend: (chapterId, limit) => invoke('aiFlavor:trend', { chapterId, limit }),
    rewrite: (payload) => invoke('aiFlavor:rewrite', payload),
    rewriteHistory: (chapterId) => invoke('aiFlavor:rewriteHistory', { chapterId }),
    config: () => invoke('aiFlavor:config'),
    configure: (config) => invoke('aiFlavor:configure', { config }),
    about: () => invoke('aiFlavor:about'),
    baseline: () => invoke('aiFlavor:baseline'),
    rebuildBaseline: (chapterIds) => invoke('aiFlavor:rebuildBaseline', { chapterIds }),
    dashStats: () => invoke('dash:stats'),
  },

  // ── P0 生成流水线（T5）──
  pipeline: {
    runConcept: (projectId) => invoke('pipeline:run-concept', { projectId }),
    runOutline: (projectId, volumeIndex) => invoke('pipeline:run-outline', { projectId, volumeIndex }),
    writeDraft: (projectId, chapterNo, planItem) =>
      invoke('pipeline:write-draft', { projectId, chapterNo, planItem }),
    listDrafts: (projectId, status) => invoke('pipeline:list-drafts', { projectId, status }),
    adoptDraft: (draftId) => invoke('pipeline:adopt-draft', { draftId }),
    discardDraft: (draftId) => invoke('pipeline:discard-draft', { draftId }),
    onProgress: (handler) => subscribe('pipeline:progress', handler),
  },

  // ── 世界观铁律 canon（P1-A T2）──
  canon: {
    list: (projectId) => invoke('canon:list', { projectId }),
    add: (projectId, text) => invoke('canon:add', { projectId, text }),
    remove: (projectId, id) => invoke('canon:remove', { projectId, id }),
  },

  // ── 提示词覆盖层与工艺技能表（P2-A T3）──
  overlay: {
    get: (role) => invoke('overlay:get', { role }),
    save: (role, temperature, additional) => invoke('overlay:save', { role, temperature, additional }),
    remove: (role) => invoke('overlay:remove', { role }),
  },
  skills: {
    list: () => invoke('skills:list'),
    match: (text, role) => invoke('skills:match', { text, role }),
  },

  // ── P2-C 灵感线（T2）：扫榜 + 卡片池 + 选题套用 ──
  trending: {
    fetch: (platform) => invoke('trending:fetch', { platform }),
    // C批：手动导入（req 原样转发；解析/上限/诚实标记全在主进程 inspiration-ipc）
    importChart: (platform, text) => invoke('trending:import', { platform, text }),
  },
  inspiration: {
    list: (kind) => invoke('inspiration:list', { kind }),
    collect: (cardId) => invoke('inspiration:collect', { cardId }),
    remove: (cardId) => invoke('inspiration:remove', { cardId }),
  },
  topic: {
    createFromCard: (cardId) => invoke('topic:create-from-card', { cardId }),
    // P2-C T6 生命周期三通道：req 原样转发（zod 边界与状态机全在 topic-service/TopicRepo，桥不加工）
    list: (status) => invoke('topic:list', { status }),
    promote: (topicId, dir) => invoke('topic:promote', { topicId, dir }),
    abandon: (topicId) => invoke('topic:abandon', { topicId }),
  },
  idea: {
    draw: () => invoke('idea:draw'),
  },

  // ── P2-C 灵感线（T5）：拆书报告——结构统计零token / 八维精读 / 一维存灵感库 ──
  teardown: {
    structure: (title, text) => invoke('teardown:structure', { title, text }),
    read: (reportId) => invoke('teardown:read', { reportId }),
    saveDimension: (reportId, dimension) => invoke('teardown:save-dimension', { reportId, dimension }),
  },

  // ── P2-D 发布排期（T6）：五通道 req/res 原样转发（zod 边界与业务全在 publish-ipc，桥不加工）──
  publish: {
    planSave: (payload) => invoke('publish:plan-save', payload),
    planList: (includeArchived) => invoke('publish:plan-list', { includeArchived }),
    queue: (planId) => invoke('publish:queue', { planId }),
    stage: (planId, chapterIds) => invoke('publish:stage', { planId, chapterIds }),
    markPublished: (planId, chapterId) => invoke('publish:mark-published', { planId, chapterId }),
  },
};

contextBridge.exposeInMainWorld('mz', bridge);