/**
 * 命令面板（⌘K）—— §UI ·R1 新增，竞品调研直接产物。
 *
 * 修复前状态：本应用**没有**任何统一的功能入口。切模式要点左侧 rail 上的图标
 * （56px 宽、只有 SVG 和 11.5px 两字标签，语义靠猜），开关面板要点顶栏右上角
 * 两个图标，设置要点 rail 底部的「墨」头像 —— 三处入口彼此没有关系，
 * 新用户必须逐个试出来。
 *
 * 调研证据（Zed 官方文档原文）：
 *   "The Command Palette is **the main way to access actions in Zed**."
 *   Zed 把所有操作命名成 `zed: ...` / `editor: ...` 的形式，文档里到处让你
 *   去命令面板执行；主题切换、图标主题、开 AI 线程全都从面板走。
 *
 * 两条从 Zed 抄来的关键设计：
 *  1. **默认按使用历史排序**（Zed 的 `command_palette.use_command_history`
 *     默认 true）。新用户按名字找，老用户靠肌肉记忆 —— 这是面板好不好用的分水岭。
 *     本实现在 localStorage 里记每个命令被执行的次数，次数相同的按原始顺序。
 *  2. **面板里显示快捷键**，于是面板本身成了快捷键的发现机制：用户搜「专注」
 *     看到右边写着 ⌘4，下一次就不用再搜了 —— 面板教人用快捷键，快捷键让人
 *     不再需要面板（这是 Ulysses/Zed 都承认的目标）。
 *
 * 有意不做的：不做「跳到第 N 章」列表。调研第 2 节的结论是
 * **命令面板 = 动作（动词），文件查找器 = 跳转（名词）**，两者不该混。
 * 章节跳转属于章节树的事（树本来就在左边常驻），塞进面板会让面板变成
 * 一个什么都装的大列表，那正是反面教材。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../lib/theme';
import { MODE_LABELS, modeLabel } from '@shared/constants/modes';
import styles from './CommandPalette.module.css';

export interface CommandPaletteProps {
  theme: Theme;
  mode: string;
  railCollapsed: boolean;
  onClose: () => void;
  /** 命令 id（`mode:write` / `view:focus` / `app:settings` …），由外壳解释执行。 */
  onRun: (id: string) => void;
}

interface Command {
  id: string;
  /** 显示名（中文，用户看到的就是这个） */
  label: string;
  /** 分组：动作 / 视图 / 应用 */
  group: string;
  /** 快捷键展示（仅提示，真正的绑定在 App 的 keydown 里） */
  keys?: string;
  /** 搜索用的额外关键词（拼音、英文别名） */
  alias?: string;
}

/**
 * 命令清单。这是**唯一**一份，外壳的 `onRun` 按 id 分派。
 * 刻意保持短：调研第 8 节的结论是「重做不是把选项删光」，但也不等于把
 * 每个按钮都搬进来 —— 面板里只放“用户在写作过程中会想切换的东西”。
 *
 * ★ P2-UI T2（四组 IA）同步口径（P2-A T4 起为五组、14 条；★ P2-B T4 起 15 条、
 *   P2-B T6 起 16 条、P2-C T3 起 17 条）：
 *   - `mode:*` 全保留（R36 后审稿进了创作组导航、P2-A T4 后提示词与技能
 *     进了系统组、P2-B T4 后伏笔台账转正、P2-B T6 后人物记忆转正、P2-C T3 后
 *     扫榜热榜转正——面板条目与 id 集双向同步于 shell-r1 A 组钉死清单，现 17 条；
 *     面板仍是它们的⌘K 快路）；
 *   - 左导航的 soon 占位项（长期记忆/导出中心/…）**不进面板**：
 *     它们是 disabled 的「设计中」路标，没有可执行动作，进面板就是骗用户点；
 *   - label 跟随新显示名（写作坊/大纲管理/…），alias 保留旧名关键词——
 *     老用户搜「仪表盘」仍要能命中「统计账本」。清单与 onRun 的双向逐字
 *     一致性由 tests/integration/shell-r1-wiring.test.ts A 组钉死。
 *   - ★ §UI ·终审 Important-3：`切换到 X` 的 X 不再手写，取自
 *     `@shared/constants/modes` 的 MODE_LABELS（与外壳的 NAV_GROUPS / 面包屑同源）。
 *     id 仍是逐字字面量——A 组按 `\{\s*id:\s*'…'` 抓清单，模板化的 id 会让它空转。
 */
const COMMANDS: Command[] = [
  { id: 'mode:write', label: `切换到 ${MODE_LABELS.write}`, group: '模式', alias: 'write xiezuo fang', keys: '' },
  { id: 'mode:plan', label: `切换到 ${MODE_LABELS.plan}`, group: '模式', alias: 'plan guihua dagang' },
  { id: 'mode:lore', label: `切换到 ${MODE_LABELS.lore}`, group: '模式', alias: 'lore sheding shijieguan' },
  { id: 'mode:review', label: `切换到 ${MODE_LABELS.review}`, group: '模式', alias: 'review shengao' },
  { id: 'mode:dash', label: `切换到 ${MODE_LABELS.dash}`, group: '模式', alias: 'dashboard yibiaopan tongji' },
  { id: 'mode:gen', label: `切换到 ${MODE_LABELS.gen}`, group: '模式', alias: 'gen shengcheng daoyantai' },
  // ★ P2-A T4：系统组实项进面板（id 集 13→14 与 shell-r1 A 组双向同步）。
  //   不占数字快捷键——⌘1–⌘4 纪律不变，keys 留空。
  { id: 'mode:prompt', label: `切换到 ${MODE_LABELS.prompt}`, group: '模式', alias: 'prompt skills 提示词 技能 覆盖层 tishici' },
  // ★ P2-B T4：伏笔台账转正为真 mode，进面板（id 集 14→15 与 shell-r1 A 组双向同步）。
  //   不占数字快捷键，keys 留空（⌘1–⌘4 纪律同 mode:prompt）。
  { id: 'mode:foreshadow', label: `切换到 ${MODE_LABELS.foreshadow}`, group: '模式', alias: 'foreshadow ledger 伏笔 台账 fubi taizhang' },
  // ★ P2-B T6：人物记忆转正为真 mode，进面板（id 集 15→16 与 shell-r1 A 组双向同步）。
  //   同样不占数字快捷键（⌘1–⌘4 纪律不变）。
  { id: 'mode:characters', label: `切换到 ${MODE_LABELS.characters}`, group: '模式', alias: 'characters memory 人物 记忆 renwu jiyi' },
  // ★ P2-C T3：扫榜热榜转正为真 mode，进面板（id 集 16→17 与 shell-r1 A 组双向同步）。
  //   同样不占数字快捷键（⌘1–⌘4 纪律不变）。
  { id: 'mode:trends', label: `切换到 ${MODE_LABELS.trends}`, group: '模式', alias: 'trending charts 扫榜 热榜 sao bang re bang' },
  // ★ P2-C T4：抽脑洞转正为真 mode，进面板（id 集 17→18 与 shell-r1 A 组双向同步）。
  //   同样不占数字快捷键（⌘1–⌘4 纪律不变）。
  { id: 'mode:idea', label: `切换到 ${MODE_LABELS.idea}`, group: '模式', alias: 'idea brainstorm 抽脑洞 chou nao dong' },

  { id: 'panel:tree', label: '显示 / 隐藏 章节树', group: '面板', keys: '⌘1', alias: 'tree chapter zhangjieshu' },
  { id: 'panel:rail', label: '显示 / 隐藏 AI 面板', group: '面板', keys: '⌘2', alias: 'rail ai panel' },
  { id: 'panel:status', label: '显示 / 隐藏 统计底栏', group: '面板', keys: '⌘/', alias: 'status word count zitiao' },

  { id: 'view:focus', label: '专注模式（收掉两侧）', group: '视图', keys: '⌘4', alias: 'focus zhuanzhu zenn' },
  { id: 'view:rail-width', label: '展开 / 收起 导航栏', group: '视图', alias: 'rail nav daohang' },

  { id: 'app:open', label: '打开 / 切换 项目', group: '应用', alias: 'open project xiangmu' },
  { id: 'app:settings', label: '打开 设置', group: '应用', alias: 'settings shezhi model api' },
];

/** 使用历史的存储键与结构：{ [id]: 次数 } */
const USAGE_KEY = 'mozhou.commandUsage';

function readUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // 只收数字，防手改过的存储把排序搞崩
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function bumpUsage(id: string): void {
  try {
    const usage = readUsage();
    usage[id] = (usage[id] ?? 0) + 1;
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // 存储不可用：本次会话内仍然执行命令，只是不记历史。不打扰用户。
  }
}

/** 主题中文名（面板里显示当前生效的主题）。
 *
 * 键集合必须与 `lib/theme.ts` 的 `Theme` 逐字相同——这里不 import 那个类型，
 * 而是让 TS 的结构检查在编译期盯着：多一个键就报错，少一个键也报错。
 * （当前只有 ink/paper 两套；R5 若加高对比皮肤，这里跟着加一格。）
 * ★ R35③：显示名与 SettingsModal 的 THEMES 同步——v3 起 ink 叫「墨韵」
 *   （旧名「深寂」退役），paper 叫「素笺」。两处皮肤名不许各说一套。 */
const THEME_LABEL: Record<Theme, string> = {
  ink: '墨韵',
  paper: '素笺',
};

/** 模式显示名见 `@shared/constants/modes`（§UI ·终审 Important-3）。
 *  这里以前是第三份手写副本（与 App.tsx 的 MODE_LABELS、本文件 COMMANDS 的 label
 *  各抄一遍，靠注释约定同步）。现在三个出口同源：底栏走 `modeLabel()`——面板的
 *  mode prop 是 string，认不出的 id 原样回显，不显示 undefined；命令名走 MODE_LABELS。 */
export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const { theme, mode, railCollapsed, onClose, onRun } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [usage] = useState<Record<string, number>>(readUsage);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  /** 打开就聚焦输入框 —— 面板的全部意义就是键盘操作，多一步点击就废了。 */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * Esc 关面板。用 `stopPropagation` 把 Esc 拦在这里，否则外壳那个
   * 「Esc 退出专注模式」的同名监听会同时触发，一次按键关两样东西。
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  /**
   * 排序：先按匹配度（前缀命中 > 包含命中），同档内按**使用次数降序**，
   * 次数相同回到原始顺序（Array.prototype.sort 在 V8 上稳定）。
   *
   * 为什么前缀优先于使用次数：用户已经开始打字了，这时候他是在**找**一个
   * 已知的命令；历史排序服务的是"什么都没打、直接回车"的场景，所以历史
   * 只在匹配度相同时起作用。把历史提到匹配度之前，会让打了两个字的用户
   * 看到一堆不相关的常用命令 —— 那是命令面板最难用的形态。
   */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scored = COMMANDS.map((c, i) => {
      if (!q) return { c, i, score: 0 };
      const label = c.label.toLowerCase();
      const alias = (c.alias ?? '').toLowerCase();
      let score = -1;
      if (label.startsWith(q)) score = 3;
      else if (label.includes(q)) score = 2;
      else if (alias.includes(q)) score = 1;
      return { c, i, score };
    }).filter((s) => s.score >= 0);

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const ua = usage[a.c.id] ?? 0;
      const ub = usage[b.c.id] ?? 0;
      if (ua !== ub) return ub - ua;
      return a.i - b.i;
    });
    return scored.map((s) => s.c);
  }, [query, usage]);

  /** 结果变了把高亮归零，否则会停在一个不存在的位置上。 */
  useEffect(() => {
    setActive(0);
  }, [query]);

  /** 键盘上下移动时把高亮项滚进可视区（结果多于屏幕高度时必需）。 */
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function run(id: string): void {
    bumpUsage(id);
    onRun(id);
    onClose();
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((v) => (results.length === 0 ? 0 : (v + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((v) => (results.length === 0 ? 0 : (v - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[active];
      if (hit) run(hit.id);
    }
  }

  /**
   * 分组渲染：保持「模式 → 面板 → 视图 → 应用」的固定顺序，而不是按结果顺序
   * 打散 —— 用户第二次打开面板时会记得「设置在最下面」，位置稳定比排序最优
   * 更重要（这正是 Refactoring UI 说的「一致性优先于局部最优」）。
   */
  const grouped = useMemo(() => {
    const order = ['模式', '面板', '视图', '应用'];
    const byGroup = new Map<string, Command[]>();
    for (const c of results) {
      const list = byGroup.get(c.group) ?? [];
      list.push(c);
      byGroup.set(c.group, list);
    }
    return order
      .filter((g) => byGroup.has(g))
      .map((g) => ({ group: g, items: byGroup.get(g) ?? [] }));
  }, [results]);

  /** 高亮项的全局下标（跨分组连续编号，和键盘上下移动一致） */
  const indexOf = new Map<string, number>();
  results.forEach((c, i) => indexOf.set(c.id, i));

  const themeLabel = THEME_LABEL[theme] ?? theme;

  return createPortal(
    <div className={styles.mask} onMouseDown={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.inputRow}>
          <svg className={styles.inputIco} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="输入命令…（↑↓ 选择，回车执行）"
            spellCheck={false}
            aria-label="搜索命令"
          />
          <kbd className={styles.esc}>Esc</kbd>
        </div>

        <ul className={styles.list} ref={listRef}>
          {results.length === 0 && <li className={styles.empty}>没有匹配的命令</li>}
          {grouped.map((g) => (
            <li key={g.group} className={styles.groupBlock}>
              <div className={styles.groupTitle}>{g.group}</div>
              <ul className={styles.groupList}>
                {g.items.map((c) => {
                  const idx = indexOf.get(c.id) ?? -1;
                  return (
                    <li key={c.id}>
                      <button
                        className={`${styles.item} ${idx === active ? styles.itemOn : ''}`}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => run(c.id)}
                      >
                        <span className={styles.itemLabel}>{c.label}</span>
                        {c.keys && <kbd className={styles.kbd}>{c.keys}</kbd>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>

        {/* 底栏只放"当前状态 + 面板自己怎么用"，不放入口 —— 入口已经在上面了。 */}
        <div className={styles.foot}>
          <span>当前：{modeLabel(mode)}</span>
          <span className={styles.footSep} />
          <span>主题 {themeLabel}</span>
          <span className={styles.footSep} />
          <span>导航栏{railCollapsed ? '已收起' : '已展开'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
