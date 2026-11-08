/**
 * §UI ·R1 外壳骨骼的接线测试 —— 命令面板 / 两态导航 / 专注模式 / 底栏可隐藏。
 *
 * ============================================================================
 * 修复前状态（三条实测事实）
 * ============================================================================
 *
 * 1. **没有统一的功能入口**。`App.tsx` 里三个入口彼此没有关系：切模式靠
 *    `nav.rail > .railModes > button.railBtn`（56px 宽、只有 SVG + 11.5px 两字
 *    标签、`flex-direction: column`，「仪表盘」三个字在 46px 里折行）、开关面板
 *    靠 `header.top > .topRight` 里两个 28px 图标、设置靠 `nav.rail > .railFoot`
 *    里的「墨」头像。全仓 `rg 'commandPalette|CommandPalette'` 零命中。
 *
 * 2. **导航栏只有一种形态**：`.rail { width: var(--mz-layout-rail-w) }`（56px）
 *    且 `.railBtn { width: 46px; font-size: var(--mz-fs-2xs) }`。竞品调研的
 *    定量证据（NN/g，179 被试 / 6 站 / 桌面+手机）实测「桌面端隐藏式导航
 *    使用率仅 27%、可见导航 48%、混合 50%」，且大屏上省下的横向空间
 *    「不足以证明隐藏它的成本」。本应用此前**恰好**只有隐藏式那一种。
 *
 * 3. **三栏永远占满、底栏永远占一行**。`.body` 里 `{showTree && <aside …>}` /
 *    `{showRail && <aside …>}` 两个开关可以各自关掉，但**没有**「一键全收」
 *    的组合；`footer.statusBar` 无条件渲染（28px 常驻）。Ulysses 的 Hide Toolbar
 *    与 Zettlr 的可折叠统计面板是本次调研里最直接的两条对照。
 *
 * ============================================================================
 * 这些测试盯的性质
 * ============================================================================
 *
 * 本仓最擅长的一类失效是**静默**：CSS 取不到自定义属性不报错（§4 第 22 条②）、
 * CSS Module 类名对不上时 React 渲染出 `class="undefined"`（§4 第 20 条①）、
 * 画好了的组件没人调（§4 第 17/19/24/26/27 条）。所以 R1 的每条改动都必须
 * 有**接线级**的证据，而不是「文件里有这串字符」。
 *
 * 分四组：
 *   A 命令面板：清单 → 分派 → 快捷键 → 使用历史
 *   B 两态导航：类名 → 令牌 → 窄窗回退
 *   C 专注模式：不卸载 Editor 的前提（第 28 条的镜像层同步依赖它）
 *   D 底栏：默认隐藏，但数字仍走第 30 条那一个来源
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const R = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** 剥掉注释：本仓三次栽在「断言被自己的说明书判红」上（见文档 §5 的坑） */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 取 `:root` 到 `[data-theme="ink"]` 之前那一段（避免误读暗色皮肤里的同名令牌） */
function rootBlock(css: string): string {
  const start = css.indexOf(':root');
  const end = css.indexOf('[data-theme="ink"]');
  return start < 0 ? '' : css.slice(start, end < 0 ? css.length : end);
}

/**
 * 按选择器取一条规则的主体。
 *
 * ★ 两个坑都在这里踩过（留档，别再犯）：
 *  1) **调用方只传选择器，不传花括号**。传 `.input {` 时拼出的正则会变成
 *     `.input \s*\{`，而 CSS 里 `{` 前恰好一个空格 —— 字面量空格 + `\s*` 会
 *     要求两个空格，匹配不到，表现为「规则明明在，测试说不在」的假红。
 *  2) 必须接受**行首任意缩进**（`^\s*`）：`@media` 块内的规则是缩进过的，
 *     只锚 `^` 会让紧凑档里的 `.rail` 查不到，同样是假红。
 */
function ruleBody(css: string, sel: string): string | null {
  const re = new RegExp(`^\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
  const m = re.exec(css);
  if (!m) return null;
  const open = m.index + m[0].length;
  const close = css.indexOf('}', open);
  return close < 0 ? null : css.slice(open, close);
}

/** 从一段 CSS 里读一个 `--mz-*` 令牌的 px 数值（读不到返回 NaN，交给断言报） */
function px(css: string, name: string): number {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*(\\d+)px`));
  return m ? Number(m[1]) : NaN;
}

const appTsx = R('src/renderer/App.tsx');
const appCss = R('src/renderer/App.module.css');
const paletteTsx = R('src/renderer/components/common/CommandPalette.tsx');
const paletteCss = R('src/renderer/components/common/CommandPalette.module.css');
const tokensCss = R('src/renderer/styles/tokens.css');
/** ★ 终审 Important-3：模式显示名的唯一来源（三副本收成一处后，账记在这个文件上） */
const modesTsx = R('src/shared/constants/modes.ts');

/** 面板清单里声明的命令 id（`{ id: 'x:y', … }` 那一列） */
const paletteIds = (): string[] =>
  [...paletteTsx.matchAll(/\{\s*id:\s*'([a-z]+:[\w-]+)'/g)].map((m) => m[1]);

/** App 的 onRun 分派里出现的 case 字面量 */
const handledIds = (): string[] =>
  [...appTsx.matchAll(/case\s+'([a-z]+:[\w-]+)'/g)].map((m) => m[1]);

describe('A. 命令面板：清单 → 分派 → 快捷键 → 使用历史', () => {
  it('面板确实被 App 渲染出来了（不是又一个"画好了没人调"）', () => {
    expect(appTsx, 'CommandPalette 没有被 import').toMatch(
      /import\s*\{\s*CommandPalette\s*\}\s*from\s*'\.\/components\/common\/CommandPalette'/,
    );
    expect(appTsx, '没有渲染 <CommandPalette/>').toMatch(/<CommandPalette\b/);
    // 命令面板是 §4 第 17/19/24/26/27 条那类「组件在、调用点不在」的高发区，
    // 所以这里正面钉一次渲染点，而不是只钉文件存在。
    expect(appTsx, '组件被 import 了却没进 JSX').toMatch(/\{showPalette\s*&&\s*\(/);
  });

  it('★ 清单里的每条命令都有分派分支（新增命令不接分派 = 点了没反应）', () => {
    const declared = paletteIds().sort();
    expect(declared.length, '命令清单是空的，这条断言没意义').toBeGreaterThanOrEqual(10);
    const handled = new Set(handledIds());
    const missing = declared.filter((id) => !handled.has(id));
    expect(missing, `这些命令在 onRun 里没有分支：${missing.join(', ')}`).toEqual([]);
  });

  it('★ 反向：分派里不许有清单外的命令（删了命令却留分支 = 死代码）', () => {
    const declared = new Set(paletteIds());
    const ghost = [...new Set(handledIds())].filter((id) => !declared.has(id));
    expect(ghost, `onRun 里有清单外的分支：${ghost.join(', ')}`).toEqual([]);
  });

  /**
   * ★ P2-UI T2：id 集不再只靠「两张镜子对看」（palette↔onRun 自洽可以是两份
   * 一起丢命令），这里逐字钉死 T2 定稿的清单：mode:* 全保留、soon 占位项
   * **不进面板**（导航里只是 disabled 的「设计中」按钮，点了没有动作，面板里就
   * 不许有它）。
   * ★ T3 R36 并批：审稿回补进 NAV_GROUPS 创作组（一级入口重新出现）后，
   * mode:review 仍只此一条 id——「审稿报告」是 label，不是新命令；id 集维持 13。
   * ★ P2-A T4：系统组实项进导航与面板，id 集 13→14（mode:prompt）。
   * 它不占数字快捷键——⌘1–⌘4 的 Ulysses 心智模型纪律不变。
   * ★ P2-B T4：资产组「伏笔台账」从 soon 占位转正为真 mode，id 集 14→15
   * （mode:foreshadow，同样不占数字快捷键）。
   * ★ P2-B T6：资产组「人物记忆」从 soon 占位转正为真 mode，id 集 15→16
   * （mode:characters，同样不占数字快捷键；soon-memory 行原地替换后 soon 剩 6 条）。
   * ★ P2-C T3：灵感组「扫榜热榜」从 soon 占位转正为真 mode，id 集 16→17
   * （mode:trends，同样不占数字快捷键；soon-trends 行原地替换后 soon 剩 5 条）。
   * ★ P2-C T4：灵感组「抽脑洞」从 soon 占位转正为真 mode，id 集 17→18
   * （mode:idea，同样不占数字快捷键；soon-brainstorm 行原地替换后 soon 剩 4 条）。
   * ★ P2-C T5：灵感组「拆书报告」从 soon 占位转正为真 mode，id 集 18→19
   * （mode:teardown，同样不占数字快捷键；soon-teardown 行原地替换后 soon 剩 3 条）。
   * ★ P2-C T6：灵感组「选题库」从 soon 占位转正为真 mode，id 集 19→20
   * （mode:topics，同样不占数字快捷键；soon-topics 行原地替换后 soon 剩 2 条）。
   */
  it('★ T2 钉死清单：面板与分派逐字等于 id 集；soon 项不进面板', () => {
    const EXPECTED = [
      'mode:write', 'mode:plan', 'mode:lore', 'mode:review', 'mode:dash', 'mode:gen', 'mode:prompt', 'mode:foreshadow', 'mode:characters', 'mode:trends', 'mode:idea', 'mode:teardown', 'mode:topics',
      'panel:tree', 'panel:rail', 'panel:status',
      'view:focus', 'view:rail-width',
      'app:open', 'app:settings',
    ].sort();
    expect([...paletteIds()].sort(), '面板清单漂出了 T2 钉死集').toEqual(EXPECTED);
    expect([...new Set(handledIds())].sort(), 'onRun 分派漂出了 T2 钉死集').toEqual(EXPECTED);
    // 注释里会「提到」soon（口径说明），所以这条剥注释只看代码：面板代码里不许有 soon 项
    expect(strip(paletteTsx), 'soon 占位项混进了命令面板（它没有可执行动作）').not.toMatch(/soon|设计中/);
  });

  it('★ T2 左导航四组 IA（P2-A T4 起为五组）：NAV_GROUPS 分组渲染 + soon 项 disabled+「设计中」tag', () => {
    expect(appTsx, '导航还是拉平的 MODES 清单').not.toMatch(/const MODES\b/);
    expect(appTsx, '没有定义 NAV_GROUPS').toMatch(/const NAV_GROUPS\b/);
    for (const g of ['创作', '资产', '灵感', '输出', '系统'])
      expect(appTsx, `分组 IA 缺「${g}」组`).toContain(`label: '${g}'`);
    expect(appTsx, 'soon 项没渲染成 disabled 按钮').toMatch(/kind === 'soon'[\s\S]{0,160}disabled/);
    expect(appTsx, 'soon 项没有「设计中」tag').toMatch(/styles\.soonTag\}>设计中</);
    // 两形态纪律锚（B 组的 title= / railLabel 断言依赖这套类名与回调参数名）
    expect(appTsx, 'railBtn/railOn 选中态拼接纪律丢了').toMatch(
      /\$\{styles\.railBtn\} \$\{mode === m\.id \? styles\.railOn/,
    );
    expect(appTsx, '收起态 title 补偿（B 组盯的 m.label 形态）丢了').toMatch(
      /title=\{railCollapsed \? m\.label/,
    );
    // ★ T3 R36 并批：审稿的**一级入口**回补进创作组（T2 定稿把它留在 R32 纪律外，
    //   评审判为计划缺口）。它是真 mode（kind:'mode'，id 'review'），四字内 label，
    //   于是「面板可达但导航没有门」的形状不许再出现。
    expect(appTsx, "R36：NAV_GROUPS 里没有 id 'review' 的 mode 条目").toMatch(
      /kind:\s*'mode',\s*id:\s*'review'/,
    );
    expect(appTsx, 'R36：审稿条目没挂四字内 label（MODE_LABELS.review）').toMatch(
      /id:\s*'review',\s*label:\s*MODE_LABELS\.review/,
    );
    expect(modesTsx, 'R36：MODE_LABELS.review 不是「审稿报告」（显示名唯一来源漂了）').toContain(
      "review: '审稿报告'",
    );
  });

  /**
   * ★ P2-A T4：PromptView（提示词与技能）存在性——组件文件、App 接线（import +
   * modeHost 渲染点 + NAV_GROUPS 系统组实项）、面板 id（已在钉死清单里）。
   * 这是 §4 第 17/19/24/26/27 条那类「画好了没人调」的正面哨兵。
   */
  it('★ P2-A T4：PromptView 被 App import、在 modeHost 渲染、系统组挂实项', () => {
    expect(() => R('src/renderer/components/views/PromptView.tsx')).not.toThrow();
    expect(() => R('src/renderer/components/views/PromptView.module.css')).not.toThrow();
    expect(appTsx, 'PromptView 没有被 import').toMatch(
      /import\s*\{\s*PromptView\s*\}\s*from\s*'\.\/components\/views\/PromptView'/,
    );
    expect(appTsx, 'PromptView 没有渲染点（modeHost 里缺 mode===prompt 分支）').toMatch(
      /mode === 'prompt' && <PromptView \/>/,
    );
    expect(appTsx, "NAV_GROUPS 系统组里没有 id 'prompt' 的 mode 实项").toMatch(
      /kind:\s*'mode',\s*id:\s*'prompt',\s*label:\s*MODE_LABELS\.prompt/,
    );
    expect(paletteIds(), '命令面板缺 mode:prompt').toContain('mode:prompt');
  });

  /**
   * ★ P2-B T6：CharacterView（人物记忆）存在性——与上面 PromptView 哨兵同规：
   * 组件文件、App 接线（import + modeHost 渲染点 + 资产组 soon-memory 原地转正）、
   * 面板 id（已在钉死清单里）。
   */
  it('★ P2-B T6：CharacterView 被 App import、在 modeHost 渲染、资产组挂实项（soon-memory 转正）', () => {
    expect(() => R('src/renderer/components/views/CharacterView.tsx')).not.toThrow();
    expect(() => R('src/renderer/components/views/CharacterView.module.css')).not.toThrow();
    expect(appTsx, 'CharacterView 没有被 import').toMatch(
      /import\s*\{\s*CharacterView\s*\}\s*from\s*'\.\/components\/views\/CharacterView'/,
    );
    expect(appTsx, 'CharacterView 没有渲染点（modeHost 里缺 mode===characters 分支）').toMatch(
      /mode === 'characters' && <CharacterView \/>/,
    );
    expect(appTsx, "资产组里 soon-memory 没转正为 id 'characters' 的 mode 实项").toMatch(
      /kind:\s*'mode',\s*id:\s*'characters',\s*label:\s*MODE_LABELS\.characters/,
    );
    expect(appTsx, 'soon-memory 占位还留着（转正要原地替换，不许双入口）').not.toMatch(/'soon-memory'/);
    expect(paletteIds(), '命令面板缺 mode:characters').toContain('mode:characters');
  });

  /**
   * ★ §UI ·终审 Important-3（模式显示名三副本收成一处）。
   * 修复前的形状：`App.tsx` 的 `MODE_LABELS`、`CommandPalette.tsx` 的 `MODE_LABEL`、
   * 以及 COMMANDS 里六个 `切换到 X` 字面量——三处手写、靠注释约定「加模式时两处一起改」。
   * 现在唯一来源是 `src/shared/constants/modes.ts`，这里双向钉：
   *   正向：七个 mode id 的显示名在来源文件里逐字存在；
   *   反向：外壳与面板**都只能引用**它，任何一侧再抄一份字面量就红。
   */
  it('★ 模式显示名只有一个来源（App / 面板都引用 shared，不再各自手写）', () => {
    // ★ P2-B T4：伏笔台账转正，键集 7→8。★ P2-B T6：人物记忆转正，键集 8→9。
    const MODE_KEYS = ['write', 'plan', 'lore', 'review', 'dash', 'gen', 'prompt', 'foreshadow', 'characters'];
    // ① 来源文件：九个键逐一存在
    for (const k of MODE_KEYS) {
      expect(modesTsx, `modes.ts 缺模式显示名 ${k}`).toMatch(new RegExp(`\\b${k}:\\s*'[^']+'`));
    }
    expect(modesTsx).toMatch(/export const MODE_LABELS:\s*Record<WorkMode,\s*string>/);
    expect(modesTsx).toMatch(
      /export type WorkMode = 'write' \| 'plan' \| 'lore' \| 'review' \| 'dash' \| 'gen' \| 'prompt' \| 'foreshadow' \| 'characters'/,
    );

    // ② 外壳：import 共享常量 + 不再本地声明 + 九条导航都挂共享名
    expect(appTsx, "App.tsx 没有从 @shared/constants/modes 取 MODE_LABELS").toMatch(
      /import\s*\{\s*MODE_LABELS,\s*type WorkMode\s*\}\s*from\s*'@shared\/constants\/modes'/,
    );
    expect(appTsx, 'App.tsx 里还留着一份本地 MODE_LABELS（第三副本的老形状回来了）').not.toMatch(
      /const MODE_LABELS\b/,
    );
    expect(appTsx, 'App.tsx 的 Mode 类型没有走共享 WorkMode').toMatch(/type Mode = WorkMode/);
    for (const k of MODE_KEYS) {
      expect(appTsx, `NAV_GROUPS 里 ${k} 没有挂 MODE_LABELS.${k}`).toContain(`label: MODE_LABELS.${k}`);
    }

    // ③ 面板：命令名与底栏都指同一处，且本地副本必须消失
    expect(paletteTsx, 'CommandPalette 没有 import 共享显示名').toMatch(
      /import\s*\{\s*MODE_LABELS,\s*modeLabel\s*\}\s*from\s*'@shared\/constants\/modes'/,
    );
    expect(paletteTsx, 'CommandPalette 里还留着一份本地 MODE_LABEL（三份副本的第二份）').not.toMatch(
      /const MODE_LABEL\b/,
    );
    for (const k of MODE_KEYS) {
      expect(paletteTsx, `面板命令 mode:${k} 的 label 没有插值 MODE_LABELS.${k}`).toContain(
        `\`切换到 \${MODE_LABELS.${k}}\``,
      );
    }
    expect(paletteTsx, '面板底栏「当前：」没有走 modeLabel()').toMatch(/\{modeLabel\(mode\)\}/);

    // ④ 反向哨兵：显示名字面量**只**允许出现在来源文件里（外加注释，故剥注释后再比）
    const names = [...modesTsx.matchAll(/^\s*(\w+):\s*'([^']+)',$/gm)]
      .filter((m) => MODE_KEYS.includes(m[1]))
      .map((m) => m[2]);
    expect(names.length, '从 modes.ts 解析出的显示名不足九条').toBe(9);
    for (const name of names) {
      for (const [label, src] of [
        ['App.tsx', strip(appTsx)],
        ['CommandPalette.tsx', strip(paletteTsx)],
      ] as const) {
        expect(
          src.includes(`'${name}'`) || src.includes(`\`${name}\``) || src.includes(`'${name}`),
          `${label} 里又出现一份「${name}」的手写字面量——显示名重新分裂了`,
        ).toBe(false);
      }
    }
  });

  it('★ T2 PipelineBar：八节点、状态从 useProjectStore 推导、挂 write/gen 的 .body 顶部', () => {
    expect(appTsx, 'PipelineBar 没有被 import').toMatch(
      /import\s*\{\s*PipelineBar\s*\}\s*from\s*'\.\/components\/common\/PipelineBar'/,
    );
    expect(appTsx, 'PipelineBar 没有挂在 write/gen 模式的 .body 顶部').toMatch(
      /\(mode === 'write' \|\| mode === 'gen'\) && !focusMode && <PipelineBar \/>[\s\S]{0,80}<div className=\{styles\.body\}>/,
    );
    const bar = R('src/renderer/components/common/PipelineBar.tsx');
    // ★ 终审 Important-2③：八节点清单与 deriveStage 搬进纯模块 pipeline-stage.ts
    //   （tests/** 归 DOM-free 的 tsconfig.node，`.tsx` 里的导出 import 不进来）。
    //   接线纪律不变：组件仍必须从那里 import 并调用，两边合起来才算「管线条存在」。
    const stage = R('src/renderer/components/common/pipeline-stage.ts');
    expect(bar, 'PipelineBar 没有引用纯推导模块').toMatch(
      /import\s*\{[^}]*deriveStage[^}]*\}\s*from\s*'\.\/pipeline-stage'/,
    );
    expect(bar, 'PipelineBar 状态没有从 useProjectStore 推导').toMatch(/useProjectStore/);
    expect(bar, 'PipelineBar 没有调用 deriveStage').toMatch(/deriveStage\(\s*\{/);
    expect(stage, 'deriveStage 不再是函数（推导层被改写或删了）').toMatch(
      /export function deriveStage\(/,
    );
    for (const n of ['灵感', '立项', '世界观', '骨架', '章纲', '正文', '质检', '定稿'])
      expect(stage, `八节点清单缺「${n}」`).toContain(`'${n}'`);
    expect(
      [...stage.matchAll(/return\s+(\d);/g)].map((m) => Number(m[1])).sort((a, b) => a - b),
      'deriveStage 的出口档不再是 0/1/2/4/5/6/7 七档（3=骨架永不为 current）',
    ).toEqual([0, 1, 2, 4, 5, 6, 7]);
    // 全令牌纪律由 theme-ink C 组 + design-tokens-usage A 组兜底，这里只钉文件在
    expect(() => R('src/renderer/components/common/PipelineBar.module.css')).not.toThrow();
  });

  it('★ 每个面板命令都在外壳里真挂上了快捷键（面板显示的键必须是真的）', () => {
    // 面板右侧写着 ⌘1/⌘2/⌘4，那绑定就必须在外壳的 keydown 里存在。
    // 这一条防的是「面板教了用户一个不存在的快捷键」——比不显示更糟。
    const keydown = strip(appTsx).slice(strip(appTsx).indexOf('function onKey'));
    for (const k of ["case '1':", "case '2':", "case '3':", "case '4':", "case '/':", "case 'k':"]) {
      expect(keydown, `快捷键 ${k} 在外壳 keydown 里不存在`).toContain(k);
    }
    // ⌘1 必须切到写作模式再动章节树，否则用户在规划页按 ⌘1 什么都不会发生
    const c1 = keydown.slice(keydown.indexOf("case '1':"), keydown.indexOf("case '2':"));
    expect(c1, "⌘1 没有先 setMode('write')").toContain("setMode('write')");
    expect(c1, '⌘1 没有切章节树').toMatch(/setShowTree\(\(v\)\s*=>\s*!v\)/);
  });

  it('⌘/ 与 ⌘K 的 preventDefault 都在（Chromium 保留键，不拦会被浏览器吃掉）', () => {
    const kd = strip(appTsx).slice(strip(appTsx).indexOf('function onKey'));
    const slash = kd.slice(kd.indexOf("case '/':"), kd.indexOf("case 'k':"));
    expect(slash, '⌘/ 没有 preventDefault').toContain('e.preventDefault()');
    const k = kd.slice(kd.indexOf("case 'k':"));
    expect(k, '⌘K 没有 preventDefault').toContain('e.preventDefault()');
  });

  it('★ 使用历史真的读写 localStorage（Zed 的 use_command_history 默认开）', () => {
    expect(paletteTsx, 'USAGE_KEY 不见了').toMatch(/const USAGE_KEY = 'mozhou\.commandUsage'/);
    expect(paletteTsx, '没有读历史的实现').toMatch(/localStorage\.getItem\(USAGE_KEY\)/);
    expect(paletteTsx, '没有写历史的实现').toMatch(/localStorage\.setItem\(USAGE_KEY/);
    // 读回来必须是"净化过"的：只手改过的存储塞进字符串/NaN 会把排序搞崩
    expect(paletteTsx, 'readUsage 没有过滤非法值').toMatch(/Number\.isFinite\(v\)\s*&&\s*v > 0/);
  });

  it('★ 排序口径：匹配度优先于使用历史（否则打字的用户会被常用命令淹没）', () => {
    const sortBlock = strip(paletteTsx).slice(strip(paletteTsx).indexOf('scored.sort'));
    const body = sortBlock.slice(0, sortBlock.indexOf('});'));
    // 先比 score，再比 usage，最后回到原始下标
    expect(body.indexOf('a.score !== b.score'), 'score 不是第一比较键').toBeLessThan(
      body.indexOf('ua !== ub'),
    );
    expect(body.indexOf('ua !== ub'), 'usage 不是第二比较键').toBeLessThan(
      body.indexOf('a.i - b.i'),
    );
  });

  it('面板打开即聚焦输入框（多一步点击就没意义了）', () => {
    expect(paletteTsx, '没有 focus 调用').toMatch(/inputRef\.current\?\.focus\(\)/);
  });

  it('★ Esc 关面板要 stopPropagation（外壳同名的 Esc 也会触发）', () => {
    const escBlock = strip(paletteTsx).slice(strip(paletteTsx).indexOf("e.key === 'Escape'"));
    expect(escBlock.slice(0, 200), 'Esc 没有 stopPropagation，一次按键会关两样东西').toContain(
      'e.stopPropagation()',
    );
  });

  it('面板 CSS 零裸色（暗色皮肤下裸 hex 必错，theme-ink C 组）', () => {
    const css = strip(paletteCss);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/\bhsla?\(/);
  });

  it('★ 面板输入框必须压掉 global.css 给的"井底"样式（否则面板里多一个方框）', () => {
    // global.css: `input, textarea, select { background: var(--mz-bg-inset); border: 1px solid … }`
    // 那是给表单字段用的。命令面板的输入框是面板的标题行，必须同底无边。
    const input = ruleBody(paletteCss, '.input');
    expect(input, '.input 规则不存在').not.toBeNull();
    expect(input ?? '', '.input 没有清掉背景').toMatch(/background:\s*transparent/);
    expect(input ?? '', '.input 没有清掉边框').toMatch(/border:\s*none/);
    const focus = ruleBody(paletteCss, '.input:focus,') ?? ruleBody(paletteCss, '.input:focus');
    expect(focus, '.input 没有自己的焦点态').not.toBeNull();
    expect(focus ?? '', '.input 的焦点态会画出一圈框').toMatch(/outline:\s*none/);
  });
});

describe('B. 两态导航：类名 → 令牌 → 窄窗回退', () => {
  it('★ 宽度不再是魔法数：展开态与收起态都走令牌', () => {
    const css = strip(appCss);
    const rail = ruleBody(css, '.rail');
    expect(rail, '.rail 规则不见了').not.toBeNull();
    expect(rail ?? '', '.rail 用了裸 px 宽度').not.toMatch(/width:\s*\d+px/);
    expect(rail ?? '', '.rail 基准不是展开态令牌').toMatch(/var\(--mz-layout-rail-expanded-w\)/);
    const collapsed = ruleBody(css, '.railCollapsed .rail');
    expect(collapsed, '收起态没有覆盖规则').not.toBeNull();
    expect(collapsed ?? '', '收起态没回到收起宽度令牌').toMatch(/var\(--mz-layout-rail-w\)/);
  });

  it('两级宽度令牌都在 :root，且展开 > 收起（否则"展开"是谎话）', () => {
    const root = rootBlock(tokensCss);
    const expanded = px(root, 'mz-layout-rail-expanded-w');
    const collapsed = px(root, 'mz-layout-rail-w');
    expect(Number.isFinite(expanded), '展开态宽度令牌不在 :root').toBe(true);
    expect(Number.isFinite(collapsed), '收起态宽度令牌不在 :root').toBe(true);
    expect(expanded).toBeGreaterThan(collapsed);
  });

  it('★ 展开态的宽度账必须成立（1280 时仍装得下正文可读下限 28em×字号令牌）', () => {
    // 这是第 33 条那条算术的第二次执行：R1 让 rail 多了一个更宽的形态，
    // 宽度账必须对新形态重算，否则第 33 条会被这一次改动静默破坏。
    const root = rootBlock(tokensCss);
    const win = Number(R('src/main/window.ts').match(/minWidth:\s*(\d+)/)?.[1] ?? 0);
    expect(win, 'window.ts 读不到 minWidth').toBeGreaterThan(0);
    const editor =
      win -
      px(root, 'mz-layout-rail-expanded-w') -
      px(root, 'mz-layout-tree-min-w') -
      px(root, 'mz-layout-rail-min-w');
    // ★ T3 同步：字号从令牌现读（18→16 那次换肤就是把魔法数 18 抄死在这里的
    //   后果——口径必须是 tokens，不是评审当天的记忆值）。
    const floor = 28 * px(root, 'mz-editor-size-novel'); // 28em × 正文字号：可读下限
    expect(editor, `展开态下编辑器只剩 ${editor}px，正文下限是 ${floor}px`).toBeGreaterThanOrEqual(
      floor,
    );
  });

  it('★ 窄窗（< 1360）里导航强制收起——两态宽度账不可能同时成立', () => {
    const bp = appCss.slice(appCss.indexOf('@media (max-width: 1359px)'));
    expect(bp, '紧凑档断点不见了').not.toBe('');
    const railRule = ruleBody(bp, '.rail');
    expect(railRule, '紧凑档没有压窄 rail').not.toBeNull();
    expect(railRule ?? '', '紧凑档里 rail 没有回到收起宽度').toMatch(/var\(--mz-layout-rail-w\)/);
    const label = ruleBody(bp, '.railLabel');
    expect(label, '紧凑档没有隐藏标签').not.toBeNull();
    expect(label ?? '', '标签没有被 display:none').toMatch(/display:\s*none/);
  });

  it('★ 收起态用 title 补偿语义（标签 display:none 后按钮只剩图标）', () => {
    // `.railCollapsed .railLabel { display: none }` 会把文字从无障碍树里摘掉，
    // 所以按钮必须有 title —— 否则读屏器面对五个没有名字的按钮。
    expect(appTsx, '收起态 railBtn 没有补 title').toMatch(/title=\{railCollapsed \? m\.label/);
    expect(appTsx, '设置按钮没有 title').toMatch(/railFootBtn[\s\S]{0,120}title="设置"/);
  });

  it('模式按钮的标签在展开态是可见文字（不再是 11.5px 折行）', () => {
    const btn = ruleBody(appCss, '.railBtn');
    expect(btn, '.railBtn 规则不见了').not.toBeNull();
    // 横排 + 不再用小号字：修复前是 column + fs-2xs（「仪表盘」折行）
    expect(btn ?? '', '.railBtn 仍是竖排').toMatch(/flex-direction:\s*row/);
    expect(btn ?? '', '.railBtn 仍用 2xs 小号字').not.toMatch(/font-size:\s*var\(--mz-fs-2xs\)/);
    expect(btn ?? '', '.railBtn 没有禁止折行').toMatch(/white-space:\s*nowrap/);
  });

  it('导航收起的偏好真的被记住（localStorage 一处读写）', () => {
    expect(appTsx, '没有 RAIL_COLLAPSED_KEY').toMatch(
      /RAIL_COLLAPSED_KEY = 'mozhou\.railCollapsed'/,
    );
    expect(appTsx, '没有读').toMatch(/localStorage\.getItem\(RAIL_COLLAPSED_KEY\)/);
    expect(appTsx, '没有写').toMatch(/localStorage\.setItem\(RAIL_COLLAPSED_KEY/);
    // useState 初始值必须走读取函数，不能写死
    expect(appTsx, '初始值没有读存储').toMatch(/useState\(readRailCollapsed\)/);
  });
});

describe('C. 专注模式：不许靠卸载组件来实现', () => {
  it('★ 专注态挂在属性上，不是条件卸载 Editor（否则滚动位置与选区全丢）', () => {
    expect(appTsx, 'shell 上没有 data-focus').toMatch(
      /data-focus=\{focusMode \? 'on' : undefined\}/,
    );
    // Editor 必须在任何情况下都渲染：它所在的分支不许被 focusMode 短路掉
    const body = appTsx.slice(appTsx.indexOf('<div className={styles.body}>'));
    const writeBranch = body.slice(0, body.indexOf(') : ('));
    expect(writeBranch, 'Editor 被 focusMode 短路掉了——用户退出专注后会丢失位置').not.toMatch(
      /\{!?focusMode\s*&&\s*<main className=\{styles\.center\}/,
    );
    expect(writeBranch, 'Editor 不在了').toContain('<Editor />');
  });

  it('侧栏靠条件渲染收掉是对的，但必须叠在 focusMode 上（两者都要为真）', () => {
    // ★ 两个坑都在这里踩过（留档）：
    //   1) 不能用 indexOf 切窗口：`<div className={styles.body}>` 这个锚点在
    //      JSX 里出现一次，但它的**文本**在文件头注释里先出现一次，于是
    //      indexOf 命中注释，切出来的窗口是文件开头 → 假红。
    //   2) 不许假设 `<aside>` 与 className 同行：真实代码是
    //      `{showRail && !focusMode && (\n  <aside className={styles.right}>`
    //      —— 断言里写死同一行会假红。用 `[\s\S]{0,40}` 容忍换行与缩进。
    const code = strip(appTsx);
    expect(code, '左栏没有叠 focusMode').toMatch(
      /showTree && !focusMode &&[\s\S]{0,40}<aside className=\{styles\.left\}/,
    );
    expect(code, '右栏没有叠 focusMode').toMatch(
      /showRail && !focusMode &&[\s\S]{0,40}<aside className=\{styles\.right\}/,
    );
  });

  it('专注态至少有 CSS 落点（属性选择器），且类名有配对规则', () => {
    expect(appCss, '没有 data-focus 的样式').toMatch(/\.shell\[data-focus='on'\]/);
    // css-module-classes A 组：App.tsx 用了 styles.focus，就必须有 .focus 规则
    expect(appTsx, 'shellCls 里没有 styles.focus').toMatch(/focusMode \? styles\.focus/);
    expect(appCss, 'styles.focus 没有配对的 CSS 规则（A 组会红）').toMatch(/^\.focus/m);
  });

  it('★ Esc 的优先级：先退专注，且不许无条件吃掉 Esc', () => {
    const kd = strip(appTsx).slice(strip(appTsx).indexOf('function onKey'));
    const esc = kd.slice(kd.indexOf("e.key === 'Escape'"), kd.indexOf('if (!mod) return;'));
    expect(esc, 'Esc 不退出专注模式').toMatch(/setFocusMode\(false\)/);
    // 只有真的处理了才 preventDefault：无条件拦 Esc 会让别的组件收不到
    expect(esc, 'Esc 没有先判 focusMode').toMatch(/if \(focusMode\) \{/);
    expect(esc, 'preventDefault 没有写在 focusMode 判断里面').toContain('e.preventDefault()');
  });
});

describe('D. 底栏：默认隐藏，但数字仍只有第 30 条那一个来源', () => {
  it('★ 底栏默认不显示', () => {
    expect(appTsx, '底栏默认仍是开着的').toMatch(
      /const \[showStatus, setShowStatus\] = useState\(false\)/,
    );
  });

  it('底栏是条件渲染的，不是常驻一行高度', () => {
    expect(appTsx, 'footer 仍然无条件渲染').toMatch(
      /\{showStatus && \(\s*<footer className=\{styles\.statusBar\}>/,
    );
  });

  it('★ 数字仍来自 dash（第 30 条收敛后的唯一来源），没有被 R1 顺手改成各自取数', () => {
    const foot = appTsx.slice(appTsx.indexOf('{showStatus && ('));
    const body = foot.slice(0, foot.indexOf('</footer>'));
    expect(body, '底栏没有用 dash').toContain('dash');
    // 不许在底栏里直接调 bridge / 重新拉数——那就是第 30 条要消灭的形状
    expect(body, '底栏里又出现了直接取数').not.toMatch(/bridge\(\)\./);
  });

  it('底栏高度令牌化', () => {
    const bar = ruleBody(appCss, '.statusBar') ?? '';
    expect(bar, '底栏高度仍是裸 px').not.toMatch(/height:\s*\d+px/);
    expect(bar, '底栏没有用 --mz-layout-status-h').toMatch(/var\(--mz-layout-status-h\)/);
    expect(rootBlock(tokensCss), '--mz-layout-status-h 不在 :root').toMatch(
      /--mz-layout-status-h\s*:/,
    );
  });

  it('★ 顶栏高度也令牌化（此前是硬写的 44px）', () => {
    const top = ruleBody(appCss, '.top') ?? '';
    expect(top, '顶栏高度仍是裸 px').not.toMatch(/height:\s*\d+px/);
    expect(top, '顶栏没有用 --mz-layout-top-h').toMatch(/var\(--mz-layout-top-h\)/);
    expect(px(rootBlock(tokensCss), 'mz-layout-top-h'), '顶栏高度令牌不在 :root').toBeGreaterThan(0);
  });
});
