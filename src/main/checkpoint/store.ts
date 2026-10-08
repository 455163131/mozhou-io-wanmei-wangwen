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
import { atomicWrite } from '../fs/project-fs';

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
   *
   * ★ 写穿（write-through）：入栈即落盘，不再等到 LRU 淘汰才写文件。
   *   修复前只有被淘汰的 checkpoint 才有磁盘副本，内存栈里的那些一重启就全没了
   *   ——`checkpoints` 表也从未被写入，于是「改动历史」重启即归零，
   *   用户无法回滚上一次会话的任何改动。
   *   现在每一步都有磁盘副本，`hydrateFromDisk()` 能在重开后完整还原。
   *
   * @returns 被淘汰（转出内存栈）的 checkpoint
   */
  async push(ck: Checkpoint): Promise<Checkpoint[]> {
    // 落盘的是 archive 形态（tier='archive' + archiveFile）；
    // 内存副本保留 tier='memory' 但同样带上 archiveFile，
    // 这样淘汰时无需再写一次文件，只需翻转 tier。
    const archiveFile = ck.archiveFile ?? (await this.writeArchiveFile(ck));
    this.memory.push({ ...ck, archiveFile });
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
   * 淘汰最老的一条，转出内存栈。
   * 策略：默认 lru（最老未回滚的），fifo 则取最早入栈的（哪怕已回滚）。
   * ★ 淘汰 ≠ 删除：磁盘副本在 push 时就已写好，这里只翻转 tier。
   */
  private async evictOldest(): Promise<Checkpoint> {
    let idx = 0;
    if (this.config.strategy === 'lru') {
      // LRU：优先淘汰「已回滚」的（用户已不需要），其次最老的
      const rolledIdx = this.memory.findIndex((c) => c.rolledBackAt !== null);
      idx = rolledIdx >= 0 ? rolledIdx : 0;
    }
    const [victim] = this.memory.splice(idx, 1);
    return this.archive(victim);
  }

  /** 把 checkpoint 写成磁盘存档文件，返回文件名 */
  private async writeArchiveFile(ck: Checkpoint): Promise<string> {
    const file = `ckpt_${ck.seq}_${ck.id}.json`;
    const path = join(this.archiveDir, file);
    const archived: Checkpoint = { ...ck, tier: 'archive' as CheckpointTier, archiveFile: file };
    // ★ 用 atomicWrite（含 fsync）而非裸 writeFile：
    //   存档是回滚的最后防线，写一半崩溃留下截断的 JSON，
    //   等于在最需要它的时候失效。
    await atomicWrite(path, JSON.stringify(archived));
    return file;
  }

  /** 转存磁盘（淘汰路径：文件通常已由 writeArchiveFile 写好，此处只翻转 tier） */
  private async archive(ck: Checkpoint): Promise<Checkpoint> {
    const file = ck.archiveFile ?? (await this.writeArchiveFile(ck));
    // ★ 先改 tier 再返回：若读回时看到 tier='memory' 而没有 archiveFile，
    //   调用方就无法判断它已转存、也无法再次定位文件。
    return { ...ck, tier: 'archive' as CheckpointTier, archiveFile: file };
  }

  /**
   * 从磁盘存档目录还原（应用重启 / 重新打开项目时调用）。
   *
   * ★ 这是「回滚能力跨会话存活」的关键。修复前 `restoreSeq()` 全项目无调用者，
   *   内存栈重启即空，改动历史归零。
   *
   * 存档目录本身就按项目隔离（`<项目根>/checkpoints/archive`），
   * 因此不需要额外的项目维度过滤。
   *
   * @returns 还原的条数
   */
  async hydrateFromDisk(): Promise<number> {
    if (!existsSync(this.archiveDir)) return 0;
    let files: string[];
    try {
      files = await fs.readdir(this.archiveDir);
    } catch {
      return 0;
    }

    const restored: Checkpoint[] = [];
    for (const f of files) {
      if (!f.startsWith('ckpt_') || !f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(join(this.archiveDir, f), 'utf8');
        const ck = JSON.parse(raw) as Checkpoint;
        // 基本形状校验：缺字段的脏文件直接跳过，不让它污染整个历史
        if (typeof ck?.seq !== 'number' || typeof ck?.id !== 'string') continue;
        ck.archiveFile = ck.archiveFile ?? f;
        ck.tier = 'archive';
        restored.push(ck);
      } catch (e) {
        // 单个存档损坏不该让整份历史读不出来——留痕并继续
        console.warn(
          `[checkpoint] 存档还原失败，已跳过：${f} —— ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (restored.length === 0) return 0;

    restored.sort((a, b) => a.seq - b.seq);
    // seq 必须接着历史最大值走，否则新 checkpoint 会与旧的撞 seq
    this.restoreSeq(restored[restored.length - 1].seq);

    // 只把最近的 maxDepth 条放回内存栈（L1 是缓存，不是全量）；
    // 其余保持 archive tier —— 仍可通过 allKnown()/readArchived() 回滚。
    const inMemoryIds = new Set(this.memory.map((c) => c.id));
    for (const ck of restored.slice(-this.config.maxDepth)) {
      if (inMemoryIds.has(ck.id)) continue;
      this.memory.push({ ...ck, tier: 'memory' as CheckpointTier });
    }
    this.memory.sort((a, b) => a.seq - b.seq);
    return restored.length;
  }

  /** 列出磁盘上全部存档的元信息（不回内存栈，供「改动历史」跨会话展示） */
  async listArchived(): Promise<Checkpoint[]> {
    if (!existsSync(this.archiveDir)) return [];
    let files: string[];
    try {
      files = await fs.readdir(this.archiveDir);
    } catch {
      return [];
    }
    const out: Checkpoint[] = [];
    for (const f of files) {
      if (!f.startsWith('ckpt_') || !f.endsWith('.json')) continue;
      try {
        const ck = JSON.parse(await fs.readFile(join(this.archiveDir, f), 'utf8')) as Checkpoint;
        if (typeof ck?.seq !== 'number') continue;
        out.push({ ...ck, archiveFile: ck.archiveFile ?? f, tier: 'archive' });
      } catch {
        // 损坏的存档在 listArchived 里静默跳过即可；readArchived 会显式报 null
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
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

  /**
   * 标记已回滚（不删除，用户可能想再滚回来）。
   *
   * ★ 两处修复：
   *   1. **必须写回磁盘存档**。只改内存副本的话，重启后回滚标记丢失，
   *      `checkpointsToUndo()` 会把同一步再撤一次。
   *   2. **已被淘汰出内存栈的也要标记**。修复前这里只 `this.memory.find(...)`，
   *      淘汰项永远标不上——而淘汰项恰恰是跨会话回滚的主要对象。
   */
  async markRolledBack(seq: number, at: number): Promise<void> {
    const inMemory = this.memory.find((c) => c.seq === seq);
    if (inMemory) {
      inMemory.rolledBackAt = at;
      await this.persistFlags(inMemory);
      return;
    }
    for (const archived of await this.listArchived()) {
      if (archived.seq !== seq) continue;
      archived.rolledBackAt = at;
      await this.persistFlags(archived);
      return;
    }
  }

  /** 把 rolledBackAt / tier 这类可变标记写回该 checkpoint 的存档文件 */
  private async persistFlags(ck: Checkpoint): Promise<void> {
    if (!ck.archiveFile) return;
    const path = join(this.archiveDir, ck.archiveFile);
    if (!existsSync(path)) return;
    await atomicWrite(path, JSON.stringify({ ...ck, tier: 'archive' }));
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