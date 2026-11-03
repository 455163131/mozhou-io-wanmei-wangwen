// tests/integration/p0-acceptance.test.ts
//
// P0 验收（T8）：空库 → 构思 → 卷纲章纲 → 第一章草稿 → 人工采纳入正稿，
// 全链路一条测试钉死。
// ★ 依控制器裁决 R2：ToolRegistry 没有公共 invoke，测试直接调
//   pipelineHandlers(deps) 导出的三个 handler（与注册进 registry 的是同一份
//   实现，见 src/main/pipeline/tools.ts 头注释），断言语义与 brief 原稿一致。
// ★ 终评修复轮（C1）：采纳段走**真路径**——pipeline/ipc 的 adoptDraft(draftId)，
//   services 组装参照 pipeline-ipc-sentinel.test.ts B 组；不再手工模拟
//   setStatus+createChapter+updateBody。空库上 writeDraft 草稿 chapterId="1"
//   指向不存在的章，由 writeCanon 的 R14 回退分支建章后写入。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ProjectRepo, ChapterRepo } from '@main/db/repos/chapter-repo';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { pipelineHandlers, type PipelineDeps } from '@main/pipeline/tools';
import { adoptDraft, type PipelineIpcServices } from '@main/pipeline/ipc';
// P1-A T4：canon/prevEnding 进装配 user 的验收走真路径——
// addCanon 用 canon-ipc 的 handler（GenView canon 卡同一条 IPC 通道的实现侧），
// getCtx 用 buildPipelineCtx（canon 从 CanonRepo 真读，不再是 stub 数组）。
import { addCanon, type CanonIpcServices } from '@main/pipeline/canon-ipc';
import { buildPipelineCtx } from '@main/pipeline/ctx';

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

    // 采纳走真路径：IPC adoptDraft（正文入正稿唯一入口，C1 修复后空库可采纳）
    const services = {
      db,
      chapterRepo: chapters,
      push: { send: (_ch: string, _p: Record<string, unknown>) => {} },
      backup: { noteEdit: () => {} },
      currentProjectId: () => pid,
      pipelineHandlers: () => h,
    } as unknown as PipelineIpcServices;
    const draftId = w.data.draftId as string;
    const r = await adoptDraft(services, draftId);             // 人工定稿主权
    expect(r.chapterId).toBeTruthy();
    expect(chapters.getBody(pid, r.chapterId!)).toContain('雾从江面上漫过来');
    expect(drafts.get(draftId)!.status).toBe('adopted');
    expect(chapters.count(pid)).toBe(1);
  });

  // P1-A T4 验收扩展（既有用例不动，本用例独立起库）：
  // canon/prevEnding 必须真进 writeDraft 的装配 user 消息。
  // captured 闭包构造口径同 pipeline-tools.test.ts 的 harnessWithCapture——
  // 假 llm 记录每次 chat 收到的 messages，captured() 返回 {system,user}
  //（user 取第二条 message content，第一条是 system）。
  it('canon add 一条后 writeDraft 的 user 含该 canon 文本；第2章 user 含第1章结尾尾句', async () => {
    const db = new Database(':memory:'); migrate(db);
    const projects = new ProjectRepo(db); const chapters = new ChapterRepo(db);
    const pid = projects.create('雾隐山海', '/tmp/moshu', 1200000).id;

    const queue = [FIX.draft, '第二章正文：雾散之后的渡口。'];
    let lastMessages: { role: 'system' | 'user'; content: string }[] = [];
    const captured = (): { system: string; user: string } => ({
      system: lastMessages[0]?.content ?? '',
      user: lastMessages[1]?.content ?? '',
    });
    const deps: PipelineDeps = {
      db,
      llm: {
        chat: async (req) => {
          lastMessages = req.messages;
          return { content: queue.shift()!, usage: { input: 1, output: 1 } };
        },
      },
      // canon 真来源：getCtx 走 buildPipelineCtx（CanonRepo.list 真读，非 stub）
      getCtx: async (projectId) => buildPipelineCtx(db, projectId),
      chapters,
    };
    const h = pipelineHandlers(deps);

    // canon add 一条：走 canon-ipc 真 handler（GenView canon 卡的同一实现侧）
    const canonServices: CanonIpcServices = { db, currentProjectId: () => pid };
    addCanon(canonServices, { projectId: pid, text: '玉佩内时间流速 3000:3' });

    // ① canon add 一条后 writeDraft：装配 user 含该 canon 文本（保护层进 user）
    const w1 = await h.writeDraft({ chapterNo: 1, planItem: { title: '雾中拾玉', hook: '玉佩里传出心跳声' } }, {} as any);
    expect(w1.ok).toBe(true);
    expect(captured().user).toContain('玉佩内时间流速 3000:3');

    // 第1章草稿采纳入正稿（真路径 adoptDraft），第2章才有上章结尾可衔接
    const services = {
      db,
      chapterRepo: chapters,
      push: { send: (_ch: string, _p: Record<string, unknown>) => {} },
      backup: { noteEdit: () => {} },
      currentProjectId: () => pid,
      pipelineHandlers: () => h,
    } as unknown as PipelineIpcServices;
    const r1 = await adoptDraft(services, w1.data.draftId as string);
    expect(r1.chapterId).toBeTruthy();

    // ② 第2章 writeDraft：装配 user 含第1章结尾尾句（prevEnding 衔接桥）
    const w2 = await h.writeDraft({ chapterNo: 2, planItem: { title: '雾散渡口', hook: '石阶下露出一角船帆' } }, {} as any);
    expect(w2.ok).toBe(true);
    expect(captured().user).toContain('林渡提着灯在雾里走了半晌。');
  });
});
