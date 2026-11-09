// tests/integration/trending-import-wiring.test.ts
//
// ★ C批「榜单手动导入」接线哨兵（R46 源扫描口径，照 llm-progress-wiring 模式）。
//
// 背景：三站礼貌直抓太脆（晋江 robots 禁止、起点 robots 不可读→按禁止处理），
// 老板批准加**手动导入**：粘贴文本/CSV → 趋势卡诚实标「手动导入」——
// 绝不标「实时」（没抓就是没抓），也绝不标「演示」（数据是老板自己贴的真榜单）。
//
// 诚实纪律锚：
//   - 通道四处齐改（ipc.ts 类型+清单 / preload api 签名+白名单 / index 实现 / register 委托），
//     少一处就是运行时静默拒绝（本仓反复出的事故形状，sentinel 同款钉法）；
//   - 解析器纯原创、live=false + manual=true；解析失败抛真因，不静默回 []；
//   - UI：manual 徽标独立一档（badgeManual），导入按钮走描边 styles.btn（不新增实底 CTA，
//     SOLID_BUTTON_CENSUS 保持 19）；异步导入过 loadSeqRef sequencer，迟到的导入不许盖新抓取；
//   - 负对照：manual 条目在任何消费页都不许落到「实时 / 演示数据」标签。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { IPC_CHANNELS, IPC_PUSH_CHANNELS } from '@shared/types/ipc';
import { INVOKE_CHANNELS, SUBSCRIBE_CHANNELS } from '../../src/preload/api';

const read = (rel: string): string => readFileSync(rel, 'utf8').replace(/\r\n/g, '\n');

const ipcSrc = read('src/shared/types/ipc.ts');
const apiSrc = read('src/preload/api.ts');
const indexSrc = read('src/preload/index.ts');
const registerSrc = read('src/main/ipc/register.ts');
const handlerSrc = read('src/main/inspiration/inspiration-ipc.ts');
const parserSrc = read('src/main/inspiration/chart-manual.ts');
const viewSrc = read('src/renderer/components/views/TrendingView.tsx');
const viewCss = read('src/renderer/components/views/TrendingView.module.css');
const poolSrc = read('src/renderer/components/views/InspirationPoolView.tsx');
const poolCss = read('src/renderer/components/views/InspirationPoolView.module.css');

describe('A. trending:import 四处齐备 + 通道账（99→100，push 18 不动）', () => {
  it('shared/types/ipc.ts：IpcInvokeMap 契约 + IPC_CHANNELS 清单都有', () => {
    expect(ipcSrc).toMatch(/'trending:import':\s*\{\s*req:\s*\{\s*platform:\s*Platform;\s*text:\s*string\s*\};\s*res:\s*ChartFetchResult\s*\}/);
    expect(IPC_CHANNELS as readonly string[]).toContain('trending:import');
  });

  it('preload/api.ts：importChart 方法签名 + INVOKE_CHANNELS 白名单都有', () => {
    expect(apiSrc).toMatch(/importChart\(/);
    expect(apiSrc).toMatch(/IpcInvokeMap\['trending:import'\]\['req'\]\['platform'\]/);
    expect(INVOKE_CHANNELS as readonly string[]).toContain('trending:import');
  });

  it('preload/index.ts：桥实现转发 trending:import（漏这里=方法存在但运行时 undefined）', () => {
    expect(indexSrc).toMatch(/importChart:\s*\(platform,\s*text\)\s*=>\s*invoke\('trending:import',\s*\{\s*platform,\s*text\s*\}\)/);
  });

  it('main/ipc/register.ts：一行式委托 importTrending（业务口径全在 inspiration-ipc）', () => {
    expect(registerSrc).toMatch(/handle\('trending:import',\s*async \(p, s\) => inspirationIpc\.importTrending\(inspDeps\(s\), p\), services\)/);
  });

  it('invoke 通道两份清单同集合且共 100 枚（99+1）；push 保持 18 不动', () => {
    expect(IPC_CHANNELS).toHaveLength(100);
    expect(INVOKE_CHANNELS).toHaveLength(100);
    expect([...IPC_CHANNELS].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(IPC_PUSH_CHANNELS).toHaveLength(18);
    expect(SUBSCRIBE_CHANNELS).toHaveLength(18);
  });

  it('sentinel CH 台账补登 trending:import（39→40）', () => {
    const sentinel = read('tests/integration/pipeline-ipc-sentinel.test.ts');
    expect(sentinel).toContain("'trending:import'");
    expect(sentinel).toMatch(/总 40 通道/);
  });
});

describe('B. 解析器与 handler：诚实纪律', () => {
  it('chart-manual.ts：原创纯解析（不 import chart-parse 私有工具）；导出 parseManualChart', () => {
    expect(parserSrc).toMatch(/export function parseManualChart\(platform: Platform, text: string\): ChartEntry\[\]/);
    expect(parserSrc).not.toMatch(/from\s+'\.\/chart-parse'/);
    expect(parserSrc).toMatch(/const MAX_ENTRIES = 200/);
    expect(parserSrc).toMatch(/手动导入超出上限：最多 \$\{MAX_ENTRIES\} 条/);
    expect(parserSrc).toContain('手动导入解析失败：未识别到任何书目');
    expect(parserSrc).toMatch(/live: false/);
    expect(parserSrc).toMatch(/manual: true/);
  });

  it('importTrending：zod 门口拦（text ≤100000）；sourceKey 用 manual| 前缀且 url 不入键', () => {
    expect(handlerSrc).toMatch(/export async function importTrending\(/);
    expect(handlerSrc).toMatch(/text: z\.string\(\)\.min\(1\)\.max\(100_000\)/);
    expect(handlerSrc).toMatch(/manual\|\$\{platform\}\|\$\{entry\.title\}\|\$\{entry\.author\}/);
    expect(handlerSrc).toContain('·手动导入');
    expect(handlerSrc).toMatch(/source: 'manual'/);
  });

  it('createTopicFromCard：manual 分支先于演示分支（【手动导入】不被【演示数据】冒领）', () => {
    const manualAt = handlerSrc.indexOf('【手动导入】');
    const demoAt = handlerSrc.indexOf('【演示数据】');
    expect(manualAt).toBeGreaterThan(-1);
    expect(demoAt).toBeGreaterThan(-1);
    expect(manualAt).toBeLessThan(demoAt);
    expect(handlerSrc).toMatch(/p\.manual === true/);
  });
});

describe('C. TrendingView：导入面板 + 诚实徽标 + 竞态守卫', () => {
  it('textarea + importChart 调用 + 导入按钮走描边 styles.btn（不新增实底 CTA）', () => {
    expect(viewSrc).toMatch(/<textarea/);
    expect(viewSrc).toMatch(/trending\.importChart\(platform, importText\)/);
    expect(viewSrc).toContain('导入为榜单');
    // 导入按钮那一段必须用 styles.btn（描边），不是 btnPrimary（实底台账保持 19）
    const btnAt = viewSrc.indexOf('导入为榜单');
    const segment = viewSrc.slice(Math.max(0, btnAt - 400), btnAt);
    expect(segment).toMatch(/className=\{styles\.btn\}/);
    expect(segment).not.toMatch(/btnPrimary/);
  });

  it('导入过 loadSeqRef sequencer：await 后（含 catch/finally）判 isCurrent 才落状态', () => {
    const at = viewSrc.indexOf('async function importChart');
    expect(at).toBeGreaterThan(-1);
    const body = viewSrc.slice(at, viewSrc.indexOf('\n  }', at));
    expect(body).toMatch(/loadSeqRef\.current\.next\(\)/);
    expect(body).toMatch(/try \{[\s\S]*isCurrent\(seq\)[\s\S]*\} catch[\s\S]*isCurrent\(seq\)[\s\S]*\} finally[\s\S]*isCurrent\(seq\)/);
    expect(body).toContain('非实时抓取');
  });

  it('徽标三态：manual→badgeManual「手动导入」先判；live→实时；demo→演示数据（负对照：manual 不落两旧档）', () => {
    expect(viewSrc).toMatch(/result\.source === 'manual' \? styles\.badgeManual/);
    expect(viewSrc).toMatch(/result\.source === 'manual' \? '手动导入' : isLive \? '实时' : '演示数据'/);
    expect(viewCss).toMatch(/\.badgeManual\s*\{/);
    // badgeManual 只走令牌（无裸 hex 色），与 badgeDemo 同形不同档
    const block = viewCss.slice(viewCss.indexOf('.badgeManual'));
    const body = block.slice(0, block.indexOf('}') + 1);
    expect(body).toMatch(/var\(--mz-/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('fallbackNote 只给 demo（manual 没有「回落真因」一说）；副题如实提手动导入', () => {
    expect(viewSrc).toMatch(/result\.source === 'demo' && result\.error/);
    expect(viewSrc).toMatch(/支持手动导入/);
  });
});

describe('D. 灵感池消费侧：manual 卡标「手动导入」，不冒领「演示数据」', () => {
  it('isManual 判定 + manualTag 渲染；isDemo 排除 manual（负对照）', () => {
    expect(poolSrc).toMatch(/function isManual\(/);
    expect(poolSrc).toMatch(/manual === true/);
    expect(poolSrc).toMatch(/isManual\(c\) && <span className=\{styles\.manualTag\}>手动导入<\/span>/);
    // isDemo 函数体必须先排除 manual，再看 live——否则手动导入卡被误标演示
    const at = poolSrc.indexOf('function isDemo');
    const body = poolSrc.slice(at, poolSrc.indexOf('\n}', at));
    expect(body).toMatch(/isManual/);
    expect(poolCss).toMatch(/\.manualTag\s*\{/);
  });
});