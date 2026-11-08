/**
 * 选题库生命周期服务（P2-C T6）。
 *
 * 灵感线的收口一段：待立项选题 → 立项（建/开项目 + 播 premise）| 放弃（终态）。
 *
 * ★ R5 裁决（controller 预检，覆盖任务 Produces 行的 createProjectDir? 笔误）：
 *   `promoteTopic(deps:{topicId, repo, projects, projectId})` 的 **projectId 必填**——
 *   立项需先有 project 才能 setPremise/linkProject。「建/开项目」这一步归
 *   `topic:promote` IPC handler（promoteTopicIpc）：dir 来自入参，缺省走
 *   project:pick-dir 式原生目录选择（取消返回 null，不抛错），再复用
 *   services.openProject 既有流（目录幂等守卫在同项目重复打开那条断环里，
 *   不在这里另起 projects.create——同目录双行项目就是它要避免的形状），
 *   拿到 projectId 后调纯 promoteTopic 播 premise + 置已立项 + linkProject。
 * ★ 校验先行、不留半程：状态非「待立项」在写 premise **之前**抛出（E_TOPIC_STATE，
 *   口径同 TopicRepo.setStatus 的单向流转——立项/放弃是人的终局决定，不许回退改判）。
 * ★ 全局子系统：三个通道都不要求已打开项目——选题在立项之前就存在（口径同 T2 五通道）。
 * ★ 可测性：不 import electron；目录选择器与 openProject 由 register.ts 注入。
 */
import { z } from 'zod';
import { MzError } from '@shared/types/ipc';
import type { Project } from '@shared/types/project';
import type { Topic } from '@shared/types/inspiration';
import type { TopicRepo } from '../db/repos/topic-repo';
import type { ProjectRepo } from '../db/repos/chapter-repo';

/* ── 边界 zod（IPC 入参在门口拦，坏值不透传到 repo）────────────── */

const TopicStatusSchema = z.enum(['待立项', '已立项', '已放弃']);
const ListArgSchema = z.object({ status: TopicStatusSchema.optional() });
const TopicIdArgSchema = z.object({ topicId: z.string().min(1) });
const PromoteArgSchema = z.object({
  topicId: z.string().min(1),
  dir: z.string().min(1).optional(),
});

function invalid(channel: string, issue: z.ZodError): never {
  throw new MzError('E_INVALID_ARGS', `${channel} 入参非法：${issue.issues.map((i) => i.message).join('；')}`, {
    retryable: false,
  });
}

/* ── promoteTopic：纯生命周期步（R5 形，projectId 必填）─────────── */

export interface PromoteDeps {
  topicId: string;
  repo: TopicRepo;
  projects: ProjectRepo;
  projectId: string;
}

/**
 * 立项三步（一次做完，顺序即因果）：播 premise → 置已立项 → 回填 project 关联。
 * 状态闸门在读侧前置：非「待立项」直接 E_TOPIC_STATE，premise 不落半程。
 */
export function promoteTopic(deps: PromoteDeps): { projectId: string; topic: Topic } {
  const cur = deps.repo.get(deps.topicId);
  if (!cur) throw new MzError('E_TOPIC_STATE', `选题不存在：${deps.topicId}`);
  if (cur.status !== '待立项') {
    throw new MzError('E_TOPIC_STATE', `不允许的状态流转：${cur.status} → 已立项（立项只对「待立项」开放）`);
  }
  deps.projects.setPremise(deps.projectId, cur.premise);
  deps.repo.setStatus(deps.topicId, '已立项');
  const topic = deps.repo.linkProject(deps.topicId, deps.projectId);
  return { projectId: deps.projectId, topic };
}

/* ── IPC 业务函数（register.ts 一行式委托，canon-ipc 同款模式）──── */

export interface PromoteIpcDeps {
  repo: TopicRepo;
  projects: ProjectRepo;
  /** 生产注入 services.openProject（目录幂等 + project:opened 推送都在它里面） */
  openProject: (dir: string) => Promise<Project>;
  /** 生产注入原生目录选择器；取消回 null（project:pick-dir 同款口径：取消是正常结果） */
  pickDir: () => Promise<string | null>;
}

/**
 * topic:list：缺省三态全量（新在前），status 过滤直连 TopicRepo.listByStatus。
 */
export function listTopics(repo: TopicRepo, args: unknown): Topic[] {
  const parsed = ListArgSchema.safeParse(args ?? {});
  if (!parsed.success) invalid('topic:list', parsed.error);
  return repo.listByStatus(parsed.data.status);
}

/**
 * topic:promote（R5：handler 先建/开项目，再 promoteTopic 播 premise）。
 * res 为 null 的唯一路径是**用户取消目录选择**——不抛错、选题原样不动。
 */
export async function promoteTopicIpc(
  deps: PromoteIpcDeps,
  args: unknown,
): Promise<{ projectId: string; topic: Topic } | null> {
  const parsed = PromoteArgSchema.safeParse(args);
  if (!parsed.success) invalid('topic:promote', parsed.error);
  const { topicId, dir } = parsed.data;
  // 校验先行：坏选题/坏状态不开目录选择框，也不建半程项目
  const cur = deps.repo.get(topicId);
  if (!cur) throw new MzError('E_NOT_FOUND', `选题不存在：${topicId}`);
  if (cur.status !== '待立项') {
    throw new MzError('E_TOPIC_STATE', `选题「${cur.title}」当前是「${cur.status}」，只有待立项的选题可以立项`);
  }
  const chosen = dir ?? (await deps.pickDir());
  if (!chosen) return null; // 取消是正常结果（project:pick-dir 同口径），静默不记错误
  const project = await deps.openProject(chosen);
  return promoteTopic({ topicId, repo: deps.repo, projects: deps.projects, projectId: project.id });
}

/**
 * topic:abandon：待立项 → 已放弃。终态改判由 TopicRepo.setStatus 抛 E_TOPIC_STATE
 * （危险动作的 UI 二次确认在渲染层 useConfirm，这里只管状态机）。
 */
export function abandonTopic(repo: TopicRepo, args: unknown): Topic {
  const parsed = TopicIdArgSchema.safeParse(args);
  if (!parsed.success) invalid('topic:abandon', parsed.error);
  return repo.setStatus(parsed.data.topicId, '已放弃');
}
