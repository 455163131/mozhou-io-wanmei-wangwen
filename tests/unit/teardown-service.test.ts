// tests/unit/teardown-service.test.ts —— P2-C T5 拆书报告服务（R3：teardownStructure text 先 title 后；
// R4：saveDimension 的 td/ins 分传）。★ 落库适配：teardownStructure 第三参注入 TeardownRepo
// （brief 原测两参形态下，函数拿不到测试自造的 :memory: 库，td.get 恒空——以可执行契约为准，
// 前两参序逐字照 R3，报告见 task-5-report.md）。
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { TeardownRepo } from '@main/db/repos/teardown-repo';
import { InspirationRepo } from '@main/db/repos/inspiration-repo';
import { teardownStructure, teardownRead, saveDimension } from '@main/inspiration/teardown-service';

let db: ReturnType<typeof Database>; let td: TeardownRepo; let ins: InspirationRepo;
const SAMPLE = '第一章 测试\n' + '他走进房间，看见桌上有一封信。'.repeat(40);
beforeEach(() => { db = new Database(':memory:'); migrate(db); td = new TeardownRepo(db); ins = new InspirationRepo(db); });

describe('teardown', () => {
  it('structure 零token：不调 LLM 即出结构统计并落库', async () => {
    const r = await teardownStructure(SAMPLE, '范文', td); // 入参不含 llm → 证明零 token
    expect(r.reportId).toBeTruthy();
    expect(td.get(r.reportId)?.structure).toBeTruthy();
    expect(td.get(r.reportId)?.dimensions).toBeNull(); // 未精读
  });
  it('read 八维：LLM 出合法 JSON → 落 dimensions source=live', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    const dims = { 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' };
    const llm = { chat: async () => ({ content: JSON.stringify(dims), usage: { input: 1, output: 1 } }) };
    const r = await teardownRead({ reportId, llm, repo: td });
    expect(r.source).toBe('live');
    expect(td.get(reportId)?.dimensions).toEqual(dims);
  });
  it('read 无 Key → 演示兜底 source=demo，dimensions 明示未精读', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    const llm = { chat: async () => { throw new Error('auth'); } };
    const r = await teardownRead({ reportId, llm, repo: td });
    expect(r.source).toBe('demo');
  });
  it('saveDimension 把一维存入灵感库 kind=teardown', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    const llm = { chat: async () => ({ content: JSON.stringify({ 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' }), usage: { input: 1, output: 1 } }) };
    await teardownRead({ reportId, llm, repo: td });
    const card = saveDimension({ reportId, dimension: '节奏', td, ins });
    expect(card.kind).toBe('teardown');
    expect(ins.listByKind('teardown')).toHaveLength(1);
  });
});
