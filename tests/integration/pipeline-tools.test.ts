// tests/integration/pipeline-tools.test.ts
//
// P0 生成流水线 T4：构思/架构/写手三生成工具。
// ★ 依控制器裁决 R2：ToolRegistry 没有公共 invoke，测试直接调
//   pipelineHandlers(deps) 导出的三个 handler，断言与 brief 原稿一致。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { ToolRegistry } from '@main/tools/registry';
import { registerPipelineTools, pipelineHandlers, type PipelineDeps } from '@main/pipeline/tools';
import type { PromptOverlay } from '@main/pipeline/overlay';
import type { PipelineCtx } from '@shared/types/pipeline';

const CONCEPT_JSON = JSON.stringify({ titles: ['雾隐山海', '玉佩三千年', '山海崩'], logline: '时间秘境换回一座城', synopsis: '梗概'.repeat(20), goldenFinger: '玉佩秘境 3000:3，代价是被遗忘', hooks: ['h1', 'h2', 'h3', 'h4', 'h5'] });
const OUTLINE_JSON = JSON.stringify({ volumes: [{ title: '第一卷', goal: '出山+灭世伏笔', targetChapters: 30 }], chapterPlan: [{ title: '雾中拾玉', hook: '玉佩里传出心跳声' }] });

function harness(fixed: string) {
  const db = new Database(':memory:'); migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
  const registry = new ToolRegistry({} as any);
  const deps: PipelineDeps = {
    db,
    llm: { chat: async () => ({ content: fixed, usage: { input: 10, output: 10 } }) },
    getCtx: async () => ({ genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 300000, premise: 'p', canon: [], language: 'zh' }),
    chapters: new ChapterRepo(db),
  };
  const ok = registerPipelineTools(registry, deps);
  return { db, pid, registry, ok, drafts: new DraftRepo(db), handlers: pipelineHandlers(deps) };
}

/**
 * P1-B T2：harness 的队列版——llm.chat 按调用次序逐条消费 queue，
 * 用于「首稿 → 续写」多轮对话的降级续写测试（chapterWords=8000 → 阈值 4000 字）。
 * P1-B T4（minor-4）：增可选 ctxOverride（换 language/chapterWords 造 en 场景）
 * 与 messages()（回看每次 chat 收到的完整 messages，钉死续写指令原文）。
 */
function harnessQueue(queue: string[], ctxOverride: Partial<PipelineCtx> = {}) {
  const db = new Database(':memory:'); migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
  const q = [...queue];
  let lastMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  const deps: PipelineDeps = {
    db,
    llm: {
      chat: async (req) => {
        lastMessages = req.messages;
        return { content: q.shift() ?? '', usage: { input: 10, output: 10 } };
      },
    },
    getCtx: async () => ({ genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 300000, premise: 'p', canon: [], language: 'zh', ...ctxOverride }),
    chapters: new ChapterRepo(db),
  };
  return { db, pid, drafts: new DraftRepo(db), handlers: pipelineHandlers(deps), messages: () => lastMessages };
}

/**
 * P1-A T3：在 harness 基础上用闭包记录 llm.chat 收到的 messages，
 * captured() 返回 {system,user}——user 取第二条 message content（第一条是 system）。
 */
function harnessWithCapture(fixed: string) {
  const db = new Database(':memory:'); migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
  const registry = new ToolRegistry({} as any);
  let lastMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  const chapters = new ChapterRepo(db);
  const deps: PipelineDeps = {
    db,
    llm: {
      chat: async (req) => {
        lastMessages = req.messages;
        return { content: fixed, usage: { input: 10, output: 10 } };
      },
    },
    getCtx: async () => ({ genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 300000, premise: 'p', canon: [], language: 'zh' }),
    chapters,
  };
  const ok = registerPipelineTools(registry, deps);
  return {
    db, pid, registry, ok, chapters,
    drafts: new DraftRepo(db),
    handlers: pipelineHandlers(deps),
    captured: () => ({ system: lastMessages[0]?.content ?? '', user: lastMessages[1]?.content ?? '' }),
  };
}

describe('生成工具', () => {
  it('三道门：deps 不全不注册', () => {
    const registry = new ToolRegistry({} as any);
    expect(registerPipelineTools(registry, { db: null as any, llm: null as any, getCtx: null as any })).toBe(false);
  });
  it('pipeline_concept 校验 JSON 并入草稿区', async () => {
    const { pid, registry, drafts, handlers } = harness(CONCEPT_JSON);
    expect(registry.has('pipeline_concept')).toBe(true);
    const res = await handlers.concept({}, {} as any);
    expect(res.ok).toBe(true);
    expect(drafts.list(pid, 'pending')[0].kind).toBe('concept');
  });
  it('pipeline_concept 遇坏 JSON 返回可重试错误而非崩溃', async () => {
    const { handlers } = harness('不是 JSON {{{');
    const res = await handlers.concept({}, {} as any);
    expect(res.ok).toBe(false);
    expect(res.error?.retryable).toBe(true);
  });
  it('pipeline_outline 全书规划过 OutlineSchema 入草稿区', async () => {
    const { pid, registry, drafts, handlers } = harness(OUTLINE_JSON);
    expect(registry.has('pipeline_outline')).toBe(true);
    const res = await handlers.outline({}, {} as any);
    expect(res.ok).toBe(true);
    expect(drafts.list(pid, 'pending')[0].kind).toBe('outline');
  });
  it('pipeline_write_draft 正文入草稿区（不进正稿）', async () => {
    const { pid, registry, drafts, handlers } = harness('雾从江面上漫过来，先把渡口的石阶吞了半截。');
    expect(registry.has('pipeline_write_draft')).toBe(true);
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: '雾中拾玉', hook: '心跳声' } }, {} as any);
    expect(res.ok).toBe(true);
    const d = drafts.list(pid, 'pending')[0];
    expect(d.kind).toBe('chapter');
    expect(d.content).toContain('雾从江面上漫过来');
  });
  it('writeDraft 第2章起带上章结尾 260 字衔接桥', async () => {
    const { pid, handlers, chapters, captured } = harnessWithCapture('正文第二段内容。');
    const m1 = chapters.createChapter(pid, { title: '第1章' });
    chapters.updateBody(pid, m1.id, '甲'.repeat(100) + '尾声独特的句子结尾。', m1.rev);
    const res = await handlers.writeDraft({ chapterNo: 2, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(res.ok).toBe(true);
    const user = captured().user;
    expect(user).toContain('尾声独特的句子结尾。');
  });
  it('第1章不带 prevEnding（无上章）', async () => {
    const { handlers, captured } = harnessWithCapture('正文。');
    await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(captured().user).not.toContain('上章结尾');
  });
  it('字数不足一半触发一次续写并拼接', async () => {
    const { handlers, drafts, pid } = harnessQueue(['短稿。', '续写部分补足本章。']);
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(res.ok).toBe(true);
    expect(res.data.retries).toBe(1);
    expect(drafts.list(pid, 'pending')[0].content).toContain('续写部分补足本章。');
  });
  it('字数达标不续写 retries=0', async () => {
    const { handlers } = harnessQueue(['x'.repeat(9000)]);
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(res.data.retries).toBe(0);
  });

  // P1-B T4 minor-4：续写指令按语言取——en 用英文等价指令，zh 保持原文逐字。
  it('minor-4：en 书续写指令用英文等价指令（逐字）', async () => {
    // en 口径按词数：chapterWords=1000 → 阈值 500 词；首稿 6 词必触发续写
    const { handlers, messages } = harnessQueue(
      ['The fog rolled in over the river.', 'It kept rolling until dawn.'],
      { language: 'en', chapterWords: 1000 },
    );
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(res.ok).toBe(true);
    expect(res.data.retries).toBe(1);
    // 续写轮的 messages：system/user/assistant(首稿)/user(续写指令)
    const msgs = messages();
    expect(msgs[2].role).toBe('assistant');
    expect(msgs[3].role).toBe('user');
    expect(msgs[3].content).toBe('Under half the target length: continue from where it stops, no repetition.');
  });
  it('minor-4：zh 书续写指令保持原文逐字', async () => {
    const { handlers, messages } = harnessQueue(['短稿。', '续写部分补足本章。']);
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(res.data.retries).toBe(1);
    expect(messages()[3].content).toBe('字数不足目标一半，从中断处继续写完本章，不重复已写内容');
  });
});

/* ── P2-A T2：覆盖层接线 + 温度覆盖 ──────────────────────────────── */

/**
 * 带覆盖层的 harness：deps.getOverlay 固定返回给定 overlay（或 null = 默认态/垃圾文件态），
 * calls() 记录每次 llm.chat 收到的 temperature 与 system 原文——
 * 温度覆盖与 system 尾部追加两条链路都钉在这里。
 * withGetOverlay:false 造"未注入 getOverlay"的旧调用方形态。
 */
function harnessOverlay(overlay: PromptOverlay | null, queue: string[], opts: { withGetOverlay?: boolean } = {}) {
  const db = new Database(':memory:'); migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
  const q = [...queue];
  const calls: { temperature: number | undefined; system: string }[] = [];
  const deps: PipelineDeps = {
    db,
    llm: {
      chat: async (req) => {
        calls.push({ temperature: req.temperature, system: req.messages[0]?.content ?? '' });
        return { content: q.shift() ?? '', usage: { input: 10, output: 10 } };
      },
    },
    getCtx: async () => ({ genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 300000, premise: 'p', canon: [], language: 'zh' }),
    chapters: new ChapterRepo(db),
  };
  if (opts.withGetOverlay !== false) deps.getOverlay = () => overlay;
  return { db, pid, drafts: new DraftRepo(db), handlers: pipelineHandlers(deps), calls };
}

describe('覆盖层接线与温度覆盖（P2-A T2）', () => {
  it('构思：overlay 温度覆盖内置 1.05，附加要求逐字出现在 chat 的 system 尾部', async () => {
    const { handlers, calls } = harnessOverlay({ role: 'concept', temperature: 0.3, additional: '书名别带「穿越」二字。' }, [CONCEPT_JSON]);
    const res = await handlers.concept({}, {} as any);
    expect(res.ok).toBe(true);
    expect(calls[0].temperature).toBe(0.3);
    expect(calls[0].system.endsWith('\n\n【作者附加要求】\n书名别带「穿越」二字。')).toBe(true);
  });

  it('架构：0.7 → 覆盖生效；写手：0.9 → 首稿与降级续写两次 chat 同用覆盖值', async () => {
    const o = harnessOverlay({ role: 'architect', temperature: 0.2, additional: '每卷 25 章上下。' }, [OUTLINE_JSON]);
    const resO = await o.handlers.outline({}, {} as any);
    expect(resO.ok).toBe(true);
    expect(o.calls[0].temperature).toBe(0.2);
    expect(o.calls[0].system.endsWith('\n\n【作者附加要求】\n每卷 25 章上下。')).toBe(true);

    // 首稿 3 字（< 8000×0.5）触发续写一轮；system 两轮一致（书籍级稳定）
    const w = harnessOverlay({ role: 'writer', temperature: 0.4, additional: '多用短句。' }, ['短稿。', 'x'.repeat(9000)]);
    const resW = await w.handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(resW.ok).toBe(true);
    expect(w.calls.length).toBe(2);
    expect(w.calls[0].temperature).toBe(0.4);
    expect(w.calls[1].temperature).toBe(0.4);
    expect(w.calls[1].system).toBe(w.calls[0].system);
    expect(w.calls[0].system.endsWith('\n\n【作者附加要求】\n多用短句。')).toBe(true);
  });

  it('overlay=null（垃圾文件态回退）→ 内置三档温度照旧，system 不含【作者附加要求】', async () => {
    const c = harnessOverlay(null, [CONCEPT_JSON]);
    await c.handlers.concept({}, {} as any);
    expect(c.calls[0].temperature).toBe(1.05);
    expect(c.calls[0].system).not.toContain('【作者附加要求】');

    const o = harnessOverlay(null, [OUTLINE_JSON]);
    await o.handlers.outline({}, {} as any);
    expect(o.calls[0].temperature).toBe(0.7);

    const w = harnessOverlay(null, ['x'.repeat(9000)]);
    await w.handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(w.calls[0].temperature).toBe(0.9);
  });

  it('overlay 存在但温度留空 → 沿用内置；additional 空白 → system 零追加', async () => {
    const { handlers, calls } = harnessOverlay({ role: 'concept', temperature: null, additional: '  \n ' }, [CONCEPT_JSON]);
    await handlers.concept({}, {} as any);
    expect(calls[0].temperature).toBe(1.05);
    expect(calls[0].system).not.toContain('【作者附加要求】');
  });

  it('未注入 getOverlay（旧调用方零改动）→ 内置三档温度', async () => {
    const c = harnessOverlay(null, [CONCEPT_JSON], { withGetOverlay: false });
    await c.handlers.concept({}, {} as any);
    expect(c.calls[0].temperature).toBe(1.05);

    const w = harnessOverlay(null, ['x'.repeat(9000)], { withGetOverlay: false });
    await w.handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as any);
    expect(w.calls[0].temperature).toBe(0.9);
  });
});
