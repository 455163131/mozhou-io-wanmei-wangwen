/**
 * §4 第 28 条：正文排版的两条断线——**每一行都居中**，以及行长上限**没人引用**。
 *
 * ★ 实测到的修复前事实：
 *   1. `Editor.module.css` 的共用规则 `.stage > .area, .stage > .backdrop` 里写着
 *      `text-align: center`。textarea 与镜像层共用这一条，所以两层都居中——
 *      行内标注（第 7 条 / 第 20 条②）不会错位，但**稿子每一行都居中排**。
 *      占位符是原生 `textarea::placeholder`（Editor.tsx:262），它居中是从 `.area` 继承的；
 *      至于这条 `text-align: center` 当初为什么写——**没有证据，不猜**。
 *      只知道没有正文时看不出来（截图里只有一句居中的占位符）。
 *   2. `global.css:71` 定义了 `.mz-prose`，带 `max-width: var(--mz-editor-measure-novel)`
 *      （34em ≈ 34 个汉字）——**全仓没有任何 TSX 引用它**（`grep -rn mz-prose src/renderer
 *      --include=*.tsx` 零命中）。于是 textarea 是 `width: 100%`，1440 窗口下一行约 55 字，
 *      窗口再宽就继续变长。
 *   3. 顺带查出来的账面：`--mz-editor-*` 共 19 个令牌，**只有 4 个被引用**，
 *      其余 15 个（wechat/toutiao 两套皮肤的全部、三种体裁的 gap/indent、manuscript 缩进）
 *      一个调用方都没有。
 *
 * 为什么值得写成测试而不是改完看一眼：本项目反复出现的形状就是"实现写好了、没人调"
 * （`setStatus` 零调用方、`pausedRuns` 只写不读、`.mz-prose` 零引用是同一类）。
 * D 组把"死令牌"从**没人知道**变成**必须显式挂账**。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const rendererRoot = dirname(fileURLToPath(new URL('../../src/renderer/App.tsx', import.meta.url)));

/**
 * 取某个选择器第一条规则的花括号体（计数式，不假设块内无嵌套）。
 * ★ 必须**行首锚定**：`'.backdrop {'` 作为子串会先命中共用规则里的
 *   `.stage > .backdrop {`，第一版就把共用体当成 .backdrop 体，判出一条假红。
 */
function ruleBody(css: string, selector: string): string | null {
  const bare = selector.replace(/\s*\{$/, '').trim();
  const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}\\s*\\{`, 'm').exec(css);
  if (!m || m.index === undefined) return null;
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

const editorCss = read('../../src/renderer/components/editor/Editor.module.css');
const globalCss = read('../../src/renderer/styles/global.css');
const tokensCss = read('../../src/renderer/styles/tokens.css');
const editorTsx = read('../../src/renderer/components/editor/Editor.tsx');

/** textarea 与镜像层共用的那一条规则 */
const SHARED = '.stage > .area,';
const sharedBody = (): string | null => {
  const at = editorCss.indexOf(SHARED);
  if (at < 0) return null;
  const open = editorCss.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < editorCss.length; i++) {
    if (editorCss[i] === '{') depth++;
    else if (editorCss[i] === '}') {
      depth--;
      if (depth === 0) return editorCss.slice(open + 1, i);
    }
  }
  return null;
};

describe('A. 正文不许居中（占位符居中是另一件事，它有自己的规则）', () => {
  it('共用规则里不许出现 text-align: center', () => {
    const body = sharedBody();
    expect(body, '共用规则找不到了').not.toBeNull();
    expect(
      /text-align:\s*center/.test(body ?? ''),
      'textarea 与镜像层共用这一条，居中会同时命中两层——稿子每行都居中',
    ).toBe(false);
  });

  it('必须显式写 text-align: left（不靠默认值，默认值会被后来人改走）', () => {
    expect(sharedBody() ?? '').toMatch(/text-align:\s*left/);
  });

  it('text-align 只能出现在共用规则里，两层各写一份就会错位', () => {
    const inShared = (sharedBody() ?? '').match(/text-align/g)?.length ?? 0;
    expect(inShared, '共用规则里没有 text-align').toBe(1);
    for (const sel of ['.area {', '.backdrop {']) {
      const body = ruleBody(editorCss, sel) ?? '';
      expect(body, `${sel} 单独定了 text-align，两层会各排各的`).not.toMatch(/text-align/);
    }
  });
});

describe('B. 行长上限要真的落在稿纸列上，而且落在两层共同的父上', () => {
  it('.stage 必须有 max-width，且用的就是 measure 令牌', () => {
    const body = ruleBody(editorCss, '.stage {') ?? '';
    expect(body, '.stage 不见了').not.toBe('');
    expect(
      body.includes('var(--mz-editor-measure-novel)'),
      '行长上限没接上令牌：一行可以无限长',
    ).toBe(true);
  });

  it('.stage 必须水平居中（不居中的话上限右侧就是一大块空白）', () => {
    const body = ruleBody(editorCss, '.stage {') ?? '';
    expect(/margin-inline:\s*auto|margin:\s*0\s+auto/.test(body), '.stage 没有水平居中').toBe(true);
  });

  it('max-width 不许出现在 .area / .backdrop 上', () => {
    // syncLayer() 只把 textarea 的 clientWidth 抄给镜像层，**不同步 left 偏移**。
    // 上限若写在其中一层上，两层就会左右错开，行内标注整体偏掉。
    for (const sel of ['.area {', '.backdrop {', SHARED]) {
      const body = sel === SHARED ? (sharedBody() ?? '') : (ruleBody(editorCss, sel) ?? '');
      expect(body, `${sel} 上出现了 max-width，两层会错位`).not.toMatch(/max-width/);
    }
  });

  it('镜像层仍然只同步 width（新增上限后这条同步必须还在，否则标注会漂）', () => {
    expect(editorTsx).toMatch(/bd\.style\.width\s*=\s*`\$\{ta\.clientWidth\}px`/);
    expect(editorTsx).toMatch(/bd\.scrollTop\s*=\s*ta\.scrollTop/);
  });
});

describe('C. 排版取值', () => {
  it('正文不加正字距：Han 本是方格字，加 tracking 只会稀释笔画', () => {
    const wrap = ruleBody(editorCss, '.wrap {') ?? '';
    const m = wrap.match(/--ed-tracking:\s*([^;]+);/);
    expect(m, '--ed-tracking 不见了').not.toBeNull();
    const v = (m?.[1] ?? '').trim();
    expect(v === '0' || /^-/.test(v), `正文 tracking=${v}（正值会让汉字发虚）`).toBe(true);
  });

  it('稿纸常驻焦点环要压掉（写作区永远聚焦，红框等于给稿纸镶边）', () => {
    // global.css 的 `:focus-visible { outline: 2px solid var(--mz-focus-color) }` 是对的，
    // 但对 textarea 这种"进来就一直在焦点上"的元素，它变成一整圈红框。
    // 只压 .area 一层，其余控件的焦点环一律不动。
    // ★ 盯的是**焦点态**那条，不是 `.area { outline: none }`——后者一直都有，
    //   但 global.css 的 `:focus-visible` 同特异度且加载更晚，把稿纸镶了一圈红。
    const focusRule = ruleBody(editorCss, '.area:focus-visible') ?? ruleBody(editorCss, '.area:focus');
    expect(focusRule, '稿纸没有自己的焦点态规则，会被全局 :focus-visible 镶红框').not.toBeNull();
    expect(focusRule ?? '').toMatch(/outline:\s*(none|0)/);
    // 不许顺手把全局焦点样式删了——那是键盘用户的唯一导航线索
    expect(globalCss).toMatch(/:focus-visible\s*\{[^}]*outline/);
  });

  it('.mz-prose 这个全局类不许再定义编辑器排版（两处定义必漂移，且它本来就零引用）', () => {
    const refs = (() => {
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const n of readdirSync(d)) {
          const f = join(d, n);
          if (statSync(f).isDirectory()) walk(f);
          else if (/\.(tsx|ts)$/.test(n)) files.push(f);
        }
      };
      walk(rendererRoot);
      return files
        .map((f) => readFileSync(f, 'utf8'))
        .filter((src) => /mz-prose/.test(src)).length;
    })();
    expect(refs, 'mz-prose 被 TSX 引用了，那它和 --ed-* 就是两处定义').toBe(0);
    expect(globalCss, '零引用的排版类要删掉，不是留着当装饰').not.toMatch(/\.mz-prose\s*\{/);
  });
});

describe('D. 死令牌台账：不再允许"写了没人调"却无人知道', () => {
  /**
   * 这些不是"忘了接"，是**排在功能前面**的取值。挂账在此，接上那天必须把这条删掉——
   * 下面第二条会验"表里没有的令牌必须被引用"，第三条会验"表里的令牌必须还真存在"。
   */
  const PLANNED: Record<string, string> = {
    '--mz-editor-gap-novel': 'textarea 没有"段距"概念（段距就是作者敲的空行）；段级样式等 T12 CodeMirror 6',
    '--mz-editor-indent-novel': '首行缩进要按段作用，textarea 做不到（text-indent 只作用首行）；等 T12',
    '--mz-editor-font-wechat': '体裁切换属于导出页 T23，编辑器内暂只有 novel 一档',
    '--mz-editor-size-wechat': '同上（T23）',
    '--mz-editor-lh-wechat': '同上（T23）',
    '--mz-editor-measure-wechat': '同上（T23）',
    '--mz-editor-gap-wechat': '同上（T23）',
    '--mz-editor-indent-wechat': '同上（T23）',
    '--mz-editor-font-toutiao': '体裁切换属于导出页 T23',
    '--mz-editor-size-toutiao': '同上（T23）',
    '--mz-editor-lh-toutiao': '同上（T23）',
    '--mz-editor-measure-toutiao': '同上（T23）',
    '--mz-editor-gap-toutiao': '同上（T23）',
    '--mz-editor-indent-toutiao': '同上（T23）',
    '--mz-editor-indent-manuscript': '导出稿纸皮肤（T23）用：投稿格式才要 2 字符首行缩进',
  };

  const names = [...new Set([...tokensCss.matchAll(/(--mz-editor-[\w-]+)\s*:/g)].map((m) => m[1]))];

  const referenced = (name: string): boolean => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(css|tsx|html)$/.test(n) && !f.endsWith('tokens.css')) files.push(f);
      }
    };
    walk(rendererRoot);
    return files.some((f) => readFileSync(f, 'utf8').includes(`var(${name})`));
  };

  it('每一个 --mz-editor-* 令牌：要么真被引用，要么在台账里写明等谁', () => {
    expect(names.length, '一个 editor 令牌都没扫到，这条断言是空的').toBeGreaterThan(0);
    const orphan = names.filter((n) => !PLANNED[n] && !referenced(n));
    expect(orphan, `既没被引用也没挂账的令牌：${orphan.join(', ')}`).toEqual([]);
  });

  it('台账里的令牌必须还真存在，且确实还没被引用（接上了就从表里删掉）', () => {
    for (const [name, why] of Object.entries(PLANNED)) {
      expect(names, `台账里的 ${name} 在 tokens.css 已不存在（表过期了）`).toContain(name);
      expect(why.length, `${name} 没写理由`).toBeGreaterThan(4);
      expect(
        referenced(name),
        `${name} 已经接上了——把它从 PLANNED 里删掉，别留一张假账`,
      ).toBe(false);
    }
  });
});
