// tests/integration/pipeline-tools.test.ts
//
// P0 生成流水线 T4：构思/架构/写手三生成工具。
// ★ 依控制器裁决 R2：ToolRegistry 没有公共 invoke，测试直接调
//   pipelineHandlers(deps) 导出的三个 handler，断言与 brief 原稿一致。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { ToolRegistry } from '@main/tools/registry';
import { registerPipelineTools, pipelineHandlers, type PipelineDeps } from '@main/pipeline/tools';

const CONCEPT_JSON = JSON.stringify({ titles: ['雾隐山海', '玉佩三千年', '山海崩'], logline: '时间秘境换回一座城', synopsis: '梗概'.repeat(20), goldenFinger: '玉佩秘境 3000:3，代价是被遗忘', hooks: ['h1', 'h2', 'h3', 'h4', 'h5'] });
const OUTLINE_JSON = JSON.stringify({ volumes: [{ title: '第一卷', goal: '出山+灭世伏笔', targetChapters: 30 }], chapterPlan: [{ title: '雾中拾玉', hook: '玉佩里传出心跳声' }] });

function harness(fixed: string) {
  const db = new Database(':memory:'); migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
  const registry = new ToolRegistry({} as any);
  const deps: PipelineDeps = {
    db,
    llm: { chat: async () => ({ content: fixed, usage: { input: 10, output: 10 } }) },
    getCtx: async () => ({ genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 300000, premise: 'p', canon: [] }),
  };
  const ok = registerPipelineTools(registry, deps);
  return { db, pid, registry, ok, drafts: new DraftRepo(db), handlers: pipelineHandlers(deps) };
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
});
