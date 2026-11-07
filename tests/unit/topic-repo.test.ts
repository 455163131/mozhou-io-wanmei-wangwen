// tests/unit/topic-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { TopicRepo } from '@main/db/repos/topic-repo';

let db: ReturnType<typeof Database>;
let repo: TopicRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); repo = new TopicRepo(db); });

describe('v16 迁移 + TopicRepo', () => {
  it('v16 后 topics 表存在且 user_version>=16', () => {
    expect(currentVersion(db)).toBeGreaterThanOrEqual(16);
    const cols = db.prepare("PRAGMA table_info('topics')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['id', 'title', 'premise', 'status', 'project_id', 'source_card_id', 'created_at', 'updated_at']),
    );
  });
  it('insert 默认待立项；listByStatus 过滤；新在前', () => {
    const a = repo.insert({ title: 'A', premise: '一句话A' });
    repo.insert({ title: 'B', premise: '一句话B' });
    expect(a.status).toBe('待立项');
    expect(repo.listByStatus('待立项').map((t) => t.title)).toEqual(['B', 'A']);
  });
  it('状态机单向：待立项→已立项 ok；已立项→已放弃 抛 E_TOPIC_STATE', () => {
    const t = repo.insert({ title: 'C', premise: 'p' });
    expect(repo.setStatus(t.id, '已立项').status).toBe('已立项');
    expect(() => repo.setStatus(t.id, '已放弃')).toThrowError(/E_TOPIC_STATE|不允许/);
  });
  it('linkProject 写 project_id 并回读', () => {
    const t = repo.insert({ title: 'D', premise: 'p' });
    expect(repo.linkProject(t.id, 'proj-x').projectId).toBe('proj-x');
  });
});
