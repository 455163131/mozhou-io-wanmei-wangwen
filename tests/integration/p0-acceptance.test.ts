// tests/integration/p0-acceptance.test.ts
//
// P0 验收（T8）：空库 → 构思 → 卷纲章纲 → 第一章草稿 → 人工采纳入正稿，
// 全链路一条测试钉死。
// ★ 依控制器裁决 R2：ToolRegistry 没有公共 invoke，测试直接调
//   pipelineHandlers(deps) 导出的三个 handler（与注册进 registry 的是同一份
//   实现，见 src/main/pipeline/tools.ts 头注释），断言语义与 brief 原稿一致。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ProjectRepo, ChapterRepo } from '@main/db/repos/chapter-repo';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { pipelineHandlers, type PipelineDeps } from '@main/pipeline/tools';

const FIX = {
  concept: JSON.stringify({ titles: ['雾隐山海', '玉佩三千年', '山海崩'], logline: 'l', synopsis: 's'.repeat(30), goldenFinger: 'g', hooks: ['h1', 'h2', 'h3', 'h4', 'h5'] }),
  outline: JSON.stringify({ volumes: [{ title: '第一卷', goal: 'g', targetChapters: 30 }], chapterPlan: [{ title: '雾中拾玉', hook: '玉佩里传出心跳声' }] }),
  draft: '雾从江面上漫过来，先把渡口的石阶吞了半截。林渡提着灯在雾里走了半晌。',
};

describe('P0 验收：空库到第一章草稿全流程', () => {
  it('concept → outline → draft → adopt 全链路', async () => {
    const db = new Database(':memory:'); migrate(db);
    const projects = new ProjectRepo(db); const chapters = new ChapterRepo(db); const drafts = new DraftRepo(db);
    const pid = projects.create('雾隐山海', '/tmp/moshu', 1200000).id;
    expect(chapters.count(pid)).toBe(0);                       // 空库

    const queue = [FIX.concept, FIX.outline, FIX.draft];
    const deps: PipelineDeps = {
      db,
      llm: { chat: async () => ({ content: queue.shift()!, usage: { input: 1, output: 1 } }) },
      getCtx: async () => ({ genre: '古风玄幻', platform: '番茄', chapterWords: 8000, targetWords: 1200000, premise: '少年拾玉佩', canon: ['玉佩内时间流速 3000:3'] }),
    };
    const h = pipelineHandlers(deps);

    const c = await h.concept({}, {} as any);
    const o = await h.outline({}, {} as any);
    const w = await h.writeDraft({ chapterNo: 1, planItem: { title: '雾中拾玉', hook: '玉佩里传出心跳声' } }, {} as any);
    expect([c.ok, o.ok, w.ok]).toEqual([true, true, true]);
    expect(chapters.count(pid)).toBe(0);                       // 草稿隔离：正稿仍空

    const draftId = w.data.draftId as string;
    drafts.setStatus(draftId, 'adopted');                      // 人工定稿主权（IPC adopt 内部同路径）
    const meta = chapters.createChapter(pid, { title: '雾中拾玉' });
    chapters.updateBody(pid, meta.id, drafts.get(draftId)!.content, meta.rev);
    expect(chapters.getBody(pid, meta.id)).toContain('雾从江面上漫过来');
    expect(chapters.count(pid)).toBe(1);
  });
});
