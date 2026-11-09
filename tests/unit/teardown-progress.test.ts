/**
 * ★ E批「模型思考过程可见」钉③：teardownRead 必须经 onProgress 如实播报等待过程。
 *
 * 与 idea-progress.test.ts 同族同口径（抽脑洞/拆书精读是两条短产出路径，
 * 老板报障的「不知道他在干什么」对八维精读同样成立——精读比抽卡更慢）。
 *
 * 钉四件事（先红后绿）：
 *   A. live 路径事件序 start → thinking/writing → done，scope='teardown'；
 *   B. thought 尾部片段限长（≤200 字）；
 *   C. 模型抛错 → fallback + note 带真因；
 *   D. 不回归 ccb2ea2 紧预算，且 stream:true + onDelta 真的传下去了。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { TeardownRepo } from '@main/db/repos/teardown-repo';
import { teardownStructure, teardownRead } from '@main/inspiration/teardown-service';
import type { LlmProgress } from '@shared/types/provider';

let db: ReturnType<typeof Database>;
let td: TeardownRepo;
const SAMPLE = '第一章 测试\n' + '他走进房间，看见桌上有一封信。'.repeat(40);
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  td = new TeardownRepo(db);
});

const DIMS = { 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' };
const DIMS_JSON = JSON.stringify(DIMS);

/** PipelineLlm.chat 的 req 形（结构兼容即可） */
interface FakeReq {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  stream?: boolean;
  onDelta?: (d: { content?: string; reasoning?: string }) => void;
}

describe('teardownRead onProgress（E批）', () => {
  it('A/D. live 流：start → thinking/writing → done，scope=teardown，stream:true + 紧预算仍在', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    let seenReq: FakeReq | null = null;
    const llm = {
      chat: async (req: FakeReq) => {
        seenReq = req;
        req.onDelta?.({ reasoning: '证据'.repeat(120) });
        req.onDelta?.({ content: DIMS_JSON.slice(0, 15) });
        req.onDelta?.({ content: DIMS_JSON.slice(15) });
        return { content: DIMS_JSON, usage: { input: 1, output: 1 } };
      },
    };
    const events: LlmProgress[] = [];
    const r = await teardownRead({ reportId, llm, repo: td, onProgress: (p) => events.push(p) });

    expect(r.source).toBe('live');
    expect(seenReq, 'teardown-service 没有把请求对象传下去').not.toBeNull();
    expect(seenReq!.stream, '八维精读必须走流式，否则等待期一个字都看不到').toBe(true);
    expect(seenReq!.timeoutMs, '不许回归 ccb2ea2 紧预算').toBeLessThanOrEqual(30_000);
    expect(seenReq!.maxRetries, '不许回归 ccb2ea2 紧预算').toBeLessThanOrEqual(1);
    expect(typeof seenReq!.onDelta).toBe('function');

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((e) => e.scope === 'teardown')).toBe(true);
    expect(events[0]).toMatchObject({ phase: 'start', attempt: 1, elapsedMs: 0, charsSeen: 0 });
    expect(events.at(-1)!.phase).toBe('done');
    expect(events.map((e) => e.phase)).toContain('thinking');
    expect(events.map((e) => e.phase)).toContain('writing');

    const counts = events.map((e) => e.charsSeen);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(events.at(-1)!.charsSeen).toBeGreaterThanOrEqual(240 + DIMS_JSON.length);
    // thought 尾部片段限长
    for (const e of events.filter((x) => x.thought != null)) {
      expect(e.thought!.length).toBeLessThanOrEqual(200);
    }
  });

  it('C. 模型抛错 → start → fallback，note 带真因，结果仍是诚实演示', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    const llm = {
      chat: async () => {
        throw new Error('触发限流（429）');
      },
    };
    const events: LlmProgress[] = [];
    const r = await teardownRead({ reportId, llm, repo: td, onProgress: (p) => events.push(p) });
    expect(r.source).toBe('demo');
    expect(events[0]!.phase).toBe('start');
    const last = events.at(-1)!;
    expect(last.phase).toBe('fallback');
    expect(last.note, 'fallback 必须带真因，不许空话').toContain('429');
  });

  it('不传 onProgress 时行为不变（老调用方零影响）', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    const llm = { chat: async () => ({ content: DIMS_JSON, usage: { input: 1, output: 1 } }) };
    const r = await teardownRead({ reportId, llm, repo: td });
    expect(r.source).toBe('live');
  });

  // ★ 裁决修复波 H2：teardownRead 同样要把 progress.retry 接到 req.onRetry
  it('H2：onRetry(2) → retry 相位 + 计数清零 + attempt 真值', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    const llm = {
      chat: async (req: {
        onDelta?: (d: { content?: string; reasoning?: string }) => void;
        onRetry?: (n: number) => void;
      }) => {
        req.onDelta?.({ reasoning: '想'.repeat(300) });
        req.onRetry?.(2);
        req.onDelta?.({ content: DIMS_JSON });
        return { content: DIMS_JSON, usage: { input: 1, output: 1 } };
      },
    };
    const events: LlmProgress[] = [];
    await teardownRead({ reportId, llm, repo: td, onProgress: (p) => events.push(p) });
    const retryEvent = events.find((e) => e.phase === 'retry');
    expect(retryEvent, 'retry 相位必须真发').toBeDefined();
    expect(retryEvent!.attempt).toBe(2);
    expect(retryEvent!.charsSeen, '第一次尝试的思考字数不许带进第二次').toBe(0);
    expect(retryEvent!.thought, '第二次不该再掺着第一次的思考尾').toBeUndefined();
    const last = events.at(-1)!;
    expect(last.attempt).toBe(2);
    expect(last.charsSeen).toBe(DIMS_JSON.length);
  });
});
