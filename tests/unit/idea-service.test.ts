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
  // ★ 终审修复波 B：假 LLM 只回显 'X'——payload.direction 是 LLM 回显、不可作反重复依据；
  //   实际抽中方向落卡时写 sourceLabel（权威源）。rand 恒 0 时若反重复没吃到权威源，
  //   第二抽仍命中同一个池首——本用例即真反重复钉（临时拆掉喂回即红）。
  it('反重复：连抽两次实际抽中方向必不同（sourceLabel 权威方向喂回 drawDirection）', async () => {
    const llm = { chat: async () => ({ content: JSON.stringify({ direction: 'X', premise: 'p' }), usage: { input: 1, output: 1 } }) };
    const first = await drawIdea({ llm, repo, rand: () => 0 });
    const second = await drawIdea({ llm, repo, rand: () => 0 });
    expect(repo.ideaHistory().length).toBe(2);
    expect(first.card.sourceLabel).toBeTruthy();
    expect(second.card.sourceLabel).not.toBe(first.card.sourceLabel);
  });
  it('反重复：payload.direction（LLM 合法回显）同样喂回避开——两路并集口径', async () => {
    // 第一抽演示兜底（LLM 抛错）：payload.direction=dir0、sourceLabel=dir0；
    // 第二抽若只看某一漏一路的口径仍可能重抽——并集保证避开。
    const okLlm = { chat: async () => ({ content: JSON.stringify({ direction: '系统流', premise: '觉醒系统', hook: 'h', genre: '科幻' }), usage: { input: 1, output: 1 } }) };
    const badLlm = { chat: async () => { throw new Error('auth'); } };
    const first = await drawIdea({ llm: badLlm, repo, rand: () => 0 }); // 演示卡：sourceLabel=池首
    const second = await drawIdea({ llm: okLlm, repo, rand: () => 0 });
    expect(second.card.sourceLabel).not.toBe(first.card.sourceLabel);
    // 第三抽避开前两抽（'系统流' 来自 payload.direction，池内合法值也须被滤掉）
    const third = await drawIdea({ llm: okLlm, repo, rand: () => 0 });
    expect(third.card.sourceLabel).not.toBe(first.card.sourceLabel);
    expect(third.card.sourceLabel).not.toBe(second.card.sourceLabel);
  });
});