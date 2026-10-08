/**
 * replace_phrase —— 精确短语替换（架构 §1.6 工具 12，★1 Precise）。
 *
 * 为什么是 ★1 而不是更高：快照精确到那一句话，回滚后**逐字节一致**，
 * 不波及同章任何其它内容。与 delete_chapter 形成鲜明对比——
 * 后者即便可回滚也是 ★4，因为回滚会把整章恢复成旧版，
 * 覆盖用户在删除之后对其它章节做的修改。
 */
import type { ChangeSet, Edit, ToolContext, ToolResult } from '@shared/types/tool';
import { inQuote } from '@shared/util/text-zh';
import { detectSideEffects } from '../../agent/side-effect';
import type { BaselineLike } from '../../rule-engine/plan-fixes';

export interface PhraseDeps {
  getBody: (chapterId: string) => Promise<string | null>;
  setBody: (chapterId: string, body: string) => Promise<void>;
  baseline: () => BaselineLike;
}

export interface ReplacePhraseArgs {
  chapterId: string;
  find: string;
  replace: string;
  /** 默认 false：不在引号内替换（人物语言不动）。用户明确要改时可传 true */
  includeQuotes?: boolean;
}

export interface ReplacePhraseResult {
  changeSet: ChangeSet;
  replacements: number;
  skippedInQuote: number;
  sideEffectRejected: boolean;
}

export async function replacePhrase(
  args: ReplacePhraseArgs,
  ctx: ToolContext,
  deps: PhraseDeps,
): Promise<ToolResult<ReplacePhraseResult>> {
  const started = Date.now();

  if (!args.chapterId || !args.find) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: '缺少必填参数：chapterId 与 find。',
        retryable: true,
        hint: '例如 {"chapterId":"37","find":"看了很久","replace":"没再看第二眼"}',
      },
    };
  }

  const before = await deps.getBody(args.chapterId);
  if (before === null) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: `章节不存在：${args.chapterId}`,
        retryable: false,
      },
    };
  }

  // ── 执行前强制落 checkpoint（★1 也一样要落：fail-safe 不区分 danger）──
  let checkpointId: string | undefined;
  if (!ctx.dryRun) {
    checkpointId = await ctx.requireCheckpoint([args.chapterId]);
  }

  const includeQuotes = args.includeQuotes === true;
  const edits: Edit[] = [];

  let cursor = 0;
  let skippedInQuote = 0;
  while (true) {
    const at = before.indexOf(args.find, cursor);
    if (at < 0) break;

    // 引号内是人物语言，是本书要「立」的核心资产——默认不动
    if (!includeQuotes && inQuote(before, at)) {
      skippedInQuote++;
      cursor = at + args.find.length;
      continue;
    }

    edits.push({
      before: args.find,
      after: args.replace,
      at: edits.length === 0 ? at : at + edits.length * (args.replace.length - args.find.length),
      note: `等义改写：「${args.find}」→「${args.replace}」`,
      ruleId: 'replace_phrase',
    });
    cursor = at + args.find.length;
  }

  if (edits.length === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_NO_EFFECT',
        message:
          skippedInQuote > 0
            ? `找到 ${skippedInQuote} 处「${args.find}」，但全部在引号内（人物语言），已按规则跳过。`
            : `未找到「${args.find}」。请先调用 locate_issues 确认原文写法（逐字可寻）。`,
        retryable: false,
        hint: '引号内不改是刻意约束；若确实要改台词，请让用户明确要求后再传 includeQuotes=true。',
      },
    };
  }

  // 按偏移倒序应用，保证前面的偏移不被后面的改动挪动
  let text = before;
  for (const e of [...edits].reverse()) {
    const realAt = before.indexOf(e.before);
    if (realAt < 0) continue;
    text = text.slice(0, realAt) + e.after + text.slice(realAt + e.before.length);
  }

  // 副作用复检：改一个短语不太可能动指标，但仍走一遍以保持口径一致
  const effects = detectSideEffects(
    before, text, 'replace_phrase', 'replace_phrase', args.chapterId, deps.baseline(),
    { affectedMetrics: ['avgSent', 'dialogRatio'], minChars: 200 },
  );

  if (effects.length > 0 && !ctx.dryRun) {
    // 有副作用 → 拒绝执行，保持原文不动（★1 精确工具可以安全地整体放弃）
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_SIDE_EFFECT_REJECTED',
        message: `改写会引入副作用，已撤回：${effects.map((e) => e.explanation).join('；')}`,
        retryable: false,
        hint: '换一个改写方式，或只替换其中一处。',
      },
    };
  }

  const changeSet: ChangeSet = {
    chapterId: args.chapterId,
    patches: [
      {
        chapterId: args.chapterId,
        beforeText: before,
        afterText: text,
        bytes: Buffer.byteLength(text, 'utf8') - Buffer.byteLength(before, 'utf8'),
        at: Date.now(),
        runId: ctx.runId,
        toolName: 'replace_phrase',
        edits,
      },
    ],
    edits,
    bytes: Buffer.byteLength(text, 'utf8') - Buffer.byteLength(before, 'utf8'),
    checkpointId,
    dryRun: ctx.dryRun,
  };

  if (!ctx.dryRun) {
    await deps.setBody(args.chapterId, text);
  }

  return {
    ok: true,
    data: { changeSet, replacements: edits.length, skippedInQuote, sideEffectRejected: false },
    changeSet,
    durationMs: Date.now() - started,
  };
}