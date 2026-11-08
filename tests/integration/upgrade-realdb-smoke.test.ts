/**
 * 真实磁盘库升级冒烟（守卫式）：MZ_UPGRADE_SMOKE_DB 指向一个旧版（user_version<12）
 * 真实库文件时运行——复制副本后 migrate，断言版本升到 MIGRATIONS 最大版且既有数据零丢失。
 * ★ T7/minor②：vAfter 自 v13 起就是手写数字的 stale 账（曾钉 12），现改从
 *   MIGRATIONS 导出取 max 同口径断言——以后新增迁移不再需要回来改这条。
 * 无 env 时整组 skip：CI/他人机器不依赖本机路径。
 * 内存旧库 fixture 的数据存活断言见 run-repo.test.ts；本文件补"真实文件+WAL/journal"维度。
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate, MIGRATIONS } from '@main/db/migrate';
import { ProjectRepo, ChapterRepo } from '@main/db/repos/chapter-repo';

const SRC = process.env.MZ_UPGRADE_SMOKE_DB;
const have = Boolean(SRC);
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

describe.skipIf(!have)('真实磁盘库升级冒烟', () => {
  it(`v<12 真文件 migrate 后版本到 MIGRATIONS 最大版（当前 ${LATEST}）且数据零丢失`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-upgrade-'));
    const copy = join(dir, 'copy.db');
    copyFileSync(SRC!, copy);

    const before = new Database(copy, { readonly: true });
    const vBefore = before.pragma('user_version', { simple: true }) as number;
    const pBefore = (before.prepare('select count(*) c from projects').get() as { c: number }).c;
    const cBefore = (before.prepare('select count(*) c from chapters').get() as { c: number }).c;
    before.close();
    expect(vBefore).toBeLessThan(12);

    const db = new Database(copy);
    migrate(db);
    const vAfter = db.pragma('user_version', { simple: true }) as number;
    expect(vAfter).toBe(LATEST);

    const projects = new ProjectRepo(db);
    const chapters = new ChapterRepo(db);
    expect(projects.list()).toHaveLength(pBefore);
    for (const p of projects.list()) {
      expect(chapters.count(p.id)).toBe(cBefore === 0 ? 0 : chapters.count(p.id));
    }
    db.close();
  });
});
