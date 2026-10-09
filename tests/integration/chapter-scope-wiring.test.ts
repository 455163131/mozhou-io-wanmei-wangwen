/**
 * §4 第 18 条的装配层哨兵。
 *
 * 本仓库反复出现的事故形状是**逻辑对、喂给它的是空气**（见 PROJECT-STATUS.md §4
 * 第 3/4/13/14/17 条）。把 `chapters` 主键换成 `(project_id, id)` 之后，
 * 新的漂移方式变成：repo 签名要求 projectId，而某个调用方随手传了个别的项目的 id、
 * 或者在构造闭包时把 projectId 捕获下来（之后 closeProject()/换书就拿着旧号查新书）。
 * 单测证明不了调用方真的传了，所以这里钉源码。
 *
 * 钉三件事：
 *   A. repo 内部：不存在任何"只按章节号取数"的 SQL 残留；
 *   B. 调用方：每一处按章取数的调用，第一个实参必须是项目维度；
 *   C. 闭包里的项目 id 是**现取**的（`this.currentProject?.id` / `projectIdStrict(...)`），
 *      不是在 getter 外层捕获的常量。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const repo = readFileSync(new URL('../../src/main/db/repos/chapter-repo.ts', import.meta.url), 'utf8');
const services = readFileSync(new URL('../../src/main/services.ts', import.meta.url), 'utf8');
const ipc = readFileSync(new URL('../../src/main/ipc/register.ts', import.meta.url), 'utf8');

/** 需要项目维度的取数入口（insert/createChapter/reorder/listMeta* 本来就带 projectId） */
const PER_CHAPTER_READERS = ['get', 'getBody', 'getBodies', 'updateBody', 'setVolume', 'getMetrics'];

describe('A. repo 里不许残留"只按章节号取数"', () => {
  it('chapters 的按章读一律带 project_id', () => {
    expect(repo).not.toMatch(/FROM chapters WHERE id = \?/);
    const updates = repo.match(/UPDATE chapters SET [^']+/g) ?? [];
    expect(updates.length, '哨兵本身别静默失效：chapter-repo 里应当有 UPDATE chapters').toBeGreaterThan(2);
    for (const sql of updates) expect(sql, `缺项目条件：${sql}`).toContain('project_id');
  });

  it('chapter_bodies / chapter_metrics 的读写一律带 project_id', () => {
    expect(repo).not.toMatch(/chapter_bodies WHERE chapter_id = \?/);
    expect(repo).not.toMatch(/chapter_metrics WHERE chapter_id = \?/);
    expect(repo).not.toMatch(/WHERE chapter_id IN/);
    expect(repo).not.toMatch(/ON CONFLICT\(chapter_id\)/);
  });

  it('★ createChapter 只在书内算号：不再有全局 taken 集合', () => {
    const fn = repo.slice(repo.indexOf('createChapter('), repo.indexOf('/** 缓存指标'));
    expect(fn).toContain("FROM chapters WHERE project_id = ?");
    expect(fn).not.toMatch(/\btaken\b/);
    // 号仍然只由主进程算，界面插不上手（第 17 条的语义不许退化）
    expect(fn).not.toMatch(/opts\.id/);
  });
});

describe('B. 调用方每次都传项目维度', () => {
  /** 抓出所有 `chapterRepo.<reader>(第一个实参)`，逐个核对首参 */
  function firstArgs(source: string, receiver: string): string[] {
    const re = new RegExp(
      `(?:${receiver})\\.(?:${PER_CHAPTER_READERS.join('|')})\\(\\s*([^,)\\n]+)`,
      'g',
    );
    return [...source.matchAll(re)].map((m) => (m[1] as string).trim());
  }

  /** 允许的首参：明确的 projectId 变量，或直接由 currentProject/projectIdStrict 现取 */
  const PROJECT_SCOPED =
    /^(projectId|pid|p|otherPid|s\.project\.id|services\.project\.id|this\.currentProject(\.id|\?\.id)|this\.projectIdStrict\()/;

  it('services.ts 里每一处按章取数都以项目打头', () => {
    const args = firstArgs(services, 'this\\.chapterRepo');
    expect(args.length, 'services.ts 应当仍有按章取数的调用（哨兵本身别静默失效）').toBeGreaterThan(0);
    for (const a of args) expect(a, `首参「${a}」不是项目维度`).toMatch(PROJECT_SCOPED);
  });

  it('ipc/register.ts 里每一处按章取数都以 s.project.id 打头', () => {
    const args = firstArgs(ipc, 's\\.chapterRepo|services\\.chapterRepo');
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) expect(a, `首参「${a}」不是项目维度`).toMatch(PROJECT_SCOPED);
  });

  it('saveMetrics 的入参里带 projectId（指标缓存也是按书的）', () => {
    const call = services.slice(
      services.indexOf('this.chapterRepo.saveMetrics('),
      services.indexOf('this.chapterRepo.saveMetrics(') + 400,
    );
    expect(call).toMatch(/projectId[,\s]/);
  });
});

describe('C. 项目 id 在闭包里现取，不在构造时捕获', () => {
  it('checkpoint / replayer 的读写闭包都重取项目', () => {
    for (const when of ['写入正文时项目已被关闭', '回滚写入时项目已被关闭']) {
      expect(services).toContain(when);
    }
    // 闭包内现取：`projectIdStrict(` 出现次数 >= 需要项目的闭包数
    const strict = (services.match(/this\.projectIdStrict\(/g) ?? []).length;
    expect(strict).toBeGreaterThanOrEqual(3);
  });

  it('读正文的闭包走 bodyOf（未打开项目返回 null，而不是拿旧 id 查）', () => {
    expect(services).toMatch(/getBody: async \(id\) => this\.bodyOf\(id\)/);
    expect(services).toMatch(/private bodyOf\(chapterId: string\): string \| null \{/);
  });

  it('IPC 的 chapter:get / update / set-volume 都先判项目再取数', () => {
    for (const ch of ["handle('chapter:get'", "handle('chapter:update'", "handle('chapter:set-volume'"]) {
      const start = ipc.indexOf(ch);
      expect(start, `IPC 里找不到 ${ch}`).toBeGreaterThan(-1);
      const block = ipc.slice(start, start + 400);
      expect(block, `${ch} 必须先判空项目`).toContain('if (!s.project)');
    }
  });
});
