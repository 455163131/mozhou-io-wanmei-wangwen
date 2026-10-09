/**
 * Agent 宿主：run 的生命周期与编排（架构 T18）。
 *
 * ★ 「叫停 ≠ 停止 run ≠ 回滚」三态区分（架构 §1.4.4④、§6.1 第 12 条）：
 *
 *   | 操作      | 语义           | 已改动内容 | 用户预期                     |
 *   |-----------|----------------|-----------|------------------------------|
 *   | 叫停      | 停止下一步     | **保留**   | 「别再动了，但做好的别删」   |
 *   | 停止 run  | 终止整个 run   | **保留**   | 同上，但要有终止原因         |
 *   | 回滚到 N  | 撤销 N 之后    | **丢弃**   | 「把那次改动撤掉」           |
 *
 *   三者在 UI 上必须是三个独立控件，绝不能混为一谈。
 */
import type { Evaluation, Observation, Plan, RunState, StepRecord, ToolCall, TerminationReason } from '@shared/types/agent';
import type { ToolResult, ToolSpec } from '@shared/types/tool';
import type { RollbackResult } from '@shared/types/checkpoint';
import { AgentLoop, newRunStats, type LoopEvent } from './loop';
import { LlmClient, LlmError } from '../llm/client';
import { accrueCost, isFree, type CostState } from '../llm/cost';
import { executeTool } from '../tools/sandbox';
import type { ToolRegistry } from '../tools/registry';
import type { CheckpointManager } from '../checkpoint/manager';
import type { Replayer } from '../checkpoint/replayer';
import type { BaselineLike } from '../rule-engine/plan-fixes';
import { buildSystemPrompt } from './prompt';
import { buildContext, summarizeChapter } from './context-builder';
import { MzError, TERMINATION_TEXT } from '@shared/types/ipc';
import type { WritePolicyConfig } from '@shared/types/tool';
import { DEFAULT_BUDGET, contextBudgetFor, RECENT_OBSERVATIONS_RAW } from '@shared/constants/budget';
import { newRunId } from '@shared/util/id';
import {
  evaluateGoal,
  parseGoal,
  toEvaluation,
  validateCustomVerdict,
  type EvalFacts,
  type GoalSpec,
  type NumericVerdict,
} from './goal-evaluator';
import { analyze, isSufficient, judge, healthScore } from '@shared/metrics-engine';
import type { ToolCallingMode, LlmProvider } from '@shared/types/provider';
import { SCAN_BATCH_SIZE } from '@shared/constants/metrics';

export interface AgentHostDeps {
  registry: ToolRegistry;
  checkpoints: CheckpointManager;
  replayer: Replayer;
  llm: LlmClient;
  provider: LlmProvider;
  toolCallingMode: ToolCallingMode;
  writePolicy: WritePolicyConfig;
  /** 当前项目上下文 */
  projectId: () => string | null;
  projectName: () => string;
  chapterIds: () => Promise<string[]>;
  chapterTitle: (id: string) => string;
  getBodies: (ids: string[]) => Promise<Map<string, string>>;
  setBody: (id: string, body: string) => Promise<void>;
  baseline: () => BaselineLike;
  /** 计算项目状态指纹 */
  stateHash: () => Promise<string>;
  /** 账本冲突查询（评估器的 no_conflicts 目标用） */
  conflicts: (projectId: string) => Array<{ id: string }>;
  /** 推送事件 */
  emit: (channel: string, payload: unknown) => void;
  /** 取/存 run 状态 */
  saveRun: (state: RunState) => void;
}

export interface RunOptions {
  goal: string;
  chapterIds?: string[];
  budget?: Partial<typeof DEFAULT_BUDGET>;
  writePolicy?: WritePolicyConfig;
}

export class AgentHost {
  private current: AgentLoop | null = null;
  private abortedRuns = new Set<string>();
  private pausedRuns = new Set<string>();
  /**
   * ★ 第 23 条：runId → 本次 run 的取消控制器。
   * 修复前 `doExecute` 每次现 `new AbortController().signal`（一个永远不会被 abort 的
   * 新对象）传给执行层，于是 `sandbox.ts:66` 的「已被叫停，未执行」和长工具自己的
   * signal 轮询（`scan.ts:60`、`client.ts:152/187`）在 Agent 路径上全是死路：
   * 叫停只在下一轮循环起点（`loop.ts:138`）被看见，正在跑的那一步照跑到底。
   */
  private runControllers = new Map<string, AbortController>();
  /**
   * ★ 第 24 条：runId → 唤醒「停在暂停闸门上的循环」的那颗 resolve。
   *   没有它，`waitWhilePaused` 会把 run 挂死——resume 与 abort 都必须来敲这扇门。
   */
  private pauseWaiters = new Map<string, () => void>();
  private runStates = new Map<string, RunState>();
  private costState: CostState = { tokensIn: 0, tokensOut: 0, costCny: 0, localMs: 0, requests: 0 };

  constructor(private readonly deps: AgentHostDeps) {}

  /**
   * 本次进程内 Agent 循环累计的 LLM 用量（仪表盘统计用）。
   * 未跑过任何 run 时为 null——零值与「没跑过」语义不同，UI 需要区分。
   */
  get usage(): {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    costCny: number;
  } | null {
    if (this.costState.requests === 0) return null;
    return { ...this.costState };
  }

  get activeRunId(): string | null {
    return this.current ? (this.current as unknown as { runId: string }).runId : null;
  }

  /**
   * 是否有 run 正在执行（terminated 的不算）。
   * ★ 与 start() 的 E_RUN_CONFLICT 判据**同源**——两处必须一致，
   *   否则会出现「空闲备份以为没在跑、start 却拒绝新 run」这类互相打脸的状态。
   *   空闲备份靠它避开 run 期间：拍到半改状态的快照，恢复出来比不恢复更难理解。
   */
  get isRunning(): boolean {
    return !!this.current && this.current.currentPhase !== 'terminated';
  }

  /** 启动一次 run。立即返回 runId，实际执行异步进行。 */
  async start(opts: RunOptions): Promise<{ runId: string }> {
    // 同一时间只允许一个 run（E_RUN_CONFLICT）
    if (this.isRunning) {
      throw new MzError('E_RUN_CONFLICT', '已有 run 在执行中，请先叫停或等待结束。');
    }

    const runId = newRunId();
    const chapterIds = opts.chapterIds ?? (await this.deps.chapterIds());

    // 评估器需要「本次范围」与「结构化目标」——start 时解析一次，避免每步重复解析
    this.scopeChapterIds = chapterIds;
    this.goalSpec = parseGoal(opts.goal, chapterIds);
    // 每次 run 重置「首次得分」，用于判断进展（delta）
    this.initialScores.clear();
    const limits = { ...DEFAULT_BUDGET, ...opts.budget };
    const writePolicy = opts.writePolicy ?? this.deps.writePolicy;
    const toolSpecs = this.deps.registry.list();

    const loop = new AgentLoop(runId, opts.goal, {
      plan: (goal, observations) => this.doPlan(goal, observations, chapterIds, toolSpecs, limits),
      select: (plan, observations) => this.doSelect(plan, observations, toolSpecs),
      execute: (call, stepNo) => this.doExecute(call, stepNo, writePolicy, runId),
      observe: (call, result, stepNo) => Promise.resolve(this.doObserve(call, result, stepNo)),
      evaluate: (goal, observations) => this.doEvaluate(goal, observations),
      stateHash: () => this.deps.stateHash(),
      emit: (e) => this.handleEvent(runId, e),
      isAborted: (id) => this.abortedRuns.has(id),
      isPaused: (id) => this.pausedRuns.has(id),
      waitWhilePaused: (id) => this.waitWhilePaused(id),
      isLocal: isFree(this.deps.provider),
      maxHistory: RECENT_OBSERVATIONS_RAW,
    }, limits);

    loop.setIdempotentTools(toolSpecs.filter((t) => t.idempotent).map((t) => t.name));
    loop.setToolReport(toolSpecs, writePolicy.policy);
    this.current = loop;
    this.abortedRuns.delete(runId);
    // 控制器与 run 同生命周期：abort(runId) 要能把 aborted 真的落到执行层
    this.runControllers.set(runId, new AbortController());

    // 异步执行，不阻塞 IPC 返回
    // ★ 第 26 条：**开跑这一刻先落一次库**。修复前 saveRun 只在 loop.run() 返回之后调一次
    //   （见 runLoop），于是应用被强杀时 runs 表里连一行都没有——「上次有 run 没闭合」
    //   这件事在数据上根本不存在，检测代码写得再好也读不出东西。
    //   saveRun 走的是 upsert，结束那次会把 status / ended_at 覆盖掉，不会留脏行。
    this.deps.saveRun(loop.state);
    void this.runLoop(loop);
    return { runId };
  }

  /**
   * 本次 run 的取消信号。`execute` 从这里取，**不再现造 controller**。
   * 与 `abortedRuns` 同生命周期（start 建、resume 换新）。
   */
  private controllerFor(runId: string): AbortController {
    let c = this.runControllers.get(runId);
    if (!c) {
      c = new AbortController();
      this.runControllers.set(runId, c);
    }
    // start 前已 abort（极端时序）：新建的 controller 要立刻反映用户的叫停
    if (this.abortedRuns.has(runId)) c.abort();
    return c;
  }

  private async runLoop(loop: AgentLoop): Promise<void> {
    const runId = loop.state.runId;
    try {
      const { reason, stats } = await loop.run();
      this.deps.saveRun(loop.state);
      void reason;
      void stats;
    } catch (e) {
      this.deps.emit('agent:terminated', {
        runId: loop.state.runId,
        reason: {
          code: 'CONSECUTIVE_FAILURE',
          failures: 1,
          lastError: e instanceof Error ? e.message : String(e),
        } satisfies TerminationReason,
        stats: loop.state.stats,
        keptChanges: loop.state.stats.edits,
      });
      // ★ 第 26 条：抛错这条路也必须落一次库。少了它，start 时那次写入留下的
      //   「未闭合」行会永远停在那儿——下次开项目弹的是「上次崩了」，
      //   而其实这次是走完并告知过用户的。
      this.deps.saveRun(loop.state);
    } finally {
      // ★ 第 26 条：跑完（或抛错）的快照必须留在 runStates 里。
      //   修复前这张 map **全仓只读不写**，于是 getState(runId) 恒 null、
      //   listRuns() 恒空——`agent:state`、`agent:history` 与 T24 的未闭合提示一起空转。
      this.runStates.set(runId, loop.state);
      this.current = null;
      this.runControllers.delete(runId);
    }
  }

  // ── 规划 ──
  private async doPlan(
    goal: string,
    observations: Observation[],
    chapterIds: string[],
    tools: ReturnType<ToolRegistry['list']>,
    limits: typeof DEFAULT_BUDGET,
  ): Promise<Plan> {
    const budget = contextBudgetFor(this.deps.provider.capabilities.maxContextTokens);
    const system = buildSystemPrompt(
      {
        baselineSource: this.deps.baseline().source,
        projectName: this.deps.projectName(),
        chapterIds,
        budget,
        toolCallingMode: this.deps.toolCallingMode,
        isLocalModel: isFree(this.deps.provider),
      },
      tools,
    );

    const ctx = buildContext({
      goal,
      plan: null,
      focusBodies: await this.loadFocusBodies(chapterIds, budget.l3Chars),
      neighborSummaries: [],
      observations,
      budget,
    });

    void limits;
    const res = await this.llmJson(
      [
        { role: 'system', content: system },
        { role: 'user', content: `${ctx.user}\n\n---\n用户目标：${goal}\n\n请给出你的计划。` },
      ],
      '计划',
      // ★ 刻意不传 tools：规划要的是 JSON 计划，不是工具调用。
      //   两者是不同职责；若这里也传 tools，模型想调工具时会返回 tool_calls，
      //   被 parsePlan 当作 JSON 解析失败 —— 这正是「工具选择与规划混在一起」的典型症状。
    );
    return parsePlan(res, goal);
  }

  private async loadFocusBodies(
    chapterIds: string[],
    l3Chars: number,
  ): Promise<Array<{ chapterId: string; title: string; body: string }>> {
    // 超大范围只取前若干章（架构 §1.4.2：章节数 > 50 只带当前章 + 统计摘要）
    const target = chapterIds.length > 50 ? chapterIds.slice(0, 1) : chapterIds.slice(0, SCAN_BATCH_SIZE);
    const bodies = await this.deps.getBodies(target);
    return target.map((id) => ({
      chapterId: id,
      title: this.deps.chapterTitle(id),
      body: (bodies.get(id) ?? '').slice(0, Math.floor(l3Chars / target.length)),
    }));
  }

  // ── 选工具 ──

  /**
   * 选择下一个要调用的工具。
   *
   * ★ 三条执行路径（架构 §1.4.5），按provider 的 functionCalling 能力自动分流：
   *   native      → 传 tools 参数，读 tool_calls（解析失败率最低）
   *   prompted    → 把 schema 注入系统提示 +文本协议，解析 <<TOOL:...>>
   *   unsupported → 不做自主选择，让上层降级单步模式
   *
   * ★ 修复记录：此前本方法无论哪条路径都只让模型「输出 JSON 再正则提取」，
   *   且**没把 tools 传给 llm.chat** —— 导致 client.ts:196 的
   *   `if (mode === 'native' && req.tools?.length)` 恒为假，
   *   native 能力形同虚设。这是**接线漏了**，不是没实现（client 侧一直是完整的）。
   */
  private async doSelect(
    plan: Plan,
    observations: Observation[],
    tools: ReturnType<ToolRegistry['list']>,
  ): Promise<ToolCall> {
    const obs = observations
      .slice(-RECENT_OBSERVATIONS_RAW)
      .map((o) => `步${o.stepNo} ${o.ok ? '成功' : '失败'} ${o.toolName}：${o.summary}`)
      .join('\n');
    const planText = plan.steps.map((s) => `${s.index}. ${s.intent}`).join('\n');

    // unsupported：不猜工具，让上层走单步模式
    if (this.deps.toolCallingMode === 'unsupported') {
      throw new MzError(
        'E_TOOLCALL_UNSUPPORTED',
        '当前模型不支持工具调用，已切换为单步模式：工具需你手动选择。',
      );
    }

    // native：走标准 tools 参数
    if (this.deps.toolCallingMode === 'native') {
      const res = await this.deps.llm.chat({
        messages: [
          {
            role: 'system',
            content:
              '你在为一个中文网文写作 Agent 选择下一步要调用的工具。' +
              '请调用最合适的那个工具。若你判断目标已达成，调用 analyze_chapter 复核后即可结束。',
          },
          {
            role: 'user',
            content: `计划：\n${planText}\n\n已执行：\n${obs || '(无)'}`,
          },
        ],
        // ★ 这一行是关键：此前从未传入，导致 native 分支永不生效
        tools: tools.map(toOpenAiToolsSpec).filter((t) => t !== null),
        tool_choice: 'auto',
        temperature: 0.2,
        stream: false,
      });
      this.accrue(res.usage.input, res.usage.output, res.usage.wallMs);
      if (res.toolCalls.length > 0) {
        const tc = res.toolCalls[0];
        if (tools.some((t) => t.name === tc.name)) {
          return { name: tc.name, args: tc.args };
        }
        // 模型编了个不存在的工具名：明确报错让它自纠，而不是静默取第一个
        throw new MzError(
          'E_TOOL_NOT_FOUND',
          `模型选择了不存在的工具「${tc.name}」。可用工具：${tools.map((t) => t.name).join(', ')}`,
        );
      }
      // native 但模型没给tool_calls：如实报告，不伪造
      throw new MzError(
        'E_INVALID_ARGS',
        '模型未返回工具调用（native 路径）。请重试，或检查该模型是否真的支持 tools 参数。',
      );
    }

    // prompted：文本协议，schema 由 client 注入系统提示
    const toolList = tools.map((t) => `- ${t.name}：${t.description.split('\n')[0]}`).join('\n');
    const res = await this.llmJson(
      [
        {
          role: 'system',
          content:
            '你正在选择下一个要调用的工具。只输出一个工具调用，不要解释。' +
            '若你判断目标已达成或无法继续，输出 {"done": true, "reason": "..."}。',
        },
        {
          role: 'user',
          content:
            `计划：\n${planText}\n\n已执行：\n${obs || '(无)'}\n\n可用工具：\n${toolList}`,
        },
      ],
      '工具选择',
    );
    return parseToolCall(res, tools);
  }

  // ── 执行 ──
  private async doExecute(
    call: ToolCall,
    stepNo: number,
    writePolicy: WritePolicyConfig,
    runId: string,
  ): Promise<ToolResult> {
    const spec = this.deps.registry.specOf(call.name);
    const handler = this.deps.registry.handlerOf(call.name);
    if (!spec || !handler) {
      return {
        ok: false,
        durationMs: 0,
        error: {
          code: 'E_TOOL_NOT_FOUND',
          message: `工具不存在：${call.name}`,
          retryable: false,
        },
      };
    }

    const outcome = await executeTool(spec, handler, call.args, {
      runId,
      stepNo,
      dryRun: false,
      writePolicy,
      // ★ 第 23 条：这里以前是 `new AbortController().signal`——每次现造一个永不 abort 的
      //   新对象，执行层读到的 aborted 恒为 false，用户的中止到不了正在跑的这一步。
      signal: this.controllerFor(runId).signal,
      logger: () => undefined,
      deps: {
        requireCheckpoint: async (chs) => {
          const runId = this.activeRunId;
          if (!runId) throw new Error('无活动 run，拒绝在无 run 上下文落快照');
          return this.deps.checkpoints.requireCheckpoint(runId, stepNo, call.name, chs);
        },
        rollbackTo: async (checkpointId) => {
          // ★ 第 27 条：走统一入口，别再直连 replayer——那样 StepRecord 不会翻状态，
          //   `checkpoint:rolled-back` 也不会发（自动回滚后编辑器一直显示撤回前的正文）。
          await this.rollbackTo(checkpointId, true);
        },
      },
    });

    // 提交 checkpoint（记录改后正文与改动数）
    if (outcome.result.ok && outcome.result.changeSet && outcome.checkpointId) {
      const afterBodies = new Map<string, string>();
      for (const p of outcome.result.changeSet.patches) afterBodies.set(p.chapterId, p.afterText);
      await this.deps.checkpoints.commit(
        outcome.checkpointId,
        afterBodies,
        outcome.result.changeSet.edits.length,
      );
      this.deps.emit('agent:checkpoint', {
        runId: this.activeRunId,
        checkpointId: outcome.checkpointId,
        stepNo,
        toolName: call.name,
        affectedChapters: outcome.result.changeSet.patches.map((p) => p.chapterId),
        bytes: outcome.result.changeSet.bytes,
      });
    }

    // 推送副作用（让 UI 显示「已自动撤回」说明）
    if (outcome.result.ok && outcome.result.changeSet) {
      void outcome.result;
    }

    return outcome.result;
  }

  // ── 观察 ──
  private doObserve(call: ToolCall, result: ToolResult, stepNo: number): Observation {
    const attempts: string[] = [];
    if (!result.ok && result.error) {
      attempts.push(`${call.name} → ${result.error.code}`);
      if (result.error.hint) attempts.push(`建议：${result.error.hint}`);
    }
    return {
      stepNo,
      toolName: call.name,
      kind: 'facts',
      summary: result.ok
        ? `成功：${JSON.stringify(result.data ?? {}).slice(0, 200)}`
        : `失败：${result.error?.message ?? '未知'}`,
      data: result.data,
      durationMs: result.durationMs,
      ok: result.ok,
      errorMessage: result.ok ? undefined : result.error?.message,
      attempts,
    };
  }

  // ── 评估 ──

  /**
   * 评估：本步之后目标是否达成。
   *
   * ★★ 修复记录：此前这里是返回固定值的占位实现
   *   （progress:'partial' / goalAchieved:false），后果是
   *   **Agent 永远不会说「搞定了」**，只能跑满 maxSteps 或撞闸门才停——
   *   等于退化成「跑完全量规则的批处理器」，恰好是 PRD 要避免的东西。
   *
   * ★★ 复检必须走真实数据：**每次评估都重新 analyze 一遍**，
   *   不能用首次体检的缓存值。否则 Agent 会拿「修正前的分数」宣布成功，
   *   那是比不评估更糟的假成功。
   */
  private async doEvaluate(
    goalText: string,
    observations: Observation[],
  ): Promise<Evaluation> {
    // goalSpec 在 start() 时已解析过；此处兜底只在「直接调evaluate（测试用）」时生效
    const goal =
      this.goalSpec ??
      parseGoal(goalText, this.scopeChapterIds) ??
      ({ kind: 'custom' as const, statement: goalText } satisfies GoalSpec);

    // ★ 从 DB 重新读取正文并重算指标——不复用任何缓存
    const facts = await this.collectEvalFacts(goal);
    const verdict =
      goal.kind === 'custom'
        ? await this.judgeCustom(goal.statement, facts)
        : evaluateGoal(goal, facts);

    const scoreNow = facts.healthScores[this.focusChapterId()];
    const scoreBefore = this.initialScores.get(this.focusChapterId());

    const last = observations[observations.length - 1];
    const sideEffects = last?.data && typeof last.data === 'object'
      ? ((last.data as { sideEffects?: Evaluation['sideEffects'] }).sideEffects ?? [])
      : [];

    return toEvaluation(verdict, scoreBefore, scoreNow, sideEffects);
  }

  /** 重新读取正文并计算评估所需的事实（★ 每次现算，不读缓存） */
  private async collectEvalFacts(goal: GoalSpec): Promise<EvalFacts> {
    const chapters =
      goal.kind === 'health_score' || goal.kind === 'metric_below' || goal.kind === 'metric_above'
        ? [goal.chapterId]
        : this.scopeChapterIds.slice(0, 50);

    const ids = chapters.filter((id) => this.scopeChapterIds.includes(id));
    const bodies = ids.length > 0 ? await this.deps.getBodies(ids) : new Map<string, string>();

    const healthScores: Record<string, number> = {};
    const metrics: Record<string, Record<string, number>> = {};
    const sufficient: Record<string, boolean> = {};
    const baseline = this.deps.baseline();

    for (const id of ids) {
      const body = bodies.get(id);
      if (body === undefined) continue;
      const a = analyze(body);
      const enough = isSufficient(a.chars);
      const items = judge({
        raw: a.raw,
        per1000: a.per1000,
        metrics: baseline.metrics,
        markerDensity: baseline.markerDensity,
      });
      healthScores[id] = healthScore(items, enough);
      metrics[id] = a.raw as unknown as Record<string, number>;
      sufficient[id] = enough;

      // 记录首次得分，供后续算delta（判断「有没有进展」）
      if (!this.initialScores.has(id)) this.initialScores.set(id, healthScores[id]);
    }

    const projectId = this.deps.projectId();
    const conflictCount = projectId ? this.deps.conflicts(projectId).length : 0;

    return { healthScores, metrics, sufficient, conflictCount };
  }

  /** custom 目标：交 LLM 判定，但结果必须过结构校验 */
  private async judgeCustom(statement: string, facts: EvalFacts): Promise<NumericVerdict> {
    try {
      const raw = await this.llmJson(
        [
          {
            role: 'system',
            content:
              '判断用户的目标是否已经达成。只输出 JSON：{"achieved": true/false, "reason": "一句话理由"}。' +
              '若信息不足，achieved 必须为 false 且reason 说明缺什么。',
          },
          {
            role: 'user',
            content:
              `目标：${statement}\n\n` +
              `当前健康分：${JSON.stringify(facts.healthScores)}\n` +
              `当前指标：${JSON.stringify(facts.metrics).slice(0, 1500)}\n` +
              `冲突数：${facts.conflictCount}`,
          },
        ],
        '目标判定',
      );
      const v = validateCustomVerdict(JSON.parse(raw));
      if (v.errors) {
        return {
          achieved: false,
          reason: `模型判定结果结构不合法（${v.errors.join('; ')}），已拒绝采纳`,
        };
      }
      return { achieved: v.achieved, reason: v.reason };
    } catch (e) {
      return {
        achieved: false,
        reason: `目标判定失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private focusChapterId(): string {
    return this.scopeChapterIds[0] ?? '1';
  }

  /** 本次 run 的章节范围（评估与上下文都用它） */
  private scopeChapterIds: string[] = [];
  /** 各章首次得分，用于算进展 delta */
  private initialScores = new Map<string, number>();
  /** 结构化目标；start() 时解析一次，避免每步重复解析 */
  private goalSpec: GoalSpec | null = null;

  /** 统一的 LLM JSON 调用：自动累加成本、分类错误 */
  /**
   * 统一的 LLM JSON 调用。
   *
   * ★ 修复记录（QA 阻断项 1）：此前签名里**没有 tools 参数**，
   *   导致 planning / custom 判定这两条路径走的都是「让模型输出 JSON 再正则提取」，
   *   且在 native provider 下`client.ts` 的 `if (mode==='native' && req.tools)`
   *   恒为假 → 10 次采样全部落回 prompted。
   *   现在显式接受 tools/toolChoice，由调用方决定；本方法只负责**非工具调用**场景。
   *
   * @param opts.tools 传入时走原生 tools 参数（native）或文本协议（prompted）
   * @returns 文本内容；**当模型返回了 tool_calls 时**通过 onToolCall 抛出，
   *          避免把「要调工具」的意图误当成 JSON 解析失败
   */
  private async llmJson(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    what: string,
    opts?: {
      /** 传入则本次请求带工具 schema */
      tools?: ToolSpec[];
      /** native 路径的 tool_choice；默认 'auto'（让模型自主选，这正是 Agent 的核心） */
      toolChoice?: 'auto' | 'none';
    },
  ): Promise<string> {
    try {
      const res = await this.deps.llm.chat({
        messages,
        tools: opts?.tools?.map(toOpenAiToolsSpec),
        tool_choice: opts?.tools && opts.tools.length > 0 ? (opts.toolChoice ?? 'auto') : undefined,
        temperature: 0.2,
        stream: false,
      });
      this.accrue(res.usage.input, res.usage.output, res.usage.wallMs);
      return res.content;
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'auth') {
        throw new MzError('E_LLM_AUTH', `${what}失败：${e.message}`);
      }
      throw new MzError('E_LLM_NETWORK', `${what}失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 累加一次 LLM 调用的用量。
   *
   * ★ 必须**同时**写两本账，少写一本就是少一道闸门：
   *   · `costState` —— 给仪表盘（`dash:stats`）看的进程级累计；
   *   · `AgentLoop.stats` —— 给闸门②（`checkBudget`）看的本次 run 用量。
   *
   *   此前只写了前者，`loop.stats` 的 token/成本/耗时恒为 0，
   *   `checkBudget()` 的三个分支永远读到 0 → **闸门②等于不存在**，
   *   只剩步数闸门①还能拦住 Agent。用户设的 maxCostCny / maxTokens 成了装饰品。
   *
   *   这个教训项目里记过一次（见 `expert/reviewer.ts` 的同名注释），
   *   但当时只修了专家团路径，主循环漏了 —— 所以这里也留一条。
   */
  private accrue(input: number, output: number, wallMs: number): void {
    const before = this.costState.costCny;
    accrueCost(this.costState, this.deps.provider, { input, output, wallMs });
    // 本地模型恒为 0 价，delta 自然是 0；云端才是真实增量
    const costDelta = Math.max(0, this.costState.costCny - before);
    this.current?.addUsage(input, output, costDelta, wallMs);
  }

  private handleEvent(runId: string, e: LoopEvent): void {
    switch (e.type) {
      case 'plan':
        this.deps.emit('agent:plan', { runId, plan: e.plan });
        break;
      case 'step':
        this.deps.emit('agent:step', { runId, step: e.step });
        break;
      // ★ 第 25 条：阶段变化转推。渲染层的 status 只有这一条来源，
      //   没有它「暂停中」在界面上无处可来（setStatus 此前零调用方）。
      case 'phase':
        this.deps.emit('agent:phase', { runId, phase: e.phase });
        break;
      case 'tool-call':
        this.deps.emit('agent:tool-call', {
          runId,
          stepNo: e.stepNo,
          toolName: e.toolName,
          danger: e.danger,
          writePolicy: e.writePolicy,
          argsSummary: e.argsSummary,
        });
        break;
      case 'terminated': {
        this.deps.emit('agent:terminated', {
          runId,
          reason: e.reason,
          stats: e.stats,
          keptChanges: e.keptChanges,
        });
        const text = TERMINATION_TEXT[e.reason.code] ?? e.reason.code;
        void text;
        break;
      }
      default:
        break;
    }
  }

  // ── 三态控制 ──

  /** 叫停：停止下一步，**保留已改改动**（≠ 回滚） */
  abort(runId: string): void {
    this.abortedRuns.add(runId);
    // ★ 同时落到控制器：正在跑的那一步（sandbox 早退、长工具自己的轮询）才看得见中止。
    //   只 get 不 set：叫停一个早已结束的 run 不该在表里留下条目。
    this.runControllers.get(runId)?.abort();
    // 停在暂停闸门里的循环也得醒，否则它永远等不到 abortedRuns
    this.pauseWaiters.get(runId)?.();
  }

  /** 暂停：与叫停不同，暂停后可 resume */
  pause(runId: string): void {
    this.pausedRuns.add(runId);
  }

  resume(runId: string): void {
    this.pausedRuns.delete(runId);
    this.abortedRuns.delete(runId);
    // AbortSignal 不可逆，旧的那把已经脏了：丢掉它，`controllerFor` 会给仍在跑的 run
    // 建一把干净的。不清则「叫停后又继续」的 run 之后每一步都被当成已叫停。
    this.runControllers.delete(runId);
    // ★ 第 24 条：敲醒挂在暂停闸门上的循环——这才是「继续」真正的落地动作
    this.pauseWaiters.get(runId)?.();
    this.pauseWaiters.delete(runId);
  }

  /**
   * 暂停闸门：一直等到 resume／abort 落地再返回。
   *
   * ★ 第 24 条。修复前这个方法根本不存在：`pause()` 只往 `pausedRuns` 里塞一个 id，
   *   全仓没有任何读取方，于是「暂停」是一条纯粹的空线——run 一步都不停。
   *   单线程下「检查条件 → 登记 resolve」之间没有 await，不会和 resume 错身错过唤醒。
   */
  private async waitWhilePaused(runId: string): Promise<{ aborted: boolean }> {
    while (this.pausedRuns.has(runId) && !this.abortedRuns.has(runId)) {
      await new Promise<void>((resolve) => {
        this.pauseWaiters.set(runId, resolve);
      });
    }
    this.pauseWaiters.delete(runId);
    return { aborted: this.abortedRuns.has(runId) };
  }

  /**
   * 回滚：撤销改动（≠ 叫停）。走 Replayer，含手动修改冲突检测。
   *
   * ★ 第 27 条：这是**回滚的唯一入口**。修复前本方法全仓零调用方——
   *   `checkpoint:undo`（register.ts）、`undo` 工具（services.ts）、sandbox 的自动回滚
   *   三条活路各自直连 `replayer.undoTo`，谁都不碰 StepRecord，
   *   于是正文撤回了、轨迹里那几步还挂着绿色 ✓。三条现在一律经过这里。
   *   返回值给调用方（`checkpoint:undo` 要把 RollbackResult 交回渲染层）。
   */
  async rollbackTo(checkpointId: string, force = false): Promise<RollbackResult> {
    const result = await this.deps.replayer.undoTo(checkpointId, force);
    this.markStepsRolledBack(result.undoneCheckpointIds);
    this.deps.emit('checkpoint:rolled-back', {
      checkpointId,
      undone: result.undone,
      lostManualEdits: result.lostManualEdits,
    });
    return result;
  }

  /**
   * 把被撤掉的那些 checkpoint 对应的步骤如实翻成 `rolled-back`，并重推给渲染层。
   *
   * ★ 边界（不谎报）：只能翻**本进程还记得**的 run（正在跑的 + 本次进程跑完的）。
   *   跨进程回滚上一次运行留下的 checkpoint 时，那些 StepRecord 不在内存里，
   *   翻不到——但也不会翻错。轨迹本来就只活在进程内（第 26 条）。
   */
  private markStepsRolledBack(undoneIds: string[]): void {
    if (undoneIds.length === 0) return;
    const hit = new Set(undoneIds);
    const states: RunState[] = [];
    const live = this.current?.state;
    if (live) states.push(live);
    for (const st of this.runStates.values()) {
      if (!states.some((x) => x.runId === st.runId)) states.push(st);
    }
    for (const st of states) {
      for (let i = 0; i < st.steps.length; i++) {
        const rec = st.steps[i];
        if (!rec.checkpointId || !hit.has(rec.checkpointId)) continue;
        if (rec.status === 'rolled-back') continue; // 重复回滚不许重复推事件
        const patched: StepRecord = { ...rec, status: 'rolled-back' };
        st.steps[i] = patched;
        this.deps.emit('agent:step', { runId: st.runId, step: patched });
      }
    }
  }

  /**
   * 读一条 run 的状态。`agent:state` 通道的实现就是它，所以**带 runId 也必须读得到正在跑的那条**——
   * 修复前带 id 的分支只查 `runStates`（从没被写过）⇒ 连自己刚 start 的 run 都返回 null。
   */
  getState(runId?: string): RunState | null {
    const live = this.current?.state ?? null;
    if (!runId || live?.runId === runId) return live;
    return this.runStates.get(runId) ?? null;
  }

  /**
   * 本进程的 run 列表：当前这条排最前，其后是跑完的（按开跑时间倒序）。
   * `agent:history` 走的就是这里。跨进程的「上次」不归它管，那是 `runs` 表 +
   * `services.listUnclosedRuns()`（第 26 条）。
   */
  listRuns(): RunState[] {
    const past = [...this.runStates.values()].sort((a, b) => b.startedAt - a.startedAt);
    const live = this.current?.state ?? null;
    if (!live) return past;
    return [live, ...past.filter((r) => r.runId !== live.runId)];
  }

  /** 章节摘要（供上下文构建） */
  async chapterSummaries(ids: string[]): Promise<Array<{ chapterId: string; summary: string }>> {
    const bodies = await this.deps.getBodies(ids);
    return ids.map((id) => {
      const body = bodies.get(id) ?? '';
      return { chapterId: id, summary: summarizeChapter(id, this.deps.chapterTitle(id), body) };
    });
  }
}

/**
 * 把项目的 ToolSpec 转成 OpenAI tools 数组。
 * 与 client.ts 内部的 toOpenAiTools 同源，避免两处格式漂移。
 */
function toOpenAiToolsSpec(spec: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          spec.params.map((p) => [
            p.name,
            {
              type: p.type === 'string[]' ? 'array' : p.type === 'number[]' ? 'array' : p.type,
              ...(p.type === 'string[]' || p.type === 'number[]'
                ? { items: { type: p.type === 'string[]' ? 'string' : 'number' } }
                : {}),
              description: p.description,
              ...(p.enum ? { enum: p.enum } : {}),
            },
          ]),
        ),
        required: spec.params.filter((p) => p.required).map((p) => p.name),
      },
    },
  };
}

// ───────────────────────── 输出解析（宽容但有校验） ─────────────────────────

/** 从模型输出里提取 JSON（容忍 ``` 围栏与前后解释文字） */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // 去``` 围栏
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : trimmed;
  // 直接尝试
  try {
    return JSON.parse(body);
  } catch {
    // 提取第一个 {...} 或 [...]
    const start = body.search(/[{[]/);
    if (start < 0) throw new Error('输出中找不到 JSON');
    const open = body[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < body.length; i++) {
      if (body[i] === open) depth++;
      if (body[i] === close) {
        depth--;
        if (depth === 0) return JSON.parse(body.slice(start, i + 1));
      }
    }
    throw new Error('JSON 括号不匹配');
  }
}

function parsePlan(raw: string, goal: string): Plan {
  const j = extractJson(raw) as Record<string, unknown>;
  const steps = Array.isArray(j.steps) ? j.steps : [];
  return {
    goalRestated: typeof j.goalRestated === 'string' ? j.goalRestated : goal,
    steps: steps.map((s: Record<string, unknown>, i: number) => ({
      index: typeof s.index === 'number' ? s.index : i + 1,
      intent: typeof s.intent === 'string' ? s.intent : String(s.step ?? ''),
      rationale: typeof s.rationale === 'string' ? s.rationale : undefined,
      plannedTool: typeof s.plannedTool === 'string' ? s.plannedTool : undefined,
    })),
    explicitlySkipped: Array.isArray(j.explicitlySkipped)
      ? (j.explicitlySkipped as Array<Record<string, unknown>>).map((s) => ({
          what: String(s.what ?? ''),
          why: String(s.why ?? ''),
        }))
      : undefined,
  };
}

function parseToolCall(raw: string, tools: Array<{ name: string }>): ToolCall {
  const j = extractJson(raw) as Record<string, unknown>;
  if (j.done === true) {
    // 模型认为完成了——返回一个安全的只读调用，由 evaluator 收尾
    return { name: 'get_health_report', args: {} };
  }
  const name = String(j.name ?? j.tool ?? '');
  if (!name) throw new Error('工具选择输出缺少 name');
  if (!tools.some((t) => t.name === name)) {
    throw new Error(`不存在的工具：${name}`);
  }
  const args = (j.args ?? j.arguments ?? {}) as Record<string, unknown>;
  return { name, args };
}

export { extractJson, newRunStats };