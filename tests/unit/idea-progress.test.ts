/**
 * ★ E批「模型思考过程可见」钉②：drawIdea 必须经 onProgress 如实播报等待过程。
 *
 * 修复前抽卡等待期间界面上只有「抽卡中…」三个字：模型是在思考、在产出、还是
 * 端点黑洞，用户一概不知（老板报障：「卡一晚上我也不知道他到底在干什么」）。
 *
 * 本文件钉四件事（先红后绿）：
 *   A. live 路径事件序 start → thinking/writing → done，scope='idea'，
 *      elapsedMs 是**测出来的**（start 恒 0），charsSeen 单调增长；
 *   B. thought 只带**尾部片段**（≤200 字），不许把整段思考灌进 IPC；
 *   C. 模型抛错 → 最后一条是 fallback，note 带**真因**（不是空话）；
 *   D. 不许回归 ccb2ea2 的紧预算：req 仍带 timeoutMs≤30s、maxRetries≤1，
 *      且这次必须 stream:true + 传 onDelta（不然增量根本出不来）。
 *
 * 诚实纪律负对照：把 fallback 的 note 换成写死文案、或把 stream:true 删掉，本文件即红。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { drawIdea } from '@main/inspiration/idea-service';
import type { LlmProgress } from '@shared/types/provider';

let db: ReturnType<typeof Database>;
let repo: InspirationRepo;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repo = new InspirationRepo(db);
});

const IDEA_JSON = JSON.stringify({ direction: '重生复仇', premise: '被害者重生归来', hook: 'h', genre: '现代言情' });

/** PipelineLlm.chat 的 req 形（结构兼容即可，测试不 import 主进程类型别名） */
interface FakeReq {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  stream?: boolean;
  onDelta?: (d: { content?: string; reasoning?: string }) => void;
}

describe('drawIdea onProgress（E批）', () => {
  it('A/D. live 流：start → thinking/writing → done，stream:true + 紧预算仍在', async () => {
    let seenReq: FakeReq | null = null;
    const llm = {
      chat: async (req: FakeReq) => {
        seenReq = req;
        // 假流：先思考（超长，验 B 的尾部截断），再逐片产出正文
        req.onDelta?.({ reasoning: '想'.repeat(300) });
        req.onDelta?.({ content: IDEA_JSON.slice(0, 20) });
        req.onDelta?.({ content: IDEA_JSON.slice(20) });
        return { content: IDEA_JSON, usage: { input: 1, output: 1 } };
      },
    };
    const events: LlmProgress[] = [];
    const r = await drawIdea({ llm, repo, onProgress: (p) => events.push(p) });

    expect(r.source).toBe('live');
    expect(seenReq, 'idea-service 没有把请求对象传下去').not.toBeNull();
    expect(seenReq!.stream, '短产出路径必须走流式，否则等待期一个字都看不到').toBe(true);
    expect(seenReq!.timeoutMs, '不许回归 ccb2ea2 紧预算').toBeLessThanOrEqual(30_000);
    expect(seenReq!.maxRetries, '不许回归 ccb2ea2 紧预算').toBeLessThanOrEqual(1);
    expect(typeof seenReq!.onDelta).toBe('function');

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((e) => e.scope === 'idea')).toBe(true);
    expect(events[0]).toMatchObject({ phase: 'start', attempt: 1, elapsedMs: 0, charsSeen: 0 });
    expect(events.at(-1)!.phase).toBe('done');
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('thinking');
    expect(phases).toContain('writing');

    // charsSeen 单调不减，且确实随流增长（300 思考字 + 正文字）
    const counts = events.map((e) => e.charsSeen);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(events.at(-1)!.charsSeen).toBeGreaterThanOrEqual(300 + IDEA_JSON.length);

    // elapsedMs 是测出来的：非负有限数
    for (const e of events) {
      expect(Number.isFinite(e.elapsedMs)).toBe(true);
      expect(e.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('B. thought 只带尾部片段（≤200 字），不是整段思考', async () => {
    const llm = {
      chat: async (req: { onDelta?: (d: { content?: string; reasoning?: string }) => void }) => {
        req.onDelta?.({ reasoning: '甲'.repeat(150) + '乙'.repeat(150) });
        req.onDelta?.({ content: IDEA_JSON });
        return { content: IDEA_JSON, usage: { input: 1, output: 1 } };
      },
    };
    const events: LlmProgress[] = [];
    await drawIdea({ llm, repo, onProgress: (p) => events.push(p) });
    const withThought = events.filter((e) => e.thought != null);
    expect(withThought.length).toBeGreaterThan(0);
    for (const e of withThought) {
      expect(e.thought!.length, '推送载荷必须限长：thought 只能是尾部片段').toBeLessThanOrEqual(200);
    }
    // 尾部片段 = 思考的**结尾**（最新），不是开头
    expect(withThought.at(-1)!.thought!.endsWith('乙'.repeat(50))).toBe(true);
  });

  it('C. 模型抛错 → start → fallback，note 带真因，卡仍是诚实演示', async () => {
    const llm = {
      chat: async () => {
        throw new Error('上游错误 503 Bad Gateway');
      },
    };
    const events: LlmProgress[] = [];
    const r = await drawIdea({ llm, repo, onProgress: (p) => events.push(p) });
    expect(r.source).toBe('demo');
    expect((r.card.payload as { live: boolean }).live).toBe(false);
    expect(events[0]!.phase).toBe('start');
    const last = events.at(-1)!;
    expect(last.phase).toBe('fallback');
    expect(last.note, 'fallback 必须带真因，不许空话').toContain('503');
  });

  it('不传 onProgress 时行为不变（老调用方零影响）', async () => {
    const llm = { chat: async () => ({ content: IDEA_JSON, usage: { input: 1, output: 1 } }) };
    const r = await drawIdea({ llm, repo });
    expect(r.source).toBe('live');
  });
});
