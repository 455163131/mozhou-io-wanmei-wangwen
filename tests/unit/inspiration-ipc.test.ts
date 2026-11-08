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
import type { ChartFetchResult } from '@shared/types/inspiration';

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
