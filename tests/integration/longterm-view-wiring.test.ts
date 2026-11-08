// tests/integration/longterm-view-wiring.test.ts
// ★ P2-E ②：长期记忆页接线哨兵（R46 源扫描口径）。
// DRD §4.3 三栏：事件流(按章筛选) / 人物状态投影(当前值) / 章节快报快照(可恢复)。
// 「可恢复」裁决（2026-11-08 老板批准）：复制快照到剪贴板 + 载入人物记忆页既有
// 矩阵编辑器（charstate:set 通道），不新开写语义。数据取数走既有 ledger:query
// （res 扩 timeline/numbers 两路，P2-B「不开平行通道」先例）+ charstate:list。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const ipc = readFileSync('src/shared/types/ipc.ts', 'utf8');
const register = readFileSync('src/main/ipc/register.ts', 'utf8');
const view = readFileSync('src/renderer/components/views/LongTermView.tsx', 'utf8');
const charView = readFileSync('src/renderer/components/views/CharacterView.tsx', 'utf8');
const store = readFileSync('src/renderer/store/index.ts', 'utf8');

describe('长期记忆页接线', () => {
  it('modes.ts 注册 longterm + 四字 label（soon 原地转正）', () => {
    expect(modes).toMatch(/'longterm'/);
    expect(modes).toMatch(/longterm:\s*'长期记忆'/);
  });
  it('App.tsx soon-longterm 原地转正且分派 LongTermView', () => {
    expect(app).not.toMatch(/soon-longterm/);
    expect(app).toMatch(/id:\s*'longterm',\s*label:\s*MODE_LABELS\.longterm/);
    expect(app).toMatch(/mode\s*===\s*'longterm'\s*&&\s*<LongTermView/);
    expect(app).toMatch(/case\s*'mode:longterm'/);
    expect(app).toMatch(/import\s*\{\s*LongTermView\s*\}\s*from\s*'\.\/components\/views\/LongTermView'/);
  });
  it('CommandPalette 有 mode:longterm 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:longterm'/);
  });
  it('ledger:query res 扩 timeline/numbers 两路（零新通道，同一本账）', () => {
    expect(ipc).toMatch(/'ledger:query':\s*\{[^}]*res:\s*\{[^}]*timeline:\s*TimelineEvent\[\][^}]*numbers:\s*NumberAnchor\[\]/);
    expect(register).toMatch(/timeline:\s*s\.timeline\(s\.project\.id\)/);
    expect(register).toMatch(/numbers:\s*s\.numbers\(s\.project\.id\)/);
  });
  it('LongTermView 三栏取数 + 项目门 + 快照复制/载入', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/ledger\.query/);
    expect(view).toMatch(/charstate\.list/);
    expect(view).toMatch(/未打开项目/);
    expect(view).toMatch(/clipboard/);
    expect(view).toMatch(/useSnapshotHandoff/);
    // 三栏语义锚（DRD §4.3）：事件流/投影/快照
    expect(view).toMatch(/事件流/);
    expect(view).toMatch(/投影/);
    expect(view).toMatch(/快照/);
  });
  it('快照交接 store 存在且 CharacterView 消费（载入编辑器不落空）', () => {
    expect(store).toMatch(/useSnapshotHandoff/);
    expect(charView).toMatch(/useSnapshotHandoff/);
    // 消费侧必须开既有 cell 弹窗（预填快照），不是另起一套编辑器
    expect(charView).toMatch(/kind:\s*'cell'/);
  });
});