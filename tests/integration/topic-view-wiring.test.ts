// tests/integration/topic-view-wiring.test.ts —— P2-C T6 选题库页接线（R46：读源码文本，不挂载）
// 形状照 trending-view-wiring.test.ts（T3 先例）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/TopicLibraryView.tsx', 'utf8');
const css = readFileSync('src/renderer/components/views/TopicLibraryView.module.css', 'utf8');
describe('选题库页接线', () => {
  it('modes.ts 注册 topics + 三字 label「选题库」', () => {
    expect(modes).toMatch(/'topics'/);
    expect(modes).toMatch(/topics:\s*'选题库'/);
  });
  it('App.tsx 灵感组 soon-topics 转正为 mode 且分派 TopicLibraryView（原地替换，不许双入口）', () => {
    expect(app).not.toMatch(/soon-topics/);
    expect(app).toMatch(/id:\s*'topics'/);
    expect(app).toMatch(/mode\s*===\s*'topics'\s*&&\s*<TopicLibraryView/);
    expect(app).toMatch(/case\s*'mode:topics'/);
  });
  it('CommandPalette 有 mode:topics 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:topics'/);
  });
  it('TopicLibraryView 走 sequencer + 三态分栏计数 + 三通道 + 立项走既有目录选择器', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/topic\.list/);
    expect(view).toMatch(/topic\.promote/);
    expect(view).toMatch(/topic\.abandon/);
    expect(view).toMatch(/project\.pickDir/);
    for (const s of ['待立项', '已立项', '已放弃']) expect(view).toContain(s);
  });
  it('放弃是危险动作：useConfirm 二次确认；pending-disable 防重复提交（T3/T5 评审口径）', () => {
    expect(view).toMatch(/useConfirm/);
    expect(view).toMatch(/danger/);
    expect(view).toMatch(/pending/);
    expect(view).toMatch(/disabled/);
  });
  // ★ 终审修复波 T6①：promote/abandon/openLinked 的 await 后 setNotice/setErr 要有跨动作闸——
  //   一条 actionSeqRef sequencer（load 同款口径），旧动作迟到的响应不许盖新通知。
  it('TopicLibraryView 三动作跨动作 sequencer（notice/err 写入时效闸）', () => {
    expect(view).toMatch(/actionSeqRef/);
    expect(view).toMatch(/isCurrent\(seq\)/);
  });
  it('全局子系统不键 project?.id（选题在立项之前就存在）', () => {
    expect(view).not.toMatch(/project\?\.id/);
  });
  it('CSS 零裸色；字号/圆角/间距零裸 px（design-tokens-usage 同口径，margin:0 这类无单位合法）', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/(?:font-size|border-radius|padding|gap|margin)\s*:\s*[^;\n]*\d+(\.\d+)?px/);
  });
});
