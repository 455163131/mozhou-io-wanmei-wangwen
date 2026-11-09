// tests/integration/review-fix-wiring.test.ts
//
// ★ 审查修复波（2026-11-09）接线哨兵：双轴审查（标准轴/规格轴）落地后要钉住的三处。
//
// F1（严重）：A 批 30s 预算是**总时长**超时，计时器覆盖整个流式读取——健康的慢思考
//   模型（reasoning 动辄 >30s）会被腰斩 → timeout 可重试 → 从零再来 → 必落演示兜底。
//   恰是 E 批「想看思考过程」的那类模型最先被 A 批误杀。改**空闲超时**：每收到一片
//   增量就续命，黑洞端点（一个字节都没有）仍按 timeoutMs 快速失败。
// F4（一般）：GenView run() 包装的成功回执与 refreshDrafts 无项目闸——切项目后迟到的
//   旧书响应会把旧书草稿刷进新书草稿区，状态行还谎报「已生成」。D 批只护了 trace 一件，
//   注释「迟到的响应不许挂到别的书名下」言过其实；本批改 run() 本身，注释才算兑现。
// F5（一般）：拆书页写「钩子样例（引文 ≤32 字，LCS 合规守卫在上游）」——上游那道 LCS
//   只比对 bench+kb（digest.ts），根本不覆盖逐字引文；且限值 20 < 引文 32。文案暗示
//   「引文有守卫把关」是假账。改成如实声明范围。
//
// 诚实纪律锚：不新增通道（invoke 100 / push 18 / CH 40 三本账一枚不动）；
// 不新增实底按钮（SOLID_BUTTON_CENSUS 19）；守卫一律「用户动作赢」——await 回来后
// 只有仍是最新的那一次才许落地。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { IPC_CHANNELS, IPC_PUSH_CHANNELS } from '@shared/types/ipc';
import { INVOKE_CHANNELS, SUBSCRIBE_CHANNELS } from '../../src/preload/api';

const read = (rel: string): string => readFileSync(rel, 'utf8').replace(/\r\n/g, '\n');

const clientSrc = read('src/main/llm/client.ts');
const genSrc = read('src/renderer/components/views/GenView.tsx');
const teardownSrc = read('src/renderer/components/views/TeardownView.tsx');
const digestSrc = read('src/main/tools/impl/digest.ts');

describe('A. F1：流式改空闲超时（有增量就续命，黑洞仍快速失败）', () => {
  it('chatOnce 把「续命」回调交给 parseStream，且每次读到一个数据块都调用它', () => {
    // 计时器不再是「一锤子 abort」：必须有可重复 arm 的形态
    expect(clientSrc).toMatch(/function arm|const arm = /);
    expect(clientSrc).toMatch(/clearTimeout\(timer\)[\s\S]{0,200}setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
    // parseStream 收一个 activity 参数，读到分片即续命
    expect(clientSrc).toMatch(/private async parseStream\([\s\S]*?onActivity[\s\S]*?\)/);
    expect(clientSrc).toMatch(/await reader\.read\(\);[\s\S]{0,220}onActivity\?\.\(\)/);
  });

  it('非流式路径不续命（总时长语义不动），且调用方 signal 的 abort 监听仍被摘除', () => {
    const at = clientSrc.indexOf('if (req.stream)');
    expect(at).toBeGreaterThan(-1);
    const block = clientSrc.slice(at, at + 400);
    expect(block).toMatch(/return await this\.parseStream\(res, wallMs, req\.onDelta, arm\)/);
    expect(block).not.toMatch(/arm\(\)/);
    // 卸载监听：finally 里 removeEventListener（旧口径只在 addEventListener 处 { once: true }）
    expect(clientSrc).toMatch(/removeEventListener\('abort', onAbort\)/);
  });

  it('超时错误文案说清是「多久没动静」（空闲语义，不再冒充总时长）', () => {
    expect(clientSrc).toMatch(/无响应|未收到任何/);
    expect(clientSrc).toMatch(/timeoutMs\}ms/);
  });
});

describe('B. F4：GenView run() 成功/失败回执带项目闸（用户动作赢）', () => {
  it('run() 起手记 pid，await fn() 回来后判仍是当前项目才许写成功文案与刷草稿', () => {
    const at = clientAnchor(genSrc, 'const run = useCallback');
    const body = genSrc.slice(at, at + 1600);
    expect(body).toMatch(/const startedAtPid = pid;/);
    expect(body).toMatch(/await fn\(\);/);
    expect(body).toMatch(
      /if \(useProjectStore\.getState\(\)\.project\?\.id !== startedAtPid\) return;\s*\n\s*setProgress\(okMsg\);/,
    );
    expect(body).toMatch(/useProjectStore\.getState\(\)\.project\?\.id !== startedAtPid\) return;\s*\n\s*setProgress\(`失败/);
  });

  it('负对照：run() 不新增按钮、不新增通道调用形态（只加闸，不改面）', () => {
    const at = clientAnchor(genSrc, 'const run = useCallback');
    const body = genSrc.slice(at, at + 900);
    expect(body).not.toMatch(/<button/);
    expect(body).not.toMatch(/btnPrimary/);
  });

  it('D 批 trace 守卫仍在原位（本批不回收已落地的闸）', () => {
    expect(genSrc).toMatch(/if \(useProjectStore\.getState\(\)\.project\?\.id !== pid\) return;\s*\n\s*setDraftTrace\(r\.trace\)/);
  });
});

describe('C. F5：拆书「引文/LCS 守卫」口径如实（假账不许留在文案里）', () => {
  it('TeardownView 不再写「LCS 合规守卫在上游」，改说守卫的真实覆盖范围', () => {
    expect(teardownSrc).not.toContain('LCS 合规守卫在上游');
    expect(teardownSrc).toMatch(/逐字摘录[\s\S]{0,80}未纳入|未纳入[\s\S]{0,40}LCS/);
  });

  it('digest 合规 note 限定范围：说的是统计与参数卡，不是整份报告', () => {
    expect(digestSrc).toMatch(/统计与参数卡未照抄原文/);
    expect(digestSrc).toMatch(/统计与参数卡疑似照抄原文/);
    // 负对照：不带范围限定的裸「未照抄原文」结论不许再出现
    expect(digestSrc).not.toMatch(/，未照抄原文。/);
  });

  it('teardown-service 给模型的引文标签保住真实上界 ≤32（本批只改口径不改数值）', () => {
    const svc = read('src/main/inspiration/teardown-service.ts');
    expect(svc).toMatch(/各 ≤32 字/);
    expect(svc).not.toMatch(/≤16 字/);
  });
});

describe('D. 负对照：三本通道账 + 实底按钮台账一枚不动', () => {
  it('invoke 100 / push 18 / sentinel CH 40 / census 19', () => {
    expect(IPC_CHANNELS).toHaveLength(100);
    expect([...IPC_CHANNELS].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(IPC_PUSH_CHANNELS).toHaveLength(18);
    expect(SUBSCRIBE_CHANNELS).toHaveLength(18);
    const sentinel = read('tests/integration/pipeline-ipc-sentinel.test.ts');
    const m = sentinel.match(/const CH = \[([^\]]+)\]/);
    expect(m![1].split(',')).toHaveLength(40);
    const census = read('tests/unit/p2ui-t4-smoke-fixes.test.ts');
    const c = census.match(/const SOLID_BUTTON_CENSUS = \[([\s\S]*?)\];/);
    expect((c![1].match(/'[^']+'/g) ?? [])).toHaveLength(19);
  });
});

/** 取源码局部窗口：锚点找不到就抛，避免「全文命中即通过」这种最容易骗过人的断言 */
function clientAnchor(src: string, anchor: string): number {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`锚点未找到：${anchor}`);
  return i;
}
