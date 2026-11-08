// tests/unit/topic-promote.test.ts —— 立项播 premise（PD-1）+ 生命周期（P2-C T6）
//
// brief Step 1 两用例逐字照写（R5：promoteTopic 的 projectId **必填**——上方
// Produces 行的 createProjectDir? 是笔误，测试码为准）；`await buildPipelineCtx(...)`
// 对同步返回值合法（R8：await 非 Promise 直接透传，照写）。
// 追加组：topic:list/promote/abandon 三个 IPC 业务函数的真库行为
// （promoteTopicIpc 的「先建/开项目再播 premise」与取消目录选择的 null 口径）。
// 红线：全程 :memory:，不碰真实 %APPDATA% 库；/tmp/* 只是 root_dir 字符串列值，
// 本文件链路无任何 fs 写入。
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { TopicRepo } from '@main/db/repos/topic-repo';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import { promoteTopic, promoteTopicIpc, listTopics, abandonTopic } from '@main/inspiration/topic-service';
import { buildPipelineCtx } from '@main/pipeline/ctx';
import { MzError } from '@shared/types/ipc';
import type { Project } from '@shared/types/project';

let db: ReturnType<typeof Database>; let topics: TopicRepo; let projects: ProjectRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); topics = new TopicRepo(db); projects = new ProjectRepo(db); });

describe('v17 premise 列 + 选题库立项', () => {
  it('v17 后 projects 有 premise 列', () => {
    expect(currentVersion(db)).toBeGreaterThanOrEqual(17);
    const cols = (db.prepare("PRAGMA table_info('projects')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('premise');
  });
  it('promote 建项目 + 播 premise + topic 置已立项链 project', async () => {
    const t = topics.insert({ title: '重生归来', premise: '被害者重生复仇' });
    const proj = projects.create('重生归来', '/tmp/x');
    const r = await promoteTopic({ topicId: t.id, repo: topics, projects, projectId: proj.id });
    expect(projects.getPremise(r.projectId)).toBe('被害者重生复仇');
    expect(topics.get(t.id)?.status).toBe('已立项');
    expect(topics.get(t.id)?.projectId).toBe(r.projectId);
  });
  it('ctx premise 优先取项目列，空列回退 adopted concept logline（向后兼容）', async () => {
    const proj = projects.create('书', '/tmp/y');
    projects.setPremise(proj.id, '显式一句话故事');
    const ctx = await buildPipelineCtx(db, proj.id);
    expect(ctx.premise).toBe('显式一句话故事');
  });
  it('abandon 置已放弃；已放弃为终态', () => {
    const t = topics.insert({ title: '弃', premise: 'p' });
    expect(topics.setStatus(t.id, '已放弃').status).toBe('已放弃');
    expect(() => topics.setStatus(t.id, '待立项')).toThrowError(/E_TOPIC_STATE|不允许/);
  });
});

/* ── 追加：IPC 业务函数层（topic-service）真库行为 ─────────────────── */

/** 同步抛错捕获：期望 fn 抛 MzError，不抛即测试失败（pipeline-ctx-canon 同款） */
function capture(fn: () => unknown): MzError {
  try {
    fn();
  } catch (e) {
    return e as MzError;
  }
  throw new Error('期望抛出 MzError，但调用正常返回');
}

describe('topic-service：生命周期 IPC 业务函数', () => {
  it('promoteTopicIpc：给 dir → 先 openProject 拿 projectId，再播 premise 置已立项', async () => {
    const t = topics.insert({ title: 'A', premise: '一句话A' });
    const opened: Project = projects.create('A', '/tmp/promote-a');
    const r = await promoteTopicIpc(
      { repo: topics, projects, openProject: async () => opened, pickDir: async () => null },
      { topicId: t.id, dir: '/tmp/promote-a' },
    );
    expect(r).not.toBeNull();
    expect(r!.projectId).toBe(opened.id);
    expect(projects.getPremise(opened.id)).toBe('一句话A');
    expect(topics.get(t.id)?.status).toBe('已立项');
    expect(topics.get(t.id)?.projectId).toBe(opened.id);
  });

  it('promoteTopicIpc：无 dir 且目录选择被取消 → 返回 null，选题原样不动（取消不是错误）', async () => {
    const t = topics.insert({ title: 'B', premise: 'q' });
    let openCalled = false;
    const r = await promoteTopicIpc(
      {
        repo: topics,
        projects,
        openProject: async () => {
          openCalled = true;
          throw new Error('取消选择就不该再开项目');
        },
        pickDir: async () => null,
      },
      { topicId: t.id },
    );
    expect(r).toBeNull();
    expect(openCalled).toBe(false);
    expect(topics.get(t.id)?.status).toBe('待立项');
  });

  it('promoteTopic：非待立项（已立项）再 promote → E_TOPIC_STATE 且 premise 不落半程（校验先行）', () => {
    const t = topics.insert({ title: 'C', premise: 'p' });
    topics.setStatus(t.id, '已立项');
    const proj = projects.create('C', '/tmp/c');
    expect(() => promoteTopic({ topicId: t.id, repo: topics, projects, projectId: proj.id })).toThrowError(
      /E_TOPIC_STATE|不允许/,
    );
    expect(projects.getPremise(proj.id)).toBe('');
  });

  it('listTopics：缺省全量 / status 过滤 / 非法 status → E_INVALID_ARGS', () => {
    topics.insert({ title: 'D', premise: 'p' });
    expect(listTopics(topics, {})).toHaveLength(1);
    expect(listTopics(topics, { status: '待立项' })).toHaveLength(1);
    expect(listTopics(topics, { status: '已放弃' })).toHaveLength(0);
    const e = capture(() => listTopics(topics, { status: '瞎写' }));
    expect(e.code).toBe('E_INVALID_ARGS');
  });

  it('abandonTopic：待立项 → 已放弃；非法入参与终态改判各抛各码', () => {
    const t = topics.insert({ title: 'E', premise: 'p' });
    expect(abandonTopic(topics, { topicId: t.id }).status).toBe('已放弃');
    expect(() => abandonTopic(topics, { topicId: t.id })).toThrowError(/不允许/);
    const e = capture(() => abandonTopic(topics, { topicId: '' }));
    expect(e.code).toBe('E_INVALID_ARGS');
  });

  it('setPremise/getPremise：字符串校验 + 缺省空串；非字符串拒写', () => {
    const proj = projects.create('F', '/tmp/f');
    expect(projects.getPremise(proj.id)).toBe('');
    projects.setPremise(proj.id, '一句话');
    expect(projects.getPremise(proj.id)).toBe('一句话');
    expect(() => projects.setPremise(proj.id, 123 as unknown as string)).toThrow();
    expect(() => projects.setPremise('proj-不存在', 'x')).toThrow();
    expect(projects.getPremise('proj-不存在')).toBe('');
  });
});
