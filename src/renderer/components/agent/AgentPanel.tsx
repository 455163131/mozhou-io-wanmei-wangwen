/**
 * Agent 轨迹面板（架构 T20）—— **本产品的核心信任机制**。
 *
 * ★ 必须满足的 6 条（架构 §4.2），逐条对应实现：
 *   1. 每步可见：工具名 + 参数 + 结果摘要 + 耗时   → StepTimeline
 *   2. 决策理由可见：为什么选它不选别的            → rationale 字段
 *   3. 可叫停：⏸ 叫停 = 停止下一步，已执行保留
 *   4. 可回滚：按 checkpoint 回退                   → RollbackHint
 *   5. 失败不隐藏：失败步骤红显 + 写明原因与已尝试策略
 *   6. 半成品可续：关闭后重开能接着跑
 *
 * ★★★ 三态区分（架构 §6.1 第 12 条）★★★：
 *   叫停 / 停止 run / 回滚到 N 步是**三个独立控件**。
 *   叫停保留改动，回滚丢弃改动。混为一谈会导致用户误删自己满意的段落。
 */
import { useState } from 'react';
import { useAgentStore, useProjectStore } from '../../store';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import type { StepRecord, TerminationReason } from '@shared/types/agent';
import { TERMINATION_TEXT } from '@shared/types/ipc';
import type { Plan } from '@shared/types/agent';
import styles from './AgentPanel.module.css';

/** 终止原因 → 徽标样式与解释 */
function terminationBadge(reason: TerminationReason): { cls: string; text: string; detail: string } {
  const base = TERMINATION_TEXT[reason.code] ?? reason.code;
  switch (reason.code) {
    case 'GOAL_ACHIEVED':
      return { cls: 'ok', text: base, detail: reason.summary };
    case 'MAX_STEPS':
      return { cls: 'warn', text: base, detail: `已执行 ${reason.used} 步，上限 ${reason.limit} 步` };
    case 'BUDGET_EXCEEDED':
      return {
        cls: 'warn',
        text: base,
        detail: `已用 ${reason.spentTokens.toLocaleString()} token` +
          (reason.limitCny > 0 ? ` / 预算 ¥${reason.limitCny}` : '（本地模型不计费，按本机耗时约束）'),
      };
    case 'NO_PROGRESS':
      return { cls: 'warn', text: base, detail: `连续 ${reason.stalls} 步没有进展` };
    case 'LOOP_REPEAT_ARG':
      return {
        cls: 'risk',
        text: base,
        detail: `工具 ${reason.toolName} 用相同参数调用了 ${reason.times} 次（指纹 ${reason.argsHash}）。` +
          `这通常意味着 Agent 卡住了 —— 建议在指令里说得更具体些。`,
      };
    case 'LOOP_STATE_OSCILLATION':
      return {
        cls: 'risk',
        text: base,
        detail: `状态指纹呈往复模式（${reason.pattern}）：改了又改回来。`,
      };
    case 'LOOP_NO_EFFECT':
      return { cls: 'risk', text: base, detail: `连续 ${reason.unchangedSteps} 步正文没有任何变化` };
    case 'CONSECUTIVE_FAILURE':
      return { cls: 'risk', text: base, detail: `最后错误：${reason.lastError}` };
    case 'USER_ABORTED':
      return { cls: 'warn', text: base, detail: `在第 ${reason.atStep} 步叫停。已做的改动都保留了。` };
    case 'VALIDATION_FAILED':
      return { cls: 'risk', text: base, detail: reason.errors.join('；') };
    default:
      return { cls: 'warn', text: base, detail: '' };
  }
}

function StepRow({ step }: { step: StepRecord }): JSX.Element {
  const [open, setOpen] = useState(false);
  const statusIcon =
    step.status === 'succeeded' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'rolled-back' ? '↩' : '▶';

  return (
    <div className={`${styles.step} ${styles[step.status]}`}>
      <button className={styles.stepHead} onClick={() => setOpen(!open)} title="点击展开详情">
        <span className={styles.stepIcon}>{statusIcon}</span>
        <span className={styles.stepNo}>{step.stepNo}</span>
        <span className={styles.toolName}>{step.toolName}</span>
        <span className={styles.dur}>{(step.durationMs / 1000).toFixed(1)}s</span>
      </button>

      <div className={styles.resultSummary}>{step.resultSummary}</div>

      {/* ★ 决策理由必须显式可见，不能藏在日志里（验收标准第 2 条） */}
      {step.rationale && <div className={styles.rationale}>理由：{step.rationale}</div>}

      {/* 副作用卡片：告诉用户「哪条规则被自动撤回了，为什么」 */}
      {step.sideEffects && step.sideEffects.length > 0 && (
        <div className={styles.sideEffect}>
          <div className={styles.sideEffectTitle}>⚠ 检测到副作用，已自动撤回</div>
          {step.sideEffects.map((e, i) => (
            <div key={i} className={styles.sideEffectItem}>
              {e.explanation}
            </div>
          ))}
        </div>
      )}

      {/* 失败不隐藏：写明已尝试过的策略 */}
      {step.errorMessage && (
        <div className={styles.errorBox}>
          <div>{step.errorMessage}</div>
          {step.attempts && step.attempts.length > 0 && (
            <div className={styles.attempts}>已尝试：{step.attempts.join(' → ')}</div>
          )}
        </div>
      )}

      {open && (
        <div className={styles.detail}>
          <div className={styles.detailRow}>
            <span>参数</span>
            <code>{step.argsSummary}</code>
          </div>
          {step.edits && step.edits.length > 0 && (
            <div className={styles.detailRow}>
              <span>改动 {step.edits.length} 处</span>
              <div className={styles.editList}>
                {step.edits.slice(0, 10).map((e, i) => (
                  <div key={i} className={styles.editItem}>
                    <span className={styles.before}>{e.before}</span>
                    <span className={styles.arrow}>→</span>
                    <span className={styles.after}>{e.after}</span>
                  </div>
                ))}
                {step.edits.length > 10 && (
                  <div className={styles.more}>…还有 {step.edits.length - 10} 处</div>
                )}
              </div>
            </div>
          )}
          {step.checkpointId && (
            <div className={styles.detailRow}>
              <span>可回滚点</span>
              <code>{step.checkpointId}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlanView({ plan }: { plan: Plan }): JSX.Element {
  return (
    <div className={styles.planBox}>
      <div className={styles.planGoal}>{plan.goalRestated}</div>
      <ol className={styles.planSteps}>
        {plan.steps.map((s) => (
          <li key={s.index}>
            <span>{s.intent}</span>
            {s.rationale && <em>（{s.rationale}）</em>}
          </li>
        ))}
      </ol>
      {/* ★「我打算不做什么」是自主决策的直接证据 */}
      {plan.explicitlySkipped && plan.explicitlySkipped.length > 0 && (
        <div className={styles.skippedBox}>
          <div className={styles.skippedTitle}>主动跳过</div>
          {plan.explicitlySkipped.map((s, i) => (
            <div key={i} className={styles.skippedItem}>
              <strong>{s.what}</strong> —— {s.why}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentPanel(): JSX.Element {
  // ★ 用 selector 订阅：只有轨迹相关的字段变化才重渲染本组件
  const status = useAgentStore((s) => s.status);
  const steps = useAgentStore((s) => s.steps);
  const plan = useAgentStore((s) => s.plan);
  const termination = useAgentStore((s) => s.termination);
  const stats = useAgentStore((s) => s.stats);
  const runId = useAgentStore((s) => s.runId);
  const llmStatus = useAgentStore((s) => s.llmStatus);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const currentChapter = useProjectStore((s) => s.currentChapterId);

  const running = status !== 'idle' && status !== 'terminated';

  async function run(): Promise<void> {
    if (!goal.trim()) return;
    setBusy(true);
    try {
      const scope = currentChapter ? [currentChapter] : undefined;
      const res = await bridge().agent.run({
        goal: goal.trim(),
        chapterIds: scope,
      });
      useAgentStore.getState().setRun(res.runId, goal.trim());
      setGoal('');
    } catch (e) {
      useProjectStore.getState().setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // ★ 叫停：停止下一步，**保留已改**（≠ 回滚）
  async function abort(): Promise<void> {
    if (!runId) return;
    try {
      await bridge().agent.abort(runId);
    } catch (e) {
      useProjectStore.getState().setError(errorText(e));
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Agent</span>
        {llmStatus && <ProviderBadge status={llmStatus} />}
      </div>

      {/* 指令输入 */}
      <div className={styles.inputRow}>
        <input
          className={styles.input}
          value={goal}
          placeholder={
            currentChapter ? `对第 ${currentChapter} 章…（例如：AI 味太重了，你看着改）` : '说一句话就行…'
          }
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) void run();
          }}
          disabled={running}
        />
        <button className={styles.runBtn} onClick={() => void run()} disabled={running || busy || !goal.trim()}>
          执行
        </button>
      </div>

      {/* ★★★ 三态独立控件，绝不能合并 ★★★ */}
      {running && (
        <div className={styles.controls}>
          <button className={styles.abortBtn} onClick={() => void abort()}>
            ⏸ 叫停（保留已改）
          </button>
          <RollbackHint />
        </div>
      )}

      {plan && <PlanView plan={plan} />}

      {/* 预算仪表：实时可见 */}
      <div className={styles.budget}>
        <span>步数 {steps.length}</span>
        <span>工具调用 {stats.toolCalls}</span>
        <span>改动 {stats.edits} 处</span>
        <span>
          {llmStatus?.isLocal
            ? `本机耗时 ${(stats.wallMs / 1000).toFixed(0)}s`
            : `¥${stats.costCny.toFixed(4)}`}
        </span>
      </div>

      {/* 轨迹 */}
      <div className={styles.timeline}>
        {steps.length === 0 && !running && (
          <div className={styles.empty}>还没有执行记录。说一句话试试。</div>
        )}
        {steps.map((s) => (
          <StepRow key={s.stepNo} step={s} />
        ))}
      </div>

      {/* 终止徽标 */}
      {termination && <TerminationBadgeView reason={termination} keptChanges={stats.edits} />}
    </div>
  );
}

/** ★ 四态明示（架构 §1.4.5）：不能都显示「已连接」 */
function ProviderBadge({ status }: { status: NonNullable<ReturnType<typeof useAgentStore.getState>['llmStatus']> }): JSX.Element {
  const ui = status.uiState;
  const map: Record<string, { text: string; cls: string; tip: string }> = {
    'cloud-native': { text: '● 云端 · 工具调用可用', cls: 'ok', tip: '完整 Agent 能力' },
    'cloud-prompted': {
      text: '● 云端 · 文本协议',
      cls: 'warn',
      tip: '工具调用走文本协议（<<TOOL:...>>），解析失败率高于原生 tools',
    },
    'local-prompted': {
      text: '● 本地 · 文本协议',
      cls: 'warn',
      tip: '本地模型工具调用走文本协议，可能失败较多。建议用于规则执行而非复杂规划。',
    },
    'local-unsupported': {
      text: '⚠ 本地 · 不支持工具调用',
      cls: 'risk',
      tip: '★能力降级（非错误）：已切换为单步模式，工具需你手动选择，Agent 不再做自主规划。',
    },
    unconfigured: {
      text: '○ 未配置模型 · 规则模式',
      cls: 'muted',
      tip: '规则模式仍可用：所有工具都能手动调，只是没有自主规划。这是可用状态，不是错误。',
    },
  };
  const m = map[ui.kind] ?? map['unconfigured'];
  return (
    <span className={`${styles.providerBadge} ${styles[m.cls]}`} title={m.tip}>
      {m.text}
    </span>
  );
}

/**
 * 终止徽标。
 * ★ 明确告知「改动保留了」+ 回滚入口——闸门终止不回滚是刻意设计。
 */
function TerminationBadgeView({
  reason,
  keptChanges,
}: {
  reason: TerminationReason;
  keptChanges: number;
}): JSX.Element {
  const badge = terminationBadge(reason);
  return (
    <div className={`${styles.termination} ${styles[badge.cls]}`}>
      <div className={styles.termTitle}>{badge.text}</div>
      <div className={styles.termDetail}>{badge.detail}</div>
      {keptChanges > 0 && (
        <div className={styles.keptNote}>
          已改动 {keptChanges} 处，<strong>改动都保留了</strong>。不满意可在「改动历史」里回滚到任意一步。
        </div>
      )}
    </div>
  );
}

/** 回滚入口（与叫停分离的独立控件） */
function RollbackHint(): JSX.Element | null {
  const checkpoints = useAgentStore((s) => s.checkpoints);
  if (checkpoints.length === 0) return null;
  const last = checkpoints[checkpoints.length - 1];

  async function undo(): Promise<void> {
    if (!last) return;
    try {
      await bridge().checkpoint.undo(last.id, false);
    } catch (e) {
      // E_ROLLBACK_CONFLICT 会走到这里——必须让用户看到会丢什么
      const msg = errorText(e);
      if (msg.includes('手动修改')) {
        const ok = window.confirm(`${msg}\n\n确认要强制回滚吗？`);
        if (ok) await bridge().checkpoint.undo(last.id, true);
      } else {
        useProjectStore.getState().setError(msg);
      }
    }
  }

  return (
    <button className={styles.rollbackBtn} onClick={() => void undo()}>
      ↩ 回滚上一步（丢弃改动）
    </button>
  );
}