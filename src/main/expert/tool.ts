/**
 * 专家团工具接入。
 *
 * ★ 本文件是「可开关 + 不影响原流程性能」承诺的落地点：
 *   1. `registerExpertTool(registry, config)` —— 只在 enabled 为真时注册。
 *      关闭时工具**根本不进注册表**，Agent 的 tools 列表里就没有它，
 *      模型不会看到、原流程性能零影响（不是「注册了但不用」）。
 *   2. 只读工具（★1 danger / idempotent）—— 专家只出意见不改稿，
 *      所以幂等豁免让循环检测不会误判「合法的连续评审」。
 *   3. 预算独立 —— 不与 Agent 循环共享池子，专家评审超支不会把 Agent 带停。
 *
 * 二期接 LLM 时，只需替换 `runExpertReview` 的实现，本文件其余部分不动。
 */
import { ToolRegistry } from '../tools/registry';
import type { ToolHandler, ToolSpec } from '@shared/types/tool';
import { ToolDanger } from '@shared/types/tool';
import type {
  DimensionVerdict,
  ExpertRoleKey,
  ExpertTeamConfig,
  ReviewStage,
} from '@shared/types/expert';
import { EXPERT_ROLE_KEYS } from '@shared/types/expert';
import { activateRoles, defaultRolesFor } from './roles';
import { aggregateOpinions } from './arbitration';
import { describeFailures, runExpertReview, type ReviewerDeps } from './reviewer';

export const EXPERT_TOOL_NAME = 'consult_expert_team';

/** 评审结论的载荷（作为 ToolResult.data 回给模型与 UI） */
export interface ExpertReviewPayload {
  stage: ReviewStage;
  activatedRoles: ExpertRoleKey[];
  verdicts: DimensionVerdict[];
  summary: unknown;
  /** 缺席专家说明（降级时非空） */
  failures: { role: ExpertRoleKey; reason: string }[];
  /** 面向模型的自然语言摘要——模型读这个，不读整个 JSON */
  narration: string;
}

export interface ExpertToolDeps {
  getChapterBody: (id: string) => string;
  /** 取章节中文名：评审结果要给用户看得懂的章名，而不是裸 id */
  getChapterTitle: (id: string) => string;
  /**
   * 阶段二：LLM 评审所需的依赖。
   * 缺失时工具不注册——避免注册一个必然失败的工具污染 Agent 的工具列表。
   */
  reviewer?: ReviewerDeps;
}

const STAGES: ReviewStage[] = ['outline', 'chapter', 'post-polish'];

/** 参数校验。不用 zod，保证工具层零依赖且错误信息面向模型 */
function parseArgs(args: Record<string, unknown>): {
  stage: ReviewStage;
  chapterIds: string[];
  roles: ExpertRoleKey[];
} {
  const stage = String(args.stage ?? 'chapter') as ReviewStage;
  if (!STAGES.includes(stage)) {
    throw new Error(
      `E_INVALID_ARGS: stage 必须是 ${STAGES.join(' | ')} 之一，收到「${String(args.stage)}」`,
    );
  }
  const rawIds = Array.isArray(args.chapterIds) ? args.chapterIds : [];
  const chapterIds = rawIds.map(String).filter((s) => s.length > 0);
  if (chapterIds.length === 0) {
    throw new Error('E_INVALID_ARGS: chapterIds 不能为空，专家团需要明确的评审对象');
  }
  const rawRoles =
    Array.isArray(args.roles) && args.roles.length > 0
      ? (args.roles as unknown[]).filter((k): k is ExpertRoleKey =>
          EXPERT_ROLE_KEYS.includes(k as ExpertRoleKey),
        )
      : defaultRolesFor(stage);
  return { stage, chapterIds, roles: rawRoles };
}

function buildSpec(): ToolSpec {
  return {
    name: EXPERT_TOOL_NAME,
    displayName: '咨询专家团',
    description: [
      '让一组小说写作专家从不同视角评审章节，返回结构化的维度结论与冲突说明。',
      '',
      '用途：大纲评审（写正文前查结构漏洞）、章节评审（写完后全面体检）、',
      '润色后复检（判断润色是否真的改善了）。',
      '',
      '★ 专家只出意见，不改稿。要采纳哪些建议由你决定。',
      '★ 多位专家意见冲突时会明确标记冲突并交作者裁决——不要自己硬选一边，',
      '  这类分歧往往正是最有价值的信息。',
      '★ 同一章节同一阶段重复评审结果一致，谨慎重复调用。',
    ].join('\n'),
    params: [
      {
        name: 'stage',
        type: 'string',
        required: false,
        description: '评审阶段：outline | chapter | post-polish。不填则用 chapter。',
        enum: STAGES,
      },
      {
        name: 'chapterIds',
        type: 'string[]',
        required: true,
        description: '要评审的章节 id 列表，如 ["37"]。',
      },
      {
        name: 'roles',
        type: 'string[]',
        required: false,
        description:
          '指定激活哪些专家。不填则用该阶段默认组合' +
          '（outline=结构+类型，chapter=全部 6 个，post-polish=文字+读者）。' +
          '可选：' + EXPERT_ROLE_KEYS.join(' / '),
      },
    ],
    // ★1：只读工具——专家不改稿，意见由 Agent 或作者决定是否采纳
    danger: ToolDanger.Precise,
    reversible: false,
    maxAffectedBytes: 0,
    crossChapter: false,
    costHintMs: 45_000, // 6 个专家并行约 45s
    // ★ 幂等=true：同一目标重复评审结果一致，循环检测判据 A 豁免，
    //   否则「连续评审 3 次」会被误判成循环
    idempotent: true,
    writes: false,
  };
}

/**
 * 注册专家团工具。
 * ★ 返回 false 表示因配置关闭而未注册——调用方据此判断工具是否可用。
 */
export function registerExpertTool(
  registry: ToolRegistry,
  config: ExpertTeamConfig,
  deps: ExpertToolDeps,
): boolean {
  // ★ 三道门：任一不满足就不注册，Agent 完全看不到这个工具
  if (!config.enabled) return false;
  if (!deps.reviewer) return false; // 没有 LLM 依赖，注册了也必然失败
  // 上面已守卫，此处收窄为必存在，后续无需反复判空
  const reviewerDeps: ReviewerDeps = deps.reviewer;

  const handler: ToolHandler = async (args) => {
    const started = Date.now();
    const { stage, chapterIds, roles } = parseArgs(args as Record<string, unknown>);
    const activated = activateRoles(roles);

    if (activated.length === 0) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_INVALID_ARGS',
          message: 'roles 中没有有效角色',
          retryable: true,
          hint: '可用角色：' + EXPERT_ROLE_KEYS.join(' / '),
        },
      };
    }

    // 章节标题：结果要给用户看得懂的章名
    const labels = chapterIds.map((id) => deps.getChapterTitle(id));

    // 执行评审（内部已处理并发上限、部分失败降级、预算截断）
    const outcome = await runExpertReview(
      stage,
      chapterIds,
      activated.map((r) => r.key),
      reviewerDeps,
    );
    const { verdicts, summary } = aggregateOpinions({
      stage,
      targetIds: chapterIds,
      opinions: outcome.opinions,
      config,
      activatedRoles: activated.map((r) => r.key),
    });

    // 面向模型的自然语言摘要：冲突与待裁决项必须显式说出来，
    // 否则模型会误以为「专家都同意」而直接照单全改
    const s = summary as {
      critical: number;
      conflicted: number;
      needAuthor: number;
    };
    const parts = [
      `专家团完成评审：${labels.join('、')}，${verdicts.length} 个维度结论`,
    ];
    if (s.critical > 0) parts.push(`${s.critical} 条严重问题`);
    if (s.conflicted > 0) {
      parts.push(
        `⚠ ${s.conflicted} 处专家意见冲突（已标记，需你识别这些维度不要单方面采纳）`,
      );
    }
    if (s.needAuthor > 0) {
      parts.push(
        `⚠ ${s.needAuthor} 处裁决为 defer：专家意见对立且权重相当，` +
          `请提交给作者判断，不要自行决定`,
      );
    }
    // 降级信息必须传达给模型，否则它会以为意见是完整的
    const failNote = describeFailures(outcome.failed);
    if (failNote) parts.push(failNote);
    if (outcome.budgetTruncated) {
      parts.push('⚠ 已达评审预算上限，部分专家未评审，意见不完整');
    }

    const payload: ExpertReviewPayload = {
      stage,
      activatedRoles: activated.map((r) => r.key),
      verdicts,
      summary,
      failures: outcome.failed,
      narration: parts.join('；'),
    };

    return {
      ok: true,
      data: payload,
      durationMs: Date.now() - started,
    };
  };

  registry.registerExternal(EXPERT_TOOL_NAME, buildSpec(), handler);
  return true;
}
