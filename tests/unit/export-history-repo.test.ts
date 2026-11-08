// tests/unit/export-history-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { ExportHistoryRepo } from '@main/db/repos/export-history-repo';

let db: ReturnType<typeof Database>; let hist: ExportHistoryRepo;
beforeEach(() => { db = new Database(':memory:'); migrate(db); hist = new ExportHistoryRepo(db); });

describe('v18 + ExportHistoryRepo', () => {
  it('v18 落三表（PRAGMA 名册）', () => {
    expect(currentVersion(db)).toBeGreaterThanOrEqual(18);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(names).toContain('export_history');
    expect(names).toContain('publish_plans');
    expect(names).toContain('publish_staging');
  });
  it('ok 行：scope 以 JSON 往返，bytes/path 原样', () => {
    const r = hist.insert({ projectId: 'p1', format: 'epub', scope: { kind: 'volume', volumeId: 'v3' }, dest: 'project', path: '/x/书.epub', bytes: 1234, status: 'ok', error: null });
    expect(r.scope).toEqual({ kind: 'volume', volumeId: 'v3' });
    expect(hist.listRecent(10)).toHaveLength(1);
  });
  it('fail 行：path/bytes 为 null，error 真因保留', () => {
    hist.insert({ projectId: 'p1', format: 'zip', scope: { kind: 'book' }, dest: 'external', path: null, bytes: null, status: 'fail', error: 'EACCES 权限拒绝' });
    const row = hist.listRecent()[0];
    expect(row.status).toBe('fail');
    expect(row.error).toBe('EACCES 权限拒绝');
  });
  it('listRecent 新在前 + limit', () => {
    for (let i = 0; i < 3; i++) hist.insert({ projectId: 'p1', format: 'txt', scope: { kind: 'book' }, dest: 'project', path: `/a${i}.txt`, bytes: i, status: 'ok', error: null });
    const list = hist.listRecent(2);
    expect(list).toHaveLength(2);
    expect(list[0].bytes).toBe(2);
  });
});
