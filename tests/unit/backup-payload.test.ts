/**
 * ★ L3 全量备份的内容与可读回性测试。
 *
 * 为什么单独开一个文件：
 *
 *   修复前 `backup()` 的唯一调用点传的是 `{ at: Date.now() }`——一个纯时间戳。
 *   落盘的 `.mzproj` 里**没有任何章节正文**，而三个触发时机中也只有「手动保存」
 *   接了线（`startIdleWatcher` 无调用者、退出路径只调 `closeDatabase()`）。
 *   于是注释里写着的「三层备份」实际是**零层**：用户没有任何可恢复的稿件副本。
 *
 *   这类缺陷既有的 281 个用例一个都抓不到——`fs/backup.ts` 从未被任何测试加载。
 *   而对一个稿件丢失即灾难的写作应用，这是最不该留白的一块。
 *
 * 本文件的判据是「**备份能不能读回来**」，而不只是「有没有写出文件」：
 * 写得出但读不回、或读回来是空的，都等于没有备份。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BackupManager } from '@main/fs/backup';
import { atomicWrite } from '@main/fs/project-fs';
import { BACKUP_DIR, BACKUP_KEEP_COUNT } from '@shared/constants/checkpoint';
import {
  PROJECT_BACKUP_FORMAT_VERSION,
  type ProjectBackup,
  type ChapterMeta,
} from '@shared/types/project';

/**
 * ★ 归档目录放在**项目内的 .tmp/**，不用系统 tmpdir。
 * 沿用 checkpoint.test.ts 的约定：某些沙箱环境下系统 tmpdir 并发写会 EPERM。
 */
const TMP_ROOT = join(process.cwd(), '.tmp');

let rootDir: string;
let mgr: BackupManager;

/** 造一份含正文的合法备份载荷 */
function makePayload(overrides: Partial<ProjectBackup> = {}): ProjectBackup {
  const meta = (id: string, order: number): ChapterMeta => ({
    id,
    projectId: 'p1',
    title: `第${order}章`,
    volumeId: null,
    order,
    status: 'draft',
    charCount: 6,
    rev: 1,
    updatedAt: 0,
  });
  const chapters = [
    { meta: meta('c1', 1), body: '第一章的正文内容。' },
    { meta: meta('c2', 2), body: '第二章的正文内容。' },
  ];
  return {
    formatVersion: PROJECT_BACKUP_FORMAT_VERSION,
    createdAt: Date.now(),
    trigger: 'manual-save',
    project: {
      id: 'p1',
      name: '测试书',
      rootDir: rootDir,
      createdAt: 0,
      updatedAt: 0,
      targetWords: 0,
      pricePerK: 0,
    },
    volumes: [],
    chapters,
    ledger: { characters: [], numbers: [], timeline: [], foreshadows: [] },
    style: null,
    // 与 services.buildBackupPayload 同口径：去空白后的字符数
    integrity: {
      chapterCount: chapters.length,
      totalChars: chapters.reduce((s, c) => s + c.body.replace(/\s/g, '').length, 0),
    },
    ...overrides,
  };
}

beforeEach(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  rootDir = await fs.mkdtemp(join(TMP_ROOT, 'backup-'));
  mgr = new BackupManager(rootDir);
});

afterEach(async () => {
  mgr.stopIdleWatcher();
  await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('★ 备份必须含正文（修复前是纯时间戳）', () => {
  it('写出的 .mzproj 里能读回全部章节正文', async () => {
    const payload = makePayload();
    const stats = await mgr.backup('manual-save', payload.project.name, payload);

    expect(stats.bytes).toBeGreaterThan(0);
    const res = await mgr.readBackup(stats.path);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.backup.chapters).toHaveLength(2);
    expect(res.backup.chapters[0].body).toBe('第一章的正文内容。');
    expect(res.backup.chapters[1].body).toBe('第二章的正文内容。');
    expect(res.backup.project.name).toBe('测试书');
  });

  it('★ 修复前的形态（只有时间戳、没有 chapters）必须被判为不可用', async () => {
    // 直接复刻修复前落盘的内容：{ project, at, payload: { at: ... } }
    const legacy = join(rootDir, BACKUP_DIR, 'legacy_manual-save.mzproj');
    await fs.mkdir(join(rootDir, BACKUP_DIR), { recursive: true });
    await atomicWrite(
      legacy,
      JSON.stringify({ project: '测试书', at: Date.now(), payload: { at: Date.now() } }),
    );

    const res = await mgr.readBackup(legacy);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 原因必须可读，让用户知道这份「备份」为什么救不回来
    expect(res.reason.length).toBeGreaterThan(0);
  });

  it('账本与风格档也一并进了备份（重启不丢）', async () => {
    const payload = makePayload();
    payload.ledger.characters = [
      {
        id: 'ch_1',
        name: '林昭',
        role: '主角',
        age: '十七',
        note: '左眉有一道旧疤',
        refs: [],
        updatedAt: 0,
      },
    ];
    payload.style = {
      source: '你的语料（12 章，按章分位数）',
      sampleChapters: 12,
      metrics: {},
      markerDensity: {},
    };

    const stats = await mgr.backup('idle-30min', payload.project.name, payload);
    const res = await mgr.readBackup(stats.path);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backup.ledger.characters[0].name).toBe('林昭');
    expect(res.backup.style?.sampleChapters).toBe(12);
    expect(stats.trigger).toBe('idle-30min');
  });
});

describe('★ 完整性自检：读回时挡住被截断/被篡改的备份', () => {
  it('章数与 integrity 不符 → 拒绝', async () => {
    const payload = makePayload();
    payload.integrity = { chapterCount: 99, totalChars: payload.integrity.totalChars };
    const stats = await mgr.backup('manual-save', 'x', payload);

    const res = await mgr.readBackup(stats.path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('99');
  });

  it('正文被篡改导致字数不符 → 拒绝', async () => {
    const stats = await mgr.backup('manual-save', 'x', makePayload());
    const raw = JSON.parse(await fs.readFile(stats.path, 'utf8')) as ProjectBackup;
    raw.chapters[0].body = '被改短';
    await fs.writeFile(stats.path, JSON.stringify(raw), 'utf8');

    const res = await mgr.readBackup(stats.path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('字');
  });

  it('JSON 被截断（写一半崩溃）→ 拒绝且不抛异常', async () => {
    const stats = await mgr.backup('manual-save', 'x', makePayload());
    const raw = await fs.readFile(stats.path, 'utf8');
    await fs.writeFile(stats.path, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');

    const res = await mgr.readBackup(stats.path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('JSON');
  });

  it('格式版本不识别 → 拒绝，并说明可能是更新版本或空备份', async () => {
    const stats = await mgr.backup('manual-save', 'x', makePayload());
    const raw = JSON.parse(await fs.readFile(stats.path, 'utf8')) as Record<string, unknown>;
    raw.formatVersion = 999;
    await fs.writeFile(stats.path, JSON.stringify(raw), 'utf8');

    const res = await mgr.readBackup(stats.path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('格式版本');
  });

  it('文件不存在 → 明确失败而非抛异常', async () => {
    const res = await mgr.readBackup(join(rootDir, BACKUP_DIR, 'nope.mzproj'));
    expect(res.ok).toBe(false);
  });
});

describe('轮转：只保留最近 N 份，且按时间而非文件名字典序', () => {
  it(`超过 ${BACKUP_KEEP_COUNT} 份时删掉最旧的`, async () => {
    const total = BACKUP_KEEP_COUNT + 3;
    const base = Date.now() - total * 60_000;
    for (let i = 0; i < total; i++) {
      await mgr.backup('manual-save', 'x', makePayload());
      const list = await mgr.listBackups();
      // 显式拉开 mtime，避免同毫秒写入让排序失去确定性
      const newest = list[0];
      if (newest) {
        const t = new Date(base + i * 60_000);
        await fs.utimes(newest.path, t, t);
      }
    }

    const list = await mgr.listBackups();
    expect(list).toHaveLength(BACKUP_KEEP_COUNT);
    // 倒序：第一个最新
    expect(list[0].at).toBeGreaterThan(list[list.length - 1].at);
  });

  it('★ 项目改名后仍能正确按时间轮转（修复前按文件名字典序会删错）', async () => {
    // 'zzz-新书' 字典序靠后但时间最旧；'aaa-旧书' 字典序靠前但时间最新。
    // 修复前 `.sort()` 直接排文件名，会保留字典序靠后的、删掉真正最新的。
    const base = Date.now() - 10 * 60_000;
    for (let i = 0; i < BACKUP_KEEP_COUNT; i++) {
      await mgr.backup('manual-save', 'zzz-新书', makePayload());
      const list = await mgr.listBackups();
      const t = new Date(base + i * 1000);
      await fs.utimes(list[0].path, t, t);
    }
    // 最新的一份用字典序靠前的名字
    await mgr.backup('manual-save', 'aaa-旧书', makePayload());
    const list = await mgr.listBackups();
    const newest = list[0];
    const t = new Date(base + 60_000);
    await fs.utimes(newest.path, t, t);

    await mgr.backup('manual-save', 'x', makePayload()); // 触发轮转
    const after = await mgr.listBackups();
    expect(after).toHaveLength(BACKUP_KEEP_COUNT);
    // 字典序靠前但时间最新的那份必须还在
    expect(after.some((b) => b.path.includes('aaa-'))).toBe(true);
  });

  it('没有备份目录时 listBackups 返回空数组（不是错误）', async () => {
    const fresh = new BackupManager(join(rootDir, 'not-exist-yet'));
    expect(await fresh.listBackups()).toEqual([]);
  });
});

describe('文件名与空闲判定', () => {
  it('项目名含 Windows 非法字符时不崩、且能读回', async () => {
    const payload = makePayload();
    payload.project.name = '我的书:第<二>部|测试?';
    const stats = await mgr.backup('manual-save', payload.project.name, payload);
    const res = await mgr.readBackup(stats.path);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 载荷里的项目名保持原样（只有**文件名**被清洗）
    expect(res.backup.project.name).toBe('我的书:第<二>部|测试?');
  });

  it('项目名为空或全是非法字符时给稳定占位名', async () => {
    const stats = await mgr.backup('manual-save', '???', makePayload());
    expect(stats.path.endsWith('.mzproj')).toBe(true);
    expect(stats.path).not.toContain('???');
  });

  it('★ isIdle：run 执行期间恒为 false（避免拍到半改状态）', () => {
    const far = Date.now() + 60 * 60 * 1000; // 远超两个阈值
    expect(mgr.isIdle(far, false)).toBe(true);
    expect(mgr.isIdle(far, true)).toBe(false);
  });

  it('isIdle：刚编辑过不算空闲', () => {
    mgr.noteEdit();
    expect(mgr.isIdle(Date.now(), false)).toBe(false);
  });

  it('isIdle：距上次备份不足 30 分钟时不算空闲（避免重复全量）', async () => {
    await mgr.backup('manual-save', 'x', makePayload());
    mgr.noteEdit(); // 让「无编辑 5 分钟」这一支先满足，从而隔离出备份间隔这一支
    // +10 分钟：编辑阈值(5min)已过，但备份间隔(30min)未到
    expect(mgr.isIdle(Date.now() + 10 * 60 * 1000, false)).toBe(false);
    // +40 分钟：两个阈值都过 → 空闲
    expect(mgr.isIdle(Date.now() + 40 * 60 * 1000, false)).toBe(true);
  });

  it('★ 同一秒内连续备份不互相覆盖（修复前文件名只精确到秒）', async () => {
    // 快速连按两次 Ctrl+S 就会落进同一秒。修复前两份算出同一个文件名，
    // 后者覆盖前者 → 「保留最近 5 份」实际只剩 4 份，且丢的是刚写的那份。
    const paths = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const stats = await mgr.backup('manual-save', 'x', makePayload());
      paths.add(stats.path);
    }
    expect(paths.size).toBe(4); // 四份互不覆盖
    const list = await mgr.listBackups();
    expect(list).toHaveLength(4);
    // 每一份都必须能读回正文（不是 0 字节的残骸）
    for (const b of list) {
      const res = await mgr.readBackup(b.path);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.backup.chapters[0].body).toBe('第一章的正文内容。');
    }
  });

  it('去重后缀不影响触发时机的识别', async () => {
    for (let i = 0; i < 3; i++) await mgr.backup('app-exit', 'x', makePayload());
    const list = await mgr.listBackups();
    expect(list.length).toBeGreaterThanOrEqual(1);
    // 至少有一份被正确识别为 app-exit（带 _1/_2 后缀的那些也要认得出来）
    expect(list.every((b) => b.trigger === 'app-exit')).toBe(true);
  });
});

describe('atomicWrite：崩溃不留半截文件', () => {
  it('写入后内容完整可读', async () => {
    const target = join(rootDir, 'a', 'b', 'chapter.txt');
    await fs.mkdir(join(rootDir, 'a', 'b'), { recursive: true });
    const content = '一整章正文'.repeat(200);
    await atomicWrite(target, content);
    expect(await fs.readFile(target, 'utf8')).toBe(content);
  });

  it('★ 不残留 .tmp- 临时文件（成功路径必须清理干净）', async () => {
    const dir = join(rootDir, 'clean');
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'x.txt'), 'hello');
    const files = await fs.readdir(dir);
    expect(files).toEqual(['x.txt']);
  });

  it('覆盖已有文件时，旧内容被完整替换而非部分覆写', async () => {
    const target = join(rootDir, 'overwrite.txt');
    await atomicWrite(target, 'AAAAAAAAAA'); // 长
    await atomicWrite(target, 'BB'); // 短
    // 若是原地截断写，可能留下 'BBAAAAAA'；rename 语义保证是完整替换
    expect(await fs.readFile(target, 'utf8')).toBe('BB');
  });
});
