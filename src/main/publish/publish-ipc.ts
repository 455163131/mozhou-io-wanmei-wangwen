/**
 * 发布排期五通道的业务实现（P2-D T6，spec §6/§7）。
 *
 * 队列不入库——publish:queue 每次由「章节库内序 + 节奏」纯函数推导（P2D-R1：
 * 体量机检对 en 书必须数词，渲染层拿不到正文就不许装算得出，推导放服务端）。
 * 批准即提交（P2D-R2）——publish:stage 的 chapterIds 就是已批准集；服务端对每章
 * **独立再清洗**（与页面预览同一个 cleanForPublish、同入参，但各算各的，
 * 不信任客户端送来的任何清洗结果）→ 只写项目根 staging/<platformId>/ 下的
 * 暂存新文件（resolveInProject 兜路径边界），**不发起任何网络请求、永不改正文库行**。
 * 已发布章不许悄悄换稿：先 listByPlan 建 published 集把这类 id 路由进 skipped
 * （文件一字不动）；StagingRepo 抛 E_STAGING_STATE 是第二道闸——mark 未暂存路径
 * 走的就是这道抛。两道的行为各钉在 tests/unit/publish-ipc.test.ts 与
 * tests/unit/staging-repo.test.ts，双保险都有活证据。
 *
 * register.ts 只做一行式委托（canon/overlay/inspiration/export 同款模式），
 * 行为用例直测本模块函数（:memory: 真库 + mkdtemp 项目根）。
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { MzError } from '@shared/types/ipc';
import { PLATFORM_RULES, type PlatformRule } from '@shared/constants/platforms';
import { buildQueue } from '@shared/publish/schedule';
import { cleanForPublish } from '@shared/publish/clean';
import type {
  PublishPlan,
  PublishQueueRes,
  StageOutcome,
  StagedEntry,
  SkippedEntry,
  StagingRow,
} from '@shared/types/publish';
import type { PublishPlanRepo } from '../db/repos/publish-plan-repo';
import type { StagingRepo } from '../db/repos/staging-repo';
import type { ChapterRepo, ProjectRepo } from '../db/repos/chapter-repo';
import { ensureDir, atomicWrite, resolveInProject } from '../fs/project-fs';

/** 当前打开项目的最小面（AppServices 结构化满足；platform/language 不在此形，读 pipelineParams） */
export interface PublishProject {
  id: string;
  name: string;
  rootDir: string;
}

/** register.ts 从 AppServices.publishDeps() 拼出的最小依赖面（getProject 为 null = 未打开项目） */
export interface PublishIpcDeps {
  getProject: () => PublishProject | null;
  plans: PublishPlanRepo;
  staging: StagingRepo;
  chapters: ChapterRepo;
  projects: ProjectRepo;
}

/* ── 边界 zod（IPC 入参在门口拦，坏值不透传到 repo/磁盘；invalid() 口径同 inspiration-ipc）── */

const PlanSaveSchema = z
  .object({
    id: z.string().min(1).optional(),
    platform: z.string().min(1),
    cadence: z.enum(['daily', 'every2', 'weekly', 'custom']),
    intervalDays: z.number().int().min(1).optional(),
    startAt: z.number().int().nonnegative(),
  })
  .refine((p) => p.cadence !== 'custom' || p.intervalDays !== undefined, {
    message: 'cadence=custom 必须带 intervalDays（≥1 整数）',
  });
const PlanListSchema = z.object({ includeArchived: z.boolean().optional() });
const PlanIdSchema = z.object({ planId: z.string().min(1) });
const StageSchema = z.object({
  planId: z.string().min(1),
  chapterIds: z.array(z.string().min(1)).min(1),
});
const MarkSchema = z.object({ planId: z.string().min(1), chapterId: z.string().min(1) });

function invalid(channel: string, issue: z.ZodError): never {
  throw new MzError('E_INVALID_ARGS', `${channel} 入参非法：${issue.issues.map((i) => i.message).join('；')}`, {
    retryable: false,
  });
}

function parse<T extends z.ZodTypeAny>(schema: T, channel: string, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) invalid(channel, parsed.error);
  return parsed.data;
}

function requireProject(deps: PublishIpcDeps, channel: string): PublishProject {
  const project = deps.getProject();
  if (!project) throw new MzError('E_INVALID_ARGS', `${channel}：未打开项目`);
  return project;
}

/**
 * plan 归属闸：不存在与不属于当前项目**同码同形**（E_NOT_FOUND）——
 * 他书计划 id 不喂本页任何读写，也不外泄「它存在但属于别书」这种侧信道。
 */
function requirePlan(deps: PublishIpcDeps, project: PublishProject, planId: string): PublishPlan {
  const plan = deps.plans.get(planId);
  if (!plan || plan.projectId !== project.id) {
    throw new MzError('E_NOT_FOUND', `排期计划不存在或不属于当前项目：${planId}`);
  }
  return plan;
}

/**
 * 平台规则匹配：`r.id===platform || r.name===platform` 双判——与 buildPipelineCtx
 * 同式（P2D anchor：project.platform 可能存展示名也可能存 id，历史口径二者收）。
 * publish_plans.platform 写侧过 repo 白名单恒为 id，双判是读侧防御。
 */
function ruleFor(platform: string): PlatformRule | undefined {
  return PLATFORM_RULES.find((r) => r.id === platform || r.name === platform);
}

/** 文件系统名里的非法字符集（Windows 保留 + 路径分隔），口径同 export-ipc */
const ILLEGAL_NAME_CHARS = '\\/:*?"<>|';

/**
 * 章文件名前缀：章 id 的数字形零填充四位（'1'→'0001'）；
 * 非数字 id（插章 '10.5' 之类）parseInt 取整数部分，NaN 兜队列序 ord。
 */
function pad4(chapterId: string, ord: number): string {
  const n = Number.parseInt(chapterId, 10);
  return String(Number.isNaN(n) ? ord : n).padStart(4, '0');
}

/** 标题安全化：剥 Windows/POSIX 非法字符与控制字符（charCodeAt 判 <0x20，不用控制字符正则——lint 明令），空白标题兜「章+id」 */
function safeTitle(raw: string, chapterId: string): string {
  const cleaned = [...raw]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && !ILLEGAL_NAME_CHARS.includes(ch))
    .join('')
    .trim();
  return cleaned || `章${chapterId}`;
}

/* ── publish:plan-save / plan-list ─────────────────────────────── */

/**
 * 存计划（新建/编辑一个入口）。★ projectId **服务端取当前项目**——req 不收，
 * 越权他书 by construction 不可能；带 id 编辑先过归属闸（不许把别书计划搬进本书）。
 * intervalDays 只在 custom 时被采信，其余节奏由 repo 按 CADENCE_DAYS 派生（一处来源）。
 */
export function savePlanIpc(deps: PublishIpcDeps, args: unknown): PublishPlan {
  const parsed = parse(PlanSaveSchema, 'publish:plan-save', args);
  const project = requireProject(deps, 'publish:plan-save');
  if (parsed.id) requirePlan(deps, project, parsed.id);
  return deps.plans.upsert({
    ...(parsed.id ? { id: parsed.id } : {}),
    projectId: project.id,
    platform: parsed.platform,
    cadence: parsed.cadence,
    // 非 custom 时 repo 忽略这个占位、按节奏派生；custom 时 zod 已保证有值
    intervalDays: parsed.intervalDays ?? 0,
    startAt: parsed.startAt,
  });
}

/** 当前项目的计划清单（archived 由 req 透传，缺省滤掉——终态不进日常视图）。 */
export function listPlansIpc(deps: PublishIpcDeps, args: unknown): PublishPlan[] {
  const parsed = parse(PlanListSchema, 'publish:plan-list', args ?? {});
  const project = requireProject(deps, 'publish:plan-list');
  return deps.plans.listByProject(project.id, parsed.includeArchived ?? false);
}

/* ── publish:queue（服务端推导入队）────────────────────────────── */

/** 库内序的 meta+body 配对 + 队列推导——queue/stage 共用一份，两处永远同题。 */
function queueInputs(deps: PublishIpcDeps, project: PublishProject, plan: PublishPlan) {
  const metas = deps.chapters.listMeta(project.id);
  const bodies = deps.chapters.getBodies(
    project.id,
    metas.map((m) => m.id),
  );
  const rule = ruleFor(plan.platform);
  // language 经 pipelineParams 真列读（P2D anchor：不新开列不新开 getter）
  const lang = deps.projects.pipelineParams(project.id).language;
  const built = buildQueue(
    { startAt: plan.startAt, cadence: plan.cadence, intervalDays: plan.intervalDays },
    metas.map((meta) => ({ meta, body: bodies.get(meta.id) ?? '' })),
    rule,
    lang,
  );
  return { metas, bodies, rule, built };
}

/**
 * 推导队列 + 跳过警告。plan 不存在/非本项目 → E_NOT_FOUND（归属闸）。
 * 平台规则不在册（手工改库等极端形）时如实追加 warning——不悄悄按默认目标算。
 */
export function queueIpc(deps: PublishIpcDeps, args: unknown): PublishQueueRes {
  const parsed = parse(PlanIdSchema, 'publish:queue', args);
  const project = requireProject(deps, 'publish:queue');
  const plan = requirePlan(deps, project, parsed.planId);
  const { rule, built } = queueInputs(deps, project, plan);
  const warnings = [...built.warnings];
  if (!rule) warnings.push(`平台规则未在册：${plan.platform}——体量目标按 0 处理，请人工核对`);
  return { plan, items: built.items, warnings };
}

/* ── publish:stage（批准即提交 + 服务端独立再清洗 + 项目内暂存写）── */

/**
 * 对每个被批准的 id：
 *   章不存在 → skipped「章节不存在」；published 集命中 → skipped「已发布不许换稿」
 *   （前置路由，不走到 repo 抛，已写文件一字不动）；不在队列（非 revised/done）
 *   → skipped「未定稿（需 revised/done）」；否则 cleanForPublish(market) 独立再清洗
 *   → staging/<platformId>/<pad4>_<safeTitle>.txt 原子写 → upsertStaged(hash=sha256(cleaned))。
 * 写永远只落项目根内（resolveInProject 兜底），%APPDATA% 与正文库行都不碰。
 */
export async function stageIpc(deps: PublishIpcDeps, args: unknown): Promise<StageOutcome> {
  const parsed = parse(StageSchema, 'publish:stage', args);
  const project = requireProject(deps, 'publish:stage');
  const plan = requirePlan(deps, project, parsed.planId);
  const { metas, bodies, rule, built } = queueInputs(deps, project, plan);
  const market = rule?.market ?? 'cn'; // 规则不在册按 cn 兜底（queueIpc 已把这件事 warn 过）
  const metaById = new Map(metas.map((m) => [m.id, m]));
  const queued = new Map(built.items.map((i) => [i.chapterId, i]));
  const published = new Set(
    deps.staging
      .listByPlan(plan.id)
      .filter((r) => r.publishedAt !== null)
      .map((r) => r.chapterId),
  );
  const platformId = plan.platform.toLowerCase();
  const staged: StagedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const chapterId of parsed.chapterIds) {
    const meta = metaById.get(chapterId);
    if (!meta) {
      skipped.push({ chapterId, reason: `章节不存在：${chapterId}` });
      continue;
    }
    if (published.has(chapterId)) {
      skipped.push({ chapterId, reason: '已发布不许换稿（工具不悄悄改历史，要改请新章或人工处理）' });
      continue;
    }
    const item = queued.get(chapterId);
    if (!item) {
      skipped.push({ chapterId, reason: '未定稿（需 revised/done）' });
      continue;
    }
    const { cleaned, edits } = cleanForPublish(bodies.get(chapterId) ?? '', market);
    const fileName = `${pad4(chapterId, item.ord)}_${safeTitle(meta.title, chapterId)}.txt`;
    const fullPath = resolveInProject(project.rootDir, join('staging', platformId, fileName));
    await ensureDir(dirname(fullPath));
    await atomicWrite(fullPath, cleaned);
    const contentHash = createHash('sha256').update(cleaned, 'utf8').digest('hex');
    deps.staging.upsertStaged(plan.id, chapterId, contentHash);
    staged.push({ chapterId, path: fullPath, contentHash, edits: edits.length });
  }
  return { staged, skipped };
}

/* ── publish:mark-published（人工发布回执，非自动）──────────────── */

/**
 * 人工标记「这一章我确实发出去了」。repo 状态机：未暂存 → E_STAGING_STATE 直抛
 * （这就是双保险里那道 repo 抛在 publish-ipc 侧的可达路径）；重复标记幂等回原
 * publishedAt——重试不打乱发布时刻。plan 先过归属闸。
 */
export function markPublishedIpc(deps: PublishIpcDeps, args: unknown): StagingRow {
  const parsed = parse(MarkSchema, 'publish:mark-published', args);
  const project = requireProject(deps, 'publish:mark-published');
  requirePlan(deps, project, parsed.planId);
  return deps.staging.markPublished(parsed.planId, parsed.chapterId);
}
