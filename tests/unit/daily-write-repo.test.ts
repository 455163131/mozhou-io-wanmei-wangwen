/**
 * 日增量追踪（§4 第 3 条）。
 *
 * 修复前的现状（实测）：仪表盘只有一句「今日新增 / 连更天数 / 稿费预估需要发布平台数据，
 * 后续接入」，而 `dashStats()`（`services.ts:815`）的返回里根本没有按日的字段——
 * 库里每一章只有 `updated_at` 一个瞬时时间戳，改一次就被覆盖一次，
 * 于是"今天写了多少字"这个网文作者最核心的指标**在数据结构上就不存在**。
 * 这一条不需要发布平台：作者每敲一次保存，本应用自己就知道净增了多少字。
 *
 * ★ 语义选择（写下来，免得后人以为随手如此）：
 *   · 记的是**净增**（新字数 − 旧字数），不是"敲了多少字"。删掉 500 字那天净增是负的，
 *     这是诚实口径——把删除也算进"今日新增"会让仪表盘永远好看但永远不准。
 *   · 记账点在 `ChapterRepo.updateBody`/`insert` **内部**，不在调用方。本仓库反复出现的
 *     事故形状就是"逻辑对、喂给它的是空气"：挂在调用方意味着 7 个 updateBody 调用点
 *     要各自记得调一次，漏一个就少一天，而漏掉的那条不会报错只会静默失真。
 *   · `delta = 0` 不落行：一次没改字数的保存不该在趋势图上留下一格"今日 0 字"，
 *     更不该把连更打断成"今天写了"。
 *   · 连更（streak）从今天往回数连续 `delta > 0` 的天数；**今天为 0 时从昨天起算**，
 *     因为凌晨刚过、今天的份还没写，此刻报"连更 0 天"等于吓唬作者断更了。
 *   · 日期按**本地时区**切（`dayKey`），因为"今天写没写"本来就是作者的体感，
 *     按 UTC 切会让国内用户每天 08:00 才换天。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate, currentVersion } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DailyWriteRepo, dayKey } from '@main/db/repos/daily-write-repo';
import type { DailySummary } from '@shared/types/project';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/** 本地时区的某个时刻：m 是月份（1 起） */
const at = (m: number, d: number, h = 12): number =>
  new Date(2026, m - 1, d, h, 0, 0, 0).getTime();

let db: DB;
let projects: ProjectRepo;
let chapters: ChapterRepo;
let daily: DailyWriteRepo;
let pid: string;
let otherPid: string;

beforeEach(() => {
  db = freshDb();
  projects = new ProjectRepo(db);
  chapters = new ChapterRepo(db);
  daily = new DailyWriteRepo(db);
  pid = projects.create('测试书', '/tmp/a').id;
  otherPid = projects.create('另一本书', '/tmp/b').id;
});

/** 直接查库，绕开 repo 自己验证行真的落盘了 */
function rawRows(): Array<{ project_id: string; day: string; delta_chars: number }> {
  return db
    .prepare('SELECT project_id, day, delta_chars FROM daily_writes ORDER BY day ASC')
    .all() as Array<{ project_id: string; day: string; delta_chars: number }>;
}

function addChapter(title: string, body = ''): string {
  return chapters.insert({ id: `ch_${title}`, projectId: pid, title, volumeId: null, order: 1, status: 'draft', body }).id;
}

describe('A. dayKey：本地日期切天', () => {
  it('形如 YYYY-MM-DD 且月日补零', () => {
    expect(dayKey(at(1, 2))).toBe('2026-01-02');
    expect(dayKey(at(10, 9))).toBe('2026-10-09');
  });

  it('同一天内的两个时刻得到同一个 key（跨小时不换天）', () => {
    expect(dayKey(at(10, 9, 0))).toBe(dayKey(at(10, 9, 23)));
  });

  it('跨零点才换天', () => {
    expect(dayKey(at(10, 9, 23))).not.toBe(dayKey(at(10, 10, 0)));
  });
});

describe('B. recordDelta：按天累加', () => {
  it('同一天的两笔记成一条累加行', () => {
    daily.recordDelta(pid, 500, at(10, 9));
    daily.recordDelta(pid, 300, at(10, 9, 20));
    expect(rawRows()).toEqual([{ project_id: pid, day: '2026-10-09', delta_chars: 800 }]);
  });

  it('不同天各记一条', () => {
    daily.recordDelta(pid, 500, at(10, 8));
    daily.recordDelta(pid, 300, at(10, 9));
    expect(rawRows().map((r) => `${r.day}:${r.delta_chars}`)).toEqual([
      '2026-10-08:500',
      '2026-10-09:300',
    ]);
  });

  it('净增为负照常入账（删了字也要诚实反映）', () => {
    daily.recordDelta(pid, 500, at(10, 9));
    daily.recordDelta(pid, -200, at(10, 9, 21));
    expect(rawRows()[0].delta_chars).toBe(300);
  });

  it('★ delta = 0 不落行：没改字数的保存不该在趋势图上占一格', () => {
    daily.recordDelta(pid, 0, at(10, 9));
    expect(rawRows()).toEqual([]);
  });

  it('项目隔离：另一本书的增量不串进来', () => {
    daily.recordDelta(pid, 500, at(10, 9));
    daily.recordDelta(otherPid, 900, at(10, 9));
    expect(daily.summary(pid, at(10, 9)).today).toBe(500);
    expect(daily.summary(otherPid, at(10, 9)).today).toBe(900);
  });

  it('未打开项目 / 空 projectId 时记账直接跳过，不抛（保存不该因统计而失败）', () => {
    expect(() => daily.recordDelta('', 500, at(10, 9))).not.toThrow();
    expect(rawRows()).toEqual([]);
  });
});

describe('C. summary：今日 / 昨日 / 本周 / 本月', () => {
  it('today 与 yesterday 分别取对应日', () => {
    daily.recordDelta(pid, 500, at(10, 8));
    daily.recordDelta(pid, 800, at(10, 9));
    const s = daily.summary(pid, at(10, 9));
    expect(s.today).toBe(800);
    expect(s.yesterday).toBe(500);
  });

  it('没有记录的日子读作 0，不是 undefined', () => {
    const s = daily.summary(pid, at(10, 9));
    expect(s).toMatchObject({ today: 0, yesterday: 0, streakDays: 0, monthNet: 0 });
  });

  it('week 是含今天在内的 7 天，缺失天补 0，末项是今天', () => {
    daily.recordDelta(pid, 800, at(10, 9));
    const s = daily.summary(pid, at(10, 9));
    expect(s.week).toHaveLength(7);
    expect(s.week[6]).toEqual({ day: '2026-10-09', delta: 800 });
    expect(s.week.map((p) => p.day)).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(s.week[0].delta).toBe(0);
  });

  it('跨月不串：monthNet 只算本月', () => {
    daily.recordDelta(pid, 1000, at(9, 30));
    daily.recordDelta(pid, 400, at(10, 1));
    daily.recordDelta(pid, 600, at(10, 9));
    expect(daily.summary(pid, at(10, 9)).monthNet).toBe(1000);
  });

  it('monthNet 是净增：本月删掉的字数要扣掉', () => {
    daily.recordDelta(pid, 1000, at(10, 1));
    daily.recordDelta(pid, -300, at(10, 9));
    expect(daily.summary(pid, at(10, 9)).monthNet).toBe(700);
  });
});

describe('D. streakDays：连更', () => {
  it('连续三天都写了 → 3', () => {
    daily.recordDelta(pid, 100, at(10, 7));
    daily.recordDelta(pid, 100, at(10, 8));
    daily.recordDelta(pid, 100, at(10, 9));
    expect(daily.summary(pid, at(10, 9)).streakDays).toBe(3);
  });

  it('中间断一天 → 只数最近那段', () => {
    daily.recordDelta(pid, 100, at(10, 5));
    daily.recordDelta(pid, 100, at(10, 6));
    // 10-07 空着
    daily.recordDelta(pid, 100, at(10, 8));
    daily.recordDelta(pid, 100, at(10, 9));
    expect(daily.summary(pid, at(10, 9)).streakDays).toBe(2);
  });

  it('★ 今天还没写 → 从昨天起算，不许报 0 吓唬作者', () => {
    daily.recordDelta(pid, 100, at(10, 7));
    daily.recordDelta(pid, 100, at(10, 8));
    expect(daily.summary(pid, at(10, 9)).streakDays).toBe(2);
  });

  it('净增 ≤ 0 的那天不算更新（删字不是写）', () => {
    daily.recordDelta(pid, 100, at(10, 8));
    daily.recordDelta(pid, -50, at(10, 9));
    expect(daily.summary(pid, at(10, 9)).streakDays).toBe(1);
  });

  it('净增恰好为 0 的那天不算更新', () => {
    daily.recordDelta(pid, 100, at(10, 8));
    daily.recordDelta(pid, -100, at(10, 9));
    expect(daily.summary(pid, at(10, 9)).streakDays).toBe(1);
  });

  it('很久没写 → 0，且不从历史里翻出旧纪录', () => {
    daily.recordDelta(pid, 100, at(8, 1));
    daily.recordDelta(pid, 100, at(8, 2));
    expect(daily.summary(pid, at(10, 9)).streakDays).toBe(0);
  });
});

describe('E. 记账点在正文写入的咽喉上', () => {
  it('新建一章带正文 → 今天净增正文的字数', () => {
    addChapter('第一章', '一二三四五');
    expect(daily.summary(pid, Date.now()).today).toBe(5);
  });

  it('改正文 → 记的是净差值，不是新正文的全长', () => {
    const id = addChapter('第一章', '一'.repeat(100));
    const day = dayKey(Date.now());
    expect(daily.summary(pid, Date.now()).today).toBe(100);
    const meta = chapters.get(pid, id)!.meta;
    chapters.updateBody(pid, id, '一'.repeat(40), meta.rev);
    expect(daily.summary(pid, Date.now()).today).toBe(40);
    expect(rawRows()).toEqual([{ project_id: pid, day, delta_chars: 40 }]);
  });

  it('★ 乐观锁冲突时不落账：失败的保存不该改统计', () => {
    const id = addChapter('第一章', '一'.repeat(100));
    expect(() => chapters.updateBody(pid, id, '一'.repeat(500), 99)).toThrow();
    expect(daily.summary(pid, Date.now()).today).toBe(100);
  });

  it('删除正文（净增为负）同样入账', () => {
    const id = addChapter('第一章', '一'.repeat(100));
    const meta = chapters.get(pid, id)!.meta;
    chapters.updateBody(pid, id, '', meta.rev);
    expect(daily.summary(pid, Date.now()).today).toBe(0);
  });

  it('重排（reorder）不记账：排序不是写作', () => {
    const a = addChapter('第一章', '一'.repeat(50));
    const b = addChapter('第二章', '二'.repeat(50));
    const before = daily.summary(pid, Date.now()).today;
    chapters.reorder(pid, [b, a]);
    expect(daily.summary(pid, Date.now()).today).toBe(before);
  });

  it('换卷（setVolume）不记账', () => {
    const a = addChapter('第一章', '一'.repeat(50));
    const vol = projects.createVolume(pid, '第一卷').id;
    const before = daily.summary(pid, Date.now()).today;
    chapters.setVolume(pid, a, vol);
    expect(daily.summary(pid, Date.now()).today).toBe(before);
  });
});

describe('F. 千字单价（稿费口径）', () => {
  it('新建项目的单价默认 0（未配置就是未配置，不许猜一个数）', () => {
    expect(projects.get(pid)!.pricePerK).toBe(0);
  });

  it('setPricePerK 真的写进库（重开 repo 也读得到）', () => {
    projects.setPricePerK(pid, 45);
    expect(new ProjectRepo(db).get(pid)!.pricePerK).toBe(45);
  });

  it('单价必须是有限非负数，NaN/负数直接拒', () => {
    expect(() => projects.setPricePerK(pid, -1)).toThrow();
    expect(() => projects.setPricePerK(pid, Number.NaN)).toThrow();
  });

  it('同项目重复设置以最后一次为准', () => {
    projects.setPricePerK(pid, 45);
    projects.setPricePerK(pid, 60);
    expect(projects.get(pid)!.pricePerK).toBe(60);
  });
});

describe('G. 迁移本身', () => {
  it('迁移版本推进到至少 8，daily_writes 表建出来了', () => {
    // 不钉死等于 8：本仓库每次加迁移这里就得改一次，而这条测试真正要验收的是
    // "v8 跑过了、表在"。往后加的版本（v9 复合主键）不该让它变红。
    expect(currentVersion(db)).toBeGreaterThanOrEqual(8);
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_writes'")
      .get() as { name: string } | undefined;
    expect(t?.name).toBe('daily_writes');
  });

  it('老库升级后 projects 多出的 price_per_k 列默认 0（不是 NULL，读数不用兜底）', () => {
    const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('price_per_k');
    const r = db.prepare('SELECT price_per_k FROM projects WHERE id = ?').get(pid) as {
      price_per_k: number | null;
    };
    expect(r.price_per_k).toBe(0);
  });

  it('删项目时按 ON DELETE CASCADE 一起清掉日增量', () => {
    daily.recordDelta(pid, 500, at(10, 9));
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    expect(rawRows()).toEqual([]);
  });
});

describe('H. summary 的形状稳定（渲染层要直接吃它）', () => {
  it('返回体含全部字段，空库也是完整对象', () => {
    const s: DailySummary = daily.summary(pid, at(10, 9));
    expect(Object.keys(s).sort()).toEqual([
      'monthNet',
      'streakDays',
      'today',
      'week',
      'yesterday',
    ]);
  });
});
