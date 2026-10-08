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
import { ipcMain, app, type BrowserWindow } from 'electron';
import type { IpcChannel, IpcInvokeMap } from '@shared/types/ipc';
import { MzError } from '@shared/types/ipc';
import type { AppServices } from '../services';
import { executeTool } from '../tools/sandbox';
import { probeCapabilities } from '../llm/capability-probe';
import {
  analyzeChapter,
  getHealthReport,
  listFixRules,
  locateIssues,
} from '../tools/impl/analyze';
import { atomicWrite, ensureDir, resolveInProject } from '../fs/project-fs';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
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
  handle('project:open', async (p) => {
    const project = await services.openProject(p.dir);
    // 检测上次是否有未闭合的 run —— 必须提示，不静默（架构 T24）
    const unclosed = services.agentHost.listRuns().filter((r) => r.status !== 'terminated');
    if (unclosed.length > 0) {
      services.push.send('agent:terminated', {
        runId: unclosed[0].runId,
        reason: {
          code: 'CONSECUTIVE_FAILURE',
          failures: 1,
          lastError: '上次运行异常中断（应用被强制关闭）。改动已保留，可在「改动历史」回滚。',
        },
        stats: unclosed[0].stats,
        keptChanges: unclosed[0].keptChanges,
      });
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

  // ── chapter ──
  handle('chapter:list', () => {
    if (!services.project) return [];
    return services.chapterRepo.listMeta(services.project.id);
  }, services);

  handle('chapter:get', (p) => {
    const ch = services.chapterRepo.get(p.chapterId);
    if (!ch) throw new MzError('E_INVALID_ARGS', `章节不存在：${p.chapterId}`);
    return ch;
  }, services);

  handle('chapter:update', (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    try {
      const meta = s.chapterRepo.updateBody(p.chapterId, p.body, p.expectedRev);
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

  handle('health:rules', async (p) => {
    const r = await listFixRules({ layer: p.layer }, fakeCtx());
    return r.ok && r.data ? r.data.rules : [];
  }, services);

  // ── ledger ──
  handle('ledger:query', (p, s) => {
    if (!s.project) return { conflicts: [], characters: [] };
    return {
      characters: s.characters(s.project.id, p.subject),
      conflicts: s.conflicts(s.project.id, p.kind === 'all' ? undefined : p.kind),
    };
  }, services);

  handle('ledger:upsert', (p) => p.character, services);

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
    const r = await s.replayer.undoTo(p.checkpointId, p.force === true);
    s.push.send('checkpoint:rolled-back', {
      checkpointId: p.checkpointId,
      undone: r.undone,
      lostManualEdits: r.lostManualEdits,
    });
    return r;
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

  // ── export ──
  handle('export:run', async (p, s) => {
    if (!s.project) throw new MzError('E_INVALID_ARGS', '未打开项目');
    const metas = services.chapterRepo.listMeta(s.project.id);
    const targets = p.chapterIds.length ? metas.filter((m) => p.chapterIds.includes(m.id)) : metas;
    const bodies = services.chapterRepo.getBodies(targets.map((m) => m.id));

    let content: string;
    if (p.kind === 'md') {
      content = targets
        .map((m) => `# ${m.title || `第${m.id}章`}\n\n${bodies.get(m.id) ?? ''}`)
        .join('\n\n---\n\n');
    } else if (p.kind === 'csv') {
      const rows = ['章节号,标题,字数,状态'];
      for (const m of targets) {
        const chars = (bodies.get(m.id) ?? '').replace(/\s/g, '').length;
        rows.push(`${m.id},${csvEscape(m.title)},${chars},${m.status}`);
      }
      content = rows.join('\n');
    } else {
      // zip：简化为拼接（不引压缩库，打包时少一个原生依赖）
      content = targets
        .map((m) => `${m.id}.md\n${'='.repeat(40)}\n${bodies.get(m.id) ?? ''}`)
        .join('\n\n');
    }

    // ★ 路径规范化防目录穿越（架构 T10）
    const dir = p.dest === 'external'
      ? app.getPath('documents')
      : s.project.rootDir;
    await ensureDir(dir);
    const fname = `${s.project.name}_${p.kind}.${p.kind === 'csv' ? 'csv' : p.kind === 'zip' ? 'txt' : 'md'}`;
    const fullPath = resolveInProject(dir, fname);
    await atomicWrite(fullPath, content);
    const st = await fs.stat(fullPath);
    return { path: fullPath, bytes: st.size };
  }, services);

  registerExpertIpc(services);
  registerFlavorIpc(services);
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
        const handoff = needsAgent(
          p.dimensions && p.dimensions.length > 0
            ? before.hits.filter((h) => p.dimensions!.includes(h.dimension))
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

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

export { join };