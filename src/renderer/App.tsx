/**
 * 应用外壳：文枢五模式（写作 | 规划 | 设定 | 审稿 | 仪表盘）。
 * 设计定稿：novel-workbench-ui/index.html（老板 2026-10-08 批准的水墨金风格）。
 * 现有面板（专家团 / 主编对谈 / 审查 / 体检 / 历史）全部挂进「写作」模式右栏；
 * 规划 / 设定 / 审稿 / 仪表盘为独立模式视图，各自接真实后端。
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
      <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".55" />
    </svg>
  );
}

export function App(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const chapters = useProjectStore((s) => s.chapters);
  const error = useProjectStore((s) => s.error);
  const setError = useProjectStore((s) => s.setError);
  const [mode, setMode] = useState<Mode>('write');
  const [railTab, setRailTab] = useState<RailTab>('expert');
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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
    void bootstrap();
  }, []);

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

  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <div className={styles.brand}>
          <div className={styles.mark}><Mark /></div>
          <div><b>文枢</b><small>NINESAGES</small></div>
        </div>
        <button className={styles.book} onClick={() => void openProject()} title="打开 / 切换项目">
          <span className={styles.cov}>{project ? project.name.slice(0, 1) : '墨'}</span>
          <span className={styles.bt}>
            <b>{project ? `《${project.name}》` : '未打开项目'}</b>
            <span>{project ? `${chapters.length} 章` : '点击选择项目目录'}</span>
          </span>
        </button>
        <nav className={styles.modes}>
          {MODES.map((m) => (
            <button key={m.id} className={mode === m.id ? styles.modeOn : ''} onClick={() => setMode(m.id)}>
              <svg className={styles.modeIco} viewBox="0 0 24 24"><path d={m.d} /></svg>
              {m.label}
            </button>
          ))}
        </nav>
        <div className={styles.topRight}>
          {dash && (
            <div className={styles.daily}>
              <span className={styles.dailyLbl}>全书</span>
              <b className={styles.mzNum}>{dash.totalChars >= 10000 ? `${(dash.totalChars / 10000).toFixed(1)} 万` : dash.totalChars.toLocaleString()}</b>
              <span className={styles.dailyLbl}>字 · {dash.chapterCount} 章</span>
            </div>
          )}
          <button className={styles.modelChip} onClick={() => setShowSettings(true)}
            title={llmStatus?.configured ? '模型设置' : '模型未配置 —— 点击配置'}>
            <span className={`${styles.chipDot} ${llmStatus?.configured ? styles.chipDotOk : styles.chipDotWarn}`} />
            {modelLabel}
          </button>
          <div className={styles.avatar}>墨</div>
        </div>
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
            <aside className={styles.left}><ChapterTree /></aside>
            <main className={styles.center}><Editor /></main>
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
