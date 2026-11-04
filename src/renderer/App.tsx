/**
 * 应用外壳：竖排模式导航栏 + 精简顶栏 + 可折叠双栏工作区 + 单一统计底栏。
 *
 * 布局 v3（§UI ·R1，2026-10-10）：按竞品调研（Ulysses / Scrivener / Zettlr /
 * Zed / VS Code / iA Writer / NN-g）重做外壳。三处结构性改动：
 *
 *  1. **左侧导航展开态带文字标签**。此前是 56px 纯图标，每个按钮只有 SVG 和
 *     11.5px 的两字标签，而 NN/g 的定量研究实测「桌面端隐藏式导航使用率仅 27%，
 *     可见导航 48%」，且桌面大屏上省下的横向空间「不足以证明隐藏它的成本」。
 *     现在 rail 有展开（168px，图标 + 四字标签）与收起（56px，纯图标 + hover
 *     tooltip 带快捷键）两态，并记住用户选择。
 *  2. **三栏可一键坍缩**。Ulysses 的 Hide Toolbar 是本次调研里最值得抄的一条：
 *     三栏是对的，错的是「三栏且永远占满」。`⌘3` 把章节树与 AI 侧栏同时收成
 *     零宽，写作时只剩正文；`⌘4` 再叠一层全屏。
 *  3. **底栏默认隐藏**。此前 28px 统计条常驻，而 Ulysses/Zettlr 都把它做成
 *     可折叠区块。改成 `⌘/` 唤起的底栏，默认不占一行高度。
 *
 * 快捷键对齐 Ulysses 的 ⌘1–⌘4 心智模型：⌘1 章节树 / ⌘2 AI 侧栏 /
 * ⌘3 全收纳 / ⌘4 专注模式 / ⌘/ 统计底栏 / ⌘K 命令面板。
 *
 * 配色走「素笺·朱批」令牌（styles/tokens.css）。
 * 现有面板（专家团 / 主编对谈 / 审查 / 体检 / 历史）全部挂进「写作」模式右栏。
 */
import { useEffect, useState } from 'react';
import { useProjectStore, useDashStore, useSettingsStore } from './store';
import { useAgentStream, useDebouncedAutosave } from './hooks/use-agent-stream';
import { bridge, errorText, hasBridge } from './hooks/use-mz-bridge';
import { refreshDash } from './hooks/use-dash';
import { ChapterTree } from './components/chapter-tree/ChapterTree';
import { Editor } from './components/editor/Editor';
import { AgentPanel } from './components/agent/AgentPanel';
import { HealthPanel } from './components/health/HealthPanel';
import { HistoryTimeline } from './components/history/HistoryTimeline';
import { ExpertPanel } from './components/expert/ExpertPanel';
import { FlavorPanel } from './components/flavor/FlavorPanel';
import { SettingsModal } from './components/settings/SettingsModal';
import { CommandPalette } from './components/common/CommandPalette';
import { PipelineBar } from './components/common/PipelineBar';
import { PlanView } from './components/views/PlanView';
import { LoreView } from './components/views/LoreView';
import { ReviewView } from './components/views/ReviewView';
import { DashboardView } from './components/views/DashboardView';
import { GenView } from './components/views/GenView';
import type { LlmStatus } from '@shared/types/provider';
import { APP_BRAND_NAME } from '@shared/constants/brand';
import styles from './App.module.css';

type Mode = 'write' | 'plan' | 'lore' | 'review' | 'dash' | 'gen';
type RailTab = 'expert' | 'agent' | 'flavor' | 'health' | 'history';

/**
 * ★ P2-UI T2（DRD §4.1）：左导航从「六个并列按钮」重排为**四组 IA**。
 *
 *   创作=[写作坊 / 大纲管理 / 生成·导演台]   —— 产出正文的三个入口
 *   资产=[世界观设定 / 人物记忆·设计中 / 伏笔台账·设计中 / 长期记忆·设计中]
 *   灵感=[扫榜热榜 / 抽脑洞 / 拆书报告 / 选题库]（全部设计中）
 *   输出=[统计账本 / 导出中心·设计中]
 *
 * 两类条目（判别联合，kind 是唯一分派点）：
 *   - `mode`：可达的真页面，`id` 就是 Mode（B 组纪律：渲染里保留
 *     `${styles.railBtn} ${mode === m.id ? styles.railOn : ''}` 与
 *     `title={railCollapsed ? m.label : undefined}` 的逐字形态，回调参数名必须是 m）；
 *   - `soon`：**disabled 占位按钮 + .soonTag「设计中」**。它是路标不是入口——
 *     没有可执行动作，所以不进命令面板（shell-r1 A 组钉死），也不进 onRun 分派。
 *
 * 「审稿」不在四组导航里（R32 Phase-1 纪律），但 `mode:review` 保留在命令面板——
 * 那是它的可达路径，A 组 palette↔onRun 双向清单不含 soon 项、含 review。
 */
type NavItem =
  | { kind: 'mode'; id: Mode; label: string; d: string }
  | { kind: 'soon'; id: string; label: string; d: string };

/** 模式显示名（面包屑用）。与 NAV_GROUPS 的 label 同步，另含导航外的 review。 */
const MODE_LABELS: Record<Mode, string> = {
  write: '写作坊',
  plan: '大纲管理',
  lore: '世界观设定',
  review: '审稿',
  dash: '统计账本',
  gen: '生成·导演台',
};

/** 导航条目（icon path 与品牌定稿的 SVG sprite 同源） */
const NAV_GROUPS: { id: string; label: string; items: NavItem[] }[] = [
  {
    id: 'create',
    label: '创作',
    items: [
      { kind: 'mode', id: 'write', label: MODE_LABELS.write, d: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z' },
      { kind: 'mode', id: 'plan', label: MODE_LABELS.plan, d: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z' },
      // ★ T6：生成模式（P0 生成流水线的 UI 入口）。图标 = 简易闪电。
      { kind: 'mode', id: 'gen', label: MODE_LABELS.gen, d: 'M13 2L5 13.5h5.5L9.5 22 19 10.5h-5.5L13 2z' },
    ],
  },
  {
    id: 'asset',
    label: '资产',
    items: [
      { kind: 'mode', id: 'lore', label: MODE_LABELS.lore, d: 'M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13z' },
      { kind: 'soon', id: 'soon-memory', label: '人物记忆', d: 'M12 12a4 4 0 100-8 4 4 0 000 8M5 20a7 7 0 0114 0' },
      { kind: 'soon', id: 'soon-foreshadow', label: '伏笔台账', d: 'M6 4h12v16l-6-4-6 4V4z' },
      { kind: 'soon', id: 'soon-longterm', label: '长期记忆', d: 'M12 4l2.3 4.7 5.2.7-3.8 3.7.9 5.2-4.6-2.5-4.6 2.5.9-5.2L5.5 9.4l5.2-.7L12 4z' },
    ],
  },
  {
    id: 'inspire',
    label: '灵感',
    items: [
      { kind: 'soon', id: 'soon-trends', label: '扫榜热榜', d: 'M5 20V10M12 20V4M19 20v-7' },
      { kind: 'soon', id: 'soon-brainstorm', label: '抽脑洞', d: 'M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.8.8 1.5 1.9 1.5 3H14.5c0-1.1.7-2.2 1.5-3A6 6 0 0012 3z' },
      { kind: 'soon', id: 'soon-teardown', label: '拆书报告', d: 'M12 4v16M5 6a2 2 0 012-2h3v18H7a2 2 0 00-2 2V6m14 0a2 2 0 00-2-2h-3v18h3a2 2 0 012 2V6' },
      { kind: 'soon', id: 'soon-topics', label: '选题库', d: 'M4 6h16M4 12h16M4 18h10' },
    ],
  },
  {
    id: 'output',
    label: '输出',
    items: [
      { kind: 'mode', id: 'dash', label: MODE_LABELS.dash, d: 'M4 14a8 8 0 0116 0' },
      { kind: 'soon', id: 'soon-export', label: '导出中心', d: 'M12 3v10m0 0l-3-3m3 3l3-3M5 19h14' },
    ],
  },
];

const RAIL_TABS: { id: RailTab; label: string }[] = [
  { id: 'expert', label: '专家团' },
  { id: 'agent', label: '主编对谈' },
  { id: 'flavor', label: '审查' },
  { id: 'health', label: '体检' },
  { id: 'history', label: '历史' },
];

/** 导航栏收起态的记忆键（与主题同款：只存字符串，读写都在 lib 层） */
const RAIL_COLLAPSED_KEY = 'mozhou.railCollapsed';

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false; // 隐私模式 / 存储被禁：回落展开态，不炸
  }
}

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

/** 侧栏展开/收起的双箭头（收起态指向右=可展开，展开态指向左=可收起） */
function ChevronIco({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg className={styles.chevronSvg} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 命令面板图标（⌘K 的视觉入口） */
function SearchIco(): JSX.Element {
  return (
    <svg className={styles.searchSvg} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
  /** ★ §UI ·R1：底栏默认隐藏（⌘/ 唤起）。此前 28px 统计条常驻。 */
  const [showStatus, setShowStatus] = useState(false);
  /** ★ §UI ·R1：命令面板（⌘K）。Zed 把命令面板当「第一入口」。 */
  const [showPalette, setShowPalette] = useState(false);
  /** ★ §UI ·R1：左侧导航展开/收起两态，记忆在 localStorage。 */
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed);
  /** ★ §UI ·R1：专注模式（⌘4）——收掉除正文外的一切。 */
  const [focusMode, setFocusMode] = useState(false);
  const theme = useSettingsStore((s) => s.theme);
  /** ★ 第 30 条：统计不再是本组件的私有 state——它同时是底栏、仪表盘、规划页的事实 */
  const dash = useDashStore((s) => s.dash);

  useAgentStream();
  useDebouncedAutosave();

  /**
   * ★ 第 30 条：底栏那行数字以前只在启动与 openProject 时取一次，
   *   于是建完一章、改完正文，侧栏已经变了而底栏还停在旧数（真机截图抓到）。
   *   重算挂在 `chapters` 上——建章 / 删章 / 改名 / 改状态 / 保存正文（rev 变）
   *   这五条路径最后都会落到 `setChapters` / `upsertChapterMeta`，
   *   收敛成**一个**触发点，比在五个地方各补一句"记得刷新"可靠得多。
   *   Agent 改稿走的是推送，不经过这里，由 `use-agent-stream` 负责触发。
   */
  useEffect(() => {
    void refreshDash();
  }, [chapters]);

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
        await refreshDash();
        useProjectStore.getState().setLoading(false);
      } catch (e) {
        setError(errorText(e));
      }
    }

    void bootstrap();
    /**
     * 依赖数组里没有 `refreshDash`：它是模块级函数（不是组件内重建的），引用恒定，
     * 放进依赖里是"外层值不是有效依赖"——`exhaustive-deps` 会直接报 unnecessary dependency。
     */
  }, [setError]);

  /**
   * ★ §UI ·R1：外壳快捷键。对齐 Ulysses 的 ⌘1–⌘4 心智模型。
   *   ⌘1 章节树 / ⌘2 AI 侧栏 / ⌘3 全收纳 / ⌘4 专注 / ⌘/ 统计底栏 / ⌘K 命令面板 / Esc 退出专注
   *
   * 为什么放在 window 上而不是某个容器：焦点可能在任何子元素（编辑器 textarea、
   * 树里的按钮、面板里的输入框），挂在容器上就要靠冒泡，而 textarea 里按 ⌘1
   * 不该被吞。`window` + `capture` 是唯一能保证「无论焦点在哪都生效」的位置。
   * `preventDefault` 是必须的：⌘1/⌘2 在 Chromium 里是「切换标签页」的保留键。
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      // Esc：优先关命令面板，其次退出专注模式（命令面板里也监听 Esc，靠它自己 stopPropagation）
      if (e.key === 'Escape') {
        if (focusMode) {
          setFocusMode(false);
          e.preventDefault();
        }
        return;
      }
      if (!mod) return;
      // ★ 第 33 条的前提：编辑器要能接到 ⌘S 保存，所以这里只拦自己要的键。
      switch (e.key) {
        case '1':
          setMode('write');
          setShowTree((v) => !v);
          e.preventDefault();
          break;
        case '2':
          setMode('write');
          setShowRail((v) => !v);
          e.preventDefault();
          break;
        case '3': {
          // 全收纳：两侧栏同时收成零宽。再按一次还原两者。
          setMode('write');
          const anyOpen = showTree || showRail;
          setShowTree(!anyOpen);
          setShowRail(!anyOpen);
          e.preventDefault();
          break;
        }
        case '4':
          setMode('write');
          setFocusMode((v) => !v);
          e.preventDefault();
          break;
        case '/':
          setShowStatus((v) => !v);
          e.preventDefault();
          break;
        case 'k':
        case 'K':
          setShowPalette((v) => !v);
          e.preventDefault();
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [focusMode, showTree, showRail]);

  /** 专注模式是「收掉一切」的叠加态：进入时记住原本的开关，退出时还原。 */
  function toggleFocus(): void {
    setFocusMode((v) => !v);
  }

  function toggleRail(): void {
    setRailCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // 存储不可用：这次会话内仍然生效，只是记不住。不打扰用户。
      }
      return next;
    });
  }

  async function openProject(): Promise<void> {
    try {
      // ★ 第 29 条：这里曾经是 `window.prompt('输入项目目录的绝对路径：')`——
      //   让一个写网文的人自己拼 `C:\Users\...\我的书`。改成原生目录选择器。
      const dir = await bridge().project.pickDir();
      if (!dir) return; // 取消是正常结果，静默返回，不记错误
      const p = await bridge().project.open(dir);
      useProjectStore.getState().setProject(p);
      useProjectStore.getState().setChapters(await bridge().chapter.list());
      useProjectStore.getState().setVolumes(await bridge().project.volumes());
      await refreshDash();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const modelLabel = llmStatus?.configured
    ? (llmStatus.settings?.model || llmStatus.uiState.kind)
    : '模型未配置';
  const modeLabel = MODE_LABELS[mode];
  const current = chapters.find((c) => c.id === currentChapterId);

  /**
   * ★ §UI ·R1：专注模式下壳层加 `data-focus`，由 CSS 把 rail / 顶栏 / 侧栏
   *   全部收掉。用属性而不是条件渲染，是因为条件渲染会把子组件卸载 →
   *   Editor 的滚动位置和 textarea 的 selection 全丢，退出专注后用户要重新找
   *   自己写到哪（这是真实痛点，不是洁癖）。
   */
  const shellCls = [
    styles.shell,
    railCollapsed ? styles.railCollapsed : '',
    focusMode ? styles.focus : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellCls} data-focus={focusMode ? 'on' : undefined}>
      <nav className={styles.rail} aria-label="模式导航">
        <div className={styles.mark} title={APP_BRAND_NAME}><Mark /></div>
        <div className={styles.railModes}>
          {NAV_GROUPS.map((g) => (
            <div key={g.id} className={styles.railGroup}>
              <div className={styles.railGroupLabel}>{g.label}</div>
              {g.items.map((m) =>
                m.kind === 'soon' ? (
                  <button
                    key={m.id}
                    className={`${styles.railBtn} ${styles.railSoon}`}
                    disabled
                    title={`${m.label}（设计中）`}
                  >
                    <svg className={styles.railIco} viewBox="0 0 24 24"><path d={m.d} /></svg>
                    <span className={styles.railLabel}>{m.label}</span>
                    <span className={styles.soonTag}>设计中</span>
                  </button>
                ) : (
                  <button
                    key={m.id}
                    className={`${styles.railBtn} ${mode === m.id ? styles.railOn : ''}`}
                    onClick={() => setMode(m.id)}
                    aria-current={mode === m.id ? 'page' : undefined}
                    title={railCollapsed ? m.label : undefined}
                  >
                    <svg className={styles.railIco} viewBox="0 0 24 24"><path d={m.d} /></svg>
                    <span className={styles.railLabel}>{m.label}</span>
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
        <div className={styles.railFoot}>
          <button
            className={styles.railToggle}
            onClick={toggleRail}
            title={railCollapsed ? '展开导航栏' : '收起导航栏'}
            aria-label={railCollapsed ? '展开导航栏' : '收起导航栏'}
          >
            <ChevronIco collapsed={railCollapsed} />
          </button>
          <button className={styles.railFootBtn} onClick={() => setShowSettings(true)} title="设置">
            <span className={styles.avatar}>墨</span>
            <span className={styles.railLabel}>设置</span>
          </button>
        </div>
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

          <div className={styles.topRight}>
            {/* ★ §UI ·R1：命令面板入口。报告的证据：Zed 官方原文「命令面板是
                访问动作的主要方式」，且它默认启用「命令使用历史排序」。 */}
            <button
              className={styles.paletteBtn}
              onClick={() => setShowPalette(true)}
              title="命令面板（⌘K）"
            >
              <SearchIco />
              <span>命令</span>
              <kbd className={styles.kbd}>⌘K</kbd>
            </button>

            {mode === 'write' && (
              <>
                <button
                  className={`${styles.panelBtn} ${focusMode ? styles.panelBtnOn : ''}`}
                  onClick={toggleFocus}
                  aria-pressed={focusMode}
                  title="专注模式（⌘4）"
                >
                  <svg className={styles.panelSvg} viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4"
                      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  className={`${styles.panelBtn} ${showTree ? styles.panelBtnOn : ''}`}
                  onClick={() => setShowTree((v) => !v)}
                  aria-pressed={showTree}
                  title="章节树（⌘1）"
                ><PanelIco side="left" /></button>
                <button
                  className={`${styles.panelBtn} ${showRail ? styles.panelBtnOn : ''}`}
                  onClick={() => setShowRail((v) => !v)}
                  aria-pressed={showRail}
                  title="AI 面板（⌘2）"
                ><PanelIco side="right" /></button>
              </>
            )}
          </div>
        </header>

        {error && (
          <div className={styles.errorBar} onClick={() => setError(null)}>
            {error}
            <span className={styles.dismiss}>（点击关闭）</span>
          </div>
        )}

        {/* ★ P2-UI T2（DRD §4.1）：八节点管线条，挂在 write/gen 模式工作区（.body）
            顶部；专注模式连它一起收掉，其余模式（plan/lore/review/dash）不挂。 */}
        {(mode === 'write' || mode === 'gen') && !focusMode && <PipelineBar />}

        <div className={styles.body}>
          {mode === 'write' ? (
            <>
              {showTree && !focusMode && <aside className={styles.left}><ChapterTree /></aside>}
              <main className={styles.center}><Editor /></main>
              {showRail && !focusMode && (
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
              {mode === 'gen' && <GenView />}
            </main>
          )}
        </div>

        {/* ★ §UI ·R1：底栏默认隐藏，⌘/ 唤起。Ulysses/Zettlr 都把统计做成可折叠。 */}
        {showStatus && (
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
        )}
      </div>

      {showSettings && (
        <SettingsModal
          status={llmStatus}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => setLlmStatus(s)}
        />
      )}

      {/* ★ §UI ·R1：命令面板。theme/模式/面板/设置的统一入口。 */}
      {showPalette && (
        <CommandPalette
          theme={theme}
          mode={mode}
          railCollapsed={railCollapsed}
          onClose={() => setShowPalette(false)}
          onRun={(id) => {
            switch (id) {
              case 'mode:write': case 'mode:plan': case 'mode:lore':
              case 'mode:review': case 'mode:dash': case 'mode:gen':
                setMode(id.slice(5) as Mode);
                break;
              case 'panel:tree':
                setMode('write');
                setShowTree((v) => !v);
                break;
              case 'panel:rail':
                setMode('write');
                setShowRail((v) => !v);
                break;
              case 'panel:status':
                setShowStatus((v) => !v);
                break;
              case 'view:focus':
                setMode('write');
                setFocusMode((v) => !v);
                break;
              case 'view:rail-width':
                toggleRail();
                break;
              case 'app:settings':
                setShowSettings(true);
                break;
              case 'app:open':
                void openProject();
                break;
              default:
                break;
            }
          }}
        />
      )}
    </div>
  );
}
