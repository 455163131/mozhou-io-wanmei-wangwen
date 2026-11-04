/**
 * §UI ① 深寂（ink）皮肤 —— 令牌成对 + 零裸色 + 装配真的接上。
 *
 * ★ 为什么这条要写成门禁而不是"改完看一眼"：
 *   本项目最擅长的一类失效是**静默**——第 22 条②实测过「CSS 取不到自定义属性时也不报错」，
 *   所以一个只写了 `:root` 浅色、又新增了一批 `[data-theme="ink"]` 覆盖的改动，
 *   **漏掉任何一个变量都不会报错**，只会在暗色下变成白字白底 / 浅字浅底。
 *   于是这里断三件事：① 成对（浅色块里每个颜色令牌，暗色块必须有同名声明）；
 *   ② 可算（正文/次级文字对所在面的 WCAG 对比度 >= 4.5:1，公式在测试里现算，不抄结论）；
 *   ③ 接得上（`data-theme` 真的被写到 documentElement 上，切换真的持久化——
 *      纯令牌块 + 没人设置它 = 又一个空壳，那正是本仓库第 24/25/26/27 条反复挖出来的形状）。
 *
 * ★ 一处刻意的偏离：渲染稿（wink-mock.html）用的是 `--bg:#0a0e18`，
 *   比纯黑好，但它没有 `--mz-bg-editor` 这一层概念。暗色下**纸面必须比桌面亮一档**
 *   （长读时视线焦点要在稿纸上），所以 ink 块自己给分层，A 组第三条钉住"不许纯黑"。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  applyTheme,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  normalizeTheme,
  readTheme,
  writeTheme,
  type Theme,
} from '@renderer/lib/theme';
import { useSettingsStore } from '@renderer/store';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const rendererRoot = dirname(fileURLToPath(new URL('../../src/renderer/App.tsx', import.meta.url)));

// ── tokens.css 分块解析（花括号计数，不假设块内无嵌套）──

function extractBlock(src: string, selector: string): string | null {
  const at = src.indexOf(selector);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * 声明名 → 值。
 * ★ 必须**按分号切**而不是按行切：tokens.css 的字号/行高是两三个声明挤在一行的
 *   （`--mz-fs-body: 15px; --mz-lh-body: 1.60;`），按行取会只吃到第一个，
 *   于是把定义得好好的令牌误报成"幽灵令牌"——第一版就栽在这里。
 */
function decls(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const seg of code.split(';')) {
    const m = seg.match(/\s*(--[\w-]+)\s*:\s*([\s\S]+)/);
    if (!m) continue;
    const value = m[2].replace(/\/\/.*$/, '').trim();
    if (value.length > 0) out.set(m[1], value);
  }
  return out;
}

const isColorValue = (v: string): boolean => /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(v);

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG 2.1 相对亮度与对比度——公式在测试里现算，不抄任何人的结论 */
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

const tokens = read('../../src/renderer/styles/tokens.css');
const lightBlock = extractBlock(tokens, ':root');
const inkBlock = extractBlock(tokens, '[data-theme="ink"]');

describe('A. 令牌成对：暗色漏一个定义就是白字白底，而它不会报错', () => {
  it('tokens.css 必须同时有 :root 与 [data-theme="ink"] 两个块', () => {
    expect(lightBlock, ':root 块不见了').not.toBeNull();
    expect(inkBlock, '暗色块还没写').not.toBeNull();
  });

  it('浅色块里每一个颜色令牌，暗色块必须有同名声明', () => {
    expect(inkBlock).not.toBeNull();
    const light = decls(lightBlock ?? '');
    const ink = decls(inkBlock ?? '');
    const missing: string[] = [];
    for (const [name, value] of light) {
      if (!isColorValue(value)) continue;
      if (!ink.has(name)) missing.push(name);
    }
    expect(missing, `暗色块漏了 ${missing.length} 个颜色令牌：${missing.join(', ')}`).toEqual([]);
  });

  it('阴影类令牌也要成对（浅色那套投影压在暗面上等于没有）', () => {
    const light = decls(lightBlock ?? '');
    const ink = decls(inkBlock ?? '');
    const shadowNames = [...light.keys()].filter((n) => n.startsWith('--mz-shadow-'));
    expect(shadowNames.length, '浅色块里一个阴影令牌都没有？那这条断言是空的').toBeGreaterThan(0);
    for (const n of shadowNames) expect(ink.has(n), `暗色块漏了 ${n}`).toBe(true);
  });

  it('暗色不许用纯黑当底（长读眩光），也不许拿浅色的近白当底', () => {
    const ink = decls(inkBlock ?? '');
    for (const [n, v] of ink) {
      if (!n.startsWith('--mz-bg-')) continue;
      const rgb = hexToRgb(v);
      if (!rgb) continue;
      expect(rgb, `${n}=${v} 解不出色值（暗色块里只允许 hex 底面）`).not.toBeNull();
      const rgbv = rgb as [number, number, number];
      expect(rgbv.every((c) => c === 0), `${n} 是纯黑 ${v}`).toBe(false);
      const lum = 0.2126 * rgbv[0] + 0.7152 * rgbv[1] + 0.0722 * rgbv[2];
      expect(lum < 120, `${n}=${v} 在暗色皮肤里亮得不成底面（亮度加权和 ${lum.toFixed(1)}）`).toBe(true);
    }
  });
});

describe('B. 暗色下的可读性要算得出来，不是"看着还行"', () => {
  /**
   * P2-UI 墨韵国风（v3）重定五对（brief Step 2）：primary/canvas、tertiary/canvas、
   * quaternary、link/canvas、inverse/accent。★ 一处对 brief 的算术纠偏：
   * brief 写的 quaternary/surface 按 WCAG 现算是 4.44:1（#7A849C on #161E30），
   * 不过 4.5 的线——四级字在暗面只许压在桌面底/凹陷井上（4.82:1），
   * 所以配对待桌面底核验，tokens.css 的 ink 注释里同步写明了这一约束。
   */
  const pairs: Array<[string, string, string, number]> = [
    ['--mz-text-primary', '--mz-bg-canvas', '宣白主字 on 墨蓝桌面底', 4.5],
    ['--mz-text-tertiary', '--mz-bg-canvas', '弱化字 on 桌面底', 4.5],
    ['--mz-text-quaternary', '--mz-bg-canvas', '四级字 on 桌面底', 4.5],
    ['--mz-text-link', '--mz-bg-canvas', '链接字（香槟金）on 桌面底', 4.5],
    ['--mz-text-inverse', '--mz-accent', '浓墨字 on 香槟金主 CTA', 4.5],
  ];
  for (const [fgName, bgName, label, min] of pairs) {
    it(`${label} 在暗色下 >= ${min}:1`, () => {
      const ink = decls(inkBlock ?? '');
      const r = contrast(ink.get(fgName) ?? '', ink.get(bgName) ?? '');
      expect(r, `${fgName}=${ink.get(fgName)} on ${bgName}=${ink.get(bgName)} 解不出色值`).not.toBeNull();
      const ratio = Math.round((r ?? 0) * 100) / 100;
      expect(ratio, `${fgName}=${ink.get(fgName)} on ${bgName}=${ink.get(bgName)} 只有 ${ratio}:1`).toBeGreaterThanOrEqual(min);
    });
  }

  it('暗色的稿纸必须比桌面底亮一档（焦点要在稿纸上，不在框上）', () => {
    const ink = decls(inkBlock ?? '');
    const lum = (hex: string): number => {
      const rgb = hexToRgb(hex);
      return rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : -1;
    };
    expect(lum(ink.get('--mz-bg-editor') ?? '')).toBeGreaterThan(lum(ink.get('--mz-bg-canvas') ?? ''));
  });

  it('主进程的预绘底色必须等于暗色的 --mz-bg-canvas（跨边界复制，最容易漂）', () => {
    const ink = decls(inkBlock ?? '');
    const win = read('../../src/main/window.ts');
    const m = win.match(/backgroundColor:\s*['"](#([\da-fA-F]{6}))['"]/);
    expect(m, 'window.ts 里的 backgroundColor 不见了').not.toBeNull();
    expect(
      m![1].toUpperCase(),
      `预绘 ${m![1]} ≠ 暗色 canvas ${ink.get('--mz-bg-canvas')}：启动会先闪一层别的颜色`,
    ).toBe((ink.get('--mz-bg-canvas') ?? '').toUpperCase());
  });
});

describe('C. 零裸色值：一旦组件里能硬写颜色，双皮肤就永远补不齐', () => {
  const cssFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.css') && !full.endsWith('tokens.css')) cssFiles.push(full);
    }
  };
  walk(rendererRoot);

  it('组件 CSS 里不许出现裸 hex / rgba（一律走令牌）', () => {
    const bad: string[] = [];
    for (const f of cssFiles) {
      const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
      src.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
        const m = code.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
        if (m) bad.push(`${f.replace(rendererRoot, 'src/renderer')}:${i + 1} ${m[0]}`);
      });
    }
    expect(bad, `裸色值 ${bad.length} 处：\n${bad.join('\n')}`).toEqual([]);
  });

  it('被引用的每个 --mz-* 都必须在 :root 里有定义（幽灵令牌）', () => {
    const light = decls(lightBlock ?? '');
    const missing = new Set<string>();
    for (const f of cssFiles.concat([join(rendererRoot, 'index.html')])) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/var\((--mz-[\w-]+)/g)) {
        if (!light.has(m[1])) missing.add(m[1]);
      }
    }
    expect([...missing], '引用了不存在的令牌').toEqual([]);
  });
});

describe('D. 装配：令牌块没人设置就是又一个空壳', () => {
  it('默认皮肤是深寂', () => {
    expect<Theme>(DEFAULT_THEME).toBe('ink');
  });

  it('normalizeTheme 只认 ink/paper，其余一律回落默认', () => {
    expect(normalizeTheme('ink')).toBe('ink');
    expect(normalizeTheme('paper')).toBe('paper');
    expect(normalizeTheme('INK')).toBe('ink');
    expect(normalizeTheme('  paper ')).toBe('paper');
    for (const junk of [null, undefined, '', 'dark', 'system', 'light', 0, {}, 'paperx']) {
      expect(normalizeTheme(junk), `垃圾值 ${String(junk)} 必须回落默认`).toBe('ink');
    }
  });

  it('readTheme 走注入的 storage，坏值与空存储都不抛', () => {
    expect(readTheme({ getItem: () => null })).toBe('ink');
    expect(readTheme({ getItem: () => 'paper' })).toBe('paper');
    expect(readTheme({ getItem: () => 'garbage' })).toBe('ink');
    expect(readTheme({ getItem: () => { throw new Error('quota'); } })).toBe('ink');
  });

  it('writeTheme 写的键必须就是 readTheme 读的键（存读不同键＝切换不生效）', () => {
    const bag = new Map<string, string>();
    const storage = {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => {
        bag.set(k, v);
      },
    };
    writeTheme(storage, 'paper');
    expect(bag.get(THEME_STORAGE_KEY)).toBe('paper');
    expect(readTheme(storage)).toBe('paper');
    writeTheme(storage, 'ink');
    expect(readTheme(storage)).toBe('ink');
  });

  it('applyTheme 真的把皮肤写到根元素的 dataset 上', () => {
    const target = { dataset: {} as Record<string, string | undefined> };
    applyTheme(target, 'ink');
    expect(target.dataset.theme).toBe('ink');
    applyTheme(target, 'paper');
    expect(target.dataset.theme, '切换后属性没跟着变＝切了个寂寞').toBe('paper');
    expect(() => applyTheme(null, 'ink')).not.toThrow();
  });

  it('lib/theme.ts 与 store 必须保持 DOM-free', () => {
    // ★ 这条不是洁癖：tsconfig.node.json 的 include 注释写明"只纳入 DOM-free 的渲染层逻辑：
    //   store 是纯状态机"，而 store 引 theme.ts。theme.ts 里一旦出现 document，
    //   node 与 web 两个工程各报一次 TS2584 —— 本轮第一版就是这么挂的。
    // ★ 必须先剥注释：这两个词在 theme.ts 的说明里就出现过，不剥就是拿说明书当代码判红
    //   （第 25 条那条「叫停不许借 ⏸」栽过同一个坑）。
    const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const themeLib = code(read('../../src/renderer/lib/theme.ts'));
    expect(themeLib, '碰浏览器的部分应放 lib/theme-dom.ts').not.toMatch(/\bdocument\b/);
    expect(themeLib).not.toMatch(/\blocalStorage\b/);
    const store = code(read('../../src/renderer/store/index.ts'));
    expect(store, 'store 里出现 DOM 就是越界').not.toMatch(/\bdocument\b|\blocalStorage\b/);
  });

  it('碰浏览器的那一手只有一个落点，且两个调用点都齐', () => {
    const dom = read('../../src/renderer/lib/theme-dom.ts');
    expect(dom).toMatch(/applyTheme\(document\.documentElement/);
    expect(dom).toMatch(/writeTheme\(localStorage/);
    // dataset 的写入点全仓唯一，否则两处写就会长出两套口径
    const writers = [
      '../../src/renderer/lib/theme.ts',
      '../../src/renderer/lib/theme-dom.ts',
      '../../src/renderer/main.tsx',
      '../../src/renderer/store/index.ts',
      '../../src/renderer/components/settings/SettingsModal.tsx',
    ]
      .map((rel) => (read(rel).match(/dataset\.theme/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(writers, 'dataset.theme 的写入点必须恰好一处（在 lib/theme.ts）').toBe(1);

    const main = read('../../src/renderer/main.tsx');
    expect(main).toMatch(/lib\/theme-dom/);
    expect(main).toMatch(/readTheme\(/);
    expect(main, '没人 commitTheme，暗色令牌块就是死码').toMatch(/commitTheme\(/);
    expect(main, '启动没同步进 store＝段控件显示成没选中的那个').toMatch(/setTheme\(/);

    const modal = read('../../src/renderer/components/settings/SettingsModal.tsx');
    expect(modal, '切换键不落 DOM＝点了没反应').toMatch(/commitTheme\(/);
    expect(modal, '切换键不改 store＝按钮停在原处').toMatch(/setTheme\(/);
  });

  it('store 的 theme 初值就是 DEFAULT_THEME，且 setTheme 真的改状态', () => {
    expect(useSettingsStore.getState().theme).toBe(DEFAULT_THEME);
    useSettingsStore.getState().setTheme('paper');
    expect(useSettingsStore.getState().theme).toBe('paper');
    useSettingsStore.getState().setTheme('ink');
    expect(useSettingsStore.getState().theme).toBe('ink');
  });
});
