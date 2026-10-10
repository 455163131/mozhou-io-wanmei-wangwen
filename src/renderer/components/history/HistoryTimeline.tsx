/**
 * 改动历史视图（架构 T21）—— 自动执行模式的核心信任机制。
 *
 * checkpoint 与轨迹面板的步骤一一对应，所以这里的时间线
 * 与 AgentPanel 的步骤列表是同一批节点，只是视角不同：
 *   AgentPanel 看的是「Agent 做了什么」
 *   HistoryTimeline 看的是「我能回滚到哪」
 */
import { useEffect, useState } from 'react';
import { useAgentStore } from '../../store';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { useProjectStore } from '../../store';
import { useConfirm, ConfirmDialog } from '../common/ConfirmDialog';
import styles from './HistoryTimeline.module.css';

export function HistoryTimeline(): JSX.Element {
  const checkpoints = useAgentStore((s) => s.checkpoints);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // ★ 第 31 条：确认走应用内遮罩，不再用 window.confirm（Chromium 自绘、
  //   自动化点不到、也说不出"撤回哪一步"）
  const { confirm, node: confirmNode } = useConfirm();

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    try {
      const list = await bridge().checkpoint.list();
      useAgentStore.getState().setCheckpoints(list);
    } catch {
      // 拿不到历史不影响编辑
    }
  }

  async function rollback(id: string, stepNo: number): Promise<void> {
    setBusy(true);
    try {
      await bridge().checkpoint.undo(id, false);
    } catch (e) {
      const msg = errorText(e);
      if (msg.includes('手动修改')) {
        // ★ 必须明示会丢什么，绝不静默覆盖用户的劳动（架构 §6.1 第 14 条）
        const ok = await confirm({
          title: `回滚到第 ${stepNo} 步之前？`,
          body: `${msg}\n回滚到第 ${stepNo} 步之前，将丢失这之后的改动。`,
          warn: '这一步之后的正文改动会被覆盖，且无法撤销。',
          confirmText: '确认回滚',
          danger: true,
        });
        if (ok) {
          try {
            await bridge().checkpoint.undo(id, true);
          } catch (e2) {
            useProjectStore.getState().setError(errorText(e2));
          }
        }
      } else {
        useProjectStore.getState().setError(msg);
      }
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  // ★ Array.isArray 防御：checkpoints 来自 store，曾被 IPC 错误对象污染过
  //   （桥接层已修复为 throw，这里保留防御，避免同类问题再次黑屏）。
  // ★ 空态也必须带上 confirmNode：确认框是**已经开着**的东西，此刻列表被刷成空
  //   （例如回滚后 refresh 回来 0 条），遮罩要是跟着消失，用户就卡在一个
  //   已经提交的确认上——遮罩在、没有按钮，整个界面点不动。
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return (
      <>
        {confirmNode}
        <div className={styles.empty}>还没有改动记录。Agent 修改正文后会在此出现可回滚节点。</div>
      </>
    );
  }

  // 倒序：最近的在上
  const ordered = [...checkpoints].sort((a, b) => b.seq - a.seq);

  return (
    <div className={styles.wrap}>
      {confirmNode}
      <div className={styles.header}>
        <span>改动历史（{checkpoints.length}）</span>
        <span className={styles.hint}>每一步都可回滚</span>
      </div>
      {ordered.map((ck) => (
        <div key={ck.id} className={styles.node}>
          <button className={styles.nodeHead} onClick={() => setExpanded(expanded === ck.id ? null : ck.id)}>
            <span className={styles.seq}>第 {ck.stepNo} 步</span>
            <span className={styles.tool}>{ck.toolName}</span>
            <span className={styles.edits}>{ck.editsCount} 处</span>
            {/* ★ 被 LRU 淘汰的显示为「需从磁盘读取」而非消失（架构 §6.1 第 13 条） */}
            {ck.tier === 'archive' && (
              <span className={styles.archive} title="已转存磁盘，回滚时从磁盘读取（只慢一点，不会丢）">
                需从磁盘读取
              </span>
            )}
            {ck.rolledBackAt !== null && <span className={styles.rolled}>已回滚</span>}
          </button>
          {expanded === ck.id && (
            <div className={styles.detail}>
              <div className={styles.detailRow}>时间：{new Date(ck.at).toLocaleString('zh-CN')}</div>
              <div className={styles.detailRow}>涉及章节：{ck.affectedChapters.join('、')}</div>
              <div className={styles.detailRow}>大小：{(ck.bytes / 1024).toFixed(1)} KB</div>
              <button
                className={styles.rollbackBtn}
                disabled={busy}
                onClick={() => void rollback(ck.id, ck.stepNo)}
              >
                ↩ 回滚到这一步之前
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 回滚确认对话框（架构 T21 RollbackConfirmDialog）。
 *
 * ★ 第 31 条：这个组件以前是**死代码**——写好了、样式也在，全仓零调用方，
 *   两处回滚入口都在用 `window.confirm`。现在它收敛成 `ConfirmDialog`
 *   的一层薄包装：遮罩/焦点/Esc 的行为只剩一份实现，这里只翻译"回滚"
 *   这件事的文案口径（checkpointId 给技术同学看，步号给作者看）。
 *   保留这个名字是因为架构文档 T21 点的是它。
 */
export function RollbackConfirmDialog({
  checkpointId,
  stepNo,
  lostCount,
  onConfirm,
  onCancel,
}: {
  checkpointId: string;
  stepNo?: number;
  lostCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <ConfirmDialog
      title={stepNo === undefined ? '确认回滚？' : `回滚到第 ${stepNo} 步之前？`}
      body={`回滚到 checkpoint ${checkpointId} 之前。`}
      warn={
        lostCount > 0
          ? `⚠️ 你在此期间对其它章节做了 ${lostCount} 处手动修改，回滚会覆盖它们。`
          : null
      }
      confirmText="确认回滚"
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}