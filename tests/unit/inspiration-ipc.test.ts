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
