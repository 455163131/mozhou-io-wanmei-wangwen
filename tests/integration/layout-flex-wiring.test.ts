/**
 * §4 第 33 条：外壳宽度账此前从没算过。
 *
 * ★ 实测到的修复前事实（三条，都不是观感问题）：
 *   ① 三个栏宽是**魔法数**直接写在 `App.module.css`（`56px` / `260px` / `360px`），
 *      而窗口下限在另一处、另一个进程 —— `window.ts:22` 的 `minWidth: 1280`。
 *      两者互不知情。实算：`1280 - 56 - 260 - 360 = 604px`，而正文行长上限
 *      `--mz-editor-measure-novel: 34em` x `--mz-editor-size-novel: 18px` = **612px**。
 *      **正文比它的容器宽 8px。**
 *   ② 后果不是观感：`Editor.module.css` 的 `.stage` 写着
 *      `max-width: var(--mz-editor-measure-novel); margin-inline: auto`，
 *      当 `max-width` 大于容器时它形同不存在，`auto` 两边余量同时归零 ——
 *      正文被压到**左贴边**，且 textarea 触发横向滚动（镜像层与它共用排版，
 *      两层一起偏）。§4 第 28 条修的是同一条规则在**宽窗口**下的另一面（居中失效）。
 *   ③ 三栏都是 `flex: none`，**没有任何一栏让位**：窗口缩窄时编辑器独自承担全部压力。
 *      而且 CSS 层此前零条宽度断点 —— 全文 `@media` 实测只有两条
 *      `prefers-reduced-motion`（`tokens.css` / `App.module.css`）。
 *
 * 本文件验四件事：**那条算术当场成立**（A）、**三栏真的会收缩**（B）、
 * **正文永不溢出容器**（C）、**断点设在了够得着的地方**（D）。
 *
 * A 组是本文件的重点：它从 CSS 与 tokens 里**把数字读出来**再算，不是断言
 * "文件里有 clamp"。这正是第 32 条踩过的坑 —— 断言一个字符串存在，改坏了照样绿。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 剥注释：注释里写着"这里曾经是 260px"，不剥会被当代码判红（第 29 条栽过三次） */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const appCss = strip(read('../../src/renderer/App.module.css'));
const editorCss = strip(read('../../src/renderer/components/editor/Editor.module.css'));
const tokensCss = strip(read('../../src/renderer/styles/tokens.css'));
const windowTs = strip(read('../../src/main/window.ts'));

/** `--mz-layout-tree-min-w: 200px;` → 200 */
function pxToken(src: string, name: string): number {
  const m = new RegExp(`--${name}\\s*:\\s*(\\d+)px`).exec(src);
  expect(m, `tokens.css 里找不到 --${name}（栏宽必须走令牌，否则测试量不到）`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

/** 取 :root 块（`[data-theme="ink"]` 之前的那一段），避免误读暗色块里的同名令牌 */
function rootBlock(src: string): string {
  const start = src.indexOf(':root');
  const end = src.indexOf('[data-theme="ink"]');
  expect(start, ':root 块不见了').toBeGreaterThanOrEqual(0);
  return src.slice(start, end > 0 ? end : undefined);
}

describe('A. 宽度账算术（本文件的核心：把数字读出来算，不是断言字符串存在）', () => {
  const winMin = (() => {
    const m = /minWidth\s*:\s*(\d+)/.exec(windowTs);
    expect(m, 'window.ts 里找不到 minWidth —— 算术失去了输入').not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  })();

  const railW = pxToken(tokensCss, 'mz-layout-rail-w');
  const treeMin = pxToken(tokensCss, 'mz-layout-tree-min-w');
  const railMin = pxToken(tokensCss, 'mz-layout-rail-min-w');

  it('★ 最窄可达状态下，编辑器拿到的宽度必须 >= 正文行长下限', () => {
    const editorAtWorst = winMin - railW - treeMin - railMin;
    // 正文下限 = measure 的 clamp 最小值 28em x 字号 18px
    const measureMin = 28 * 18;
    expect(
      editorAtWorst,
      `最窄窗口下编辑器只剩 ${editorAtWorst}px，正文下限 ${measureMin}px —— 必溢出`,
    ).toBeGreaterThanOrEqual(measureMin);
    // 留白：不能刚刚好，否则居中退化成贴边（margin-inline:auto 两边都接近 0）
    expect(editorAtWorst - measureMin, '余量太小，居中会退化成贴边').toBeGreaterThanOrEqual(48);
  });

  it('★ 每一个真实可达的窗口宽度上，编辑器都容得下理想行长 34em 或至少正文下限', () => {
    /**
     * ★ 这条初版写错过，留档：我原本断言「满栏基准宽 + 最窄窗口」也容得下 34em，
     *   实测 `expected 604 to be greater than or equal to 612` —— **失败是对的**。
     *   那两个前提不可能同时成立：1280 落在紧凑档内（< 1360），此时两栏取的是
     *   **下限** 而 不是基准宽；满栏基准宽只在 >= 1360 时出现，而那时窗口至少 1360。
     *   把两个互斥前提拼在一起，等于要求 1280 窗口同时处在两个布局档里。
     *
     *   正确的验法是**逐档扫一遍真实可达的宽度**：对每个窗口宽，先按断点决定
     *   该取基准宽还是下限，再算编辑器剩下的宽度。
     */
    const BREAKPOINT = 1360;
    const treeMax = pxToken(tokensCss, 'mz-layout-tree-max-w');
    const railMax = pxToken(tokensCss, 'mz-layout-rail-max-w');
    const ideal = 34 * 18; // 612
    const floor = 28 * 18; // 504（measure 的 clamp 下限）

    const rows: string[] = [];
    for (let win = winMin; win <= 1920; win += 1) {
      const compact = win < BREAKPOINT;
      const editor = win - railW - (compact ? treeMin : treeMax) - (compact ? railMin : railMax);
      rows.push(`win=${win} ${compact ? '紧凑' : '满栏'} → editor=${editor}`);
      // 任何可达宽度下，编辑器都必须容得下正文下限
      expect(editor, rows[rows.length - 1]!).toBeGreaterThanOrEqual(floor);
      // 且必须留得出居中余量，否则 margin-inline:auto 退化成贴边
      expect(editor - floor, `win=${win} 余量不足，居中会退化成贴边`).toBeGreaterThanOrEqual(48);
      // 满栏档下还必须容得下理想行长（紧凑档允许收到 28em，这是设计的取舍）
      if (!compact) {
        expect(editor, rows[rows.length - 1]!).toBeGreaterThanOrEqual(ideal);
      }
    }
    // 至少要扫到过两个档位，否则这条测试等于没验证断点
    expect(rows.some((r) => r.includes('紧凑'))).toBe(true);
    expect(rows.some((r) => r.includes('满栏'))).toBe(true);
  });

  it('A3 三栏之和 + 正文理想行长 <= 窗口默认宽（默认 1440 下不该出现横向滚动）', () => {
    const m = /width\s*:\s*(\d+)/.exec(windowTs);
    const winDefault = m ? Number((m as RegExpExecArray)[1]) : 1440;
    const fixed = railW + pxToken(tokensCss, 'mz-layout-tree-max-w') + pxToken(tokensCss, 'mz-layout-rail-max-w');
    expect(winDefault - fixed, '默认窗口下编辑器容不下理想行长').toBeGreaterThanOrEqual(34 * 18);
  });
});

describe('B. 三栏真的会收缩（flex:none 是修复前的形状，不许回来）', () => {
  it('左右两栏都是 flex: 0 1 auto，不是 flex: none', () => {
    const left = /\.left\s*\{([^}]*)\}/.exec(appCss);
    const right = /\.right\s*\{([^}]*)\}/.exec(appCss);
    expect(left, '.left 规则不见了').not.toBeNull();
    expect(right, '.right 规则不见了').not.toBeNull();
    for (const [name, blk] of [
      ['.left', (left as RegExpExecArray)[1]],
      ['.right', (right as RegExpExecArray)[1]],
    ] as const) {
      expect(blk, `${name} 没有 flex-shrink，窗口变窄时不会让位`).toMatch(/flex:\s*0\s+1\s+auto/);
      expect(blk, `${name} 还写着 flex: none —— 这是修复前的形状`).not.toMatch(/flex:\s*none/);
      expect(blk, `${name} 缺 min-width 让位下限`).toMatch(/min-width:\s*var\(--mz-layout-/);
    }
  });

  it('栏宽走令牌，不再有魔法数（图标/分隔线的固定尺寸不在此列）', () => {
    for (const dead of ['width: 260px', 'width: 360px', 'width: 56px']) {
      expect(appCss.includes(dead), `App.module.css 里还留着魔法数 ${dead}`).toBe(false);
    }
    expect(appCss).toMatch(/width:\s*var\(--mz-layout-rail-w\)/);
    expect(appCss).toMatch(/width:\s*var\(--mz-layout-tree-max-w\)/);
    expect(appCss).toMatch(/width:\s*var\(--mz-layout-rail-max-w\)/);
  });

  it('让位顺序有依据：AI 右栏下限 < 章节树基准宽（先让弹性空间大的那栏）', () => {
    // 这不是审美：六个页签平摊到 300px 每只 50px 仍可点；章节树标题截断一多就认不出章
    const railMinW = pxToken(tokensCss, 'mz-layout-rail-min-w');
    const treeMinW = pxToken(tokensCss, 'mz-layout-tree-min-w');
    expect(railMinW, 'AI 栏下限不该小于章节树下限').toBeGreaterThan(treeMinW);
  });
});

describe('C. 正文永不溢出容器（第 28 条那条规则的另一面）', () => {
  it('★ .stage 的 max-width 必须同时含 measure 与 100% 兜底', () => {
    const stage = /\.stage\s*\{([^}]*)\}/.exec(editorCss);
    expect(stage, '.stage 规则不见了').not.toBeNull();
    const blk = (stage as RegExpExecArray)[1];
    expect(blk, '.stage 缺 max-width').toMatch(/max-width:/);
    expect(blk, '缺 measure 令牌').toMatch(/var\(--mz-editor-measure-novel\)/);
    /**
     * ★ 为什么必须有 100% 兜底：clamp(MIN, VAL, MAX) 的 MIN 是**硬下限**，
     *   容器窄于 MIN 时它返回 MIN 而不是容器宽 —— 正文照样溢出。
     *   只有 min(measure, 100%) 才在数学上保证"永不超过容器"。
     */
    expect(blk, '缺 100% 兜底：clamp 的硬下限会在极窄容器下溢出').toMatch(/100%/);
  });

  it('★ measure 不再是裸 34em（裸值在 604px 容器里永远不会生效）', () => {
    const root = rootBlock(tokensCss);
    const m = /--mz-editor-measure-novel\s*:\s*([^;]+);/.exec(root);
    expect(m, 'tokens.css 的 :root 里找不到 --mz-editor-measure-novel').not.toBeNull();
    const val = (m as RegExpExecArray)[1].trim();
    expect(val, `measure 还是裸值「${val}」——窄窗下 max-width 会形同不存在`).not.toMatch(/^34em$/);
    expect(val, 'measure 没有随窗口收窄的能力（缺 clamp/min）').toMatch(/clamp\(|min\(/);
    expect(val, 'measure 必须保留 34em 作为理想行长').toMatch(/34em/);
  });

  it('C3 居中仍然写着（第 28 条不许被这次改动顺手改掉）', () => {
    const stage = /\.stage\s*\{([^}]*)\}/.exec(editorCss);
    expect((stage as RegExpExecArray)[1]).toMatch(/margin-inline:\s*auto/);
  });

  it('C4 正文仍左对齐（第 28 条的正面断言，防回归）', () => {
    expect(editorCss).toMatch(/text-align:\s*left/);
  });
});

describe('D. 断点必须够得着（"防御写了触发不了"是本仓反复出现的形状）', () => {
  it('★ 存在一条真正的宽度断点，且落在 minWidth 之上', () => {
    const bp = /@media\s*\(max-width:\s*(\d+)px\)/.exec(appCss);
    expect(bp, 'App.module.css 里没有任何宽度断点——窄窗下三栏不会进紧凑档').not.toBeNull();
    const bpPx = Number((bp as RegExpExecArray)[1]);
    const winMin = Number((/minWidth\s*:\s*(\d+)/.exec(windowTs) as RegExpExecArray)[1]);
    /**
     * ★ 断点必须 **大于** minWidth。若断点 <= minWidth，则用户真能拖到的
     *   整个区间都落在断点之外，紧凑档**永不进入** —— 与第 33 条边界 (a)
     *   记录的同类先例一致：两个模态的 `max-width: calc(100vw - 48px)`
     *   在 1280 下限下反而永远用不上。
     */
    expect(
      bpPx,
      `断点 ${bpPx}px 不大于 minWidth ${winMin}px，紧凑档永远进不去`,
    ).toBeGreaterThan(winMin);
  });

  it('断点里两栏都收到各自的下限', () => {
    const at = appCss.indexOf('@media (max-width:');
    const blk = appCss.slice(at, at + 400);
    expect(blk, '断点里没收 .left').toMatch(/\.left\s*\{[^}]*width:\s*var\(--mz-layout-tree-min-w\)/);
    expect(blk, '断点里没收 .right').toMatch(/\.right\s*\{[^}]*width:\s*var\(--mz-layout-rail-min-w\)/);
  });

  it('D3 减少动效的那个断点没被误伤（它是另一条，不该被合并/删除）', () => {
    expect(appCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
