/**
 * 应用服务容器（依赖装配）。
 *
 * 把DB / repo / 工具注册表 / checkpoint / LLM / AgentHost 的依赖关系集中在一处，
 * 避免在 IPC handler 里到处 new 出不完整的对象图。
 */
import { join } from 'node:path';
import { app } from 'electron';
import type { Project, StyleProfile } from '@shared/types/project';
import type { CharacterProfile, LedgerConflict, NumberAnchor, TimelineEvent, Foreshadow } from '@shared/types/ledger';
import type { MetricSpec } from '@shared/types/project';
import type { RunState } from '@shared/types/agent';
import { openDatabase, type MzDatabase } from './db/database';
import { ChapterRepo, ProjectRepo, StyleProfileRepo, percentiles } from './db/repos/chapter-repo';
import { ToolRegistry, type ToolDeps } from './tools/registry';
import { CheckpointManager } from './checkpoint/manager';
import { Replayer } from './checkpoint/replayer';
import { PushChannel } from './ipc/push';
import { AgentHost } from './agent/host';
import { LlmClient } from './llm/client';
import { findProvider, DEFAULT_PROVIDER_ID, isLocalProvider } from '@shared/constants/providers';
import { REFERENCE_BASELINE } from '@shared/constants/metrics';
import { DEFAULT_WRITE_POLICY } from '@shared/constants/checkpoint';
import { DEFAULT_BUDGET } from '@shared/constants/budget';
import { MARKER_KEYS, analyze, isSufficient } from '@shared/metrics-engine';
import type { BaselineLike } from './rule-engine/plan-fixes';
import { hashProjectState, ledgerDigest } from './util/hash';
import { BackupManager } from './fs/backup';
import { ensureDir } from './fs/project-fs';
import { displayKey, hasApiKey, getApiKeyForFetch, saveApiKey } from './llm/keyring';
import type { LlmProvider, LlmStatus, ProviderSettings, ProviderCapabilities } from '@shared/types/provider';
// 专家团（独立模块）
import { ExpertReviewRepo } from './db/repos/expert-review-repo';
import { DEFAULT_EXPERT_CONFIG, type ExpertTeamConfig } from '@shared/types/expert';
import type { ReviewerDeps } from './expert/reviewer';
import type { DashStats } from '@shared/types/ipc';
// AI 味检测（独立板块）
import { FlavorRepo } from './db/repos/flavor-repo';
import { FlavorBaselineRepo } from './db/repos/flavor-baseline-repo';
import { DEFAULT_FLAVOR_CONFIG, type FlavorConfig } from '@shared/types/ai-flavor';
import { DEFAULT_FLAVOR_BASELINE, type FlavorBaseline } from '@shared/ai-flavor/baseline';
import { FLAVOR_FEATURE_VERSION } from '@shared/ai-flavor/engine';
import { buildFlavorBaseline, DEFAULT_MIN_CHAPTERS, type BuildResult } from './flavor/baseline-builder';
import type { WritePolicyConfig } from '@shared/types/tool';

export class AppServices {
  readonly db: MzDatabase;
  readonly chapterRepo: ChapterRepo;
  readonly projectRepo: ProjectRepo;
  readonly styleRepo: StyleProfileRepo;
  /** 专家团评审记录（独立于 AI 味板块） */
  readonly expertRepo: ExpertReviewRepo;
  /** AI 味检测板块记录（独立表，与专家团零耦合） */
  readonly flavorRepo: FlavorRepo;
  /** AI 味基线（用户自建基线；内置默认基线是常量，不进库） */
  readonly flavorBaselineRepo: FlavorBaselineRepo;
  readonly push = new PushChannel();
  readonly backup: BackupManager;

  private registryInstance: ToolRegistry | null = null;
  private checkpointsInstance: CheckpointManager | null = null;
  private replayerInstance: Replayer | null = null;
  private agentHostInstance: AgentHost | null = null;
  private llmInstance: LlmClient | null = null;

  private currentProject: Project | null = null;
  /** registry 的依赖装配（构造时填充，供 registryDeps() 返回） */
  private depsCache: ToolDeps | null = null;
  private providerId: string = DEFAULT_PROVIDER_ID;
  private baseUrlOverride = '';
  private model = '';
  private capabilities: ProviderCapabilities | null = null;
  private probedAt = 0;
  writePolicy: WritePolicyConfig = { ...DEFAULT_WRITE_POLICY };
  /** 专家团配置（未打开项目时用内存副本） */
  private expertCfg: ExpertTeamConfig = { ...DEFAULT_EXPERT_CONFIG };
  /** AI 味板块配置（独立于专家团） */
  private flavorCfg: FlavorConfig = { ...DEFAULT_FLAVOR_CONFIG };

  constructor() {
    this.db = openDatabase(join(app.getPath('userData'), 'mozhou.db'));
    this.chapterRepo = new ChapterRepo(this.db);
    this.projectRepo = new ProjectRepo(this.db);
    this.styleRepo = new StyleProfileRepo(this.db);
    this.expertRepo = new ExpertReviewRepo(this.db);
    this.flavorRepo = new FlavorRepo(this.db);
    this.flavorBaselineRepo = new FlavorBaselineRepo(this.db);
    this.backup = new BackupManager(app.getPath('userData'));
  }

  // ── 当前项目 ──
  get project(): Project | null {
    return this.currentProject;
  }

  async openProject(dir: string): Promise<Project> {
    await ensureDir(dir);
    // 按目录找已有项目，没有则新建
    const existing = this.projectRepo.list().find((p) => p.rootDir === dir);
    const project = existing ?? this.projectRepo.create(dir.split(/[\\/]/).pop() ?? '未命名', dir);
    this.currentProject = project;
    await ensureDir(join(dir, 'chapters'));
    await ensureDir(join(dir, 'checkpoints', 'archive'));
    await ensureDir(join(dir, 'backups'));

    // 重置项目相关状态
    this.registryInstance = null;
    this.checkpointsInstance = null;
    this.replayerInstance = null;
    this.agentHostInstance = null;

    this.push.send('project:opened', { projectId: project.id });
    return project;
  }

  closeProject(): void {
    this.currentProject = null;
    this.checkpointsInstance?.clearProject();
    this.registryInstance = null;
    this.agentHostInstance = null;
    this.push.clear();
  }

  // ── Checkpoint ──
  get checkpoints(): CheckpointManager {
    if (!this.checkpointsInstance) {
      if (!this.currentProject) throw new Error('未打开项目');
      this.checkpointsInstance = new CheckpointManager(
        {
          getBody: async (id) => this.chapterRepo.getBody(id),
          setBody: async (id, body) => {
            const meta = this.chapterRepo
              .listMeta(this.currentProject!.id)
              .find((m) => m.id === id);
            this.chapterRepo.updateBody(id, body, meta?.rev ?? 1);
            this.backup.noteEdit();
            this.push.send('chapter:changed', {
              chapterId: id,
              rev: (meta?.rev ?? 1) + 1,
              source: 'agent',
            });
          },
        },
        join(this.currentProject.rootDir, 'checkpoints', 'archive'),
      );
    }
    return this.checkpointsInstance;
  }

  get replayer(): Replayer {
    if (!this.replayerInstance) {
      this.replayerInstance = new Replayer(this.checkpoints, {
        getBody: async (id) => this.chapterRepo.getBody(id),
        setBody: async (id, body) => {
          const meta = this.chapterRepo
            .listMeta(this.currentProject!.id)
            .find((m) => m.id === id);
          this.chapterRepo.updateBody(id, body, meta?.rev ?? 1);
          this.push.send('chapter:changed', { chapterId: id, rev: (meta?.rev ?? 1) + 1, source: 'agent' });
        },
      });
    }
    return this.replayerInstance;
  }

  // ── 工具注册表 ──

  /**
   * 工具层的依赖装配。抽成方法而非内联对象，
   * 是为了让 IPC handler 能复用同一份依赖（registryDeps()）——
   * 否则只读工具在 handler 里要再装配一遍，两处必然漂移。
   */
  private toolDeps(): ToolDeps {
    this.depsCache = {
        allChapterIds: async () =>
          this.currentProject ? this.chapterRepo.listMeta(this.currentProject.id).map((m) => m.id) : [],
        getBodies: async (ids) => this.chapterRepo.getBodies(ids),
        getBody: async (id) => this.chapterRepo.getBody(id),
        setBody: async (id, body) => {
          if (!this.currentProject) return;
          const meta = this.chapterRepo.listMeta(this.currentProject.id).find((m) => m.id === id);
          if (!meta) return;
          const updated = this.chapterRepo.updateBody(id, body, meta.rev);
          this.backup.noteEdit();
          this.push.send('chapter:changed', { chapterId: id, rev: updated.rev, source: 'agent' });
        },
        chapterTitle: (id) => this.chapterRepo.get(id)?.meta.title ?? `第${id}章`,
        baseline: () => this.baseline,
        undoToCheckpoint: async (checkpointId, force) => {
          const r = await this.replayer.undoTo(checkpointId, force);
          this.push.send('checkpoint:rolled-back', {
            checkpointId,
            undone: r.undone,
            lostManualEdits: r.lostManualEdits,
          });
          return r;
        },
        rollbackRule: async (checkpointId, chapterId, newBody) => {
          // 用 checkpoint 里的原文还原，比接受传入的 newBody 更可靠：
          // newBody 可能是模型算出来的，而 patch.beforeText 是落盘前的真实原文
          const ck = await this.checkpoints.read(checkpointId);
          const patch = ck?.patches.find((p) => p.chapterId === chapterId);
          const restoreTo = patch?.beforeText ?? newBody;
          const meta = this.chapterRepo.get(chapterId)?.meta;
          if (meta) this.chapterRepo.updateBody(chapterId, restoreTo, meta.rev);
          this.push.send('chapter:changed', {
            chapterId,
            rev: (meta?.rev ?? 1) + 1,
            source: 'agent',
          });
          return { restored: true, body: restoreTo };
        },
        characters: (projectId, subject) => this.characters(projectId, subject),
        numbers: (projectId, subject) => this.numbers(projectId, subject),
        timeline: (projectId) => this.timeline(projectId),
        foreshadows: (projectId) => this.foreshadows(projectId),
        conflicts: (projectId, kind) => this.conflicts(projectId, kind),
        currentProjectId: () => this.currentProject?.id ?? null,
        saveMetrics: (chapterId, score, raw, chars, paras, sents) => {
          this.chapterRepo.saveMetrics({
            chapterId,
            chars,
            paras,
            sents,
            avgSent: raw['avgSent'] ?? 0,
            sentCv: raw['sentCv'] ?? 0,
            avgPara: raw['avgPara'] ?? 0,
            sentsPerPara: raw['sentsPerPara'] ?? 0,
            ttr: raw['ttr'] ?? 0,
            bigramTtr: raw['bigramTtr'] ?? 0,
            triRepeat: raw['triRepeat'] ?? 0,
            dialogRatio: raw['dialogRatio'] ?? 0,
            score,
            computedAt: Date.now(),
          });
        },
    };
    return this.depsCache;
  }

  get registry(): ToolRegistry {
    if (!this.registryInstance) {
      this.registryInstance = new ToolRegistry(this.toolDeps());
    }
    return this.registryInstance;
  }

  /** 供 IPC handler 直接调只读工具用的依赖（与 registry 共用同一份，避免两处漂移） */
  registryDeps(): ToolDeps {
    if (!this.depsCache) this.toolDeps();
    // toolDeps() 必定已填充 depsCache
    return this.depsCache as ToolDeps;
  }

  // ── LLM ──
  get provider(): LlmProvider {
    return findProvider(this.providerId) ?? findProvider(DEFAULT_PROVIDER_ID)!;
  }

  get llm(): LlmClient {
    if (!this.llmInstance) {
      this.llmInstance = new LlmClient({
        provider: this.provider,
        baseUrl: this.baseUrlOverride || this.provider.defaultBaseUrl,
        model: this.model || 'deepseek-chat',
        mode: this.effectiveMode,
        tools: this.registry.list(),
      });
    }
    return this.llmInstance;
  }

  /** 有效工具调用能力：未探测时用 provider 声明值 */
  get effectiveMode(): 'native' | 'prompted' | 'unsupported' {
    return this.capabilities?.functionCalling ?? this.provider.capabilities.functionCalling;
  }

  get effectiveContextTokens(): number {
    return this.capabilities?.maxContextTokens ?? this.provider.capabilities.maxContextTokens;
  }

  async configureLlm(payload: {
    providerId: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<LlmStatus> {
    this.providerId = payload.providerId || DEFAULT_PROVIDER_ID;
    if (payload.baseUrl !== undefined) this.baseUrlOverride = payload.baseUrl;
    if (payload.model !== undefined) this.model = payload.model;
    if (payload.apiKey) await saveApiKey(payload.apiKey);
    // provider 变了，能力缓存失效
    this.capabilities = null;
    this.llmInstance = null;
    const status = await this.llmStatus();
    this.push.send('llm:status', status);
    return status;
  }

  async llmStatus(): Promise<LlmStatus> {
    const p = this.provider;
    const hasKey = await hasApiKey();
    const settings: ProviderSettings = {
      providerId: p.id,
      baseUrl: this.baseUrlOverride || p.defaultBaseUrl,
      model: this.model,
      hasKey,
      displayKey: await displayKey(),
      capabilities: this.capabilities ?? p.capabilities,
      probedAt: this.probedAt,
    };
    const isLocal = isLocalProvider(p.id);
    const mode = this.effectiveMode;

    // ★ 四态明示（架构 §1.4.5）：不能都显示「已连接」
    let uiState: LlmStatus['uiState'];
    if (!hasKey && p.requiresKey) {
      uiState = { kind: 'unconfigured' };
    } else if (isLocal && mode === 'unsupported') {
      uiState = { kind: 'local-unsupported', providerName: p.name };
    } else if (isLocal && mode === 'prompted') {
      uiState = { kind: 'local-prompted', providerName: p.name };
    } else if (mode === 'prompted') {
      uiState = { kind: 'cloud-prompted', providerName: p.name };
    } else {
      uiState = { kind: 'cloud-native', providerName: p.name };
    }

    return { configured: hasKey || !p.requiresKey, isLocal, uiState, settings };
  }

  /** 当前生效的 baseUrl（IPC 的 llm:test 用） */
  get llmBaseUrl(): string {
    return this.baseUrlOverride || this.provider.defaultBaseUrl;
  }

  setCapabilities(caps: ProviderCapabilities, at: number): void {
    this.capabilities = caps;
    this.probedAt = at;
  }

  async apiKeyForFetch(): Promise<string | undefined> {
    return getApiKeyForFetch();
  }

  // ── AgentHost ──
  get agentHost(): AgentHost {
    if (!this.agentHostInstance) {
      this.agentHostInstance = new AgentHost({
        registry: this.registry,
        checkpoints: this.checkpoints,
        replayer: this.replayer,
        llm: this.llm,
        provider: this.provider,
        toolCallingMode: this.effectiveMode,
        writePolicy: this.writePolicy,
        projectId: () => this.currentProject?.id ?? null,
        projectName: () => this.currentProject?.name ?? '未打开项目',
        chapterIds: async () =>
          this.currentProject ? this.chapterRepo.listMeta(this.currentProject.id).map((m) => m.id) : [],
        chapterTitle: (id) => this.chapterRepo.get(id)?.meta.title ?? `第${id}章`,
        getBodies: async (ids) => this.chapterRepo.getBodies(ids),
        setBody: async (id, body) => {
          const meta = this.chapterRepo.get(id)?.meta;
          if (meta) this.chapterRepo.updateBody(id, body, meta.rev);
        },
        baseline: () => this.baseline,
        stateHash: async () => this.computeStateHash(),
        conflicts: (projectId) => this.conflicts(projectId),
        emit: (channel, payload) => this.push.send(channel as never, payload as never),
        saveRun: (state) => this.saveRun(state),
      });
    }
    return this.agentHostInstance;
  }

  /** 项目状态指纹（循环检测判据 B 输入） */
  async computeStateHash(): Promise<string> {
    if (!this.currentProject) return hashProjectState([], '');
    const metas = this.chapterRepo.listMeta(this.currentProject.id);
    const bodies = this.chapterRepo.getBodies(metas.map((m) => m.id));
    const chapters = metas.map((m) => ({ id: m.id, body: bodies.get(m.id) ?? '' }));
    return hashProjectState(chapters, ledgerDigest([]));
  }

  /** run 落库（保留 30 天供复盘，架构 §1.7） */
  private saveRun(state: RunState): void {
    if (!this.currentProject) return;
    try {
      this.db
        .prepare(
          'INSERT INTO runs(id, project_id, goal, status, termination, stats_json, kept_changes, started_at, ended_at) ' +
            'VALUES(?,?,?,?,?,?,?,?,?) ' +
            'ON CONFLICT(id) DO UPDATE SET status=excluded.status, ' +
            'termination=excluded.termination, stats_json=excluded.stats_json, ' +
            'kept_changes=excluded.kept_changes, ended_at=excluded.ended_at',
        )
        .run(
          state.runId,
          this.currentProject.id,
          state.goal,
          state.status,
          state.termination ? JSON.stringify(state.termination) : null,
          JSON.stringify(state.stats),
          state.keptChanges,
          state.startedAt || Date.now(),
          state.endedAt,
        );

      for (const obs of state.observations) {
        this.db
          .prepare(
            'INSERT INTO observations(run_id, step_no, tool_name, kind, summary, data_json, ok, duration_ms) ' +
              'VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            state.runId,
            obs.stepNo,
            obs.toolName,
            obs.kind,
            obs.summary.slice(0, 500),
            obs.data ? JSON.stringify(obs.data).slice(0, 4000) : null,
            obs.ok ? 1 : 0,
            Math.round(obs.durationMs),
          );
      }
    } catch (e) {
      // 轨迹持久化失败不应中断 run——轨迹只是复盘用的
      void e;
    }
  }

  // ── 风格指纹 ──
  /** ★ 绝不能用示例基线当默认：优先用用户语料重建的结果 */
  get baseline(): BaselineLike & { source: string } {
    if (!this.currentProject) {
      return { source: REFERENCE_BASELINE.source, metrics: REFERENCE_BASELINE.metrics, markerDensity: REFERENCE_BASELINE.markerDensity };
    }
    const stored = this.styleRepo.get(this.currentProject.id);
    if (stored && stored.sampleChapters >= 10) {
      return {
        source: stored.source,
        metrics: stored.metrics as Record<string, MetricSpec>,
        markerDensity: stored.markerDensity as Record<string, { p50: number; p95: number }>,
      };
    }
    return {
      source:
        stored?.source ??
        REFERENCE_BASELINE.source +
          '（你的语料还不足 10 章，暂用示例基线。建议用「重建基线」用你自己的语料生成）',
      metrics: REFERENCE_BASELINE.metrics,
      markerDensity: REFERENCE_BASELINE.markerDensity,
    };
  }

  /** 按章分位数重建基线（架构 §1.7：不用拼接均值） */
  async rebuildBaseline(chapterIds?: string[]): Promise<StyleProfile> {
    if (!this.currentProject) throw new Error('未打开项目');
    const metas = this.chapterRepo.listMeta(this.currentProject.id);
    const ids = chapterIds?.length ? chapterIds : metas.map((m) => m.id);
    const bodies = this.chapterRepo.getBodies(ids);

    const metricValues: Record<string, number[]> = {};
    const markerValues: Record<string, number[]> = {};
    for (const k of MARKER_KEYS) markerValues[k] = [];

    let used = 0;
    for (const id of ids) {
      const body = bodies.get(id);
      if (!body) continue;
      const a = analyze(body);
      if (!isSufficient(a.chars)) continue; // 样本不足的章不参与基线
      used++;
      for (const [k, v] of Object.entries(a.raw)) {
        (metricValues[k] ??= []).push(v);
      }
      for (const k of MARKER_KEYS) markerValues[k].push(a.per1000[k] ?? 0);
    }

    const metrics: Record<string, MetricSpec> = {};
    for (const [k, vals] of Object.entries(metricValues)) {
      const p = percentiles(vals);
      const ref = REFERENCE_BASELINE.metrics[k as keyof typeof REFERENCE_BASELINE.metrics];
      metrics[k] = {
        label: ref?.label ?? k,
        unit: ref?.unit ?? '',
        p05: p.p05,
        p25: p.p25,
        p50: p.p50,
        p75: p.p75,
        p95: p.p95,
        mean: p.mean,
        dir: ref?.dir ?? 'both',
      };
    }

    const markerDensity: Record<string, { p50: number; p95: number }> = {};
    for (const k of MARKER_KEYS) {
      const vals = markerValues[k] ?? [];
      markerDensity[k] = vals.length
        ? { p50: percentiles(vals).p50, p95: percentiles(vals).p95 }
        : REFERENCE_BASELINE.markerDensity[k] ?? { p50: 0, p95: 0 };
    }

    const source = `你的语料（${used} 章，按章分位数）`;
    this.styleRepo.save(this.currentProject.id, source, used, metrics, markerDensity);
    return {
      projectId: this.currentProject.id,
      source,
      sampleChapters: used,
      metrics,
      markerDensity,
      updatedAt: Date.now(),
    };
  }

  // ── 账本（内存实现，DB 已建表但先走内存以便快速可用）──
  private memCharacters = new Map<string, CharacterProfile[]>();
  private memNumbers = new Map<string, NumberAnchor[]>();
  private memTimeline = new Map<string, TimelineEvent[]>();
  private memForeshadows = new Map<string, Foreshadow[]>();

  characters(projectId: string, subject?: string): CharacterProfile[] {
    const all = this.memCharacters.get(projectId) ?? [];
    return subject ? all.filter((c) => c.name.includes(subject)) : all;
  }
  numbers(projectId: string, subject?: string): NumberAnchor[] {
    const all = this.memNumbers.get(projectId) ?? [];
    return subject ? all.filter((n) => n.subject.includes(subject)) : all;
  }
  timeline(projectId: string): TimelineEvent[] {
    return this.memTimeline.get(projectId) ?? [];
  }
  foreshadows(projectId: string): Foreshadow[] {
    return this.memForeshadows.get(projectId) ?? [];
  }
  conflicts(_projectId: string, _kind?: string): LedgerConflict[] {
    // 冲突检测在 query_ledger 内部按需算；这里返回空表示「尚未登记冲突」
    return [];
  }

  dispose(): void {
    this.backup.stopIdleWatcher();
    this.push.clear();
  }

  // ══════════════════════════════════════════════════════════════════
  // 专家团 + AI 味检测的公共依赖
  // ══════════════════════════════════════════════════════════════════

  currentProjectId(): string | null {
    return this.currentProject?.id ?? null;
  }

  getChapterBody(id: string): string {
    return this.chapterRepo.getBody(id) ?? '';
  }

  allChapterIds(): string[] {
    const pid = this.currentProject?.id;
    if (!pid) return [];
    return this.chapterRepo.listMeta(pid).map((c) => c.id);
  }

  /**
   * 写回正文（AI 味改写用）。
   * 走 repo.updateBody 以复用乐观锁（expectedRev 不匹配会抛 E_REVISION_CONFLICT）。
   */
  async updateChapterBody(id: string, body: string, _source: string): Promise<void> {
    const meta = this.chapterRepo.get(id);
    if (!meta) throw new Error(`章节不存在：${id}`);
    this.chapterRepo.updateBody(id, body, meta.meta.rev);
  }

  // ── 专家团配置 ──

  expertConfig(): ExpertTeamConfig {
    return this.expertCfg;
  }

  setExpertConfig(cfg: ExpertTeamConfig): void {
    this.expertCfg = { ...DEFAULT_EXPERT_CONFIG, ...cfg };
  }

  /**
   * 构造评审依赖。★ 模型不可用时返回 null——调用方据此给出明确错误，
   * 而不是让评审悄无声息地失败。
   */
  buildReviewer(_projectId: string): ReviewerDeps | null {
    const llm = this.llm;
    if (!llm) return null;
    return {
      llm,
      provider: this.provider,
      config: this.expertCfg,
      getChapterBody: (id) => this.getChapterBody(id),
    };
  }

  // ── AI 味板块配置（独立于专家团）──

  flavorConfig(): FlavorConfig {
    return this.flavorCfg;
  }

  setFlavorConfig(cfg: FlavorConfig): void {
    this.flavorCfg = { ...DEFAULT_FLAVOR_CONFIG, ...cfg };
  }

  /**
   * 当前项目生效的 AI 味基线：有用户基线用用户的，否则回退内置默认。
   * ★ 回退判断留在本方法（调用方不必关心「有没有用户基线」）；
   *   未打开项目时也用内置默认。
   * ★ 单维度回退（样本不足）已由 `buildFlavorBaseline` 在**写入时**填好默认值 +
   *   `calibrated:false`，故这里**不再做逐字段合并**（避免双重兜底）。
   */
  flavorBaseline(): FlavorBaseline {
    const pid = this.currentProject?.id;
    if (!pid) return DEFAULT_FLAVOR_BASELINE;
    return this.flavorBaselineRepo.latest(pid) ?? DEFAULT_FLAVOR_BASELINE;
  }

  /**
   * 用当前项目语料**重建**用户基线（T03）。
   *
   * ★ 样本闸门：有效章数 < `DEFAULT_MIN_CHAPTERS`（10）时**不保存**——避免一份全回退的
   *   劣基线覆盖默认基线（否则用户会「越重建越差」且不自知）。此时返回 `saved:false` + warning。
   * ★ 保存后 `flavorBaseline()` 会自动用最新的用户基线；不保存则继续用默认。
   */
  async rebuildFlavorBaseline(chapterIds?: string[]): Promise<BuildResult & { saved: boolean }> {
    if (!this.currentProject) throw new Error('未打开项目');
    const metas = this.chapterRepo.listMeta(this.currentProject.id);
    const ids = chapterIds && chapterIds.length > 0 ? chapterIds : metas.map((m) => m.id);
    const bodies = this.chapterRepo.getBodies(ids);
    const samples = ids.map((id) => ({ chapterId: id, text: bodies.get(id) ?? '' }));

    // ★ 特征版本由服务注入（builder 保持纯函数：不 import 版本常量、不读库）。
    const result = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);

    let saved = false;
    if (result.used >= DEFAULT_MIN_CHAPTERS) {
      this.flavorBaselineRepo.save(this.currentProject.id, result.baseline);
      saved = true;
    } else {
      result.warnings.push(
        `有效章节不足 ${DEFAULT_MIN_CHAPTERS} 章，未保存用户基线（继续使用默认基线）。`,
      );
    }
    return { ...result, saved };
  }

  /**
   * 仪表盘聚合统计（dash:stats 的数据源）。
   * ★ 全部来自真实数据：状态计数 / 卷进度 / 检查点数 / AgentHost 用量；不造假数。
   *   卷进度 = 稳定稿（done+revised）字数占全卷字数比。
   */
  dashStats(projectId: string): DashStats {
    const metas = this.chapterRepo.listMeta(projectId);
    const byStatus = { todo: 0, draft: 0, revised: 0, done: 0 };
    let totalChars = 0;
    for (const m of metas) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      totalChars += m.charCount;
    }
    const volumes = this.projectRepo.volumes(projectId).map((v) => {
      const cs = metas.filter((m) => m.volumeId === v.id);
      const chars = cs.reduce((s, m) => s + m.charCount, 0);
      const solid = cs
        .filter((m) => m.status === 'done' || m.status === 'revised')
        .reduce((s, m) => s + m.charCount, 0);
      return {
        id: v.id,
        title: v.title,
        chapters: cs.length,
        chars,
        progressPct: chars > 0 ? Math.round((solid / chars) * 100) : 0,
      };
    });
    const usage = this.agentHostInstance ? this.agentHostInstance.usage : null;
    return {
      totalChars,
      chapterCount: metas.length,
      byStatus,
      volumes,
      checkpoints: this.checkpointsInstance ? this.checkpointsInstance.listForRun().length : 0,
      llm: usage,
    };
  }
}

export { DEFAULT_BUDGET };