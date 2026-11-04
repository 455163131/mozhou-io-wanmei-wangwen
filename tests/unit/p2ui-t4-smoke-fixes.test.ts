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
 *  C. §UI ·R37 hover 选中态特异性回补 —— global.css 的 `button:hover:not(:disabled)`
 *     特异性 (0,2,1) 压过组件侧裸 `.xx:hover` (0,2,0)，选中态（实底 accent + 反色字）
 *     hover 时底色被全局刷成 bg-hover、字色却仍是 text-inverse：ink 皮肤实测
 *     1.25:1 近不可读（真机评审发现）。钉三处（.railOn / .btnPrimary / .chipOn）
 *     的 hover 规则存在、选择器含 `:not(:disabled)`（或等效提特异性写法）、
 *     hover 态仍走 accent 实底组合，并按 WCAG 现算 hover 生效对 >= 4.5:1。
 *
 * 比值一律 WCAG 2.1 现场算（与 theme-ink B 组 / p2ui-t3-reskin B 组同式），不抄结论。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 剥注释：文档里满是「这里曾经是金色」，不剥就是拿历史叙述判红 */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const appCss = read('../../src/renderer/App.module.css');
const treeCss = read('../../src/renderer/components/chapter-tree/ChapterTree.module.css');
const expertCss = read('../../src/renderer/components/expert/ExpertPanel.module.css');
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

/** 收 css 里所有以 `base:hover…` 开头的规则（选择器头 + 花括号体），供 C 组逐条钉 */
function hoverRules(css: string, base: string): Array<{ header: string; body: string }> {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: Array<{ header: string; body: string }> = [];
  const re = new RegExp(`^[ \\t]*(${esc}:hover[^{\\n]*)\\{`, 'gm');
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

describe('C. §UI ·R37 hover 选中态特异性回补（全局 button:hover 不得洗掉实底 accent）', () => {
  const HOVER_PIN = [
    ['App.module.css', appCss, '.railOn'],
    ['ExpertPanel.module.css', expertCss, '.btnPrimary'],
    ['ExpertPanel.module.css', expertCss, '.chipOn'],
  ] as const;

  it('三处各有自己的 :hover 规则，且选择器头含 :not(:disabled)（压过 global.css (0,2,1)）', () => {
    for (const [label, css, sel] of HOVER_PIN) {
      const rules = hoverRules(strip(css), sel);
      expect(rules.length, `${label} 缺 ${sel}:hover 本规则——hover 底色只剩全局 button:hover`).toBeGreaterThan(0);
      for (const r of rules) {
        expect(
          r.header,
          `${label} 「${r.header}」是裸 :hover，特异性 (0,2,0) 被 global.css 的 button:hover:not(:disabled) (0,2,1) 压过：底色退回 bg-hover 而字色仍 text-inverse，ink 实测 1.25:1`,
        ).toContain(':not(:disabled)');
      }
    }
  });

  it('hover 态仍走自己的实底 accent 组合（bg=accent-hover / fg=text-inverse，不许退回 bg-hover）', () => {
    for (const [label, css, sel] of HOVER_PIN) {
      for (const r of hoverRules(strip(css), sel)) {
        expect(r.body, `${label} ${r.header} 底色不是 accent 族`).toMatch(
          /background:\s*var\(--mz-accent-hover\)/,
        );
        expect(r.body, `${label} ${r.header} 底色又退回全局的 bg-hover`).not.toMatch(
          /background:\s*var\(--mz-bg-hover\)/,
        );
        expect(r.body, `${label} ${r.header} 字色不再是 text-inverse`).toMatch(
          /color:\s*var\(--mz-text-inverse\)/,
        );
      }
    }
  });

  it('★ 修后 hover 实际生效组合现算 >= 4.5:1（WCAG 正文档，两套皮肤；修前 ink 走 bg-hover 实测 1.25:1）', () => {
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
      // 反向取证：bug 的成因对（text-inverse 压 bg-hover）确实不过线——钉住「赢的必须是 accent-hover 那对」。
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
});
