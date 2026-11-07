// tests/integration/p2b-acceptance.test.ts
//
// ★P2-B T7 验收：台账真正进装配（没有这一步，T4/T6 的两页只是装饰品）。
// 真 SQLite 内存库 + migrate（同 pipeline-ctx-canon 的 B 组模式）：
//   upsertForeshadows / upsertCharacters / stateSet 写账 → buildPipelineCtx 读账 →
//   assembleWriterContext 装配——四个场景逐一对着计划的 Step 1 落断言。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ProjectRepo, ChapterRepo } from '@main/db/repos/chapter-repo';
import { LedgerRepo } from '@main/db/repos/ledger-repo';
import { buildPipelineCtx } from '@main/pipeline/ctx';
import { assembleWriterContext, estimateTokens, FORESHADOW_CAP_TOKENS, CAST_CAP_TOKENS } from '@main/pipeline/assemble';
import type { PipelineCtx } from '@shared/types/pipeline';
import type { Foreshadow } from '@shared/types/ledger';

function makeEnv() {
  const db = new Database(':memory:');
  migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/p2b', 300000).id;
  const chapters = new ChapterRepo(db);
  for (let i = 1; i <= 5; i++) chapters.createChapter(pid); // 章 id = '1'..'5'（章号字符串口径）
  const ledgers = new LedgerRepo(db);
  return { db, pid, ledgers };
}

/** 最小可登记的伏笔行：埋设出处指向章 id，其余按测试逐个覆盖 */
function f(id: string, chapterId: string, over: Partial<Foreshadow> = {}): Foreshadow {
  return {
    id,
    plantedAt: { chapterId, offset: 0, quote: '原文短句' },
    plantedQuote: '原文短句',
    resolvedAt: null,
    status: 'unresolved',
    ...over,
  };
}

const budget = (window = 128000, outputReserve = 4000) => ({ window, outputReserve });
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('P2-B 验收：伏笔台账进装配（foreshadow 槽）', () => {
  it('仅未偿条目入账：resolved 不占预算，坏 ref 整行跳过（不虚增），A 排前 C 排后', () => {
    const { db, pid, ledgers } = makeEnv();
    ledgers.upsertForeshadows(pid, [
      f('f-b', '2', { name: '断玉归属', weight: 'B' }),
      f('f-a', '1', { name: '秘境钥匙', weight: 'A' }),
      f('f-c', '3', { name: '路边老槐', weight: 'C' }),
      f('f-done', '1', { name: '已偿之债', weight: 'A', status: 'resolved', resolvedAt: { chapterId: '4', offset: 0, quote: 'r' } }),
      f('f-bad', '999', { name: '埋在不存在的章' }),
      f('f-legacy', '2'), // Agent 旧行：无 name/weight/chain → 未命名·权重B·空链
    ]);
    const ctx = buildPipelineCtx(db, pid);
    // resolved 与坏 ref 都不进账（账面虚增=让模型看到不存在的债）
    expect(ctx.foreshadowLines).toHaveLength(4);
    expect(ctx.foreshadowLines.join('\n')).not.toContain('已偿之债');
    expect(ctx.foreshadowLines.join('\n')).not.toContain('埋在不存在的章');
    // 行模板逐字（计划锁定的口径）：【伏笔】名（埋第N章·权重X）：链
    expect(ctx.foreshadowLines[0]).toBe('【伏笔】秘境钥匙（埋第1章·权重A）：');
    // A→B→C 排序：硬顶从尾部丢 = C 档先落（R25 条目边界）
    const idxA = ctx.foreshadowLines.findIndex((l) => l.includes('权重A'));
    const idxB = ctx.foreshadowLines.findIndex((l) => l.includes('权重B）'));
    const idxC = ctx.foreshadowLines.findIndex((l) => l.includes('权重C'));
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
    const { user, trace } = assembleWriterContext(ctx, budget());
    expect(user).toContain('【伏笔台账】');
    expect(user).toContain('【伏笔】秘境钥匙（埋第1章·权重A）：');
    expect(user).toContain('【伏笔】（未命名）（埋第2章·权重B）：'); // 旧行空态诚实
    expect(user).not.toContain('已偿之债');
    expect(trace.map((t) => t.slot)).toContain('foreshadow');
  });

  it('空账 → 诚实占位行（canon 空态同型文案纪律）', () => {
    const { db, pid } = makeEnv();
    const ctx = buildPipelineCtx(db, pid);
    expect(ctx.foreshadowLines).toEqual([]);
    expect(ctx.castLines).toEqual([]);
    const { user } = assembleWriterContext(ctx, budget());
    expect(user).toContain('【伏笔台账】\n本书暂无未偿伏笔。');
    expect(user).toContain('【人物近况】\n本书暂无人物近况记录。');
  });
});

describe('P2-B 验收：人物近况进装配（cast 槽）', () => {
  it('每人一行·取最大章号快照·knows/notKnows 空态未登记', () => {
    const { db, pid, ledgers } = makeEnv();
    const now = Date.now();
    ledgers.upsertCharacters(pid, [
      { id: 'c-lin', name: '林晚', role: '主角', age: '20', note: '', refs: [], updatedAt: now, knows: ['玉佩是钥匙'], notKnows: ['沈默的身份'] },
      { id: 'c-shen', name: '沈默', role: '配角', age: '25', note: '', refs: [], updatedAt: now },
    ]);
    // 对抗性钉（终审修复波 A）：乱序插入——先第 3 章再第 1 章，证明 ctx 取的是
    // **最大章号**而非插入序（stateList ORDER BY 另由 charstate-repo 独立钉）。
    ledgers.stateSet(pid, 'c-lin', 3, '右手受伤');
    ledgers.stateSet(pid, 'c-lin', 1, '初入城，未觉异常');
    const ctx = buildPipelineCtx(db, pid);
    // 第 3 章（最大章号）盖掉第 1 章；快照带「第N章末：」as-of 锚点（R49：
    // 无锚点写手无法判断快照有多陈旧）；无人物状态卡 → 近况未记（不带锚点）；
    // 无 knows → 未登记
    expect(ctx.castLines).toEqual([
      '林晚：第3章末：右手受伤｜知：玉佩是钥匙｜不知：沈默的身份',
      '沈默：近况未记｜知：未登记｜不知：未登记',
    ]);
    const { user, trace } = assembleWriterContext(ctx, budget());
    expect(user).toContain('【人物近况】\n' + ctx.castLines.join('\n'));
    expect(trace.map((t) => t.slot)).toContain('cast');
  });
});

describe('P2-B 验收：预算挤压（条目级 rank，R25 整条丢）', () => {
  /** 挤压器：槽外全撑爆，逼装配走到 foreshadow 的条目级牺牲 */
  function squeezeCtx(ctx: PipelineCtx): PipelineCtx {
    return {
      ...ctx,
      prevEnding: '衔'.repeat(3000),
      concept: {
        titles: ['t1', 't2', 't3'],
        logline: 'l',
        synopsis: '概'.repeat(400),
        goldenFinger: 'g',
        hooks: Array.from({ length: 5 }, (_, i) => `钩${i}：${'枝'.repeat(100)}`),
      },
    };
  }

  it('紧预算：cast 先落（槽级 rank），C 档伏笔先丢、A 档活到最后（条目级 rank）', () => {
    const { db, pid, ledgers } = makeEnv();
    ledgers.upsertForeshadows(pid, [
      f('f-a', '1', { name: '秘境钥匙', weight: 'A' }),
      f('f-b', '2', { name: '断玉归属', weight: 'B' }),
      ...Array.from({ length: 6 }, (_, i) => f(`f-c${i}`, '3', { name: `点缀${i}`, weight: 'C', chain: '缀'.repeat(120) })),
    ]);
    const now = Date.now();
    ledgers.upsertCharacters(pid, [
      { id: 'c1', name: '林晚', role: '', age: '', note: '', refs: [], updatedAt: now, knows: ['x'] },
      { id: 'c2', name: '沈默', role: '', age: '', note: '', refs: [], updatedAt: now, knows: ['y'] },
      { id: 'c3', name: '老周', role: '', age: '', note: '', refs: [], updatedAt: now },
    ]);
    const base = buildPipelineCtx(db, pid);
    // 未触发硬顶（行数×长度 < 2000 字符）：丢弃必须来自总预算收敛而非硬顶
    expect(base.foreshadowLines.join('\n').length).toBeLessThanOrEqual(Math.floor(FORESHADOW_CAP_TOKENS / 0.6));
    const { user, trace } = assembleWriterContext(squeezeCtx(base), { window: 8600, outputReserve: 8000 });
    expect(estimateTokens(user)).toBeLessThanOrEqual(600);
    // 槽级牺牲序：cast(5) 在 foreshadow(6) 之前被动过
    const firstCast = trace.findIndex((t) => t.slot === 'cast' && t.action !== 'kept');
    const firstFore = trace.findIndex((t) => t.slot === 'foreshadow' && t.action === 'dropped');
    expect(firstCast).toBeGreaterThanOrEqual(0);
    expect(firstFore).toBeGreaterThan(firstCast);
    // 条目级：C 先落，A/B 活到最后
    expect(user).toContain('【伏笔】秘境钥匙');
    expect(user).toContain('【伏笔】断玉归属');
    expect(countOf(user, '权重C')).toBeLessThan(6);
    // 丢的都是整条：留下的行仍以完整模板结尾，没有拦腰截半
    for (const line of user.split('\n').filter((l) => l.startsWith('【伏笔】'))) {
      expect(line).toMatch(/^【伏笔】.+（埋第\d+章·权重[ABC]）：.*$/);
    }
  });

  it('伏笔硬顶：超 1200 tokens 按条目边界丢末位（C 档），首条即超则整槽丢弃不留半条', () => {
    const { db, pid, ledgers } = makeEnv();
    const many = Array.from({ length: 20 }, (_, i) =>
      f(`f-m${i}`, '1', { name: `点缀${i}`, weight: 'C', chain: '长'.repeat(150) }),
    );
    ledgers.upsertForeshadows(pid, [f('f-a', '1', { name: '秘境钥匙', weight: 'A', chain: '主'.repeat(150) }), ...many]);
    const { user, trace } = assembleWriterContext(buildPipelineCtx(db, pid), budget());
    const t = trace.find((x) => x.slot === 'foreshadow' && x.action !== 'kept');
    expect(t).toBeTruthy();
    expect(t!.reason).toContain('硬顶');
    expect(user).toContain('【伏笔】秘境钥匙'); // A 排前 → 硬顶保头 = A 保留
    expect(countOf(user, '【伏笔】')).toBeLessThan(21);

    // 单条即超硬顶：整槽丢弃（trace dropped），user 里连块标题都不该出现
    const env2 = makeEnv();
    env2.ledgers.upsertForeshadows(env2.pid, [f('f-huge', '1', { name: '巨无霸', weight: 'C', chain: '洪'.repeat(3000) })]);
    const huge = assembleWriterContext(buildPipelineCtx(env2.db, env2.pid), budget());
    expect(huge.trace.some((x) => x.slot === 'foreshadow' && x.action === 'dropped')).toBe(true);
    expect(huge.user).not.toContain('【伏笔台账】');
  });

  it('人物近况硬顶：超 1200 tokens 按行边界丢末位人物', () => {
    const { db, pid, ledgers } = makeEnv();
    const now = Date.now();
    ledgers.upsertCharacters(
      pid,
      Array.from({ length: 30 }, (_, i) => ({
        id: `c${i}`,
        name: `人物${i}`,
        role: '',
        age: '',
        note: '',
        refs: [],
        updatedAt: now,
        knows: ['知'.repeat(60)],
      })),
    );
    const ctx = buildPipelineCtx(db, pid);
    expect(ctx.castLines.join('\n').length).toBeGreaterThan(Math.floor(CAST_CAP_TOKENS / 0.6));
    const { user, trace } = assembleWriterContext(ctx, budget());
    const t = trace.find((x) => x.slot === 'cast' && x.action !== 'kept');
    expect(t).toBeTruthy();
    expect(t!.reason).toContain('硬顶');
    expect(user).toContain('人物0：'); // 保头丢尾
    expect(countOf(user, '｜知：')).toBeLessThan(30);

    // 首行即超硬顶：整槽丢弃（trace dropped），块标题也不该出现——半行人物边界比没有更糟
    const env2 = makeEnv();
    env2.ledgers.upsertCharacters(env2.pid, [
      { id: 'c-big', name: '大清单', role: '', age: '', note: '', refs: [], updatedAt: now, knows: ['长'.repeat(3000)] },
    ]);
    const huge = assembleWriterContext(buildPipelineCtx(env2.db, env2.pid), budget());
    expect(huge.trace.some((x) => x.slot === 'cast' && x.action === 'dropped' && x.reason.includes('硬顶'))).toBe(true);
    expect(huge.user).not.toContain('【人物近况】');
  });
});
