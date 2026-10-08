/**
 * replace_phrase —— 精确短语替换（架构 §1.6 工具 12，★1 Precise）。
 *
 * 为什么是 ★1 而不是更高：快照精确到那一句话，回滚后**逐字节一致**，
 * 不波及同章任何其它内容。与 delete_chapter 形成鲜明对比——
 * 后者即便可回滚也是 ★4，因为回滚会把整章恢复成旧版，
 * 覆盖用户在删除之后对其它章节做的修改。
 */
import type { ChangeSet, Edit, ToolContext, ToolResult } from '@shared/types/tool';
import { buildQuoteRanges, inQuoteRanges } from '@shared/util/text-zh';
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

  // ★ 引号区间表在循环外建一次。修复前每次匹配都调 inQuote(before, at)，
  //   而它每次都从头扫到 at → 整体 O(n·m)；长章 + 高频短语时明显可感。
  const quotes = includeQuotes ? null : buildQuoteRanges(before);

  let cursor = 0;
  let skippedInQuote = 0;
  while (true) {
    const at = before.indexOf(args.find, cursor);
    if (at < 0) break;

    // 引号内是人物语言，是本书要「立」的核心资产——默认不动
    if (quotes && inQuoteRanges(quotes, at)) {
      skippedInQuote++;
      cursor = at + args.find.length;
      continue;
    }

    edits.push({
      before: args.find,
      after: args.replace,
      // 原文（before）中的字符偏移。倒序应用时，靠前的偏移不受靠后改动的影响，
      // 因此必须存原文偏移而非「改后偏移」——与 rule-engine/fix-families.ts 的 m.index 口径一致。
      at,
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

  // 按原文偏移倒序应用：靠后的改动先落地，靠前的偏移因此保持不变。
  // ★ 必须用 e.at，绝不能用 before.indexOf(e.before)——后者恒定位到「第一处」匹配，
  //   多处替换时会在同一偏移反复切割已经变短/变长的字符串，静默产出乱码正文。
  let text = before;
  let applied = 0;
  for (const e of [...edits].sort((x, y) => y.at - x.at)) {
    // 防御脏数据：偏移越界、或该偏移处的文本与记录的 before 不符 → 跳过而非破坏正文
    if (e.at < 0 || e.at + e.before.length > text.length) continue;
    if (text.slice(e.at, e.at + e.before.length) !== e.before) continue;
    text = text.slice(0, e.at) + e.after + text.slice(e.at + e.before.length);
    applied++;
  }

  if (applied === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_NO_EFFECT',
        message: `定位到 ${edits.length} 处「${args.find}」，但偏移校验全部未通过，已放弃改写以保持原文不动。`,
        retryable: false,
        hint: '正文可能在定位后被改动过，请重新调用 locate_issues 获取最新写法。',
      },
    };
  }

  // 副作用复检：改一个短语不太可能动指标，但仍走一遍以保持口径一致
  const effects = detectSideEffects(
    before, text, 'replace_phrase', 'replace_phrase', args.chapterId, deps.baseline(),
    { affectedMetrics: ['avgSent', 'dialogRatio'], minChars: 200 },
  );

  // preview 与 execute 必须同路径（架构 T08「preview/execute 同源」）：
  // 副作用拒绝在 dryRun 下同样成立，否则会出现「预览说能改、真改被拒」的欺骗性预览。
  if (effects.length > 0) {
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
    data: { changeSet, replacements: applied, skippedInQuote, sideEffectRejected: false },
    changeSet,
    durationMs: Date.now() - started,
  };
}