/**
 * 便携版旧数据的一次性迁移 —— §4 第 14 条①，老板 2026-10-09 定夺要做。
 *
 * 缺陷形态：第 8 条把数据目录改到 exe 旁边之后，**已经在用旧便携版的用户**
 * 升级完双击新 exe，看到的是空项目列表 —— 书稿还在上一台机器的
 * `%APPDATA%\mozhou-agent` 里，新目录里只有一个刚建出来的空库。
 * 2026-10-09 真机实测确认过这个现象（新 exe 首启只建 `mozhou-data\mozhou.db`，
 * 不会去 %APPDATA% 认旧库）。
 *
 * 迁移的三条硬口径（每条都对应一个"宁可不做也不能做错"的情形）：
 *   1. **目标已有库就整批不动**：U 盘可能在两台机器上各写过一次，
 *      哪边新无从判断，覆盖等于删人稿子。
 *   2. **只认 mozhou.db 这个信号**：旧目录里可能只剩 Chromium 缓存
 *      （从没建过项目），把缓存搬过去毫无意义还会污染新目录。
 *   3. **搬完改名而不是删**：原件留在原地可回退；复制中途失败时更不许动旧目录。
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyUserData } from '@main/portable-migration';

const roots: string[] = [];

/** 造一个临时根目录，返回里面 legacy / target 两条路径 */
function sandbox(): { legacy: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'mz-mig-'));
  roots.push(root);
  return { legacy: join(root, 'appdata', 'mozhou-agent'), target: join(root, 'usb', 'mozhou-data') };
}

function touch(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('A. 什么情况下必须整批不动', () => {
  it('旧目录根本不存在 → skipped/no-legacy，且不凭空造目录', () => {
    const { legacy, target } = sandbox();
    const got = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });

    expect(got.status).toBe('skipped');
    expect(got.reason).toBe('no-legacy');
    expect(existsSync(legacy)).toBe(false);
  });

  it('★ 旧目录只有缓存没有 mozhou.db → skipped/no-manuscript（从没建过项目的人不该被"迁移"）', () => {
    const { legacy, target } = sandbox();
    touch(join(legacy, 'Cache', 'data_0'), 'cache-bytes');
    touch(join(legacy, 'Local Storage', 'leveldb', 'CURRENT'), '16');

    const got = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });

    expect(got.status).toBe('skipped');
    expect(got.reason).toBe('no-manuscript');
    expect(existsSync(join(target, 'Cache', 'data_0'))).toBe(false);
  });

  it('★ 目标目录里已经有库 → skipped/target-busy，两边的文件一个都不许变', () => {
    // U 盘在 A 机器写过、%APPDATA% 在 B 机器留着一份，谁新无从判断。
    // 这种时候唯一安全的动作是什么都不做，让用户自己挑。
    const { legacy, target } = sandbox();
    touch(join(legacy, 'mozhou.db'), 'OLD-BITS');
    touch(join(target, 'mozhou.db'), 'NEW-BITS');

    const got = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });

    expect(got.status).toBe('skipped');
    expect(got.reason).toBe('target-busy');
    expect(readFileSync(join(target, 'mozhou.db'), 'utf8')).toBe('NEW-BITS');
    expect(readFileSync(join(legacy, 'mozhou.db'), 'utf8')).toBe('OLD-BITS');
    expect(existsSync(legacy)).toBe(true);
  });

  it('legacy 与 target 是同一个目录 → skipped/same-dir（否则等于把自己搬走再改名）', () => {
    const { legacy } = sandbox();
    touch(join(legacy, 'mozhou.db'), 'bits');

    const got = migrateLegacyUserData({ legacyDir: legacy, targetDir: legacy });

    expect(got.status).toBe('skipped');
    expect(got.reason).toBe('same-dir');
    expect(existsSync(join(legacy, 'mozhou.db'))).toBe(true);
  });

  it('幂等：迁移成功后再跑一次，什么都不会发生', () => {
    const { legacy, target } = sandbox();
    touch(join(legacy, 'mozhou.db'), 'db-bytes');

    const first = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });
    expect(first.status).toBe('migrated');

    const second = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });
    expect(second.status).toBe('skipped');
    expect(readFileSync(join(target, 'mozhou.db'), 'utf8')).toBe('db-bytes');
  });
});

describe('B. 正常迁移搬了什么', () => {
  it('整棵目录树逐文件按字节落到 exe 旁边（含子目录与原生库文件）', () => {
    const { legacy, target } = sandbox();
    touch(join(legacy, 'mozhou.db'), 'db-bytes');
    touch(join(legacy, 'mozhou.db-wal'), 'wal-bytes');
    touch(join(legacy, 'llm-credentials.bin'), 'encrypted-bits');
    touch(join(legacy, 'backups', '2026-10-08', 'book.zip'), 'zip-bytes');
    touch(join(legacy, 'chapters', '第1章.md'), '# 第一章\n');

    const got = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });

    expect(got.status).toBe('migrated');
    for (const rel of [
      'mozhou.db',
      join('mozhou.db-wal'),
      join('llm-credentials.bin'),
      join('backups', '2026-10-08', 'book.zip'),
      join('chapters', '第1章.md'),
    ]) {
      expect(existsSync(join(target, rel)), `缺 ${rel}`).toBe(true);
    }
    expect(readFileSync(join(target, 'mozhou.db'), 'utf8')).toBe('db-bytes');
    expect(readFileSync(join(target, 'chapters', '第1章.md'), 'utf8')).toBe('# 第一章\n');
    expect(got.copied).toBe(5);
  });

  it('★ 搬完旧目录改名留档，而不是原地删除', () => {
    const { legacy, target } = sandbox();
    touch(join(legacy, 'mozhou.db'), 'db-bytes');

    const got = migrateLegacyUserData({
      legacyDir: legacy,
      targetDir: target,
      now: () => new Date('2026-10-09T06:40:00'),
    });

    expect(got.status).toBe('migrated');
    expect(existsSync(legacy)).toBe(false);
    expect(got.archivedTo).toBeTruthy();
    expect(existsSync(got.archivedTo as string)).toBe(true);
    // 归档名里带时间，且就在原来的父目录下，用户自己找得回来
    expect(got.archivedTo).toContain('20261009');
    expect(join(got.archivedTo as string, '..')).toBe(join(legacy, '..'));
  });

  it('归档位已被占用 → 加后缀另开一份，绝不覆盖上一次的归档', () => {
    const { legacy, target } = sandbox();
    const now = () => new Date('2026-10-09T06:40:00');
    touch(join(legacy, 'mozhou.db'), 'db-bytes');
    const first = migrateLegacyUserData({ legacyDir: legacy, targetDir: target, now });
    expect(first.status).toBe('migrated');
    writeFileSync(join(first.archivedTo as string, 'keep.txt'), 'do-not-touch', 'utf8');

    // 用户又用安装版写了一份（旧目录被重新造出来），第二次迁移撞上同一个归档名
    touch(join(legacy, 'mozhou.db'), 'db-bytes-2');
    const second = migrateLegacyUserData({ legacyDir: legacy, targetDir: join(target, '..', 'mozhou-data-2'), now });

    expect(second.status).toBe('migrated');
    expect(second.archivedTo).not.toBe(first.archivedTo);
    expect(readFileSync(join(first.archivedTo as string, 'keep.txt'), 'utf8')).toBe('do-not-touch');
  });

  it('目标里留一份来源说明（出问题时不用猜是从哪儿搬来的）', () => {
    const { legacy, target } = sandbox();
    touch(join(legacy, 'mozhou.db'), 'db-bytes');

    const got = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });

    expect(got.status).toBe('migrated');
    const note = readFileSync(join(target, 'MIGRATED-FROM.txt'), 'utf8');
    expect(note).toContain(legacy);
    expect(note).toContain('共 1 个文件');
  });
});

describe('C. 中途失败不许留下半个状态', () => {
  it('★ 复制失败 → status=failed，旧目录原名还在（原件永远不许先动）', () => {
    const { legacy, target } = sandbox();
    touch(join(legacy, 'mozhou.db'), 'db-bytes');
    touch(join(legacy, 'backups', 'book.zip'), 'zip-bytes');
    // 在目标里用同名的普通文件把子目录的位置挡死：复制 backups/ 必然失败
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'backups'), 'i-am-a-file-not-a-dir', 'utf8');

    const got = migrateLegacyUserData({ legacyDir: legacy, targetDir: target });

    expect(got.status).toBe('failed');
    expect(got.error).toBeTruthy();
    expect(existsSync(join(legacy, 'mozhou.db'))).toBe(true);
    expect(existsSync(join(legacy, 'backups', 'book.zip'))).toBe(true);
  });
});
