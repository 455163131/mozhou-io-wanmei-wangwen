// tests/integration/publish-view-wiring.test.ts —— 发布排期页接线（源码钉，P2-D T6）
//
// 口径同 export-view-wiring.test.ts：读源断言「组件文件在、App 接了、面板接了、
// 页面形状守了竞态纪律」。行为不在这里测（publish-ipc.test.ts 直测业务函数）。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/PublishView.tsx', 'utf8');
const css = readFileSync('src/renderer/components/views/PublishView.module.css', 'utf8');

describe('发布排期页接线', () => {
  it('modes.ts 注册 publish + 四字 label「发布排期」', () => {
    expect(modes).toMatch(/'publish'/);
    expect(modes).toMatch(/publish:\s*'发布排期'/);
  });

  it('App.tsx 输出组新增 publish 导航项 + modeHost 渲染 + onRun 合并分派', () => {
    expect(existsSync('src/renderer/components/views/PublishView.tsx')).toBe(true);
    expect(existsSync('src/renderer/components/views/PublishView.module.css')).toBe(true);
    expect(app).toMatch(/kind:\s*'mode',\s*id:\s*'publish',\s*label:\s*MODE_LABELS\.publish/);
    expect(app).toMatch(/import\s*\{\s*PublishView\s*\}\s*from\s*'\.\/components\/views\/PublishView'/);
    expect(app).toMatch(/mode === 'publish' && <PublishView \/>/);
    expect(app).toMatch(/case 'mode:publish'/);
    // 日历 icon 通用几何（brief 逐字）
    expect(app).toMatch(/M8 2v4M16 2v4M3 10h18/);
  });

  it('CommandPalette 有 mode:publish 命令（alias 逐字，无数字快捷键）', () => {
    expect(palette).toMatch(/id:\s*'mode:publish'/);
    expect(palette).toMatch(/切换到 \$\{MODE_LABELS\.publish\}/);
    expect(palette).toMatch(/fa bu pai qi publish schedule/);
    // 不占数字快捷键纪律：mode:publish 条目里不写 keys
    const entry = /id: 'mode:publish'[^\n]*\n/.exec(palette)?.[0] ?? '';
    expect(entry).not.toMatch(/keys:/);
  });

  it('PublishView 竞态形状照 ExportView 纪律：createSequencer + invalidateAction 漏斗 + 五通道调用面', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/invalidateAction/);
    expect(view).toMatch(/publish\.planSave\(/);
    expect(view).toMatch(/publish\.planList\(/);
    expect(view).toMatch(/publish\.queue\(/);
    expect(view).toMatch(/publish\.stage\(/);
    expect(view).toMatch(/publish\.markPublished\(/);
    // 每个 await 回来后判鲜（isCurrent 至少覆盖 load 与 action 两条链）
    expect(view).toMatch(/isCurrent/);
  });

  it('PublishView 要素在位：清洗预览同源 / 人工核对清单 / 标记已发布 confirm / 诚实空态 / P2D-R5 正午换算', () => {
    // 预览与服务端 stage 同函数同入参（clean.ts 契约 1）——客户端 import 同一个 shared 纯函数
    expect(view).toMatch(/cleanForPublish/);
    expect(view).toMatch(/@shared\/publish\/clean/);
    expect(view).toMatch(/人工核对（平台惯例，非机检）|人工核对清单/);
    expect(view).toMatch(/contentNotes/);
    expect(view).toMatch(/标记已发布/);
    expect(view).toMatch(/useConfirm/);
    expect(view).toMatch(/未打开项目/);
    // P2D-R5：起始日落本地正午（12 时）再取 ms
    expect(view).toMatch(/new Date\([^)]*,\s*12\s*\)/);
    expect(view).toMatch(/P2D-R5/);
    // validateChapter 低量文案走真值（schedule.ts 现实现「低于平台目标 N字」由服务端明细带回，页面不另造句）
    expect(view).toMatch(/validateChapter/);
    // 项目作用域（同 ExportView P2D-R3 口径）：键 pid
    expect(view).toMatch(/project\?\.id/);
  });

  it('CSS 全令牌：btnPrimary 一颗实底（census 在册），零裸色', () => {
    expect(css).toMatch(/\.btnPrimary\s*\{/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toMatch(/var\(--mz-accent-ink\)/);
  });

  it('★ T7 BLOCK：暂存态 chip 真源是 queue res 的 staged（杀会话快照假阳性）+ 待排档 + mark 后复取队列', () => {
    // chip 三档从服务端 staged 账本推导（stage/mark 响应只做乐观并显，终局以 refetch 为准）
    expect(view).toMatch(/queue\.staged|stagedMap/);
    expect(view).toMatch(/staged/);
    expect(view).toMatch(/待排/);
    // mark 成功后重走 load 链复同步（refetch 裁决，注释里写明取舍）
    const markBlock = /async function runMark[\s\S]*?\n {2}}/.exec(view)?.[0] ?? '';
    expect(markBlock).toMatch(/await load\(/);
    // 文件头注记不再声称「会话快照是显示真源」
    expect(view).not.toMatch(/暂存态显示是会话快照/);
  });

  it('★ T7 minors：archived 卡文案不称「只读」（如实：队列/暂存面仍可用）+ runMark notice 携序携题', () => {
    expect(view).not.toMatch(/（只读）/);
    expect(view).toMatch(/已归档[\s\S]{0,40}不再出现在默认列表/);
    // notice 用队列 ord + 标题，不裸 id（用户账本里章序和标题才是人话）
    expect(view).toMatch(/\$\{ord\} 章/);
    expect(view).toMatch(/《\$\{title\}》|\$\{title\}/);
  });
});
