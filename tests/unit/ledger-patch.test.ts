/**
 * 手改通道 repo 层（P2-B T3）：ledger:patch / ledger:remove 的底座。
 *
 * ★ 为什么 patch 是"白名单合并"而不是"整行覆盖"：作者手改一条伏笔的名字，
 *   不该把 Agent 登记的 plantedAt/refs 一并抹掉——那是共写一本账的底线。
 *   结构字段（id/plantedAt）不在白名单里，索引列（status/name）改时必须与列同步。
 *
 * 真内存库（照 sentinel B 组模式：仓库无 tests/helpers，勿 import 不存在的 helper）。
 * ★ better-sqlite3 默认开着 foreign_keys，ledger_* 外键引用 projects(id)——
 *   两个项目必须先建行（'p1' 本方、'other' 对方），否则 upsert 直接被 FK 拦死。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { LedgerRepo } from '@main/db/repos/ledger-repo';
import { MzError } from '@shared/types/ipc';

const P = 'p1';
const mk = () => {
  const db = new Database(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO projects(id, name, root_dir, created_at, updated_at) VALUES(?,?,?,?,?)');
  ins.run(P, '测试书', '/tmp/p1', 1, 1);
  ins.run('other', '另一本书', '/tmp/other', 1, 1);
  return new LedgerRepo(db);
};

describe('LedgerRepo.patch', () => {
  it('合并进 payload：改 name/weight 不丢 refs 与 plantedAt', () => {
    const r = mk();
    r.upsertForeshadows(P, [{ id: 'f1', plantedAt: { chapterId: 'c1', offset: 3, quote: 'q' }, plantedQuote: 'q', status: 'unresolved', resolvedAt: null }]);
    r.patch(P, 'foreshadow', 'f1', { name: '黑玉簪', weight: 'A' });
    const row = r.foreshadows(P).find((x) => x.id === 'f1')!;
    expect(row.name).toBe('黑玉簪'); expect(row.weight).toBe('A');
    expect(row.plantedAt).toEqual({ chapterId: 'c1', offset: 3, quote: 'q' });
  });
  it('patch 里出现结构字段（id/plantedAt/status）以外的手录键才允许改 payload；status 走列同步', () => {
    const r = mk();
    r.upsertForeshadows(P, [{ id: 'f2', plantedAt: { chapterId: 'c1', offset: 0, quote: 'q' }, plantedQuote: 'q', status: 'unresolved', resolvedAt: null }]);
    r.patch(P, 'foreshadow', 'f2', { status: 'resolved', resolvedAt: { chapterId: 'c5', offset: 1, quote: 'r' } });
    const row = r.foreshadows(P, 'resolved').find((x) => x.id === 'f2')!;
    expect(row.status).toBe('resolved'); expect(row.resolvedAt!.chapterId).toBe('c5');
  });
  it('跨项目 id 拒绝（assertIdNotTakenByOtherProject 同口径的项目域守卫）：patch 他项目行抛 E_NOT_FOUND', () => {
    const r = mk();
    r.upsertForeshadows('other', [{ id: 'f9', plantedAt: { chapterId: 'c1', offset: 0, quote: 'q' }, plantedQuote: 'q', status: 'unresolved', resolvedAt: null }]);
    expect(() => r.patch(P, 'foreshadow', 'f9', { name: 'x' })).toThrow(/E_NOT_FOUND|不存在/);
  });
  it('weight 非法值拒绝（枚举收紧在写侧，库列不加 CHECK）', () => {
    const r = mk();
    r.upsertForeshadows(P, [{ id: 'fw', plantedAt: { chapterId: 'c1', offset: 0, quote: 'q' }, plantedQuote: 'q', status: 'unresolved', resolvedAt: null }]);
    expect(() => r.patch(P, 'foreshadow', 'fw', { weight: 'D' })).toThrow(/E_INVALID_ARGS|非法/);
  });
  it('白名单外的键整批拒绝：结构字段 id/plantedAt 不许经 patch 漂移', () => {
    const r = mk();
    r.upsertForeshadows(P, [{ id: 'fb', plantedAt: { chapterId: 'c1', offset: 0, quote: 'q' }, plantedQuote: 'q', status: 'unresolved', resolvedAt: null }]);
    expect(() => r.patch(P, 'foreshadow', 'fb', { plantedAt: { chapterId: 'c9', offset: 0, quote: 'x' } })).toThrow(/E_INVALID_ARGS|非法|白名单/);
    expect(r.foreshadows(P)[0].plantedAt.chapterId).toBe('c1');
  });
});

describe('LedgerRepo.remove', () => {
  it('删 character 本体行（连带删其 ledger_char_states 的验证在 charstate-repo.test.ts，T5 已闭合）', () => {
    const r = mk();
    r.upsertCharacters(P, [{ id: 'ch1', name: '林晚', role: '女主', age: '26', note: '', refs: [], updatedAt: 1 }]);
    expect(r.remove(P, 'character', 'ch1')).toBe(true);
    expect(r.characters(P)).toHaveLength(0);
    expect(r.remove(P, 'character', 'ch1')).toBe(false);
  });
  // ★P2-B T5 收 T3 minor-2：非法 kind 与 patch 同口径抛 MzError，不再静默 false——
  // "删不动"和"不支持这类"是两回事，压成 false 会把调用方的 bug 吞掉。
  it('非法 kind 抛 E_INVALID_ARGS（与 patch 对齐；handler 层校验维持原样）', () => {
    const r = mk();
    expect(() => r.remove(P, 'bogus' as never, 'x')).toThrowError(/E_INVALID_ARGS|不支持/);
    try {
      r.remove(P, 'constructor' as never, 'x');
      expect.unreachable('原型链上的键不该被当成合法 kind');
    } catch (e) {
      expect((e as MzError).code).toBe('E_INVALID_ARGS');
    }
  });
});

describe('LedgerRepo.patch 的 kind 守卫', () => {
  // ★P2-B T5 收 T3 minor-1：LEDGER_TABLES 是普通对象，`LEDGER_TABLES[kind]` 对
  // 'constructor' 返回 Object 构造器——真值判断会放行。守卫必须用 Object.hasOwn。
  it('原型链键（constructor 等）不是合法 kind：抛 E_INVALID_ARGS 而不是拼进 SQL', () => {
    const r = mk();
    for (const bad of ['constructor', 'toString', '__proto__']) {
      try {
        r.patch(P, bad as never, 'x', { name: 'y' });
        expect.unreachable(`kind=${bad} 不该过守卫`);
      } catch (e) {
        expect((e as MzError).code).toBe('E_INVALID_ARGS');
      }
    }
  });
});
