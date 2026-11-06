// tests/integration/projects-language.test.ts
//
// P1-B T3：v14 projects.language 列 + setPipelineParams 枚举校验 +
// buildPipelineCtx 读 language 并按平台名/id 匹配 PLATFORM_RULES +
// R26：writeDraft 续写不足阈值按 language 分口径（zh=字符数，en=词数）。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@main/db/migrate';
import { ChapterRepo, ProjectRepo } from '@main/db/repos/chapter-repo';
import { DraftRepo } from '@main/db/repos/draft-repo';
import { buildPipelineCtx } from '@main/pipeline/ctx';
import { pipelineHandlers, type PipelineDeps } from '@main/pipeline/tools';
import { PLATFORM_RULES } from '@shared/constants/platforms';
import type { PipelineCtx } from '@shared/types/pipeline';

function env() {
  const db = new Database(':memory:');
  migrate(db);
  const projects = new ProjectRepo(db);
  const pid = projects.create('测试书', '/tmp/t', 300000).id;
  return { db, projects, pid };
}

describe('projects.language 列（v14）', () => {
  it('v14 后 projects 有 language 列，缺省 zh', () => {
    const { db, projects, pid } = env();
    const cols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    expect(cols.some((x) => x.name === 'language')).toBe(true);
    expect(projects.pipelineParams(pid).language).toBe('zh');
  });

  it("setPipelineParams 收 'en' 落库，缺省字段不改", () => {
    const { projects, pid } = env();
    projects.setPipelineParams(pid, { genre: '玄幻', language: 'en' });
    expect(projects.pipelineParams(pid)).toEqual({ genre: '玄幻', platform: '', chapterWords: 0, language: 'en' });
    projects.setPipelineParams(pid, { chapterWords: 2000 });
    expect(projects.pipelineParams(pid).language).toBe('en');
  });

  it("setPipelineParams 拒 'fr'（枚举外一律抛）", () => {
    const { projects, pid } = env();
    expect(() => projects.setPipelineParams(pid, { language: 'fr' as 'en' })).toThrow();
    expect(projects.pipelineParams(pid).language).toBe('zh'); // 拒后原值不动
  });

  it('buildPipelineCtx 读 language 并按平台名匹配 platformRule', () => {
    const { db, projects, pid } = env();
    projects.setPipelineParams(pid, { platform: 'Webnovel', chapterWords: 2000, language: 'en' });
    const ctx = buildPipelineCtx(db, pid);
    expect(ctx.language).toBe('en');
    expect(ctx.platformRule?.id).toBe('webnovel');
  });

  it('未匹配到规则包时 platformRule 缺省，language 缺省 zh', () => {
    const { db, projects, pid } = env();
    projects.setPipelineParams(pid, { platform: '某不存在平台' });
    const ctx = buildPipelineCtx(db, pid);
    expect(ctx.language).toBe('zh');
    expect(ctx.platformRule).toBeUndefined();
  });

  it('规则包六平台齐全：国内三 + 海外三，字段合法', () => {
    expect(PLATFORM_RULES).toHaveLength(6);
    PLATFORM_RULES.forEach((p) => {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(['cn', 'overseas']).toContain(p.market);
      expect(p.chapterWords).toBeGreaterThan(0);
    });
  });
});

/* ── R26：续写不足阈值按 language 分口径（zh=字符数，en=词数） ── */

function enHarness(queue: string[], ctxOverride: Partial<PipelineCtx> = {}) {
  const db = new Database(':memory:');
  migrate(db);
  const projects = new ProjectRepo(db);
  const pid = projects.create('测试书', '/tmp/t', 300000).id;
  const q = [...queue];
  const deps: PipelineDeps = {
    db,
    llm: { chat: async () => ({ content: q.shift() ?? '', usage: { input: 10, output: 10 } }) },
    getCtx: async () => ({
      genre: '玄幻', platform: 'Webnovel', chapterWords: 2000, targetWords: 300000,
      premise: 'p', canon: [], language: 'en', foreshadowLines: [], castLines: [],
      platformRule: PLATFORM_RULES.find((p) => p.id === 'webnovel'),
      ...ctxOverride,
    }),
    chapters: new ChapterRepo(db),
  };
  return { db, pid, drafts: new DraftRepo(db), handlers: pipelineHandlers(deps) };
}

describe('R26 续写阈值分口径', () => {
  it('en 按词数：600 词 < 2000*0.5 词 → 触发续写（zh 口径下 3k 字符会漏判）', async () => {
    const first = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    // first.length ≈ 3700 字符 > 1000（zh 口径达标），但词数 600 < 1000（en 口径不足）
    expect(first.length).toBeGreaterThan(1000);
    const { handlers } = enHarness([first, 'continued portion of the chapter']);
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as never);
    expect(res.ok).toBe(true);
    expect(res.data?.retries).toBe(1);
  });

  it('en 词数达标不续写 retries=0', async () => {
    const first = Array.from({ length: 1100 }, (_, i) => `word${i}`).join(' ');
    const { handlers } = enHarness([first]);
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as never);
    expect(res.ok).toBe(true);
    expect(res.data?.retries).toBe(0);
    expect(res.data?.shortfall).toBe(false);
  });

  it('zh 仍按字符数（现状口径不回归）', async () => {
    const { handlers } = enHarness(['短稿。', '续写部分补足本章。'], { language: 'zh', platformRule: undefined });
    const res = await handlers.writeDraft({ chapterNo: 1, planItem: { title: 't', hook: 'h' } }, {} as never);
    expect(res.ok).toBe(true);
    expect(res.data?.retries).toBe(1);
  });
});
