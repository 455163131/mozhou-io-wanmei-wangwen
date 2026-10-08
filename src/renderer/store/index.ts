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
import type { StepRecord, TerminationReason, Plan, RunStats } from '@shared/types/agent';
import type { LlmStatus } from '@shared/types/provider';
import type { Checkpoint } from '@shared/types/checkpoint';
import type { ChapterAnalysis, HealthReport } from '@shared/types/health';

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
          s.body = body;
          s.dirty = body !== s.body || s.dirty;
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
  checkpoints: Checkpoint[];
  llmStatus: LlmStatus | null;

  setRun: (runId: string, goal: string) => void;
  setPlan: (plan: Plan) => void;
  appendStep: (step: StepRecord) => void;
  updateStep: (stepNo: number, patch: Partial<StepRecord>) => void;
  setStatus: (s: string) => void;
  setTermination: (t: TerminationReason, stats: RunStats, kept: number) => void;
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
          if (i >= 0) s.steps[i] = { ...s.steps[i], ...step };
          else s.steps.push(step);
          s.stats.steps = s.steps.length;
          s.stats.edits += step.edits?.length ?? 0;
          if (step.checkpointId) s.stats.checkpoints += 1;
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
          s.checkpoints = [];
        }),
    })),
  ),
);

// ───────────────────────── settings-store ─────────────────────────

interface SettingsState {
  writePolicy: 'preview-only' | 'auto-with-undo' | 'ask-per-tool';
  budget: { maxSteps: number; maxCostCny: number; maxTokens: number };
  setWritePolicy: (p: SettingsState['writePolicy']) => void;
  setBudget: (b: Partial<SettingsState['budget']>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector(
    immer((set) => ({
      writePolicy: 'auto-with-undo',
      budget: { maxSteps: 24, maxCostCny: 5, maxTokens: 200_000 },
      setWritePolicy: (p) =>
        set((s) => {
          s.writePolicy = p;
        }),
      setBudget: (b) =>
        set((s) => {
          Object.assign(s.budget, b);
        }),
    })),
  ),
);