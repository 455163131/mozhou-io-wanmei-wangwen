/**
 * `update_ledger` 工具的行为（§4 第 13 条）。
 *
 * 账本"能写"由 ledger-repo.test.ts 钉，"真有人写"由 ledger-write-wiring.test.ts 钉，
 * 本文件钉的是**写进去的东西是不是真的**：出处核验、id 复用、凭空断言被拒。
 *
 * deps 用手搭的真对象（LedgerRepo 走真内存库，正文由本文件提供）——
 * 不 mock 账本本身，否则测的是我写的假 repo。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { LedgerRepo } from '@main/db/repos/ledger-repo';
import { parseNumeric, updateLedger, type UpdateLedgerDeps } from '@main/tools/impl/ledger-update';
import type { ToolContext } from '@shared/types/tool';

const BODY_CH1 = '林渊今年十九岁，怀里揣着一枚铜钥匙。';
const BODY_CH2 = '宗门库房里还有三万五千灵石。';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  // 账本表对外键 REFERENCES projects(id)，测试里固定一个 id 好写断言
  db.prepare(
    'INSERT INTO projects(id, name, root_dir, created_at, updated_at, target_words) VALUES(?,?,?,?,?,?)',
  ).run('prj_t', '测试书', '/tmp/t', 1, 1, 0);
  return db;
}

const ctx = {
  runId: 'run_t',
  stepNo: 1,
  dryRun: false,
  requireCheckpoint: async () => 'ck_t',
  signal: new AbortController().signal,
  logger: () => {},
} as unknown as ToolContext;

let db: DB;
let repo: LedgerRepo;
let deps: UpdateLedgerDeps & { projectId: string | null };

beforeEach(() => {
  db = freshDb();
  repo = new LedgerRepo(db);
  deps = {
    projectId: 'prj_t',
    characters: (p, s) => repo.characters(p, s),
    numbers: (p, s) => repo.numbers(p, s),
    timeline: (p) => repo.timeline(p),
    foreshadows: (p) => repo.foreshadows(p),
    conflicts: () => [],
    upsertLedger: (p, e) => {
      if (e.characters) repo.upsertCharacters(p, e.characters);
      if (e.numbers) repo.upsertNumbers(p, e.numbers);
      if (e.timeline) repo.upsertTimeline(p, e.timeline);
      if (e.foreshadows) repo.upsertForeshadows(p, e.foreshadows);
      return repo.counts(p);
    },
    currentProjectId: () => deps.projectId,
    getBodies: async (ids) => {
      const m = new Map<string, string>();
      if (ids.includes('ch_1')) m.set('ch_1', BODY_CH1);
      if (ids.includes('ch_2')) m.set('ch_2', BODY_CH2);
      return m;
    },
    chapterTitle: (id) => (id === 'ch_1' ? '第一章' : id),
  };
});

const charArg = {
  characters: [{ name: '林渊', age: '19岁', refs: [{ chapterId: 'ch_1', quote: '林渊今年十九岁' }] }],
};

describe('A. parseNumeric：中文写法要能折算，折不出来就是折不出来', () => {
  it('万/千/亿 与纯数字都归一', () => {
    expect(parseNumeric('3.5万')).toBe(35000);
    expect(parseNumeric('1200')).toBe(1200);
    expect(parseNumeric('2千')).toBe(2000);
    expect(parseNumeric('1.2亿')).toBe(120000000);
  });

  it('模型显式给的 numeric 优先于折算', () => {
    expect(parseNumeric('3.5万', 40000)).toBe(40000);
  });

  it('「三千」这种纯汉字写法返回 NaN，由调用方拒（不静默给 0）', () => {
    expect(Number.isNaN(parseNumeric('三千'))).toBe(true);
  });
});

describe('B. 出处核验：这是账本的立身之本', () => {
  it('引文逐字存在 → 落库，offset 由系统回填（模型不可能自己算偏移）', async () => {
    const r = await updateLedger(charArg, ctx, deps);
    expect(r.ok).toBe(true);
    const got = repo.characters('prj_t');
    expect(got).toHaveLength(1);
    expect(got[0]?.refs[0]?.offset).toBe(BODY_CH1.indexOf('林渊今年十九岁'));
    expect(got[0]?.refs[0]?.quote).toBe('林渊今年十九岁');
  });

  it('引文在正文里找不到 → 整批拒绝，一条都不写', async () => {
    const r = await updateLedger(
      { characters: [{ name: '林渊', age: '20岁', refs: [{ chapterId: 'ch_1', quote: '林渊今年二十岁' }] }] },
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('出处核验未通过');
    expect(repo.characters('prj_t')).toEqual([]);
  });

  it('引用的章节不存在 → 同样拒绝（不许拿不存在的章当证据）', async () => {
    const r = await updateLedger(
      { characters: [{ name: '林渊', refs: [{ chapterId: 'ch_9', quote: '随便一句' }] }] },
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('不存在');
  });

  it('一条出处都不给 → 拒绝：凭空断言正是账本要防的', async () => {
    const r = await updateLedger({ characters: [{ name: '林渊', age: '19岁' }] }, ctx, deps);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('出处');
  });
});

describe('C. 登记语义', () => {
  it('同名人物重复登记 = 覆盖，账本里只有一条（id 复用）', async () => {
    await updateLedger(charArg, ctx, deps);
    await updateLedger(
      { characters: [{ name: '林渊', age: '20岁', refs: [{ chapterId: 'ch_1', quote: '林渊今年十九岁' }] }] },
      ctx,
      deps,
    );
    const got = repo.characters('prj_t');
    expect(got).toHaveLength(1);
    expect(got[0]?.age).toBe('20岁');
  });

  it('数字锚点：value 保留「3.5万」原文，numeric 折算成 35000', async () => {
    const r = await updateLedger(
      { numbers: [{ value: '3.5万', subject: '宗门库房', unit: '灵石', refs: [{ chapterId: 'ch_2', quote: '三万五千灵石' }] }] },
      ctx,
      deps,
    );
    expect(r.ok).toBe(true);
    expect(repo.numbers('prj_t')[0]).toEqual(
      expect.objectContaining({ value: '3.5万', numeric: 35000, unit: '灵石' }),
    );
  });

  it('伏笔给了回收位置就自动记成 resolved，不必让模型猜枚举值', async () => {
    const r = await updateLedger(
      {
        foreshadows: [
          {
            plantedChapterId: 'ch_1',
            plantedQuote: '一枚铜钥匙',
            resolvedChapterId: 'ch_2',
            resolvedQuote: '三万五千灵石',
          },
        ],
      },
      ctx,
      deps,
    );
    expect(r.ok).toBe(true);
    const f = repo.foreshadows('prj_t')[0];
    expect(f?.status).toBe('resolved');
    expect(f?.resolvedAt?.chapterId).toBe('ch_2');
  });

  it('返回的条数是整表计数，不是本批条数（UI 刷新要的是"现在有多少"）', async () => {
    await updateLedger(charArg, ctx, deps);
    const r = await updateLedger(
      { timeline: [{ when: '三年前', what: '林家灭门', refs: [{ chapterId: 'ch_1', quote: '一枚铜钥匙' }] }] },
      ctx,
      deps,
    );
    expect(r.data).toEqual(
      expect.objectContaining({ characters: 1, numbers: 0, timeline: 1, foreshadows: 0 }),
    );
  });
});

describe('D. 边界', () => {
  it('未打开项目 → 如实失败，不静默成功', async () => {
    deps.projectId = null;
    const r = await updateLedger(charArg, ctx, deps);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('尚未打开项目');
  });

  it('四类全空 → 拒绝（否则等于给用户一个"登记成功"的假回执）', async () => {
    const r = await updateLedger({}, ctx, deps);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('全空');
  });
});
