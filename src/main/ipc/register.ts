/**
 * IPC handler 注册（架构 T02 契约落地点）。
 *
 * ★ **显式白名单，不用自动反射**。每个通道显式注册：
 *   新增通道时若漏了注册，渲染层调用会得到「No handler registered」，
 *   契约与实现在同一处可见，不会在两处漂移。
 *
 * ★ 错误序列化：把 MzError 的 code 一并返回，渲染层据此决定动作
 *   （回喂 Agent 自纠 / 弹确认框 / 终止 run），而不是只弹个 toast。
 */
import { ipcMain, app, dialog, type BrowserWindow } from 'electron';
import type { IpcChannel, IpcInvokeMap } from '@shared/types/ipc';
import { MzError } from '@shared/types/ipc';
import type { AppServices } from '../services';
import { executeTool } from '../tools/sandbox';
import { probeCapabilities } from '../llm/capability-probe';
import {
  analyzeChapter,
  getHealthReport,
  listFixRules,
  locateChapterIssues,
  locateIssues,
} from '../tools/impl/analyze';
import type { StyleProfile, MetricSpec } from '@shared/types/project';
// ── 专家团（阶段三）──
import { EXPERT_ROLES, defaultRolesFor } from '../expert/roles';
import { aggregateOpinions } from '../expert/arbitration';
import { describeFailures, runExpertReview } from '../expert/reviewer';
// ── AI 味检测（独立板块）──
import { detectFlavor, FLAVOR_ENGINE_VERSION } from '@shared/ai-flavor/engine';
import { isBaselineStale, type FlavorBaseline } from '@shared/ai-flavor/baseline';
import { FLAVOR_DISCLAIMER } from '@shared/types/ai-flavor';
import { applyLocalRewrites, diffReports, needsAgent } from '../flavor/rewrite';
// ── P0 生成流水线（T5）：业务语义全在 pipeline/ipc.ts，这里只登记通道 ──
import * as pipelineIpc from '../pipeline/ipc';
// ── 世界观铁律 canon（P1-A T2）：业务语义全在 pipeline/canon-ipc.ts，这里只登记通道 ──
import * as canonIpc from '../pipeline/canon-ipc';
// ── 提示词覆盖层与技能表（P2-A T3）：业务语义全在 pipeline/overlay-ipc.ts，这里只登记通道 ──
import * as overlayIpc from '../pipeline/overlay-ipc';
// ── P2-C 灵感线（T2）：业务语义全在 inspiration/inspiration-ipc.ts（zod 边界+premise 派生），这里只登记通道 ──
import * as inspirationIpc from '../inspiration/inspiration-ipc';
// ── P2-C 灵感线（T4）：抽脑洞业务语义全在 inspiration/idea-service.ts（反重复+演示兜底），这里只登记通道 ──
import { drawIdea } from '../inspiration/idea-service';
// ── P2-C 灵感线（T5）：拆书报告业务语义全在 inspiration/teardown-service.ts（零token复用+八维角色+演示兜底），这里只登记通道 ──
import { teardownStructureIpc, teardownReadIpc, teardownSaveDimensionIpc } from '../inspiration/teardown-service';
// ── P2-C 灵感线（T6）：选题库生命周期业务语义全在 inspiration/topic-service.ts（R5 立项形+状态机+演示边界），这里只登记通道 ──
import { listTopics, promoteTopicIpc, abandonTopic } from '../inspiration/topic-service';
// ── P2-D 导出（T3）：业务语义全在 export/export-ipc.ts（scope 三级+字节诚实预览+历史落库），这里只登记通道 ──
import * as exportIpc from '../export/export-ipc';
import { ExportHistoryRepo } from '../db/repos/export-history-repo';
// ── P2-D 发布排期（T6）：业务语义全在 publish/publish-ipc.ts（服务端推导入队+批准即提交+项目内暂存写），这里只登记通道 ──
import * as publishIpc from '../publish/publish-ipc';

type Handler<K extends IpcChannel> = (
  payload: IpcInvokeMap[K]['req'],
  services: AppServices,
) => Promise<IpcInvokeMap[K]['res']> | IpcInvokeMap[K]['res'];

function handle<K extends IpcChannel>(channel: K, fn: Handler<K>, services: AppServices): void {
  ipcMain.handle(channel, async (_e, payload) => {
    try {
      return await fn(payload as IpcInvokeMap[K]['req'], services);
    } catch (e) {
      if (e instanceof MzError) {
        return { __mzError: e.code, message: e.message, detail: e.detail } as never;
      }
      // 未预期的异常：打完整日志，渲染层只拿到可读消息
      console.error(`[ipc] ${channel} 失败：`, e);
      const msg = e instanceof Error ? e.message : String(e);
      return { __mzError: 'E_INTERNAL', message: msg } as never;
    }
  });
}

/** 拖拽排序入参的形状校验：必须是一串字符串 id。排列完不完整由 repo 判。 */
function assertIdList(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    throw new MzError('E_INVALID_ARGS', '排序列表必须是一串 id');
  }
}

export function registerAllIpc(services: AppServices, getWindow: () => BrowserWindow | null): void {
  // ── app ──
  handle('app:getPaths', () => ({
    userData: app.getPath('userData'),
    documents: app.getPath('documents'),
  }), services);

  handle('app:window', (p) => {
    const win = getWindow();
    if (!win) return undefined;
    if (p.action === 'minimize') win.minimize();
    else if (p.action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else win.close();
    return undefined;
  }, services);

  // ── project ──
  /**
   * ★ 第 29 条：打开 / 切换项目以前走 `App.tsx` 里的 `window.prompt`，
   *   让用户**手打绝对路径**——而这是网文作者进这个应用的第一个动作，
   *   他们的工具是文件夹，不是路径字符串。这里换成原生目录选择器。
   *   **取消返回 null 而不是抛**：取消是正常结果，不该在界面上留下一条错误。
   */
  handle('project:pick-dir', async () => {
    const win = getWindow();
    if (!win) return null;
    const picked = await dialog.showOpenDialog(win, {
      title: '选择书稿目录',
      buttonLabel: '打开这个目录',
      // createDirectory：作者常常要先建一个「新书」文件夹再选它，少了这个标记就得两步走
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths[0];
  }, services);

  handle('project:open', async (p) => {
    const project = await services.openProject(p.dir);
    // 检测上次是否有未闭合的 run —— 必须提示，不静默（架构 T24）
    // ★ 第 26 条：以前判据是 `agentHost.listRuns()`——一张**从没被写过**的进程内 map，
    //   恒空，所以这段提示一次都没发过；何况进程内的东西本来就看不见「上次」。
    //   现在读真正存东西的 runs 表（配套：host 在开跑那一刻就先落一次库）。
    //   终止码仍用 USER_ABORTED —— 10 种码是架构承诺（§1.4.1），不为「进程被强杀」新增第 11 种；
    //   剩下的码里它最不离真：用户关掉了应用、停在第 N 步、改动都保留了。
    //   不用 CONSECUTIVE_FAILURE：那会让面板打上「连续多次工具失败」，把关软件说成工具坏了。
    const unclosed = services.listUnclosedRuns();
    const [firstUnclosed] = unclosed;
    if (firstUnclosed) {
      services.push.send('agent:terminated', {
        runId: firstUnclosed.runId,
        reason: { code: 'USER_ABORTED', atStep: firstUnclosed.stats.steps + 1 },
        stats: firstUnclosed.stats,
        keptChanges: firstUnclosed.keptChanges,
      });
      // ★ 报过就封账：这条提示是一次性的。少了这一句，强杀一次就会**每次开项目都弹同一条**，
      //   比不弹更糟——用户会以为每次都崩了一回。
      services.markUnclosedRunReported(firstUnclosed.runId);
    }
    return project;
  }, services);

  handle('project:close', () => {
    services.closeProject();
    return undefined;
  }, services);

  handle('project:list', () => services.projectRepo.list(), services);
  handle('project:save', () => {
    if (!services.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    // L3 备份之一：用户主动保存（架构 §1.8）。
    // ★ 修复前这里传的是 `{ at: Date.now() }` —— 一个纯时间戳，
    //   落盘的 .mzproj 里没有任何正文，备份等于没做。现在走 backupNow()，
    //   载荷是含全部章节正文的 ProjectBackup。
    // 刻意 fire-and-forget：3.75MB 级写入若 await，每次保存都会明显卡顿。
    // 但失败必须留痕 —— 静默失败的备份比没有备份更危险（用户以为有）。
    void services.backupNow('manual-save').catch((e) => {
      console.error('[backup] 手动保存时的全量备份失败：', e);
    });
    services.projectRepo.touch(services.project.id);
    services.backup.noteEdit();
    return services.project;
  }, services);

  handle('project:volumes', () => {
    if (!services.project) return [];
    return services.projectRepo.volumes(services.project.id);
  }, services);

  // ── 分卷：建卷与拖拽排序（§4 第 4 条）──
  // repo 的 createVolume/insertVolume 早就写好了，但全仓零调用方 ——
  // 通道补齐之前，「分卷」在 UI 上是一张只能看的卡。
  handle('project:create-volume', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (typeof p.title !== 'string') throw new MzError('E_INVALID_ARGS', '卷名必须是字符串');
    try {
      const vol = s.projectRepo.createVolume(s.project.id, p.title);
      s.backup.noteEdit();
      return vol;
    } catch (e) {
      // 这里 repo 抛出来的只可能是入参校验（空卷名），如实转成用户可读的错误
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  handle('project:reorder-volumes', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    assertIdList(p.ids);
    try {
      const vols = s.projectRepo.reorderVolumes(s.project.id, p.ids);
      s.backup.noteEdit();
      return vols;
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  // ── 千字单价（§4 第 3 条：稿费预估的唯一输入）──
  // 校验放在 repo（setPricePerK 自己拒 NaN/负数），这里只补 IPC 边界的类型守卫，
  // 免得两个地方各写一套口径、日后只改一处。
  handle('project:set-price', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (typeof p.pricePerK !== 'number') throw new MzError('E_INVALID_ARGS', '千字单价必须是数字');
    try {
      return s.projectRepo.setPricePerK(s.project.id, p.pricePerK);
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  // ── 生成流水线的立项参数（T6/R3：写 v12 的 genre/platform/chapter_words 真列）──
  // 数值口径在 repo（setPipelineParams 自己拒非整数/负数/未知项目），这里只补
  // IPC 边界的形状守卫与 projectId 一致性——与 pipeline 六通道同款：
  // 渲染层拿着别的书的 id 过来，直接拒，不静默改写另一本书的参数。
  handle('project:set-gen', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (p.projectId !== s.project.id) {
      throw new MzError('E_INVALID_ARGS', `projectId 与当前打开项目不一致：${p.projectId}`);
    }
    if (typeof p.genre !== 'string' || typeof p.platform !== 'string') {
      throw new MzError('E_INVALID_ARGS', 'genre / platform 必须是字符串');
    }
    if (typeof p.chapterWords !== 'number') {
      throw new MzError('E_INVALID_ARGS', 'chapterWords 必须是数字');
    }
    // P1-B T3：language 可选——缺省不改原值；给了就必须是枚举内值
    // （repo 也会拦，这里在边界先拦是为了错误消息不必穿过写库路径）
    if (p.language !== undefined && p.language !== 'zh' && p.language !== 'en') {
      throw new MzError('E_INVALID_ARGS', `language 只支持 'zh' | 'en'，收到 ${String(p.language)}`);
    }
    try {
      s.projectRepo.setPipelineParams(p.projectId, {
        genre: p.genre,
        platform: p.platform,
        chapterWords: p.chapterWords,
        language: p.language,
      });
      return s.projectRepo.pipelineParams(p.projectId);
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  // ── chapter ──
  handle('chapter:list', () => {
    if (!services.project) return [];
    return services.chapterRepo.listMeta(services.project.id);
  }, services);

  handle('chapter:get', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    const ch = s.chapterRepo.get(s.project.id, p.chapterId);
    if (!ch) throw new MzError('E_INVALID_ARGS', `章节不存在：${p.chapterId}`);
    return ch;
  }, services);

  handle('chapter:update', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    try {
      const meta = s.chapterRepo.updateBody(s.project.id, p.chapterId, p.body, p.expectedRev);
      s.backup.noteEdit();
      s.push.send('chapter:changed', { chapterId: p.chapterId, rev: meta.rev, source: 'user' });
      return meta;
    } catch (e) {
      if (e instanceof Error && e.name === 'E_REVISION_CONFLICT') {
        throw new MzError('E_REVISION_CONFLICT', e.message);
      }
      throw e;
    }
  }, services);

  handle('chapter:create', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (typeof p.title !== 'string') throw new MzError('E_INVALID_ARGS', '标题必须是字符串');
    if (p.volumeId !== null && typeof p.volumeId !== 'string') {
      throw new MzError('E_INVALID_ARGS', 'volumeId 只能是卷 id 或 null');
    }
    try {
      // 章节号（主键）在 repo 里算，这里不传：见 IpcInvokeMap['chapter:create'] 的注释
      const meta = s.chapterRepo.createChapter(s.project.id, {
        title: p.title,
        volumeId: p.volumeId,
      });
      s.backup.noteEdit();
      return meta;
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  handle('chapter:reorder', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    assertIdList(p.ids);
    try {
      // 只改 ord：拖一下顺序不该把编辑器的乐观锁搅乱
      const metas = s.chapterRepo.reorder(s.project.id, p.ids);
      s.backup.noteEdit();
      return metas;
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  handle('chapter:set-volume', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (typeof p.chapterId !== 'string') throw new MzError('E_INVALID_ARGS', 'chapterId 必须是字符串');
    if (p.volumeId !== null && typeof p.volumeId !== 'string') {
      throw new MzError('E_INVALID_ARGS', 'volumeId 只能是卷 id 或 null');
    }
    try {
      const meta = s.chapterRepo.setVolume(s.project.id, p.chapterId, p.volumeId);
      s.backup.noteEdit();
      return meta;
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  /**
   * 改章节标题（§4 第 19 条①）。空标题放行：与 `chapter:create` 同口径，
   * 界面按 `第N章` 兜底显示，这里不做"必须起个名"的强制。
   */
  handle('chapter:set-title', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (typeof p.chapterId !== 'string') throw new MzError('E_INVALID_ARGS', 'chapterId 必须是字符串');
    if (typeof p.title !== 'string') throw new MzError('E_INVALID_ARGS', '标题必须是字符串');
    try {
      const meta = s.chapterRepo.setTitle(s.project.id, p.chapterId, p.title);
      s.backup.noteEdit();
      return meta;
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  /**
   * 导入 `chapters/*.md` 旧稿（§4 第 19 条②）。
   * 不接任何参数：目录固定是当前项目的 `chapters/`，传路径就是目录穿越的口子。
   * 结果原样回给界面 —— 三个桶（导入/跳过/认不出）都得让用户看见，这里不替它汇总。
   */
  handle('chapter:import-md', async (_p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    try {
      return await s.importMarkdownChapters();
    } catch (e) {
      if (e instanceof MzError) throw e;
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  // ── health（只读）──
  handle('health:analyze', async (p, s) => {
    const ctx = fakeCtx();
    const r = await analyzeChapter({ chapterIds: p.chapterIds }, ctx, s.registryDeps());
    if (!r.ok || !r.data) return [];
    return r.data.chapters;
  }, services);

  handle('health:report', async (p, s) => {
    const r = await getHealthReport({ chapterIds: p.chapterIds }, fakeCtx(), s.registryDeps());
    if (!r.ok || !r.data) throw new MzError('E_INTERNAL', '体检报告生成失败');
    const data = r.data;
    return {
      projectId: s.project?.id ?? '',
      baselineSource: data.baselineSource,
      sampleChapters: data.sampleChapters,
      chapters: data.chapters,
      distribution: {},
      commonIssues: data.commonIssues,
      avgScore: data.avgScore,
    };
  }, services);

  handle('health:locate', async (p, s) => {
    const r = await locateIssues({ metric: p.metric, chapterIds: p.chapterIds }, fakeCtx(), s.registryDeps());
    if (!r.ok || !r.data) return [];
    return r.data.locations;
  }, services);

  /**
   * 编辑器行内标注的数据源（§4 第 20 条②）：一次调用把这一章所有偏差项定位完。
   *
   * ★ 与 `health:locate` 的分工见 `ipc.ts` 那条注释——判定与坐标必须出自同一份
   *   正文快照，所以这里一次调到底，绝不让渲染层按指标循环调（中间一落盘，
   *   标注就会莫名消失，用户看到的是"我没改它，线没了"）。
   *   依赖复用 `s.registryDeps()`：与只读工具同一份装配，两处不漂移。
   *   算不出（章被删 / 切了项目）回空数组——标注是锦上添花，不许打扰写作主链路；
   *   但 `chapterId` 传了个非字符串进来是调用点的缺陷，那种要响。
   */
  handle('health:locate-chapter', async (p, s) => {
    if (typeof p.chapterId !== 'string' || !p.chapterId) {
      throw new MzError('E_INVALID_ARGS', 'chapterId 必须是字符串');
    }
    const r = await locateChapterIssues({ chapterId: p.chapterId }, fakeCtx(), s.registryDeps());
    if (!r.ok || !r.data) return [];
    return r.data.issues;
  }, services);

  handle('health:rules', async (p) => {
    const r = await listFixRules({ layer: p.layer }, fakeCtx());
    return r.ok && r.data ? r.data.rules : [];
  }, services);

  // ── ledger ──
  handle('ledger:query', (p, s) => {
    // ★P2-B T4：补 foreshadows 一路（伏笔台账页的取数通道，不新开平行 IPC）
    // ★P2-E ②：再补 timeline/numbers 两路（长期记忆页的事件流/数字锚点，同一本账）
    if (!s.project) return { conflicts: [], characters: [], foreshadows: [], timeline: [], numbers: [] };
    return {
      characters: s.characters(s.project.id, p.subject),
      conflicts: s.conflicts(s.project.id, p.kind === 'all' ? undefined : p.kind),
      foreshadows: s.foreshadows(s.project.id),
      timeline: s.timeline(s.project.id),
      numbers: s.numbers(s.project.id),
    };
  }, services);

  // ★ 修复前这个 handler 是个回显桩：把入参 p.character 原样返回，一条都没落库（§4 第 13 条）。
  handle('ledger:upsert', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (!p.entries || typeof p.entries !== 'object') {
      throw new MzError('E_INVALID_ARGS', 'entries 必须是 { characters?, numbers?, timeline?, foreshadows? } 对象');
    }
    try {
      return s.upsertLedger(s.project.id, p.entries);
    } catch (e) {
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  /**
   * ★P2-B T3 手改通道。边界只做形状守卫（kind/id/patch 三件套），
   * 白名单与值域全在 LedgerRepo.patch——两处不漂移，Agent 工具若接 patch 也走同一道闸。
   * 与 ledger:upsert 的 try/catch 压平不同：repo 抛的就是 MzError（E_NOT_FOUND/E_INVALID_ARGS），
   * 原样让它出去，压平会把"条目不存在"错报成"参数非法"。
   */
  handle('ledger:patch', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if ((p.kind !== 'character' && p.kind !== 'foreshadow') || typeof p.id !== 'string' || !p.id) {
      throw new MzError('E_INVALID_ARGS', 'ledger:patch 需要 { kind: character|foreshadow, id: 非空字符串, patch: 字段对象 }');
    }
    if (!p.patch || typeof p.patch !== 'object' || Array.isArray(p.patch)) {
      throw new MzError('E_INVALID_ARGS', 'ledger:patch 的 patch 必须是要改的字段对象');
    }
    s.ledgerRepo.patch(s.project.id, p.kind, p.id, p.patch);
    return true as const; // res: true 字面量类型——改成布尔要先动契约
  }, services);

  handle('ledger:remove', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    const kinds = ['character', 'foreshadow', 'number', 'timeline'];
    if (!kinds.includes(p.kind) || typeof p.id !== 'string' || !p.id) {
      throw new MzError('E_INVALID_ARGS', 'ledger:remove 需要 { kind: character|foreshadow|number|timeline, id: 非空字符串 }');
    }
    // 幂等删除：不存在回 {ok:false} 不抛（canon:remove 同款口径）
    return { ok: s.ledgerRepo.remove(s.project.id, p.kind, p.id) };
  }, services);

  /**
   * ★P2-B T5 状态矩阵通道。业务口径（trim/判空、章号正整数、跨人物拒绝）
   * 全在 LedgerRepo.stateSet，handler 只做边界：
   * · set 的 projectId 从 s.project 派生——同 ledger:upsert 守卫口径，当前项目
   *   没打开就 E_INVALID_ARGS「未打开项目」；repo 的非 MzError 抛错（如人物卡
   *   不属于本项目的 Plain Error）压平成 E_INVALID_ARGS（upsert 修复批同款），
   *   MzError 本身原样出去（压平会把"快照为空"说成别的）。
   * · list 的 req {projectId} 照 canon:list：必须等于当前打开项目——
   *   不许拿 A 书的 id 读 B 书的状态矩阵。
   */
  handle('charstate:list', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (typeof p.projectId !== 'string' || !p.projectId) {
      throw new MzError('E_INVALID_ARGS', 'charstate:list 需要 { projectId: 非空字符串 }');
    }
    if (p.projectId !== s.project.id) {
      throw new MzError('E_INVALID_ARGS', `projectId 与当前打开的项目不一致：传入 ${p.projectId}，当前 ${s.project.id}`);
    }
    return s.ledgerRepo.stateList(p.projectId);
  }, services);

  handle('charstate:set', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    try {
      return s.ledgerRepo.stateSet(s.project.id, p.characterId, p.chapterNo, p.snapshot);
    } catch (e) {
      if (e instanceof MzError) throw e;
      throw new MzError('E_INVALID_ARGS', e instanceof Error ? e.message : String(e));
    }
  }, services);

  // ── tool ──
  handle('tool:list', (_p, s) => s.registry.list(), services);

  handle('tool:preview', async (p, s) => {
    const spec = s.registry.specOf(p.toolName);
    const handler = s.registry.handlerOf(p.toolName);
    if (!spec || !handler) {
      throw new MzError('E_TOOL_NOT_FOUND', `工具不存在：${p.toolName}`);
    }
    const outcome = await executeTool(spec, handler, p.args, {
      runId: 'preview',
      stepNo: 0,
      // ★ preview 用 dryRun=true，与 execute 走同一条路径，只是到最后一步不落盘
      dryRun: true,
      writePolicy: { policy: 'preview-only', autoApproveThreshold: 1, hardStopThreshold: 5 },
      signal: new AbortController().signal,
      logger: () => undefined,
      deps: {
        requireCheckpoint: async () => {
          throw new MzError('E_CHECKPOINT_FAILED', '预览模式不应落快照');
        },
      },
    });
    if (!outcome.result.ok || !outcome.result.changeSet) {
      throw new MzError(
        (outcome.result.error?.code as never) ?? 'E_INTERNAL',
        outcome.result.error?.message ?? '预览未产生改动',
      );
    }
    return outcome.result.changeSet;
  }, services);

  handle('tool:execute', async (p, s) => {
    const spec = s.registry.specOf(p.toolName);
    const handler = s.registry.handlerOf(p.toolName);
    if (!spec || !handler) {
      throw new MzError('E_TOOL_NOT_FOUND', `工具不存在：${p.toolName}`);
    }
    const outcome = await executeTool(spec, handler, p.args, {
      runId: 'manual',
      stepNo: 0,
      dryRun: false,
      writePolicy: s.writePolicy,
      signal: new AbortController().signal,
      logger: () => undefined,
      deps: {
        requireCheckpoint: async (chs) => {
          return s.checkpoints.requireCheckpoint('manual', 0, p.toolName, chs);
        },
        rollbackTo: async (checkpointId) => {
          await s.replayer.undoTo(checkpointId, true);
        },
      },
    });
    if (!outcome.result.ok) {
      throw new MzError(
        (outcome.result.error?.code as never) ?? 'E_INTERNAL',
        outcome.result.error?.message ?? '工具执行失败',
      );
    }
    if (outcome.result.changeSet && outcome.checkpointId) {
      const after = new Map<string, string>();
      for (const pt of outcome.result.changeSet.patches) after.set(pt.chapterId, pt.afterText);
      await s.checkpoints.commit(
        outcome.checkpointId,
        after,
        outcome.result.changeSet.edits.length,
      );
    }
    return outcome.result.changeSet ?? {
      chapterId: '',
      patches: [],
      edits: [],
      bytes: 0,
      dryRun: false,
    };
  }, services);

  // ── agent ──
  handle('agent:run', async (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    if (p.writePolicy) s.writePolicy = p.writePolicy;
    return s.agentHost.start({
      goal: p.goal,
      chapterIds: p.chapterIds,
      budget: p.budget,
    });
  }, services);

  handle('agent:abort', (p, s) => {
    // ★ 叫停 = 停止下一步、保留已改（≠ 回滚）
    s.agentHost.abort(p.runId);
    return undefined;
  }, services);

  handle('agent:pause', (p, s) => {
    s.agentHost.pause(p.runId);
    return undefined;
  }, services);

  handle('agent:resume', (p, s) => {
    s.agentHost.resume(p.runId);
    return undefined;
  }, services);

  handle('agent:state', (p, s) => s.agentHost.getState(p.runId), services);
  handle('agent:history', (p, s) => s.agentHost.listRuns().slice(0, p.limit ?? 20), services);

  // ── checkpoint ──
  handle('checkpoint:list', (p, s) => s.checkpoints.listForRun(p.runId), services);
  handle('checkpoint:undo', async (p, s) => {
    // ★ 第 27 条：走 host 这个唯一入口。修复前这里直连 replayer 并自己再发一次
    //   checkpoint:rolled-back——结果是 ① 被撤的步骤在轨迹里仍是 ✓（StepStatus 的
    //   rolled-back 零产出方），② host 那条同名事件形同虚设。现在事件只由 host 发。
    return s.agentHost.rollbackTo(p.checkpointId, p.force === true);
  }, services);

  // ── llm ──
  handle('llm:status', async (_p, s) => s.llmStatus(), services);

  handle('llm:configure', async (p, s) => {
    const status = await s.configureLlm({
      providerId: p.providerId,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: p.apiKey,
    });
    // 首次配置或用户点「重新检测」时探测能力
    const probedAt = status.settings?.probedAt ?? 0;
    if (p.reprobe || probedAt === 0) {
      const probe = await probeCapabilities(s.provider, {
        model: status.settings?.model || 'default',
        apiKey: p.apiKey,
      });
      s.setCapabilities(probe.capabilities, probe.at);
      const updated = await s.llmStatus();
      s.push.send('llm:status', updated);
      return updated;
    }
    return status;
  }, services);

  handle('dash:stats', () => {
    if (!services.currentProjectId()) throw new MzError('E_NOT_PROJECT_FILE', '未打开项目');
    return services.dashStats(services.currentProjectId() as string);
  }, services);

  handle('llm:test', async (_p, s) => {
    try {
      const key = await s.apiKeyForFetch();
      const res = await fetch(`${s.llmBaseUrl}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      return {
        ok: res.ok,
        message: res.ok ? '连接正常' : `HTTP ${res.status} ${res.statusText}`,
      };
    } catch (e) {
      return {
        ok: false,
        message: `连接失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }, services);

  // ── style ──
  handle('style:profile', (_p, s): StyleProfile | null => {
    if (!s.project) return null;
    const stored = s.styleRepo.get(s.project.id);
    if (!stored) return null;
    return {
      projectId: s.project.id,
      source: stored.source,
      sampleChapters: stored.sampleChapters,
      metrics: stored.metrics as Record<string, MetricSpec>,
      markerDensity: stored.markerDensity as Record<string, { p50: number; p95: number }>,
      updatedAt: Date.now(),
    };
  }, services);

  handle('style:rebuild', async (p, s) => {
    return s.rebuildBaseline(p.chapterIds);
  }, services);

  // ── P2-D 导出（T3）：三通道业务语义全在 export/export-ipc.ts ──
  // （scope 三级解析 + 单一构建的字节诚实预览 + 成败都入历史 + 落名安全化）。
  // 这里一行式委托（canon/overlay/inspiration 同款模式）。旧内联块（md/csv/假 zip
  // 拼接与 csvEscape）按 P2D-R4 整体退役：csv 不在新 format 枚举，zip 是真容器。
  // dest='external' 写文档目录根（★4，永不自动）；'project' 写项目根（★2）。
  let exportHistoryRepo: ExportHistoryRepo | null = null; // db 进程内不变：懒化单例即可
  const exportDeps = (s: AppServices): exportIpc.ExportIpcDeps => ({
    getProject: () => s.project,
    chapters: s.chapterRepo,
    documentsDir: app.getPath('documents'),
    history: (exportHistoryRepo ??= new ExportHistoryRepo(s.db)),
  });
  handle('export:run', (p, s) => exportIpc.runExportIpc(exportDeps(s), p), services);
  handle('export:preview', (p, s) => exportIpc.previewExportIpc(exportDeps(s), p), services);
  handle('export:history', (p, s) => exportIpc.historyIpc(exportDeps(s), p), services);

  // ── P2-D 发布排期（T6）：计划两枚 + 队列推导一枚 + 暂存/标记两通道 ──
  // 业务口径（zod 边界、plan 归属闸、服务端再清洗、staging 只写项目根内）全在
  // publish/publish-ipc.ts，deps 由 services.publishDeps() 活闭包装配，这里一行式
  // 委托（canon/overlay/inspiration/export 同款模式）。零网络零正文写红线由
  // tests/unit/publish-redline-negative.test.ts 的 DIRS 负对照钉守。
  handle('publish:plan-save', (p, s) => publishIpc.savePlanIpc(s.publishDeps(), p), services);
  handle('publish:plan-list', (p, s) => publishIpc.listPlansIpc(s.publishDeps(), p), services);
  handle('publish:queue', (p, s) => publishIpc.queueIpc(s.publishDeps(), p), services);
  handle('publish:stage', (p, s) => publishIpc.stageIpc(s.publishDeps(), p), services);
  handle('publish:mark-published', (p, s) => publishIpc.markPublishedIpc(s.publishDeps(), p), services);

  registerExpertIpc(services);
  registerFlavorIpc(services);

  // ── P0 生成流水线（T5）──
  // AppServices 结构化满足 pipelineIpc.PipelineIpcServices（db/chapterRepo/push/
  // backup/currentProjectId/pipelineHandlers），handler 直调，不在此复制业务口径。
  handle('pipeline:run-concept', async (p, s) => pipelineIpc.runConcept(s, p.projectId), services);
  handle('pipeline:run-outline', async (p, s) => pipelineIpc.runOutline(s, p), services);
  handle('pipeline:write-draft', async (p, s) => pipelineIpc.writeDraft(s, p), services);
  handle('pipeline:list-drafts', (p, s) => pipelineIpc.listDrafts(s, p), services);
  handle('pipeline:adopt-draft', async (p, s) => pipelineIpc.adoptDraft(s, p.draftId), services);
  handle('pipeline:discard-draft', async (p, s) => pipelineIpc.discardDraft(s, p.draftId), services);

  // ── 世界观铁律 canon（P1-A T2）──
  // AppServices 结构化满足 canonIpc.CanonIpcServices（db/currentProjectId），
  // handler 直调，不在此复制业务口径（trim/判空/幂等删除全在 CanonRepo + canon-ipc）。
  handle('canon:list', (p, s) => canonIpc.listCanon(s, p), services);
  handle('canon:add', (p, s) => canonIpc.addCanon(s, p), services);
  handle('canon:remove', (p, s) => canonIpc.removeCanon(s, p), services);

  // ── 提示词覆盖层与工艺技能表（P2-A T3）──
  // 业务口径（角色白名单、温度 0~2、幂等删除、命中预览）全在 overlay-ipc.ts，
  // 这里一行式委托。dataDir 用 `app.getPath('userData')`——与 services.ts 注入
  // PipelineDeps.getOverlay 的路径同一来源，读写与生成链永远看同一份文件。
  handle('overlay:get', (p) => overlayIpc.overlayGet(app.getPath('userData'), p), services);
  handle('overlay:save', (p) => overlayIpc.overlaySave(app.getPath('userData'), p), services);
  handle('overlay:remove', (p) => overlayIpc.overlayRemove(app.getPath('userData'), p), services);
  handle('skills:list', () => overlayIpc.skillsList(), services);
  handle('skills:match', (p) => overlayIpc.skillsMatch(p), services);

  // ── P2-C 灵感线（T2）：扫榜 + 卡片池 + 选题套用五通道 ──
  // 业务口径（zod 边界、robots 回落真因、premise 按 kind 派生）全在
  // inspiration/inspiration-ipc.ts，这里一行式委托（canon/overlay 同款模式）。
  // 全局子系统：不要求已打开项目——灵感卡片在立项之前就存在。
  const inspDeps = (s: AppServices): inspirationIpc.InspirationIpcDeps => ({
    inspiration: s.inspirationRepo,
    topics: s.topicRepo,
    charts: s.chartSource,
  });
  handle('trending:fetch', async (p, s) => inspirationIpc.fetchTrending(inspDeps(s), p), services);
  // C批：榜单手动导入——粘贴文本/CSV 诚实落库（source='manual'，解析失败抛真因）
  handle('trending:import', async (p, s) => inspirationIpc.importTrending(inspDeps(s), p), services);
  handle('inspiration:list', (p, s) => inspirationIpc.listCards(inspDeps(s), p), services);
  handle('inspiration:collect', (p, s) => inspirationIpc.collectCard(inspDeps(s), p), services);
  handle('inspiration:remove', (p, s) => inspirationIpc.removeCard(inspDeps(s), p), services);
  handle('topic:create-from-card', (p, s) => inspirationIpc.createTopicFromCard(inspDeps(s), p), services);
  // 抽脑洞（T4）：deps 由 services.ideaDeps() 装配（llm chat 子集 + inspirationRepo + idea 覆盖层），
  // 业务口径（反重复选方向、zod 契约、演示兜底）全在 idea-service.ts，这里一行式委托。
  handle('idea:draw', (_p, s) => drawIdea(s.ideaDeps()), services);
  // 拆书报告（T5）：deps 由 services.teardownDeps() 装配（teardownRepo/inspirationRepo +
  // llm chat 子集 + teardown 覆盖层）。结构统计零 token；精读演示兜底；存维度回卡自带 id。
  // 业务口径（zod 边界、digest 复用、live/demo 如实）全在 teardown-service.ts，这里一行式委托。
  handle('teardown:structure', (p, s) => teardownStructureIpc(s.teardownDeps(), p), services);
  handle('teardown:read', (p, s) => teardownReadIpc(s.teardownDeps(), p), services);
  handle('teardown:save-dimension', (p, s) => teardownSaveDimensionIpc(s.teardownDeps(), p), services);

  // ── P2-C 灵感线（T6）：选题库生命周期三通道（取数 / 立项 / 放弃）──
  // 业务口径（zod 边界、R5 的 projectId 必填形、单向状态机、取消= null 不抛）
  // 全在 inspiration/topic-service.ts，这里一行式委托（canon/overlay 同款模式）。
  // ★ dir 缺省时的目录选择器与 project:pick-dir 同一份参数口径；那边的
  //   showOpenDialog 被 project-pickdir-wiring A 组按 handler 块逐字钉死，
  //   不能抽走共用——这份是同一 UX 契约的第二调用点（立项专用入口）。
  const pickDirForPromote = async (): Promise<string | null> => {
    const win = getWindow();
    if (!win) return null;
    const picked = await dialog.showOpenDialog(win, {
      title: '选择新书目录（立项）',
      buttonLabel: '在这里开新书',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths[0];
  };
  handle('topic:list', (p, s) => listTopics(s.topicRepo, p), services);
  handle(
    'topic:promote',
    async (p, s) =>
      promoteTopicIpc(
        {
          repo: s.topicRepo,
          projects: s.projectRepo,
          // 复用既有 openProject 流：目录幂等守卫 + project:opened 推送（渲染层
          // store 由 use-agent-stream 的订阅刷新，这里不另起 projects.create，
          // 同目录双行项目正是 openProject 要避免的形状）。
          openProject: (dir) => s.openProject(dir),
          pickDir: pickDirForPromote,
        },
        p,
      ),
    services,
  );
  handle('topic:abandon', (p, s) => abandonTopic(s.topicRepo, p), services);
}

// ══════════════════════════════════════════════════════════════════════
// 专家团 IPC（阶段三：让用户不依赖 Agent 也能触发评审）
// ══════════════════════════════════════════════════════════════════════

function registerExpertIpc(services: AppServices): void {
  const pid = () => services.currentProjectId();

  handle(
    'expert:roles',
    () =>
      Object.values(EXPERT_ROLES).map((r) => ({
        key: r.key,
        displayName: r.displayName,
        mission: r.mission,
        defaultWeight: r.defaultWeight,
      })),
    services,
  );

  handle('expert:config', () => services.expertConfig(), services);

  handle(
    'expert:configure',
    (p) => {
      services.setExpertConfig(p.config as never);
      return services.expertConfig();
    },
    services,
  );

  handle(
    'expert:review',
    async (p) => {
      const projectId = pid();
      if (!projectId) throw new MzError('E_NOT_PROJECT_FILE', '未打开项目');
      const reviewer = services.buildReviewer(projectId);
      if (!reviewer) {
        throw new MzError(
          'E_LLM_NETWORK',
          '专家团评审需要可用的模型。请在设置中配置 provider 后重试。',
        );
      }
      const cfg = services.expertConfig();
      const stage = p.stage as never;
      const chapterIds = p.chapterIds ?? [];
      const roles = (
        p.roles && p.roles.length > 0 ? p.roles : defaultRolesFor(stage)
      ) as never[];

      const t0 = Date.now();
      const outcome = await runExpertReview(stage, chapterIds, roles, reviewer);
      const { verdicts, summary } = aggregateOpinions({
        stage,
        targetIds: chapterIds,
        opinions: outcome.opinions,
        config: cfg,
        activatedRoles: roles as never,
      });

      const reviewId = `ex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      // ★ 落库：即便部分失败也记录（status=partial），便于回溯
      services.expertRepo.save({
        id: reviewId,
        projectId,
        stage,
        targetIds: chapterIds,
        roles: roles as never,
        verdicts,
        summary,
        tokensIn: outcome.usage.input,
        tokensOut: outcome.usage.output,
        costCny: outcome.usage.costCny,
        durationMs: Date.now() - t0,
        status: outcome.failed.length === 0 ? 'ok' : 'partial',
        error: describeFailures(outcome.failed) || undefined,
        createdAt: Date.now(),
      });

      return {
        reviewId,
        report: { stage, verdicts, summary, narration: describeFailures(outcome.failed) },
        failures: outcome.failed.map((f) => ({ role: f.role, reason: f.reason })),
      };
    },
    services,
  );

  handle(
    'expert:history',
    (p) => {
      const projectId = pid();
      return projectId ? services.expertRepo.listByProject(projectId, p.limit ?? 20) : [];
    },
    services,
  );

  handle(
    'expert:opinions',
    (p) => services.expertRepo.opinionsOf(p.reviewId),
    services,
  );

  handle(
    'expert:decide',
    (p) => {
      services.expertRepo.decide(p.reviewId, p.dimension, p.decision);
    },
    services,
  );
}

// ══════════════════════════════════════════════════════════════════════
// AI 味检测 IPC（独立板块）
// ══════════════════════════════════════════════════════════════════════

function registerFlavorIpc(services: AppServices): void {
  const pid = () => services.currentProjectId();

  handle('aiFlavor:about', () => ({
    disclaimer: FLAVOR_DISCLAIMER,
    engineVersion: FLAVOR_ENGINE_VERSION,
  }), services);

  /** 基线 → 渲染层摘要（过期判断用特征版本，见 `isBaselineStale`） */
  const baselineInfo = (b: FlavorBaseline) => ({
    source: b.source,
    corpus: b.corpus,
    chapters: b.chapters,
    stale: isBaselineStale(b),
    engineVersion: b.engineVersion,
  });

  handle('aiFlavor:baseline', () => baselineInfo(services.flavorBaseline()), services);

  handle(
    'aiFlavor:rebuildBaseline',
    async (p) => {
      if (!pid()) throw new MzError('E_NOT_PROJECT_FILE', '未打开项目');
      const r = await services.rebuildFlavorBaseline(p.chapterIds);
      return {
        used: r.used,
        skipped: r.skipped,
        saved: r.saved,
        warnings: r.warnings,
        // 重建后当前生效基线：保存成功 = 新用户基线；未保存 = 仍是原基线
        info: baselineInfo(services.flavorBaseline()),
      };
    },
    services,
  );

  handle('aiFlavor:config', () => services.flavorConfig(), services);

  handle(
    'aiFlavor:configure',
    (p) => {
      services.setFlavorConfig(p.config as never);
      return services.flavorConfig();
    },
    services,
  );

  handle(
    'aiFlavor:scan',
    (p) => {
      const projectId = pid();
      if (!projectId) throw new MzError('E_NOT_PROJECT_FILE', '未打开项目');
      const ids = p.chapterIds && p.chapterIds.length > 0
        ? p.chapterIds
        : services.allChapterIds();
      const cfg = services.flavorConfig();
      // ★ 注入基线：主进程负责解析「用户基线 or 默认」，引擎不读库（设计 §3.4）。
      //   一次解析、每章复用，保证整批扫描用的是同一把尺。
      const baseline = services.flavorBaseline();
      const results = [];
      for (const id of ids) {
        const body = services.getChapterBody(id);
        const report = detectFlavor(body, id, cfg, baseline);
        // ★ 落库：每次检测都留痕，供趋势对比
        services.flavorRepo.saveScan({
          id: `fs_${id}_${Date.now().toString(36)}`,
          projectId,
          chapterId: id,
          report,
        });
        results.push(report);
      }
      return results;
    },
    services,
  );

  handle(
    'aiFlavor:latest',
    (p) => {
      const projectId = pid();
      if (!projectId) return null;
      return services.flavorRepo.latestScan(projectId, p.chapterId);
    },
    services,
  );

  handle(
    'aiFlavor:trend',
    (p) => {
      const projectId = pid();
      if (!projectId) return [];
      return services.flavorRepo.scoreTrend(projectId, p.chapterId, p.limit ?? 10);
    },
    services,
  );

  handle(
    'aiFlavor:rewriteHistory',
    (p) => {
      const projectId = pid();
      if (!projectId) return [];
      return services.flavorRepo.listRewrites(projectId, p.chapterId);
    },
    services,
  );

  handle(
    'aiFlavor:rewrite',
    async (p) => {
      const projectId = pid();
      if (!projectId) throw new MzError('E_NOT_PROJECT_FILE', '未打开项目');
      const cfg = services.flavorConfig();
      // ★ 改写前后必须用**同一把尺**：基线解析一次，before / after 共用。
      //   否则 before/after 用的不是同一份基线，对比 delta 失真（设计 §3.4）。
      const baseline = services.flavorBaseline();
      const body = services.getChapterBody(p.chapterId);
      const before = detectFlavor(body, p.chapterId, cfg, baseline);

      // ── 路径二：交给主 Agent 重新生成 ──
      if (p.path === 'agent') {
        const dims = p.dimensions;
        const handoff = needsAgent(
          dims && dims.length > 0
            ? before.hits.filter((h) => dims.includes(h.dimension))
            : before.hits,
        );
        if (handoff.length === 0) {
          return {
            changedCount: 0,
            beforeIndex: before.index,
            afterIndex: before.index,
            delta: 0,
            newText: body,
            edits: [],
            rejected: [],
            agentHandoff: { count: 0, offsets: [] },
            message: '没有需要 AI 介入的片段——本地规则已能处理全部命中。',
          };
        }
        // 构造 goal 交给 AgentHost（局部改写，不整篇重写）
        const goal =
          `对第 ${p.chapterId} 章做局部改写：只处理下列 ${handoff.length} 处 AI 腔片段，` +
          `不要改动其他任何文字。当前 AI 味指数 ${before.index}，目标降到 ${Math.max(0, before.index - 15)} 以下。\n` +
          handoff
            .slice(0, 12)
            .map((h, i) => `${i + 1}. 原文「${h.excerpt}」问题：${h.reason} 建议：${h.advice}`)
            .join('\n');
        const started = await services.agentHost.start({
          goal,
          chapterIds: [p.chapterId],
          writePolicy: services.writePolicy,
        });
        return {
          changedCount: 0,
          beforeIndex: before.index,
          afterIndex: before.index,
          delta: 0,
          newText: body,
          edits: [],
          rejected: [],
          agentHandoff: { count: handoff.length, offsets: handoff.map((h) => h.offset) },
          runId: started.runId,
          message: `已交给主 Agent 处理 ${handoff.length} 处需要理解上下文的片段（run ${started.runId}）。完成后可重新检测查看分数变化。`,
        };
      }

      // ── 路径一：本地规则改写 ──
      const out = applyLocalRewrites(body, before.hits, {
        dimensions: p.dimensions as never,
        paragraphNos: p.paragraphNos,
      });
      // ★ 前后分对比必须用真实重跑，不能用估算；且与 before 共用同一基线
      const after = detectFlavor(out.text, p.chapterId, cfg, baseline);
      const handoff = needsAgent(before.hits);

      if (!p.dryRun) {
        if (out.edits.length > 0) {
          await services.updateChapterBody(p.chapterId, out.text, `ai-flavor:${out.edits.length}`);
        }
        services.flavorRepo.saveRewrite({
          id: `fr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          projectId,
          chapterId: p.chapterId,
          path: 'auto-rule',
          changedCount: out.edits.length,
          beforeIndex: before.index,
          afterIndex: after.index,
          delta: before.index - after.index,
          regressedDims: diffReports(before, after).regressedDimensions,
          edits: out.edits,
          message: `本地规则改写 ${out.edits.length} 处；另有 ${handoff.length} 处需 AI 介入`,
        });
      }

      return {
        changedCount: out.edits.length,
        beforeIndex: before.index,
        afterIndex: after.index,
        delta: before.index - after.index,
        newText: out.text,
        edits: out.edits.map((e) => ({
          from: e.from,
          to: e.to,
          offset: e.offset,
          why: e.why,
        })),
        rejected: out.rejected,
        agentHandoff: { count: handoff.length, offsets: handoff.map((h) => h.offset) },
        message:
          `本地改写 ${out.edits.length} 处，AI 味指数 ${before.index} → ${after.index}` +
          `（${before.index - after.index >= 0 ? '↓' : '↑'}${Math.abs(before.index - after.index)}）` +
          (handoff.length > 0 ? `；另有 ${handoff.length} 处需交给 AI 处理` : ''),
      };
    },
    services,
  );
}

/** 只读工具用的假上下文（无 run、不落快照） */
function fakeCtx(): {
  runId: string;
  stepNo: number;
  dryRun: boolean;
  requireCheckpoint: (c: readonly string[]) => Promise<string>;
  signal: AbortSignal;
  logger: (m: string) => void;
} {
  return {
    runId: 'readonly',
    stepNo: 0,
    dryRun: true,
    requireCheckpoint: async () => {
      throw new MzError('E_CHECKPOINT_FAILED', '只读工具不应落快照');
    },
    signal: new AbortController().signal,
    logger: () => undefined,
  };
}