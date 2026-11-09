// tests/unit/inspiration-ipc.test.ts —— P2-C T2 五通道业务函数（真库 :memory:，不 mock ipcMain）
// 口径同 sentinel B/C/D 组：register.ts 只做一行式委托，行为用例直调 inspiration-ipc 函数。
// trending:fetch 用假 ChartDataSource 注入——单测绝不碰真实网络（F3）。
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { TopicRepo } from '@main/db/repos/topic-repo';
import {
  fetchTrending,
  importTrending,
  listCards,
  collectCard,
  removeCard,
  createTopicFromCard,
  type InspirationIpcDeps,
} from '@main/inspiration/inspiration-ipc';
import { MzError } from '@shared/types/ipc';
import type { ChartDataSource } from '@main/inspiration/chart-source';
import type { ChartEntry, ChartFetchResult, TrendPayload } from '@shared/types/inspiration';

let db: ReturnType<typeof Database>;
let deps: InspirationIpcDeps;
let lastPlatform: string | null;
const fakeCharts: ChartDataSource = {
  async fetch(platform) {
    lastPlatform = platform;
    return { entries: [], source: 'demo', error: '测试假源' } satisfies ChartFetchResult;
  },
};

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  lastPlatform = null;
  deps = { inspiration: new InspirationRepo(db), topics: new TopicRepo(db), charts: fakeCharts };
});

describe('inspiration-ipc', () => {
  it('fetchTrending：platform 过 zod 枚举后委托 chart source；非法 platform → E_INVALID_ARGS', async () => {
    const r = await fetchTrending(deps, { platform: '晋江' });
    expect(lastPlatform).toBe('晋江');
    expect(r.source).toBe('demo');
    await expect(fetchTrending(deps, { platform: '刺猬猫' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(lastPlatform).toBe('晋江'); // 非法值没有触达数据源
  });

  it('listCards：kind 直连 listByKind；collected 走 listCollected；非法 kind → E_INVALID_ARGS', () => {
    deps.inspiration.insert({ kind: 'trend', title: '书A', payload: { platform: '番茄', live: false }, sourceLabel: '番茄' });
    const b = deps.inspiration.insert({ kind: 'idea', title: '脑洞B', payload: { direction: 'd', premise: 'p', temperature: 1, live: false }, sourceLabel: 'd' });
    deps.inspiration.setCollected(b.id, true);
    expect(listCards(deps, { kind: 'trend' }).map((c) => c.title)).toEqual(['书A']);
    expect(listCards(deps, { kind: 'collected' }).map((c) => c.id)).toEqual([b.id]);
    expect(() => listCards(deps, { kind: 'bogus' })).toThrowError(MzError);
  });

  it('collectCard / removeCard：收藏置 true 回卡；删除幂等回布尔；cardId 非字符串 → E_INVALID_ARGS', () => {
    const c = deps.inspiration.insert({ kind: 'trend', title: '书C', payload: { platform: '起点', live: false }, sourceLabel: '起点' });
    expect(collectCard(deps, { cardId: c.id }).collected).toBe(1);
    expect(removeCard(deps, { cardId: c.id })).toBe(true);
    expect(removeCard(deps, { cardId: c.id })).toBe(false);
    expect(() => collectCard(deps, { cardId: 123 })).toThrowError(MzError);
  });

  it('collectCard：卡不存在 → E_NOT_FOUND（repo 抛，原样出去，不静默）', () => {
    const e = (() => { try { collectCard(deps, { cardId: 'ic-不存在' }); return null; } catch (err) { return err as MzError; } })();
    expect(e).toBeInstanceOf(MzError);
    expect(e!.code).toBe('E_NOT_FOUND');
  });

  it('createTopicFromCard：trend 卡 premise = 书名＋tags 拼一句，sourceCardId 挂钩，状态待立项', () => {
    const c = deps.inspiration.insert({
      kind: 'trend',
      title: '长河渡口',
      payload: { platform: '番茄', tags: ['现实', '群像'], live: true },
      sourceLabel: '番茄',
    });
    const t = createTopicFromCard(deps, { cardId: c.id });
    expect(t.title).toBe('长河渡口');
    expect(t.premise).toContain('长河渡口');
    expect(t.premise).toContain('现实');
    expect(t.premise).toContain('群像');
    expect(t.sourceCardId).toBe(c.id);
    expect(t.status).toBe('待立项');
  });

  // ★ 终审修复波 A：演示 trend 卡（live=false）不许谎称「从X热榜套用」的真实榜单来源——
  //   premise 必须带【演示数据】标记；live:true 卡保持原措辞逐字不变（现网口径钉）。
  it('createTopicFromCard：trend 演示卡（live=false）premise 带【演示数据】标记、不冒充热榜；live=true 保持原措辞', () => {
    const demo = deps.inspiration.insert({
      kind: 'trend',
      title: '演示书',
      payload: { platform: '番茄', tags: ['悬疑'], live: false },
      sourceLabel: '番茄',
    });
    const t1 = createTopicFromCard(deps, { cardId: demo.id });
    expect(t1.premise).toContain('【演示数据】');
    expect(t1.premise).toContain('（悬疑）');
    expect(t1.premise).not.toContain('热榜');
    const live = deps.inspiration.insert({
      kind: 'trend',
      title: '实时书',
      payload: { platform: '晋江', live: true },
      sourceLabel: '晋江',
    });
    const t2 = createTopicFromCard(deps, { cardId: live.id });
    expect(t2.premise).toBe('榜单观察：《实时书》——从晋江热榜套用的趋势选题');
  });

  it('createTopicFromCard：idea 卡取 payload.premise；teardown 卡取 payload.summary', () => {
    const idea = deps.inspiration.insert({ kind: 'idea', title: '脑洞D', payload: { direction: '系统流', premise: '一句前提', temperature: 1, live: false }, sourceLabel: '系统流' });
    expect(createTopicFromCard(deps, { cardId: idea.id }).premise).toBe('一句前提');
    const td = deps.inspiration.insert({ kind: 'teardown', title: '拆书E', payload: { dimension: '节奏', summary: '摘要一句', bookTitle: '范文', reportId: 'td-1' }, sourceLabel: '范文' });
    expect(createTopicFromCard(deps, { cardId: td.id }).premise).toBe('摘要一句');
  });

  it('createTopicFromCard：卡不存在 → E_NOT_FOUND（真因直报，不落半程 topic）', () => {
    const e = (() => { try { createTopicFromCard(deps, { cardId: 'ic-不存在' }); return null; } catch (err) { return err as MzError; } })();
    expect(e).toBeInstanceOf(MzError);
    expect(e!.code).toBe('E_NOT_FOUND');
    expect(deps.topics.listByStatus()).toHaveLength(0);
  });
});

/* ── P2-C T3a（R9）：trending:fetch 幂等落库 trend 卡 + 回填 cardId ──
 * 假 ChartDataSource 返回固定条目（无网络）；真库 :memory:。
 * 口径：dedup key = platform|url（url 空 → platform|title|author），存 payload.sourceKey；
 * 命中旧卡原样返回（热度刷新不改写旧卡——卡=首抓快照，UI 展示当次热度）。 */
describe('fetchTrending 落库 + 幂等（R9/T3a）', () => {
  const entryA = (): ChartEntry => ({
    rank: 1, title: '长河渡口', author: '驿舟子', platform: '番茄',
    heat: 326000, tags: ['现实', '群像'], url: 'https://fanqienovel.com/book/a', live: true,
  });
  const entryB = (): ChartEntry => ({
    rank: 2, title: '守夜灯塔修补匠', author: '迟迟雨', platform: '番茄',
    heat: null, tags: ['悬疑'], url: 'https://fanqienovel.com/book/b', live: true,
  });

  function fakeSource(entries: ChartEntry[], source: 'live' | 'demo' = 'live'): ChartDataSource {
    return { async fetch() { return { entries, source } satisfies ChartFetchResult; } };
  }

  it('① 每条 entry 落 kind=trend 卡并回填 cardId；get(cardId) 可读且 payload 带 sourceKey', async () => {
    deps.charts = fakeSource([entryA(), entryB()]);
    const r = await fetchTrending(deps, { platform: '番茄' });
    expect(r.entries).toHaveLength(2);
    for (const e of r.entries) {
      expect(typeof e.cardId).toBe('string');
      expect(e.cardId!.length).toBeGreaterThan(0);
      const card = deps.inspiration.get(e.cardId!);
      expect(card).not.toBeNull();
      expect(card!.kind).toBe('trend');
      expect(card!.title).toBe(e.title);
      expect(card!.sourceLabel).toBe('番茄');
      const p = card!.payload as TrendPayload;
      expect(p.platform).toBe('番茄');
      expect(p.live).toBe(true);
      expect(p.sourceKey).toBe(`番茄|${e.url}`);
    }
    // heat null → payload 不落 heat（宁缺毋假）；heat 有值 → 原样落
    const pa = deps.inspiration.get(r.entries[0].cardId!)!.payload as TrendPayload;
    const pb = deps.inspiration.get(r.entries[1].cardId!)!.payload as TrendPayload;
    expect(pa.heat).toBe(326000);
    expect(pb.heat).toBeUndefined();
  });

  it('② 二次 fetch 同 cardId、卡数不增；热度刷新不改写旧卡（卡=首抓快照）', async () => {
    const first = [entryA(), entryB()];
    deps.charts = fakeSource(first);
    const r1 = await fetchTrending(deps, { platform: '番茄' });
    const ids1 = r1.entries.map((e) => e.cardId);
    // 第二次抓取：热度变了（999999），条目身份不变
    const second = [entryA(), entryB()];
    second[0].heat = 999999;
    deps.charts = fakeSource(second);
    const r2 = await fetchTrending(deps, { platform: '番茄' });
    expect(r2.entries.map((e) => e.cardId)).toEqual(ids1);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(2);
    expect(r2.entries[0].heat).toBe(999999); // 当次结果展示新热度
    const old = deps.inspiration.get(ids1[0]!)!.payload as TrendPayload;
    expect(old.heat).toBe(326000); // 旧卡不被改写
  });

  it('③ 同书名不同 url → 不同卡（url 优先于 title 作 dedup key）', async () => {
    deps.charts = fakeSource([entryA()]);
    const r1 = await fetchTrending(deps, { platform: '番茄' });
    const moved = entryA();
    moved.url = 'https://fanqienovel.com/book/a-new';
    deps.charts = fakeSource([moved]);
    const r2 = await fetchTrending(deps, { platform: '番茄' });
    expect(r2.entries[0].cardId).not.toBe(r1.entries[0].cardId);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(2);
  });

  it('④ url 空（演示集口径）→ 按 platform|title|author 去重；live=false 照落', async () => {
    const demoA = (): ChartEntry => ({ ...entryA(), url: '', heat: null, live: false });
    deps.charts = fakeSource([demoA()], 'demo');
    const r1 = await fetchTrending(deps, { platform: '番茄' });
    expect(r1.source).toBe('demo');
    const id1 = r1.entries[0].cardId!;
    const p = deps.inspiration.get(id1)!.payload as TrendPayload;
    expect(p.sourceKey).toBe('番茄|长河渡口|驿舟子');
    expect(p.url).toBeUndefined();
    expect(p.live).toBe(false);
    // 重复 fetch → 同卡
    deps.charts = fakeSource([demoA()], 'demo');
    const r2 = await fetchTrending(deps, { platform: '番茄' });
    expect(r2.entries[0].cardId).toBe(id1);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(1);
    // 同名不同作者 → 新卡
    const otherAuthor = demoA();
    otherAuthor.author = '另一人';
    deps.charts = fakeSource([otherAuthor], 'demo');
    const r3 = await fetchTrending(deps, { platform: '番茄' });
    expect(r3.entries[0].cardId).not.toBe(id1);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(2);
  });

  it('⑤ 平台隔离：同书名同作者跨平台 → 不同卡（key 前缀是平台）', async () => {
    const a = { ...entryA(), url: '' };
    deps.charts = fakeSource([a]);
    const r1 = await fetchTrending(deps, { platform: '番茄' });
    const b = { ...entryA(), url: '', platform: '晋江' as const };
    deps.charts = fakeSource([b]);
    const r2 = await fetchTrending(deps, { platform: '晋江' });
    expect(r2.entries[0].cardId).not.toBe(r1.entries[0].cardId);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(2);
  });
});

/* ── C批「榜单手动导入」：trending:import 诚实落库（真 :memory: 库，不碰网络）──
 * 口径：source='manual'；每条 entry 落 kind='trend' 卡（live:false + manual:true），
 * dedup key = `manual|platform|title|author`（url 不入键——手动输入的链接不可信）；
 * 解析失败原样抛真因；套用 premise 带【手动导入】前缀（先于演示分支判定）。 */
describe('importTrending（C批手动导入）', () => {
  const CSV = '排名,书名,作者,热度,链接,标签\n1,《长河渡口》,驿舟子,27.7万,https://example.com/a,现实|群像\n2,守夜灯塔修补匠,迟迟雨,,,悬疑';

  it('① happy path：source=manual；cards 落库 + cardId 回填；sourceLabel/payload 诚实标记', async () => {
    const r = await importTrending(deps, { platform: '晋江', text: CSV });
    expect(r.source).toBe('manual');
    expect(r.entries).toHaveLength(2);
    for (const e of r.entries) {
      expect(e.live).toBe(false);
      expect(e.manual).toBe(true);
      expect(typeof e.cardId).toBe('string');
      const card = deps.inspiration.get(e.cardId!);
      expect(card).not.toBeNull();
      expect(card!.kind).toBe('trend');
      expect(card!.sourceLabel).toBe('晋江·手动导入');
      const p = card!.payload as TrendPayload;
      expect(p.manual).toBe(true);
      expect(p.live).toBe(false);
      expect(p.platform).toBe('晋江');
      expect(p.sourceKey).toBe(`manual|晋江|${e.title}|${e.author}`);
    }
    const pa = deps.inspiration.get(r.entries[0]!.cardId!)!.payload as TrendPayload;
    const pb = deps.inspiration.get(r.entries[1]!.cardId!)!.payload as TrendPayload;
    expect(pa.heat).toBe(277000);
    expect(pa.url).toBe('https://example.com/a');
    expect(pb.heat).toBeUndefined(); // heat null → 不落（宁缺毋假）
    expect(pb.url).toBeUndefined(); // url 空 → 不落
  });

  it('② 重复导入同书 → 同卡不增；url 不入 dedup 键（换链接仍是同一张卡）', async () => {
    const r1 = await importTrending(deps, { platform: '番茄', text: CSV });
    const ids1 = r1.entries.map((e) => e.cardId);
    const r2 = await importTrending(deps, { platform: '番茄', text: CSV });
    expect(r2.entries.map((e) => e.cardId)).toEqual(ids1);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(2);
    // 同书名同作者、链接变了 → 仍是同一张卡（manual url 不可信，不入键）
    const moved = CSV.replace('https://example.com/a', 'https://elsewhere.example/zzz');
    const r3 = await importTrending(deps, { platform: '番茄', text: moved });
    expect(r3.entries[0]!.cardId).toBe(ids1[0]);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(2);
    // 与 trending:fetch 的卡互不串键（前缀 manual| 隔离）
    const liveEntry: ChartEntry = { rank: 1, title: '长河渡口', author: '驿舟子', platform: '番茄', heat: null, tags: [], url: '', live: true };
    deps.charts = { async fetch() { return { entries: [liveEntry], source: 'live' as const }; } };
    await fetchTrending(deps, { platform: '番茄' });
    expect(deps.inspiration.listByKind('trend')).toHaveLength(3);
  });

  it('② ‐b H3 计数如实：首导 inserted=条数/deduped=0，重复导 inserted=0/deduped=条数', async () => {
    const r1 = await importTrending(deps, { platform: '起点', text: CSV });
    expect(r1.inserted).toBe(2);
    expect(r1.deduped).toBe(0);
    const r2 = await importTrending(deps, { platform: '起点', text: CSV });
    expect(r2.inserted, '重复导入不许把命中算成新增').toBe(0);
    expect(r2.deduped).toBe(2);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(2);
  });

  it('② ‐c H3 中途抛错不留半批：库里 0 张卡（真 :memory: 库，事务在 repo 层）', async () => {
    // 三条里第三条的 tags 塞进一个不可 JSON 序列化的循环引用 → insert 抛
    const badCsv = '1,书甲,甲\n2,书乙,乙\n3,书丙,丙';
    const realUpsert = deps.inspiration.upsertTrends.bind(deps.inspiration);
    let calls = 0;
    deps.inspiration.upsertTrends = ((items: { title: string; payload: TrendPayload; sourceLabel: string }[]) => {
      calls++;
      if (calls === 1) {
        // 模拟批内第 3 步炸：第三条 payload 造**真**循环引用（JSON.stringify 必抛）
        const poisoned = items.map((it, i) => {
          const payload = { ...it.payload };
          if (i === 2) (payload as unknown as { self?: unknown }).self = payload;
          return { ...it, payload };
        });
        return realUpsert(poisoned);
      }
      return realUpsert(items);
    }) as typeof deps.inspiration.upsertTrends;
    await expect(importTrending(deps, { platform: '番茄', text: badCsv })).rejects.toThrowError();
    expect(deps.inspiration.listByKind('trend'), '半截落库：前两条留下了').toHaveLength(0);
  });

  it('② ‐d fetchTrending 也回报 inserted/deduped（同一口径，不厚此薄彼）', async () => {
    const a = await fetchTrending(deps, { platform: '番茄' });
    expect(a.inserted).toBe(a.entries.length);
    expect(a.deduped).toBe(0);
    const b = await fetchTrending(deps, { platform: '番茄' });
    expect(b.inserted).toBe(0);
    expect(b.deduped).toBe(b.entries.length);
  });

  it('③ 非法入参 → E_INVALID_ARGS（platform 枚举 / text 非空 / ≤100000 字符）', async () => {
    await expect(importTrending(deps, { platform: '刺猬猫', text: CSV })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(importTrending(deps, { platform: '番茄', text: '' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(importTrending(deps, { platform: '番茄', text: '书'.repeat(100_001) })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(deps.inspiration.listByKind('trend')).toHaveLength(0); // 坏值没有落库
  });

  it('④ 解析失败 → 真因原样上抛（不静默回空、不冒充演示）', async () => {
    await expect(importTrending(deps, { platform: '番茄', text: '排名,书名,作者\n1,,甲' })).rejects.toThrowError(/手动导入解析失败：未识别到任何书目/);
    const over = Array.from({ length: 201 }, (_, i) => `${i + 1},书${i},a`).join('\n');
    await expect(importTrending(deps, { platform: '番茄', text: over })).rejects.toThrowError(/手动导入超出上限：最多 200 条/);
    expect(deps.inspiration.listByKind('trend')).toHaveLength(0);
  });

  it('⑤ createTopicFromCard：manual 卡 premise 带【手动导入】（先于演示分支）；非 manual 的 live=false 仍【演示数据】', async () => {
    const r = await importTrending(deps, { platform: '晋江', text: CSV });
    const t = createTopicFromCard(deps, { cardId: r.entries[0]!.cardId! });
    expect(t.premise).toBe('【手动导入】榜单观察：《长河渡口》（现实、群像）——从晋江手动导入榜单套用的趋势选题');
    expect(t.premise).not.toContain('【演示数据】');
    // 演示卡（live=false 且无 manual）口径不变
    const demo = deps.inspiration.insert({
      kind: 'trend', title: '演示书',
      payload: { platform: '番茄', tags: ['悬疑'], live: false },
      sourceLabel: '番茄',
    });
    expect(createTopicFromCard(deps, { cardId: demo.id }).premise).toContain('【演示数据】');
  });
});
