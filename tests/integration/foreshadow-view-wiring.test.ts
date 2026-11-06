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
 */
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const view = readFileSync(join(process.cwd(), 'src/renderer/components/views/ForeshadowView.tsx'), 'utf8');

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

it('★ register.ts 的 ledger:patch：未打开项目抛结构化 E_INVALID_ARGS（handler 级源码钉）', () => {
  const register = readFileSync(join(process.cwd(), 'src/main/ipc/register.ts'), 'utf8');
  const at = register.indexOf("handle('ledger:patch'");
  expect(at, '声明了通道却没人处理').toBeGreaterThan(-1);
  const body = register.slice(at, at + 700);
  expect(body, '未打开项目要抛结构化错误，不能静默成功').toMatch(/!\w+\.project/);
  expect(body).toMatch(/MzError\('E_INVALID_ARGS', '未打开项目'\)/);
});
