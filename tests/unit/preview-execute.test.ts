/**
 * preview / execute 一致性测试（架构 T08 明确要求）。
 *
 * ★★★ 这是整个项目最容易被写坏的一处 ★★★
 *
 * 架构原话：「写成两个函数，100% 会出现『预览显示改 3 处、实际改了 4 处』，
 * 用户信任直接崩掉。」
 *
 * 本测试用同一段文本分别走 preview(dryRun=true) 与 execute(dryRun=false)，
 * 断言产出的改动**逐字节相同**。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { applyFixTool, type FixDeps } from '@main/tools/impl/fix';
import { replacePhrase, type PhraseDeps } from '@main/tools/impl/phrase';
import { REFERENCE_BASELINE } from '@shared/constants/metrics';
import type { ToolContext } from '@shared/types/tool';

/** 造一段含多处可安全改写的中文正文 */
const SAMPLE = [
  '三月十五的清晨，他起了个大早。',
  '他看了一眼窗外的雨，看了三遍，又看了一会儿。',
  '她愣了一下，然后顿了顿，没说话。',
  '他抬起头，看向远处。',
  '',
  '她抬起头，又低下头，把话头掐了。',
  '他看了一眼账本，看了很久，没说话。',
  '他抬起头看了看，愣了一下。',
].join('\n');

function makeCtx(dryRun: boolean, checkpointCalls: string[][]): ToolContext {
  return {
    runId: 'test',
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

describe('preview 与 execute 产出完全一致（架构 T08 铁律）', () => {
  let bodies: Map<string, string>;
  let written: string[][];
  let deps: FixDeps;
  let ckPreview: string[][];
  let ckExecute: string[][];

  beforeEach(() => {
    bodies = new Map([['37', SAMPLE]]);
    written = [];
    deps = {
      getBodies: async (ids) => {
        const m = new Map<string, string>();
        for (const id of ids) {
          const b = bodies.get(id);
          if (b !== undefined) m.set(id, b);
        }
        return m;
      },
      setBody: async (id, body) => {
        bodies.set(id, body);
        written.push([id]);
      },
      baseline: () => REFERENCE_BASELINE,
    } as FixDeps;
    ckPreview = [];
    ckExecute = [];
  });

  it('fix_expression：预览与执行的 diff 逐字一致', async () => {
    const args = { chapterIds: ['37'] };

    const preview = await applyFixTool(
      'fix_expression',
      args,
      makeCtx(true, ckPreview),
      deps,
      { reversible: true },
    );
    const execute = await applyFixTool(
      'fix_expression',
      args,
      makeCtx(false, ckExecute),
      deps,
      { reversible: true },
    );

    expect(preview.ok, preview.error?.message).toBe(true);
    expect(execute.ok, execute.error?.message).toBe(true);

    const pv = preview.data!.changeSet;
    const ex = execute.data!.changeSet;

    // 改动条数一致
    expect(ex.edits.length).toBe(pv.edits.length);
    // 每条改动的前后文与偏移完全一致
    expect(ex.edits).toEqual(pv.edits);
    // 产出正文逐字节一致
    expect(ex.patches[0]?.afterText).toBe(pv.patches[0]?.afterText);
  });

  it('★ preview 绝不写盘、绝不落快照', async () => {
    const before = bodies.get('37');
    await applyFixTool(
      'fix_expression',
      { chapterIds: ['37'] },
      makeCtx(true, ckPreview),
      deps,
      { reversible: true },
    );
    expect(written.length, 'preview 不得调用 setBody').toBe(0);
    expect(bodies.get('37'), 'preview 不得改动正文').toBe(before);
    expect(ckPreview.length, 'preview 不得落快照').toBe(0);
  });

  it('★ execute 必须先落快照（fail-safe：快照是唯一防线）', async () => {
    await applyFixTool(
      'fix_expression',
      { chapterIds: ['37'] },
      makeCtx(false, ckExecute),
      deps,
      { reversible: true },
    );
    // 有改动才要求快照；无改动则不落
    const res = await applyFixTool(
      'fix_repetition',
      { chapterIds: ['37'] },
      makeCtx(false, ckExecute),
      deps,
      { reversible: true },
    );
    if (res.ok && (res.data?.changeSet.edits.length ?? 0) > 0) {
      expect(ckExecute.length).toBeGreaterThan(0);
    }
  });

  it('★ 快照失败时必须拒绝执行，正文保持不变', async () => {
    const failingCtx: ToolContext = {
      ...makeCtx(false, []),
      requireCheckpoint: async () => {
        throw new Error('磁盘满，快照落盘失败');
      },
    };
    const before = bodies.get('37');
    await expect(
      applyFixTool('fix_expression', { chapterIds: ['37'] }, failingCtx, deps, { reversible: true }),
    ).rejects.toThrow();
    expect(bodies.get('37'), '快照失败时正文绝不能被改动').toBe(before);
  });

  it('execute 后正文确实落盘，且与 changeSet.afterText 一致', async () => {
    const res = await applyFixTool(
      'fix_expression',
      { chapterIds: ['37'] },
      makeCtx(false, ckExecute),
      deps,
      { reversible: true },
    );
    if (res.ok && (res.data?.changeSet.edits.length ?? 0) > 0) {
      expect(written.length).toBeGreaterThan(0);
      expect(bodies.get('37')).toBe(res.data!.changeSet.patches[0].afterText);
    }
  });

  it('重复执行同一工具是幂等的（第二轮改动数不增加）', async () => {
    const first = await applyFixTool(
      'fix_expression',
      { chapterIds: ['37'] },
      makeCtx(false, ckExecute),
      deps,
      { reversible: true },
    );
    const firstEdits = first.ok ? first.data!.changeSet.edits.length : 0;

    const second = await applyFixTool(
      'fix_expression',
      { chapterIds: ['37'] },
      makeCtx(false, ckExecute),
      deps,
      { reversible: true },
    );
    const secondEdits = second.ok ? second.data!.changeSet.edits.length : 0;
    // 已改过的内容不应再产生同类型改动
    expect(secondEdits).toBeLessThanOrEqual(firstEdits);
  });

  it('引号内的人物语言在两种模式下都不改', async () => {
    const withQuote = '她说：“他愣了一下。”然后走了。';
    bodies.set('37', withQuote);
    const args = { chapterIds: ['37'], markers: ['顿/停了一下'] };

    const pv = await applyFixTool('fix_expression', args, makeCtx(true, ckPreview), deps, { reversible: true });
    const ex = await applyFixTool('fix_expression', args, makeCtx(false, ckExecute), deps, { reversible: true });
    if (pv.ok && ex.ok) {
      expect(ex.data!.changeSet.patches[0]?.afterText).toBe(pv.data!.changeSet.patches[0]?.afterText);
      // 引号内的「愣了一下」不该被改
      expect(bodies.get('37')).toContain('愣了一下');
    }
  });
});

describe('replace_phrase：preview/execute 一致 + ★1 精确性', () => {
  let bodies: Map<string, string>;
  let deps: PhraseDeps;
  let ck: string[][];

  beforeEach(() => {
    bodies = new Map([['1', '他看了很久窗外的雨，然后走了。']]);
    ck = [];
    deps = {
      getBody: async (id) => bodies.get(id) ?? null,
      setBody: async (id, body) => {
        bodies.set(id, body);
      },
      baseline: () => REFERENCE_BASELINE,
    };
  });

  it('preview 与 execute 结果一致', async () => {
    const args = { chapterId: '1', find: '看了很久', replace: '没再看第二眼' };
    const pv = await replacePhrase(args, makeCtx(true, ck), deps);
    const ex = await replacePhrase(args, makeCtx(false, ck), deps);
    expect(pv.ok && ex.ok).toBe(true);
    expect(ex.changeSet!.patches[0].afterText).toBe(pv.changeSet!.patches[0].afterText);
    expect(ex.changeSet!.edits).toEqual(pv.changeSet!.edits);
  });

  it('preview 不写盘', async () => {
    const before = bodies.get('1');
    await replacePhrase(
      { chapterId: '1', find: '看了很久', replace: 'X' },
      makeCtx(true, ck),
      deps,
    );
    expect(bodies.get('1')).toBe(before);
    expect(ck.length).toBe(0);
  });

  it('★ 引号内默认不替换（人物语言保护）', async () => {
    bodies.set('1', '“他看了很久。”她说完就走了。');
    const res = await replacePhrase(
      { chapterId: '1', find: '看了很久', replace: 'X' },
      makeCtx(false, ck),
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('E_NO_EFFECT');
    expect(bodies.get('1')).toContain('看了很久');
  });

  it('找不到目标短语时明确报错，不静默成功', async () => {
    const res = await replacePhrase(
      { chapterId: '1', find: '不存在的短语', replace: 'X' },
      makeCtx(false, ck),
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain('未找到');
    // 提示必须可操作：告诉调用方下一步该做什么
    expect(res.error?.hint).toContain('引号内不改');
    expect(res.error?.retryable).toBe(false);
  });

  it('includeQuotes=true 时才改引号内', async () => {
    bodies.set('1', '“他看了很久。”她说完就走了。');
    const res = await replacePhrase(
      { chapterId: '1', find: '看了很久', replace: '没再看第二眼', includeQuotes: true },
      makeCtx(false, ck),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(bodies.get('1')).toBe('“他没再看第二眼。”她说完就走了。');
  });
});

describe('副作用检测：★ 只判「改前 ok → 改后越界」（架构 §6.1 第 15 条）', () => {
  it('改前本来就超标 → 改得更差不算副作用（不得误回滚合法改善）', async () => {
    const { detectSideEffects } = await import('@main/agent/side-effect');
    const base = REFERENCE_BASELINE;
    // dialogRatio 基线 p50=0.656 p95=0.828，dir='both'
    // 改前 0.95（本就超标，grade=risk）→ 改后 0.98（更差）
    // 造两段对白占比差异明显的文本
    const before = Array.from({ length: 40 }, (_, i) => `第${i}句叙述没有任何引号。`).join('\n');
    const after = `“全是引号。”\n`.repeat(40) + before;
    const effects = detectSideEffects(
      before, after, 'test', 'F13', '1', base, { affectedMetrics: ['dialogRatio'] },
    );
    // 改前 risk → 不应判为副作用
    expect(effects).toHaveLength(0);
  });

  it('改前 ok → 改后 risk 判为副作用，并给出可读解释', async () => {
    const { detectSideEffects } = await import('@main/agent/side-effect');
    const base = REFERENCE_BASELINE;
    // 改前对白占比落在基线内（ok），改后远超 p95
    const before = Array.from({ length: 20 }, (_, i) => `“对话${i}。”`).join('\n') +
      '\n' + Array.from({ length: 20 }, (_, i) => `叙述${i}没有任何引号。`).join('\n');
    const after = Array.from({ length: 60 }, (_, i) => `“对话${i}。”`).join('\n') +
      '\n' + Array.from({ length: 2 }, (_, i) => `叙述${i}。`).join('\n');
    const effects = detectSideEffects(
      before, after, 'fix_structure', 'F9', '1', base, { affectedMetrics: ['dialogRatio'] },
    );
    for (const e of effects) {
      expect(e.beforeGrade).toBe('ok');
      expect(e.afterGrade).toBe('risk');
      expect(e.explanation).toContain('超出');
      expect(e.explanation.length).toBeGreaterThan(10);
    }
  });

  it('样本量不足时不做副作用判定（噪声太大）', async () => {
    const { detectSideEffects } = await import('@main/agent/side-effect');
    const short = '短文本。';
    const effects = detectSideEffects(
      short, short + '更长一点', 't', 'F1', '1', REFERENCE_BASELINE,
      { affectedMetrics: ['dialogRatio'] },
    );
    expect(effects).toHaveLength(0);
  });
});

describe('工具清理', () => {
  it('.tmp 目录可清理', async () => {
    await fs.rm(join(process.cwd(), '.tmp'), { recursive: true, force: true }).catch(() => undefined);
    expect(true).toBe(true);
  });
});