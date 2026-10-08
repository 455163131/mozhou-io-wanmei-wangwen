/**
 * Agent 事件流 → store（架构 T19）。
 *
 * ★ 高频事件必须增量 push 到 store，让轨迹面板单独重渲染。
 *   若在组件里直接订阅 IPC，每个事件都会触发整棵子树重渲染。
 */
import { useEffect } from 'react';
import { bridge, errorText, onAgentEvent } from './use-mz-bridge';
import { useAgentStore, useProjectStore, useEditorStore, useHealthStore } from '../store';
import type { StepRecord, Plan, TerminationReason, RunStats } from '@shared/types/agent';
import type { LlmStatus } from '@shared/types/provider';

export function useAgentStream(): void {
  useEffect(() => {
    const agent = useAgentStore.getState;

    // ── 轨迹步骤：只订阅 StepTimeline 需要的字段 ──
    const offStep = onAgentEvent('agent:step', (p) => {
      agent().appendStep(p.step as StepRecord);
      // 本步改动了正文 → 刷新体检面板（增量只更当前章）
      // Edit 类型里没有 chapterId（改动落在哪个章由 ChangeSet 决定），
      // 故从 checkpoint 事件里取不到章号时退化为刷新当前章
      const chId = useProjectStore.getState().currentChapterId;
      if (chId) void refreshChapterAnalysis(chId);
    });

    const offPlan = onAgentEvent('agent:plan', (p) => {
      agent().setPlan(p.plan as Plan);
    });

    const offTerminated = onAgentEvent('agent:terminated', (p) => {
      agent().setTermination(
        p.reason as TerminationReason,
        p.stats as RunStats,
        p.keptChanges ?? 0,
      );
      // 终止后拉一次完整体检，让用户看到最终状态
      void refreshAllAnalysis();
      // 拉 checkpoint 列表供改动历史使用
      void refreshCheckpoints();
    });

    const offCheckpoint = onAgentEvent('agent:checkpoint', () => {
      void refreshCheckpoints();
    });

    const offChapterChanged = onAgentEvent('chapter:changed', (p) => {
      // 只在 source==='agent' 时刷新当前章正文（用户自己改的不重载，避免打断输入）
      if (p.source === 'agent') {
        void reloadCurrentChapter(p.chapterId);
      }
    });

    const offLlm = onAgentEvent('llm:status', (p) => {
      agent().setLlmStatus(p as LlmStatus);
    });

    const offRolledBack = onAgentEvent('checkpoint:rolled-back', () => {
      // 回滚后正文变了，必须重载当前章 + 重算体检
      void reloadCurrentChapter(null);
      void refreshAllAnalysis();
      void refreshCheckpoints();
    });

    const offProjectOpened = onAgentEvent('project:opened', () => {
      void refreshProject();
    });

    return () => {
      offStep();
      offPlan();
      offTerminated();
      offCheckpoint();
      offChapterChanged();
      offLlm();
      offRolledBack();
      offProjectOpened();
    };
  }, []);
}

async function refreshProject(): Promise<void> {
  try {
    const mz = bridge();
    const project = await mz.project.list();
    if (project.length > 0) {
      useProjectStore.getState().setProject(project[0]);
      await mz.project.open(project[0].rootDir);
    }
  } catch (e) {
    useProjectStore.getState().setError(errorText(e));
  }
}

async function refreshCheckpoints(): Promise<void> {
  try {
    const list = await bridge().checkpoint.list();
    useAgentStore.getState().setCheckpoints(list);
  } catch {
    // checkpoint 列表拿不到不影响主流程
  }
}

async function refreshChapterAnalysis(chapterId: string): Promise<void> {
  try {
    const list = await bridge().health.analyze([chapterId]);
    const store = useHealthStore.getState();
    const rest = store.analyses.filter((a) => a.chapterId !== chapterId);
    store.setAnalyses([...rest, ...list]);
  } catch {
    // 体检刷新失败不打断 Agent 执行
  }
}

async function refreshAllAnalysis(): Promise<void> {
  try {
    const list = await bridge().health.analyze();
    useHealthStore.getState().setAnalyses(list);
  } catch {
    // 同上
  }
}

async function reloadCurrentChapter(chapterId: string | null): Promise<void> {
  try {
    const mz = bridge();
    const id = chapterId ?? useProjectStore.getState().currentChapterId;
    if (!id) return;
    const ch = await mz.chapter.get(id);
    useEditorStore.getState().load(ch.body, ch.meta.rev);
  } catch {
    // 章不存在时静默（可能是被删或切换项目）
  }
}

/** 自动保存：编辑停止 1.5s 后落盘 */
export function useDebouncedAutosave(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useEditorStore.subscribe(
      (s) => s.dirty,
      (dirty) => {
        if (!dirty) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void saveNow();
        }, 1500);
      },
    );
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
}

export async function saveNow(): Promise<boolean> {
  const mz = bridge();
  const editor = useEditorStore.getState();
  const chapterId = useProjectStore.getState().currentChapterId;
  if (!chapterId || !editor.dirty) return true;
  editor.setSaving(true);
  try {
    const meta = await mz.chapter.update(chapterId, editor.body, editor.rev);
    editor.markClean(meta.rev);
    useProjectStore.getState().upsertChapterMeta(meta);
    return true;
  } catch (e) {
    useProjectStore.getState().setError(errorText(e));
    return false;
  } finally {
    editor.setSaving(false);
  }
}