/**
 * 目标达成评估器测试（团队负责人要求的自验项 2）。
 *
 * 覆盖：4 种目标类型各至少 1 条 + 「未达成」判定 + 进度分级 + custom 校验。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateGoal,
  parseGoal,
  toEvaluation,
  validateCustomVerdict,
  type EvalFacts,
  type GoalSpec,
} from '@main/agent/goal-evaluator';

function facts(over: Partial<EvalFacts> = {}): EvalFacts {
  return {
    healthScores: {},
    metrics: {},
    sufficient: {},
    conflictCount: 0,
    ...over,
  };
}

describe('目标类型 1：health_score（健康分达到阈值）', () => {
  const goal: GoalSpec = { kind: 'health_score', chapterId: '37', threshold: 85 };

  it('达成：87.4 ≥ 85', () => {
    const v = evaluateGoal(goal, facts({
      healthScores: { '37': 87.4 },
      sufficient: { '37': true },
    }));
    expect(v.achieved).toBe(true);
    expect(v.actual).toBeCloseTo(87.4);
    expect(v.target).toBe(85);
    expect(v.reason).toContain('已达到目标');
  });

  it('★ 恰好等于阈值也算达成（边界含等号）', () => {
    const v = evaluateGoal(goal, facts({ healthScores: { '37': 85 }, sufficient: { '37': true } }));
    expect(v.achieved).toBe(true);
  });

  it('未达成：24 分差 61 分，且给出可执行的下一步', () => {
    const v = evaluateGoal(goal, facts({ healthScores: { '37': 24 }, sufficient: { '37': true } }));
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('还差');
    expect(v.reason).toContain('61');
  });

  it('★ 样本不足时不得宣布达成（避免假成功）', () => {
    const v = evaluateGoal(goal, facts({
      healthScores: { '37': 99 },
      sufficient: { '37': false },
    }));
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('字数不足');
  });

  it('无数据时不崩溃，明确说明', () => {
    const v = evaluateGoal(goal, facts());
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('没有可评估的数据');
  });
});

describe('目标类型 2：metric_below（指标降到阈值以下）', () => {
  const goal: GoalSpec = { kind: 'metric_below', chapterId: '37', metric: 'triRepeat', threshold: 0.2 };

  it('达成：0.18 ≤ 0.2', () => {
    const v = evaluateGoal(goal, facts({ metrics: { '37': { triRepeat: 0.18 } } }));
    expect(v.achieved).toBe(true);
    expect(v.reason).toContain('已降到');
  });

  it('未达成：0.4767 仍高于 0.2，且给出差值', () => {
    const v = evaluateGoal(goal, facts({ metrics: { '37': { triRepeat: 0.4767 } } }));
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('仍高于目标');
    expect(v.reason).toContain('0.2767');
  });

  it('边界：恰好等于阈值算达成', () => {
    const v = evaluateGoal(goal, facts({ metrics: { '37': { triRepeat: 0.2 } } }));
    expect(v.achieved).toBe(true);
  });

  it('★ marker 类指标也支持（走 per1000）', () => {
    const g: GoalSpec = {
      kind: 'metric_below', chapterId: '1', metric: 'dialogRatio', threshold: 0.5,
    };
    const v = evaluateGoal(g, facts({ metrics: { '1': { dialogRatio: 0.42 } } }));
    expect(v.achieved).toBe(true);
  });
});

describe('目标类型 3：metric_above（指标升到阈值以上）', () => {
  const goal: GoalSpec = { kind: 'metric_above', chapterId: '37', metric: 'dialogRatio', threshold: 0.6 };

  it('达成：0.65 ≥ 0.6', () => {
    const v = evaluateGoal(goal, facts({ metrics: { '37': { dialogRatio: 0.65 } } }));
    expect(v.achieved).toBe(true);
    expect(v.reason).toContain('已升到');
  });

  it('未达成：0.42，给出差值', () => {
    const v = evaluateGoal(goal, facts({ metrics: { '37': { dialogRatio: 0.42 } } }));
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('还差');
  });
});

describe('目标类型 4：no_conflicts（一致性账本无冲突）', () => {
  const goal: GoalSpec = { kind: 'no_conflicts', threshold: 0 };

  it('达成：冲突数 0', () => {
    const v = evaluateGoal(goal, facts({ conflictCount: 0 }));
    expect(v.achieved).toBe(true);
    expect(v.reason).toContain('已达标');
  });

  it('★ 未达成：3 处冲突，并提示「需你裁决」（系统不自动统一）', () => {
    const v = evaluateGoal(goal, facts({ conflictCount: 3 }));
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('3 处冲突');
    expect(v.reason).toContain('需你裁决');
  });
});

describe('目标类型 5：custom（兜底转 LLM）', () => {
  it('规则层不擅自判定，转交 custom 路径', () => {
    const v = evaluateGoal({ kind: 'custom', statement: '看着改吧' }, facts());
    expect(v.achieved).toBe(false);
    expect(v.reason).toContain('custom');
  });
});

describe('★「未达成」的严重程度分级（循环靠它决定重试还是收手）', () => {
  const notAchieved = evaluateGoal(
    { kind: 'health_score', chapterId: '1', threshold: 90 },
    facts({ healthScores: { '1': 50 }, sufficient: { '1': true } }),
  );

  it('未达成但有改进 → partial（继续）', () => {
    const e = toEvaluation(notAchieved, 40, 50);
    expect(e.progress).toBe('partial');
    expect(e.goalAchieved).toBe(false);
  });

  it('★ 未达成且无变化 → none（交给闸门③判停滞）', () => {
    const e = toEvaluation(notAchieved, 50, 50);
    expect(e.progress).toBe('none');
    expect(e.nextHint).toContain('换策略');
  });

  it('★ 未达成且分数变差 → negative（触发副作用回滚）', () => {
    const e = toEvaluation(notAchieved, 60, 50);
    expect(e.progress).toBe('negative');
    expect(e.nextHint).toContain('副作用');
  });

  it('有副作用时优先判 negative（不论分数是否变）', () => {
    const e = toEvaluation(notAchieved, 40, 50, [
      {
        toolName: 'fix_structure', ruleId: 'F4', chapterId: '1',
        metric: 'dialogRatio', before: 0.6, after: 0.9, bound: 0.828,
        boundKind: 'p95', beforeGrade: 'ok', afterGrade: 'risk',
        rolledBack: true, explanation: 'F4 让对白占比超标，已撤回',
      },
    ]);
    expect(e.progress).toBe('negative');
    expect(e.sideEffects).toHaveLength(1);
  });

  it('达成 → positive 且 goalAchieved=true', () => {
    const done = evaluateGoal(
      { kind: 'health_score', chapterId: '1', threshold: 85 },
      facts({ healthScores: { '1': 87 }, sufficient: { '1': true } }),
    );
    const e = toEvaluation(done, 24, 87);
    expect(e.goalAchieved).toBe(true);
    expect(e.progress).toBe('positive');
    expect(e.nextHint).toBeUndefined();
  });
});

describe('文本目标 → 结构化目标解析', () => {
  it('解析「第 37 章健康分提到 85 以上」', () => {
    const g = parseGoal('第 37 章健康分提到 85 以上', ['37', '38']);
    expect(g).toEqual({ kind: 'health_score', chapterId: '37', threshold: 85 });
  });

  it('解析「把 triRepeat 降到 0.2 以下」', () => {
    const g = parseGoal('把 triRepeat 降到 0.2 以下', ['37']);
    expect(g).toEqual({ kind: 'metric_below', chapterId: '37', metric: 'triRepeat', threshold: 0.2 });
  });

  it('解析「检查全书有没有前后矛盾」→ no_conflicts', () => {
    const g = parseGoal('检查全书有没有前后矛盾', ['1', '2']);
    expect(g).toEqual({ kind: 'no_conflicts', threshold: 0 });
  });

  it('★ 解析不出时返回 null（由调用方降级到 custom，不硬猜）', () => {
    expect(parseGoal('你看着改吧', ['1'])).toBeNull();
  });
});

describe('custom 判定结果的结构校验（Zod 语义）', () => {
  it('合法结果被采纳', () => {
    const v = validateCustomVerdict({ achieved: true, reason: '健康分已达标' });
    expect(v.achieved).toBe(true);
    expect(v.errors).toBeUndefined();
  });

  it('★ achieved 类型错误 → 拒绝并逐项点名', () => {
    const v = validateCustomVerdict({ achieved: 'yes', reason: '好了' });
    expect(v.achieved).toBe(false);
    expect(v.errors?.join()).toContain('achieved');
  });

  it('★ reason 为空 → 拒绝', () => {
    const v = validateCustomVerdict({ achieved: true, reason: '   ' });
    expect(v.errors?.join()).toContain('reason');
  });

  it('完全不是对象时不崩溃', () => {
    const v = validateCustomVerdict(null);
    expect(v.achieved).toBe(false);
    expect(v.errors?.length).toBeGreaterThan(0);
  });
});