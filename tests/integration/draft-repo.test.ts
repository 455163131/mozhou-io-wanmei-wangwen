// tests/integration/draft-repo.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { ProjectRepo } from '@main/db/repos/chapter-repo';

function setup() {
  const db = new Database(':memory:');
  migrate(db);
  const projects = new ProjectRepo(db);
  const p = projects.create('测试书', '/tmp/t', 300000);
  return { db, drafts: new DraftRepo(db), pid: p.id };
}

describe('DraftRepo 草稿隔离', () => {
  it('insert 默认 pending，list 可按状态过滤', () => {
    const { drafts, pid } = setup();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '雾从江面上漫过来。' });
    expect(d.status).toBe('pending');
    expect(d.id).toMatch(/^dr-/);
    drafts.setStatus(d.id, 'adopted');
    expect(drafts.list(pid, 'pending')).toHaveLength(0);
    expect(drafts.list(pid, 'adopted')[0].content).toBe('雾从江面上漫过来。');
  });
  it('discarded 草稿保留可审计（不物理删除）', () => {
    const { drafts, pid } = setup();
    const d = drafts.insert({ projectId: pid, role: 'writer', kind: 'chapter', content: '弃稿' });
    drafts.setStatus(d.id, 'discarded');
    expect(drafts.get(d.id)?.status).toBe('discarded');
  });
});
