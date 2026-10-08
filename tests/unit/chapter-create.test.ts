/**
 * 新建章节（§4 第 17 条）。
 *
 * ★ 修复前的现状（全部实测过，见 PROJECT-STATUS.md §4 第 17 条）：
 *   `ChapterRepo.insert`（`chapter-repo.ts:199`）全仓**零调用方**，`src/` 里
 *   `INSERT INTO chapters` 只有 insert 内部那一处，7 个 Agent 工具没有一个能建章，
 *   `openProject()` 只 `ensureDir(chapters/)` 却从不把目录里的稿子读回来。
 *   净效果：**chapters 表恒为空** —— 章节树、编辑器、体检、AI 味统计、
 *   规划视图、日增量，在真实使用中全都拿不到任何数据（单测能过是因为测试自己调 insert 造数据）。
 *
 * ★ 语义选择（写下来，免得后人以为随手如此）：
 *   · 章节 id 就是**章节号**（`ChapterMeta.id` 的既有语义，导出的文件名也用它），
 *     所以新建时由主进程按"现有可解析为数字的最大号 + 1"算，绝不由前端传进来——
 *     前端传 id 等于让 UI 决定主键，两次点击就会建出两条同号章或撞主键。
 *   · `ord` 是**全书顺序**（`reorder` 按整表下标写回），新章追加到全书末尾。
 *   · 空标题允许：先建章再想名字是写作的常态，界面按 `第N章` 兜底显示。
 *   · 新建即为 `draft`（不是 todo）：作者点"新建章节"是要开始写，不是要立一个大纲占位。
 *   · 一次建章 = 一个事务里 chapters + chapter_bodies 两行。只有 chapters 有行而
 *     chapter_bodies 没行，`get()` 会读出 body=''，但备份读回时会出现"有章无文"的半状态。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo } from '@main/db/repos/daily-write-repo';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

let db: DB;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let daily: DailyWriteRepo;
let pid: string;
let otherPid: string;

beforeEach(() => {
  db = freshDb();
  projects = new ProjectRepo(db);
  daily = new DailyWriteRepo(db);
  chapters = new ChapterRepo(db, daily);
  pid = projects.create('测试书', '/tmp/a').id;
  otherPid = projects.create('另一本书', '/tmp/b').id;
});

/** 绕开 repo 直接看库，证明两行都真落盘了 */
function rawCounts(chapterId: string): { chapters: number; bodies: number } {
  const c = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE id = ?').get(chapterId) as {
    n: number;
  };
  const b = db
    .prepare('SELECT COUNT(*) AS n FROM chapter_bodies WHERE chapter_id = ?')
    .get(chapterId) as { n: number };
  return { chapters: c.n, bodies: b.n };
}

describe('A. 章节号由主进程算', () => {
  it('第一本空书 → 章节号是 1', () => {
    const m = chapters.createChapter(pid, { title: '开局' });
    expect(m.id).toBe('1');
  });

  it('数字号取最大 +1（不数条数：删过一章也不会把号退回去）', () => {
    chapters.insert({ id: '1', projectId: pid, title: '一', volumeId: null, order: 0, status: 'draft', body: 'x' });
    chapters.insert({ id: '7', projectId: pid, title: '七', volumeId: null, order: 1, status: 'draft', body: 'x' });
    expect(chapters.createChapter(pid, { title: '八' }).id).toBe('8');
  });

  it('插章号 10.5 之后下一号是 11.5（保留既有小数号语义）', () => {
    chapters.insert({ id: '10.5', projectId: pid, title: '插', volumeId: null, order: 0, status: 'draft', body: 'x' });
    expect(chapters.createChapter(pid, { title: '新' }).id).toBe('11.5');
  });

  it('非数字 id 不参与算号（楔子/番外这类占位不该被当成 0 号）', () => {
    chapters.insert({ id: 'xieu', projectId: pid, title: '楔子', volumeId: null, order: 0, status: 'draft', body: 'x' });
    expect(chapters.createChapter(pid, { title: '第一章' }).id).toBe('1');
  });

  it('连续建两章号不撞', () => {
    const a = chapters.createChapter(pid, { title: 'A' });
    const b = chapters.createChapter(pid, { title: 'B' });
    expect([a.id, b.id]).toEqual(['1', '2']);
  });

  it('★ 同机第二本书建章不撞主键：号跳过已被别的书占用的（chapters.id 是全局主键）', () => {
    chapters.createChapter(pid, { title: 'A' });
    chapters.createChapter(pid, { title: 'B' });
    const m = chapters.createChapter(otherPid, { title: '别人的第一章' });
    // '1'/'2' 已被 pid 占用，chapters.id 单列主键装不下两本各自从 1 开始的书。
    // 这里钉死当前语义：能建、号全局唯一；改成按书从 1 开始需要把主键换成
    // (project_id, id) 复合键 —— 见 PROJECT-STATUS.md §4「章节号跨书不隔离」。
    expect(m.id).toBe('3');
    expect(chapters.listMeta(pid).map((c) => c.id)).toEqual(['1', '2']);
    expect(chapters.listMeta(otherPid).map((c) => c.id)).toEqual(['3']);
  });
});

describe('B. 建出来的章长什么样', () => {
  it('标题去首尾空白后落库，空标题允许（先建章再想名字是常态）', () => {
    const m = chapters.createChapter(pid, { title: '  第一章 风雨欲来  ' });
    expect(m.title).toBe('第一章 风雨欲来');
    const e = chapters.createChapter(pid, { title: '   ' });
    expect(e.title).toBe('');
  });

  it('新建即 draft：点「新建章节」是要开始写，不是要立大纲占位', () => {
    expect(chapters.createChapter(pid, { title: 'A' }).status).toBe('draft');
  });

  it('正文为空、字数 0、rev 1', () => {
    const m = chapters.createChapter(pid, { title: 'A' });
    expect(m).toMatchObject({ charCount: 0, rev: 1 });
    expect(chapters.getBody(m.id)).toBe('');
  });

  it('★ chapters 与 chapter_bodies 两行都落盘（有章无文=半状态）', () => {
    const m = chapters.createChapter(pid, { title: 'A' });
    expect(rawCounts(m.id)).toEqual({ chapters: 1, bodies: 1 });
  });

  it('ord 追加到全书末尾', () => {
    const a = chapters.createChapter(pid, { title: 'A' });
    const b = chapters.createChapter(pid, { title: 'B' });
    expect([a.order, b.order]).toEqual([0, 1]);
  });

  it('不传卷 → volumeId 为 null（未分卷）', () => {
    expect(chapters.createChapter(pid, { title: 'A' }).volumeId).toBeNull();
  });

  it('指定本项目的卷 → 落进那一卷', () => {
    const vol = projects.createVolume(pid, '第一卷').id;
    const m = chapters.createChapter(pid, { title: 'A', volumeId: vol });
    expect(m.volumeId).toBe(vol);
  });

  it('★ 别项目的卷 id 直接被拒（不写库）', () => {
    const otherVol = projects.createVolume(otherPid, '别人的卷').id;
    expect(() => chapters.createChapter(pid, { title: 'A', volumeId: otherVol })).toThrow();
    expect(chapters.listMeta(pid)).toHaveLength(0);
  });

  it('不存在的卷 id 被外键拦住（不写库）', () => {
    expect(() => chapters.createChapter(pid, { title: 'A', volumeId: 'vol_ghost' })).toThrow();
    expect(chapters.listMeta(pid)).toHaveLength(0);
  });

  it('未打开的项目 / 空 projectId 直接拒', () => {
    expect(() => chapters.createChapter('', { title: 'A' })).toThrow();
    expect(() => chapters.createChapter('proj_ghost', { title: 'A' })).toThrow();
  });
});

describe('C. 与日增量的关系', () => {
  it('★ 新建空章不产生净增（0 字不该在趋势图上占一格）', () => {
    chapters.createChapter(pid, { title: 'A' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_writes').get() as { n: number }).toEqual({ n: 0 });
  });

  it('建章后写正文，净增按正文全长度记（走 updateBody 那条咽喉）', () => {
    const m = chapters.createChapter(pid, { title: 'A' });
    chapters.updateBody(m.id, '一二三四五', m.rev);
    expect(daily.summary(pid).today).toBe(5);
  });
});

describe('D. 排序与列表能立刻看见新章', () => {
  it('listMeta 按 ord 返回，新章在最后', () => {
    chapters.createChapter(pid, { title: 'A' });
    const b = chapters.createChapter(pid, { title: 'B' });
    const list = chapters.listMeta(pid);
    expect(list.map((c) => c.title)).toEqual(['A', 'B']);
    // reorder 要求整表排列，新建的章必须已经在里面（否则拖一次就报"列表过期"）
    expect(() => chapters.reorder(pid, list.map((c) => c.id).reverse())).not.toThrow();
    expect(chapters.listMeta(pid).map((c) => c.id)).toEqual([b.id, '1']);
  });
});
