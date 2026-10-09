/**
 * 改章节标题（§4 第 19 条①）。
 *
 * 修复前的现状（实测口径见 PROJECT-STATUS.md §4 第 19 条）：全仓没有任何
 * `UPDATE chapters SET title`，标题只能在**建的那一刻**通过 `chapter:create` 给一次，
 * 之后想改名没有任何入口——编辑器只写正文（`updateBody` 不碰 title），
 * 拖拽只改 ord 和 volume_id。写错了名字只能删了重建，而删章没有入口。
 *
 * ★ 三条口径，写下来免得后人以为是随手定的：
 *   · **不动 `rev`**：改标题不是编辑正文。动了 rev 会让编辑器里那份未保存的正文
 *     在下次保存时撞上乐观锁，用户感知就是"我改了个标题，怎么写不回去了"。
 *     和 `reorder`（§4 第 4 条）同一个理由。
 *   · **不动 `updated_at`**：这一列跟着 `rev`/`char_count` 一起写，语义是
 *     "正文最后一次改动"。改名不该让"最近修改时间"说谎。
 *   · **不动 `chapter_bodies`**：所以也**不该产生日净增**（`DailyWriteRepo` 只由
 *     正文变化驱动）。这条是硬断言，不是顺带。
 *   · 空标题允许，与 `createChapter` 同口径（界面按 `第N章` 兜底显示）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo } from '@main/db/repos/daily-write-repo';

let db: DB;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let daily: DailyWriteRepo;
let pid: string;
let otherPid: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  projects = new ProjectRepo(db);
  daily = new DailyWriteRepo(db);
  chapters = new ChapterRepo(db, daily);
  pid = projects.create('测试书', '/tmp/a').id;
  otherPid = projects.create('另一本书', '/tmp/b').id;
});

describe('A. 标题改得动', () => {
  it('setTitle 返回新 meta，listMeta 也读到新值（不是只改了内存）', () => {
    const m = chapters.createChapter(pid, { title: '开局' });
    const after = chapters.setTitle(pid, m.id, '改过的标题');
    expect(after.title).toBe('改过的标题');
    // get() 的返回是 { meta, body }（chapter-repo.ts:111），标题在 meta 上
    expect(chapters.get(pid, m.id)!.meta.title).toBe('改过的标题');
    expect(chapters.listMeta(pid).find((c) => c.id === m.id)!.title).toBe('改过的标题');
  });

  it('直接查库确认落盘（绕开 repo 的读路径）', () => {
    const m = chapters.createChapter(pid, { title: '旧' });
    chapters.setTitle(pid, m.id, '新');
    const r = db
      .prepare('SELECT title FROM chapters WHERE project_id = ? AND id = ?')
      .get(pid, m.id) as { title: string };
    expect(r.title).toBe('新');
  });

  it('前后空格去掉，空标题允许（与 createChapter 同口径，界面按 第N章 兜底）', () => {
    const m = chapters.createChapter(pid, { title: '' });
    expect(chapters.setTitle(pid, m.id, '  标题  ').title).toBe('标题');
    expect(chapters.setTitle(pid, m.id, '   ').title).toBe('');
  });

  it('改成完全相同的标题也算成功（幂等，不抛）', () => {
    const m = chapters.createChapter(pid, { title: '同一句' });
    expect(chapters.setTitle(pid, m.id, '同一句').title).toBe('同一句');
  });
});

describe('B. 只改 title：正文口径的东西一律不动', () => {
  it('★ 不碰 rev：改完标题，编辑器拿旧 expectedRev 仍然写得进正文', () => {
    const m = chapters.createChapter(pid, { title: '开局' });
    const saved = chapters.updateBody(pid, m.id, '第一段正文。', m.rev);
    // 此刻库里 rev 已经是 saved.rev（写正文推进过一次），改名不许再推一次
    const reNamed = chapters.setTitle(pid, m.id, '换名');
    expect(reNamed.rev, '改标题不该推进乐观锁版本').toBe(saved.rev);
    // 编辑器手里那份 rev 还是改名前的，必须照样写得进去
    const again = chapters.updateBody(pid, m.id, '第一段正文改。', saved.rev);
    expect(again.rev).toBe(saved.rev + 1);
  });

  it('★ 不碰 updated_at（这一列跟正文一起写，改名不该让"最近修改"说谎）', () => {
    const m = chapters.createChapter(pid, { title: '开局' });
    const renamed = chapters.setTitle(pid, m.id, '换名');
    expect(renamed.updatedAt).toBe(m.updatedAt);
  });

  it('★ 不碰正文，也不产生日净增', () => {
    const m = chapters.createChapter(pid, { title: '开局' });
    chapters.updateBody(pid, m.id, '一二三四五', m.rev);
    const before = daily.summary(pid).today;
    const renamed = chapters.setTitle(pid, m.id, '换名');
    expect(renamed.charCount).toBe(5);
    expect(chapters.getBody(pid, m.id)).toBe('一二三四五');
    expect(daily.summary(pid).today).toBe(before);
  });

  it('改标题不影响卷归属与顺序', () => {
    const vol = projects.createVolume(pid, '第一卷');
    const m = chapters.createChapter(pid, { title: '开局', volumeId: vol.id });
    const renamed = chapters.setTitle(pid, m.id, '换名');
    expect(renamed.volumeId).toBe(vol.id);
    expect(renamed.order).toBe(m.order);
  });
});

describe('C. 第 18 条的续集：只改本书那一章', () => {
  it('★ 两本书同号时，改 A 的标题不许动到 B', () => {
    const a = chapters.createChapter(pid, { title: 'A 的第一章' });
    const b = chapters.createChapter(otherPid, { title: 'B 的第一章' });
    expect(a.id).toBe(b.id);
    chapters.setTitle(pid, a.id, 'A 改过了');
    expect(chapters.get(otherPid, b.id)!.meta.title).toBe('B 的第一章');
  });

  it('章不存在抛错（而不是静默改了别书的同号章）', () => {
    expect(() => chapters.setTitle(pid, '999', '无中生有')).toThrow(/章节不存在/);
  });

  it('拿别项目的章号来改要失败', () => {
    const b = chapters.createChapter(otherPid, { title: 'B 的第一章' });
    expect(() => chapters.setTitle(pid, b.id, '越权')).toThrow(/章节不存在/);
    expect(chapters.get(otherPid, b.id)!.meta.title).toBe('B 的第一章');
  });
});
