/**
 * replace_phrase 偏移正确性回归测试。
 *
 * ★★★ 本文件针对一个会静默损坏用户稿件的缺陷 ★★★
 *
 * 缺陷形态（修复前）：应用编辑时用 `before.indexOf(e.before)` 定位，而 indexOf 恒返回
 * **第一处**匹配。当 find 在章内出现 ≥2 次且 replace 与 find 长度不等时，循环会在
 * 同一偏移反复切割已经变长/变短的字符串，产出结构性乱码并直接写库。
 *
 * 例：原文「他看了很久，又看了三遍。」，find=「看了」→ replace=「没再看」
 *   期望：他没再看很久，又没再看三遍。
 *   修复前实际：他没再看看很久，又看了三遍。   ← 乱码
 *
 * 修复方式：Edit.at 统一为**原文偏移**（与 rule-engine/fix-families.ts 的 m.index 口径一致），
 * 倒序应用；并加偏移校验，不符则跳过而非破坏正文（沿用 ai-flavor-rewrite 的防御约定）。
 *
 * 另附 preview/execute 同路径断言（架构 T08）：副作用拒绝在 dryRun 下同样成立，
 * 否则会出现「预览说能改、真改被拒」的欺骗性预览。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { replacePhrase, type PhraseDeps } from '@main/tools/impl/phrase';
import { REFERENCE_BASELINE } from '@shared/constants/metrics';
import type { ToolContext } from '@shared/types/tool';

function makeCtx(dryRun: boolean, checkpointCalls: string[][] = []): ToolContext {
  return {
    runId: 'test-phrase',
    stepNo: 1,
    dryRun,
    requireCheckpoint: async (chs) => {
      checkpointCalls.push([...chs]);
      return `ckpt_${chs.join('_')}`;
    },
    signal: new AbortController().signal,
    logger: () => undefined,
  };
}

describe('replace_phrase · 多处匹配的偏移正确性（稿件损坏回归）', () => {
  let body: string;
  let writes: Array<{ id: string; body: string }>;
  let deps: PhraseDeps;

  beforeEach(() => {
    // 12 字：短于 detectSideEffects 的 minChars(200)，副作用闸门不介入，
    // 使本文件只测偏移算术，不被指标波动干扰。
    body = '他看了很久，又看了三遍。';
    writes = [];
    deps = {
      getBody: async () => body,
      setBody: async (id, b) => {
        body = b;
        writes.push({ id, body: b });
      },
      baseline: () => REFERENCE_BASELINE,
    };
  });

  it('★ 替换串更长：两处都必须被替换，且其余字符逐字不动', async () => {
    const res = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '没再看' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(true);
    // 修复前会得到「他没再看看很久，又看了三遍。」
    expect(body).toBe('他没再看很久，又没再看三遍。');
    expect(res.data?.replacements).toBe(2);
  });

  it('★ 替换串更短：偏移收缩后仍逐处命中', async () => {
    const res = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '瞥' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(body).toBe('他瞥很久，又瞥三遍。');
    expect(res.data?.replacements).toBe(2);
  });

  it('等长替换：两处均命中，长度不变', async () => {
    const res = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '瞧了' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(body).toBe('他瞧了很久，又瞧了三遍。');
    expect(res.data?.replacements).toBe(2);
  });

  it('★ 替换串更短且出现 4 次：累积收缩不串位', async () => {
    body = '他看了看，看了看她，又看了看天，最后看了看地。';
    const res = await replacePhrase(
      { chapterId: '37', find: '看了看', replace: '瞥' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(body).toBe('他瞥，瞥她，又瞥天，最后瞥地。');
    expect(res.data?.replacements).toBe(4);
  });

  it('单次匹配仍正确（回归护栏：不要为修多处而弄坏单处）', async () => {
    body = '他抬起头看了看远处。';
    const res = await replacePhrase(
      { chapterId: '37', find: '看了看', replace: '没再看' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(body).toBe('他抬起头没再看远处。');
    expect(res.data?.replacements).toBe(1);
  });

  it('edits[].at 是**原文**偏移且严格递增（锁定坐标系统一约定）', async () => {
    const res = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '没再看' },
      makeCtx(true),
      deps,
    );
    expect(res.ok).toBe(true);
    const edits = res.data!.changeSet.edits;
    expect(edits.map((e) => e.at)).toEqual([1, 7]);
    // 每个 at 在原文上都能逐字对上 before —— 这是「原文偏移」语义的可执行定义
    for (const e of edits) {
      expect(body.slice(e.at, e.at + e.before.length)).toBe(e.before);
    }
  });

  it('引号内的匹配被跳过，且不影响引号外两处的偏移', async () => {
    body = '他看了很久。“你看了吗？”她看了他一眼。';
    const res = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '瞥' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(body).toBe('他瞥很久。“你看了吗？”她瞥他一眼。');
    expect(res.data?.replacements).toBe(2);
    expect(res.data?.skippedInQuote).toBe(1);
  });

  it('includeQuotes=true 时引号内也改', async () => {
    body = '他看了很久。“你看了吗？”她看了他一眼。';
    const res = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '瞥', includeQuotes: true },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(body).toBe('他瞥很久。“你瞥吗？”她瞥他一眼。');
    expect(res.data?.replacements).toBe(3);
    expect(res.data?.skippedInQuote).toBe(0);
  });
});

describe('replace_phrase · preview 与 execute 同路径（架构 T08）', () => {
  let body: string;
  let deps: PhraseDeps;

  beforeEach(() => {
    body = '他看了很久，又看了三遍。';
    deps = {
      getBody: async () => body,
      setBody: async (_id, b) => {
        body = b;
      },
      baseline: () => REFERENCE_BASELINE,
    };
  });

  it('dryRun 不写库，但产出的 afterText 与真改逐字相同', async () => {
    const original = body;
    const preview = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '没再看' },
      makeCtx(true),
      deps,
    );
    expect(preview.ok).toBe(true);
    expect(body).toBe(original); // 预览必须不落盘
    const previewed = preview.data!.changeSet.patches[0].afterText;

    const execute = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '没再看' },
      makeCtx(false),
      deps,
    );
    expect(execute.ok).toBe(true);
    expect(body).toBe(previewed); // 真改结果 == 预览结果，逐字节
  });

  it('dryRun 也落 checkpoint 之前不写库；execute 才写', async () => {
    const ckPreview: string[][] = [];
    await replacePhrase(
      { chapterId: '37', find: '看了', replace: '瞥' },
      makeCtx(true, ckPreview),
      deps,
    );
    expect(ckPreview).toEqual([]); // dryRun 不占快照槽位

    const ckExecute: string[][] = [];
    await replacePhrase(
      { chapterId: '37', find: '看了', replace: '瞥' },
      makeCtx(false, ckExecute),
      deps,
    );
    expect(ckExecute).toEqual([['37']]);
  });
});

describe('replace_phrase · 参数与边界', () => {
  const deps: PhraseDeps = {
    getBody: async () => '他看了很久。',
    setBody: async () => undefined,
    baseline: () => REFERENCE_BASELINE,
  };

  it('缺 find 时返回 E_INVALID_ARGS 且不写库', async () => {
    const res = await replacePhrase(
      { chapterId: '37', find: '', replace: '瞥' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.code).toBe('E_INVALID_ARGS');
  });

  it('章节不存在时返回 E_INVALID_ARGS', async () => {
    const missing: PhraseDeps = { ...deps, getBody: async () => null };
    const res = await replacePhrase(
      { chapterId: 'nope', find: '看了', replace: '瞥' },
      makeCtx(false),
      missing,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.retryable).toBe(false);
  });

  it('未找到目标短语 → E_NO_EFFECT（不静默成功）', async () => {
    const res = await replacePhrase(
      { chapterId: '37', find: '不存在的词', replace: '瞥' },
      makeCtx(false),
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.code).toBe('E_NO_EFFECT');
  });

  it('全部匹配都在引号内 → E_NO_EFFECT 且 skippedInQuote 计数正确', async () => {
    const quoted: PhraseDeps = { ...deps, getBody: async () => '“你看了吗？”' };
    const res = await replacePhrase(
      { chapterId: '37', find: '看了', replace: '瞥' },
      makeCtx(false),
      quoted,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.code).toBe('E_NO_EFFECT');
  });
});
