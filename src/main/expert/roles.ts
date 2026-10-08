/**
 * 专家角色注册表。
 *
 * ★ 按需加载的核心：这里只放**静态数据**，不构造任何 prompt、不发 LLM 请求。
 *   只有 `activateRoles()` 被调用且实际激活时，才会产生运行开销。
 *   六个角色全部定义在这里，但默认只有 2-3 个会被激活——
 *   「章节评审全开 6 个」是特例，不是常态。
 */
import type { ExpertRoleKey, RoleDefinition, ReviewStage } from '@shared/types/expert';
import { EXPERT_ROLE_KEYS } from '@shared/types/expert';

export const EXPERT_ROLES: Record<ExpertRoleKey, RoleDefinition> = {
  structure: {
    key: 'structure',
    displayName: '结构师',
    mission:
      '你是结构师，专注文情节结构、大纲完整性、节奏分布、卷幕张力与场景衔接。' +
      '你判断的是「故事骨架是否立得住」，不评判字句与人物性格细节。',
    focus: ['plot-structure', 'pacing', 'setting-consistency'],
    ignore: ['prose', 'dialogue'],
    defaultWeight: 1.0,
    intuitive: false,
  },

  character: {
    key: 'character',
    displayName: '人物塑造师',
    mission:
      '你是人物塑造师，专注文人物动机的合理性、性格前后是否一致、人物弧光是否完整、人物关系网是否自洽。' +
      '你判断的是「人是否立得住」，不评判句式与节奏。',
    focus: ['character', 'setting-consistency'],
    ignore: ['prose', 'pacing', 'dialogue'],
    defaultWeight: 1.0,
    intuitive: false,
  },

  dialogue: {
    key: 'dialogue',
    displayName: '对白作家',
    mission:
      '你是对白作家，专注文对白是否承担潜台词、是否千人一面、是否沦为纯粹的信息搬运。' +
      '你判断的是「台词是否有效」，不评判情节结构与描写。',
    focus: ['dialogue', 'character'],
    ignore: ['plot-structure', 'pacing', 'prose'],
    defaultWeight: 0.9,
    intuitive: false,
  },

  prose: {
    key: 'prose',
    displayName: '文字 editors',
    mission:
      '你是文字编辑，专注文病句、冗余、AI 腔、描写堆砌、感官失真等语言层问题。' +
      '你判断的是「句子是否干净」，不评判结构与人物动机。',
    focus: ['prose', 'dialogue'],
    ignore: ['plot-structure', 'pacing', 'character', 'genre-convention'],
    defaultWeight: 0.9,
    intuitive: false,
  },

  reader: {
    key: 'reader',
    displayName: '读者代表',
    mission:
      '你是读者代表，站在普通读者的角度判断：哪里会弃书、哪里爽点密集、哪里代入感强、哪里节奏拖沓。' +
      '你只报告阅读体感，不做技术性诊断——你说不清「为什么」是正常的。',
    focus: ['reader-experience', 'pacing'],
    ignore: ['prose', 'plot-structure', 'setting-consistency', 'dialogue'],
    defaultWeight: 0.8,
    // ★ intuitive=true：读者意见是「体感」而非「诊断」，与其他角色的量纲不同，
    //   维度冲突时应让位于可验证的判断，因此权重也最低。
    intuitive: true,
  },

  genre: {
    key: 'genre',
    displayName: '类型守门人',
    mission:
      '你是类型守门人，专注文本作是否符合该类型的读者预期与惯例' +
      '（系统流的金手指规则、言情的感情线推进、悬疑的线索布局等）。' +
      '你判断的是「类型读者会不会买账」，不评判文笔与微观结构。',
    focus: ['genre-convention', 'plot-structure', 'pacing'],
    ignore: ['prose', 'dialogue', 'character'],
    defaultWeight: 1.0,
    intuitive: false,
  },
};

/**
 * 按需取用：只返回被激活的角色定义。
 * 未激活的角色**不构造任何东西**，这是「按需加载」的落地点。
 */
export function activateRoles(keys: readonly ExpertRoleKey[]): RoleDefinition[] {
  const out: RoleDefinition[] = [];
  const seen = new Set<ExpertRoleKey>();
  for (const k of keys) {
    if (seen.has(k)) continue; // 防御重复传入
    seen.add(k);
    const def = EXPERT_ROLES[k];
    if (def) out.push(def);
  }
  return out;
}

/**
 * 某阶段默认激活哪些角色。
 * 刻意让三个阶段的规模不同——若每个阶段都 6 个全开，
 * 专家团会成为性能负担，用户也会因为「每次都要等 6 个人」而弃用。
 */
export function defaultRolesFor(stage: ReviewStage): ExpertRoleKey[] {
  switch (stage) {
    case 'outline':
      return ['structure', 'genre'];
    case 'chapter':
      return EXPERT_ROLE_KEYS.slice();
    case 'post-polish':
      return ['prose', 'reader'];
  }
}

/** 构造单个角色的评审提示词（仅在激活时调用） */
export function buildRolePrompt(role: RoleDefinition, targetLabel: string): string {
  const focusText = role.focus.join('、');
  const ignoreText = role.ignore.length > 0 ? role.ignore.join('、') : '（无）';
  return [
    role.mission,
    '',
    `【评审对象】${targetLabel}`,
    `【你负责的维度】${focusText}`,
    `【你不负责的维度】${ignoreText}`,
    '',
    '【输出要求】',
    '逐维度给出意见，每个维度一条，格式：',
    '{"dimension":"<维度>","severity":"critical|major|minor|nit",' +
      '"verdict":"block|suggest|endorse|neutral",' +
      '"evidence":"引用原文片段（必须逐字来自原文，不要编造）",' +
      '"suggestion":"具体可执行的改法"}',
    '',
    '★ evidence 必须逐字引用原文，不许转述或编造。',
    `★ 你不负责的维度（${ignoreText}）不要给意见；如果强烈认为有问题，在该维度外用一句话说明即可。`,
    '★ 只输出 JSON 数组，不要输出任何解释文字。',
  ].join('\n');
}
