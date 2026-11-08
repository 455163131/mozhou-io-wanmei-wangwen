// tests/unit/publish-schedule.test.ts
import { describe, it, expect } from 'vitest';
import { countUnits } from '@shared/publish/metrics';
import { resolveIntervalDays, buildQueue, validateChapter } from '@shared/publish/schedule';
import { PLATFORM_RULES } from '@shared/constants/platforms';
import type { ChapterMeta } from '@shared/types/project';

function meta(id: string, status: ChapterMeta['status']): ChapterMeta {
  return { id, projectId: 'p1', title: `章${id}`, volumeId: null, order: Number(id), status, charCount: 0, rev: 1, updatedAt: 0 };
}

describe('publish 纯函数', () => {
  it('countUnits：zh 去空白字符数 / en 非空白连串数（R26 口径对齐 tools.ts:356）', () => {
    expect(countUnits('你 好\n世界', 'zh')).toEqual({ size: 4, unit: '字' });
    expect(countUnits('hello   world\nagain', 'en')).toEqual({ size: 3, unit: 'words' });
  });
  it('resolveIntervalDays：三常量 + custom 下限 1', () => {
    expect(resolveIntervalDays('weekly', 99)).toBe(7);
    expect(resolveIntervalDays('custom', 0)).toBe(1);
    expect(resolveIntervalDays('custom', 3)).toBe(3);
  });
  it('buildQueue：todo/draft 不入队进 warnings；应发日=起+序×间隔', () => {
    const start = new Date(2026, 10, 8, 12).getTime();
    const { items, warnings } = buildQueue(
      { startAt: start, cadence: 'every2', intervalDays: 2 },
      [
        { meta: meta('1', 'done'), body: '一二三' },
        { meta: meta('2', 'draft'), body: '跳过' },
        { meta: meta('3', 'revised'), body: '四五六七八九十一二三四五' },
      ],
      PLATFORM_RULES.find((r) => r.name === '晋江'), 'zh',
    );
    expect(warnings.join()).toContain('章2');
    expect(items.map((i) => i.chapterId)).toEqual(['1', '3']);
    expect(items[1].plannedAt).toBe(start + 86400000 * 2);
    expect(items[1].minSize).toBe(5000);
    expect(items[1].meetsSize).toBe(false);
  });
  it('overseas 规则走词口径：unit=words', () => {
    const rule = PLATFORM_RULES.find((r) => r.id === 'webnovel');
    const { items } = buildQueue({ startAt: 0, cadence: 'daily', intervalDays: 1 }, [{ meta: meta('1', 'done'), body: 'a b c d e f' }], rule, 'en');
    expect(items[0].sizeUnit).toBe('words');
    expect(items[0].size).toBe(6);
  });
  it('无匹配 rule：minSize=0、validateChapter 出「平台规则未在册」不装机检', () => {
    const { items } = buildQueue({ startAt: 0, cadence: 'daily', intervalDays: 1 }, [{ meta: meta('1', 'done'), body: 'x' }], undefined, 'zh');
    expect(items[0].minSize).toBe(0);
    expect(validateChapter(items[0]).join()).toContain('未在册');
  });
  it('确定性无 DST：跨月 31 日队列逐日不差', () => {
    const start = new Date(2026, 9, 31, 12).getTime(); // 10-31
    const cs = Array.from({ length: 3 }, (_, i) => ({ meta: meta(String(i + 1), 'done' as const), body: '文'.repeat(6000) }));
    const { items } = buildQueue({ startAt: start, cadence: 'daily', intervalDays: 1 }, cs, undefined, 'zh');
    const days = items.map((i) => new Date(i.plannedAt!).getDate());
    expect(days).toEqual([31, 1, 2]);
  });
});
