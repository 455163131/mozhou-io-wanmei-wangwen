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
import type { LlmProgress } from '@shared/types/provider';

let db: ReturnType<typeof Database>; let td: TeardownRepo; let ins: InspirationRepo;
const SAMPLE = '第一章 测试\n' + '他走进房间，看见桌上有一封信。'.repeat(40);
/** 带章末疑问钩子的文本（钩子引文长度断言用；段够长 → snippetAround 窗口 >16 字） */
const HOOK_TEXT =
  '第一章 测试\n' +
  '夜色深沉，他推开房门，屋里空无一人，只有桌上那封信静静躺着，难道这一切从头到尾都是骗局？\n' +
  '他走进房间，看见桌上有一封信。'.repeat(40);
/** ★ B批⑤：把 digest 报告里恒定不变的 20 字片段（章末钩子密度:0 处/段 对白占比:0%）
 *  原样写进正文 → LCS 恰好 ≥ DIGEST_LCS_LIMIT(20) → compliance.passed 必为 false（确定性构造，非碰运气）。 */
const LCS_FAIL_TEXT = `${SAMPLE}\n章末钩子密度:0 处/段 对白占比:0%`;
const DIMS_OK = { 定位: 'a', 结构: 'b', 节奏: 'c', 爽点钩子: 'd', 伏笔: 'e', 人物: 'f', 文风: 'g', 可借鉴: 'h' };
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

  // ── B批④：钩子引文长度——标签必须与 snippetAround(radius=16) 的真实上界一致 ──
  it('B批④：钩子引文真实上界 ≤32 字（且确有 >16 字的引文——「≤16 字」标签是假的）', async () => {
    const { structure } = await teardownStructure(HOOK_TEXT, '范文', td);
    expect(structure.hooks.length).toBeGreaterThan(0);
    let sawOver16 = false;
    for (const h of structure.hooks) {
      const content = h.quote.replace(/…/g, '');
      expect(content.length, `引文超 snippetAround(radius=16) 真实上界：「${h.quote}」`).toBeLessThanOrEqual(32);
      if (content.length > 16) sawOver16 = true;
    }
    expect(sawOver16, '构造文本应产出 >16 字引文——证明旧「≤16 字」标签失实、本钉非空洞').toBe(true);
  });

  it('B批④：精读 user 消息里的引文长度标签写真实上界（各 ≤32 字），不许再写 ≤16 字', async () => {
    const { reportId } = await teardownStructure(HOOK_TEXT, '范文', td);
    let userMsg = '';
    const llm = {
      chat: async (req: { messages: { role: string; content: string }[] }) => {
        userMsg = req.messages.find((m) => m.role === 'user')?.content ?? '';
        return { content: JSON.stringify(DIMS_OK), usage: { input: 1, output: 1 } };
      },
    };
    await teardownRead({ reportId, llm, repo: td });
    expect(userMsg).toContain('各 ≤32 字');
    expect(userMsg).not.toContain('≤16 字');
  });

  // ── B批⑤：LCS 版权合规裁决不许算完即扔——随 structure 落库，passed=false 要能被 UI 上屏 ──
  it('B批⑤：structure 携带 digest compliance 裁决（正常文本 passed=true）', async () => {
    const { structure } = await teardownStructure(SAMPLE, '范文', td);
    expect(structure.compliance).not.toBeNull();
    expect(structure.compliance!.passed).toBe(true);
    expect(structure.compliance!.note.length).toBeGreaterThan(0);
  });

  it('B批⑤：LCS ≥ 20 时 compliance.passed=false 如实进 structure（供 UI 上屏警告，不静默）', async () => {
    const { structure } = await teardownStructure(LCS_FAIL_TEXT, '范文', td);
    expect(structure.compliance, '裁决必须随 structure 落库，不许解构后扔掉').not.toBeNull();
    expect(structure.compliance!.passed).toBe(false);
    expect(structure.compliance!.note).toContain('⚠️'); // 真因原文，不另编法律话术
    expect(td.get(td.list()[0]!.id)?.structure).toMatchObject({ compliance: { passed: false } });
  });

  // ── B批⑥：teardownRead 每条兜底路径的真因都必须可见（fallback 事件带 note / 直抛） ──
  it('B批⑥：产出未过契约 → demo 兜底且 fallback note 带契约真因（非 LLM 失败模式也不许吞因）', async () => {
    const { reportId } = await teardownStructure(SAMPLE, '范文', td);
    const llm = { chat: async () => ({ content: '{"定位":"只有半截"}', usage: { input: 1, output: 1 } }) };
    const events: LlmProgress[] = [];
    const r = await teardownRead({ reportId, llm, repo: td, onProgress: (p) => events.push(p) });
    expect(r.source).toBe('demo');
    const last = events.at(-1)!;
    expect(last.phase).toBe('fallback');
    expect(last.note, '契约解析失败的真因必须经 fallback 事件披露').toContain('契约');
  });

  it('B批⑥：报告不存在 → 直抛 E_NOT_FOUND（repo 错误不走兜底、不被吞）', async () => {
    const llm = { chat: async () => ({ content: JSON.stringify(DIMS_OK), usage: { input: 1, output: 1 } }) };
    await expect(teardownRead({ reportId: 'td-不存在的报告', llm, repo: td })).rejects.toThrow(/拆书报告不存在/);
  });
});
