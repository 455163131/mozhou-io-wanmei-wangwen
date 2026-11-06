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
 *
 * ★ P2-B T7：台账两源真读——伏笔台账（LedgerRepo.foreshadows，仅未偿）与
 *   人物近况（LedgerRepo.characters + stateList，每人取最大章号快照）。
 *   装配纪律：定位不到埋设章的坏 ref **整行跳过**（debtSeries 同口径——
 *   宁可少一条，不让模型看到一条来路不明的债）；行只进 user 可压缩槽，
 *   不进 system（R45：写手 system 字节稳定纪律）。
 */
import type { Database } from 'better-sqlite3';
import { ProjectRepo, ChapterRepo } from '../db/repos/chapter-repo';
import { DraftRepo } from '../db/repos/draft-repo';
import { CanonRepo } from '../db/repos/canon-repo';
import { LedgerRepo } from '../db/repos/ledger-repo';
import { WEIGHT_VALUE } from '@shared/ledger-metrics';
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

  /* ── P2-B T7：台账两源（伏笔/人物近况）── */

  // 章 id → 故事章号：createChapter 的算号口径是「数字字符串主键」，
  // 楔子/番外这类非数字 id 不参与（它给不出「埋第几章」）。
  const chapterNoOf = new Map<string, number>();
  for (const m of new ChapterRepo(db).listMeta(projectId)) {
    const n = Number(m.id);
    if (Number.isInteger(n) && n >= 1 && String(n) === m.id) chapterNoOf.set(m.id, n);
  }
  const ledgers = new LedgerRepo(db);

  const openForeshadows: Array<{ text: string; rank: number }> = [];
  for (const fo of ledgers.foreshadows(projectId)) {
    if (fo.status === 'resolved') continue; // 已偿的债不占预算
    const plantedNo = chapterNoOf.get(fo.plantedAt?.chapterId ?? '');
    if (plantedNo === undefined) continue; // 坏 ref 整行跳过，不虚增（debtSeries 同口径）
    // 脏 weight（Agent 旧行/手工改库）一律按中性 B——与 ledger-metrics 的兜底同形
    const w = fo.weight === 'A' || fo.weight === 'C' ? fo.weight : 'B';
    openForeshadows.push({
      text: `【伏笔】${fo.name ?? '（未命名）'}（埋第${plantedNo}章·权重${w}）：${fo.chain ?? ''}`,
      rank: WEIGHT_VALUE[w],
    });
  }
  // A→C 稳定排序（Node 22 的 sort 稳定）：装配侧「保头丢尾」的硬顶收敛
  // 因此天然先落 C 档，与条目级牺牲 rank 同一方向，不打对台。
  openForeshadows.sort((a, b) => b.rank - a.rank);
  const foreshadowLines = openForeshadows.map((o) => o.text);

  // 每人取**最大章号**的快照：stateList 已按章号升序，后来者覆盖即可。
  const latestSnapshot = new Map<string, string>();
  for (const s of ledgers.stateList(projectId)) latestSnapshot.set(s.characterId, s.snapshot);
  const castLines = ledgers.characters(projectId).map((c) => {
    const knows = (c.knows ?? []).join('、') || '未登记';
    const notKnows = (c.notKnows ?? []).join('、') || '未登记';
    return `${c.name}：${latestSnapshot.get(c.id) ?? '近况未记'}｜知：${knows}｜不知：${notKnows}`;
  });

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
    // P2-B T7：台账两源真读（装配侧只消费字符串，rank/槽位归 assemble 管）
    foreshadowLines,
    castLines,
  };
}
