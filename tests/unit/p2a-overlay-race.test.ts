/**
 * I-1 回归钉（源码级，同 shell-r1 扫描风格）——P2-B 首批工单。
 *
 * 本仓无 jsdom/组件测试环境：PromptView 的接线只能靠源码扫描断言。这里钉的是
 * 终审 I-1 那条竞态——慢的 A 角色 overlay:get 在用户点了 B 之后才落地，会把 A
 * 的文字填进 B 的表单，保存即串档。钉三件事：
 *   ① openRole 领取序号 + await 回来后早退，旧响应不落入 setStates/表单回填；
 *   ② 首帧 Promise.all 同样受守卫，迟到的首帧不许盖掉用户已选角色；
 *   ③ openRole 起手清 loadError（P2-A T4 minor 移交）。
 * ★ 与 shell-r1 一样先归一化换行（LF/CRLF 都不让正则假红），但**不剥注释**——
 *   守卫必须出现在真实代码里，注释里的同名字样不算数；故实现侧注释不得复刻钉死
 *   的字面量，否则等于把断言写给自己的说明书。
 */
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/renderer/components/views/PromptView.tsx'), 'utf8').replace(/\r\n/g, '\n');

it('openRole 走 sequencer 且旧响应早退（不落入 setStates/表单回填）', () => {
  expect(src).toMatch(/const seq = seqRef\.current\.next\(\);/);
  // 早退必须出现在 fetchRole 之后、第一次 setStates 之前
  const m = src.match(/await fetchRole\(role\);[\s\S]{0,120}?if \(!seqRef\.current\.isCurrent\(seq\)\) return;[\s\S]{0,200}?setStates/);
  expect(m).not.toBeNull();
});
it('首帧 Promise.all 同样受守卫（迟到的首帧不许盖掉用户已选角色）', () => {
  expect(src).toMatch(/if \(!seqRef\.current\.isCurrent\(seq\)\) return;\s*\n\s*setStates\(\{ concept/);
});
it('openRole 清 loadError（P2-A T4 minor 移交）', () => {
  // ★ 终点从 openRole 之后再找「命中预览」：它作为口径说明先出现在文件头注释里，
  //   若按 indexOf('命中预览') 取首个命中会把窗口切空（起点在终点之后）。
  const start = src.indexOf('const openRole');
  const body = src.slice(start, src.indexOf('命中预览', start));
  expect(body).toMatch(/setLoadError\(null\);/);
});
