/**
 * 流水线上下文装配（P1-A T2：从 services.pipelineCtx 抽出的可测纯函数）。
 *
 * ★ 为什么抽出来：services 在 ELECTRON_RUN_AS_NODE 的测试环境里造不出来
 *   （要 electron 的 app.getPath），装配逻辑长在里面就一行测试都加不了。
 *   抽成 `buildPipelineCtx(db, projectId)` 后，真 SQLite 内存库即可直测。
 *
 * ★ 占位诚实（R10/T5 原语义逐字保留）：
 *   genre/platform/chapterWords 读 v12 补的 projects 真列。空串/0 = 未设定，
 *   回退占位——message 不撒谎：占位时 genre 传「未设定」是如实陈述，
 *   T6 的参数面板写入真值后这里读到的就是作者填的内容；
 *   concept/outline 来自最新 adopted 草稿，坏 JSON 视同不存在（不炸装配）。
 *
 * ★ P1-A：canon 由休眠的空数组换成真数据源——CanonRepo.list（project_canon 表，
 *   迁移 v13），按录入序进入每次装配（保护层铁律，任何环节不得与之相抵）。
 */
import type { Database } from 'better-sqlite3';
import { ProjectRepo } from '../db/repos/chapter-repo';
import { DraftRepo } from '../db/repos/draft-repo';
import { CanonRepo } from '../db/repos/canon-repo';
import type { ConceptOut, OutlineOut, PipelineCtx } from '@shared/types/pipeline';
import { ConceptSchema, OutlineSchema } from '@shared/types/pipeline';
import { PLATFORM_RULES } from '@shared/constants/platforms';

/** 从库里解析某项目的流水线上下文（纯函数：只读 db，不依赖 AppServices） */
export function buildPipelineCtx(db: Database, projectId: string): PipelineCtx {
  const projects = new ProjectRepo(db);
  const proj = projects.get(projectId);
  const params = projects.pipelineParams(projectId);
  const drafts = new DraftRepo(db);
  const adopted = drafts.list(projectId, 'adopted'); // 新稿在前，find 即最新

  let concept: ConceptOut | undefined;
  const conceptDraft = adopted.find((d) => d.kind === 'concept');
  if (conceptDraft) {
    try {
      const r = ConceptSchema.safeParse(JSON.parse(conceptDraft.content));
      if (r.success) concept = r.data;
    } catch {
      /* 坏草稿视同不存在 */
    }
  }

  let outline: OutlineOut | undefined;
  const outlineDraft = adopted.find((d) => d.kind === 'outline');
  if (outlineDraft) {
    try {
      const r = OutlineSchema.safeParse(JSON.parse(outlineDraft.content));
      if (r.success) outline = r.data;
    } catch {
      /* 坏草稿视同不存在 */
    }
  }

  return {
    genre: params.genre || '未设定',
    platform: params.platform || '未设定',
    chapterWords: params.chapterWords > 0 ? params.chapterWords : 2000,
    // 目标字数没填时给 0 会让架构师算出「全书约 1 章」——用 30 万缺省兜住
    targetWords: proj && proj.targetWords > 0 ? proj.targetWords : 300_000,
    // premise 尚无独立入口：已采纳构思的卖点是最接近的既有事实
    premise: concept?.logline ?? '',
    // P1-A：铁律真读（录入序），无条目时空数组而非 undefined
    canon: new CanonRepo(db).list(projectId).map((e) => e.text),
    // P1-B T3：language 真读（repo 已把枚举外的值收敛为 'zh'）；platformRule
    // 按平台名或 id 匹配规则包，匹配不到就缺省（prompt 不注入平台段）
    language: params.language,
    platformRule: PLATFORM_RULES.find((r) => r.name === params.platform || r.id === params.platform),
    concept,
    outline,
  };
}
