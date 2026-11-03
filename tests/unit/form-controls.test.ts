/**
 * §UI ②：表单控件的三态，以及"皮肤管不到的原生像素"。
 *
 * ★ 五条实测到的修复前事实（2026-10-10，深寂皮肤，真机截图 + 源码点数）：
 *   1. **下拉展开后，选中项是一整条系统蓝**（约 #2A6FDB）——它是全应用唯一一处蓝，
 *      不来自任何 token，深寂的暖朱配色到这里断了一截。根子：全仓 `grep -rn color-scheme
 *      src/renderer` **零命中**，弹出层按浅色系统主题画；而 `option:checked` 一条规则都没有。
 *   2. **聚焦输入框出现两圈**：`global.css:58` 的 `:focus-visible { outline: 2px 朱砂 }`
 *      与 `global.css:87` 的 `input:focus { border-color: var(--mz-accent) }` 叠在一起，
 *      两圈同色、中间隔 2px，读起来像描边糊了。
 *   3. **`select` 没有基础态**：`global.css:71-78` 那条只给它 `font/color: inherit`，
 *      带 background 的那条（:80-86）选择器只有 `input, textarea`。今天两个 select
 *      各自带了类（`ReviewView .select`、`SettingsModal .input`）才没露馅——
 *      第三个 select 一进来就是 OS 白底。这是"写了没人调"的另一半：**没人写**。
 *   4. **字段没有 :hover 态**（按钮有：`button:hover:not(:disabled)`）。
 *   5. **字段有禁用态、但没有禁用样式**：`ChapterTree.tsx:156` 的新章标题框
 *      `disabled={creating}`、`PlanView.tsx:113` 的新卷名框 `disabled={saving}`——
 *      `global.css` 只写了 `button:disabled`，所以框子被禁用时**外观一点不变**，
 *      用户只觉得"打字没反应"。（这条是 F 组自己抓出来的：我原先按"22 处 disabled
 *      全在按钮上"下的结论，只看 `disabled=` 那一行，宿主标签在三行之外。）
 *   6. 顺带抓到一条我自己上一轮写进去的错文案：`SettingsModal.tsx:147`「当场生效」——
 *      中文里没有这个词，应是「立即生效」。
 *
 * ★ 一条刻意**不做**的事：不给 `select` 写 `appearance: none` + 自绘箭头。
 *   截图里原生箭头在深寂下是清晰可读的，关掉它就得自己画一个（多一条 data-URI 背景图），
 *   收益看不出来。B 组因此是一条**反向**钉：谁哪天把 `appearance: none` 加上而没画箭头，
 *   下拉框就变成一个看不出能点的文本框——那条测试会红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const rendererRoot = dirname(fileURLToPath(new URL('../../src/renderer/App.tsx', import.meta.url)));

const walk = (dir: string, base: string, re: RegExp): Array<{ rel: string; src: string }> => {
  const out: Array<{ rel: string; src: string }> = [];
  for (const n of readdirSync(dir)) {
    const full = join(dir, n);
    const rel = base ? `${base}/${n}` : n;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel, re));
    else if (re.test(n)) out.push({ rel, src: readFileSync(full, 'utf8').replace(/\r\n/g, '\n') });
  }
  return out;
};

const cssFiles = (): Array<{ rel: string; src: string }> => walk(rendererRoot, '', /\.css$/);
const tsxFiles = (): Array<{ rel: string; src: string }> => walk(rendererRoot, '', /\.tsx$/);

/** 剥掉注释：断言只许看代码，不许命中我写的说明（本会话栽过三次的那颗坑） */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * 取某选择器**第一条**规则的花括号体。行首锚定 + 计数配对，
 * 不假设块内无嵌套（`@media` 里的内层规则因此也能被单独取到）。
 */
function ruleBody(css: string, selector: string): string | null {
  const bare = selector.replace(/\s*\{$/, '').trim();
  const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}\\s*\\{`, 'm').exec(css);
  if (m === null) return null;
  const open = css.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * 所有"选择器列表里含 tag"的规则体（用于反向检查：某属性不许出现在这些规则里）。
 * ★ 选择器组**不带** `(^|})` 前缀：`[^{}]+` 本身就越不过 `}`，加了前缀反而每条
 *   匹配都把上一条规则的收尾 `}` 吃掉，于是**隔一条漏一条**（第一版就是这么漏掉了
 *   正要断言的那条字段基础规则，红得莫名其妙）。
 */
function rules(css: string): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.push({ sel: m[1], body: m[2] });
  return out;
}

function bodiesFor(css: string, tag: RegExp): string[] {
  return rules(css)
    .filter((r) => tag.test(r.sel))
    .map((r) => r.body);
}

const globalCss = strip(read('../../src/renderer/styles/global.css'));
const tokensCss = strip(read('../../src/renderer/styles/tokens.css'));

describe('A. 皮肤必须告诉操作系统自己是明是暗', () => {
  it(':root 声明 color-scheme: light', () => {
    const body = ruleBody(tokensCss, ':root');
    expect(body, 'tokens.css 没有 :root 块').not.toBeNull();
    expect(body as string, ':root 没有 color-scheme——原生弹出层/滚动条会按浅色画').toMatch(
      /color-scheme:\s*light/,
    );
  });

  it('[data-theme="ink"] 声明 color-scheme: dark', () => {
    const body = ruleBody(tokensCss, '[data-theme="ink"]');
    expect(body, 'tokens.css 没有深寂块').not.toBeNull();
    expect(body as string).toMatch(/color-scheme:\s*dark/);
  });

  it('全仓 color-scheme 恰好两处（同一件事不许有第三个来源）', () => {
    const sites = cssFiles()
      .map((f) => ({ rel: f.rel, n: (strip(f.src).match(/color-scheme/g) ?? []).length }))
      .filter((f) => f.n > 0);
    const total = sites.reduce((a, b) => a + b.n, 0);
    expect(total, `color-scheme 散在 ${JSON.stringify(sites)}`).toBe(2);
  });
});

describe('B. select 必须有基础态，不许指望每个组件自带类', () => {
  it('一条同时覆盖 input / textarea / select 的规则给了底色与描边', () => {
    const hit = rules(globalCss).find(
      (r) =>
        /\binput\b/.test(r.sel) &&
        /\btextarea\b/.test(r.sel) &&
        /\bselect\b/.test(r.sel) &&
        /background:/.test(r.body) &&
        /border:/.test(r.body),
    );
    expect(hit, 'global.css 里没有一条给 select 底色+描边的字段基础规则').not.toBeUndefined();
  });

  it('select 不许被 appearance: none 掏空（要掏就得自绘箭头，而这里选择保留原生箭头）', () => {
    const bad = bodiesFor(globalCss, /\bselect\b/).filter((b) => /appearance:\s*none/.test(b));
    expect(bad, '原生箭头被关掉却没有自绘箭头').toEqual([]);
  });
});

describe('C. 展开的下拉里，选中项必须走皮肤', () => {
  it('存在 option:checked 且底色取自 --mz-accent-soft', () => {
    const body = ruleBody(globalCss, 'option:checked');
    expect(body, '没有 option:checked——选中项由操作系统画成系统蓝').not.toBeNull();
    expect(body as string).toMatch(/background:\s*var\(--mz-accent-soft\)/);
  });

  it('option 相关规则里不许出现裸 hex（配色只能来自 token）', () => {
    const hexy = bodiesFor(globalCss, /\boption\b/).filter((b) => /#[0-9a-fA-F]{3,8}/.test(b));
    expect(hexy, `option 规则里写死了颜色：${JSON.stringify(hexy)}`).toEqual([]);
  });

  it('--mz-accent-soft 在两个皮肤里都有定义', () => {
    const root = ruleBody(tokensCss, ':root') as string;
    const ink = ruleBody(tokensCss, '[data-theme="ink"]') as string;
    expect(root).toMatch(/--mz-accent-soft:/);
    expect(ink).toMatch(/--mz-accent-soft:/);
  });
});

describe('D. 焦点只许有一圈', () => {
  it('字段的 :focus 规则不许再改 border-color（与全局 outline 叠成两圈）', () => {
    const offenders = bodiesFor(globalCss, /:(?:focus|focus-visible)\b/)
      .filter((b) => /\bborder-color:/.test(b))
      .map((b) => b.trim());
    expect(offenders, `焦点态又改了一次描边：${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('全局 :focus-visible 的 outline 必须还在（一圈可以少，零圈不行）', () => {
    const body = ruleBody(globalCss, ':focus-visible');
    expect(body, '全局焦点环被删了').not.toBeNull();
    expect(body as string).toMatch(/outline:\s*var\(--mz-focus-width\)\s+solid\s+var\(--mz-focus-color\)/);
  });
});

describe('E. 悬停态：字段和按钮一样要有反馈', () => {
  it('input / textarea / select 有 :hover 且描边取自 --mz-border-strong', () => {
    const hover = rules(globalCss).filter((r) => /:hover/.test(r.sel));
    expect(hover.length, 'global.css 里一条 hover 规则都没有').toBeGreaterThan(0);
    const sel = hover.map((r) => r.sel).join('\n');
    for (const tag of ['input', 'textarea', 'select']) {
      expect(sel, `字段 hover 规则漏了 ${tag}`).toContain(`${tag}:hover`);
    }
    const strong = hover.filter((r) => /border-color:\s*var\(--mz-border-strong\)/.test(r.body));
    expect(strong.length, '字段 hover 没有描边反馈（或用的不是 --mz-border-strong）').toBeGreaterThan(0);
  });

  it('--mz-border-strong 在两个皮肤里都有定义', () => {
    expect(ruleBody(tokensCss, ':root') as string).toMatch(/--mz-border-strong:/);
    expect(ruleBody(tokensCss, '[data-theme="ink"]') as string).toMatch(/--mz-border-strong:/);
  });
});

describe('F. 禁用态：能被禁用的标签，必须有长得不一样的禁用态', () => {
  /**
   * ★ 台账（棘轮，不是一次性断言）：全渲染层 `disabled=` 实际落在哪些标签上。
   * 第一版我按"22 处全是按钮"写，**被这条测试自己纠正了**——它只看到 `disabled=` 那一行，
   * 而宿主标签在三行之外：`ChapterTree.tsx:156` 的新章标题框 `disabled={creating}` 与
   * `PlanView.tsx:113` 的新卷名框 `disabled={saving}` 都是 **input**。
   * 于是这里要的不是"字段没有禁用态所以不管"，而是：
   *   ① 集合必须逐字相等——多一个标签就红（提醒补样式），少一个也红（提醒删条目）；
   *   ② 台账里每个非 button 的标签，global.css 必须真有一条覆盖它的 `:disabled` 规则。
   *
   * ★ P1-B T4：GenView 立项卡的「平台」从自由文本 input 换成 PLATFORM_RULES 分组
   *   select（国内/海外 optgroup），select 同样带 `disabled={busy.params}`——于是
   *   宿主集合多了 `select`。样式侧 global.css:95-97 的 `select:disabled`
   *   （color+background+cursor）早已就位（B 组要求 select 有基础态时一并写的），
   *   这里把台账补齐即可满足 ①②，非"加标签不补样式"的欠账。
   */
  const DISABLED_HOSTS = ['button', 'input', 'select'];

  const hostsFound = (): string[] => {
    const found = new Set<string>();
    for (const f of tsxFiles()) {
      const src = strip(f.src);
      const re = /\bdisabled\s*=/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        // 宿主＝离 `disabled=` 最近的那个开标签（JSX 里属性一定写在它之后）
        const opens = [...src.slice(0, m.index).matchAll(/<([a-zA-Z][\w.]*)/g)];
        const last = opens[opens.length - 1];
        found.add(last ? last[1] : '?');
      }
    }
    return [...found].sort();
  };

  it('disabled= 的宿主标签集合与台账逐字相等', () => {
    expect(hostsFound()).toEqual([...DISABLED_HOSTS].sort());
  });

  it('台账里每个非按钮标签，global.css 都有覆盖它的 :disabled 规则', () => {
    for (const tag of DISABLED_HOSTS.filter((t) => t !== 'button')) {
      const bodies = rules(globalCss)
        .filter((r) => new RegExp(`\\b${tag}\\b[^{}]*:disabled`).test(r.sel))
        .map((r) => r.body.trim());
      expect(bodies.length, `<${tag}> 会被禁用，但 global.css 没有它的 :disabled 规则`).toBeGreaterThan(0);
      expect(
        bodies.some((b) => /(^|[; ])(color|background|opacity):/.test(b)),
        `<${tag}>:disabled 存在但没有任何视觉差别`,
      ).toBe(true);
    }
  });
});

describe('G. 面向用户的文案', () => {
  it('「当场」这个不存在的词不许出现在渲染层代码里（注释除外）', () => {
    const hits = tsxFiles()
      .map((f) => ({ rel: f.rel, n: (strip(f.src).match(/当场/g) ?? []).length }))
      .filter((f) => f.n > 0);
    expect(hits, `用户会看到的错别字：${JSON.stringify(hits)}`).toEqual([]);
  });

  it('皮肤提示语必须说清"立即生效 + 重启后仍在"', () => {
    const modal = strip(read('../../src/renderer/components/settings/SettingsModal.tsx'));
    expect(modal).toMatch(/立即生效/);
    expect(modal).toMatch(/重启后/);
  });
});
