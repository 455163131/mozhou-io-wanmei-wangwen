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
import { autoRules, sideEffectTargetsOf } from '../../rule-engine/fix-rules';
import { toolRulesFor } from '../derive-from-rules';
import { sweepSideEffects, detectSideEffects } from '../../agent/side-effect';

export interface FixDeps {
  getBodies: (chapterIds: string[]) => Promise<Map<string, string>>;
  /** 写回正文（dryRun 时**绝不能**被调用） */
  setBody: (chapterId: string, body: string) => Promise<void>;
  baseline: () => BaselineLike;
}

/**
 * 聚合工具名 → 规则 id 列表。
 *
 * ★ 不在本文件另存一份：映射的唯一真源是 `derive-from-rules.ts` 的 `toolRulesFor()`，
 *   它同时驱动工具**声明**（ToolSpec 生成）。声明与执行共用一份，
 *   才不会出现「工具说明写着覆盖 F12、执行时一条都不跑」这类漂移。
 *   修复前本文件的 TOOL_RULES 与那边是两份手抄表，且 fix_synonym_rotation
 *   一项用的是 FIX_RULES 里不存在的 `family:*` 伪 id → 该工具恒为静默 no-op。
 */
const toolRules = toolRulesFor;

/**
 * 同义轮换族名 → 实现它的规则 id（对应 fix-rules.ts 里的 fixFamilies 调用）。
 *
 * ⚠️ 粒度限制（如实登记，不假装能做到）：place 与 inch 都由 F13 实现，
 *   而 F13 一次轮换两族。用户只点名其中一族时，另一族也会被轮换。
 *   要真正做到按族隔离，需要把 F13 拆成两条规则或让 fixFamilies 接受运行时族参数。
 */
const FAMILY_RULES: Record<string, string> = {
  same: 'F12',
  place: 'F13',
  inch: 'F13',
};

/** 参数里的 families / metrics / markers 筛选 → 缩小规则集合 */
function narrowRules(toolName: string, args: Record<string, unknown>): string[] | null {
  const all = toolRules(toolName);
  // 未知工具名 → 空数组。返回 null 让调用方报 E_INVALID_ARGS，而不是静默跑零条规则
  if (all.length === 0) return null;

  // families：修复前只做了「取值合法性校验」，校验完就丢弃，从未参与规则选择——
  // 用户点名要轮换哪一族，实际跑的仍是全族（而且当时全族等于零条）。
  const families = Array.isArray(args.families) ? (args.families as string[]) : null;
  if (families && families.length > 0) {
    const ids = families
      .map((f) => FAMILY_RULES[f])
      .filter((id): id is string => !!id && all.includes(id));
    return [...new Set(ids)];
  }

  const metrics = Array.isArray(args.metrics) ? (args.metrics as string[]) : null;
  const markers = Array.isArray(args.markers) ? (args.markers as string[]) : null;
  if (!metrics && !markers) return all;

  const filters = [
    ...(metrics ?? []).map((m) => `metric:${m}`),
    ...(markers ?? []).map((m) => `marker:${m}`),
  ];

  return all.filter((ruleId) => {
    const rule = autoRules().find((r) => r.id === ruleId);
    // 未知 id 一律不保留（fail-closed）。修复前这里有一条 `family:` 特殊分支，
    // 现在 TOOL_RULES 只含真实规则 id，该分支已无意义。
    if (!rule) return false;
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
        message: `当前筛选条件下没有可用规则。该工具覆盖：${toolRules(toolName).join(', ') || '（无）'}`,
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
    // ★ 用 let 而非 const + push 累加。
    //   每轮的 trial 都是「从原文重跑一遍全部已接受规则」，所以 trial.changes
    //   本身就是**当前完整的编辑集**（含之前各轮的），不是增量。
    //   修复前这里写 `finalEdits.push(...trial.changes)`，等于把前面各轮的改动
    //   重复追加一遍：接受 F12、F13 两条后 edits 会报 3 条（F12 被算两次），
    //   污染 editsCount 与用户可见的「改了 N 处」。直接整体替换才正确。
    let finalEdits: Edit[] = [];
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
      finalEdits = trial.changes.slice();
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

  // ★ 零改动 + 无副作用否决 = 这批规则在本文本上确实无事可做，必须**明确报出来**。
  //   修复前这里一律返回 ok:true，于是「规则 id 写错导致一条都没跑」与
  //   「文本本来就干净」在返回值上完全无法区分 —— Agent 看到「成功但没效果」
  //   会反复重试，一路烧到步数/成本闸门才停。
  //   与 tools/impl/phrase.ts 的 E_NO_EFFECT 口径保持一致。
  //   注意：被副作用否决的情况**不走这里**，那条路径有 allSideEffects 要交给用户看。
  if (patches.length === 0 && allSideEffects.length === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_NO_EFFECT',
        message:
          `${toolName} 在 ${existing.length} 个章节上没有产生任何改动。` +
          (allSkipped.length > 0
            ? `已跳过 ${allSkipped.length} 条规则（原因见 skipped）。`
            : '这些规则负责的问题在本章未检出。'),
        retryable: false,
        hint:
          '先调 locate_issues 确认本章到底有哪些偏离；没有偏离就不需要修正，' +
          '不要重复调用本工具。',
      },
    };
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

/**
 * 规则 id → 副作用检测该盯的指标。
 *
 * ★ **不再手抄映射表**。修复前这里存了一份 `Record<string, string[]>`，
 *   与 `agent/side-effect.ts` 的 `RULE_TARGETS` 是同一份知识的两个副本，
 *   而且**已经分叉**：F6 这里写 `dialogRatio`、那边写 `openType`
 *   （真相是 `fix-rules.ts` 的 `targets: ['openType']` —— F6 是「章首公式」，
 *   与对白占比毫无关系）。未知规则还会 `?? []`，等于副作用闸门 fail-open。
 *   现在统一走 `sideEffectTargetsOf()`，只此一份真源。
 */
function ruleTargets(ruleId: string): string[] {
  return sideEffectTargetsOf(ruleId);
}

export { sweepSideEffects, rollbackRule };