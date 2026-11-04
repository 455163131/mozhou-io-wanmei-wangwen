/**
 * §UI ·P2-UI T4（视觉冒烟小修批）两组断言。
 *
 * 来源：真机 dev 截图目检（`.superpowers/sdd/2026-11-04-p2ui-guofeng-reskin/shots/`），
 * 两条都是「静态门禁查不出来、只有实跑才看得见」的形状：
 *
 *  A. 朱砂印「墨」mark —— DRD §4.4 的三色是「墨蓝 + 香槟金 + 朱砂印」，T1 建了
 *     --mz-brand-seal 却没有任何组件引用它（截图上的品牌方印是金色的，整套 UI
 *     因此只剩两色）。这里把 .mark 的实底钉到朱砂印档，并按图形级（非文字）
 *     ≥3:1 现算两套皮肤的印章底/墨字对比。
 *  B. 章节树 todo 空心点 —— T3 报告 concern-2：border-subtle 压 bg-surface 只有
 *     1.1x:1，快速扫视时「没动笔的章」像没有点。截图复核成立，按 brief 口径
 *     升到 border-strong 档；钉的不是绝对值（暗底冷蓝灰本来就拉不开），而是
 *     「同面上必须比旧档更亮」这条可核验的关系，旧档一旦回来就判红。
 *  C. §UI ·R37 hover 选中态特异性回补 + R38 扩面 + 终审 Important-2 **派生式候选集**
 *     —— global.css 的 `button:hover:not(:disabled)` 特异性 (0,2,1) 压过组件侧裸
 *     `.xx:hover` (0,2,0)，选中态（实底 + 反色字）hover 时底色被全局刷成 bg-hover、
 *     字色却仍是反色档：ink 皮肤实测 1.25:1 近不可读（真机评审发现）。R37/R38 手写
 *     的六处清单修的是「已经看见的」，终审 Important-2 把口径换成**从 CSS 派生**：
 *     扫全渲染层 CSS，凡「实底背景 ∈ {accent, brand-seal, sem-warn-strong,
 *     sem-err-strong} × 反色字 ∈ {text-inverse, accent-ink, sem-ink}」且宿主是
 *     `<button>` 的规则，都必须自带一条**特异性严格大于** (0,2,1) 的 hover 覆盖。
 *     「严格」不是洁癖：global.css 是 `@import` 链的最后一环、在产物里最后加载，
 *     同特异性时后写者胜（口径同 editor-prose-layout C 组「同特异度且加载更晚」），
 *     所以平局＝输。派生后 ConfirmDialog 的 `.dangerBtn`（终审 Important-1 那颗
 *     回滚确认键）自然入列，候选全量 10 处（原 6 处 + dangerBtn + R37 之前就各自
 *     挡住的 AgentPanel .runBtn / SettingsModal .btnPrimary / GenView .btnPrimary）。
 *  D. §UI ·终审 Important-3（R40）+ Minor③（R41）—— soon 占位项在展开态被省略号
 *     截断：一行里 mode 项没有「设计中」chip、soon 项有，所以 soon 的标签预算少一颗
 *     chip 的宽度；四字标签需要的宽度**恰好**比预算大 2px，于是 `button:hover` 那次
 *     没查出来的账在这里现算。同批钉：模式显示名三副本收成一处、占位符颜色接线。
 *
 * 比值一律 WCAG 2.1 现场算（与 theme-ink B 组 / p2ui-t3-reskin B 组同式），不抄结论。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 剥注释：文档里满是「这里曾经是金色」，不剥就是拿历史叙述判红 */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const appCss = read('../../src/renderer/App.module.css');
const appTsx = read('../../src/renderer/App.tsx');
const treeCss = read('../../src/renderer/components/chapter-tree/ChapterTree.module.css');
const tokensCss = read('../../src/renderer/styles/tokens.css');

/** 取行首选择器第一条规则的花括号体（与 p2ui-t3-reskin 同读法） */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}\\s*\\{`, 'm').exec(css);
  if (!m) return '';
  const open = css.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

/**
 * 收 css 里所有**以 `base:hover…` 收尾**的规则（选择器头 + 花括号体），供 C 组逐条钉。
 * ★ R38：`base:hover` 前面允许带前置类名/后代组合器——`.railCollapsed .railOn:hover`、
 *   `.paraChip.paraOn:hover` 这类「靠复合选择器提特异性」的写法同样是合法修法，
 *   只认行首裸 `base:hover` 会把它们当成「规则不存在」。
 */
function hoverRules(css: string, base: string): Array<{ header: string; body: string }> {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: Array<{ header: string; body: string }> = [];
  const re = new RegExp(`^[ \\t]*([^\\{\\n]*${esc}:hover[^\\{\\n]*)\\{`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push({ header: m[1].trim(), body: css.slice(open + 1, i) });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * 选择器头的特异性：CSS 的 (a,b,c) 三元组这里只取后两档 —— a（ID）在本项目
 * 的 CSS Module 里恒 0，比大小用不上。b = 类 / 伪类 / 属性选择器，
 * c = 类型选择器 / 伪元素。口径与规范一致：`:not()` 自身不贡献，括号里的
 * 参数照计；`::before` 那类伪元素落 c 档。
 */
function specificity(header: string): [number, number] {
  // 先拆 :not()：不拆的话 `:hover:not(:disabled)` 会把 `:not` 自己也数成一个伪类，
  // 特异性被高估，本组的「压不过全局」就永远测不出红。
  const s = header.replace(/::[\w-]+/g, ' ').replace(/:not\(([^)]*)\)/g, ' $1 ');
  const b = (s.match(/\.[\w-]+|:[\w-]+|\[[^\]]*\]/g) ?? []).length;
  const c = (s.replace(/\.[\w-]+|:[\w-]+|\[[^\]]*\]/g, ' ').match(/[a-zA-Z][\w-]*/g) ?? []).length;
  return [b, c];
}

/**
 * 与 global.css 的 `button:hover:not(:disabled)` = (0,2,1) 比：**必须严格大于**。
 *
 * ★ §UI ·终审 Important-2①：平局过去算赢，那是错的。global.css 是 index.html 里
 *   最后加载的一环（`@import './tokens.css'` 之后，且组件 CSS Module 都排在它之前），
 *   特异性相等时**后写者胜**，所以 (0,2,1) 对 (0,2,1) 的实际结果是组件侧输——
 *   与 editor-prose-layout C 组「global.css 同特异度且加载更晚，把稿纸镶了一圈红」
 *   是同一条层叠事实。这里按字典序严格比：b>2，或 b=2 且 c>1。
 */
function beatsGlobalButtonHover(header: string): boolean {
  const [b, c] = specificity(header);
  return b > 2 || (b === 2 && c > 1);
}

/* ── C 组的派生式候选集（终审 Important-2②：候选从 CSS 来，不从记忆来）──────── */

const RENDERER_DIR = fileURLToPath(new URL('../../src/renderer', import.meta.url));

/** 渲染层全部 CSS（tokens.css 除外——它是定义处，不是使用处） */
const RENDERER_CSS: string[] = (() => {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      const rel = base ? `${base}/${n}` : n;
      if (statSync(full).isDirectory()) walk(full, rel);
      else if (n.endsWith('.css') && n !== 'tokens.css') out.push(rel);
    }
  };
  walk(RENDERER_DIR, '');
  return out.sort();
})();

const readCss = (rel: string): string =>
  readFileSync(join(RENDERER_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

/** 「实底」档：饱和实底背景，其上必须走反色字（tokens.css §4/§5 的四档） */
const SOLID_BG_TOKENS = ['--mz-accent', '--mz-brand-seal', '--mz-sem-warn-strong', '--mz-sem-err-strong'];
/** 「反色字」档：浓墨/近白，专为压在实底上而生 */
const INK_FG_TOKENS = ['--mz-text-inverse', '--mz-accent-ink', '--mz-sem-ink'];

/** 全部规则（选择器头 + 花括号体），与 form-controls 的 rules() 同读法 */
function allRules(css: string): Array<{ header: string; body: string }> {
  const out: Array<{ header: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.push({ header: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** 基态规则：排除 hover/active/focus/disabled/伪元素/at-rule 头 */
const isBaseRule = (header: string): boolean =>
  !/:hover|:active|:focus|:disabled|::|^@|\s\|\s/.test(header);

const bgOf = (body: string): string[] =>
  [...body.matchAll(/background(?:-color)?:\s*var\((--mz-[\w-]+)\)/g)].map((m) => m[1]);
const fgOf = (body: string): string[] =>
  [...body.matchAll(/(?:^|[;\s])color:\s*var\((--mz-[\w-]+)\)/g)].map((m) => m[1]);

/**
 * 类名宿主是不是 `<button>`：CSS Module 与同名 tsx 一对一（css-module-classes A 组
 * 已经保证配对存在），取 `styles.X` 出现点**最近的前一个开标签**当宿主——
 * 就是 form-controls F 组那条台账用过的手法。
 * 这一步是候选集的必要闸门：`.mark`（品牌印章）同样是 brand-seal 实底 + 反色字，
 * 但它的宿主是 `<div>`，全局 button:hover 洗不到它，把它拉进来就是假阳性。
 */
function hostedOnButton(cssRel: string, cls: string): boolean {
  if (!cssRel.endsWith('.module.css')) return false;
  const tsxRel = join(RENDERER_DIR, cssRel.replace(/\.module\.css$/, '.tsx'));
  let src: string;
  try {
    src = strip(readFileSync(tsxRel, 'utf8').replace(/\r\n/g, '\n'));
  } catch {
    return false; // 没有同名 tsx（App.module.css 之外的 global.css 等）
  }
  const re = new RegExp(`styles\\.${cls}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const opens = [...src.slice(0, m.index).matchAll(/<([a-zA-Z][\w.]*)/g)];
    const last = opens[opens.length - 1];
    if (last && last[1].toLowerCase() === 'button') return true;
  }
  return false;
}

interface SolidButtonPin {
  key: string;
  cssRel: string;
  cls: string;
  /** 基态规则的实底档与反色字档 */
  baseBg: string;
  baseFg: string;
}

/** 从 CSS 派生候选集：实底 × 反色字 × 宿主是 button */
function deriveSolidButtons(): SolidButtonPin[] {
  const found = new Map<string, SolidButtonPin>();
  for (const cssRel of RENDERER_CSS) {
    for (const r of allRules(strip(readCss(cssRel)))) {
      if (!isBaseRule(r.header)) continue;
      const bg = bgOf(r.body).find((b) => SOLID_BG_TOKENS.includes(b));
      const fg = fgOf(r.body).find((f) => INK_FG_TOKENS.includes(f));
      if (!bg || !fg) continue;
      const cls = r.header
        .split(/[\s,>+~]+/)
        .map((part) => [...part.matchAll(/\.[\w-]+/g)].map((c) => c[0].slice(1)))
        .flat()
        .filter((c) => hostedOnButton(cssRel, c))
        .pop();
      if (!cls) continue;
      found.set(`${cssRel}#${cls}`, { key: `${cssRel}#${cls}`, cssRel, cls, baseBg: bg, baseFg: fg });
    }
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 候选集全量（终审 Important-2② 派生出来的账，逐条点名）。
 * 前六处 = R37/R38 手写清单；后四处 = 派生扫出来的**同族但一直没进清单**的：
 *   - AgentPanel `.runBtn`、SettingsModal `.btnPrimary`、GenView `.btnPrimary`
 *     三处早就各自带了 `.btnPrimary:hover:not(:disabled)` 那类同形覆盖（R37 的
 *     注释还指着它们当写法范例），只是从没进过回归清单；
 *   - ConfirmDialog `.dangerBtn` 是终审 Important-1 补的那颗，族是 warn-strong。
 * ★ 这里红了两边都不许默默改表：多一条＝新出现的实底按钮（要么补 hover 覆盖，
 *   要么在本文件写明并记进报告台账），少一条＝候选集本身漂了（改族名/改宿主标签）。
 */
const SOLID_BUTTON_CENSUS = [
  'App.module.css#railOn',
  'components/agent/AgentPanel.module.css#runBtn',
  'components/common/ConfirmDialog.module.css#dangerBtn',
  'components/expert/ExpertPanel.module.css#btnPrimary',
  'components/expert/ExpertPanel.module.css#chipOn',
  'components/flavor/FlavorPanel.module.css#btnPrimary',
  'components/flavor/FlavorPanel.module.css#paraOn',
  'components/settings/SettingsModal.module.css#btnPrimary',
  'components/views/GenView.module.css#btnPrimary',
  'components/views/ReviewView.module.css#btnPri',
];

/**
 * hover 生效对的可读性下限（键 = `hoverBg|生效字色`）。
 * 不在表里的组合一律判红并要人显式定档——「顺手放宽」就是这条门禁存在的反面。
 */
const HOVER_PAIR_BAR: Record<string, { min: number; why: string }> = {
  '--mz-accent-hover|--mz-text-inverse': {
    min: 4.5,
    why: '香槟金/金墨实底 hover 档 × 反色正文级字（R37 起全部走这对）',
  },
  '--mz-accent-hover|--mz-accent-ink': {
    min: 4.5,
    why: '同上，字色走 accent-ink 档（GenView 导演台 CTA）',
  },
  '--mz-sem-warn-strong|--mz-sem-ink': {
    min: 3.0,
    why: '★ 终审 Important-1 的例外档：paper 的 sem-warn-strong 是 v2 化石值，压 sem-ink 现算 3.69:1（过图形级 3、不过正文档 4.5）。本批不动令牌，理由与台账写在 tokens.css §5；这里只钉「hover 保持实底」这条可核验关系。',
  },
};

function extractBlock(src: string, selector: string): string {
  const at = src.indexOf(selector);
  expect(at, `tokens.css 里找不到 ${selector} 块`).toBeGreaterThan(-1);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

function decls(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const seg of block.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const m = seg.match(/\s*(--[\w-]+)\s*:\s*([\s\S]+)/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().slice(1);
  if (!/^#[0-9a-fA-F]{6}$/.test(hex.trim())) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function contrast(fgHex: string, bgHex: string): number | null {
  const f = hexToRgb(fgHex);
  const b = hexToRgb(bgHex);
  if (!f || !b) return null;
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const L = (rgb: [number, number, number]): number =>
    0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const a = L(f);
  const c = L(b);
  return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
}

const paper = decls(extractBlock(tokensCss, ':root'));
const ink = decls(extractBlock(tokensCss, '[data-theme="ink"]'));
const SKINS = [
  ['paper', paper],
  ['ink', ink],
] as const;

describe('A. 朱砂印「墨」mark（DRD §4.4 三色之第三色必须真落到 UI 上）', () => {
  it('brand-seal 两套皮肤成对定义（印章不随明暗漂移，值同为 #C4553B）', () => {
    for (const [name, decl] of SKINS) {
      const v = decl.get('--mz-brand-seal');
      expect(v, `${name} 皮肤缺 --mz-brand-seal`).toBeTruthy();
      expect(v, `${name} 的朱砂印不是 hex 档`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(paper.get('--mz-brand-seal')).toBe(ink.get('--mz-brand-seal'));
  });

  it('★ .mark 实底取朱砂印，不再蹭香槟金（截图上「整套 UI 只剩两色」的根因）', () => {
    // 走 strip()：.mark 体内那段修订注释写满了「实底从香槟金改走朱砂印」，
    // 不剥注释就是拿历史叙述判红（同文件头对 strip 的定义）。
    const mark = ruleBody(strip(appCss), '.mark');
    expect(mark, 'App.module.css 缺 .mark 规则').not.toBe('');
    expect(mark).toMatch(/background:\s*var\(--mz-brand-seal\)/);
    expect(mark, '.mark 又回到金色实底').not.toMatch(/background:\s*var\(--mz-accent\)/);
    expect(mark).toMatch(/color:\s*var\(--mz-text-inverse\)/);
  });

  it('印章底/墨字现算图形级 >= 3:1（mark 是品牌图形，非正文文字档）', () => {
    for (const [name, decl] of SKINS) {
      const r = contrast(decl.get('--mz-text-inverse') ?? '', decl.get('--mz-brand-seal') ?? '');
      expect(r, `${name}: text-inverse on brand-seal 解不出色值`).not.toBeNull();
      const ratio = Math.round((r ?? 0) * 100) / 100;
      expect(ratio, `${name}: 墨字压朱砂印只有 ${ratio}:1（图形级下限 3）`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('B. 章节树 todo 空心点档位（T3 concern-2 的截图裁决）', () => {
  it('仍是空心（透明底），但描边升到 border-strong 档', () => {
    // 同 A2：.dotTodo 体内的修订注释提过旧档 border-subtle，先剥再钉。
    const todo = ruleBody(strip(treeCss), '.dotTodo');
    expect(todo, '缺 .dotTodo 规则').not.toBe('');
    expect(todo).toMatch(/background:\s*transparent/);
    expect(todo).toMatch(/border:[^;]*var\(--mz-border-strong\)/);
    expect(todo, 'todo 点又掉回 border-subtle（截图实测近不可见）').not.toMatch(
      /border:[^;]*var\(--mz-border-subtle\)/,
    );
  });

  it('★ 同面上新档必须严格亮过旧档（两套皮肤都算，钉的是关系不是绝对值）', () => {
    for (const [name, decl] of SKINS) {
      const surface = decl.get('--mz-bg-surface') ?? '';
      const strong = contrast(decl.get('--mz-border-strong') ?? '', surface);
      const subtle = contrast(decl.get('--mz-border-subtle') ?? '', surface);
      expect(strong, `${name}: border-strong on bg-surface 解不出色值`).not.toBeNull();
      expect(subtle, `${name}: border-subtle on bg-surface 解不出色值`).not.toBeNull();
      expect(
        (strong ?? 0) > (subtle ?? 0),
        `${name}: border-strong=${strong?.toFixed(2)} 没比 border-subtle=${subtle?.toFixed(2)} 更亮`,
      ).toBe(true);
    }
  });

  it('组件 CSS 零裸色不破（同 theme-ink C 组口径，防这两处顺手硬写）', () => {
    for (const [label, css] of [
      ['App.module.css', appCss],
      ['ChapterTree.module.css', treeCss],
    ] as const) {
      expect(strip(css), `${label} 出现裸 hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(strip(css), `${label} 出现裸 rgba`).not.toMatch(/\brgba?\(/);
    }
  });
});

describe('C. §UI ·R37+R38+终审 Important-2 hover 覆盖（候选集从 CSS 派生，全局 button:hover 不得洗掉实底）', () => {
  const PINS = deriveSolidButtons();

  it('★ 派生候选集逐字等于台账（新增实底反色按钮必须进来，漏一条也要说明为什么）', () => {
    expect(
      PINS.map((p) => p.key),
      '派生结果与台账不一致。多出来的：先给它补同形 hover 覆盖再登记；消失的：确认不是「把类名改了/把宿主换成 div」造成的静默逃逸。',
    ).toEqual(SOLID_BUTTON_CENSUS);
    // 哨兵：候选集本身不许空转成 6 以下（walk 路径写错时会静默变空）
    expect(PINS.length, '派生候选集小于台账条数，扫描器自己失效了').toBeGreaterThanOrEqual(
      SOLID_BUTTON_CENSUS.length,
    );
  });

  it('每条候选都有自己的 :hover 规则，且特异性**严格**压过 global.css button:hover:not(:disabled) (0,2,1)', () => {
    for (const p of PINS) {
      const rules = hoverRules(strip(readCss(p.cssRel)), `.${p.cls}`);
      expect(
        rules.length,
        `${p.cssRel} 缺 .${p.cls}:hover —— hover 底色只剩全局 button:hover，实底被洗成 bg-hover`,
      ).toBeGreaterThan(0);
      for (const r of rules) {
        expect(
          beatsGlobalButtonHover(r.header),
          `${p.cssRel} 「${r.header}」特异性 ${specificity(r.header).join(',')} 没**严格**赢过 global.css 的 (0,2,1)：global.css 在产物里最后加载，同特异性时组件侧输，底色退回 bg-hover 而字色仍是反色档`,
        ).toBe(true);
      }
    }
  });

  it('hover 态仍走实底档（背景不许退回 --mz-bg-* 那类面板色；改了字色就必须还是反色档）', () => {
    for (const p of PINS) {
      for (const r of hoverRules(strip(readCss(p.cssRel)), `.${p.cls}`)) {
        const bg = bgOf(r.body);
        expect(
          bg.length > 0 && bg.some((b) => /accent|seal|strong/.test(b)),
          `${p.cssRel} 「${r.header}」的 hover 背景不是实底族：${JSON.stringify(bg)}`,
        ).toBe(true);
        expect(r.body, `${p.cssRel} 「${r.header}」把实底退回了面板色（就是那颗 bug）`).not.toMatch(
          /background:\s*var\(--mz-bg-/,
        );
        const fg = fgOf(r.body);
        if (fg.length > 0) {
          expect(
            fg.every((f) => INK_FG_TOKENS.includes(f)),
            `${p.cssRel} 「${r.header}」的字色不再是反色档：${JSON.stringify(fg)}`,
          ).toBe(true);
        }
        // 没写 color 是合法的：基态那条反色字继续生效（SettingsModal/AgentPanel 就是这么写的）
      }
    }
  });

  it('★ hover 实际生效对现算 >= 档位下限（两套皮肤；例外档必须显式写在 HOVER_PAIR_BAR 里）', () => {
    expect(PINS.length, '候选集是空的，这条断言没有意义').toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const p of PINS) {
      const rules = hoverRules(strip(readCss(p.cssRel)), `.${p.cls}`);
      const last = rules[rules.length - 1];
      const bg = last ? bgOf(last.body)[0] ?? p.baseBg : p.baseBg;
      const fg = last && fgOf(last.body).length > 0 ? fgOf(last.body)[0] : p.baseFg;
      const bar = HOVER_PAIR_BAR[`${bg}|${fg}`];
      expect(
        bar,
        `${p.key} 的 hover 生效对 ${bg} × ${fg} 没定过档：新组合要人来判断下限，不许默认放过`,
      ).toBeDefined();
      seen.add(`${bg}|${fg}`);
      for (const [name, decl] of SKINS) {
        const r = contrast(decl.get(fg) ?? '', decl.get(bg) ?? '');
        expect(r, `${name}: ${bg} × ${fg} 解不出色值`).not.toBeNull();
        const ratio = Math.round((r ?? 0) * 100) / 100;
        expect(
          ratio,
          `${name}: ${p.key} 的 hover 生效对只有 ${ratio}:1（下限 ${(bar?.min ?? 4.5)
            .toFixed(1)}；${bar?.why ?? ''}）`,
        ).toBeGreaterThanOrEqual(bar?.min ?? 4.5);
      }
    }
    // 例外档不许被悄悄扩大：目前全仓只有一对走 <4.5
    const relaxed = [...seen].filter((k) => (HOVER_PAIR_BAR[k]?.min ?? 4.5) < 4.5);
    expect(
      relaxed,
      `放宽到正文档以下的 hover 对有 ${relaxed.length} 对（台账里只许 warn-strong 那一对，见 tokens.css §5 例外）`,
    ).toEqual(['--mz-sem-warn-strong|--mz-sem-ink']);
  });

  it('★ 反向取证：bug 的成因对（反色字压 bg-hover）确实不过线——钉住「赢的必须是实底那对」', () => {
    for (const [name, decl] of SKINS) {
      const fg = decl.get('--mz-text-inverse') ?? '';
      const bg = decl.get('--mz-accent-hover') ?? '';
      const r = contrast(fg, bg);
      expect(r, `${name}: text-inverse on accent-hover 解不出色值`).not.toBeNull();
      const ratio = Math.round((r ?? 0) * 100) / 100;
      expect(
        ratio,
        `${name}: hover 态墨字/近白字压 accent-hover 只有 ${ratio}:1（下限 4.5；退回 bg-hover 档时 ink 实测 1.25:1）`,
      ).toBeGreaterThanOrEqual(4.5);
      const bugPair = contrast(fg, decl.get('--mz-bg-hover') ?? '');
      expect(bugPair, `${name}: bg-hover 对照解不出色值`).not.toBeNull();
      if (name === 'ink') {
        expect(
          Math.round((bugPair ?? 0) * 100) / 100,
          `${name}: bg-hover 对不再近不可读？那这条反证就该改写`,
        ).toBeLessThan(4.5);
      }
    }
  });

  it('global.css 里那条全局 button:hover 还在（组件侧的覆盖是以它为对手的，对手不许被删）', () => {
    const g = strip(readCss('styles/global.css'));
    const rule = allRules(g).find((r) => r.header === 'button:hover:not(:disabled)');
    expect(rule, 'global.css 的全局 button hover 底色被删了：C 组的特异性账就没有对手了').toBeDefined();
    expect(rule?.body).toMatch(/background:\s*var\(--mz-bg-hover\)/);
  });

  it('★ 「平局＝输」的前提本身也被钉住：main.tsx 里 global.css 排在 App 之后', () => {
    // 上两条用例把特异性判据从 `>=` 改成严格 `>`，依据是层叠的第二顺位「后来者胜」。
    // 后来者是谁不是常量，是 main.tsx 的 import 顺序决定的：App（连带全部 CSS Module）
    // 必须先于 global.css，否则同特异性时输的是全局而不是组件，判据就得改回去。
    // 实测产物 `out/renderer/assets/index-*.css`：全局 button:hover 落在 5337/5342 行（最末）。
    const main = read('../../src/renderer/main.tsx');
    const atApp = main.indexOf("from './App'");
    const atGlobal = main.indexOf("'./styles/global.css'");
    expect(atApp, 'main.tsx 不再 import App：C 组的对手关系要重判').toBeGreaterThan(-1);
    expect(atGlobal, 'main.tsx 不再 import global.css：全应用失去 button 基础态').toBeGreaterThan(-1);
    expect(
      atGlobal > atApp,
      'global.css 排到了 App 之前：同特异性时输的将是全局那条，beatsGlobalButtonHover 的「严格大于」该放宽回平局可赢',
    ).toBe(true);
  });
});

describe('D. §UI ·终审 Important-3（R40 soon 行宽度账）+ Minor③（R41 占位符接线）', () => {
  /** tokens 取值解析：`Npx` / `Nem` / `var(--x)` 链（布局与间距令牌都在 :root，两套皮肤共用） */
  function tokenNum(name: string, seen = 0): number {
    const raw = paper.get(name);
    expect(raw, `tokens.css :root 缺 ${name}`).toBeTruthy();    const v = (raw ?? '').trim();
    const chain = /^var\((--[\w-]+)\)$/.exec(v);
    if (chain) {
      expect(seen, `${name} 的 var 链打转了`).toBeLessThan(4);
      return tokenNum(chain[1], seen + 1);
    }
    const len = /^(\d+(?:\.\d+)?)px$/.exec(v) ?? /^(\d+(?:\.\d+)?)em$/.exec(v);
    expect(len, `${name} 的值读不出长度：${v}`).not.toBeNull();
    return Number(len?.[1]);
  }

  /**
   * 取一条规则里某个属性的长度分量，再解析成 px。
   * `which='inline'`（默认）取**横向分量**：两值简写 `padding: 竖向 横向` 的第二个；
   * `which='first'` 取第一个分量——`border: 1px solid var(--x)` 的线宽就在那儿，
   * 按横向分量的规矩去取会拿到 `solid` 这个关键字。
   */
  function lenOf(body: string, prop: string, which: 'inline' | 'first' = 'inline'): number {
    const m = new RegExp(`${prop}:\\s*([^;]+);`).exec(body);
    expect(m, `规则里找不到 ${prop}`).not.toBeNull();
    const parts = (m?.[1] ?? '').trim().split(/\s+/);
    const h = which === 'first' || parts.length < 2 ? parts[0] : parts[1];
    const viaToken = /^var\((--[\w-]+)\)$/.exec(h);
    if (viaToken) return tokenNum(viaToken[1]);
    const px = /^(\d+(?:\.\d+)?)px$/.exec(h);
    expect(px, `${prop} 的分量读不出长度：${h}`).not.toBeNull();
    return Number(px?.[1]);
  }

  const css = strip(appCss);
  const railBody = ruleBody(css, '.rail');
  const btnBody = ruleBody(css, '.railBtn');
  const soonBody = ruleBody(css, '.railSoon');
  const tagBody = ruleBody(css, '.soonTag');
  const icoBody = ruleBody(css, '.railIco');
  for (const [name, body] of [
    ['.rail', railBody],
    ['.railBtn', btnBody],
    ['.railSoon', soonBody],
    ['.soonTag', tagBody],
    ['.railIco', icoBody],
  ] as const) {
    expect(body, `App.module.css 缺 ${name} 规则`).not.toBe('');
  }

  /** soon 标签：直接从 App.tsx 的 NAV_GROUPS 派生，不抄清单 */
  const SOON = [...appTsx.matchAll(/kind:\s*'soon',\s*id:\s*'([\w-]+)',\s*label:\s*'([^']+)'/g)].map(
    (m) => ({ id: m[1], label: m[2] }),
  );
  const CHIP = /styles\.soonTag\}>([^<]+)</.exec(appTsx)?.[1] ?? '';

  /**
   * soon 行的几何账（全部从令牌 + 规则现读，没有一个手抄的数）。
   * `budget(gap)` = 展开态轨宽 − rail 左右内边距 − 行左右内边距 − 图标 − chip − 两道 gap。
   */
  function soonRow(): {
    budget: (gap: number) => number;
    need: (chars: number) => number;
    widest: number;
    gapSoon: number;
    gapMode: number;
  } {
    const inner =
      tokenNum('--mz-layout-rail-expanded-w') -
      2 * lenOf(railBody, 'padding') -
      2 * lenOf(btnBody, 'padding');
    const chipW =
      [...CHIP].length * tokenNum('--mz-fs-2xs') +
      2 * lenOf(tagBody, 'padding') +
      2 * lenOf(tagBody, 'border', 'first');
    const fixed = inner - lenOf(icoBody, 'width') - chipW;
    const labelFs = tokenNum('--mz-chrome-type-body');
    const tracking = tokenNum('--mz-tracking-cjk');
    return {
      budget: (gap: number): number => fixed - 2 * gap,
      need: (chars: number): number => chars * labelFs * (1 + tracking),
      widest: Math.max(...SOON.map((s) => [...s.label].length)),
      gapSoon: lenOf(soonBody, 'gap'),
      gapMode: lenOf(btnBody, 'gap'),
    };
  }

  it('soon 占位项确实存在，且标签逐条 ≤4 字（R40 裁决的契约）', () => {
    expect(SOON.length, 'NAV_GROUPS 里一个 soon 项都没扫到，这条断言空转').toBeGreaterThanOrEqual(6);
    for (const s of SOON) {
      const n = [...s.label].length;
      expect(n, `${s.id} 的标签「${s.label}」有 ${n} 字，超出 soon 行的预算（契约 ≤4）`).toBeLessThanOrEqual(4);
    }
    expect(CHIP, 'soon 项没有「设计中」chip（D 组的宽度账就没有对手了）').not.toBe('');
  });

  it('★ soon 行宽度账现算：标签 + 图标 + chip + 两道 gap 必须装进展开态轨宽', () => {
    const { budget, need, widest, gapSoon } = soonRow();
    expect(
      need(widest),
      `${widest} 字 soon 标签要 ${need(widest).toFixed(1)}px，但 soon 行只剩 ${budget(gapSoon).toFixed(1)}px：` +
        `「${SOON.find((s) => [...s.label].length === widest)?.label}」会被 .railLabel 的 ellipsis 截掉`,
    ).toBeLessThanOrEqual(budget(gapSoon));
  });

  it('★ 负对照：把 mode 行的 gap 用在 soon 行上就是截断本身（证明 .railSoon 那条 gap 是承重的）', () => {
    const { budget, need, widest, gapSoon, gapMode } = soonRow();
    expect(gapSoon, 'soon 行与 mode 行的 gap 一样，那 soon 的补偿没写进去').not.toBe(gapMode);
    expect(
      need(widest) > budget(gapMode),
      `用 mode 行的 gap(${gapMode}) 算，soon 行预算 ${budget(gapMode).toFixed(1)}px 仍装得下 ${widest} 字标签` +
        `（${need(widest).toFixed(1)}px）——那 R40 报的截断就不成立了，这条负对照该改写`,
    ).toBe(true);
    expect(budget(gapSoon)).toBeGreaterThan(budget(gapMode));
  });

  it('R41：global.css 把 --mz-text-placeholder 接到了 ::placeholder 上（令牌不再是死档）', () => {
    const g = strip(readCss('styles/global.css'));
    const rule = allRules(g).find((r) => /::placeholder/.test(r.header));
    expect(rule, 'global.css 没有 ::placeholder 规则：占位符颜色还落在浏览器默认灰上').toBeDefined();
    expect(rule?.body).toMatch(/color:\s*var\(--mz-text-placeholder\)/);
    for (const [name, decl] of SKINS) {
      expect(decl.get('--mz-text-placeholder'), `${name} 皮肤缺 --mz-text-placeholder`).toBeTruthy();
      expect(decl.get('--mz-text-placeholder')).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('minor②：ink 的 --mz-wash-ai 引用朱砂淡晕档，不再抄一遍同值 hex（PlanView 仍指 var）', () => {
    // 终审措辞指的是「同值两处书写」：PlanView.module.css:31 本来就写的是 var(--mz-wash-ai)，
    // 真正重复的是 tokens.css 的 ink 块把 --mz-brand-seal-soft 的值又手抄了一遍 #2A1512。
    // paper 侧不在此列（那里的 wash-ai 是 rgba 淡染，与 brand-seal-soft 的 #F9EDEA 不同值），
    // 所以这里只钉 ink 那一行——值不变，写法与 :root 的 --mz-editor-font-novel 同例。
    expect(ink.get('--mz-wash-ai'), 'ink 的 wash-ai 又变回抄出来的 hex 字面量了').toBe(
      'var(--mz-brand-seal-soft)',
    );
    expect(ink.get('--mz-brand-seal-soft')).toMatch(/^#[0-9a-fA-F]{6}$/);
    const plan = strip(readCss('components/views/PlanView.module.css'));
    expect(ruleBody(plan, '.bookg'), '.bookg 的渐变起点不是令牌').toMatch(
      /linear-gradient\([^)]*var\(--mz-wash-ai\)/,
    );
  });
});
