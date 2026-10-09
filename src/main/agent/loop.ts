/**
 * Agent 循环状态机（架构 §1.4.1 / T15）—— **本项目最关键的任务**。
 *
 * 状态流转：
 *   Idle → Planning → Selecting → Executing → Observing → Evaluating
 *                                                          ├→ Planning（需继续）
 *                                                          └→ [*]（目标达成）
 *   任一闸门触发 → Aborted（保留已产生的改动，可撤销）
 *
 * ★ 关键设计：**终止时不回滚已完成改动**。
 *   Agent 可能已经改好了 7 章，第 8 章超预算——全盘回滚等于白烧钱。
 *
 * ★ 四层闸门 + 双判据循环检测 + 10 种结构化终止原因，每一种都产出可读原因。
 */
import type {
  BudgetLimits,
  Evaluation,
  Observation,
  Plan,
  RunState,
  RunStats,
  StepRecord,
  TerminationReason,
} from '@shared/types/agent';
import type { ToolCall, ToolDanger, ToolResult, WritePolicy } from '@shared/types/tool';
import { BudgetGuard } from './budget-guard';
import { LoopDetector } from './loop-detector';

export type LoopPhase = 'idle' | 'planning' | 'selecting' | 'executing' | 'observing' | 'evaluating' | 'paused' | 'terminated';

export interface LoopDeps {
  /** 规划：goal + observations → Plan */
  plan: (goal: string, observations: Observation[], stepNo: number) => Promise<Plan>;
  /** 选工具：Plan + 上下文 → ToolCall */
  select: (plan: Plan, observations: Observation[], stepNo: number) => Promise<ToolCall>;
  /** 执行工具 */
  execute: (call: ToolCall, stepNo: number) => Promise<ToolResult>;
  /** 观察提取 */
  observe: (call: ToolCall, result: ToolResult, stepNo: number) => Promise<Observation>;
  /** 评估 */
  evaluate: (goal: string, observations: Observation[], stepNo: number) => Promise<Evaluation>;
  /** 当前项目状态指纹（判据 B 输入） */
  stateHash: () => Promise<string>;
  /** 推送事件到渲染层 */
  emit: (event: LoopEvent) => void;
  /** 用户是否叫停 */
  isAborted: (runId: string) => boolean;
  /**
   * ★ 第 24 条：用户是否按了暂停。
   *   修复前 `LoopDeps` 里没有这一项，`host.pausedRuns` 只写不读——
   *   「暂停」是一条谁都不看的通道，run 一步都不会停。
   */
  isPaused: (runId: string) => boolean;
  /** 暂停闸门：挂着等 resume（或 abort）落地；返回是否已被叫停 */
  waitWhilePaused: (runId: string) => Promise<{ aborted: boolean }>;
  isLocal: boolean;
  maxHistory: number;
}

export type LoopEvent =
  | { type: 'plan'; runId: string; plan: Plan }
  | { type: 'step'; runId: string; step: StepRecord }
  | { type: 'tool-call'; runId: string; stepNo: number; toolName: string; danger: ToolDanger | null; writePolicy: WritePolicy | null; argsSummary: string }
  // ★ 第 25 条：阶段变化只在这两个时刻发（其余阶段各有自己的事件，不需要额外刷屏）。
  //   渲染层的 status 全靠它，否则「暂停中」在界面上无处可来。
  | { type: 'phase'; runId: string; phase: 'paused' | 'planning' }
  | { type: 'terminated'; runId: string; reason: TerminationReason; stats: RunStats; keptChanges: number };

export function newRunStats(): RunStats {
  return {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    costCny: 0,
    wallMs: 0,
    toolCalls: 0,
    edits: 0,
    checkpoints: 0,
  };
}

export class AgentLoop {
  private phase: LoopPhase = 'idle';
  private plan: Plan | null = null;
  private observations: Observation[] = [];
  private steps: StepRecord[] = [];
  private guard: BudgetGuard;
  private detector = new LoopDetector();
  private stepNo = 0;
  private stats: RunStats = newRunStats();
  private termination: TerminationReason | null = null;
  /** 工具名 → 回滚成本，由 AgentHost 从 registry 注入；缺省 null = 不谎报 */
  private dangerByName: Map<string, ToolDanger> | null = null;
  /** 本次 run 生效的写策略，由 AgentHost 注入 */
  private reportedPolicy: WritePolicy | null = null;

  constructor(
    private readonly runId: string,
    private readonly goal: string,
    private readonly deps: LoopDeps,
    private readonly budgetLimits: BudgetLimits,
  ) {
    this.guard = new BudgetGuard(budgetLimits);
  }

  /**
   * 本次 run 的开始时刻（RunState.startedAt 的来源）。
   * ★ 第 26 条：以前 `state.startedAt` 硬写 0，于是 runs 表里的 started_at 全靠
   *   services 落库那一刻补 Date.now()（≈ 结束时间），「什么时候开的」永远读不到，
   *   listRuns 的排序也只是在排一堆零。
   */
  private readonly startedAtMs = Date.now();

  /** 预算上限，供 UI 预算仪表展示 */
  get limits(): BudgetLimits {
    return this.budgetLimits;
  }

  /** 剩余预算 */
  remaining(): ReturnType<BudgetGuard['remaining']> {
    return this.guard.remaining(this.stats, this.deps.isLocal);
  }

  get state(): RunState {
    return {
      runId: this.runId,
      goal: this.goal,
      status: this.phase === 'idle' ? 'idle' : this.phase,
      steps: this.steps,
      plan: this.plan,
      observations: this.observations,
      stats: this.stats,
      termination: this.termination,
      keptChanges: this.stats.edits,
      startedAt: this.startedAtMs,
      endedAt: this.phase === 'terminated' ? Date.now() : null,
    };
  }

  get currentPhase(): LoopPhase {
    return this.phase;
  }

  /**
   * 主循环。返回终止原因——**调用方不应假设它一定成功**。
   */
  async run(): Promise<{ reason: TerminationReason; stats: RunStats }> {
    for (;;) {
      // ── 闸门① 步数上限（在每步开始时检查）──
      const stepGate = this.guard.checkSteps();
      if (stepGate) return this.terminate(stepGate);

      this.stepNo += 1;
      const stepNo = this.stepNo;

      // ── 用户叫停（独立于回滚）──
      if (this.deps.isAborted(this.runId)) {
        return this.terminate({ code: 'USER_ABORTED', atStep: stepNo });
      }

      // ── 用户暂停：停在步与步之间，等 resume 放走 ──
      // ★ 第 24 条。粒度与叫停一致（正在跑的那一步跑完，绝不半途中断写操作），
      //   但语义相反：不终止、不留终止原因、不算失败，等。
      //   abort 落在等待里也要醒来——否则 run 永远挂在闸门上。
      if (this.deps.isPaused(this.runId)) {
        this.phase = 'paused';
        // ★ 第 25 条：报给渲染层。放在 await 之前——挂住这件事本身就得让人看见
        this.deps.emit({ type: 'phase', runId: this.runId, phase: 'paused' });
        const { aborted } = await this.deps.waitWhilePaused(this.runId);
        if (aborted || this.deps.isAborted(this.runId)) {
          return this.terminate({ code: 'USER_ABORTED', atStep: stepNo });
        }
        // 放走了就报回下一步真正要进入的阶段（下面 try 块的第一件事就是 planning）
        this.deps.emit({ type: 'phase', runId: this.runId, phase: 'planning' });
      }

      try {
        // ═══ 状态：planning ═══
        this.phase = 'planning';
        this.plan = await this.deps.plan(this.goal, this.observations, stepNo);
        this.deps.emit({ type: 'plan', runId: this.runId, plan: this.plan });

        // ═══ 状态：selecting ═══
        this.phase = 'selecting';
        const call = await this.deps.select(this.plan, this.observations, stepNo);

        // ── 闸门④a 循环判据 A（同参数重复调用）──
        // idempotent 的工具豁免：重复调用安全不算循环
        const loopVerdict = this.detector.recordInvocation(call.name, call.args, this.isIdempotent(call.name));
        if (loopVerdict) {
          const reason = this.guard.checkLoop(loopVerdict);
          if (reason) return this.terminate(reason);
        }

        this.deps.emit({
          type: 'tool-call',
          runId: this.runId,
          stepNo,
          toolName: call.name,
          // ★ 取的是 registry 里这个工具的 spec 与本次 run 已解析的策略，不是常量。
          //   修复前这里硬写 danger:1 / 'auto-with-undo'，把 ★2~★5 一律报成 ★1、
          //   把用户切过的写策略一律报成老板默认值。
          //   null 只表示「宿主没注入」——宁可如实说不知道，绝不编一个好看的数字。
          danger: this.dangerByName?.get(call.name) ?? null,
          writePolicy: this.reportedPolicy ?? null,
          argsSummary: JSON.stringify(call.args).slice(0, 200),
        });

        // ═══ 状态：executing ═══
        this.phase = 'executing';
        const result = await this.deps.execute(call, stepNo);
        this.stats.toolCalls += 1;

        // ── 用户叫停落在了这一步：工具压根没执行，直接终止 ──
        // ★ 第 23 条。修复前这里没有分支：一次因为「已被叫停」而失败的返回会
        //   ① 计入闸门⑤的连续失败（用户意图被当成故障）、② 走一次 evaluate
        //   （没执行的动作被评估出一句结论）、③ 记成 failed/succeeded 步骤。
        //   现在它记 aborted，并且立刻以 USER_ABORTED 收尾。
        if (!result.ok && result.error?.code === 'E_TOOL_REFUSED' && this.deps.isAborted(this.runId)) {
          const obs = await this.deps.observe(call, result, stepNo);
          this.observations.push(obs);
          if (this.observations.length > this.deps.maxHistory) this.observations.shift();
          this.pushStep(stepNo, call, result, obs, undefined);
          return this.terminate({ code: 'USER_ABORTED', atStep: stepNo });
        }

        // ═══ 状态：observing ═══
        this.phase = 'observing';
        const obs = await this.deps.observe(call, result, stepNo);
        this.observations.push(obs);
        if (this.observations.length > this.deps.maxHistory) this.observations.shift();

        // ── 闸门⑤ 连续失败 ──
        // ★ 校验失败（模型没按 schema 填参数）与执行失败（工具本身出问题）
        //   是两件不同的事：前者回喂逐项点名错误让模型自纠最有效，
        //   后者重试同样输入只会同样失败。故走两个独立计数器，
        //   并让 VALIDATION_FAILED 成为真正可触发的终止原因（架构承诺的 10 种之一）。
        const errCode = result.ok ? undefined : result.error?.code;
        if (errCode === 'E_INVALID_ARGS' || errCode === 'E_TOOL_NOT_FOUND') {
          const validationErrors =
            result.error?.hint !== undefined
              ? [result.error.message, result.error.hint]
              : [result.error?.message ?? '参数校验未通过'];
          const vGate = this.guard.recordValidationFailure(validationErrors);
          this.pushStep(stepNo, call, result, obs, undefined);
          if (vGate) return this.terminate(vGate);
          // 未达上限：把逐项错误当作 Observation 回喂，让下一轮自纠
          this.observations.push({
            ...obs,
            ok: false,
            errorMessage: result.error?.message,
            attempts: [
              `参数校验未通过（${errCode}）`,
              ...(result.error?.hint ? [`自纠提示：${result.error.hint}`] : []),
            ],
            summary: `参数不合法，需修正后重试：${result.error?.message ?? ''}`,
          });
          continue;
        }

        const failGate = this.guard.recordToolResult(
          result.ok,
          result.error?.message,
        );
        if (failGate) {
          this.pushStep(stepNo, call, result, obs, undefined);
          return this.terminate(failGate);
        }

        // ═══ 状态：evaluating ═══
        this.phase = 'evaluating';
        const evaluation = await this.deps.evaluate(this.goal, this.observations, stepNo);

        // ── 闸门③ 无进展 ──
        const progressGate = this.guard.recordProgress(evaluation.progress);
        if (progressGate) {
          this.pushStep(stepNo, call, result, obs, evaluation);
          return this.terminate(progressGate);
        }

        this.pushStep(stepNo, call, result, obs, evaluation);

        // ── 闸门② token / 成本 / 本机耗时 ──
        const budgetGate = this.guard.checkBudget(this.stats, this.deps.isLocal);
        if (budgetGate) return this.terminate(budgetGate);

        // ── 闸门④b 循环判据 B（状态指纹）──
        const hash = await this.deps.stateHash();
        const stateVerdict = this.detector.recordState(hash);
        if (stateVerdict) {
          const reason = this.guard.checkLoop(stateVerdict);
          if (reason) return this.terminate(reason);
        }

        // ── 达成目标 → 结束 ──
        if (evaluation.goalAchieved) {
          return this.terminate({
            code: 'GOAL_ACHIEVED',
            summary: evaluation.reason || '目标已达成',
          });
        }
      } catch (e) {
        // 规划/选择阶段的异常也算一次失败，走连续失败闸门
        this.guard.recordToolResult(false, e instanceof Error ? e.message : String(e));
        const gate = this.guard.failureCount >= 3
          ? {
              code: 'CONSECUTIVE_FAILURE' as const,
              failures: this.guard.failureCount,
              lastError: e instanceof Error ? e.message : String(e),
            }
          : null;
        if (gate) return this.terminate(gate);
        // 否则继续下一轮：给模型一次自纠机会
        continue;
      }
    }
  }

  private pushStep(
    stepNo: number,
    call: ToolCall,
    result: ToolResult,
    obs: Observation,
    evaluation?: Evaluation,
  ): void {
    // ★ 第 23 条：`StepStatus` 里的 'aborted' 此前**全仓没有任何产出方**——
    //   这里只写 succeeded/failed，而轨迹面板把未知状态落到兜底的 ▶，
    //   于是「中止」显示成「正在跑」。现按「用户叫停导致未执行」如实记 aborted。
    const isUserAbort =
      !result.ok && result.error?.code === 'E_TOOL_REFUSED' && this.deps.isAborted(this.runId);
    const record: StepRecord = {
      stepNo,
      runId: this.runId,
      phase: 'tool-call',
      status: isUserAbort ? 'aborted' : result.ok ? 'succeeded' : 'failed',
      toolName: call.name,
      argsSummary: JSON.stringify(call.args).slice(0, 200),
      resultSummary: isUserAbort
        ? '已被叫停，本步未执行'
        : result.ok
          ? (obs.summary ?? '完成')
          : (result.error?.message ?? '失败'),
      durationMs: result.durationMs,
      rationale: evaluation?.reason,
      edits: result.changeSet?.edits,
      checkpointId: result.changeSet?.checkpointId,
      sideEffects: evaluation?.sideEffects,
      errorMessage: result.ok ? undefined : result.error?.message,
      attempts: obs.attempts,
    };
    this.steps.push(record);
    this.stats.steps += 1;
    this.stats.edits += result.changeSet?.edits.length ?? 0;
    if (result.changeSet?.checkpointId) this.stats.checkpoints += 1;
    this.deps.emit({ type: 'step', runId: this.runId, step: record });
  }

  /** 终止：保留改动，发出事件。**不回滚**。 */
  private terminate(reason: TerminationReason): { reason: TerminationReason; stats: RunStats } {
    this.phase = 'terminated';
    this.termination = reason;
    this.deps.emit({
      type: 'terminated',
      runId: this.runId,
      reason,
      stats: this.stats,
      keptChanges: this.stats.edits,
    });
    return { reason, stats: this.stats };
  }

  /**
   * 累加一次 LLM 调用的用量（token / 成本 / 耗时）。
   *
   * ★ 由 `AgentHost.accrue()` 在**每次 LLM 调用后**调用 —— 这是闸门②的唯一数据来源。
   *   一旦没人调它，`this.stats.tokensIn/tokensOut/costCny/wallMs` 就恒为 0，
   *   `checkBudget()` 三个分支全部读 0 → 闸门②静默失效（本文件历史上真的发生过）。
   *
   *   测试若要触发 `BUDGET_EXCEEDED`，**不要在这里手动塞用量**——那只能证明
   *   「闸门逻辑对不对」，证明不了「用量有没有被喂进来」。
   *   生产装配的验证见 `tests/integration/budget-wiring.test.ts`。
   */
  addUsage(tokensIn: number, tokensOut: number, costCny: number, wallMs: number): void {
    this.stats.tokensIn += tokensIn;
    this.stats.tokensOut += tokensOut;
    this.stats.costCny += costCny;
    this.stats.wallMs += wallMs;
  }

  private isIdempotent(toolName: string): boolean {
    // 由 AgentHost 注入真实值；默认保守（不豁免）
    return (this as unknown as { idempotentSet?: Set<string> }).idempotentSet?.has(toolName) ?? false;
  }

  /** 供 AgentHost 设置幂等工具集合 */
  setIdempotentTools(names: string[]): void {
    (this as unknown as { idempotentSet?: Set<string> }).idempotentSet = new Set(names);
  }

  /**
   * 供 AgentHost 注入 `agent:tool-call` 事件的真实载荷。
   *
   * 与 `setIdempotentTools` 同样是装配期注入——loop 拿不到 registry，
   * 但事件里的 danger/writePolicy 必须来自真实配置，不能是 loop 自己编的常量。
   */
  setToolReport(specs: ReadonlyArray<{ name: string; danger: ToolDanger }>, policy: WritePolicy): void {
    this.dangerByName = new Map(specs.map((s) => [s.name, s.danger]));
    this.reportedPolicy = policy;
  }
}