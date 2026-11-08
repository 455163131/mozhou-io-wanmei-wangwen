// tests/integration/trending-view-wiring.test.ts —— P2-C T3 扫榜热榜页接线（R46：读源码文本，不挂载）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/TrendingView.tsx', 'utf8');
describe('扫榜热榜页接线', () => {
  it('modes.ts 注册 trends + 四字 label', () => {
    expect(modes).toMatch(/'trends'/);
    expect(modes).toMatch(/trends:\s*'扫榜热榜'/);
  });
  it('App.tsx 灵感组 soon-trends 转正为 mode 且分派 TrendingView', () => {
    expect(app).not.toMatch(/soon-trends/);
    expect(app).toMatch(/id:\s*'trends'/);
    expect(app).toMatch(/mode\s*===\s*'trends'\s*&&\s*<TrendingView/);
    expect(app).toMatch(/case\s*'mode:trends'/);
  });
  it('CommandPalette 有 mode:trends 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:trends'/);
  });
  it('TrendingView 走 sequencer + 演示/实时明示 + 收藏/套用', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/演示数据|实时/);
    expect(view).toMatch(/inspiration\.collect|collect/);
    expect(view).toMatch(/createTopicFromCard|套用/);
  });
  // ★ 终审修复波 D：套用成功≠pending 清空就完事——TopicRepo.insert 无 sourceCardId 去重，
  //   重点击会堆重复待立项选题。会话级 applied 集镜像 collected 集：成功后按钮「已套用」禁用。
  it('TrendingView 套用防重：会话级 applied 集 + 成功后「已套用」禁用（镜像 collected 模式）', () => {
    expect(view).toMatch(/applied/);
    expect(view).toContain('已套用');
  });
});