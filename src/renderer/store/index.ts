/**
 * Zustand stores（架构 §4.1）。
 *
 * ★ **必须用 selector 订阅**，不要在组件里 `useStore()` 无选择器。
 *   Agent 轨迹每步都 push，全订阅会让编辑器与体检面板跟着重渲染——
 *   长文下会明显卡顿。这条是架构 §6 第 5 条硬要求。
 *
 * 用 immer 中间件：改轨迹 state 时写起来像可变对象，实际不可变。
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { ChapterMeta, Project, Volume } from '@shared/types/project';
import type { StepRecord, TerminationReason, Plan, RunBudget, RunStats } from '@shared/types/agent';
import type { LlmStatus } from '@shared/types/provider';
import type { Checkpoint } from '@shared/types/checkpoint';
import type { ChapterAnalysis, HealthReport } from '@shared/types/health';
import type { DashStats } from '@shared/types/ipc';
import { DEFAULT_THEME, type Theme } from '../lib/theme';

// ───────────────────────── project-store ─────────────────────────

interface ProjectState {
  project: Project | null;
  chapters: ChapterMeta[];
  volumes: Volume[];
  currentChapterId: string | null;
  loading: boolean;
  error: string | null;

  setProject: (p: Project | null) => void;
  setChapters: (c: ChapterMeta[]) => void;
  setVolumes: (v: Volume[]) => void;
  setCurrent: (id: string | null) => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
  upsertChapterMeta: (m: ChapterMeta) => void;
}

export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector(
    immer((set) => ({
      project: null,
      chapters: [],
      volumes: [],
      currentChapterId: null,
      loading: false,
      error: null,

      setProject: (p) =>
        set((s) => {
          s.project = p;
          if (!p) {
            s.chapters = [];
            s.volumes = [];
            s.currentChapterId = null;
          }
        }),
      setChapters: (c) =>
        set((s) => {
          s.chapters = c;
          // 当前章不存在时自动选第一章，避免空白编辑器
          if (!c.some((m) => m.id === s.currentChapterId)) {
            s.currentChapterId = c.length ? c[0].id : null;
          }
        }),
      setVolumes: (v) =>
        set((s) => {
          s.volumes = v;
        }),
      setCurrent: (id) =>
        set((s) => {
          s.currentChapterId = id;
        }),
      setLoading: (v) =>
        set((s) => {
          s.loading = v;
        }),
      setError: (e) =>
        set((s) => {
          s.error = e;
        }),
      upsertChapterMeta: (m) =>
        set((s) => {
          const i = s.chapters.findIndex((x) => x.id === m.id);
          if (i >= 0) s.chapters[i] = m;
          else s.chapters.push(m);
        }),
    })),
  ),
);

// ───────────────────────── editor-store（本地态，不落盘） ─────────────────────────

interface EditorState {
  /** 当前章正文。编辑中的态只在内存，落盘由用户显式或 Agent 触发 */
  body: string;
  /** 载入时的 rev，用于乐观锁 */
  rev: number;
  dirty: boolean;
  saving: boolean;

  load: (body: string, rev: number) => void;
  setBody: (body: string) => void;
  setSaving: (v: boolean) => void;
  markClean: (rev: number) => void;
}

export const useEditorStore = create<EditorState>()(
  subscribeWithSelector(
    immer((set) => ({
      body: '',
      rev: 1,
      dirty: false,
      saving: false,
      load: (body, rev) =>
        set((s) => {
          s.body = body;
          s.rev = rev;
          s.dirty = false;
        }),
      setBody: (body) =>
        set((s) => {
          // ★ 必须「先比较、后赋值」。immer 的 draft 上一旦执行 s.body = body，
          //   再判 body !== s.body 恒为 false → dirty 永远置不上真 →
          //   保存按钮永久禁用、Ctrl+S 直接 return、1.5s 自动保存订阅永不触发，
          //   用户在编辑器里敲的字一个都不会落盘。
          if (body === s.body) return;
          s.body = body;
          s.dirty = true;
        }),
      setSaving: (v) =>
        set((s) => {
          s.saving = v;
        }),
      markClean: (rev) =>
        set((s) => {
          s.dirty = false;
          s.rev = rev;
        }),
    })),
  ),
);

// ───────────────────────── health-store ─────────────────────────

interface HealthState {
  analyses: ChapterAnalysis[];
  report: HealthReport | null;
  loading: boolean;
  setAnalyses: (a: ChapterAnalysis[]) => void;
  setReport: (r: HealthReport | null) => void;
  setLoading: (v: boolean) => void;
  analysisOf: (chapterId: string) => ChapterAnalysis | undefined;
}

export const useHealthStore = create<HealthState>()(
  subscribeWithSelector(
    immer((set, get) => ({
      analyses: [],
      report: null,
      loading: false,
      setAnalyses: (a) =>
        set((s) => {
          s.analyses = a;
        }),
      setReport: (r) =>
        set((s) => {
          s.report = r;
        }),
      setLoading: (v) =>
        set((s) => {
          s.loading = v;
        }),
      analysisOf: (chapterId) => get().analyses.find((a) => a.chapterId === chapterId),
    })),
  ),
);

// ───────────────────────── agent-store（高频流，用 selector 订阅） ─────────────────────────

interface AgentStoreState {
  runId: string | null;
  status: string;
  goal: string;
  plan: Plan | null;
  /** 轨迹步骤：只追加，不修改（除状态流转） */
  steps: StepRecord[];
  termination: TerminationReason | null;
  stats: RunStats;
  /**
   * ★ 第 32 条：预算仪表的唯一数据源。null = 还没有活着的 run。
   *   修复前渲染层只能靠 `settings-store` 里那份手抄的默认值猜上限，
   *   而真正生效的上限是主进程 `agent.run` 传的 budget——两份数可以不一样。
   */
  budget: RunBudget | null;
  checkpoints: Checkpoint[];
  llmStatus: LlmStatus | null;

  setRun: (runId: string, goal: string) => void;
  setPlan: (plan: Plan) => void;
  appendStep: (step: StepRecord) => void;
  updateStep: (stepNo: number, patch: Partial<StepRecord>) => void;
  setStatus: (s: string) => void;
  setTermination: (t: TerminationReason, stats: RunStats, kept: number) => void;
  setBudgetState: (b: RunBudget | null) => void;
  setCheckpoints: (c: Checkpoint[]) => void;
  setLlmStatus: (s: LlmStatus) => void;
  reset: () => void;
}

const EMPTY_STATS: RunStats = {
  steps: 0,
  tokensIn: 0,
  tokensOut: 0,
  costCny: 0,
  wallMs: 0,
  toolCalls: 0,
  edits: 0,
  checkpoints: 0,
};

export const useAgentStore = create<AgentStoreState>()(
  subscribeWithSelector(
    immer((set) => ({
      runId: null,
      status: 'idle',
      goal: '',
      plan: null,
      steps: [],
      termination: null,
      stats: { ...EMPTY_STATS },
      budget: null,
      checkpoints: [],
      llmStatus: null,

      setRun: (runId, goal) =>
        set((s) => {
          s.runId = runId;
          s.goal = goal;
          s.status = 'planning';
          s.steps = [];
          s.plan = null;
          s.termination = null;
          s.stats = { ...EMPTY_STATS };
          // ★ 第 32 条：新 run 开跑时清掉上一轮的预算快照——留着会让仪表
          //   在新 run 的头几百毫秒里显示上一条 run 的剩余量。
          s.budget = null;
          s.checkpoints = [];
        }),
      setPlan: (plan) =>
        set((s) => {
          s.plan = plan;
        }),
      appendStep: (step) =>
        set((s) => {
          // 幂等：同 stepNo 重复 push 时更新而非追加（事件重放场景）
          const i = s.steps.findIndex((x) => x.stepNo === step.stepNo);
          const prev = i >= 0 ? s.steps[i] : null;
          const merged = prev ? { ...prev, ...step } : step;
          if (prev) s.steps[i] = merged;
          else s.steps.push(merged);
          s.stats.steps = s.steps.length;
          // ★ 第 27 条：计数必须按**增量**算，不能重推一次就翻一倍。
          //   修复前这两行是裸 `+=`：注释自称幂等，账却不幂等。以前每步只推一次
          //   所以看不出来；现在同一步要推两次（running → 终态），回滚后还会再推一次
          //   （rolled-back），edits / checkpoints 会被算成两倍。
          s.stats.edits += (merged.edits?.length ?? 0) - (prev?.edits?.length ?? 0);
          if (merged.checkpointId && !prev?.checkpointId) s.stats.checkpoints += 1;
        }),
      updateStep: (stepNo, patch) =>
        set((s) => {
          const i = s.steps.findIndex((x) => x.stepNo === stepNo);
          if (i >= 0) Object.assign(s.steps[i], patch);
        }),
      setStatus: (st) =>
        set((s) => {
          s.status = st;
        }),
      setTermination: (t, stats, kept) =>
        set((s) => {
          s.termination = t;
          s.stats = stats;
          s.status = 'terminated';
          void kept;
        }),
      /**
       * ★ 第 32 条：预算快照的唯一写入口。
       *   **终止时不清空**——用户正是在看到 `BUDGET_EXCEEDED` 的那一刻最需要
       *   知道"刚才撞的是哪一档、还剩多少"，把仪表擦干净等于把解释一起擦掉。
       */
      setBudgetState: (b) =>
        set((s) => {
          s.budget = b;
        }),
      setCheckpoints: (c) =>
        set((s) => {
          s.checkpoints = c;
        }),
      setLlmStatus: (st) =>
        set((s) => {
          s.llmStatus = st;
        }),
      reset: () =>
        set((s) => {
          s.runId = null;
          s.status = 'idle';
          s.goal = '';
          s.plan = null;
          s.steps = [];
          s.termination = null;
          s.stats = { ...EMPTY_STATS };
          s.budget = null;
          s.checkpoints = [];
        }),
    })),
  ),
);

// ───────────────────────── dash-store ─────────────────────────

/**
 * 全书统计（底栏 + 仪表盘 + 规划页共用的那一份事实）。
 *
 * ★ 第 30 条：修复前 `aiFlavor.dashStats()` 在渲染层有**四个取数点、散在三个组件**
 *   （App 底栏、DashboardView、PlanView 两处），各自 useState、各自 catch。
 *   同一个事实四个副本，就是"底栏显示 0 而侧栏显示 289"能活下来的原因——
 *   没有一处是"权威"，也就没有一处会负责刷新。
 *   现在取数只剩 `hooks/use-dash.ts` 一处，这里只放状态（不碰 bridge，
 *   以便在 environment:'node' 下被真正测到）。
 */
interface DashState {
  dash: DashStats | null;
  /** 取数失败的原文；成功时要清成 null，否则上一次的错误会一直挂在仪表盘上 */
  error: string | null;
  setDash: (d: DashStats | null) => void;
  setError: (e: string | null) => void;
}

export const useDashStore = create<DashState>()(
  subscribeWithSelector((set) => ({
    // 初值必须是 null 而不是零值对象：底栏据此显示「—」，
    // 填 0 会把"还没取到数"演成"这本书一个字没有"。
    dash: null,
    error: null,
    setDash: (d) => set({ dash: d }),
    setError: (e) => set({ error: e }),
  })),
);

// ───────────────────────── settings-store ─────────────────────────

interface SettingsState {
  writePolicy: 'preview-only' | 'auto-with-undo' | 'ask-per-tool';
  budget: { maxSteps: number; maxCostCny: number; maxTokens: number };
  /**
   * 皮肤。初值是 DEFAULT_THEME，**不在这里读 storage**——本文件归 tsconfig.node.json 管，
   * 那个工程没有 DOM lib。启动时由 main.tsx 用 readTheme(localStorage) 同步进来。
   */
  theme: Theme;
  setWritePolicy: (p: SettingsState['writePolicy']) => void;
  setBudget: (b: Partial<SettingsState['budget']>) => void;
  /** 只改状态。落 DOM 与持久化在 lib/theme-dom.ts 的 commitTheme，两边必须一起调 */
  setTheme: (t: Theme) => void;
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector(
    immer((set) => ({
      writePolicy: 'auto-with-undo',
      budget: { maxSteps: 24, maxCostCny: 5, maxTokens: 200_000 },
      theme: DEFAULT_THEME,
      setWritePolicy: (p) =>
        set((s) => {
          s.writePolicy = p;
        }),
      setBudget: (b) =>
        set((s) => {
          Object.assign(s.budget, b);
        }),
      setTheme: (t) =>
        set((s) => {
          s.theme = t;
        }),
    })),
  ),
);
// ───────────────────────── snapshot-handoff（P2-E ②，本地态，不落盘） ─────────────────────────

/**
 * 长期记忆页 → 人物记忆页矩阵编辑器的跨页交接。
 * offer 只写草稿；take 读一次即清——CharacterView 取数完成后开既有 cell 弹窗，
 * 不自动落库（保存仍走 charstate:set，由作者确认）。草稿不持久化：
 * 应用重启即丢，这是「待编辑」而非「账」，丢了不欠数据。
 */
export interface SnapshotDraft {
  characterId: string;
  chapterNo: number;
  snapshot: string;
}

interface SnapshotHandoffState {
  draft: SnapshotDraft | null;
  offer: (d: SnapshotDraft) => void;
  take: () => SnapshotDraft | null;
}

export const useSnapshotHandoff = create<SnapshotHandoffState>()((set, get) => ({
  draft: null,
  offer: (d) => set({ draft: d }),
  take: () => {
    const d = get().draft;
    if (d) set({ draft: null });
    return d;
  },
}));
