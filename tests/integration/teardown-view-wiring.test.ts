// tests/integration/teardown-view-wiring.test.ts —— P2-C T5 拆书报告页接线（R46：读源码文本，不挂载）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/TeardownView.tsx', 'utf8');
describe('拆书报告页接线', () => {
  it('modes.ts 注册 teardown + 四字 label', () => {
    expect(modes).toMatch(/'teardown'/);
    expect(modes).toMatch(/teardown:\s*'拆书报告'/);
  });
  it('App.tsx 灵感组 soon 占位转正为 mode 且分派 TeardownView（原地替换，不许双入口）', () => {
    expect(app).not.toMatch(/soon-teardown/);
    expect(app).toMatch(/id:\s*'teardown'/);
    expect(app).toMatch(/mode\s*===\s*'teardown'\s*&&\s*<TeardownView/);
    expect(app).toMatch(/case\s*'mode:teardown'/);
  });
  it('CommandPalette 有 mode:teardown 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:teardown'/);
  });
  it('TeardownView 走 sequencer + 零token结构统计秒出 + AI 精读八维 + live/演示明示 + 存入灵感库', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/零\s*token/);
    expect(view).toMatch(/teardown\.structure/);
    expect(view).toMatch(/teardown\.read|精读/);
    expect(view).toMatch(/演示|实时/);
    expect(view).toMatch(/saveDimension|存入灵感库/);
  });
  it('TeardownView 选已导入书只走只读通道（绝不写正文：update/create/import 都不许出现）', () => {
    expect(view).not.toMatch(/chapter\.update|chapter\.create|importMarkdown/);
  });
  // ★ 终审修复波 T5①：saveDim 的 await 后写入要过时效闸——重点「结构统计」换了报告后，
  //   旧 saveDim 的迟到响应不许把新报告的该维标成「已存入」（captured-reportId + ref 口径）。
  it('TeardownView saveDim 有 captured-reportId 时效闸（迟到的旧报告响应不落新报告状态）', () => {
    expect(view).toMatch(/reportIdRef/);
    expect(view).toMatch(/capturedReportId/);
  });
});
