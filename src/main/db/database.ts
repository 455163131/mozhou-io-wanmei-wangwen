/**
 * SQLite 初始化与迁移（架构 T10）。
 *
 * 用 better-sqlite3（同步 API）—— Agent 循环里读写频繁，同步省一层异步包装。
 * 不用 ORM：查询都很简单，且 schema 会变，裸 SQL + 薄 repo 层更透明。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrate';

export type MzDatabase = Database.Database;

let instance: MzDatabase | null = null;

export function openDatabase(dbPath: string): MzDatabase {
  if (instance) return instance;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // WAL：读写并发更好；崩溃安全性优于默认的 delete 模式
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 负数表示按 KB 计，给 SQLite 更大的缓存（架构 §1.9 的批量扫描需要）
  db.pragma('cache_size = -8000');
  db.pragma('temp_store = MEMORY');

  migrate(db);
  instance = db;
  return db;
}

export function getDatabase(): MzDatabase | null {
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}