/**
 * 修正工具实现（架构 §1.6 工具 8-11 / T08）。
 *
 * ★★★ 本文件实现三条不可省的正确性保证 ★★★
 *
 * 1. **preview 与 execute 共用同一段变换逻辑**（`ctx.dryRun` 区分）。
 *    架构原话：写成两个函数「100% 会出现预览说改 3 处、实际改了 4 处」。
 *    本文件只有一个 `applyFixTool()`，dryRun 时跳过写库与 checkpoint 落地。
 *
 * 2. **执行前强制落 checkpoint，失败即拒绝执行**（fail-safe）。
 *    `ctx.requireCheckpoint()` 抛错时**直接向上抛**，不 catch 后继续——
 *    「改了但没快照」这个状态必须被彻底禁止。
 *
 * 3. **副作用检测在入栈前**：只把通过复检的改动写进 Patch，
 *    被回滚的规则不进 checkpoint（撤销栈里不混入「试过但被否」的中间态）。
 */
import type { ChangeSet, Edit, SideEffect, ToolContext, ToolResult } from '@shared/types/tool';
import { planFixes, rollbackRule, type BaselineLike, type FixPlan } from '../../rule-engine/plan-fixes';
import { autoRules } from '../../rule-engine/fix-rules';
import { sweepSideEffects, detectSideEffects } from '../../agent/side-effect';

export interface FixDeps {
  getBodies: (chapterIds: string[]) => Promise<Map<string, string>>;
  /** 写回正文（dryRun 时**绝不能**被调用） */
  setBody: (chapterId: string, body: string) => Promise<void>;
  baseline: () => BaselineLike;
}

/** 聚合工具名 → 规则 id 列表 */
const TOOL_RULES: Record<string, string[]> = {
  fix_structure: ['F6', 'F7', 'F8', 'F9', 'F10'],
  fix_expression: ['F1', 'F2', 'F3', 'F4', 'F5', 'F11'],
  fix_repetition: ['F12', 'F13'],
  fix_synonym_rotation: ['family:same', 'family:place', 'family:inch'],
};

/** 参数里的 metrics/markers 筛选 → 缩小规则集合 */
function narrowRules(toolName: string, args: Record<string, unknown>): string[] | null {
  const all = TOOL_RULES[toolName];
  if (!all) return null;

  const metrics = Array.isArray(args.metrics) ? (args.metrics as string[]) : null;
  const markers = Array.isArray(args.markers) ? (args.markers as string[]) : null;
  if (!metrics && !markers) return all;

  const filters = [
    ...(metrics ?? []).map((m) => `metric:${m}`),
    ...(markers ?? []).map((m) => `marker:${m}`),
  ];

  return all.filter((ruleId) => {
    const rule = autoRules().find((r) => r.id === ruleId);
    if (!rule) {
      // 族规则：按族名匹配
      if (ruleId.startsWith('family:')) {
        const fam = ruleId.slice(7);
        if (filters.some((f) => f.includes(fam === 'same' ? '一样' : fam))) return true;
        return filters.length === 0;
      }
      return false;
    }
    // 规则负责的任一 target 命中筛选条件即保留
    return rule.targets.some((t) => filters.includes(t));
  });
}

export interface ApplyFixArgs {
  chapterIds: string[];
  metrics?: string[];
  markers?: string[];
  families?: string[];
}

export interface ApplyFixResult {
  changeSet: ChangeSet;
  sideEffects: SideEffect[];
  /** 被跳过的规则及原因，直接展示给用户（诚实性） */
  skipped: FixPlan['skipped'];
  scoreBefore: number;
  scoreAfter: number;
}

/**
 * ★ 核心执行器。四个聚合修正工具与 preview **全部走这一个函数**。
 */
export async function applyFixTool(
  toolName: string,
  args: ApplyFixArgs,
  ctx: ToolContext,
  deps: FixDeps,
  spec: { reversible: boolean },
): Promise<ToolResult<ApplyFixResult>> {
  const started = Date.now();
  const chapterIds = args.chapterIds ?? [];

  if (chapterIds.length === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: '缺少必填参数 chapterIds：要改哪些章？',
        retryable: true,
        hint: '例如 {"chapterIds":["37"]}',
      },
    };
  }

  // fix_synonym_rotation 的 families 参数单独处理
  if (toolName === 'fix_synonym_rotation' && Array.isArray(args.families)) {
    const fams = args.families as string[];
    const invalid = fams.filter((f) => !['place', 'same', 'inch'].includes(f));
    if (invalid.length > 0) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_INVALID_ARGS',
          message:
            `families 含无效取值：${invalid.join(', ')}。` +
            `⚠️ 特别提醒：没有 verb 族——作者语料实测「说」1356 次而「道/问/念/应」近乎不存在，` +
            `轮换它们等于用机器口吻覆盖作者口吻，这是刻意关闭的能力。`,
          retryable: false,
          hint: '可选值：place | same | inch',
        },
      };
    }
  }

  const ruleIds = narrowRules(toolName, args as unknown as Record<string, unknown>);
  if (!ruleIds || ruleIds.length === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: `当前筛选条件下没有可用规则。该工具覆盖：${TOOL_RULES[toolName]?.join(', ')}`,
        retryable: false,
        hint: '去掉 metrics/markers 参数以运行该层全部规则。',
      },
    };
  }

  const baseline = deps.baseline();
  const bodies = await deps.getBodies(chapterIds);
  const existing = chapterIds.filter((id) => bodies.has(id));
  if (existing.length === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: `章节不存在：${chapterIds.join(', ')}`,
        retryable: false,
      },
    };
  }

  // ── ② 执行前强制落 checkpoint（fail-safe）。preview 模式跳过 ──
  let checkpointId: string | undefined;
  if (!ctx.dryRun && spec.reversible) {
    checkpointId = await ctx.requireCheckpoint(existing);
    // ↑ 若抛错，这里直接向上抛——**绝不 catch 后继续**
  }

  // ── ① 逐章处理：plan → 副作用复检 → 局部回滚 → 采纳 ──
  const allEdits: Edit[] = [];
  const allSideEffects: SideEffect[] = [];
  const allSkipped: FixPlan['skipped'] = [];
  const afterBodies = new Map<string, string>();
  const patches: ChangeSet['patches'] = [];
  let scoreBeforeSum = 0;
  let scoreAfterSum = 0;
  let changedChapters = 0;

  for (const chapterId of existing) {
    const before = bodies.get(chapterId) as string;
    const plan = planFixes(before, { rules: ruleIds, baseline });
    scoreBeforeSum += plan.scoreBefore;
    allSkipped.push(...plan.skipped.map((s) => ({ ...s })));

    if (plan.changes.length === 0) {
      afterBodies.set(chapterId, before);
      scoreAfterSum += plan.scoreBefore;
      continue;
    }

    // ── ③ 副作用检测在入栈前 ──
    // 逐条规则复检：把被副作用否决的规则从计划中剔除
    const acceptedRules: string[] = [];
    let finalText = plan.before;
    const finalEdits: Edit[] = [];
    const chapterEffects: SideEffect[] = [];

    for (const app of plan.perRule) {
      // 把这条规则叠加到当前已接受的结果上
      const trial = planFixes(plan.before, {
        rules: [...acceptedRules, app.ruleId],
        baseline,
      });
      const effects = detectSideEffects(plan.before, trial.after, toolName, app.ruleId, chapterId, baseline, {
        affectedMetrics: ruleTargets(app.ruleId),
      });

      if (effects.length > 0) {
        for (const e of effects) {
          e.rolledBack = true;
          chapterEffects.push(e);
        }
        // 这条规则被否：不加入 acceptedRules，等价于不落 Patch
        continue;
      }
      acceptedRules.push(app.ruleId);
      finalText = trial.after;
      finalEdits.push(...trial.changes);
    }

    if (finalEdits.length === 0) {
      // 全部规则都被副作用否决 → 该章不产生任何改动
      afterBodies.set(chapterId, before);
      scoreAfterSum += plan.scoreBefore;
      if (chapterEffects.length > 0) {
        allSideEffects.push(...chapterEffects);
        // ★ 副作用必须让用户看到：「F4 让对白占比从 0.82 涨到 0.87，超出 p95，所以撤回了它」
        for (const e of chapterEffects) {
          allSkipped.push({
            id: e.ruleId,
            label: `${toolName}/${e.ruleId}`,
            targets: [e.metric],
            relevant: true,
            changes: 0,
            why: e.explanation,
          });
        }
      }
      continue;
    }

    changedChapters++;
    scoreAfterSum += planFixes(plan.before, { rules: acceptedRules, baseline }).scoreAfter;
    afterBodies.set(chapterId, finalText);
    allEdits.push(...finalEdits);
    allSideEffects.push(...chapterEffects);

    patches.push({
      chapterId,
      beforeText: before,
      afterText: finalText,
      bytes: Buffer.byteLength(finalText, 'utf8') - Buffer.byteLength(before, 'utf8'),
      at: Date.now(),
      runId: ctx.runId,
      toolName,
      edits: finalEdits,
    });
  }

  const n = existing.length || 1;
  const changeSet: ChangeSet = {
    chapterId: existing[0],
    patches,
    edits: allEdits,
    bytes: patches.reduce((s, p) => s + p.bytes, 0),
    checkpointId,
    dryRun: ctx.dryRun,
  };

  // ── dryRun 到此为止：绝不写库 ──
  if (!ctx.dryRun && patches.length > 0) {
    for (const [chapterId, text] of afterBodies) {
      const orig = bodies.get(chapterId) as string;
      if (orig !== text) await deps.setBody(chapterId, text);
    }
  }

  return {
    ok: true,
    data: {
      changeSet,
      sideEffects: allSideEffects,
      skipped: allSkipped,
      scoreBefore: scoreBeforeSum / n,
      scoreAfter: scoreAfterSum / n,
    },
    changeSet,
    durationMs: Date.now() - started,
  };
}

function ruleTargets(ruleId: string): string[] {
  const map: Record<string, string[]> = {
    F1: ['marker:看了X遍/X久/X会儿'],
    F2: ['marker:顿/停了一下'],
    F3: ['marker:把X放在/搁在/摊在/摆在'],
    F4: ['marker:抬起头/低头'],
    F5: ['marker:没说话/没答/没出声'],
    F6: ['dialogRatio'],
    F7: ['avgSent', 'sentCv'],
    F8: ['sentCv'],
    F9: ['sentsPerPara'],
    F10: ['avgPara'],
    F11: ['marker:一X一X 叠词'],
    F12: ['ttr', 'bigramTtr'],
    F13: ['triRepeat', 'marker:观感类摆拍精确'],
    'family:same': ['ttr', 'bigramTtr'],
    'family:place': ['marker:把X放在/搁在/摊在/摆在'],
    'family:inch': ['triRepeat'],
  };
  return map[ruleId] ?? [];
}

export { sweepSideEffects, rollbackRule };