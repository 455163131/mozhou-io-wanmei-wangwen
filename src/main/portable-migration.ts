/**
 * 便携版旧数据的一次性迁移（§4 第 14 条①）。
 *
 * 第 8 条把数据目录挪到 exe 旁边之后，**旧便携版用户**升级完打开的是空列表：
 * 书稿还在 `%APPDATA%\mozhou-agent` 里。这里在便携目录刚建好、数据库还没被打开之前，
 * 把那份旧数据整体搬过来一次。
 *
 * ★ 三条不许越过的线（口径来自 tests/unit/portable-migration.test.ts）：
 *   1. 目标已有 `mozhou.db` 就整批不动 —— U 盘和 %APPDATA% 可能各写过一份，
 *      谁新无从判断，覆盖等于删人稿子；
 *   2. 只认 `mozhou.db` 这一个信号 —— 旧目录只剩 Chromium 缓存说明从没建过项目，
 *      搬缓存过去只会污染新目录；
 *   3. 搬完**改名留档**而不是删除，且改名发生在复制成功之后 ——
 *      中途失败时原件必须还躺在原来的位置，可回退。
 *
 * 纯 fs 操作、路径全部由调用方注入，因此不碰 electron，可直接喂真目录断言真结果。
 * 装配点只有一个：`index.ts` 在 `app.setPath('userData', …)` 之前调一次。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DB_FILENAME } from './data-dir';

/** 迁移完成后写在目标目录里的来源说明文件名 */
export const MIGRATION_NOTE = 'MIGRATED-FROM.txt';

export type MigrationStatus = 'migrated' | 'skipped' | 'failed';

export type MigrationReason = 'no-legacy' | 'no-manuscript' | 'target-busy' | 'same-dir';

export interface MigrationOutcome {
  status: MigrationStatus;
  /** skipped 时说明是哪一条闸住的 */
  reason?: MigrationReason;
  /** migrated 时搬了多少个文件 */
  copied?: number;
  /** migrated 时旧目录被改名成了什么（留档不删除） */
  archivedTo?: string;
  error?: string;
}

export interface MigrationInput {
  /** 覆盖前的默认 userData，通常是 `%APPDATA%\mozhou-agent` */
  legacyDir: string;
  /** exe 旁边的便携目录 */
  targetDir: string;
  /** 注入时间，便于测试断言归档名；默认取当前时间 */
  now?: () => Date;
}

/** 递归列出目录下所有文件的相对路径（不含目录本身） */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
    // 其它类型（符号链接、管道、设备）不搬：便携包的数据目录里不该有这些
  }
  return out;
}

function isSameDir(a: string, b: string): boolean {
  const na = resolve(a);
  const nb = resolve(b);
  // Windows 路径大小写不敏感；POSIX 上 /A 与 /a 是两个目录，不能一起折
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function stamp(date: Date): string {
  const n = (v: number, w = 2): string => String(v).padStart(w, '0');
  return `${n(date.getFullYear(), 4)}${n(date.getMonth() + 1)}${n(date.getDate())}`
    + `${n(date.getHours())}${n(date.getMinutes())}${n(date.getSeconds())}`;
}

export function migrateLegacyUserData(input: MigrationInput): MigrationOutcome {
  const { legacyDir, targetDir } = input;
  const now = input.now ?? ((): Date => new Date());

  if (!existsSync(legacyDir)) return { status: 'skipped', reason: 'no-legacy' };
  // 同目录闸必须排在 target-busy 之前：否则自己判自己"已有库"，理由会说反
  if (isSameDir(legacyDir, targetDir)) return { status: 'skipped', reason: 'same-dir' };
  if (!existsSync(join(legacyDir, DB_FILENAME))) return { status: 'skipped', reason: 'no-manuscript' };
  if (existsSync(join(targetDir, DB_FILENAME))) return { status: 'skipped', reason: 'target-busy' };

  try {
    const files = listFiles(legacyDir);
    for (const rel of files) {
      const to = join(targetDir, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(legacyDir, rel), to);
    }

    let archived = `${legacyDir}-migrated-${stamp(now())}`;
    let n = 2;
    while (existsSync(archived)) archived = `${legacyDir}-migrated-${stamp(now())}-${n++}`;
    renameSync(legacyDir, archived);

    writeFileSync(
      join(targetDir, MIGRATION_NOTE),
      `本目录由便携版首次启动时的一次性迁移建立。\n`
        + `来源：${legacyDir}\n`
        + `时间：${now().toISOString()}\n`
        + `共 ${files.length} 个文件。\n`
        + `旧目录已改名为 ${basename(archived)} 留在原地（没有删除），确认无误后可自行清理。\n`,
      'utf8',
    );

    return { status: 'migrated', copied: files.length, archivedTo: archived };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
