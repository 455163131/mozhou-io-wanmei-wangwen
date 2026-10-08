/**
 * ★ checkpoint 跨会话存活测试（回滚能力重启后还在不在）。
 *
 * 为什么单独开一个文件：
 *
 *   修复前的形态是——`migrate.ts` 把 `checkpoints` 表建好了（含 archive_file /
 *   chapters_json / rolled_back_at 字段），但**全项目没有一条 INSERT**；
 *   `store.restoreSeq()` 与 `store.pruneArchive()` 也**都没有调用者**。
 *   于是：
 *     · checkpoint 只活在进程内存 → 重启后「改动历史」归零，
 *       用户无法回滚上一次会话的任何改动；
 *     · 磁盘存档既读不回来、又永不清理 → 一堆无限增长的不可达垃圾。
 *
 *   而既有的 checkpoint.test.ts（331 行）**从未测过 markRolledBack，也从未测过
 *   重启还原**——这正是该缺陷能长期潜伏的原因：所有用例都在单个进程内闭环。
 *
 * 修复方式：入栈即写穿落盘（不再等 LRU 淘汰才写文件）+ `hydrate()` 在打开项目时
 * 从存档目录还原（顺带跑一次 pruneArchive）。存档目录本身按项目隔离，
 * 因此无需引入 DB 迁移即可让回滚能力跨会话存活。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CheckpointManager } from '@main/checkpoint/manager';
import { DEFAULT_CHECKPOINT_CONFIG } from '@shared/constants/checkpoint';

/** 沿用既有约定：归档目录放项目内 .tmp/，避开系统 tmpdir 的 EPERM 竞态 */
const TMP_ROOT = join(process.cwd(), '.tmp');
let archiveDir = '';

class MemStore {
  bodies = new Map<string, string>();
  async getBody(id: string): Promise<string | null> {
    return this.bodies.has(id) ? this.bodies.get(id)! : null;
  }
  async setBody(id: string, body: string): Promise<void> {
    this.bodies.set(id, body);
  }
}

beforeEach(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  archiveDir = await fs.mkdtemp(join(TMP_ROOT, 'ckpt-persist-'));
});

function makeStore(): MemStore {
  const s = new MemStore();
  s.bodies.set('c1', '第一章原文');
  s.bodies.set('c2', '第二章原文');
  return s;
}

async function listArchiveFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(archiveDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

describe('★ 写穿落盘：每一步都有磁盘副本，不等淘汰', () => {
  it('requireCheckpoint 之后磁盘上立刻有存档文件（修复前要等 LRU 淘汰）', async () => {
    const mgr = new CheckpointManager(makeStore(), archiveDir);
    expect(await listArchiveFiles()).toHaveLength(0);

    await mgr.requireCheckpoint('run1', 1, 'fix_structure', ['c1']);
    expect(await listArchiveFiles()).toHaveLength(1);

    await mgr.requireCheckpoint('run1', 2, 'fix_expression', ['c2']);
    expect(await listArchiveFiles()).toHaveLength(2);
  });

  it('内存副本仍标 tier=memory，但已带 archiveFile（淘汰时无需再写一次）', async () => {
    const mgr = new CheckpointManager(makeStore(), archiveDir);
    const id = await mgr.requireCheckpoint('run1', 1, 't', ['c1']);
    const ck = await mgr.read(id);
    expect(ck).toBeTruthy();
    expect(ck!.archiveFile).toBeTruthy();
  });

  it('存档是合法 JSON 且含改前原文（不是空壳）', async () => {
    const mgr = new CheckpointManager(makeStore(), archiveDir);
    await mgr.requireCheckpoint('run1', 1, 't', ['c1']);
    const [file] = await listArchiveFiles();
    const raw = JSON.parse(await fs.readFile(join(archiveDir, file), 'utf8'));
    expect(raw.patches[0].beforeText).toBe('第一章原文');
    expect(raw.tier).toBe('archive');
    expect(raw.archiveFile).toBe(file);
  });
});

describe('★ 重启还原：改动历史与回滚能力跨会话存活', () => {
  it('新 manager 指向同一存档目录 + hydrate → 能看到上一次会话的 checkpoint', async () => {
    const sessionA = new CheckpointManager(makeStore(), archiveDir);
    const idA = await sessionA.requireCheckpoint('run1', 1, 'fix_structure', ['c1']);
    await sessionA.requireCheckpoint('run1', 2, 'fix_expression', ['c2']);

    // 模拟应用重启：全新的 manager，内存栈是空的
    const sessionB = new CheckpointManager(makeStore(), archiveDir);
    expect(sessionB.stats().depth).toBe(0);

    const restored = await sessionB.hydrate();
    expect(restored).toBe(2);
    expect(sessionB.stats().depth).toBe(2);

    // 关键：不只是「看得到条目」，还要能读回正文，否则回滚无从下手
    const ck = await sessionB.read(idA);
    expect(ck).toBeTruthy();
    expect(ck!.patches[0].beforeText).toBe('第一章原文');
    expect(ck!.affectedChapters).toEqual(['c1']);
  });

  it('★ 重启后 seq 接着历史最大值走，不与旧 checkpoint 撞号', async () => {
    const sessionA = new CheckpointManager(makeStore(), archiveDir);
    await sessionA.requireCheckpoint('run1', 1, 't', ['c1']);
    await sessionA.requireCheckpoint('run1', 2, 't', ['c1']);
    await sessionA.requireCheckpoint('run1', 3, 't', ['c1']);

    const sessionB = new CheckpointManager(makeStore(), archiveDir);
    await sessionB.hydrate();
    const newId = await sessionB.requireCheckpoint('run2', 1, 't', ['c1']);
    const ck = await sessionB.read(newId);
    // 修复前 restoreSeq 无调用者 → 新 seq 从 1 重新开始，与历史 seq 1/2/3 冲突，
    // 于是 checkpointsToUndo(seq) 这类按 seq 比较的逻辑会张冠李戴。
    expect(ck!.seq).toBe(4);
  });

  it('★ 重启后仍能对上一次会话的改动执行回滚', async () => {
    const store = makeStore();
    const sessionA = new CheckpointManager(store, archiveDir);
    await sessionA.requireCheckpoint('run1', 1, 't', ['c1']);

    const sessionB = new CheckpointManager(store, archiveDir);
    await sessionB.hydrate();
    // seq=1 之后发生的改动都应可撤（此处尚无 seq>1 的项，故为空）
    expect(sessionB.checkpointsToUndo(1)).toHaveLength(0);
    // 而「回到 seq 0 之前」= 撤销全部
    const toUndo = sessionB.checkpointsToUndo(0);
    expect(toUndo).toHaveLength(1);
    expect(toUndo[0].patches[0].beforeText).toBe('第一章原文');
  });

  it('★ 回滚标记跨会话存活：不会把同一步重复撤销', async () => {
    const sessionA = new CheckpointManager(makeStore(), archiveDir);
    await sessionA.requireCheckpoint('run1', 1, 't', ['c1']);
    await sessionA.requireCheckpoint('run1', 2, 't', ['c2']);
    // 用户已经撤过 seq=2 这一步
    await sessionA.markRolledBack(2);

    const sessionB = new CheckpointManager(makeStore(), archiveDir);
    await sessionB.hydrate();
    const pending = sessionB.checkpointsToUndo(1);
    // 修复前 markRolledBack 只改内存副本，重启后标记丢失 →
    // 这里会把 seq=2 再撤一次，正文停在错误的中间态。
    expect(pending.map((c) => c.seq)).not.toContain(2);
  });

  it('★ 已被 LRU 淘汰出内存栈的 checkpoint 重启后依然可还原', async () => {
    const cfg = { ...DEFAULT_CHECKPOINT_CONFIG, maxDepth: 2 };
    const sessionA = new CheckpointManager(makeStore(), archiveDir, cfg);
    const first = await sessionA.requireCheckpoint('run1', 1, 't', ['c1']);
    await sessionA.requireCheckpoint('run1', 2, 't', ['c1']);
    await sessionA.requireCheckpoint('run1', 3, 't', ['c1']);
    // maxDepth=2 → 第一条已被淘汰出内存栈
    expect(sessionA.stats().depth).toBe(2);

    const sessionB = new CheckpointManager(makeStore(), archiveDir, cfg);
    const restored = await sessionB.hydrate();
    expect(restored).toBe(3); // 磁盘上三份都在
    // 「LRU 淘汰 ≠ 删除」：淘汰项仍必须够得着
    const ck = await sessionB.read(first);
    expect(ck).toBeTruthy();
    expect(ck!.patches[0].beforeText).toBe('第一章原文');
  });
});

describe('还原的健壮性', () => {
  it('★ 单个存档损坏不影响其余（跳过并留痕，而非整份历史读不出来）', async () => {
    const sessionA = new CheckpointManager(makeStore(), archiveDir);
    await sessionA.requireCheckpoint('run1', 1, 't', ['c1']);
    await sessionA.requireCheckpoint('run1', 2, 't', ['c1']);

    const files = await listArchiveFiles();
    // 把其中一份写成截断的 JSON，模拟写一半崩溃
    await fs.writeFile(join(archiveDir, files[0]), '{"seq":1,"id":"ck', 'utf8');

    const sessionB = new CheckpointManager(makeStore(), archiveDir);
    const restored = await sessionB.hydrate();
    expect(restored).toBe(1); // 只剩好的那份
    expect(sessionB.stats().depth).toBe(1);
  });

  it('形状不合法的存档（缺 seq）被跳过，不让它污染历史', async () => {
    await fs.writeFile(join(archiveDir, 'ckpt_x_bogus.json'), '{"id":"ck"}', 'utf8');
    const sessionB = new CheckpointManager(makeStore(), archiveDir);
    expect(await sessionB.hydrate()).toBe(0);
  });

  it('空存档目录 hydrate 返回 0，且不抛异常（首次打开项目）', async () => {
    const mgr = new CheckpointManager(makeStore(), archiveDir);
    expect(await mgr.hydrate()).toBe(0);
    expect(mgr.stats().depth).toBe(0);
  });

  it('★ hydrate 顺带清理过期存档（修复前 pruneArchive 无调用者 → 无限增长）', async () => {
    const sessionA = new CheckpointManager(makeStore(), archiveDir);
    await sessionA.requireCheckpoint('run1', 1, 't', ['c1']);
    expect(await listArchiveFiles()).toHaveLength(1);

    // 把存档的 mtime 推到保留期之外
    const [file] = await listArchiveFiles();
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    await fs.utimes(join(archiveDir, file), old, old);

    const sessionB = new CheckpointManager(makeStore(), archiveDir);
    expect(await sessionB.hydrate()).toBe(0);
    expect(await listArchiveFiles()).toHaveLength(0); // 已被清理
  });

  it('clearProject 后不再看到上一个项目的历史', async () => {
    const sessionA = new CheckpointManager(makeStore(), archiveDir);
    await sessionA.requireCheckpoint('run1', 1, 't', ['c1']);

    const sessionB = new CheckpointManager(makeStore(), archiveDir);
    await sessionB.hydrate();
    expect(sessionB.stats().depth).toBe(1);

    sessionB.clearProject();
    expect(sessionB.stats().depth).toBe(0);
    // 索引也要清干净：否则 allKnown() 仍会返回上个项目的条目
    expect(sessionB.checkpointsToUndo(0)).toHaveLength(0);
  });
});
