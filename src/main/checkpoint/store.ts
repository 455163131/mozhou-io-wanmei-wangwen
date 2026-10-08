/**
 * Checkpoint 存储（架构 §1.4.4）。
 *
 * 两层：
 *   L1 内存栈 —— 深度 50，约 375KB，撤销走这里（快）
 *   L2 磁盘存档 —— 被 LRU 淘汰的转存这里，30 天保留
 *
 * ★ 架构 §6.1 第 13 条铁律：**LRU 淘汰不等于删除**。
 *   被淘汰的 checkpoint 转存磁盘，用户仍能从「改动历史」回滚，
 *   只是慢一点（需从磁盘读回）。**「够不到」和「被删了」是两回事**——
 *   用户永远不该失去回滚能力，代价只是多一次磁盘 IO。
 */
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, CheckpointConfig, CheckpointTier } from '@shared/types/checkpoint';
import { ARCHIVE_RETENTION_DAYS } from '@shared/constants/checkpoint';

export class CheckpointStore {
  /** L1 内存栈，seq 升序 */
  private memory: Checkpoint[] = [];
  /** seq 自增计数器 */
  private seq = 0;

  constructor(
    private readonly config: CheckpointConfig,
    private readonly archiveDir: string,
  ) {
    mkdirSync(archiveDir, { recursive: true });
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** 当前最高 seq */
  currentSeq(): number {
    return this.seq;
  }

  /** 从磁盘恢复 seq 计数（应用重启后避免 seq 回退导致 seq 冲突） */
  restoreSeq(maxSeq: number): void {
    this.seq = Math.max(this.seq, maxSeq);
  }

  /**
   * 入栈。**淘汰转磁盘，绝不丢弃**。
   * @returns 被淘汰（转存磁盘）的 checkpoint
   */
  async push(ck: Checkpoint): Promise<Checkpoint[]> {
    this.memory.push(ck);
    const evicted: Checkpoint[] = [];

    // 淘汰条件：深度超限、条数超限、字节超限
    while (this.memory.length > this.config.maxDepth) {
      evicted.push(await this.evictOldest());
    }
    while (this.memory.length > this.config.perProjectCap) {
      evicted.push(await this.evictOldest());
    }
    while (this.totalBytes() > this.config.maxTotalBytes && this.memory.length > 1) {
      // 至少保留 1 条，否则用户完全失去回滚能力
      evicted.push(await this.evictOldest());
    }
    return evicted;
  }

  /**
   * 淘汰最老的一条并转存磁盘。
   * 策略：默认 lru（最老未回滚的），fifo 则取最早入栈的（哪怕已回滚）。
   */
  private async evictOldest(): Promise<Checkpoint> {
    let idx = 0;
    if (this.config.strategy === 'lru') {
      // LRU：优先淘汰「已回滚」的（用户已不需要），其次最老的
      const rolledIdx = this.memory.findIndex((c) => c.rolledBackAt !== null);
      idx = rolledIdx >= 0 ? rolledIdx : 0;
    }
    const [victim] = this.memory.splice(idx, 1);
    const archived = await this.archive(victim);
    return archived;
  }

  /** 转存磁盘 */
  private async archive(ck: Checkpoint): Promise<Checkpoint> {
    const file = `ckpt_${ck.seq}_${ck.id}.json`;
    const path = join(this.archiveDir, file);
    // ★ 先改 tier 再落盘：若先写盘再改 tier，读回来会看到 tier='memory'
    //   而没有 archiveFile，调用方就无法判断它已转存、也无法再次定位文件。
    //   （这个 bug 表现为「淘汰后读回的 checkpoint 仍是 memory」，很难从上层察觉。）
    const archived: Checkpoint = { ...ck, tier: 'archive' as CheckpointTier, archiveFile: file };
    await fs.writeFile(path, JSON.stringify(archived), 'utf8');
    return archived;
  }

  /** 按 seq 升序列出（内存优先，磁盘在后） */
  list(): Checkpoint[] {
    return this.memory.slice().sort((a, b) => a.seq - b.seq);
  }

  /** 查最近一次未回滚的 checkpoint（撤销上一步用） */
  latest(): Checkpoint | undefined {
    const active = this.memory.filter((c) => c.rolledBackAt === null);
    return active.length ? active[active.length - 1] : undefined;
  }

  /**
   * 回滚到某个 checkpoint **之前**。
   * 返回需要应用的反向补丁（按 seq 倒序，保证撤销顺序正确）。
   */
  undoToSeq(seq: number): Checkpoint[] {
    const active = this.memory.filter((c) => c.rolledBackAt === null && c.seq > seq);
    return active.sort((a, b) => b.seq - a.seq);
  }

  /** 标记已回滚（不删除，用户可能想再滚回来） */
  markRolledBack(seq: number, at: number): void {
    const ck = this.memory.find((c) => c.seq === seq);
    if (ck) ck.rolledBackAt = at;
  }

  /** 从磁盘读回一个已存档的 checkpoint */
  async readArchived(ck: Checkpoint): Promise<Checkpoint | null> {
    if (ck.tier === 'memory') return ck;
    if (!ck.archiveFile) return null;
    const path = join(this.archiveDir, ck.archiveFile);
    if (!existsSync(path)) return null;
    try {
      const raw = await fs.readFile(path, 'utf8');
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }

  /** 清理超过保留期的磁盘存档 */
  async pruneArchive(now = Date.now()): Promise<number> {
    if (!existsSync(this.archiveDir)) return 0;
    const files = await fs.readdir(this.archiveDir);
    let removed = 0;
    const cutoff = now - ARCHIVE_RETENTION_DAYS * 24 * 3600 * 1000;
    for (const f of files) {
      if (!f.startsWith('ckpt_')) continue;
      const path = join(this.archiveDir, f);
      try {
        const st = await fs.stat(path);
        if (st.mtimeMs < cutoff) {
          await fs.unlink(path);
          removed++;
        }
      } catch (e) {
        // 单个文件清理失败不影响整体，但必须留痕——
        // 静默跳过会让「清理没生效」这件事无法排查（曾因此排查过一轮）
        console.warn(`[checkpoint] 清理存档失败：${f} —— ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return removed;
  }

  totalBytes(): number {
    return this.memory.reduce((s, c) => s + c.bytes, 0);
  }

  /** 清空内存栈（切换项目时调用；磁盘存档保留） */
  clearMemory(): void {
    this.memory = [];
  }
}