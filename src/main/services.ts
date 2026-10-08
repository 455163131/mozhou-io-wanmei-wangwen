/**
 * 应用服务容器（依赖装配）。
 *
 * 把DB / repo / 工具注册表 / checkpoint / LLM / AgentHost 的依赖关系集中在一处，
 * 避免在 IPC handler 里到处 new 出不完整的对象图。
 */
import { join, resolve } from 'node:path';
import { app } from 'electron';
import type { Project, StyleProfile, ProjectBackup } from '@shared/types/project';
import { PROJECT_BACKUP_FORMAT_VERSION } from '@shared/types/project';
import type { CharacterProfile, LedgerConflict, NumberAnchor, TimelineEvent, Foreshadow } from '@shared/types/ledger';
import type { LedgerCounts, LedgerEntries } from '@shared/types/ledger';
import { detectConflicts } from './tools/impl/ledger-query';
import type { MetricSpec } from '@shared/types/project';
import type { RunState } from '@shared/types/agent';
import { openDatabase, type MzDatabase } from './db/database';
import { ChapterRepo, ProjectRepo, StyleProfileRepo, percentiles } from './db/repos/chapter-repo';
import { LedgerRepo } from './db/repos/ledger-repo';
import { DailyWriteRepo } from './db/repos/daily-write-repo';
import { ToolRegistry, type ToolDeps } from './tools/registry';
import { CheckpointManager } from './checkpoint/manager';
import { Replayer } from './checkpoint/replayer';
import { PushChannel } from './ipc/push';
import { AgentHost } from './agent/host';
import { LlmClient } from './llm/client';
import { findProvider, DEFAULT_PROVIDER_ID, isLocalProvider } from '@shared/constants/providers';
import { REFERENCE_BASELINE } from '@shared/constants/metrics';
import { DEFAULT_WRITE_POLICY, type BackupTrigger } from '@shared/constants/checkpoint';
import { DEFAULT_BUDGET } from '@shared/constants/budget';
import { MARKER_KEYS, analyze, isSufficient } from '@shared/metrics-engine';
import type { BaselineLike } from './rule-engine/plan-fixes';
import { hashProjectState, ledgerDigest, ledgerStateEntries } from './util/hash';
import { isAllowedLlmBaseUrl } from '@shared/util/external-url';
import { MzError } from '@shared/types/ipc';
import { BackupManager, type BackupStats } from './fs/backup';
import { ensureDir } from './fs/project-fs';
import { countChars } from '@shared/util/text-zh';
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
  /** 账本（§4 第 13 条：此前只有 migrate 建的表，没有任何读写方） */
  readonly ledgerRepo: LedgerRepo;
  /** 日增量账（§4 第 3 条：今日新增 / 连更 / 本月净增的唯一数据源） */
  readonly dailyWrites: DailyWriteRepo;
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
    // 日增量必须在 chapterRepo 之前建：正文写入的记账点就在 updateBody 里
    this.dailyWrites = new DailyWriteRepo(this.db);
    this.chapterRepo = new ChapterRepo(this.db, this.dailyWrites);
    this.projectRepo = new ProjectRepo(this.db);
    this.styleRepo = new StyleProfileRepo(this.db);
    this.expertRepo = new ExpertReviewRepo(this.db);
    this.flavorRepo = new FlavorRepo(this.db);
    this.flavorBaselineRepo = new FlavorBaselineRepo(this.db);
    this.ledgerRepo = new LedgerRepo(this.db);
    this.backup = new BackupManager(app.getPath('userData'));

    // ★ L3 备份时机之二：空闲 30 分钟。修复前 `startIdleWatcher` 全项目无调用者，
    //   这条时机等于不存在。run 执行期间不备份——拍到半改状态，
    //   恢复出来比不恢复更难理解。
    this.backup.startIdleWatcher(
      () => this.agentHostInstance?.isRunning ?? false,
      async () => {
        await this.backupNow('idle-30min');
      },
    );
  }

  // ── 当前项目 ──
  get project(): Project | null {
    return this.currentProject;
  }

  async openProject(dir: string): Promise<Project> {
    await ensureDir(dir);
    // 路径归一化后再比对：否则 C:\proj 与 C:/proj（或带尾斜杠）会被当成两个项目，
    // 在同一目录下建出两条 projects 记录。
    const rootDir = resolve(dir);
    // 按目录找已有项目，没有则新建
    const existing = this.projectRepo.list().find((p) => resolve(p.rootDir) === rootDir);
    const project = existing ?? this.projectRepo.create(rootDir.split(/[\\/]/).pop() ?? '未命名', rootDir);

    // ★ 幂等守卫：同一项目重复打开时直接返回，**不重置单例、不重推事件**。
    //   这是无限 IPC 循环的主进程侧断点——渲染层「收到 project:opened → 刷新」
    //   若不慎再调 open，没有这道守卫就会成环，且每轮都把下面四个单例置 null，
    //   摧毁正在执行的 Agent run。
    if (this.currentProject?.id === project.id) return project;

    this.currentProject = project;
    await ensureDir(join(rootDir, 'chapters'));
    await ensureDir(join(rootDir, 'checkpoints', 'archive'));
    await ensureDir(join(rootDir, 'backups'));

    // 重置项目相关状态
    this.registryInstance = null;
    this.checkpointsInstance = null;
    this.replayerInstance = null;
    this.agentHostInstance = null;

    // ★ 还原上一次会话的 checkpoint（改动历史 / 回滚能力跨会话存活）。
    //   修复前 restoreSeq 与 pruneArchive 都无调用者：重启后改动历史归零，
    //   磁盘存档既读不回来又永不清理。放在这里是因为存档目录刚被 ensureDir 建好。
    //   还原失败不该阻止打开项目——最坏情况只是看不到旧历史，故 catch 后留痕继续。
    try {
      const restored = await this.checkpoints.hydrate();
      if (restored > 0) console.log(`[services] 已还原 ${restored} 份历史 checkpoint`);
    } catch (e) {
      console.error('[services] checkpoint 还原失败（项目仍可打开，但改动历史可能不完整）：', e);
    }

    this.push.send('project:opened', { projectId: project.id });
    return project;
  }

  closeProject(): void {
    this.currentProject = null;
    this.checkpointsInstance?.clearProject();
    // ★ 四个单例必须全部置空。此前漏了 checkpoints/replayer，
    //   导致切换项目后回滚操作仍绑定**旧项目**的 checkpoint store。
    this.registryInstance = null;
    this.checkpointsInstance = null;
    this.replayerInstance = null;
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
            // ★ 上面那句判空只覆盖「构造本 manager 的那一刻」；这个闭包是之后才跑的，
            //   期间 closeProject() 会把 currentProject 置空。所以在此重取，不用 !。
            const projectId = this.currentProject?.id;
            if (projectId === undefined) {
              throw new MzError('E_INTERNAL', '写入正文时项目已被关闭');
            }
            const meta = this.chapterRepo.listMeta(projectId).find((m) => m.id === id);
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
          // 同 checkpoints 的 setBody：回滚跑得更晚，项目可能已被关掉
          const projectId = this.currentProject?.id;
          if (projectId === undefined) {
            throw new MzError('E_INTERNAL', '回滚写入时项目已被关闭');
          }
          const meta = this.chapterRepo.listMeta(projectId).find((m) => m.id === id);
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
        upsertLedger: (projectId, entries) => this.upsertLedger(projectId, entries),
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
    const p = findProvider(this.providerId) ?? findProvider(DEFAULT_PROVIDER_ID);
    // DEFAULT_PROVIDER_ID 是内置清单里的常量，取不到即代码缺陷。
    // 绝不能让它带着 undefined 往下走——那会在 .baseUrl 上炸成裸 TypeError。
    if (!p) throw new MzError('E_INTERNAL', `内置默认 provider「${DEFAULT_PROVIDER_ID}」不在清单里`);
    return p;
  }

  get llm(): LlmClient {
    if (!this.llmInstance) {
      this.llmInstance = new LlmClient({
        provider: this.provider,
        baseUrl: this.baseUrlOverride || this.provider.defaultBaseUrl,
        // 兜底模型必须来自 provider 自身。此前这里硬编码 'deepseek-chat' 当六家通用兜底，
        // 切到 OpenRouter 却没填模型时会把 DeepSeek 的模型名发过去，必然失败。
        model: this.model || this.provider.defaultModel || '',
        mode: this.effectiveMode,
        tools: this.registry.list(),
        // ★ Key 走动态解析：构造时不取出，每次请求才从 safeStorage 解密一次。
        //   此前这里**根本不传 Key**，导致六家云 provider 的 Agent 请求全部不带
        //   Authorization 头 → 401；而「测试连接」却是通的（那条路径单独取了 Key），
        //   故障表现为「配置成功但 Agent 不可用」，极难归因。
        apiKeyProvider: () => getApiKeyForFetch(),
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
    // ★ baseUrl 来自渲染层，必须校验协议再接受。
    //   `Authorization: Bearer <key>` 会发往这个地址；若允许非回环的 http://，
    //   用户的 API Key 就是明文过网，且响应可被中间人改写。
    //   本地运行时（Ollama / LM Studio）的 http://127.0.0.1 是正当用法，已放行。
    if (payload.baseUrl !== undefined && payload.baseUrl !== '') {
      const verdict = isAllowedLlmBaseUrl(payload.baseUrl);
      if (!verdict.ok) {
        throw new MzError('E_INVALID_ARGS', `模型地址不可用：${verdict.reason}`, {
          baseUrl: payload.baseUrl,
        });
      }
      this.baseUrlOverride = payload.baseUrl;
    } else if (payload.baseUrl === '') {
      // 显式清空 = 回到 provider 默认地址
      this.baseUrlOverride = '';
    }
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
    const projectId = this.currentProject.id;
    const metas = this.chapterRepo.listMeta(projectId);
    const bodies = this.chapterRepo.getBodies(metas.map((m) => m.id));
    const chapters = metas.map((m) => ({ id: m.id, body: bodies.get(m.id) ?? '' }));
    // ★ 账本必须进指纹：Agent 补一条人物设定而没动正文时，若这里传空数组，
    //   判据 B 会算出与上一步逐字相同的哈希，把「确实改了账本」误报成 no-effect。
    const ledger = ledgerStateEntries({
      characters: this.characters(projectId),
      numbers: this.numbers(projectId),
      timeline: this.timeline(projectId),
      foreshadows: this.foreshadows(projectId),
    });
    return hashProjectState(chapters, ledgerDigest(ledger));
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

  // ── 账本 ──
  //
  // ★ 修复前这里是四个 `Map<string, T[]>`，全仓**没有任何 `.set()`**：
  //   注释写着"内存实现以便快速可用"，但没有写入口，于是账本连会话内都恒为空，
  //   `query_ledger` 永远返回空集合，S2 跨章一致性对账无数据来源（§4 第 13 条）。
  //   现在读写一律走 LedgerRepo（真库），`ledger_*` 五张表里的四张终于有人用了。
  //   唯一没有落库的是 `ledger_conflicts`：冲突按最新账本现算，
  //   存下来反而会留下一份过期的"待裁决"记录去提醒用户。

  characters(projectId: string, subject?: string): CharacterProfile[] {
    return this.ledgerRepo.characters(projectId, subject);
  }
  numbers(projectId: string, subject?: string): NumberAnchor[] {
    return this.ledgerRepo.numbers(projectId, subject);
  }
  timeline(projectId: string): TimelineEvent[] {
    return this.ledgerRepo.timeline(projectId);
  }
  foreshadows(projectId: string): Foreshadow[] {
    return this.ledgerRepo.foreshadows(projectId);
  }

  /**
   * 批量登记账本（§4 第 13 条的写入口）。
   *
   * 四类都可省略；每一类内部是一条事务（要么全写要么全不写），
   * 返回登记后各类的整表条数，让调用方拿到"现在账本上有多少"而不是"我写了几条"。
   */
  upsertLedger(projectId: string, entries: LedgerEntries): LedgerCounts {
    if (entries.characters) this.ledgerRepo.upsertCharacters(projectId, entries.characters);
    if (entries.numbers) this.ledgerRepo.upsertNumbers(projectId, entries.numbers);
    if (entries.timeline) this.ledgerRepo.upsertTimeline(projectId, entries.timeline);
    if (entries.foreshadows) this.ledgerRepo.upsertForeshadows(projectId, entries.foreshadows);
    return this.ledgerRepo.counts(projectId);
  }

  conflicts(projectId: string, kind?: string): LedgerConflict[] {
    // detectConflicts 此前全仓零调用方——冲突检测写好了却没人喂数据（第 13 条的另一半）
    const found = detectConflicts(
      this.ledgerRepo.characters(projectId),
      this.ledgerRepo.numbers(projectId),
      this.ledgerRepo.timeline(projectId),
    );
    return kind ? found.filter((c) => c.kind === kind) : found;
  }

  // ── L3 全量备份（架构 §1.8）──

  /**
   * 构建全量备份载荷。
   *
   * ★★ 必须含正文 ★★
   * 修复前唯一调用点传的是 `{ at: Date.now() }`——一个纯时间戳，
   * 落盘的 `.mzproj` 里没有任何章节内容，所谓三层备份实为零层。
   * 现在返回结构化的 ProjectBackup，类型上就不允许再退化成时间戳。
   *
   * @returns 未打开项目时为 null（不是错误，调用方静默跳过）
   */
  buildBackupPayload(trigger: BackupTrigger): ProjectBackup | null {
    const project = this.currentProject;
    if (!project) return null;

    // 这是「一次读全书」的唯一正当入口：全量备份是显式冷路径，
    // 只在手动保存 / 退出 / 空闲三个低频时机触发（见 listAllWithBody 注释）。
    const chapters = this.chapterRepo.listAllWithBody(project.id);
    const totalChars = chapters.reduce((sum, c) => sum + countChars(c.body), 0);

    return {
      formatVersion: PROJECT_BACKUP_FORMAT_VERSION,
      createdAt: Date.now(),
      trigger,
      project,
      volumes: this.projectRepo.volumes(project.id),
      chapters,
      // 账本当前是内存态（docs/REMAINING.md §1.4），一并落进备份，
      // 至少守住「重启不丢」这条底线。
      ledger: {
        characters: this.characters(project.id),
        numbers: this.numbers(project.id),
        timeline: this.timeline(project.id),
        foreshadows: this.foreshadows(project.id),
      },
      style: this.styleRepo.get(project.id),
      integrity: { chapterCount: chapters.length, totalChars },
    };
  }

  /** 立即做一次全量备份。未打开项目时返回 null。 */
  async backupNow(trigger: BackupTrigger): Promise<BackupStats | null> {
    const payload = this.buildBackupPayload(trigger);
    if (!payload) return null;
    return this.backup.backup(trigger, payload.project.name, payload);
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
    const daily = this.dailyWrites.summary(projectId);
    const pricePerK = this.projectRepo.get(projectId)?.pricePerK ?? 0;
    return {
      totalChars,
      chapterCount: metas.length,
      byStatus,
      volumes,
      checkpoints: this.checkpointsInstance ? this.checkpointsInstance.listForRun().length : 0,
      llm: usage,
      daily,
      pricePerK,
      // ★ 未设单价时给 0 而不是拿"行业均价"算一个：钱是最容易被当真的数字。
      //   本月净增为负也按 0 结——稿费不会因为删字变成欠款。
      monthPay: pricePerK > 0 ? Math.round((Math.max(0, daily.monthNet) / 1000) * pricePerK) : 0,
    };
  }
}

export { DEFAULT_BUDGET };