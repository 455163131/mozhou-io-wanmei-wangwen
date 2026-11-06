/**
 * 伏笔台账页（P2-B T4，mode: foreshadow）接线钉。
 *
 * 四条源码级钉（brief Step 1 逐字）盯的是这个页面最容易「画好了没人调 / 另起炉灶」
 * 的四个形状：取数走既有 ledger 通道而不是新开平行 IPC；证据定位复用
 * health:locate-chapter 且正文只读（页面绝不改稿）；状态色全走 tokens 令牌
 * （裸 hex 在双皮肤下必错一处）；Agent 旧行缺 name/weight 显示「未登记」而不是
 * 编一个默认值糊弄作者。
 * 另加一条 register.ts 的 handler 级源码钉（ledger:patch 未打开项目必须如实抛
 * 结构化错误——写法照 chapter-set-title-wiring C 组的读法）。
 *
 * Fix round 1（审查修复波）追加五钉：项目切换 pid 键重载（R13 口径）、
 * load/证据定位双 sequencer + 位置钉（守卫坐在最后一个 await 与 setEvi/setCurrent
 * 之间，p2a-overlay-race 同款读法）、失败路径不跳编辑器、页头 MODE_LABELS
 * 单一来源、因果链缺登记「未登记」口径。
 */
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// ★ 归一化换行（LF/CRLF 都不让多行正则假红），照 p2a-overlay-race 的读法；不剥注释。
const view = readFileSync(join(process.cwd(), 'src/renderer/components/views/ForeshadowView.tsx'), 'utf8').replace(/\r\n/g, '\n');

it('取数走 ledger:query + patch/remove，不新开平行通道', () => {
  expect(view).toMatch(/ledger\.query\(/);
  expect(view).toMatch(/ledger\.patch\(/);
  expect(view).toMatch(/ledger\.remove\(/);
});
it('证据定位复用 health:locate-chapter，正文只读（无 updateBody）', () => {
  expect(view).toMatch(/locateChapter\(/);
  expect(view).not.toMatch(/updateBody/);
});
it('状态色只引用 tokens 变量，不裸色', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/components/views/ForeshadowView.module.css'), 'utf8');
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(css).toMatch(/var\(--mz-/);
});
it('缺 name/weight 的 Agent 旧行渲染「未登记」，不编造默认值', () => {
  expect(view).toMatch(/未登记/);
});

// ── Fix round 1（T4 审查修复波）──────────────────────────────────────────

it('★ 项目切换重载：订阅 project?.id，初始 load 键在 pid 上（R13/GenView 口径）', () => {
  expect(view).toMatch(/useProjectStore\(\(s\) => s\.project\)/);
  expect(view).toMatch(/const pid = project\?\.id \?\? null;/);
  // 效果键 [pid, load]：openProject 同帧刷 chapters，但不键 chapters——两键即双载。
  expect(view).toMatch(/useEffect\(\(\) => \{[\s\S]{0,400}?void load\(\);\s*\}, \[pid, load\]\);/);
  expect(view).not.toMatch(/}, \[pid, chapters, load\]\)/);
});
it('★ load/locateEvidence 各持 sequencer，post-await 状态写全部判最新（I-1 同族）', () => {
  expect(view).toMatch(/from '\.\.\/\.\.\/lib\/sequenced'/);
  expect(view).toMatch(/const seq = loadSeqRef\.current\.next\(\);/);
  expect(view).toMatch(/const seq = eviSeqRef\.current\.next\(\);/);
  // load：ledger.query 回来后判最新才 setFs
  expect(view).toMatch(/await api\.ledger\.query\('foreshadow'\);\s*\n\s*if \(!loadSeqRef\.current\.isCurrent\(seq\)\) return;\s*\n\s*setFs\(/);
  // 位置钉（p2a-overlay-race 同款读法）：证据面的守卫坐在最后一个 await（回收章
  // chapter.get）与第一批状态写（setEvi 完成态 + setCurrent 跳章）之间。
  const m = view.match(
    /await api\.chapter\.get\(f\.resolvedAt\.chapterId\);[\s\S]{0,250}?if \(!eviSeqRef\.current\.isCurrent\(seq\)\) return;\s*\n\s*setEvi\(\{ f, busy: false[\s\S]{0,120}?setCurrent\(f\.plantedAt\.chapterId\);/,
  );
  expect(m, '守卫缺席：慢的 A 响应会盖掉 B 的证据面板并把编辑器拽去 A 章').not.toBeNull();
});
it('★ chapter.get 失败只报错误、不跳编辑器（setCurrent 只在成功路径）', () => {
  // setCurrent 必须出现在 err:null 的成功 setEvi 之后、catch 之前
  const success = view.match(/setEvi\(\{ f, busy: false, planted, resolved, err: null \}\);\s*\n\s*useProjectStore\.getState\(\)\.setCurrent\(/);
  expect(success).not.toBeNull();
  // 失败分支里只许有证据面板的错误态，不许有跳章
  const at = view.indexOf('catch (e) {', view.indexOf('async function locateEvidence'));
  expect(at).toBeGreaterThan(-1);
  const catchBody = view.slice(at, at + 400);
  expect(catchBody).not.toMatch(/setCurrent|locateChapter/);
});
it('页头显示名走 MODE_LABELS 单一来源，不抄字面量', () => {
  expect(view).toMatch(/import \{ MODE_LABELS \} from '@shared\/constants\/modes'/);
  expect(view).toMatch(/\{MODE_LABELS\.foreshadow\}/);
});
it('因果链缺登记与 name/weight 同口径显示「未登记」，不画破折号', () => {
  expect(view).not.toMatch(/: '—'/);
  expect(view).toMatch(/f\.chain && f\.chain\.trim\(\) \? f\.chain : <span className=\{styles\.unreg\}>未登记<\/span>/);
});

it('★ register.ts 的 ledger:patch：未打开项目抛结构化 E_INVALID_ARGS（handler 级源码钉）', () => {
  const register = readFileSync(join(process.cwd(), 'src/main/ipc/register.ts'), 'utf8');
  const at = register.indexOf("handle('ledger:patch'");
  expect(at, '声明了通道却没人处理').toBeGreaterThan(-1);
  const body = register.slice(at, at + 700);
  expect(body, '未打开项目要抛结构化错误，不能静默成功').toMatch(/!\w+\.project/);
  expect(body).toMatch(/MzError\('E_INVALID_ARGS', '未打开项目'\)/);
});
