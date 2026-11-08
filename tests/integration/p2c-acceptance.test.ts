// tests/integration/p2c-acceptance.test.ts
//
// ★P2-C T7 验收：灵感线端到端（照 p2b-acceptance 同型，真 SQLite 内存库 + migrate）。
// 四场景对着计划 Step 1 逐字落断言：抽脑洞演示兜底 → 卡片套用立项 → 收藏入库 →
// 选题库三态互斥；再加裁决⑤：trend 卡 R9 幂等端到端（同 sourceKey 同 id、
// 不同 url 不同 id——直调 InspirationRepo.upsertTrend，不走网络）。
// 红线：全程 :memory:，不碰真实 %APPDATA% 库；/tmp/z 只是 root_dir 列字符串值。
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { TopicRepo } from '@main/db/repos/topic-repo';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import { promoteTopic } from '@main/inspiration/topic-service';
import { drawIdea } from '@main/inspiration/idea-service';

let db: ReturnType<typeof Database>;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('P2-C 灵感线端到端', () => {
  it('①抽脑洞演示兜底→落 idea 卡（明示演示）', async () => {
    const ins = new InspirationRepo(db);
    const llm = { chat: async () => { throw new Error('auth'); } }; // 无 Key
    const r = await drawIdea({ llm, repo: ins });
    expect(r.source).toBe('demo');
    expect((r.card.payload as { live: boolean }).live).toBe(false);
  });
  it('②卡片套用→选题库待立项→立项播 premise→已立项链 project', async () => {
    const ins = new InspirationRepo(db);
    const topics = new TopicRepo(db);
    const projects = new ProjectRepo(db);
    const card = ins.insert({ kind: 'idea', title: '重生', payload: { direction: '重生复仇', premise: '被害者重生复仇', temperature: 1.05, live: true }, sourceLabel: '重生复仇' });
    const topic = topics.insert({ title: card.title, premise: (card.payload as { premise: string }).premise, sourceCardId: card.id });
    const proj = projects.create('重生', '/tmp/z');
    const r = await promoteTopic({ topicId: topic.id, repo: topics, projects, projectId: proj.id });
    expect(projects.getPremise(r.projectId)).toBe('被害者重生复仇');
    expect(topics.get(topic.id)?.status).toBe('已立项');
  });
  it('③收藏入库→灵感库可见', () => {
    const ins = new InspirationRepo(db);
    const c = ins.insert({ kind: 'trend', title: '书', payload: { platform: '番茄', live: false }, sourceLabel: '番茄' });
    ins.setCollected(c.id, true);
    expect(ins.listCollected().map((x) => x.id)).toEqual([c.id]);
  });
  it('④选题库三态互斥：待立项/已立项/已放弃不重叠', () => {
    const topics = new TopicRepo(db);
    const a = topics.insert({ title: 'a', premise: 'p' });
    const b = topics.insert({ title: 'b', premise: 'p' });
    topics.setStatus(a.id, '已立项');
    topics.setStatus(b.id, '已放弃');
    expect(topics.listByStatus('待立项')).toHaveLength(0);
    expect(topics.listByStatus('已立项').map((t) => t.id)).toEqual([a.id]);
    expect(topics.listByStatus('已放弃').map((t) => t.id)).toEqual([b.id]);
  });
  it('⑤trend 卡 R9 幂等端到端：同 sourceKey 二次 upsert 同 id，不同 url 不同 id', () => {
    const ins = new InspirationRepo(db);
    const key1 = '番茄|https://example.com/book-1';
    const first = ins.upsertTrend({ title: '书一', payload: { platform: '番茄', url: 'https://example.com/book-1', sourceKey: key1, live: true }, sourceLabel: '番茄' });
    // 同 platform|url 再抓：卡=首抓快照，热度刷新不改写、不新增——原 id 原样返回
    const again = ins.upsertTrend({ title: '书一热度新', payload: { platform: '番茄', url: 'https://example.com/book-1', heat: 999, sourceKey: key1, live: true }, sourceLabel: '番茄' });
    expect(again.id).toBe(first.id);
    expect(ins.get(first.id)?.title).toBe('书一');
    // 不同 url = 不同 sourceKey = 不同卡
    const other = ins.upsertTrend({ title: '书二', payload: { platform: '番茄', url: 'https://example.com/book-2', sourceKey: '番茄|https://example.com/book-2', live: true }, sourceLabel: '番茄' });
    expect(other.id).not.toBe(first.id);
    expect(ins.listByKind('trend')).toHaveLength(2);
  });
});
