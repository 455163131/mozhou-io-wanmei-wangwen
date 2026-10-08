/**
 * 裁决引擎单元测试。
 *
 * ★ 本测试不 mock 任何东西——裁决引擎是纯函数，直接喂意见验证规则命中。
 *   目标是证明「六条裁决规则每条都能真实触发」，而不是测函数不崩。
 */
import { describe, it, expect } from 'vitest';
import type {
  DimensionVerdict,
  ExpertOpinion,
  ExpertTeamConfig,
  ReviewDimension,
} from '@shared/types/expert';
import { DEFAULT_EXPERT_CONFIG } from '@shared/types/expert';
import { aggregateOpinions, compareReports } from '@main/expert/arbitration';
import { EXPERT_ROLES, activateRoles, defaultRolesFor } from '@main/expert/roles';

const cfg: ExpertTeamConfig = {
  ...DEFAULT_EXPERT_CONFIG,
  enabled: true,
  roleWeights: {},
};

function op(
  role: ExpertOpinion['role'],
  dimension: ReviewDimension,
  severity: ExpertOpinion['severity'],
  opts: { verdict?: ExpertOpinion['verdict']; suggestion?: string; evidence?: string } = {},
): ExpertOpinion {
  return {
    role,
    dimension,
    severity,
    verdict: opts.verdict ?? 'suggest',
    evidence: opts.evidence ?? '「他一步一步走过来，眼神里有些东西。」',
    suggestion: opts.suggestion ?? '把「一步一步」改为具体动作',
  };
}

function agg(opinions: ExpertOpinion[], config = cfg) {
  return aggregateOpinions({
    stage: 'chapter',
    targetIds: ['37'],
    opinions,
    config,
    activatedRoles: [...new Set(opinions.map((o) => o.role))],
  });
}

function dimOf(verdicts: readonly DimensionVerdict[], d: ReviewDimension) {
  return verdicts.find((v) => v.dimension === d);
}

// ── 角色注册表 ───────────────────────────────────────────────────────

describe('角色注册表', () => {
  it('★ 六个角色全部定义且职责边界无重叠矛盾', () => {
    expect(Object.keys(EXPERT_ROLES)).toHaveLength(6);
    for (const k of Object.keys(EXPERT_ROLES) as (keyof typeof EXPERT_ROLES)[]) {
      const r = EXPERT_ROLES[k];
      expect(r.focus.length).toBeGreaterThan(0);
      // focus 与 ignore 不应有交集，否则角色自相矛盾
      expect(r.focus.filter((d) => r.ignore.includes(d))).toEqual([]);
    }
  });

  it('★ 读者代表的 focus 覆盖了其它角色普遍 ignore 的维度（冲突可真实发生）', () => {
    // reader 与 structure 都会碰 pacing → 冲突有真实来源
    expect(EXPERT_ROLES.reader.focus).toContain('pacing');
    expect(EXPERT_ROLES.structure.focus).toContain('pacing');
  });

  it('按需加载：未激活的角色不返回定义', () => {
    const active = activateRoles(['structure', 'genre']);
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.key)).toEqual(['structure', 'genre']);
  });

  it('按需加载：重复传入去重，未知角色被丢弃而非抛错', () => {
    const active = activateRoles([
      'prose',
      'prose',
      'prose',
      'reader',
      'not-exists' as never,
    ]);
    expect(active).toHaveLength(2);
  });

  it('★ 三个阶段的默认激活规模不同（性能：不是每阶段都6 个全开）', () => {
    expect(defaultRolesFor('outline')).toHaveLength(2);
    expect(defaultRolesFor('post-polish')).toHaveLength(2);
    expect(defaultRolesFor('chapter')).toHaveLength(6);
  });
});

// ── 越界降权 ─────────────────────────────────────────────────────────

describe('越界意见降权', () => {
  it('★ 文字编辑对「结构」提意见 → 标记越界且权重被打折', () => {
    const { verdicts } = agg([op('prose', 'plot-structure', 'critical')]);
    const v = dimOf(verdicts, 'plot-structure')!;
    expect(v.opinions[0].crossBoundary).toBe(true);
    // prose 默认 0.9，越界后 ×0.3= 0.27
    expect(v.opinions[0].effectiveWeight).toBeCloseTo(0.27, 5);
  });

  it('本角色 focus 内的意见不算越界', () => {
    const { verdicts } = agg([op('prose', 'prose', 'major')]);
    expect(dimOf(verdicts, 'prose')!.opinions[0].crossBoundary).toBe(false);
    expect(dimOf(verdicts, 'prose')!.opinions[0].effectiveWeight).toBeCloseTo(0.9, 5);
  });

  it('★ 越界意见不删除，只是降权（观察仍有参考价值）', () => {
    const { verdicts } = agg([op('prose', 'plot-structure', 'major')]);
    expect(dimOf(verdicts, 'plot-structure')!.opinions).toHaveLength(1);
  });
});

// ── 规则 1：硬约束优先 ───────────────────────────────────────────────

describe('规则 1· 硬约束优先', () => {
  it('★ 严重度断层时，block 一方胜出（即使它权重更低）', () => {
    const { verdicts } = agg([
      op('reader', 'pacing', 'critical', { verdict: 'block' }),
      op('structure', 'pacing', 'nit', { verdict: 'endorse' }),
    ]);
    const v = dimOf(verdicts, 'pacing')!;
    expect(v.decision).toBe('accept');
    expect(v.conflict?.rule).toBe('hard-constraint');
    // 胜出者是 reader，尽管 structure 权重 1.0 > reader 0.8
    expect(v.opinions.find((o) => o.verdict === 'block')!.role).toBe('reader');
  });

  it('双方都是 block → 不走硬约束规则，进入后续裁决', () => {
    const { verdicts } = agg([
      op('structure', 'plot-structure', 'critical', { verdict: 'block' }),
      op('genre', 'plot-structure', 'nit', { verdict: 'block' }),
    ]);
    expect(dimOf(verdicts, 'plot-structure')!.conflict?.rule).not.toBe('hard-constraint');
  });
});

// ── 规则 2：严重度优先 ───────────────────────────────────────────────

describe('规则 2· 严重度优先', () => {
  it('★ 权重相同、严重度差≥2 → 高severity 胜出', () => {
    // structure 与 genre 权重都是 1.0
    const { verdicts } = agg([
      op('structure', 'plot-structure', 'critical'),
      op('genre', 'plot-structure', 'minor'),
    ]);
    const v = dimOf(verdicts, 'plot-structure')!;
    expect(v.conflict?.rule).toBe('severity');
  });

  it('★ 严重度差仅 1 级 → 不算冲突，走权重', () => {
    const { verdicts } = agg([
      op('structure', 'plot-structure', 'major'),
      op('genre', 'plot-structure', 'minor'),
    ]);
    const v = dimOf(verdicts, 'plot-structure')!;
    expect(v.conflict).toBeUndefined();
  });
});

// ── 规则 3：角色权重 ─────────────────────────────────────────────────

describe('规则 3· 角色权重', () => {
  it('★ 严重度断层但最高级有多方时，按权重裁决', () => {
    // 输入构造要领：必须同时满足①有断层 ②最高severity 有多方（否则规则2 先命中）
    //   dialogue 对话 0.9（major）+ prose 越界谈 character 0.27（major）+ structure nit
    const { verdicts } = agg([
      op('dialogue', 'character', 'major', { suggestion: '对白里能看出人物的犹豫' }),
      op('prose', 'character', 'major', { suggestion: '这几段人物语气不一致' }),
      op('structure', 'character', 'nit', { suggestion: '与主线关联偏弱' }),
    ]);
    const v = dimOf(verdicts, 'character')!;
    expect(v.conflict?.rule).toBe('role-weight');
    // 胜出者是权重正常的 dialogue（0.9），而非越界的 prose（0.27）
    expect(v.opinions.find((o) => (o.effectiveWeight ?? 0) > 0.5)!.role).toBe('dialogue');
  });

  it('★ 越界会把权重拉到对手之下（越界不主导裁决）', () => {
    // 与上条同构，但把prose 换成权重 1.0 的 character 看对比
    const { verdicts } = agg([
      // prose 越界谈 character（prose.ignore 含 character）→ 0.9×0.3 = 0.27
      op('prose', 'character', 'major', { suggestion: '语气不像同一个人' }),
      op('dialogue', 'character', 'major', { suggestion: '对白能体现潜台词' }),
      op('structure', 'character', 'nit', { suggestion: '支线收尾略急' }),
    ]);
    const v = dimOf(verdicts, 'character')!;
    expect(v.conflict?.rule).toBe('role-weight');
    const pro = v.opinions.find((o) => o.role === 'prose')!;
    expect(pro.crossBoundary).toBe(true);
    expect(pro.effectiveWeight).toBeCloseTo(0.27, 5);
  });

  it('★ 权重覆盖生效（配置可以把读者权重抬到压过专业角色）', () => {
    const custom: ExpertTeamConfig = {
      ...cfg,
      roleWeights: { reader: 2.0 },
    };
    const { verdicts } = agg(
      [
        op('dialogue', 'dialogue', 'major'),
        op('reader', 'dialogue', 'major'),
        op('structure', 'dialogue', 'nit'),
      ],
      custom,
    );
    const v = dimOf(verdicts, 'dialogue')!;
    expect(v.conflict?.rule).toBe('role-weight');
    expect(v.opinions.find((o) => o.role === 'reader')!.effectiveWeight).toBeCloseTo(2.0, 5);
  });
});

// ── 规则 4：类型惯例优先 ─────────────────────────────────────────────

describe('规则 4· 类型惯例优先', () => {
  it('★ 同等权重下，类型维度的分歧交给类型守门人', () => {
    // structure(1.0) 与 genre(1.0) 同权重，genre.focus 含 plot-structure
    const { verdicts } = agg([
      op('structure', 'plot-structure', 'critical', { suggestion: '重构三幕结构' }),
      op('genre', 'plot-structure', 'critical', { suggestion: '按类型惯例该在第 2 幕转折' }),
      op('dialogue', 'plot-structure', 'nit', { suggestion: '台词略密' }),
    ]);
    const v = dimOf(verdicts, 'plot-structure')!;
    expect(v.conflict?.rule).toBe('genre-instinct');
  });
});

// ── 规则 5：弃权交作者 ───────────────────────────────────────────────

describe('规则 5· 弃权交作者', () => {
  it('★ 同权重多方 + 有断层 + 无类型惯例兜底 → defer 而不是硬凑结论', () => {
    // 输入构造要领（三条同时满足才落到规则 5）：
    //   ①有严重度断层 ②最高severity 有多方（否则规则 2 先命中）
    //   ③最高权重并列（否则规则 3 先命中）且 genre 不在场（否则规则 4 先命中）
    // 另注：evidence 必须各不相同，否则会被去重逻辑合并成一条（same-evidence 的
    // 两条 dialogue 意见Jaccard 达阈值 → 只剩 1 条 → 走规则 2）。
    const { verdicts } = agg([
      op('dialogue', 'dialogue', 'major', {
        suggestion: '对白应更含蓄，不要直接说出情绪',
        evidence: '「我不生气。」她说。',
      }),
      op('prose', 'dialogue', 'major', {
        suggestion: '这句台词削弱了人物的隐忍设定',
        evidence: '「我不生气。」这句直接说破，不符合她一贯的克制。',
      }),
      op('reader', 'dialogue', 'nit', {
        suggestion: '读起来有点绕，想快进',
        evidence: '这段对话来回三句都在绕。',
      }),
    ]);
    const v = dimOf(verdicts, 'dialogue')!;
    expect(v.decision).toBe('defer');
    expect(v.conflict?.rule).toBe('defer-to-author');
    // defer 时把双方意见都摆出来，而不是随便挑一个
    expect(v.suggestion).toContain('对白作家');
  });

  it('★ defer 计入 needAuthor 统计', () => {
    const { summary } = agg([
      op('dialogue', 'dialogue', 'major', {
        suggestion: '对白应更含蓄',
        evidence: '「我不生气。」',
      }),
      op('prose', 'dialogue', 'major', {
        suggestion: '削弱人物隐忍设定',
        evidence: '这句直接说破。',
      }),
      op('reader', 'dialogue', 'nit', {
        suggestion: '读起来绕',
        evidence: '来回三句。',
      }),
    ]);
    expect(summary.needAuthor).toBe(1);
  });

  it('★ 弃权时置信度标记为「无共识」（0.5），不伪装成高置信', () => {
    const { verdicts } = agg([
      op('dialogue', 'dialogue', 'major', {
        suggestion: '对白应更含蓄',
        evidence: '「我不生气。」',
      }),
      op('prose', 'dialogue', 'major', {
        suggestion: '削弱人物隐忍设定',
        evidence: '这句直接说破。',
      }),
      op('reader', 'dialogue', 'nit', {
        suggestion: '读起来绕',
        evidence: '来回三句。',
      }),
    ]);
    expect(dimOf(verdicts, 'dialogue')!.confidence).toBe(0.5);
  });
});

// ── 无冲突路径 ───────────────────────────────────────────────────────

describe('无冲突路径', () => {
  it('★ 单一专家的意见直接采纳且无冲突标记', () => {
    const { verdicts, summary } = agg([op('prose', 'prose', 'major')]);
    const v = dimOf(verdicts, 'prose')!;
    expect(v.decision).toBe('accept');
    expect(v.conflict).toBeUndefined();
    expect(summary.conflicted).toBe(0);
  });

  it('★ 多专家同维度且无严重度断层 → 合并为一条，无冲突', () => {
    const { verdicts } = agg([
      op('prose', 'prose', 'major'),
      op('character', 'prose', 'minor'),
    ]);
    const v = dimOf(verdicts, 'prose')!;
    expect(v.decision).toBe('accept');
    expect(v.opinions).toHaveLength(2);
  });
});

// ── 去重 ─────────────────────────────────────────────────────────────

describe('同维度意见去重', () => {
  it('★ 措辞相近的同角色意见合并（不重复计数）', () => {
    const { verdicts } = agg([
      op('prose', 'prose', 'minor', { suggestion: '把「一步一步」改为具体的动作描写' }),
      op('prose', 'prose', 'minor', { suggestion: '把「一步一步」改为具体的动作描写吧' }),
    ]);
    expect(dimOf(verdicts, 'prose')!.opinions).toHaveLength(1);
  });

  it('★ 合并时保留最严severity（重复提及不降低严重度）', () => {
    const { verdicts, summary } = agg([
      op('prose', 'prose', 'minor', { suggestion: '冗余表达应当删掉' }),
      op('prose', 'prose', 'major', { suggestion: '冗余表达应当删掉' }),
    ]);
    expect(dimOf(verdicts, 'prose')!.opinions[0].severity).toBe('major');
    expect(summary.major).toBe(1);
    expect(summary.minor).toBe(0);
  });

  it('措辞不同的意见不合并', () => {
    const { verdicts } = agg([
      op('prose', 'prose', 'minor', { suggestion: '删掉「月光洒在窗台上」' }),
      op('prose', 'prose', 'minor', { suggestion: '第 5 段与第 3 段描写重复' }),
    ]);
    expect(dimOf(verdicts, 'prose')!.opinions).toHaveLength(2);
  });
});

// ── 汇总统计与排序 ───────────────────────────────────────────────────

describe('汇总统计与排序', () => {
  it('★ 按严重度降序排列，UI 不用再排', () => {
    const { verdicts } = agg([
      op('prose', 'prose', 'nit'),
      op('structure', 'plot-structure', 'critical'),
      op('character', 'character', 'major'),
    ]);
    expect(verdicts[0].dimension).toBe('plot-structure');
    expect(verdicts[1].dimension).toBe('character');
    expect(verdicts[verdicts.length - 1].dimension).toBe('prose');
  });

  it('★ 统计数字与实际意见数一致', () => {
    const { summary } = agg([
      op('structure', 'plot-structure', 'critical'),
      op('character', 'character', 'major'),
      op('prose', 'prose', 'minor'),
      op('reader', 'pacing', 'nit'),
    ]);
    expect(summary).toMatchObject({ critical: 1, major: 1, minor: 1, nit: 1 });
  });

  it('置信度在 0~1 之间', () => {
    const { verdicts } = agg([
      op('structure', 'plot-structure', 'critical'),
      op('genre', 'plot-structure', 'minor'),
    ]);
    for (const v of verdicts) {
      expect(v.confidence).toBeGreaterThanOrEqual(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('空意见不崩，返回空结论', () => {
    const { verdicts, summary } = agg([]);
    expect(verdicts).toEqual([]);
    expect(summary.critical).toBe(0);
  });
});

// ── 润色前后对照 ─────────────────────────────────────────────────────

describe('润色后对照（compareReports）', () => {
  const before = aggregateOpinions({
    stage: 'chapter',
    targetIds: ['37'],
    config: cfg,
    activatedRoles: ['prose'],
    opinions: [op('prose', 'prose', 'critical', { suggestion: '删掉重复描写' })],
  }).verdicts;

  it('★ 问题变少 → improved', () => {
    const after = aggregateOpinions({
      stage: 'post-polish',
      targetIds: ['37'],
      config: cfg,
      activatedRoles: ['prose'],
      opinions: [op('prose', 'prose', 'nit', { suggestion: '已经好了' })],
    }).verdicts;
    const delta = compareReports(before, after);
    const p = delta.find((d) => d.dimension === 'prose')!;
    expect(p.trend).toBe('improved');
  });

  it('★ 润色后出现问题 → regressed（这是「越改越差」的客观证据）', () => {
    const after = aggregateOpinions({
      stage: 'post-polish',
      targetIds: ['37'],
      config: cfg,
      activatedRoles: ['prose'],
      opinions: [op('prose', 'pacing', 'critical', { suggestion: '改完结构乱了' })],
    }).verdicts;
    const delta = compareReports(before, after);
    expect(delta.find((d) => d.dimension === 'pacing')!.trend).toBe('regressed');
  });

  it('无变化 → same', () => {
    const same = aggregateOpinions({
      stage: 'post-polish',
      targetIds: ['37'],
      config: cfg,
      activatedRoles: ['prose'],
      opinions: [op('prose', 'prose', 'critical', { suggestion: '删掉重复描写' })],
    }).verdicts;
    expect(compareReports(before, same)[0].trend).toBe('same');
  });
});
