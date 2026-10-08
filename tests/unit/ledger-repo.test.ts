/**
 * 账本落库（§4 第 13 条）。
 *
 * ★ 修复前的现状（全部实测，不是推测）：
 *   · `services.ts` 里四个 `memCharacters/memNumbers/memTimeline/memForeshadows`
 *     是 `Map<string, T[]>`，全仓**没有任何 `.set()` 调用点** → 会话内也恒为空；
 *   · `db/migrate.ts` 的 `ledger_*` 五张表只有 DDL，没有 repo；
 *   · `handle('ledger:upsert', (p) => p.character)` 是个**回显桩**——参数原样返回，一个字都没写进库。
 *   所以本文件测的是"从无到有"的写入语义。
 *
 * ★ 语义选择（写下来，免得后人以为随手如此）：
 *   · 实体整体以 JSON 存进 `payload`，另把用于过滤/索引的字段（name/subject/when/status/
 *     planted_chapter）拆成真实列——索引列存在的意义就是能被索引，只存 payload 等于白建表。
 *   · upsert 以 `id` 为主键：同 id 覆盖，不追加。账本条目是"事实"，同一事实修订两次应该收敛。
 *   · 一批要么全写要么全不写（单事务）：半张人物卡比没登记更糟，`query_ledger` 会把它当既成事实引用。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { nextId } from '@shared/util/id';
import { LedgerRepo } from '@main/db/repos/ledger-repo';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import type { CharacterProfile, Foreshadow, NumberAnchor, TimelineEvent } from '@shared/types/ledger';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

let db: DB;
let ledger: LedgerRepo;
let pid: string;
let otherPid: string;

beforeEach(() => {
  db = freshDb();
  const projects = new ProjectRepo(db);
  ledger = new LedgerRepo(db);
  pid = projects.create('测试书', '/tmp/a').id;
  otherPid = projects.create('另一本书', '/tmp/b').id;
});

const ref = (chapterId: string, quote: string) => ({ chapterId, offset: 0, quote });

function character(over: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    id: nextId('chr'),
    name: '林渊',
    role: '主角',
    age: '19岁',
    note: '沉默寡言',
    refs: [ref('ch_1', '林渊今年十九岁')],
    updatedAt: 1700000000000,
    ...over,
  };
}

function number(over: Partial<NumberAnchor> = {}): NumberAnchor {
  return {
    id: nextId('num'),
    value: '3.5万',
    numeric: 35000,
    unit: '灵石',
    subject: '宗门库房',
    refs: [ref('ch_2', '库房里还有三万五千灵石')],
    ...over,
  };
}

function event(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: nextId('tl'),
    when: '三年前',
    what: '林家灭门',
    refs: [ref('ch_3', '三年前的那场大火')],
    ...over,
  };
}

function foreshadow(over: Partial<Foreshadow> = {}): Foreshadow {
  return {
    id: nextId('fs'),
    plantedAt: ref('ch_4', '那枚铜钥匙一直揣在他怀里'),
    plantedQuote: '铜钥匙',
    resolvedAt: null,
    status: 'unresolved',
    ...over,
  };
}

describe('A. 空库读取：四个 list 返回空数组而不是 undefined/抛', () => {
  it('人物/数字/时间线/伏笔全为空', () => {
    expect(ledger.characters(pid)).toEqual([]);
    expect(ledger.numbers(pid)).toEqual([]);
    expect(ledger.timeline(pid)).toEqual([]);
    expect(ledger.foreshadows(pid)).toEqual([]);
  });
});

describe('B. 人物卡', () => {
  it('写入后逐字段读回，refs 数组原样保真', () => {
    const c = character();
    expect(ledger.upsertCharacters(pid, [c])).toBe(1);
    const got = ledger.characters(pid);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(c);
  });

  it('同 id 再写是覆盖不是追加（账本条目要收敛）', () => {
    const c = character();
    ledger.upsertCharacters(pid, [c]);
    ledger.upsertCharacters(pid, [{ ...c, age: '20岁', updatedAt: 1700000009999 }]);
    const got = ledger.characters(pid);
    expect(got).toHaveLength(1);
    expect(got[0]?.age).toBe('20岁');
    expect(got[0]?.updatedAt).toBe(1700000009999);
  });

  it('subject 按名字模糊过滤，空串不过滤', () => {
    ledger.upsertCharacters(pid, [character({ name: '林渊' }), character({ name: '苏晚' })]);
    expect(ledger.characters(pid, '林').map((c) => c.name)).toEqual(['林渊']);
    expect(ledger.characters(pid, '')).toHaveLength(2);
    expect(ledger.characters(pid, '不存在的人')).toEqual([]);
  });

  it('过滤走的是真实列而不是 payload：库里 name 列必须是明文', () => {
    ledger.upsertCharacters(pid, [character({ name: '林渊' })]);
    const row = db.prepare('SELECT name, payload FROM ledger_characters').get() as {
      name: string;
      payload: string;
    };
    expect(row.name).toBe('林渊');
    expect(JSON.parse(row.payload).name).toBe('林渊');
  });
});

describe('C. 数字锚点 / 时间线 / 伏笔', () => {
  it('数字按 subject 过滤，value 的中文写法与归一值都不丢', () => {
    ledger.upsertNumbers(pid, [number(), number({ subject: '主角年龄', value: '19', numeric: 19, unit: '岁' })]);
    const mine = ledger.numbers(pid, '宗门库房');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual(expect.objectContaining({ value: '3.5万', numeric: 35000, unit: '灵石' }));
    expect(ledger.numbers(pid)).toHaveLength(2);
  });

  it('时间线按写入顺序读回，when 落真实列', () => {
    ledger.upsertTimeline(pid, [event({ when: '第一天' }), event({ when: '第七天' })]);
    expect(ledger.timeline(pid).map((t) => t.when)).toEqual(['第一天', '第七天']);
    const n = db.prepare('SELECT COUNT(*) AS n FROM ledger_timeline WHERE "when" = ?').get('第七天') as { n: number };
    expect(n.n).toBe(1);
  });

  it('伏笔可按 status 过滤，planted_chapter 落列供跨章对账', () => {
    ledger.upsertForeshadows(pid, [
      foreshadow({ status: 'unresolved' }),
      foreshadow({ status: 'resolved', plantedAt: ref('ch_9', '伏笔'), resolvedAt: ref('ch_20', '回收') }),
    ]);
    expect(ledger.foreshadows(pid, 'unresolved')).toHaveLength(1);
    expect(ledger.foreshadows(pid, 'resolved')[0]?.resolvedAt?.chapterId).toBe('ch_20');
    expect(ledger.foreshadows(pid)).toHaveLength(2);
    const row = db
      .prepare('SELECT planted_chapter FROM ledger_foreshadows WHERE status = ?')
      .get('unresolved') as { planted_chapter: string };
    expect(row.planted_chapter).toBe('ch_4');
  });

  it('未登记的 suspected 状态读得到（三态都要能落库）', () => {
    ledger.upsertForeshadows(pid, [foreshadow({ status: 'suspected' })]);
    expect(ledger.foreshadows(pid, 'suspected')).toHaveLength(1);
  });
});

describe('D. 原子性与拒非法', () => {
  it('一批里有一条非法 → 整批不写（半张人物卡比没登记更糟）', () => {
    const bad = { ...character(), name: '   ' };
    expect(() => ledger.upsertCharacters(pid, [character(), bad])).toThrow(/人物名/);
    expect(ledger.characters(pid)).toEqual([]);
  });

  it('空 id / 非字符串 id 直接拒，不能让主键变成空串', () => {
    expect(() => ledger.upsertCharacters(pid, [{ ...character(), id: '' }])).toThrow(/id/);
    expect(() => ledger.upsertNumbers(pid, [{ ...number(), id: '   ' }])).toThrow(/id/);
  });

  it('伏笔状态不在三态之内要拒（写错一个字母就会永远过滤不出来）', () => {
    expect(() => ledger.upsertForeshadows(pid, [foreshadow({ status: 'open' as Foreshadow['status'] })])).toThrow(
      /status/,
    );
  });

  it('空数组是合法的空操作，返回 0 且不抛', () => {
    expect(ledger.upsertCharacters(pid, [])).toBe(0);
    expect(ledger.upsertTimeline(pid, [])).toBe(0);
  });
});

describe('E. 项目隔离与外键', () => {
  it('不同项目的账本互不可见', () => {
    ledger.upsertCharacters(pid, [character()]);
    expect(ledger.characters(otherPid)).toEqual([]);
  });

  it('同一 id 属于别的项目时拒绝，不许把别人的条目搬过来', () => {
    const c = character();
    ledger.upsertCharacters(pid, [c]);
    expect(() => ledger.upsertCharacters(otherPid, [c])).toThrow(/不属于/);
    expect(ledger.characters(pid)[0]?.name).toBe('林渊');
    expect(ledger.characters(otherPid)).toEqual([]);
  });

  it('项目不存在 → 外键拦住（账本必须挂在真实项目上）', () => {
    expect(() => ledger.upsertCharacters('prj_不存在', [character()])).toThrow();
  });
});

describe('F. 迁移与重复写', () => {
  it('重复 migrate 幂等：账本数据不丢、版本不再前进', () => {
    ledger.upsertNumbers(pid, [number()]);
    const before = db.pragma('user_version', { simple: true }) as number;
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(before);
    expect(ledger.numbers(pid)).toHaveLength(1);
  });

  it('批量写多条一次落库，条数与读回一致', () => {
    const many = Array.from({ length: 12 }, (_, i) => character({ name: `人物${i}` }));
    expect(ledger.upsertCharacters(pid, many)).toBe(12);
    expect(ledger.characters(pid)).toHaveLength(12);
  });
});
