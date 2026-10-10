/**
 * §4 第 34 条：令牌层造好了，组件层从来没用过它。
 *
 * 三条修复前事实（全部实测，不是估计）：
 *
 *   ① 令牌层有 217 个 `--mz-*`，排版刻度 11 级（display 32 / h1 24 / h2 20 / h3 17 /
 *      body 15 / editor 18 / sm 13 / xs 12 / metric-lg 28 / metric 16 / metric-sm 13），
 *      而组件 CSS 里**裸 px 字号 113 处**全是刻度外值：11px×30、12px×37、10.5px×10、
 *      14px×8、10px×7、12.5px×6、11.5px×5、13px×5、13.5px×1，另加四个刻度外的
 *      「英雄数字」22/23/34/36px。**六个刻度（display/h1/h2/h3/body/editor）在组件
 *      CSS 里一次都没被引用过。**
 *
 *   ② 裸 `border-radius` 43 处、12 个不同值（2/3/4/5/6/7/8/9/10/11/12px），而圆角
 *      令牌只有 4 个（xs 3 / sm 5 / md 8 / lg 12）。**最流行的两个恰好是令牌里不存在
 *      的 6px（14 处）与 11px（5 处）** —— 设计稿改过、令牌跟着改过、散装值没跟。
 *
 *   ③ `--mz-space-*` 八级间距令牌在组件与外壳 CSS 里 **0 处引用**
 *      （`rg '--mz-space-\d'` 全仓只命中 tokens.css 的定义行本身）；实测手写的
 *      padding/gap/margin 含 px 值共 269 处。
 *
 * 这三条指向同一个病：令牌层是给新代码准备的，老组件是化石层，两边从没对齐过。
 * 本条就是这个缺口上的门禁 —— 此前**没有任何一条测试**说过组件 CSS 里不许写裸 px。
 *
 * 收敛口径（第 34 条实际执行的那一套，记录在此供后人复核）：
 *   字号：10 / 10.5 / 11 / 11.5 → --mz-fs-2xs(11.5)  ← 新增刻度
 *         12        → --mz-fs-xs(12)
 *         12.5 / 13 / 13.5 / 14 → --mz-fs-sm(13)
 *         22 / 23   → --mz-fs-metric-md(22)          ← 新增刻度
 *         34 / 36   → --mz-fs-metric-xl(36)          ← 新增刻度
 *   圆角：2/3/4 → xs(3)   5/6 → sm(5)   7/8/9/10 → md(8)   11/12 → lg(12)
 *   间距：就近 + **向上**取整（新增 6px 与 10px 两个半级，映射里 269 处
 *         的可见变化方向统一为「变大或不变」，唯一例外是 1px 徽标内边距 → 0）
 *
 * 为什么三个刻度是**新加**而不是硬塞进最近旧刻度：把 34/36px 收到 metric-lg 28px 是
 * -22%，那不是「收敛」是改设计；把 11.5px 压到 xs 12px 会连带 37 处本来就写 12px 的
 * 一起动，改动面失控。定 11.5px 这一档是为了让 10/10.5/11px 这一层**只在向上方向
 * 合并**（小字从 10px 抬到 11.5px 是变大，且仍在正文 15px / xs 12px 之下的合理层级）。
 *
 * ★ 覆盖边界（如实写明）：
 *   1. 只扫 `src/renderer/**` 下的 `.module.css`，**不扫 `App.module.css` 之外的
 *      全局样式**（`global.css` / `tokens.css` 是令牌与基础态的定义处，本来就该有
 *      裸值和 ::selection 之类的浏览器机制值）。
 *   2. 只查 `font-size` / `border-radius` / `padding|gap|margin` 三类属性的**裸 px**。
 *      `width` / `height` / `top` 等几何值不在此列 —— 那些是尺寸不是刻度，本仓也没有
 *      对应的令牌族，强行纳入只会造出一张没人看的白名单。
 *   3. 值里出现 `calc()` / `clamp()` / 多值简写时只按「**整值等于纯 px 数字**」判定；
 *      例如 `padding: 0 4px` 会被命中，而 `padding: calc(var(--x) + 4px)` 不会 ——
 *      后者在数学上无法静态定级，属有意放过。
 *   4. 括号内（如 `:hover` 伪类、`@media` 查询条件）出现的 px 不在此列，本测试只看
 *      属性声明的值。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** 归一 CRLF → LF：仓库 .gitattributes 是 `* text=auto eol=lf`，但本机 core.autocrlf=true
 *  会让工作区是 CRLF，不归一的话那些按行锚定的正则会在 Windows 上假红。 */
function read(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.module.css')) out.push(p);
  }
  return out;
}

const CSS_FILES = walk(join(SRC, 'renderer')).sort();

/** 剥掉注释：不剥的话，本仓库那些「这里曾经写着 34px」的说明注释会被自己判红。
 *  （第 32 / 33 条都在这个坑里栽过，见 §四对应台账的「边界」段。） */
function strip(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Hit {
  file: string;
  line: number;
  prop: string;
  value: string;
}

/** 逐行扫三类属性的**裸 px** 值。返回命中清单（含文件/行号，失败信息可直接定位）。 */
function rawPxHits(): Hit[] {
  const hits: Hit[] = [];
  for (const f of CSS_FILES) {
    const rel = relative(SRC, f).replace(/\\/g, '/');
    const lines = strip(read(f)).split('\n');
    lines.forEach((line, i) => {
      const m = /^\s*(font-size|border-radius|padding|padding-top|padding-right|padding-bottom|padding-left|padding-inline|padding-block|gap|row-gap|column-gap|margin|margin-top|margin-right|margin-bottom|margin-left|margin-inline|margin-block)\s*:\s*([^;]+);/.exec(
        line,
      );
      if (!m) return;
      const value = m[2].trim();
      // 只有当值里**每个**分量都是纯 px 数字才算「裸」——calc/clamp/关键字/变量都不算
      const parts = value.split(/\s+/);
      const allPx = parts.length > 0 && parts.every((p) => /^\d+(\.\d+)?px$/.test(p));
      if (allPx) hits.push({ file: rel, line: i + 1, prop: m[1], value });
    });
  }
  return hits;
}

/**
 * 有意保留的例外。空表是**目标状态**：这张表存在的意义是让「还有人没改完」这件事
 * 必须被写下来，而不是可以悄悄漏过去。
 *
 * 表结构：`相对路径 -> 该文件里允许残留的裸 px 声明数`。计数而不是布尔，
 * 是为了防止「反正这个文件破例了」变成无上限开口 —— 多一处就红。
 *
 * ★ 反向验在下面那条用例里：表里写了的文件必须真的存在、且残留数必须**正好相等**
 *   （改完了却没从表里删 ＝ 红；表里写了但文件里没有 ＝ 也红）。
 */
const PLANNED_RAW_PX: Record<string, number> = {};

describe('A. 组件 CSS 的排版/圆角/间距必须落在令牌上', () => {
  it('全仓扫到的 module.css 数量合理（哨兵本身别静默失效）', () => {
    // 少了这个下限，「walk 路径写错 → 一个文件都没扫到 → 零命中 → 全绿」会静默通过
    expect(CSS_FILES.length, 'src/renderer/**/*.module.css 至少该有十几个').toBeGreaterThan(10);
  });

  it('没有任何组件 CSS 在写裸 px 字号 / 圆角 / 间距', () => {
    const unplanned = rawPxHits().filter((h) => !(h.file in PLANNED_RAW_PX));
    expect(
      unplanned.map((h) => `${h.file}:${h.line}  ${h.prop}: ${h.value}`),
      '这些组件 CSS 绕过了令牌层。字号走 --mz-fs-*、圆角走 --mz-radius-*、' +
        '间距走 --mz-space-*；确实还不能改的，写进 PLANNED_RAW_PX 并注明理由。',
    ).toEqual([]);
  });

  it('★ 台账没空转：表里每个文件都还在、残留数正好相等', () => {
    const hits = rawPxHits();
    for (const [file, allowed] of Object.entries(PLANNED_RAW_PX)) {
      const actual = hits.filter((h) => h.file === file).length;
      expect(
        actual,
        `PLANNED_RAW_PX 里写着 ${file} 允许 ${allowed} 处裸 px，实际 ${actual} 处` +
          (actual === 0 ? '（改完了就把它从表里删掉）' : ''),
      ).toBe(allowed);
    }
  });
});

describe('B. 第 34 条新增的三级刻度必须真的存在且在 :root 里', () => {
  const tokens = strip(read(join(SRC, 'renderer/styles/tokens.css')));
  // 只取 :root 到深色皮肤块之前那段，避免读到 [data-theme="ink"] 里的同名覆盖
  const rootBlock = tokens.slice(0, tokens.indexOf('[data-theme="ink"]'));

  function rootPx(name: string): number | null {
    const m = new RegExp(`--${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\s*;`).exec(rootBlock);
    return m ? Number(m[1]) : null;
  }

  it('--mz-fs-metric-xl / -md / --mz-fs-2xs 三级都在 :root 定义', () => {
    expect(rootPx('mz-fs-metric-xl'), '缺 --mz-fs-metric-xl（评分英雄数字无处可落）').toBe(36);
    expect(rootPx('mz-fs-metric-md'), '缺 --mz-fs-metric-md（卡片主数字无处可落）').toBe(22);
    expect(rootPx('mz-fs-2xs'), '缺 --mz-fs-2xs（小标签层无处可落）').toBe(11.5);
  });

  it('★ 三级之间的关系成立：2xs < xs < sm < body，metric-lg < metric-md < metric-xl', () => {
    const px = (n: string) => rootPx(n);
    // 小字层必须仍在正文之下 —— 11.5px 是「小」不是「更小到看不清」
    expect(px('mz-fs-2xs')!).toBeLessThan(px('mz-fs-xs')!);
    expect(px('mz-fs-xs')!).toBeLessThan(px('mz-fs-sm')!);
    expect(px('mz-fs-sm')!).toBeLessThan(px('mz-fs-body')!);
    // 数字族必须自下而上，且 metric-md 落在 metric 与 metric-lg 之间（这正是它存在的理由）
    expect(px('mz-fs-metric')!).toBeLessThan(px('mz-fs-metric-md')!);
    expect(px('mz-fs-metric-md')!).toBeLessThan(px('mz-fs-metric-lg')!);
    expect(px('mz-fs-metric-lg')!).toBeLessThan(px('mz-fs-metric-xl')!);
  });

  it('--mz-space-half(6) 与 --mz-space-2h(10) 在 :root 定义，且插在正确的档位之间', () => {
    expect(rootPx('mz-space-half'), '缺 6px 半级 —— 原来最常用的 6px 间距无处可落').toBe(6);
    expect(rootPx('mz-space-2h'), '缺 10px 半级 —— 原来第二常用的 10px 间距无处可落').toBe(10);
    // 半级必须真的卡在整级之间，否则命名含义与实际不符
    expect(rootPx('mz-space-1')!).toBeLessThan(rootPx('mz-space-half')!);
    expect(rootPx('mz-space-half')!).toBeLessThan(rootPx('mz-space-2')!);
    expect(rootPx('mz-space-2')!).toBeLessThan(rootPx('mz-space-2h')!);
    expect(rootPx('mz-space-2h')!).toBeLessThan(rootPx('mz-space-3')!);
  });
});

describe('C. 收敛没有顺手改掉别的规则（第 28 / 33 条的成果必须完好）', () => {
  const editorCss = strip(read(join(SRC, 'renderer/components/editor/Editor.module.css')));

  it('★ 正文仍左对齐（第 28 条：这里曾经写着 center，每行稿子都居中）', () => {
    const shared = /\.stage > \.area,\s*\.stage > \.backdrop\s*\{([^}]*)\}/.exec(editorCss);
    expect(shared, 'Editor.module.css 里找不到镜像层与 textarea 的共用规则').not.toBeNull();
    expect(shared![1], '共用规则丢了 text-align: left').toMatch(/text-align:\s*left/);
  });

  it('★ 写作区仍不带焦点环，且镜像层不得自带字号（第 7 条：两层会漂移）', () => {
    expect(editorCss, '写作区又镶上焦点环了（一进应用就是一圈红框）').toMatch(
      /\.area:focus-visible\s*\{[^}]*outline:\s*none/,
    );
    /**
     * ★ 锚点必须**行首限定**。`/\.backdrop\s*\{/` 会先命中**共用规则**那一行
     *   `.stage > .area,\n.stage > .backdrop {` —— 量到的是共用块，而共用块里
     *   `font-size: var(--ed-size)` 是**对的**（两层必须同一处定义，见 .wrap 的注释）。
     *   这条断言想抓的是「.backdrop 单独又写一份字号」，所以只认行首的 `.backdrop{`。
     *   （本条测试初版就栽在这里：实测报 `expected '… font-size: var(--ed-size) …'
     *   not to match /font-size/`，红得没有道理 —— 是断言量错了对象。）
     */
    const backdrop = /^\.backdrop\s*\{([^}]*)\}/m.exec(editorCss);
    expect(backdrop, 'Editor.module.css 里找不到独立的 .backdrop 规则').not.toBeNull();
    expect(backdrop![1], '.backdrop 自己写了一份字号 —— 镜像层会与 textarea 漂移').not.toMatch(
      /font-size/,
    );
  });

  it('★ 行长上限仍是 min(measure, 100%)（第 33 条：裸 clamp 的下限是硬下限，会溢出）', () => {
    // 同样行首锚定：`.stage > .area, .stage > .backdrop {` 那行以 .stage 开头，会假命中
    const stage = /^\.stage\s*\{([^}]*)\}/m.exec(editorCss);
    expect(stage, 'Editor.module.css 里找不到独立的 .stage 规则').not.toBeNull();
    expect(stage![1], '.stage 丢了 min(100%) 兜底 —— 容器窄于 28em 时正文照样溢出').toMatch(
      /max-width:\s*min\(var\(--mz-editor-measure-novel\),\s*100%\)/,
    );
  });
});

describe('D. 令牌自身不许写成裸值引用（防「用令牌套令牌」的空转）', () => {
  const tokens = read(join(SRC, 'renderer/styles/tokens.css'));

  it('第 34 条新增的每一级都在注释里写明了它为什么必须存在', () => {
    // 这三级是我判断出来的「缺口刻度」，不是设计稿给的。若后人删掉理由，就没法判断
    // 能不能再合并 —— 所以理由与声明必须同生共死。
    for (const name of ['mz-fs-metric-xl', 'mz-fs-metric-md', 'mz-fs-2xs', 'mz-space-half', 'mz-space-2h']) {
      const idx = tokens.indexOf(`--${name}:`);
      expect(idx, `tokens.css 里找不到 --${name}:`).toBeGreaterThan(-1);
      // 向前 2000 字符内必须有中文说明（本仓库所有令牌都带说明，这一条是惯例哨兵）
      const before = tokens.slice(Math.max(0, idx - 2000), idx);
      expect(before, `--${name} 附近没有任何中文说明 —— 缺口刻度的存在理由必须写下来`).toMatch(
        /[\u4e00-\u9fa5]/,
      );
    }
  });
});
