/**
 * 日增量 → 仪表盘的**装配**哨兵（§4 第 3 条）。
 *
 * 为什么单独一个文件：`DailyWriteRepo` 的行为已由 `tests/unit/daily-write-repo.test.ts`
 * 用真库钉住，但那条链还有后半段——repo 算出来的数要穿过 services.dashStats、
 * IPC 契约、preload 桥，最后落在 DashboardView 的格子里。本仓库反复出现的事故形状
 * 恰恰是「逻辑对、喂给它的是空气」：写对了一个没人调的函数等于没修。
 *
 * `AppServices` 依赖 Electron 运行期（app.getPath / safeStorage / better-sqlite3 单例），
 * 起不来真对象，所以这一层用源码哨兵钉装配——钉的是"这条链每一环都在"，
 * 不是某个函数的内部实现。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const migrate = read('src/main/db/migrate.ts');
const chapterRepo = read('src/main/db/repos/chapter-repo.ts');
const services = read('src/main/services.ts');
const ipcTypes = read('src/shared/types/ipc.ts');
const register = read('src/main/ipc/register.ts');
const preloadApi = read('src/preload/api.ts');
const preloadIndex = read('src/preload/index.ts');
const view = read('src/renderer/components/views/DashboardView.tsx');

describe('A. 迁移与记账点', () => {
  it('v8 建了 daily_writes，并给 projects 加了 price_per_k', () => {
    expect(migrate).toMatch(/version:\s*8/);
    expect(migrate).toContain('CREATE TABLE IF NOT EXISTS daily_writes');
    expect(migrate).toContain('ADD COLUMN price_per_k');
  });

  it('★ 记账点在 updateBody 内部，不在调用方（7 个调用点一个都不用来记）', () => {
    const fn = chapterRepo.slice(
      chapterRepo.indexOf('updateBody('),
      chapterRepo.indexOf('/** 批量取正文'),
    );
    expect(fn).toContain('this.dailyWrites.recordDelta(');
    // 必须在 rev 冲突抛出之后、返回之前：失败的保存不许记账
    expect(fn.indexOf("name = 'E_REVISION_CONFLICT'")).toBeLessThan(
      fn.indexOf('this.dailyWrites.recordDelta('),
    );
  });

  it('新建一章同样记账（首稿字数全是净增）', () => {
    const fn = chapterRepo.slice(
      chapterRepo.indexOf('insert(meta:'),
      chapterRepo.indexOf('/** 缓存指标'),
    );
    expect(fn).toContain('this.dailyWrites.recordDelta(');
  });

  it('DailyWriteRepo 是 ChapterRepo 的默认构造，不给"忘了传"留机会', () => {
    expect(chapterRepo).toMatch(/dailyWrites:\s*DailyWriteRepo\s*=\s*new DailyWriteRepo\(db\)/);
  });
});

describe('B. services 把日增量喂进 dashStats', () => {
  it('构造了 DailyWriteRepo 并显式传给 ChapterRepo', () => {
    expect(services).toContain('new DailyWriteRepo(');
    expect(services).toMatch(/new ChapterRepo\(this\.db,\s*this\.dailyWrites\)/);
  });

  it('dashStats 返回 daily / pricePerK / monthPay', () => {
    const start = services.indexOf('dashStats(projectId');
    const fn = services.slice(start, services.indexOf('\n  }', start));
    expect(fn).toContain('this.dailyWrites.summary(projectId)');
    expect(fn).toMatch(/\bdaily,\n/);
    expect(fn).toMatch(/\bpricePerK,\n/);
    expect(fn).toMatch(/\bmonthPay:/);
  });

  it('★ 单价为 0 时稿费必须是 0，不许拿默认单价算出一个凭空的钱数', () => {
    expect(services).toMatch(/pricePerK\s*>\s*0\s*\?/);
  });
});

describe('C. IPC 四处同步（第五节坑 3）', () => {
  it('契约里有 project:set-price', () => {
    expect(ipcTypes).toMatch(/'project:set-price':\s*\{\s*req:\s*\{\s*pricePerK:\s*number\s*\};\s*res:\s*Project\s*\}/);
    expect(ipcTypes).toContain("'project:set-price'");
  });

  it('DashStats 类型带上了 daily', () => {
    const iface = ipcTypes.slice(ipcTypes.indexOf('export interface DashStats'), ipcTypes.indexOf('export interface FlavorBaselineInfo'));
    expect(iface).toMatch(/daily:\s*DailySummary/);
    expect(iface).toMatch(/monthPay:\s*number/);
  });

  it('主进程 handle 存在且真调用 setPricePerK', () => {
    const h = register.slice(
      register.indexOf("handle('project:set-price'"),
      register.indexOf("handle('project:set-price'") + 700,
    );
    expect(register).toContain("handle('project:set-price'");
    expect(h).toMatch(/setPricePerK\(/);
    // 写通道未打开项目时抛结构化错误，不学读通道的静默口径
    expect(h).toMatch(/if \(!\w+\.project\)\s*throw new MzError\('E_INVALID_ARGS'/);
  });

  it('preload 白名单与桥都通了', () => {
    expect(preloadApi).toContain("'project:set-price'");
    expect(preloadApi).toMatch(/setPrice\(\s*pricePerK:\s*number\s*\)/);
    expect(preloadIndex).toMatch(/setPrice:\s*\(pricePerK\)\s*=>\s*invoke\('project:set-price'/);
  });
});

describe('D. 仪表盘真的显示了，而不是藏在类型里', () => {
  it('今日新增 / 连更 / 稿费三格都在渲染层取数', () => {
    expect(view).toContain('stats.daily.today');
    expect(view).toContain('stats.daily.streakDays');
    expect(view).toContain('stats.monthPay');
  });

  it('近 7 天趋势画的是 week 序列（不是又一句"待接入"）', () => {
    expect(view).toContain('stats.daily.week');
  });

  it('★ 未设单价时显示「未设单价」，不显示 ¥0', () => {
    expect(view).toMatch(/未设单价/);
    expect(view).toMatch(/pricePerK\s*>\s*0/);
  });

  it('旧的「今日新增 / 连更 / 稿费需要发布平台数据」免责句必须消失', () => {
    expect(view).not.toMatch(/今日新增 \/ 连更天数 \/ 稿费预估.{0,10}需要发布平台数据/);
  });

  it('追读率仍然如实标注需要平台数据（本地算不出来，不许造代理指标）', () => {
    expect(view).toMatch(/追读率/);
    expect(view).toMatch(/发布平台/);
  });
});
