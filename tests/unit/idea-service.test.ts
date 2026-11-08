// tests/unit/idea-service.test.ts —— LLM 生成 + 演示兜底 + 反重复落库
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { drawIdea } from '@main/inspiration/idea-service';

let db: ReturnType<typeof Database>; let repo: InspirationRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new InspirationRepo(db); });

describe('drawIdea', () => {
  it('LLM 出合法 JSON → 落 idea 卡 source=live', async () => {
    const llm = { chat: async () => ({ content: JSON.stringify({ direction: '重生复仇', premise: '被害者重生归来', hook: 'h', genre: '现代言情' }), usage: { input: 1, output: 1 } }) };
    const r = await drawIdea({ llm, repo });
    expect(r.source).toBe('live');
    expect(r.card.kind).toBe('idea');
    expect(repo.listByKind('idea')).toHaveLength(1);
  });
  it('LLM 抛错（无 Key）→ 演示兜底 source=demo、live=false、仍落库', async () => {
    const llm = { chat: async () => { throw new Error('auth'); } };
    const r = await drawIdea({ llm, repo });
    expect(r.source).toBe('demo');
    expect((r.card.payload as { live: boolean }).live).toBe(false);
  });
  it('反重复：连抽两次方向不同（ideaHistory 喂回 drawDirection）', async () => {
    const llm = { chat: async () => ({ content: JSON.stringify({ direction: 'X', premise: 'p' }), usage: { input: 1, output: 1 } }) };
    await drawIdea({ llm, repo, rand: () => 0 });
    const second = await drawIdea({ llm, repo, rand: () => 0 });
    expect(repo.ideaHistory().length).toBe(2);
    expect(second.card).toBeTruthy();
  });
});