/**
 * §UI ·P2-UI T3（墨韵国风换肤）三组组件层断言：
 *
 *  A. 章节树四色状态点 —— STATUS_MARK 的 ○◐◑● 字形换成四色圆点
 *     （done=sem-pass-fg / revised=sem-warn-fg / draft=text-quaternary /
 *     todo=空心）；颜色语义由 title 的文字兜底（读屏不猜颜色）。
 *     todo 那圈的档位由 T3 的 border-subtle 升到 T4 的 border-strong
 *     （真机截图裁决，见 p2ui-t4-smoke-fixes B 组），本文件只钉「空心」这一形状。
 *     红点（穿帮=health 命中章）留 Phase 2，不在此钉。
 *  B. R35-②b 并批 —— 「accent 当正文级字用」的五处（T1 评审点名）改走
 *     --mz-text-link。断言两层：类名级（color 取值必须是 text-link）与
 *     比值级（WCAG 2.1 现场算，两套皮肤都 >= 4.5:1，公式与 theme-ink B 组同源）。
 *     修复前实测（paper 档）：accent #8C6D3A 压 accent-soft #F3EAD9 = 4.03:1、
 *     压 bg-selected 一类淡面 ≈3.97:1——金色当小字在浅色皮肤不过 AA。
 *  C. GenView 导演台化 —— 卡片头衬线（chrome-title 令牌）、主 CTA 金底深字
 *     （accent + accent-ink 令牌）、canon 卡金调描边（border-accent 令牌）。全令牌零裸色。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 剥注释：仓库说明书里满是「这里曾经是 ○◐◑● / 18px」，不剥就是拿文档判红（§5 的坑） */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const treeTsx = read('../../src/renderer/components/chapter-tree/ChapterTree.tsx');
const treeCss = read('../../src/renderer/components/chapter-tree/ChapterTree.module.css');
const dashCss = read('../../src/renderer/components/views/DashboardView.module.css');
const genCss = read('../../src/renderer/components/views/GenView.module.css');
const genTsx = read('../../src/renderer/components/views/GenView.tsx');
const loreCss = read('../../src/renderer/components/views/LoreView.module.css');
const reviewCss = read('../../src/renderer/components/views/ReviewView.module.css');
const tokensCss = read('../../src/renderer/styles/tokens.css');

/** 取行首选择器第一条规则的花括号体（同 editor-prose-layout 的计数式读法） */
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

// ── WCAG 2.1 现算（与 theme-ink B 组同源公式，不抄任何结论） ──────────────

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

describe('A. 章节树四色状态点', () => {
  it('字形标记 STATUS_MARK 退场（tsx 里不许再藏 ○◐◑●）', () => {
    expect(treeTsx).not.toMatch(/STATUS_MARK/);
    expect(strip(treeTsx)).not.toMatch(/[○◐◑●]/);
  });

  it('四色 class 都在 tsx 被引用（styles.dotX 点取值）', () => {
    for (const cls of ['dotDone', 'dotRevised', 'dotDraft', 'dotTodo']) {
      expect(treeTsx, `ChapterTree.tsx 没引用 styles.${cls}`).toMatch(
        new RegExp(`styles\\.${cls}\\b`),
      );
    }
  });

  it('四色 class 在同名 module.css 都有非空规则（css-module-classes A 组的前置）', () => {
    for (const cls of ['dotDone', 'dotRevised', 'dotDraft', 'dotTodo']) {
      const body = ruleBody(treeCss, `.${cls}`);
      expect(body, `ChapterTree.module.css 缺 .${cls} 规则`).not.toBe('');
      expect(body.trim().length, `.${cls} 是空花括号`).toBeGreaterThan(0);
    }
  });

  it('四色各归各的令牌：done=pass 绿 / revised=warn 黄 / draft=quaternary 灰 / todo=空心', () => {
    expect(ruleBody(treeCss, '.dotDone')).toMatch(/background:\s*var\(--mz-sem-pass-fg\)/);
    expect(ruleBody(treeCss, '.dotRevised')).toMatch(/background:\s*var\(--mz-sem-warn-fg\)/);
    expect(ruleBody(treeCss, '.dotDraft')).toMatch(/background:\s*var\(--mz-text-quaternary\)/);
    const todo = ruleBody(treeCss, '.dotTodo');
    expect(todo, 'todo 必须是空心（透明底 + 描边），不是第四种实色').toMatch(
      /background:\s*transparent/,
    );
    // 档位本身（border-strong）由 p2ui-t4-smoke-fixes B 组钉；这里只钉「有描边」。
    expect(todo).toMatch(/border:[^;]*var\(--mz-border-strong\)/);
  });

  it('圆点本体是圆点：基座规则走 radius-full，不许长回 10px 字形框', () => {
    const base = ruleBody(treeCss, '.statusDot');
    expect(base, '缺 .statusDot 基座规则').not.toBe('');
    expect(base).toMatch(/border-radius:\s*var\(--mz-radius-full\)/);
  });

  it('title 保留语义文字（颜色之外必须有字，读屏与色觉障碍都不靠猜）', () => {
    expect(treeTsx, '没有状态文字表').toMatch(/STATUS_LABEL/);
    for (const word of ['大纲', '草稿', '待审', '已发布']) {
      expect(treeTsx, `title 里缺状态词「${word}」`).toContain(word);
    }
  });
});

describe('B. R35-②b：正文级金字一律走 --mz-text-link', () => {
  const SITES: Array<[string, string, string]> = [
    ['章节树拖卷落点字色', treeCss, '.volume.volumeOver > .volumeTitle'],
    ['仪表盘成本字', dashCss, '.cost'],
    ['导演台草稿类型徽标', genCss, '.kind'],
    ['设定卡人物徽标', loreCss, '.av'],
    ['审稿命中标签', reviewCss, '.tag'],
  ];

  for (const [label, css, sel] of SITES) {
    it(`${label}：color 不许再指 --mz-accent，必须指 --mz-text-link`, () => {
      const body = ruleBody(css, sel);
      expect(body, `找不到 ${sel} 规则`).not.toBe('');
      expect(
        /(^|[^-])color:\s*var\(--mz-accent\)/.test(body),
        `${sel} 还在拿 accent 当正文级字用（T1 评审点名处）`,
      ).toBe(false);
      expect(body, `${sel} 的 color 没走 text-link`).toMatch(/color:\s*var\(--mz-text-link\)/);
    });
  }

  /**
   * 比值级：五处的实际压面各不同（surface / elevated / accent-soft），
   * 两套皮肤逐一现算。改前 paper 侧 accent/accent-soft 只有 4.03:1。
   */
  const RATIOS: Array<[string, string]> = [
    ['link on surface（章节树落点字）', '--mz-bg-surface'],
    ['link on elevated（仪表盘/审稿小字）', '--mz-bg-elevated'],
    ['link on accent-soft（导演台/设定徽标）', '--mz-accent-soft'],
  ];
  for (const [label, bgName] of RATIOS) {
    it(`★ ${label}：paper 与 ink 现算都 >= 4.5:1`, () => {
      for (const [skinName, decl] of [
        ['paper', paper],
        ['ink', ink],
      ] as const) {
        const r = contrast(decl.get('--mz-text-link') ?? '', decl.get(bgName) ?? '');
        expect(r, `${skinName}: --mz-text-link=${decl.get('--mz-text-link')} on ${bgName} 解不出色值`).not.toBeNull();
        const ratio = Math.round((r ?? 0) * 100) / 100;
        expect(ratio, `${skinName}: text-link on ${bgName} 只有 ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe('C. GenView 导演台化（全令牌）', () => {
  it('卡片头衬线：.cardHead 的 family 走 chrome-title 令牌', () => {
    expect(ruleBody(genCss, '.cardHead'), '.cardHead 没有衬线字族').toMatch(
      /font-family:\s*var\(--mz-chrome-font-title\)/,
    );
  });

  it('主 CTA 金底深字：实底取 accent、字色取 accent-ink（暗面即墨字）', () => {
    const btn = ruleBody(genCss, '.btnPrimary');
    expect(btn).toMatch(/background:\s*var\(--mz-accent\)/);
    expect(btn).toMatch(/color:\s*var\(--mz-accent-ink\)/);
  });

  it('canon 卡金调描边：.canonCard 挂上且走 border-accent 令牌，tsx 的 iron 律卡真引用了它', () => {
    const card = ruleBody(genCss, '.canonCard');
    expect(card, 'GenView.module.css 缺 .canonCard 金调描边规则').not.toBe('');
    expect(card).toMatch(/var\(--mz-border-accent\)/);
    expect(genTsx, '铁律卡没挂 styles.canonCard').toMatch(/styles\.card\} \$\{styles\.canonCard\}/);
  });

  it('组件 CSS 零裸色不破（同 theme-ink C 组口径，防这三处顺手硬写）', () => {
    expect(strip(genCss)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(strip(genCss)).not.toMatch(/\brgba?\(/);
  });
});
