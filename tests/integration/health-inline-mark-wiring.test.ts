/**
 * §4 第 20 条② —— 体检命中画到正文上的**通路**哨兵。
 *
 * 映射层与生产端各由一份纯单测钉着（`inline-marks-health.test.ts` /
 * `health-locate-issues.test.ts`）。本仓库反复出的事故形状是"逻辑对、喂给它的是空气"
 * （§5 坑 3：IPC 契约散在四个文件里，漏一处就是运行期 `undefined is not a function`），
 * 所以这里把每一跳都钉一遍，最后再走一次**真 SQLite**：正文从库里读出来，
 * 坐标在同一份正文上回验——中间不许有任何一份手抄的 fixture。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo } from '@main/db/repos/daily-write-repo';
import { locateChapterIssues, type ReadOnlyDeps } from '@main/tools/impl/analyze';
import { marksFromLocations } from '@renderer/components/editor/inline-marks';
import type { ToolContext } from '@shared/types/tool';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const ipc = read('src/shared/types/ipc.ts');
const api = read('src/preload/api.ts');
const bridge = read('src/preload/index.ts');
const register = read('src/main/ipc/register.ts');
const editor = read('src/renderer/components/editor/Editor.tsx');
const css = read('src/renderer/components/editor/Editor.module.css');

const CHANNEL = 'health:locate-chapter';

describe('A. ★ IPC 契约四处一个都不能少（§5 坑 3）', () => {
  it('shared：req/res 声明在 IpcInvokeMap 里，res 是 LocatedIssue[]', () => {
    expect(ipc).toMatch(new RegExp(`'${CHANNEL}': \\{\\s*req: \\{ chapterId: string \\};\\s*res: LocatedIssue\\[\\]`));
    expect(ipc).toMatch(/LocatedIssue[,}]/);
  });

  it('shared：通道名进了 IPC_CHANNELS 清单（漏这里 preload 会被白名单拦掉）', () => {
    expect(ipc).toMatch(new RegExp(`^\\s+'${CHANNEL}',\\s*$`, 'm'));
  });

  it('preload：方法签名与 INVOKE_CHANNELS 白名单都在', () => {
    expect(api).toMatch(/locateChapter\(chapterId: string\)/);
    expect(api).toMatch(new RegExp(`^\\s+'${CHANNEL}',\\s*$`, 'm'));
  });

  it('preload：实现把参数原样递进去，不吞掉 chapterId', () => {
    expect(bridge).toMatch(new RegExp(`locateChapter: \\(chapterId\\) => invoke\\('${CHANNEL}', \\{ chapterId \\}\\)`));
  });

  it('main：handler 注册了，且复用 registryDeps()（不许在 handler 里再装配一遍假依赖）', () => {
    expect(register).toMatch(new RegExp(`handle\\('${CHANNEL}'`));
    const at = register.indexOf(`handle('${CHANNEL}'`);
    expect(at).toBeGreaterThan(-1);
    const body = register.slice(at, at + 700);
    expect(body).toMatch(/locateChapterIssues\(/);
    expect(body, '自己 new 一份 deps 就会与工具侧漂移').toContain('s.registryDeps()');
  });
});

describe('B. 编辑器真的用上了这条链', () => {
  it('从映射层引入体检映射与跨源合并', () => {
    expect(editor).toMatch(/marksFromLocations/);
    expect(editor).toMatch(/mergeMarks/);
  });

  it('★ 数据源是「上一次体检」的现算结果，按当前章发起，编辑器里不重跑体检', () => {
    expect(editor).toMatch(/health\.locateChapter\(/);
    expect(editor, '编辑器里跑 health.analyze 等于每切一章就重测一次').not.toMatch(/health\.analyze\(/);
  });

  it('★ 两个来源一起过 mergeMarks，AI 味与体检共用一套「不许画」纪律', () => {
    expect(editor).toMatch(/mergeMarks\(\[[\s\S]*marksFromHits\([\s\S]*marksFromLocations\(/);
  });

  it('切章即换数据源、卸载即清掉（不然上一章的线会留在这一章上）', () => {
    // 只认真调用点：文件头注释里也提到 locateChapter，按名字找会找到注释上
    const at = editor.indexOf('health.locateChapter(currentChapter)');
    expect(at).toBeGreaterThan(-1);
    const effect = editor.slice(editor.lastIndexOf('useEffect(', at), at + 600);
    expect(effect).toMatch(/currentChapter/);
    expect(effect).toMatch(/cancelled/);
  });

  it('拿不到就什么都不画，绝不因为标注打扰写作主链路', () => {
    expect(editor).toMatch(/catch[\s\S]{0,220}setHealthIssues\(null\)/);
  });

  it('关掉「行内标注」开关时两个来源一起关', () => {
    expect(editor).toMatch(/showMarks\s*\?\s*mergeMarks\(/);
  });
});

describe('C. 体检两档必须有真类名（第 20 条①那个坑：取不到就是 class="undefined"）', () => {
  it('Editor.tsx 把 warn/risk 接到 styles 上', () => {
    for (const lvl of ['warn', 'risk']) {
      expect(editor, `${lvl} 档没接上类名`).toMatch(new RegExp(`${lvl}: styles\\.${lvl}`));
    }
  });

  it('CSS 里两条规则都存在且给了下划线颜色', () => {
    for (const lvl of ['warn', 'risk']) {
      const rule = css.match(new RegExp(`\\.${lvl} \\{([^}]*)\\}`));
      expect(rule, `Editor.module.css 里没有 .${lvl}`).not.toBeNull();
      expect(rule![1], `.${lvl} 是空花括号`).not.toHaveLength(0);
      expect(rule![1]).toMatch(/text-decoration-color/);
    }
  });
});

describe('D. ★ 真库通路：正文从 chapter_bodies 读出来，坐标在同一份正文上回验', () => {
  const LONG = '这一段的字数被刻意拉长到足以让段落均长越过基线上限很多很多，末尾还补了一句。';
  const novel = `他顿了一下。\n\n${LONG}`;

  let db: DB;
  let chapters: ChapterRepo;
  let pid: string;
  let cid: string;

  const CTX: ToolContext = {
    runId: 'test',
    stepNo: 1,
    dryRun: true,
    requireCheckpoint: async () => '',
    signal: new AbortController().signal,
    logger: () => {},
  };

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    const projects = new ProjectRepo(db);
    const daily = new DailyWriteRepo(db);
    chapters = new ChapterRepo(db, daily);
    pid = projects.create('测试书', '/tmp/a').id;
    cid = chapters.createChapter(pid, { title: '第一章' }).id;
    chapters.updateBody(pid, cid, novel, chapters.get(pid, cid)?.meta.rev ?? 1);
  });

  /** 与 services.toolDeps() 同形状：getBodies 走 repo，不喂 fixture */
  function repoDeps(): ReadOnlyDeps {
    return {
      getBodies: async (ids) => chapters.getBodies(pid, ids),
      chapterTitle: () => '第一章',
      allChapterIds: async () => chapters.listMeta(pid).map((m) => m.id),
      baseline: () => ({
        source: 'test',
        metrics: {
          avgPara: {
            label: '段落均长',
            unit: '字',
            p05: 1,
            p25: 1,
            p50: 3,
            p75: 5,
            p95: 5,
            mean: 3,
            dir: 'both' as const,
          },
        },
        markerDensity: { '顿/停了一下': { p50: 0, p95: 0 } },
      }),
    };
  }

  it('库里的正文喂进去就能画出线', async () => {
    const deps = repoDeps();
    const body = (await deps.getBodies([cid])).get(cid);
    expect(body).toBe(novel);
    const res = await locateChapterIssues({ chapterId: cid }, CTX, deps);
    expect(res.ok, res.error?.message).toBe(true);
    const issues = res.data?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    const marks = marksFromLocations(issues, novel);
    expect(marks.length).toBeGreaterThan(0);
    // 每条画出来的区间都真的落在库里那份正文上
    for (const m of marks) expect(novel.slice(m.start, m.end).trim().length).toBeGreaterThan(0);
  });

  it('作者改过一个字再映射 → 一条都不画（不许把线留在别的句子上）', async () => {
    const res = await locateChapterIssues({ chapterId: cid }, CTX, repoDeps());
    const issues = res.data?.issues ?? [];
    const edited = novel.replace('他顿了一下。', '他停了一下。');
    expect(issues.length).toBeGreaterThan(0);
    expect(marksFromLocations(issues, edited)).toHaveLength(0);
  });

  it('★ 章不存在（被删了 / 切了项目）返回空而不是抛错', async () => {
    const res = await locateChapterIssues({ chapterId: '9999' }, CTX, repoDeps());
    expect(res.ok).toBe(true);
    expect(res.data?.issues).toEqual([]);
  });
});
