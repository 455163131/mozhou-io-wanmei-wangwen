// tests/integration/idea-view-wiring.test.ts —— P2-C T4 抽脑洞页接线（R46：读源码文本，不挂载）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/IdeaDrawView.tsx', 'utf8');
describe('抽脑洞页接线', () => {
  it('modes.ts 注册 idea + 三字 label', () => {
    expect(modes).toMatch(/'idea'/);
    expect(modes).toMatch(/idea:\s*'抽脑洞'/);
  });
  it('App.tsx 灵感组 soon-brainstorm 转正为 mode 且分派 IdeaDrawView', () => {
    expect(app).not.toMatch(/soon-brainstorm/);
    expect(app).toMatch(/id:\s*'idea'/);
    expect(app).toMatch(/mode\s*===\s*'idea'\s*&&\s*<IdeaDrawView/);
    expect(app).toMatch(/case\s*'mode:idea'/);
  });
  it('CommandPalette 有 mode:idea 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:idea'/);
  });
  it('IdeaDrawView 走 sequencer + 演示/实时明示 + 收藏/套用', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/演示|实时/);
    expect(view).toMatch(/inspiration\.collect|collect/);
    expect(view).toMatch(/createTopicFromCard|套用/);
  });
  // ★ 终审修复波 D：单卡页同口径——套用成功后「已套用」禁用（新抽一张才复位）。
  it('IdeaDrawView 套用防重：applied 态 + 成功后「已套用」禁用', () => {
    expect(view).toMatch(/applied/);
    expect(view).toContain('已套用');
  });
});