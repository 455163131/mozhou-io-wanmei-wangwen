/**
 * 分卷创建与拖拽排序的 repo 行为（§4 第 4 条）。
 *
 * 真库跑（better-sqlite3 内存库 + migrate），不 mock：这一条要守的就是
 * `ord` 在库里的真实唯一性/顺序语义，mock 出来的是我自己写的假语义。
 *
 * 修复前的现状（实测）：`ProjectRepo.insertVolume(projectId, title, order)` 全仓
 * **零调用方**——`grep -rn insertVolume src/` 只有定义那一行。也就是说
 * 「新建分卷」在 UI、IPC、Agent 工具三条路上一个入口都没有，
 * 而 `PlanView` 空卷时提示用户「在对话里让 Agent 建立卷册规划」，
 * Agent 侧同样没有建卷工具（`grep -rn volume src/main/tools/impl/` 零命中）。
 * 所以本文件测的是"从无到有"的语义，而不是回归某个旧行为。
 *
 * ★ 语义选择（写下来，免得后人以为随手如此）：
 *   · `ord` 从 0 起、按数组下标重排 —— 与既有 `volumes()`/`listMeta()` 的
 *     `ORDER BY ord ASC` 一致，不引入分数索引那种"看着能插其实会漂"的方案。
 *   · 重排必须**整表全给**且**全部属于本项目**：少给一条就会造成两条同 ord，
 *     多给一条别的项目的 id 就会把别人的卷册 ord 改掉。两种都直接抛，
 *     且抛出去时库里顺序**一字不动**（事务原子性，测试里专门钉这条）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { nextId } from '@shared/util/id';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

let db: DB;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let pid: string;
let otherPid: string;

beforeEach(() => {
  db = freshDb();
  projects = new ProjectRepo(db);
  chapters = new ChapterRepo(db);
  pid = projects.create('测试书', '/tmp/a').id;
  otherPid = projects.create('另一本书', '/tmp/b').id;
});

/** 库里实际的 (id → ord)，用来绕开 repo 自己验证 ord 真的落盘了 */
function ordMap(table: 'volumes' | 'chapters'): Map<string, number> {
  const rows = db.prepare(`SELECT id, ord FROM ${table} WHERE project_id = ?`).all(pid) as Array<{
    id: string;
    ord: number;
  }>;
  return new Map(rows.map((r) => [r.id, r.ord]));
}

function addVolume(title: string): string {
  return projects.createVolume(pid, title).id;
}

function addChapter(title: string, volumeId: string | null = null): string {
  const order = chapters.listMeta(pid).length;
  return chapters.insert({
    id: nextId('ch'),
    projectId: pid,
    title,
    volumeId,
    order,
    status: 'draft',
    body: '正文',
  }).id;
}

describe('A. 建卷：ord 追加、标题校验', () => {
  it('第一卷 ord=0，之后依次追加（不要求调用方自己数）', () => {
    const a = projects.createVolume(pid, '第一卷');
    const b = projects.createVolume(pid, '第二卷');
    const c = projects.createVolume(pid, '第三卷');
    expect([a.order, b.order, c.order]).toEqual([0, 1, 2]);
    expect(projects.volumes(pid).map((v) => v.title)).toEqual(['第一卷', '第二卷', '第三卷']);
  });

  it('返回的 Volume 与随后 volumes() 读到的一致（不许返回内存里的乐观值）', () => {
    const created = projects.createVolume(pid, '风起于青萍之末');
    const found = projects.volumes(pid).find((v) => v.id === created.id);
    expect(found).toEqual(created);
  });

  it('空标题/纯空白标题直接抛，不入库', () => {
    expect(() => projects.createVolume(pid, '')).toThrow();
    expect(() => projects.createVolume(pid, '   ')).toThrow();
    expect(projects.volumes(pid)).toHaveLength(0);
  });

  it('标题两端空白被裁掉（用户粘贴带空格的卷名是常态）', () => {
    expect(projects.createVolume(pid, '  第一卷  ').title).toBe('第一卷');
    expect(ordMap('volumes').size).toBe(1);
  });
});

describe('B. 卷册重排：整表全给、原子、越界即抛', () => {
  it('按下标重写 ord，volumes() 立刻是新顺序', () => {
    const ids = ['一', '二', '三', '四'].map((t) => addVolume(`第${t}卷`));
    const swapped = [ids[2], ids[0], ids[3], ids[1]];
    const res = projects.reorderVolumes(pid, swapped);
    expect(res.map((v) => v.id)).toEqual(swapped);
    expect(ordMap('volumes')).toEqual(new Map(swapped.map((id, i) => [id, i])));
    expect(projects.volumes(pid).map((v) => v.id)).toEqual(swapped);
  });

  it('ord 无重复无空洞（拖十次之后仍是 0..n-1）', () => {
    const ids = ['一', '二', '三'].map((t) => addVolume(`第${t}卷`));
    for (const order of [[ids[1], ids[2], ids[0]], [ids[2], ids[0], ids[1]], [ids[0], ids[1], ids[2]]]) {
      projects.reorderVolumes(pid, order);
    }
    expect(ordMap('volumes')).toEqual(new Map(ids.map((id, i) => [id, i])));
  });

  it('漏一条就抛，且库里顺序一字不动（半个重排比不排更糟）', () => {
    const ids = ['一', '二', '三'].map((t) => addVolume(`第${t}卷`));
    const before = ordMap('volumes');
    expect(() => projects.reorderVolumes(pid, [ids[1], ids[0]])).toThrow();
    expect(ordMap('volumes')).toEqual(before);
  });

  it('混进别的项目的卷 id 就抛，且不动别人的 ord', () => {
    const mine = ['一', '二'].map((t) => addVolume(`第${t}卷`));
    const theirs = projects.createVolume(otherPid, '别人的卷').id;
    expect(() => projects.reorderVolumes(pid, [theirs, mine[1], mine[0]])).toThrow();
    expect(ordMap('volumes')).toEqual(new Map(mine.map((id, i) => [id, i])));
    // 别人那一卷的 ord 必须原封不动
    expect(db.prepare('SELECT ord FROM volumes WHERE id = ?').get(theirs)).toMatchObject({ ord: 0 });
  });

  it('不存在的 id 也抛（前端列表过期时不该静默成功）', () => {
    const ids = ['一', '二'].map((t) => addVolume(`第${t}卷`));
    expect(() => projects.reorderVolumes(pid, [ids[0], 'vol_不存在'])).toThrow();
    expect(() => projects.reorderVolumes(pid, [ids[0]])).toThrow();
  });
});

describe('C. 章节重排与跨卷移动', () => {
  it('章节按下标重写 ord，listMeta 是新顺序', () => {
    const ids = ['第一章', '第二章', '第三章'].map((t) => addChapter(t));
    const swapped = [ids[2], ids[0], ids[1]];
    const res = chapters.reorder(pid, swapped);
    expect(res.map((c) => c.id)).toEqual(swapped);
    expect(chapters.listMeta(pid).map((c) => c.id)).toEqual(swapped);
    expect(ordMap('chapters')).toEqual(new Map(swapped.map((id, i) => [id, i])));
  });

  it('重排不许顺手改正文与 rev（排序不是编辑）', () => {
    const ids = ['第一章', '第二章'].map((t) => addChapter(t));
    const revBefore = chapters.get(pid, ids[0])!.meta.rev;
    const bodyBefore = chapters.getBody(pid, ids[0]);
    chapters.reorder(pid, [ids[1], ids[0]]);
    expect(chapters.get(pid, ids[0])!.meta.rev).toBe(revBefore);
    expect(chapters.getBody(pid, ids[0])).toBe(bodyBefore);
  });

  it('漏条/越界同样抛且顺序不动', () => {
    const ids = ['第一章', '第二章', '第三章'].map((t) => addChapter(t));
    const before = ordMap('chapters');
    expect(() => chapters.reorder(pid, ids.slice(0, 2))).toThrow();
    expect(() => chapters.reorder(pid, [...ids, 'ch_不存在'])).toThrow();
    expect(ordMap('chapters')).toEqual(before);
  });

  it('setVolume：把章挪进某卷，再挪回未分卷（null）', () => {
    const vid = addVolume('第一卷');
    const cid = addChapter('第一章');
    expect(chapters.setVolume(pid, cid, vid).volumeId).toBe(vid);
    expect(chapters.listMeta(pid)[0].volumeId).toBe(vid);
    expect(chapters.setVolume(pid, cid, null).volumeId).toBeNull();
  });

  it('setVolume：卷不属于本项目就抛，章保持原样', () => {
    const cid = addChapter('第一章');
    const theirs = projects.createVolume(otherPid, '别人的卷').id;
    expect(() => chapters.setVolume(pid, cid, theirs)).toThrow();
    expect(chapters.get(pid, cid)!.meta.volumeId).toBeNull();
  });

  it('删卷后章不悬空：volume_id 由外键置空（ON DELETE SET NULL 真的生效）', () => {
    const vid = addVolume('第一卷');
    const cid = addChapter('第一章', vid);
    db.prepare('DELETE FROM volumes WHERE id = ?').run(vid);
    expect(chapters.get(pid, cid)!.meta.volumeId).toBeNull();
  });
});
