// tests/integration/projects-gen-columns.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';

describe('projects 生成参数列', () => {
  it('v12 后存在 genre/platform/chapter_words', () => {
    const db = new Database(':memory:'); migrate(db);
    const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[];
    ['genre', 'platform', 'chapter_words'].forEach(c => expect(cols.some(x => x.name === c)).toBe(true));
  });
});
