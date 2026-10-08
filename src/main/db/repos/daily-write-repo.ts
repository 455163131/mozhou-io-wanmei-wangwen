/**
 * 日增量账（§4 第 3 条）。
 *
 * 只回答一个问题：**作者今天写了多少字，连着写了几天**。
 * 这一条不需要发布平台——每次正文落库，本应用自己就知道净增了多少字。
 *
 * ★ 语义（与 tests/unit/daily-write-repo.test.ts 一一对应）：
 *   · 存**净增**（新字数 − 旧字数），删 500 字那天就是 −500。把删除也算"新增"
 *     会让仪表盘永远好看但永远不准。
 *   · 记账点在 `ChapterRepo.updateBody` / `insert` 内部，不在调用方。挂调用方意味着
 *     7 个 updateBody 调用点各自记得调一次，漏一个就静默少一天（本仓库反复出现的事故形状）。
 *   · `delta = 0` 不落行；连更只数 `delta > 0` 的天。
 *   · 按**本地时区**切天：「今天写没写」是作者的体感，按 UTC 切会让国内用户 08:00 才换天。
 */
import type { Database } from 'better-sqlite3';
import type { DailyPoint, DailySummary } from '@shared/types/project';

/** 零填充的本地日期字符串。字符串序 == 时间序，所以可以直接比大小、进 IN 列表 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * 按"日历日"平移，而不是减 86400000 毫秒。
 * 夏令时切换的地区（以及个别时区的历史闰秒）会让固定毫秒差落到同一天或跳过一天；
 * setDate 让 Date 自己处理，落到的一定是上一/下一天的同一时刻。
 */
function shiftDay(ms: number, by: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + by);
  return d.getTime();
}

export class DailyWriteRepo {
  constructor(private readonly db: Database) {}

  /**
   * 记一笔当日净增。
   * ★ 不抛：统计失败绝不该让一次保存失败——但也不静默吞，调用方在事务里，
   *   真出问题由事务一起回滚，不会出现"正文改了、账没改"的半状态。
   */
  recordDelta(projectId: string, delta: number, nowMs: number = Date.now()): void {
    if (!projectId) return;
    if (!Number.isFinite(delta)) return;
    const rounded = Math.round(delta);
    if (rounded === 0) return;
    this.db
      .prepare(
        'INSERT INTO daily_writes(project_id, day, delta_chars, updated_at) VALUES(?,?,?,?) ' +
          'ON CONFLICT(project_id, day) DO UPDATE SET ' +
          'delta_chars = delta_chars + excluded.delta_chars, updated_at = excluded.updated_at',
      )
      .run(projectId, dayKey(nowMs), rounded, nowMs);
  }

  /** 近 `days` 天（含 `endMs` 那天）的净增序列，缺失天补 0，按日升序 */
  series(projectId: string, days: number, endMs: number = Date.now()): DailyPoint[] {
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i -= 1) keys.push(dayKey(shiftDay(endMs, -i)));
    const byDay = this.deltas(projectId, keys);
    return keys.map((k) => ({ day: k, delta: byDay.get(k) ?? 0 }));
  }

  /**
   * 连更天数：从今天往回数连续 `delta > 0` 的天。
   * 今天为 0（刚过零点、还没写）时从昨天起算——此刻报 0 等于吓唬作者断更了。
   */
  streakDays(projectId: string, nowMs: number = Date.now()): number {
    if (!projectId) return 0;
    const rows = this.db
      .prepare('SELECT day FROM daily_writes WHERE project_id = ? AND delta_chars > 0')
      .all(projectId) as Array<{ day: string }>;
    const written = new Set(rows.map((r) => r.day));
    let cursor = nowMs;
    if (!written.has(dayKey(cursor))) cursor = shiftDay(cursor, -1);
    let n = 0;
    while (written.has(dayKey(cursor))) {
      n += 1;
      cursor = shiftDay(cursor, -1);
    }
    return n;
  }

  summary(projectId: string, nowMs: number = Date.now()): DailySummary {
    const week = this.series(projectId, 7, nowMs);
    return {
      today: week[6]?.delta ?? 0,
      yesterday: week[5]?.delta ?? 0,
      streakDays: this.streakDays(projectId, nowMs),
      week,
      monthNet: this.monthNet(projectId, nowMs),
    };
  }

  /** 本月净增：日期串零填充后可直接字符串比，[月初 key, 月末 key] 即本月 */
  private monthNet(projectId: string, nowMs: number): number {
    if (!projectId) return 0;
    const now = new Date(nowMs);
    const monthStart = dayKey(new Date(now.getFullYear(), now.getMonth(), 1, 12).getTime());
    const r = this.db
      .prepare(
        'SELECT COALESCE(SUM(delta_chars), 0) AS n FROM daily_writes ' +
          'WHERE project_id = ? AND day >= ? AND day <= ?',
      )
      .get(projectId, monthStart, dayKey(nowMs)) as { n: number };
    return r.n;
  }

  private deltas(projectId: string, keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!projectId || keys.length === 0) return out;
    const placeholders = keys.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT day, delta_chars FROM daily_writes WHERE project_id = ? AND day IN (${placeholders})`)
      .all(projectId, ...keys) as Array<{ day: string; delta_chars: number }>;
    for (const r of rows) out.set(r.day, r.delta_chars);
    return out;
  }
}
