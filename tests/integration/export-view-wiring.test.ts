// tests/integration/export-view-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/ExportView.tsx', 'utf8');

describe('导出中心页接线', () => {
  it('modes.ts 注册 export + 四字 label', () => {
    expect(modes).toMatch(/'export'/);
    expect(modes).toMatch(/export:\s*'导出中心'/);
  });
  it('App.tsx soon-export 转正且分派 ExportView', () => {
    expect(app).not.toMatch(/soon-export/);
    expect(app).toMatch(/id:\s*'export'/);
    expect(app).toMatch(/mode\s*===\s*'export'\s*&&\s*<ExportView/);
    expect(app).toMatch(/case\s*'mode:export'/);
  });
  it('CommandPalette 有 mode:export 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:export'/);
  });
  it('ExportView 走三通道 + 预览真字节 + 历史', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/exportArtifact/);
    expect(view).toMatch(/exportPreview/);
    expect(view).toMatch(/exportHistory/);
    expect(view).toMatch(/真字节|预览/);
    expect(view).toMatch(/未打开项目/);
  });
});
