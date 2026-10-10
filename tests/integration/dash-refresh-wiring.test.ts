/**
 * §4 第 30 条：建章 / 改稿之后，底栏统计不刷新。
 *
 * ★ 实测到的修复前事实（第一张有真数据的界面截图抓出来的）：
 *   项目开成、新建一章、粘进 289 字之后，侧栏已经显示「未分卷 / 第1章 289」，
 *   底栏却还写着「全书 0 字 · 章节 0 · 已发布/待审/草稿 0/0/0」。根子在装配：
 *   - `App.tsx:90` 的 `loadDash()` 只有**两个**调用点：`bootstrap()`（:125）与
 *     `openProject()`（:146）。建章、改名、改状态、保存正文、Agent 改稿、导入旧稿、
 *     回滚——**一条都不触发重算**。所以"启动时取一次"之后那一行数字就是死的。
 *   - 更糟的是取数点不止一个：`DashboardView.tsx:22` 自己另有一份
 *     `useState<DashStats|null>`，与底栏**各读各的**。同一个事实两个来源，
 *     正是"改了一处忘另一处"的温床——本仓库第 22~27 条反复挖的就是这个形状。
 *
 * 于是这里断三件事：A 单一取数来源；B 触发点齐全（含"关项目要清空"，
 * 否则底栏会显示上一本书的数）；C store 本身的运行时行为。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { useDashStore } from '@renderer/store';
import type { DashStats } from '@shared/types/ipc';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const rendererRoot = dirname(fileURLToPath(new URL('../../src/renderer/App.tsx', import.meta.url)));

const rendererSources = (): Array<{ rel: string; src: string }> => {
  const out: Array<{ rel: string; src: string }> = [];
  const walk = (d: string, base: string): void => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      const rel = base ? `${base}/${n}` : n;
      if (statSync(full).isDirectory()) walk(full, rel);
      else if (/\.(ts|tsx)$/.test(n)) out.push({ rel, src: readFileSync(full, 'utf8').replace(/\r\n/g, '\n') });
    }
  };
  walk(rendererRoot, '');
  return out;
};

const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('A. 同一个事实只许有一个来源', () => {
  it('aiFlavor.dashStats() 的取数点在渲染层必须恰好一处（修复前是两处：底栏 + DashboardView）', () => {
    const sites = rendererSources()
      .map((f) => ({ rel: f.rel, n: (strip(f.src).match(/dashStats\s*\(/g) ?? []).length }))
      .filter((f) => f.n > 0);
    const total = sites.reduce((a, b) => a + b.n, 0);
    expect(total, `取数点散在 ${sites.map((s) => `${s.rel}(${s.n})`).join(', ')}——底栏和仪表盘会各说一套`).toBe(1);
  });

  it('dash 必须存在 store 里，底栏与仪表盘都从它读', () => {
    const store = read('../../src/renderer/store/index.ts');
    expect(store).toMatch(/useDashStore/);
    expect(store).toMatch(/dash: DashStats \| null/);
    const app = strip(read('../../src/renderer/App.tsx'));
    expect(app, '底栏还在自己 useState 一份').not.toMatch(/useState<DashStats \| null>/);
    const dash = strip(read('../../src/renderer/components/views/DashboardView.tsx'));
    expect(dash, '仪表盘还在自己 useState 一份').not.toMatch(/useState<DashStats \| null>/);
    expect(dash).toMatch(/useDashStore/);
  });
});

describe('B. 每一条会改动统计的路径都必须触发重算', () => {
  const app = strip(read('../../src/renderer/App.tsx'));
  const stream = strip(read('../../src/renderer/hooks/use-agent-stream.ts'));

  it('章节集合变化要重算（建章 / 删章 / 改名 / 改状态 / 保存正文都收敛成 chapters 变）', () => {
    const at = app.indexOf('useDashStore');
    expect(at, 'App 没接 dash store').toBeGreaterThan(0);
    expect(
      /\}\s*,\s*\[[^\]]*chapters[^\]]*\]\s*\)/.test(app),
      '没有以 chapters 为依赖的重算 effect——建章后底栏就是死的',
    ).toBe(true);
  });

  it('Agent 改稿（chapter:changed）要重算——它不走渲染层的保存路径', () => {
    expect(stream).toMatch(/refreshDash\s*\(/);
  });

  it('打开 / 切换项目要重算（这条本来就有，别改丢了）', () => {
    expect(app).toMatch(/refreshDash\s*\(/);
  });

  it('取数失败必须把 dash 置 null，不许留着上一本书的数', () => {
    // ★ 这一条替代了"关项目要清空"——渲染层**没有**关闭项目的入口
    //   （grep -rn "project.close" src/renderer 零命中），所以 clearDash 会是死代码，
    //   不该为了凑断言而加。真会发生的谎报是：refresh 抛错后 catch 里什么都不做，
    //   底栏于是继续显示**上一本书**的字数与章数。
    const hook = strip(read('../../src/renderer/hooks/use-dash.ts'));
    const at = hook.indexOf('catch');
    expect(at, 'refreshDash 没有错误分支').toBeGreaterThan(0);
    expect(hook.slice(at, at + 260), 'catch 里没把 dash 清掉').toMatch(/setDash\(\s*null\s*\)/);
  });
});

describe('C. store 的运行时行为', () => {
  it('初值是 null（底栏据此显示「—」而不是 0），setDash 真的改状态并可清回', () => {
    useDashStore.getState().setDash(null);
    expect(useDashStore.getState().dash).toBeNull();
    // 只填这条测试要看的字段，其余留空：验的是"状态会不会跟着换"，不是 DashStats 的完整性
    useDashStore.getState().setDash({ chapterCount: 3 } as unknown as DashStats);
    expect(useDashStore.getState().dash).not.toBeNull();
    expect(useDashStore.getState().dash?.chapterCount).toBe(3);
    useDashStore.getState().setDash(null);
    expect(useDashStore.getState().dash).toBeNull();
  });
});
