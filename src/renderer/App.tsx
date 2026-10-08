/**
 * 应用外壳：竖排模式导航栏 + 精简顶栏 + 可折叠双栏工作区 + 单一统计底栏。
 * 布局 v2（2026-10-09）：低频的模式导航移到左侧 56px 图标栏；顶栏只管
 * 项目切换与面包屑；统计只出现在底栏一处；章节树与 AI 右栏均可折叠，
 * 写作专注态编辑器全宽。配色走「素笺·朱批」令牌（styles/tokens.css）。
 * 现有面板（专家团 / 主编对谈 / 审查 / 体检 / 历史）全部挂进「写作」模式右栏。
 */
import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from './store';
import { useAgentStream, useDebouncedAutosave } from './hooks/use-agent-stream';
import { bridge, errorText, hasBridge } from './hooks/use-mz-bridge';
import { ChapterTree } from './components/chapter-tree/ChapterTree';
import { Editor } from './components/editor/Editor';
import { AgentPanel } from './components/agent/AgentPanel';
import { HealthPanel } from './components/health/HealthPanel';
import { HistoryTimeline } from './components/history/HistoryTimeline';
import { ExpertPanel } from './components/expert/ExpertPanel';
import { FlavorPanel } from './components/flavor/FlavorPanel';
import { SettingsModal } from './components/settings/SettingsModal';
import { PlanView } from './components/views/PlanView';
import { LoreView } from './components/views/LoreView';
import { ReviewView } from './components/views/ReviewView';
import { DashboardView } from './components/views/DashboardView';
import type { LlmStatus } from '@shared/types/provider';
import type { DashStats } from '@shared/types/ipc';
import styles from './App.module.css';

type Mode = 'write' | 'plan' | 'lore' | 'review' | 'dash';
type RailTab = 'expert' | 'agent' | 'flavor' | 'health' | 'history';

/** 模式导航（icon path 与文枢定稿的 SVG sprite 同源） */
const MODES: { id: Mode; label: string; d: string }[] = [
  { id: 'write', label: '写作', d: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z' },
  { id: 'plan', label: '规划', d: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z' },
  { id: 'lore', label: '设定', d: 'M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13z' },
  { id: 'review', label: '审稿', d: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z' },
  { id: 'dash', label: '仪表盘', d: 'M4 14a8 8 0 0116 0' },
];

const RAIL_TABS: { id: RailTab; label: string }[] = [
  { id: 'expert', label: '专家团' },
  { id: 'agent', label: '主编对谈' },
  { id: 'flavor', label: '审查' },
  { id: 'health', label: '体检' },
  { id: 'history', label: '历史' },
];

function Mark(): JSX.Element {
  return (
    <svg className={styles.markSvg} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v18M5 7l7-4 7 4M7 12h10M8 17h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 折叠开关的面板图标 */
function PanelIco({ side }: { side: 'left' | 'right' }): JSX.Element {
  return (
    <svg className={styles.panelSvg} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={side === 'left' ? 'M9 4v16' : 'M15 4v16'} />
    </svg>
  );
}

export function App(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const chapters = useProjectStore((s) => s.chapters);
  const currentChapterId = useProjectStore((s) => s.currentChapterId);
  const error = useProjectStore((s) => s.error);
  const setError = useProjectStore((s) => s.setError);
  const [mode, setMode] = useState<Mode>('write');
  const [railTab, setRailTab] = useState<RailTab>('expert');
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const [showRail, setShowRail] = useState(true);
  const [dash, setDash] = useState<DashStats | null>(null);

  useAgentStream();
  useDebouncedAutosave();

  const loadDash = useCallback(async (): Promise<void> => {
    try {
      setDash(await bridge()?.aiFlavor.dashStats());
    } catch {
      /* 未打开项目时无统计，不报错 */
    }
  }, []);

  useEffect(() => {
    /**
     * 定义在 effect **内部**：它只被这里调用一次。
     *
     * 修复前它定义在组件体内、而 effect 依赖数组是空的 —— `exhaustive-deps`
     * 会报缺失依赖（本项目此前无 lint，故无人发现）。而「加进依赖数组」是错的解法：
     * 组件每次渲染都会重建这个函数，加进依赖会让 effect 每轮重跑、反复打开项目。
     * 正确解法是把只用一次的函数移进 effect。
     *
     * StrictMode 下 effect 仍会双跑，但 `services.openProject` 已加同项目幂等守卫，
     * 重复 open 不再重置主进程单例、也不再重推事件，故这里是安全的。
     */
    async function bootstrap(): Promise<void> {
      if (!hasBridge()) {
        setError('preload 未加载成功 —— 无法与主进程通信。请检查 preload 构建格式是否为 CJS。');
        return;
      }
      try {
        const list = await bridge().project.list();
        if (list.length > 0) {
          const p = await bridge().project.open(list[0].rootDir);
          useProjectStore.getState().setProject(p);
          const chapters = await bridge().chapter.list();
          useProjectStore.getState().setChapters(chapters);
          useProjectStore.getState().setVolumes(await bridge().project.volumes());
        }
        setLlmStatus(await bridge().llm.status());
        await loadDash();
        useProjectStore.getState().setLoading(false);
      } catch (e) {
        setError(errorText(e));
      }
    }

    void bootstrap();
    // loadDash 是 useCallback([])、setError 是 zustand action，两者引用恒定
  }, [loadDash, setError]);

  async function openProject(): Promise<void> {
    try {
      const dir = window.prompt('输入项目目录的绝对路径：');
      if (!dir) return;
      const p = await bridge().project.open(dir);
      useProjectStore.getState().setProject(p);
      useProjectStore.getState().setChapters(await bridge().chapter.list());
      useProjectStore.getState().setVolumes(await bridge().project.volumes());
      await loadDash();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const modelLabel = llmStatus?.configured
    ? (llmStatus.settings?.model || llmStatus.uiState.kind)
    : '模型未配置';
  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? '';
  const current = chapters.find((c) => c.id === currentChapterId);

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="模式导航">
        <div className={styles.mark} title="文枢"><Mark /></div>
        <div className={styles.railModes}>
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`${styles.railBtn} ${mode === m.id ? styles.railOn : ''}`}
              onClick={() => setMode(m.id)}
              aria-current={mode === m.id ? 'page' : undefined}
              title={m.label}
            >
              <svg className={styles.railIco} viewBox="0 0 24 24"><path d={m.d} /></svg>
              <span>{m.label}</span>
            </button>
          ))}
        </div>
        <button className={styles.railFoot} onClick={() => setShowSettings(true)} title="设置">
          <span className={styles.avatar}>墨</span>
        </button>
      </nav>

      <div className={styles.main}>
        <header className={styles.top}>
          <button className={styles.book} onClick={() => void openProject()} title="打开 / 切换项目">
            <span className={styles.cov}>{project ? project.name.slice(0, 1) : '墨'}</span>
            <span className={styles.bt}>
              <b>{project ? `《${project.name}》` : '未打开项目'}</b>
              <span>{project ? `${chapters.length} 章` : '点击选择项目目录'}</span>
            </span>
          </button>
          <span className={styles.topSep} />
          <div className={styles.crumb}>
            <b>{modeLabel}</b>
            {mode === 'write' && <span>{current ? `第 ${current.id} 章 · ${current.title}` : '未选择章节'}</span>}
          </div>
          {mode === 'write' && (
            <div className={styles.topRight}>
              <button
                className={`${styles.panelBtn} ${showTree ? styles.panelBtnOn : ''}`}
                onClick={() => setShowTree((v) => !v)}
                aria-pressed={showTree}
                title="章节树"
              ><PanelIco side="left" /></button>
              <button
                className={`${styles.panelBtn} ${showRail ? styles.panelBtnOn : ''}`}
                onClick={() => setShowRail((v) => !v)}
                aria-pressed={showRail}
                title="AI 面板"
              ><PanelIco side="right" /></button>
            </div>
          )}
        </header>

        {error && (
          <div className={styles.errorBar} onClick={() => setError(null)}>
            {error}
            <span className={styles.dismiss}>（点击关闭）</span>
          </div>
        )}

        <div className={styles.body}>
          {mode === 'write' ? (
            <>
              {showTree && <aside className={styles.left}><ChapterTree /></aside>}
              <main className={styles.center}><Editor /></main>
              {showRail && (
                <aside className={styles.right}>
                  <div className={styles.tabs}>
                    {RAIL_TABS.map((t) => (
                      <button key={t.id} className={`${styles.tab} ${railTab === t.id ? styles.tabActive : ''}`}
                        onClick={() => setRailTab(t.id)}>{t.label}</button>
                    ))}
                  </div>
                  <div className={styles.tabBody}>
                    {railTab === 'expert' && <ExpertPanel />}
                    {railTab === 'agent' && <AgentPanel />}
                    {railTab === 'flavor' && <FlavorPanel />}
                    {railTab === 'health' && <HealthPanel />}
                    {railTab === 'history' && <HistoryTimeline />}
                  </div>
                </aside>
              )}
            </>
          ) : (
            <main className={styles.modeHost}>
              {mode === 'plan' && <PlanView />}
              {mode === 'lore' && <LoreView />}
              {mode === 'review' && <ReviewView />}
              {mode === 'dash' && <DashboardView />}
            </main>
          )}
        </div>

        <footer className={styles.statusBar}>
          <span>全书 <b className={styles.mzNum}>{dash ? (dash.totalChars >= 10000 ? `${(dash.totalChars / 10000).toFixed(1)} 万` : dash.totalChars.toLocaleString()) : '—'}</b> 字</span>
          <span className={styles.stSep} />
          <span>章节 <b className={styles.mzNum}>{dash?.chapterCount ?? '—'}</b></span>
          <span className={styles.stSep} />
          <span>已发布/待审/草稿 <b className={styles.mzNum}>{dash ? `${dash.byStatus.done}/${dash.byStatus.revised}/${dash.byStatus.draft}` : '—'}</b></span>
          <span className={styles.stSp} />
          <span className={styles.modelFoot} onClick={() => setShowSettings(true)}>
            <span className={`${styles.chipDot} ${llmStatus?.configured ? styles.chipDotOk : styles.chipDotWarn}`} />
            {llmStatus?.configured ? `模型 ${modelLabel}` : '模型未配置（点击设置）'}
          </span>
        </footer>
      </div>

      {showSettings && (
        <SettingsModal
          status={llmStatus}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => setLlmStatus(s)}
        />
      )}
    </div>
  );
}
