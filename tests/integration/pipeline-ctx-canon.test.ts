// tests/integration/pipeline-ctx-canon.test.ts
//
// P1-A T2：buildPipelineCtx 抽成可测纯函数 + canon 真读进装配上下文；
// canon IPC 三通道 handler（list/add/remove）走真 SQLite 内存库。
// ★ T1 评审 minor-1 统一口径：canon 通道的 E_INVALID_ARGS 经 IPC 边界透传时
//   带 detail {retryable:false}——渲染层据此不画重试按钮。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ProjectRepo } from '@main/db/repos/chapter-repo';
import { CanonRepo } from '@main/db/repos/canon-repo';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { buildPipelineCtx } from '@main/pipeline/ctx';
import { listCanon, addCanon, removeCanon, type CanonIpcServices } from '@main/pipeline/canon-ipc';
import { MzError } from '@shared/types/ipc';

describe('buildPipelineCtx canon 真读', () => {
  it('canon 条目按录入序进入 ctx.canon', () => {
    const db = new Database(':memory:'); migrate(db);
    const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
    new CanonRepo(db).add(pid, '玉佩内时间流速 3000:3');
    const ctx = buildPipelineCtx(db, pid);
    expect(ctx.canon).toEqual(['玉佩内时间流速 3000:3']);
  });
  it('无 canon 时为空数组而非 undefined', () => {
    const db = new Database(':memory:'); migrate(db);
    const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
    expect(buildPipelineCtx(db, pid).canon).toEqual([]);
  });
});

/* ── P2-C T6 / PD-1：premise 派生新口径（v17 真列优先，空列回退 logline）── */

const CONCEPT_FOR_CTX = JSON.stringify({
  titles: ['雾隐山海', '玉佩三千年', '山海崩'],
  logline: '时间秘境换回一座城',
  synopsis: '梗概'.repeat(20),
  goldenFinger: '玉佩秘境 3000:3，代价是被遗忘',
  hooks: ['h1', 'h2', 'h3', 'h4', 'h5'],
});

describe('buildPipelineCtx premise 派生（PD-1 口径）', () => {
  it('premise 真列优先：setPremise 后 ctx.premise 取列值，哪怕已采纳构思另有 logline', () => {
    const db = new Database(':memory:'); migrate(db);
    const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
    const drafts = new DraftRepo(db);
    const d = drafts.insert({ projectId: pid, role: 'concept', kind: 'concept', content: CONCEPT_FOR_CTX });
    drafts.setStatus(d.id, 'adopted');
    new ProjectRepo(db).setPremise(pid, '显式一句话故事');
    expect(buildPipelineCtx(db, pid).premise).toBe('显式一句话故事');
  });
  it('premise 列空（旧书）→ 回退最新 adopted concept 的 logline：向后兼容逐字不变', () => {
    const db = new Database(':memory:'); migrate(db);
    const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
    const drafts = new DraftRepo(db);
    const d = drafts.insert({ projectId: pid, role: 'concept', kind: 'concept', content: CONCEPT_FOR_CTX });
    drafts.setStatus(d.id, 'adopted');
    expect(buildPipelineCtx(db, pid).premise).toBe('时间秘境换回一座城');
  });
  it('两源皆空 → 空串（占位诚实，不撒谎）', () => {
    const db = new Database(':memory:'); migrate(db);
    const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
    expect(buildPipelineCtx(db, pid).premise).toBe('');
  });
});

/* ── canon IPC 三通道 handler（真库） ──────────────────────────── */

function makeCanonEnv() {
  const db = new Database(':memory:'); migrate(db);
  const pid = new ProjectRepo(db).create('测试书', '/tmp/t', 300000).id;
  let current: string | null = pid;
  const services: CanonIpcServices = { db, currentProjectId: () => current };
  return {
    db,
    pid,
    services,
    canon: new CanonRepo(db),
    setCurrent: (v: string | null) => { current = v; },
  };
}

/** 同步抛错捕获：期望 fn 抛 MzError，不抛即测试失败 */
function capture(fn: () => unknown): MzError {
  try {
    fn();
  } catch (e) {
    return e as MzError;
  }
  throw new Error('期望抛出 MzError，但调用正常返回');
}

describe('canon IPC 三通道', () => {
  it('canon:list 按录入序返回真库条目', () => {
    const { services, pid, canon } = makeCanonEnv();
    canon.add(pid, '铁律一');
    canon.add(pid, '铁律二');
    expect(listCanon(services, { projectId: pid }).map((e) => e.text)).toEqual(['铁律一', '铁律二']);
  });

  it('canon:add 落库并返回 CanonEntry（trim 口径在 repo）', () => {
    const { services, pid, canon } = makeCanonEnv();
    const e = addCanon(services, { projectId: pid, text: '  玉佩内时间流速 3000:3  ' });
    expect(e.text).toBe('玉佩内时间流速 3000:3');
    expect(e.projectId).toBe(pid);
    expect(canon.list(pid).map((x) => x.id)).toEqual([e.id]);
  });

  it('canon:add 空文本 → E_INVALID_ARGS 透传且 detail.retryable=false（minor-1 口径）', () => {
    const { services, pid } = makeCanonEnv();
    const e = capture(() => addCanon(services, { projectId: pid, text: '   \n  ' }));
    expect(e).toBeInstanceOf(MzError);
    expect(e.code).toBe('E_INVALID_ARGS');
    expect(e.message).toContain('不能为空');
    expect((e.detail as { retryable: boolean }).retryable).toBe(false);
  });

  it('canon:add projectId 与当前打开项目不一致 → E_INVALID_ARGS 且 retryable:false', () => {
    const { services } = makeCanonEnv();
    const e = capture(() => addCanon(services, { projectId: 'proj_别的书', text: '铁律' }));
    expect(e).toBeInstanceOf(MzError);
    expect(e.code).toBe('E_INVALID_ARGS');
    expect((e.detail as { retryable: boolean }).retryable).toBe(false);
  });

  it('canon:list 未打开项目 → E_INVALID_ARGS 且 retryable:false（同口径）', () => {
    const { services, pid, setCurrent } = makeCanonEnv();
    setCurrent(null);
    const e = capture(() => listCanon(services, { projectId: pid }));
    expect(e).toBeInstanceOf(MzError);
    expect(e.code).toBe('E_INVALID_ARGS');
    expect((e.detail as { retryable: boolean }).retryable).toBe(false);
  });

  it('canon:remove 存在 → {ok:true} 且 list 不再含；不存在 → {ok:false} 不抛', () => {
    const { services, pid, canon } = makeCanonEnv();
    const e = canon.add(pid, '铁律一');
    expect(removeCanon(services, { projectId: pid, id: 'cn-不存在' })).toEqual({ ok: false });
    expect(removeCanon(services, { projectId: pid, id: e.id })).toEqual({ ok: true });
    expect(canon.list(pid)).toHaveLength(0);
  });

  it('canon:remove 不许跨书删除：projectId 不一致 → E_INVALID_ARGS', () => {
    const { services, pid, canon } = makeCanonEnv();
    const e = canon.add(pid, '铁律一');
    const err = capture(() => removeCanon(services, { projectId: 'proj_别的书', id: e.id }));
    expect(err).toBeInstanceOf(MzError);
    expect(err.code).toBe('E_INVALID_ARGS');
    expect(canon.list(pid)).toHaveLength(1); // 原书条目未被删
  });
});
