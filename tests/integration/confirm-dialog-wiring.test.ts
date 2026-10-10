/**
 * §4 第 31 条：两处回滚确认以前问的是 `window.confirm`。
 *
 * ★ 实测到的修复前事实（三条，都不是观感问题）：
 *   ① `AgentPanel.tsx:384` 与 `HistoryTimeline.tsx:41` 都调 `window.confirm(...)`。
 *      这是本项目里**唯一一处不可撤销地覆盖用户劳动**的动作，而它问的话是
 *      "确认要强制回滚吗？"——**连撤回哪一步、会丢多少都不说**。
 *   ② `HistoryTimeline.tsx` 早就导出了一个完整的 `RollbackConfirmDialog`
 *      （遮罩 + 标题 + 丢改动警告 + danger 键），**全仓零调用方**——
 *      又是本仓库反复出现的「画好了没人调」形状（第 17/19/24/26/27 条同款）。
 *   ③ 它是 Chromium 自绘的，不是 `#32770`。第 29 条已经栽过一次：
 *      自动化驱动点不动它，"界面上到底长什么样"只能靠读代码猜。
 *
 * 本文件验四件事：**组件真的存在且是唯一实现**（A）、**两个调用点真的走它**（B）、
 * **确认框的语义不许退化**（C）、**它必须被渲染在组件树里**（D）。
 * 浏览器模态归零那条棘轮在 `project-pickdir-wiring.test.ts` C 组（台账已清空），
 * 这里不重复它——只在这里补一条反向验：**两处入口不许再自己造遮罩**。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 剥注释：不剥的话，注释里写的"这里曾经是 window.confirm"会被当代码判红（第 29 条栽过三次） */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const CONFIRM = 'renderer/components/common/ConfirmDialog.tsx';
const confirmSrc = read(`../../src/${CONFIRM}`);
const confirmCss = read('../../src/renderer/components/common/ConfirmDialog.module.css');
const agentPanel = read('../../src/renderer/components/agent/AgentPanel.tsx');
const history = read('../../src/renderer/components/history/HistoryTimeline.tsx');
const historyCss = read('../../src/renderer/components/history/HistoryTimeline.module.css');
const pickdirTest = read('./project-pickdir-wiring.test.ts');

/** 从 `function name(` 起切一段，够断言用（本仓既有手法，见第 23/29 条测试） */
function blockOf(src: string, marker: string, span = 1400): string {
  const at = src.indexOf(marker);
  expect(at, `找不到锚点：${marker}`).toBeGreaterThan(0);
  return src.slice(at, at + span);
}

describe('A. 确认框存在、且是唯一实现', () => {
  it('ConfirmDialog 组件与同名 module.css 都在（CSS Module 是配对检查，缺一个直接红）', () => {
    expect(confirmSrc).toMatch(/export function ConfirmDialog\(/);
    expect(confirmCss).toMatch(/\.dialogMask\s*\{/);
    expect(confirmCss).toMatch(/\.dangerBtn\s*\{/);
  });

  it('★ 遮罩样式只有一份：HistoryTimeline.module.css 里的对话框规则已清干净', () => {
    // 修复前那七条规则服务于一个零调用方的死组件；留两份必漂移
    for (const cls of ['dialogMask', 'dialogTitle', 'dialogBody', 'warnLine', 'dialogActions', 'dangerBtn']) {
      expect(
        new RegExp(`\\.${cls}\\s*\\{`).test(historyCss),
        `HistoryTimeline.module.css 里还留着 .${cls}，第二份遮罩样式出现了`,
      ).toBe(false);
    }
    // 但 `.rollbackBtn` 必须还在：它是本视图的行内按钮，不是对话框的一部分（别一刀切删多了）
    expect(historyCss, '行内回滚按钮的样式被顺手删了').toMatch(/\.rollbackBtn\s*\{/);
  });

  it('useConfirm 返回 node，且 node 为 null 时不渲染任何东西（不许无条件挂遮罩）', () => {
    const b = blockOf(confirmSrc, 'export function useConfirm(');
    expect(b).toMatch(/confirm:\s*\(req:\s*ConfirmRequest\)\s*=>\s*Promise<boolean>/);
    expect(b, '没有返回 node，调用方无从渲染').toMatch(/node:\s*JSX\.Element\s*\|\s*null/);
    expect(b, 'req 为空时必须返回 null，否则每次渲染都糊一层遮罩').toMatch(/req\s*\?\s*\(/);
  });

  it('并发调用不许留下永远 await 的 promise（后一次把前一次当取消）', () => {
    const b = blockOf(confirmSrc, 'const confirm = useCallback(');
    expect(b, '前一次的 resolve 没被 settle，调用方会永久挂起').toMatch(/settle\.current\?\.\(false\)/);
  });
});

describe('B. 两个回滚入口真的走它（不是"有个组件没人用"）', () => {
  it('AgentPanel 的 RollbackHint 用 useConfirm，且不再有 window.confirm', () => {
    const b = blockOf(agentPanel, 'function RollbackHint(');
    expect(strip(b)).toMatch(/useConfirm\(\)/);
    expect(strip(b), '还剩浏览器模态').not.toMatch(/window\.(confirm|prompt|alert)\s*\(/);
    expect(b, '没渲染 node 就等于用户永远点不到确认').toMatch(/\{confirmNode\}/);
  });

  it('★ AgentPanel 必须说清"撤回哪一步"——修复前只问"确认要强制回滚吗"', () => {
    const b = blockOf(agentPanel, 'function RollbackHint(');
    // 这一颗按钮是作者自己点的（不像改动历史是点某一格），所以它必须自报家门
    expect(b, '标题里没带步号').toMatch(/last\.stepNo/);
    expect(b, '标题里没带工具名').toMatch(/last\.toolName/);
    expect(b, '正文里没说丢多少').toMatch(/last\.editsCount/);
    expect(b, '正文里没说涉及哪些章').toMatch(/last\.affectedChapters/);
  });

  it('HistoryTimeline 的 rollback 用 confirm(...)，且不再有 window.confirm', () => {
    const b = blockOf(history, 'async function rollback(');
    expect(strip(b)).toMatch(/await confirm\(\{/);
    expect(strip(b), '还剩浏览器模态').not.toMatch(/window\.(confirm|prompt|alert)\s*\(/);
    expect(b, '标题里没带步号').toMatch(/第 \$\{stepNo\} 步/);
  });

  it('★ 判据不许被顺手改掉：还是按「手动修改」这条冲突说明分叉', () => {
    // 修复只该换"怎么问"，不该换"什么时候要问"——那是语义改动，得单独定
    expect(blockOf(history, 'async function rollback(')).toMatch(/msg\.includes\('手动修改'\)/);
    expect(blockOf(agentPanel, 'function RollbackHint(')).toMatch(/msg\.includes\('手动修改'\)/);
  });

  it('★ 强制回滚那条路径没丢：确认之后仍然传 force=true', () => {
    expect(blockOf(history, 'async function rollback(')).toMatch(/checkpoint\.undo\(id,\s*true\)/);
    expect(blockOf(agentPanel, 'function RollbackHint(')).toMatch(/checkpoint\.undo\(last\.id,\s*true\)/);
  });

  it('非冲突错误仍然回写 setError（没有把报错吞掉）', () => {
    expect(blockOf(history, 'async function rollback(')).toMatch(/setError\(msg\)/);
    expect(blockOf(agentPanel, 'function RollbackHint(')).toMatch(/setError\(msg\)/);
  });

  it('HistoryTimeline 的空态早退之外，主路径也渲染了 node', () => {
    // 起点在 `export function HistoryTimeline(`，第一个 {confirmNode} 在 +1807 字符处
    // （中间隔着 rollback()、空态早退）。窗口给足，量的是「有没有渲染」不是「在哪一行」。
    const b = blockOf(history, 'export function HistoryTimeline(', 2200);
    expect(b, '主路径没渲染 node').toMatch(/\{confirmNode\}/);
  });

  it('★ 空态早退也渲染 node（否则确认框开着时列表被刷空＝界面卡死）', () => {
    // 回滚后 refresh() 可能回来 0 条；遮罩还在但已经 early return，
    // 屏幕上只剩一层暗色遮罩、没有任何按钮可点。
    const at = history.indexOf('if (!Array.isArray(checkpoints)');
    expect(at, '空态早退不见了').toBeGreaterThan(0);
    const b = history.slice(at, at + 400);
    expect(b, '空态早退里没渲染 confirmNode').toMatch(/\{confirmNode\}/);
  });

  it('RollbackConfirmDialog 不再是死代码：它收敛成 ConfirmDialog 的包装并被引用', () => {
    const b = blockOf(history, 'export function RollbackConfirmDialog(');
    expect(b, '薄包装里没走 ConfirmDialog').toMatch(/<ConfirmDialog/);
    expect(b, 'T21 点的是它，danger 档不许丢').toMatch(/danger/);
    // 架构文档 T21 点的这个名字必须还在
    expect(history).toMatch(/export function RollbackConfirmDialog\(/);
  });
});

describe('C. 确认框的语义不许退化', () => {
  it('危险动作的默认焦点在「取消」，不是回车即中', () => {
    // ★ 这条是本组最要紧的一条：destructive 动作不该被一次误按回车确认
    const b = blockOf(confirmSrc, 'export function ConfirmDialog(', 2200);
    expect(b, '焦点没落在取消键上').toMatch(/cancelRef\.current\?\.focus\(\)/);
    expect(b, '取消键没挂 ref').toMatch(/ref=\{cancelRef\}/);
  });

  it('Esc 必须能取消（不能只有鼠标一条路）', () => {
    const b = blockOf(confirmSrc, 'export function ConfirmDialog(', 2200);
    expect(b).toMatch(/e\.key === 'Escape'/);
    expect(b).toMatch(/onCancel\(\)/);
    // 监听器必须摘掉，否则关掉之后 Esc 还在取消别的东西
    expect(b, 'keydown 监听没解绑').toMatch(/removeEventListener\('keydown'/);
  });

  it('是模态：role=alertdialog + aria-modal，且用 portal 挂到 body', () => {
    // 挂在组件树深处会被父级 overflow/transform 裁掉或叠错层
    expect(confirmSrc).toMatch(/createPortal/);
    expect(confirmSrc).toMatch(/role="alertdialog"/);
    expect(confirmSrc).toMatch(/aria-modal="true"/);
    expect(confirmSrc, '没有可访问名，读屏软件只念"对话框"').toMatch(/aria-label=\{title\}/);
  });

  it('点遮罩 = 取消，但点对话框本体不能冒泡上去', () => {
    const b = blockOf(confirmSrc, 'export function ConfirmDialog(', 2200);
    expect(b, '遮罩没接 onMouseDown').toMatch(/className=\{styles\.dialogMask\}[\s\S]{0,160}onMouseDown=\{onCancel\}/);
    expect(b, '本体没 stopPropagation，点正文也会被当成取消').toMatch(/e\.stopPropagation\(\)/);
  });

  it('配色只能来自 token（裸 hex 在暗色皮肤下必错）', () => {
    const hex = confirmCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex, `ConfirmDialog.module.css 里有裸 hex：${hex.join(', ')}`).toEqual([]);
  });

  it('warn 行是可选的：没有额外警告时不许渲染一个空框', () => {
    expect(confirmSrc).toMatch(/\{warn && <div className=\{styles\.warnLine\}>/);
  });
});

describe('D. 装配哨兵：浏览器模态台账必须已清空（棘轮不许被悄悄放宽）', () => {
  it('★ project-pickdir-wiring 里的 BROWSER_MODAL_DEBT 是空表', () => {
    const m = /const BROWSER_MODAL_DEBT: Record<string, number> = \{([^}]*)\}/.exec(pickdirTest);
    expect(m, '台账声明找不到了——是不是被删了而不是清空？删掉的话棘轮就没了').not.toBeNull();
    expect(m![1].trim(), '台账不空说明还有欠账没修').toBe('');
  });

  it('★ 棘轮本身还在：那条逐个文件比对的断言不许被删', () => {
    expect(pickdirTest, '逐文件比对没了，等于把棘轮拆了').toMatch(
      /window\\\.\(prompt\|alert\|confirm\)|window\\\\\.\(prompt\|alert\|confirm\)/,
    );
    expect(pickdirTest).toMatch(/rendererFiles\(\/\\\.\(ts\|tsx\)\$\/\)/);
  });

  it('渲染层里 source 与 CSS 各只有一个 ConfirmDialog（没有第二份实现）', () => {
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const full = join(d, n);
        if (statSync(full).isDirectory()) walk(full);
        else if (/^ConfirmDialog\.(tsx|module\.css)$/.test(n)) found.push(full.replace(SRC, ''));
      }
    };
    walk(SRC);
    expect(found.sort()).toEqual([
      join('renderer/components/common', 'ConfirmDialog.module.css'),
      join('renderer/components/common', 'ConfirmDialog.tsx'),
    ]);
  });
});
