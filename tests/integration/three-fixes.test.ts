/**
 * 三项补完的验证（团队负责人自验要求 2、3、4）：
 *   · VALIDATION_FAILED 终止原因真实可触发，且带具体错误路径
 *   · native tool_calls 解析（含 client 层 body 构造）
 *   · GOAL_ACHIEVED 端到端：用假 LLM 构造「健康分 24 → 87」
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '@main/agent/loop';
import { BudgetGuard } from '@main/agent/budget-guard';
import { LlmClient } from '@main/llm/client';
import { findProvider } from '@shared/constants/providers';
import { DEFAULT_BUDGET } from '@shared/constants/budget';
import { evaluateGoal, type EvalFacts } from '@main/agent/goal-evaluator';
import type { Observation, Plan } from '@shared/types/agent';
import type { ToolCall, ToolResult } from '@shared/types/tool';
import { analyze, isSufficient, judge, healthScore } from '@shared/metrics-engine';
import { REFERENCE_BASELINE } from '@shared/constants/metrics';

// ───────────────────────── ① VALIDATION_FAILED ─────────────────────────

describe('① VALIDATION_FAILED：真实可触发且带错误路径', () => {
  /** 构造一个总是返回 E_INVALID_ARGS 的循环 */
  async function runAlwaysInvalid(): Promise<{ code: string; errors?: string[] }> {
    let n = 0;
    const loop = new AgentLoop(
      'run_v', '目标',
      {
        plan: async (): Promise<Plan> => ({ goalRestated: 'x', steps: [] }),
        select: async (): Promise<ToolCall> => ({ name: 't', args: { attempt: ++n } }),
        execute: async (): Promise<ToolResult> => ({
          ok: false,
          durationMs: 1,
          error: {
            code: 'E_INVALID_ARGS',
            message: '参数校验未通过：\n  · chapterNo: expected number, got string',
            retryable: true,
            hint: '可用参数：chapterNo(number)',
          },
        }),
        observe: async (_c, _r, stepNo): Promise<Observation> => ({
          stepNo, toolName: 't', kind: 'facts', summary: 'invalid', durationMs: 1, ok: false,
        }),
        evaluate: async () => ({ progress: 'partial' as const, goalAchieved: false, reason: '' }),
        stateHash: async () => `h${n}`,
        emit: () => undefined,
        isAborted: () => false,
        isPaused: () => false,
        waitWhilePaused: async () => ({ aborted: false }),
        isLocal: false,
        maxHistory: 50,
      },
      DEFAULT_BUDGET,
    );
    const { reason } = await loop.run();
    return { code: reason.code, errors: 'errors' in reason ? reason.errors : undefined };
  }

  it('★ 连续校验失败 → VALIDATION_FAILED（不是 CONSECUTIVE_FAILURE）', async () => {
    const r = await runAlwaysInvalid();
    expect(r.code).toBe('VALIDATION_FAILED');
  });

  it('★ 终止原因带具体错误路径', async () => {
    const r = await runAlwaysInvalid();
    expect(r.errors).toBeDefined();
    const joined = (r.errors ?? []).join('\n');
    expect(joined).toContain('chapterNo');
    expect(joined).toContain('expected number');
  });

  it('★ 校验失败与执行失败走两个独立计数器', () => {
    const g = new BudgetGuard(DEFAULT_BUDGET);
    // 执行失败 2 次（未达 3 次上限，故不触发 CONSECUTIVE_FAILURE）
    expect(g.recordToolResult(false, 'IO 失败')).toBeNull();
    expect(g.recordToolResult(false, 'IO 失败')).toBeNull();
    // 校验失败第 1 次：未达上限（2），应放行让模型自纠
    expect(g.recordValidationFailure(['args.chapterNo: expected number, got string'])).toBeNull();
    // 第 2 次 → 触发 VALIDATION_FAILED，且不受执行失败计数影响
    const v = g.recordValidationFailure(['args.chapterNo: expected number, got string']);
    expect(v?.code).toBe('VALIDATION_FAILED');
    expect(v?.code).not.toBe('CONSECUTIVE_FAILURE');
  });

  it('★ 校验成功后计数清零（模型自纠成功就不该终止）', () => {
    const g = new BudgetGuard(DEFAULT_BUDGET);
    g.recordValidationFailure(['a: 错']);
    expect(g.recordValidationFailure(['a: 还错'])?.code).toBe('VALIDATION_FAILED');
    const g2 = new BudgetGuard(DEFAULT_BUDGET);
    g2.recordValidationFailure(['a: 错']);
    g2.recordValidationFailure(['a: 错']);
    // 若成功过，计数应归零
    expect(g2.validationFailureCount).toBe(2);
    const g3 = new BudgetGuard(DEFAULT_BUDGET);
    g3.recordValidationFailure(['a: 错']);
    g3.recordValidationFailure(['a: 错']);
    g3.recordToolResult(true, undefined); // 成功
    expect(g3.validationFailureCount).toBe(0);
  });

  it('E_TOOL_NOT_FOUND 也算校验失败（模型编了个不存在的工具）', async () => {
    let n = 0;
    const loop = new AgentLoop('r', 'g', {
      plan: async (): Promise<Plan> => ({ goalRestated: 'x', steps: [] }),
      select: async (): Promise<ToolCall> => ({ name: 'nope', args: { i: ++n } }),
      execute: async (): Promise<ToolResult> => ({
        ok: false, durationMs: 1,
        error: { code: 'E_TOOL_NOT_FOUND', message: '不存在的工具：nope', retryable: true },
      }),
      observe: async (_c, _r, stepNo): Promise<Observation> => ({
        stepNo, toolName: 'nope', kind: 'facts', summary: 'x', durationMs: 1, ok: false,
      }),
      evaluate: async () => ({ progress: 'partial' as const, goalAchieved: false, reason: '' }),
      stateHash: async () => `h${n}`,
      emit: () => undefined,
      isAborted: () => false,
      isPaused: () => false,
      waitWhilePaused: async () => ({ aborted: false }),
      isLocal: false,
      maxHistory: 50,
    }, DEFAULT_BUDGET);
    const { reason } = await loop.run();
    expect(reason.code).toBe('VALIDATION_FAILED');
  });
});

// ───────────────────────── ② native tool_calls ─────────────────────────

describe('② native tool_calls 路径', () => {
  /** 拦截 fetch，检查实际发出的 body */
  /**
   * 拦截 fetch，记录实际发出的 body。
   * ★ 返回 Promise<Array> 而非 run() 的结果——run 返回 void，
   *   直接 return run(...) 会让调用方拿到 undefined（这个坑踩过一次）。
   */
  async function withFetchCapture(
    run: (calls: Array<Record<string, unknown>>) => Promise<void>,
    respond: (body: unknown) => Response,
  ): Promise<Array<Record<string, unknown>>> {
    const sent: Array<Record<string, unknown>> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return respond({});
    }) as typeof fetch;
    try {
      await run(sent);
    } finally {
      globalThis.fetch = orig;
    }
    return sent;
  }

  it('★ native 路径确实把 tools 放进请求体（这是之前漏掉的接线）', async () => {
    const provider = findProvider('deepseek')!;
    const client = new LlmClient({
      provider,
      baseUrl: provider.defaultBaseUrl,
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      mode: 'native',
      tools: [],
      timeoutMs: 5000,
    });

    await withFetchCapture(
      async () => {
        await client.chat({
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'ping', parameters: {} } }],
          tool_choice: 'auto',
          stream: false,
        });
      },
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ).then((sent) => {
      expect(sent).toHaveLength(1);
      const body = sent[0];
      expect(body['tools']).toBeDefined();
      expect(Array.isArray(body['tools'])).toBe(true);
      expect(body['tool_choice']).toBe('auto');
    });
  });

  it('★ 解析 response.choices[].message.tool_calls', async () => {
    const provider = findProvider('deepseek')!;
    const client = new LlmClient({
      provider, baseUrl: provider.defaultBaseUrl, model: 'deepseek-chat',
      apiKey: 'sk-test', mode: 'native', tools: [], timeoutMs: 5000,
    });

    await withFetchCapture(
      async () => {
        const res = await client.chat({
          messages: [{ role: 'user', content: '选工具' }],
          tools: [{ type: 'function', function: { name: 'analyze_chapter', parameters: {} } }],
          stream: false,
        });
        expect(res.viaTextProtocol).toBe(false);
        expect(res.toolCalls).toHaveLength(1);
        expect(res.toolCalls[0].name).toBe('analyze_chapter');
        expect(res.toolCalls[0].args).toEqual({ chapterIds: ['1'] });
      },
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'analyze_chapter', arguments: '{"chapterIds":["1"]}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
  });

  it('★ prompted 路径不发 tools（发了也没用，探测已确认它会忽略）', async () => {
    const provider = findProvider('ollama')!;
    const client = new LlmClient({
      provider, baseUrl: provider.defaultBaseUrl, model: 'llama3',
      mode: 'prompted', tools: [], timeoutMs: 5000,
    });
    const sent = await withFetchCapture(
      async () => {
        await client.chat({
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
          stream: false,
        });
      },
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '普通回答' } }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
    );
    expect(sent[0]['tools']).toBeUndefined();
    // 但协议说明必须进 system 消息
    const msgs = sent[0]['messages'] as Array<{ role: string; content: string }>;
    const sys = msgs.find((m) => m.role === 'system');
    expect(sys?.content).toContain('<<TOOL:');
  });
});

// ───────────────────────── ③ GOAL_ACHIEVED 端到端 ─────────────────────────

describe('③ GOAL_ACHIEVED 端到端：健康分从低位升到达标', () => {
  /**
   * 真实散文（手写而非模板拼接）。
   * ★ 踩过的坑：一开始用 `Array.from(n, () => \`同一句话\`)` 生成「好文本」，
   *   结果 triRepeat 高达 0.875（p95=0.383），健康分只有 56.3 —— 模板重复
   *   本身就是 AI 味。这反而印证了指标有效：它正确地拒绝了这段「假好文本」。
   */
  const GOOD = `老陈把铁盒从柜子最底层拖出来的时候，灰尘在午后的光柱里翻涌。
盒盖锈死了，他用螺丝刀沿着边缘撬开一道缝，里面是三十年前那本账册。
第一页的字迹已经褪成浅褐，他凑近了些，勉强认出三个数字。
灶上的水开了，壶嘴冒出白气。他没有起身，仍一页一页往后翻。
中间夹着一张对折的纸条，展开来只有半句话，墨迹晕开成一团。
“三月十七，找小周。”他念出声，声音撞在空屋子里，又落回来。
窗外传来自行车的铃声，由近及远，最后消失在小区的拐角。
他把纸条重新折好，放回原处，合上铁盒时手掌停了一瞬。
楼道里的声控灯亮了又灭，他抱着盒子站在原地，等眼睛适应黑暗。
天色一点点沉下去，窗外的梧桐叶被风翻过来，露出浅色的背面。`;

  /** 典型 AI 味：全是万能停顿 + 动作三板斧 + 观感替代 */
  const BAD = Array.from({ length: 10 }, () =>
    '他愣了一下，顿了一下，没说话。他抬起头，把书放在桌上。他看了很久窗外，又看了一会儿。',
  ).join('\n');

  function analyzeScore(text: string): number {
    const a = analyze(text);
    const items = judge({
      raw: a.raw, per1000: a.per1000,
      metrics: REFERENCE_BASELINE.metrics,
      markerDensity: REFERENCE_BASELINE.markerDensity,
    });
    return healthScore(items, isSufficient(a.chars));
  }

  it('★ 目标：第 1 章健康分 ≥ 70，修正后 Agent 判定达成并停止', async () => {
    const scoreBefore = analyzeScore(BAD);
    const scoreAfter = analyzeScore(GOOD);
    console.log(`  改前健康分=${scoreBefore.toFixed(1)} → 改后=${scoreAfter.toFixed(1)}（目标 ≥70）`);
    // 前置确认：这段文本确实达标，否则本用例测不到「达成」分支
    expect(scoreAfter).toBeGreaterThanOrEqual(70);
    expect(scoreAfter).toBeGreaterThan(scoreBefore);

    let step = 0;
    let currentText = BAD;
    const goal = { kind: 'health_score' as const, chapterId: '1', threshold: 70 };

    const loop = new AgentLoop('run_e2e', '把第 1 章健康分提到 70 以上', {
      plan: async (): Promise<Plan> => ({
        goalRestated: '把第 1 章健康分提到 70 以上',
        steps: [{ index: 1, intent: '诊断并修正表达层问题' }],
      }),
      select: async (): Promise<ToolCall> => {
        step += 1;
        return { name: `step_${step}`, args: { s: step } };
      },
      execute: async (): Promise<ToolResult> => {
        currentText = GOOD; // 「执行修复」→ 正文变好
        return { ok: true, durationMs: 5, data: {} };
      },
      observe: async (_c, _r, stepNo): Promise<Observation> => ({
        stepNo, toolName: 'fix_expression', kind: 'facts',
        summary: '已修正表达层', durationMs: 5, ok: true,
      }),
      // ★ 真评估：每步重新读正文重算，绝不复用缓存
      evaluate: async (): Promise<{ progress: 'partial' | 'positive'; goalAchieved: boolean; reason: string }> => {
        const facts: EvalFacts = {
          healthScores: { '1': analyzeScore(currentText) },
          metrics: {},
          sufficient: { '1': true },
          conflictCount: 0,
        };
        const v = evaluateGoal(goal, facts);
        return {
          progress: v.achieved ? 'positive' : 'partial',
          goalAchieved: v.achieved,
          reason: v.reason,
        };
      },
      stateHash: async () => (step === 1 ? 'h1' : `h${step}`),
      emit: () => undefined,
      isAborted: () => false,
      isPaused: () => false,
      waitWhilePaused: async () => ({ aborted: false }),
      isLocal: false,
      maxHistory: 50,
    }, { ...DEFAULT_BUDGET, maxSteps: 24 });

    const { reason, stats } = await loop.run();
    console.log(`  终止原因=${reason.code}  实际步数=${stats.steps}`);
    expect(reason.code).toBe('GOAL_ACHIEVED');
    // 关键：不是跑满 24 步，而是判定达成后主动停
    expect(stats.steps).toBeLessThan(5);
  });

  it('★ 复检用真实数据：修正前的分数不会被当成达成（防假成功）', async () => {
    // 用 BAD 的分数去对 70 的目标 —— 必须判未达成
    const v = evaluateGoal(
      { kind: 'health_score', chapterId: '1', threshold: 70 },
      { healthScores: { '1': analyzeScore(BAD) }, metrics: {}, sufficient: { '1': true }, conflictCount: 0 },
    );
    expect(v.achieved).toBe(false);
    console.log(`  BAD 文本对目标 70 的判定：${v.reason}`);
  });

  it('★ 分数未到目标时不得宣布达成（边界：72 < 95）', () => {
    const v = evaluateGoal(
      { kind: 'health_score', chapterId: '1', threshold: 95 },
      { healthScores: { '1': analyzeScore(GOOD) }, metrics: {}, sufficient: { '1': true }, conflictCount: 0 },
    );
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('还差');
  });
});
