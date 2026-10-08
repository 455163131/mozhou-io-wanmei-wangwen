/**
 * checkpoint 与回滚测试（架构 T27 / §1.4.4）。
 *
 * ★ 本测试覆盖 PRD 验收标准第 6 条：「应用后回滚，正文必须与改前逐字一致」。
 *   这是**零容忍**项（架构 §5.2 V17），因为回滚是老板决策 ① 之后的**唯一防线**。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CheckpointManager, CheckpointError } from '@main/checkpoint/manager';
import { Replayer, detectManualEditConflicts } from '@main/checkpoint/replayer';
import { DEFAULT_CHECKPOINT_CONFIG } from '@shared/constants/checkpoint';

/**
 * ★ 归档目录放在**项目内的 .tmp/**，不用系统 tmpdir。
 *   原因：某些沙箱环境下系统 tmpdir 不可写（实测 EPERM），
 *   会让整个测试文件以 unhandled error 中断——表现为「测试没跑完」而非「测试失败」，
 *   比失败更隐蔽。
 */
let archiveDir = '';
const TMP_ROOT = join(process.cwd(), '.tmp');

/** 内存正文存储，模拟 DB */
class MemStore {
  bodies = new Map<string, string>();
  revs = new Map<string, number>();
  failGet = new Set<string>();

  async getBody(id: string): Promise<string | null> {
    if (this.failGet.has(id)) throw new Error('读盘失败（模拟）');
    return this.bodies.has(id) ? this.bodies.get(id)! : null;
  }
  async setBody(id: string, body: string): Promise<void> {
    this.bodies.set(id, body);
    this.revs.set(id, (this.revs.get(id) ?? 1) + 1);
  }
}

beforeEach(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  archiveDir = await fs.mkdtemp(join(TMP_ROOT, 'ckpt-'));
});

describe('强制快照（fail-safe：失败即拒绝执行）', () => {
  it('成功时返回 checkpointId，且快照含改前原文', async () => {
    const store = new MemStore();
    store.bodies.set('1', '原文第一行\n原文第二行');
    const mgr = new CheckpointManager(store, archiveDir);
    const id = await mgr.requireCheckpoint('run1', 1, 'fix_structure', ['1']);
    expect(id).toMatch(/^ckpt_/);
    const ck = await mgr.read(id);
    expect(ck?.patches[0].beforeText).toBe('原文第一行\n原文第二行');
  });

  it('★ 章节不存在时抛 CheckpointError，绝不返回「半个快照」', async () => {
    const store = new MemStore();
    const mgr = new CheckpointManager(store, archiveDir);
    await expect(mgr.requireCheckpoint('r', 1, 't', ['不存在的章'])).rejects.toBeInstanceOf(CheckpointError);
  });

  it('★ 读取失败时抛错，且错误信息含「拒绝执行」', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'x');
    store.failGet.add('1');
    const mgr = new CheckpointManager(store, archiveDir);
    try {
      await mgr.requireCheckpoint('r', 1, 't', ['1']);
      throw new Error('本应抛错但没抛');
    } catch (e) {
      expect(e).toBeInstanceOf(CheckpointError);
      expect((e as CheckpointError).message).toContain('拒绝执行');
      expect((e as CheckpointError).message).toContain('fail-safe');
    }
  });

  it('★ 多章快照：任一章失败则整体拒绝', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'a');
    store.bodies.set('2', 'b');
    store.failGet.add('2');
    const mgr = new CheckpointManager(store, archiveDir);
    await expect(mgr.requireCheckpoint('r', 1, 't', ['1', '2'])).rejects.toBeInstanceOf(CheckpointError);
    // 关键：不应留下「1 有快照、2 没有」的状态
    expect(mgr.stats().depth).toBe(0);
  });

  it('空章节列表也拒绝（无从快照 = 无从保护）', async () => {
    const store = new MemStore();
    const mgr = new CheckpointManager(store, archiveDir);
    await expect(mgr.requireCheckpoint('r', 1, 't', [])).rejects.toBeInstanceOf(CheckpointError);
  });
});

describe('★ 回滚后正文与改前逐字一致（PRD 验收标准第 6 条 / V17 零容忍）', () => {
  /** 跑 N 次「改 → 回滚」，每次都比对字节 */
  it('单章反复改写+ 回滚，20 次全部逐字一致', async () => {
    const store = new MemStore();
    const original = '第一段：他把书放在桌上。\n第二段：她看了很久窗外。\n第三段：愣了一下，说没说话。';
    store.bodies.set('37', original);
    const mgr = new CheckpointManager(store, archiveDir);
    const rp = new Replayer(mgr, store);

    // 语义：undoTo(X) = 「回到第 X 步**之前**」，故撤销 X 自己的改动
    // 需要一个「X 之前」的锚点。这里每轮都从基准态重来，故用**上一轮的 checkpoint**
    // 作为锚点；第 0 轮用初始 checkpoint。
    let anchor = await mgr.requireCheckpoint('run', 0, 'init', ['37']);

    for (let i = 0; i < 20; i++) {
      const id = await mgr.requireCheckpoint('run', i + 1, 'fix_expression', ['37']);
      // 模拟 Agent 改动
      const modified = `${original}\n第 ${i} 次追加的内容。`.repeat(i + 1);
      store.bodies.set('37', modified);
      await mgr.commit(id, new Map([['37', modified]]), 1);

      // 回滚到 anchor（= 第 i 步之前的状态）
      await rp.undoTo(anchor, true);
      expect(store.bodies.get('37'), `第 ${i} 轮回滚后不一致`).toBe(original);
      // 字节级比对（PRD 验收标准第 6 条：逐字一致）
      expect(
        Buffer.from(store.bodies.get('37')!, 'utf8').equals(Buffer.from(original, 'utf8')),
        `第 ${i} 轮字节级不一致`,
      ).toBe(true);

      // 下一轮的锚点 = 本轮的 checkpoint（它记录了本轮改前的原文）
      anchor = id;
    }
  });

  it('跨多章回滚：每章都还原', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'AAA');
    store.bodies.set('2', 'BBB');
    store.bodies.set('3', 'CCC');
    const mgr = new CheckpointManager(store, archiveDir);
    const rp = new Replayer(mgr, store);

    // 先落一个基准 checkpoint 作为回滚锚点
    await mgr.requireCheckpoint('r', 0, 'init', ['1', '2', '3']);
    const id = await mgr.requireCheckpoint('r', 1, 'fix_structure', ['1', '2', '3']);
    store.bodies.set('1', 'A改');
    store.bodies.set('2', 'B改');
    store.bodies.set('3', 'C改');
    await mgr.commit(id, new Map([['1', 'A改'], ['2', 'B改'], ['3', 'C改']]), 3);
    // 回滚到基准（= 第 1 步之前）
    await rp.undoTo(mgr.listForRun('r')[0].id, true);

    expect(store.bodies.get('1')).toBe('AAA');
    expect(store.bodies.get('2')).toBe('BBB');
    expect(store.bodies.get('3')).toBe('CCC');
  });

  it('中文与 emoji 的字节级一致性（UTF-8 边界安全）', async () => {
    const store = new MemStore();
    const tricky = '中文标点：「测试」，省略号…… emoji: 🚀🎉 组合字符 é 与中文混排。';
    store.bodies.set('1', tricky);
    const mgr = new CheckpointManager(store, archiveDir);
    const rp = new Replayer(mgr, store);

    await mgr.requireCheckpoint('r', 0, 'init', ['1']);
    const id = await mgr.requireCheckpoint('r', 1, 'replace_phrase', ['1']);
    store.bodies.set('1', tricky + '改动');
    await mgr.commit(id, new Map([['1', tricky + '改动']]), 1);
    await rp.undoTo(mgr.listForRun('r')[0].id, true);

    expect(Buffer.from(store.bodies.get('1')!, 'utf8').equals(Buffer.from(tricky, 'utf8'))).toBe(true);
  });
});

describe('★ 手动修改冲突检测（架构 §6.1 第 14 条）', () => {
  it('期间有手动修改 → 抛 E_ROLLBACK_CONFLICT，且报出丢了多少处', async () => {
    const store = new MemStore();
    store.bodies.set('1', '原文');
    const mgr = new CheckpointManager(store, archiveDir);
    const rp = new Replayer(mgr, store);

    await mgr.requireCheckpoint('r', 0, 'init', ['1']);
    const id = await mgr.requireCheckpoint('r', 1, 'fix_expression', ['1']);
    const after = 'Agent 改后的内容';
    store.bodies.set('1', after);
    await mgr.commit(id, new Map([['1', after]]), 1);
    // ★ 用户在此期间手动改了同一章
    store.bodies.set('1', `${after}\n用户自己新加的一行`);

    try {
      await rp.undoTo(mgr.listForRun('r')[0].id, false);
      throw new Error('本应抛冲突错');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_ROLLBACK_CONFLICT');
      expect((e as Error).message).toContain('手动修改');
    }
  });

  it('无冲突时正常回滚', async () => {
    const store = new MemStore();
    store.bodies.set('1', '原文');
    const mgr = new CheckpointManager(store, archiveDir);
    const rp = new Replayer(mgr, store);
    await mgr.requireCheckpoint('r', 0, 'init', ['1']);
    const id = await mgr.requireCheckpoint('r', 1, 't', ['1']);
    const after = '改后';
    store.bodies.set('1', after);
    await mgr.commit(id, new Map([['1', after]]), 1);
    const r = await rp.undoTo(mgr.listForRun('r')[0].id, false);
    expect(r.lostManualEdits).toBe(0);
    expect(store.bodies.get('1')).toBe('原文');
  });

  it('detectManualEditConflicts 能定位到新增行', () => {
    const base = '原有第一行\n原有第二行';
    const current = '原有第一行\n用户新增行\n原有第二行';
    const conflicts = detectManualEditConflicts(
      new Map([['1', current]]),
      [{ chapterId: '1', afterText: base, edits: [] }],
    );
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((c) => c.snippet.includes('用户新增行'))).toBe(true);
  });

  it('★ 内容一致时不误报冲突', () => {
    const same = '完全一样的内容';
    const conflicts = detectManualEditConflicts(
      new Map([['1', same]]),
      [{ chapterId: '1', afterText: same, edits: [] }],
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe('★ LRU 淘汰转磁盘而非丢弃（架构 §6.1 第 13 条）', () => {
  it('超出 maxDepth 后最老的被淘汰，但转存磁盘且可读回', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'v0');
    // maxDepth=2：第 3 次入栈应淘汰第 1 个
    const mgr = new CheckpointManager(store, archiveDir, { ...DEFAULT_CHECKPOINT_CONFIG, maxDepth: 2 });

    const c1 = await mgr.requireCheckpoint('r', 1, 't', ['1']);
    store.bodies.set('1', 'v1');
    await mgr.commit(c1, new Map([['1', 'v1']]), 1);

    const c2 = await mgr.requireCheckpoint('r', 2, 't', ['1']);
    store.bodies.set('1', 'v2');
    await mgr.commit(c2, new Map([['1', 'v2']]), 1);

    const c3 = await mgr.requireCheckpoint('r', 3, 't', ['1']);
    store.bodies.set('1', 'v3');
    await mgr.commit(c3, new Map([['1', 'v3']]), 1);
    void c2;

    // 内存里只剩 2 条
    expect(mgr.stats().depth).toBe(2);

    // ★ 但被淘汰的 c1 仍能从磁盘读回——「够不到」≠「被删了」
    const files = await fs.readdir(archiveDir);
    expect(files.some((f) => f.includes('ckpt_')), '被淘汰的 checkpoint 必须转存磁盘').toBe(true);

    const revived = await mgr.read(c1);
    expect(revived, '被淘汰的 checkpoint 应能从磁盘读回').not.toBeNull();
    expect(revived!.tier).toBe('archive');
    expect(revived!.patches[0].beforeText).toBe('v0');
  });

  it('内存栈清空不删磁盘存档（切项目后仍可回滚历史）', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'v0');
    const mgr = new CheckpointManager(store, archiveDir, { ...DEFAULT_CHECKPOINT_CONFIG, maxDepth: 1 });
    const c1 = await mgr.requireCheckpoint('r', 1, 't', ['1']);
    store.bodies.set('1', 'v1');
    await mgr.commit(c1, new Map([['1', 'v1']]), 1);
    await mgr.requireCheckpoint('r', 2, 't', ['1']); // 触发淘汰

    mgr.clearProject();
    expect(mgr.stats().depth).toBe(0);
    const files = await fs.readdir(archiveDir);
    expect(files.length).toBeGreaterThan(0);
  });
});

describe('checkpoint 与轨迹步骤一一对应（架构 §1.4.4②）', () => {
  it('每步一个 checkpoint，seq 严格递增，可按 run 查询', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'v');
    const mgr = new CheckpointManager(store, archiveDir);

    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await mgr.requireCheckpoint('runA', i, 't', ['1']));
    }
    const list = mgr.listForRun('runA');
    expect(list).toHaveLength(5);
    // seq 严格递增
    for (let i = 1; i < list.length; i++) {
      expect(list[i].seq).toBeGreaterThan(list[i - 1].seq);
    }
    // stepNo 与轨迹步骤对应
    expect(list.map((c) => c.stepNo)).toEqual([1, 2, 3, 4, 5]);
    // 按 run 隔离
    expect(mgr.listForRun('runB')).toHaveLength(0);
  });

  it('usageRatio 反映内存占用', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'x'.repeat(1000));
    const mgr = new CheckpointManager(store, archiveDir, {
      ...DEFAULT_CHECKPOINT_CONFIG,
      maxTotalBytes: 100_000,
    });
    await mgr.requireCheckpoint('r', 1, 't', ['1']);
    expect(mgr.usageRatio()).toBeGreaterThan(0);
    expect(mgr.usageRatio()).toBeLessThan(1);
    expect(mgr.limits.maxTotalBytes).toBe(100_000);
  });
});

describe('清理', () => {
  it('pruneArchive 删除过期存档', async () => {
    const store = new MemStore();
    store.bodies.set('1', 'v');
    const mgr = new CheckpointManager(store, archiveDir, { ...DEFAULT_CHECKPOINT_CONFIG, maxDepth: 1 });
    await mgr.requireCheckpoint('r', 1, 't', ['1']);
    await mgr.requireCheckpoint('r', 2, 't', ['1']);
    const before = (await fs.readdir(archiveDir)).length;
    expect(before).toBeGreaterThan(0);
    // 用「现在 + 100 天」作为当前时间 → 全部过期
    const pruned = await mgr.pruneArchive(Date.now() + 100 * 24 * 3600 * 1000);
    expect(pruned).toBe(before);
    expect((await fs.readdir(archiveDir)).length).toBe(0);
  });

  it('临时目录清理不报错', async () => {
    await fs.rm(archiveDir, { recursive: true, force: true }).catch(() => undefined);
  });
});