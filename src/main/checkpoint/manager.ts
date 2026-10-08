/**
 * Checkpoint 管理器（架构 §1.4.4）。
 *
 * ★★★ **fail-safe 是本模块存在的全部理由** ★★★
 *
 * 架构 §6.1 第 11 条铁律：「快照失败 = 拒绝执行，不是『继续执行并记录警告』」。
 * 老板决策 ① 把 preview 从第一道防线撤下后，checkpoint 就成了**唯一防线**——
 * 一旦它变成「尽力而为」，用户原稿就失去了最后保障。
 *
 * 因此 `requireCheckpoint()` 的语义是：
 *   成功 → 返回 checkpointId，允许继续
 *   失败 → **抛错**，调用方必须拒绝执行，绝不允许 catch 后继续
 */
import type { Patch } from '@shared/types/tool';
import type { Checkpoint, CheckpointConfig } from '@shared/types/checkpoint';
import { newCheckpointId } from '@shared/util/id';
import { DEFAULT_CHECKPOINT_CONFIG } from '@shared/constants/checkpoint';
import { CheckpointStore } from './store';

export interface SnapshotProvider {
  /** 取当前章节正文；返回 null 表示该章不存在 */
  getBody(chapterId: string): Promise<string | null>;
  /** 写回章节正文（回滚时用） */
  setBody(chapterId: string, body: string): Promise<void>;
}

export class CheckpointError extends Error {
  constructor(
    message: string,
    readonly chapters: string[],
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

export class CheckpointManager {
  private readonly store: CheckpointStore;
  /** runId -> 该 run 的 checkpoint 序列（轨迹面板与 checkpoint 一一对应） */
  private byRun = new Map<string, Checkpoint[]>();
  /**
   * 磁盘存档索引（hydrate() 时载入）。
   * 让「改动历史」与跨会话回滚能看到上一次会话的 checkpoint ——
   * 内存栈只保留最近 maxDepth 条，更早的靠这份索引 + 按需读文件。
   */
  private archivedIndex: Checkpoint[] = [];

  constructor(
    private readonly provider: SnapshotProvider,
    archiveDir: string,
    /** 当前生效的 checkpoint 配置（供 UI 展示容量） */
    private readonly config: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG,
  ) {
    this.store = new CheckpointStore(config, archiveDir);
    // 透传给 store；同时保留引用供 stats/UI 查询容量
    this.config = config;
  }

  /**
   * ★ 强制快照。写工具在改动任何正文**之前**必须调用它。
   *
   * 失败即抛 CheckpointError——调用方**不得** catch 后继续执行。
   * 这是「改了但没快照」这个状态被彻底禁止的唯一保证。
   */
  async requireCheckpoint(
    runId: string,
    stepNo: number,
    toolName: string,
    chapters: readonly string[],
  ): Promise<string> {
    if (chapters.length === 0) {
      throw new CheckpointError('空章节列表无法建立快照', []);
    }

    const patches: Patch[] = [];
    const failed: string[] = [];

    for (const chapterId of chapters) {
      try {
        const beforeText = await this.provider.getBody(chapterId);
        if (beforeText === null) {
          failed.push(chapterId);
          continue;
        }
        patches.push({
          chapterId,
          beforeText,
          // afterText 在 commit 时填充；快照阶段只知道改前状态
          afterText: beforeText,
          bytes: Buffer.byteLength(beforeText, 'utf8'),
          at: Date.now(),
          runId,
          toolName,
          edits: [],
        });
      } catch (e) {
        failed.push(chapterId);
      }
    }

    if (failed.length > 0) {
      throw new CheckpointError(
        `快照失败，拒绝执行（涉及章节：${failed.join(', ')}）。` +
          `这是 fail-safe 设计：宁可不做，也不能留下「改了但没快照」的状态。`,
        failed,
      );
    }

    const ck: Checkpoint = {
      id: newCheckpointId(),
      runId,
      stepNo,
      toolName,
      at: Date.now(),
      patches,
      affectedChapters: [...chapters],
      bytes: patches.reduce((s, p) => s + p.bytes, 0),
      seq: this.store.nextSeq(),
      tier: 'memory',
      rolledBackAt: null,
      editsCount: 0,
    };

    const evicted = await this.store.push(ck);
    if (evicted.length > 0) {
      // 淘汰不丢数据：转存磁盘，用户仍可回滚（只是慢一点）
      for (const e of evicted) this.trackInRun(e);
    }
    this.trackInRun(ck);

    return ck.id;
  }

  /** 执行成功后提交：把改后正文写进 patch 并记录改动数 */
  async commit(
    checkpointId: string,
    afterBodies: Map<string, string>,
    editsCount: number,
  ): Promise<void> {
    const ck = this.find(checkpointId);
    if (!ck) return;
    for (const patch of ck.patches) {
      const after = afterBodies.get(patch.chapterId);
      if (after !== undefined) patch.afterText = after;
    }
    ck.editsCount = editsCount;
  }

  /**
   * 全部已知checkpoint（含已被 LRU 淘汰的）。
   *
   * ★ **必须包含已淘汰项**：LRU 淘汰只是把数据转存磁盘，
   *   若这里只查内存栈，被淘汰的 checkpoint 就再也读不回来了——
   *   等于「淘汰」变成了「删除」，违反架构 §6.1 第 13 条。
   *
   *   注意按 id 去重：同一 checkpoint 可能同时出现在内存栈与 byRun 里
   *   （淘汰后它只剩后者），不去重会让 undoTo 重复撤销同一步。
   */
  private allKnown(): Checkpoint[] {
    const map = new Map<string, Checkpoint>();
    // 最底层：磁盘存档索引（跨会话还原来的）。优先级最低，
    // 上面的 run 序列与内存栈会用更新的副本覆盖它。
    for (const ck of this.archivedIndex) map.set(ck.id, ck);
    // 先放 run 序列（它保留被淘汰项的历史视图）
    for (const arr of Array.from(this.byRun.values())) {
      for (const ck of arr) map.set(ck.id, ck);
    }
    // 再放内存栈：**覆盖** run 序列里的同名项——
    // 被淘汰时 trackInRun() 存入的是淘汰前的副本（tier 仍是 'memory'、无 archiveFile），
    // 用内存栈的版本才能拿到正确的 tier 与磁盘路径。
    // 内存栈里没有的（已淘汰）才用 run 序列的副本 —— 但它需要 archiveFile 才能读回，
    // 故淘汰时必须把带 archiveFile 的版本写回 byRun。
    for (const ck of this.store.list()) map.set(ck.id, ck);
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }

  find(id: string): Checkpoint | undefined {
    return this.allKnown().find((ck) => ck.id === id);
  }

  /** 某run 的 checkpoint 序列（按 seq 升序），轨迹面板用 */
  listForRun(runId?: string): Checkpoint[] {
    if (!runId) return this.store.list();
    return (this.byRun.get(runId) ?? []).slice().sort((a, b) => a.seq - b.seq);
  }

  /** 回滚到某checkpoint 之前：返回被撤销的 checkpoint（倒序） */
  checkpointsAfter(seq: number): Checkpoint[] {
    return this.store.undoToSeq(seq);
  }

  /**
   * 回滚：需要把「被撤销的那些 checkpoint 的原文」应用到各章。
   *
   * ★ 从 allKnown() 取而非 store.undoToSeq()：
   *   已被 LRU 淘汰的 checkpoint 仍需参与回滚（架构 §6.1 第 13 条），
   *   它们已不在内存栈里，只查内存会导致「回滚不完整」——
   *   正文停在中间态，比不回滚更难理解。
   *
   * 按 seq 倒序应用，保证「后改的先撤」。
   */
  checkpointsToUndo(seq: number): Checkpoint[] {
    return this.allKnown()
      .filter((c) => c.rolledBackAt === null && c.seq > seq)
      .sort((a, b) => b.seq - a.seq);
  }

  /**
   * 标记已回滚。★ 改为 async：标记必须写回磁盘存档，
   * 否则重启后标记丢失，`checkpointsToUndo()` 会把同一步再撤一次。
   */
  async markRolledBack(seq: number): Promise<void> {
    await this.store.markRolledBack(seq, Date.now());
    // 同步更新索引里的副本，避免本次会话内 allKnown() 读到旧标记
    for (const ck of this.archivedIndex) {
      if (ck.seq === seq) ck.rolledBackAt = Date.now();
    }
  }

  /**
   * 从磁盘存档还原上一次会话的 checkpoint（打开项目时调用）。
   *
   * ★ 修复前 `restoreSeq()` 与 `pruneArchive()` 全项目**都没有调用者**：
   *   内存栈重启即空 → 「改动历史」归零、无法回滚上次会话的任何改动；
   *   磁盘存档则既读不回来、又永不清理 → 无限增长的一堆不可达垃圾。
   *
   * 存档目录本身按项目隔离（`<项目根>/checkpoints/archive`），无需额外的项目过滤。
   *
   * @returns 还原的存档条数
   */
  async hydrate(): Promise<number> {
    const pruned = await this.store.pruneArchive();
    if (pruned > 0) console.log(`[checkpoint] 已清理过期存档 ${pruned} 份`);
    this.archivedIndex = await this.store.listArchived();
    const n = await this.store.hydrateFromDisk();
    // hydrateFromDisk 只把最近 maxDepth 条放回内存栈，其余留在 archivedIndex；
    // 两边可能有重叠，allKnown() 用 Map 去重，内存栈版本优先。
    return n;
  }

  /** 读回一个 checkpoint（内存或磁盘） */
  async read(id: string): Promise<Checkpoint | null> {
    const ck = this.find(id);
    if (!ck) return null;
    return this.store.readArchived(ck);
  }

  stats(): { depth: number; bytes: number; tier: Checkpoint['tier'][] } {
    const list = this.store.list();
    return {
      depth: list.length,
      bytes: this.store.totalBytes(),
      tier: list.map((c) => c.tier),
    };
  }

  /** 当前生效的 checkpoint 配置（供 UI 展示深度/容量上限） */
  get limits(): CheckpointConfig {
    return this.config;
  }

  /** 容量占用比例，供 UI 显示「撤销栈已用 12%」 */
  usageRatio(): number {
    return this.config.maxTotalBytes > 0
      ? this.store.totalBytes() / this.config.maxTotalBytes
      : 0;
  }

  totalBytes(): number {
    return this.store.totalBytes();
  }

  /**
   * 清理超过保留期的磁盘存档。
   * @param now 当前时间（可注入，便于测试「已过期」场景）
   */
  pruneArchive(now?: number): Promise<number> {
    return this.store.pruneArchive(now);
  }

  restoreSeq(maxSeq: number): void {
    this.store.restoreSeq(maxSeq);
  }

  clearProject(): void {
    this.store.clearMemory();
    this.byRun.clear();
    // 存档索引也必须清：它属于上一个项目，留着会让新项目看到别的项目的改动历史
    this.archivedIndex = [];
  }

  private trackInRun(ck: Checkpoint): void {
    const arr = this.byRun.get(ck.runId) ?? [];
    // 被淘汰的也要记进run 序列，否则改动历史会缺节点。
    // 关键：淘汰项必须记**带archiveFile 的版本**，否则事后无从判断它已转存磁盘、
    // 也无从从磁盘读回 —— 那等于「淘汰 = 删除」，违反架构 §6.1 第 13 条。
    const i = arr.findIndex((c) => c.id === ck.id);
    if (i >= 0) arr[i] = ck;
    else arr.push(ck);
    this.byRun.set(ck.runId, arr);
  }
}