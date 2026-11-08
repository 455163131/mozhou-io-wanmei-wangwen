// tests/integration/inspiration-pool-wiring.test.ts
// ★ P2-E ①：灵感池浏览页接线哨兵（R46 源扫描口径，同 export-view-wiring）。
// inspiration:list / inspiration:remove 两通道在 P2-C T2 就已四处齐全，
// 但一直零渲染消费者——本页是它们的收口，不许再画一个没人调的组件。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/InspirationPoolView.tsx', 'utf8');

describe('灵感池页接线', () => {
  it('modes.ts 注册 pool + 三字 label 灵感池', () => {
    expect(modes).toMatch(/'pool'/);
    expect(modes).toMatch(/pool:\s*'灵感池'/);
  });
  it('App.tsx 灵感组挂实项且分派 InspirationPoolView', () => {
    expect(app).toMatch(/id:\s*'pool',\s*label:\s*MODE_LABELS\.pool/);
    expect(app).toMatch(/mode\s*===\s*'pool'\s*&&\s*<InspirationPoolView/);
    expect(app).toMatch(/case\s*'mode:pool'/);
    expect(app).toMatch(/import\s*\{\s*InspirationPoolView\s*\}\s*from\s*'\.\/components\/views\/InspirationPoolView'/);
  });
  it('CommandPalette 有 mode:pool 命令（不占数字快捷键）', () => {
    expect(palette).toMatch(/id:\s*'mode:pool'/);
    expect(palette).toMatch(/MODE_LABELS\.pool/);
  });
  it('InspirationPoolView 走既有双通道 + sequencer + 删除二次确认', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/inspiration\.list/);
    expect(view).toMatch(/inspiration\.remove/);
    expect(view).toMatch(/useConfirm/);
    expect(view).toMatch(/collected/);
    // 全局子系统：卡片在立项之前就存在，不键项目、不挂「未打开项目」门
    expect(view).not.toMatch(/未打开项目/);
  });
  it('★ 终审修复波：删除在途禁 tab——陈旧 tab 闭包重取不许盖新分类（I-1 族）', () => {
    // tab 按钮的 disabled 必须同时看 busy 与 pendingId：删除确认后的 IPC 在途期间
    // 切 tab 会让删除尾部的 load(旧tab) 反超新 load，列表与高亮错配。
    expect(view).toMatch(/className=\{`\$\{styles\.tab\}[\s\S]{0,120}disabled=\{busy \|\| pendingId !== null\}/);
  });
});