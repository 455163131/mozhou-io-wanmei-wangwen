/**
 * 回滚执行器（架构 §1.4.4④、§6.1 第 14 条）。
 *
 * ★ 关键设计：**回滚要检测用户的手动修改**。
 *   自动执行期间用户很可能同时在编辑别处。若期间用户改过同一章，
 *   回滚会覆盖掉他的劳动——必须检测并弹确认（「将丢失 N 处手动修改」），
 *   对应新增错误码 E_ROLLBACK_CONFLICT。
 *
 * ★ 另一条铁律：**叫停 ≠ 回滚**。
 *   叫停 = 停止下一步、保留已改；回滚 = 撤销改动。
 *   两者在 UI 上必须是两个独立控件，绝不能混为一谈。
 */
import type { RollbackResult } from '@shared/types/checkpoint';
import type { CheckpointManager, SnapshotProvider } from './manager';
import { MzError } from '@shared/types/ipc';
import { buildQuoteRanges, inQuoteRanges } from '@shared/util/text-zh';

export interface RollbackConflict {
  checkpointId: string;
  lostManualEdits: number;
  lostEdits: Array<{ chapterId: string; at: number; snippet: string }>;
  restoredChapters: string[];
}

/**
 * 检测「用户在 checkpoint 之后是否手动改过同一章」。
 *
 * 判据：checkpoint 记录的 afterText 与当前正文不一致，且差异处不是 Agent 的编辑。
 * 保守判定——只要不一致就算可能冲突，因为宁可多问一次也不要覆盖用户劳动。
 */
export function detectManualEditConflicts(
  currentBodies: Map<string, string>,
  patches: Array<{ chapterId: string; afterText: string; edits: Array<{ before: string; after: string; at: number }> }>,
): Array<{ chapterId: string; at: number; snippet: string }> {
  const conflicts: Array<{ chapterId: string; at: number; snippet: string }> = [];

  for (const p of patches) {
    const current = currentBodies.get(p.chapterId);
    if (current === undefined) continue;
    if (current === p.afterText) continue;

    // 找出当前正文中不存在于 checkpoint 快照的片段 = 疑似用户新增
    const added = diffSnippets(p.afterText, current);
    for (const a of added) {
      conflicts.push({ chapterId: p.chapterId, at: a.at, snippet: a.text });
    }
  }

  return conflicts;
}

/** 粗粒度差异提取：找出 current 中有、base 中无的片段 */
function diffSnippets(base: string, current: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  // 以行为单位比较——正文以行为主要编辑单位，避免逐字符 diff 的噪声
  const baseLines = new Set(base.split('\n'));
  const baseLineArr = base.split('\n');
  let offset = 0;
  const curLines = current.split('\n');
  for (let i = 0; i < curLines.length; i++) {
    const line = curLines[i];
    if (!baseLines.has(line) && line.trim() !== '') {
      out.push({ at: offset, text: line.trim().slice(0, 40) });
    }
    offset += line.length + 1;
  }
  // 整段都不同时（不只是新增行），也报一次冲突
  if (out.length === 0 && base !== current && baseLineArr.length !== curLines.length) {
    out.push({ at: 0, text: '(段落结构已变化)' });
  }
  return out.slice(0, 20);
}

export class Replayer {
  constructor(
    private readonly manager: CheckpointManager,
    private readonly provider: SnapshotProvider,
  ) {}

  /**
   * 回滚到指定 checkpoint 之前。
   *
   * @param force 已向用户确认过冲突时才传 true；否则有冲突直接抛 E_ROLLBACK_CONFLICT
   * @throws E_ROLLBACK_CONFLICT 存在疑似手动修改且未 force
   */
  async undoTo(checkpointId: string, force = false): Promise<RollbackResult> {
    const ck = await this.manager.read(checkpointId);
    if (!ck) {
      throw new MzError('E_CHECKPOINT_FAILED', `找不到 checkpoint：${checkpointId}`);
    }

    const toUndo = this.manager.checkpointsToUndo(ck.seq);
    if (toUndo.length === 0) {
      return {
        checkpointId,
        undone: 0,
        fromSeq: ck.seq,
        toSeq: ck.seq,
        lostManualEdits: 0,
        lostEdits: [],
        restoredChapters: [],
      };
    }

    // 先检测冲突：把所有将被覆盖的章节当前正文收集起来
    const currentBodies = new Map<string, string>();
    const allPatches = toUndo.flatMap((c) => c.patches);
    for (const p of allPatches) {
      if (!currentBodies.has(p.chapterId)) {
        const cur = await this.provider.getBody(p.chapterId);
        if (cur !== null) currentBodies.set(p.chapterId, cur);
      }
    }
    const conflicts = detectManualEditConflicts(currentBodies, allPatches);

    if (conflicts.length > 0 && !force) {
      // **不静默**：必须让用户看到「将丢失 N 处你在此期间的其它手动修改」
      throw new MzError(
        'E_ROLLBACK_CONFLICT',
        `回滚会覆盖 ${conflicts.length} 处你在此期间的其它手动修改，需确认后再执行。`,
        { lostManualEdits: conflicts.length, lostEdits: conflicts.slice(0, 10) },
      );
    }

    // 按 seq 倒序应用，保证「后改的先撤」
    let undone = 0;
    const restored = new Set<string>();
    for (const c of toUndo) {
      for (const p of c.patches) {
        await this.provider.setBody(p.chapterId, p.beforeText);
        restored.add(p.chapterId);
        undone++;
      }
      await this.manager.markRolledBack(c.seq);
    }

    return {
      checkpointId,
      undone,
      fromSeq: Math.max(...toUndo.map((c) => c.seq)),
      toSeq: ck.seq,
      lostManualEdits: conflicts.length,
      lostEdits: conflicts.slice(0, 20),
      restoredChapters: [...restored],
    };
  }

  /** 撤销上一步（当前 run 内最近的未回滚 checkpoint 之后） */
  async undoLast(runId: string): Promise<RollbackResult | null> {
    const list = this.manager.listForRun(runId).filter((c) => c.rolledBackAt === null);
    if (list.length < 2) return null;
    // 回到倒数第二个 checkpoint 之前 = 撤销最后一步
    return this.undoTo(list[list.length - 2].id);
  }

  /**
   * 局部回滚：只撤一条规则的改动，保留其它有效改动（架构 §1.4.4⑤）。
   *
   * 与全局回滚的区别：不撤销整个 checkpoint，只把该规则的编辑从正文中移除。
   */
  async rollbackRule(
    checkpointId: string,
    chapterId: string,
    newBody: string,
  ): Promise<{ restored: boolean; body: string }> {
    const ck = await this.manager.read(checkpointId);
    if (!ck) return { restored: false, body: newBody };
    const patch = ck.patches.find((p) => p.chapterId === chapterId);
    if (!patch) return { restored: false, body: newBody };

    await this.provider.setBody(chapterId, newBody);
    patch.afterText = newBody;
    return { restored: true, body: newBody };
  }

  /**
   * 引号保护复核：回滚时若快照里含有引号内的改动，说明快照本身有问题。
   *
   * ★ 用区间表而非逐条 inQuote：本函数对**每条 edit** 都要判一次，
   *   而 `inQuote(text, at)` 单次就是 O(n)（从头扫到 at）。
   *   10 万字章节 + 数百处编辑 → 10^7~10^8 次字符比较，且发生在回滚路径上
   *   （用户等待最敏感处）。建一次表后是 O(n + m·log m)。
   *
   * ⚠️ 注意 `e.at` 的坐标系：单工具编辑是原文偏移，可直接对 `text` 判定；
   *   FixPlan.changes 那种跨规则摊平的总表则各条分属不同坐标系（见 Edit.at 注释），
   *   不能整体传进来。
   */
  static validateNoQuoteEdits(edits: Array<{ at: number; before: string; after: string }>, text: string): boolean {
    const quotes = buildQuoteRanges(text);
    return edits.every((e) => !inQuoteRanges(quotes, e.at));
  }
}