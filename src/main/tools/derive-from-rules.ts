/**
 * 从 FIX_RULES 派生聚合工具 schema（架构 §1.5）。
 *
 * ★ 为什么是 4 个聚合工具而不是 13 个独立工具：
 *   模型调 fix_f7 再调 fix_f8 再调 fix_f9 会产生 3 轮往返，而它们同属结构层、
 *   本可一次规划完。架构原话：「不给 Agent 自由组合，而是按 targets 聚合」。
 *
 * ★ 但**规则本身仍是 13 条**，聚合格只是入口收敛。
 *   派生测试必须覆盖 F1–F13 全部 13 条 auto 规则——
 *   ⚠️ F1–F5 由 fixFromSuggestionRule() 工厂生成，源码里**不以 `{id:'F1'}` 字面量出现**，
 *   按字面量 grep 只能数出 8 条，会漏掉 F1–F5（而 F1/F4 恰好是 PRD 样例里
 *   Agent 自主选择的那两条，漏了会导致测试失败）。
 *
 * 五条转换规则（架构 §1.5）：
 *   auto:true            → 成为可调用的规则（经聚合工具暴露）
 *   auto:false + why      → **不是工具**，而是「负面知识」注入系统提示
 *   id                   → name（fix_f7）与 displayName（label）
 *   label + layer        → description 主体
 *   targets:string[]     → params的 enum 约束
 *   applies              → 前置条件 guard（不满足时返回 retryable=false）
 */
import { ToolDanger, type ToolSpec } from '@shared/types/tool';
import { autoRules, negativeRules, FIX_FAMILIES } from '../rule-engine/fix-rules';
import { METRIC_KEYS } from '@shared/constants/metrics';
import { MARKER_KEYS } from '@shared/metrics-engine';

/** 聚合工具分组：规则 id → 工具名 */
const AGG_GROUPS: Array<{
  tool: string;
  display: string;
  rules: string[];
  desc: string;
}> = [
  {
    tool: 'fix_structure',
    display: '结构层修正',
    rules: ['F6', 'F7', 'F8', 'F9', 'F10'],
    desc:
      '调整章节的节奏结构：章首公式、句长、长短交错、段落合并、长段切分。' +
      '适用于「一句话一段」「句长整齐得像节拍器」「段落过长难读」这类问题。',
  },
  {
    tool: 'fix_expression',
    display: '表达层修正',
    rules: ['F1', 'F2', 'F3', 'F4', 'F5', 'F11'],
    desc:
      '把万能表达换成具体动作：观感替代、停顿替代、置物句去重、动作三板斧、留白替代、叠词降重。' +
      '引号内的人物语言一律不动。',
  },
  {
    tool: 'fix_repetition',
    display: '重复度降重',
    rules: ['F12', 'F13'],
    desc:
      '降低用字重复与三连词重复：同义词等义轮换（仅限作者语料中真实出现过的表达）。' +
      '不改动人名、地名、金额、日期等事实锚点。',
  },
];

/** ruleId → 中文说明，供工具参数描述用 */
function ruleSummary(ruleId: string): string {
  const r = autoRules().find((x) => x.id === ruleId);
  if (!r) return ruleId;
  const targets = r.targets
    .map((t) => (t.startsWith('marker:') ? `标记「${t.slice(7)}」` : metricLabel(t)))
    .join('、');
  return `${r.label}（${targets}）`;
}

function metricLabel(key: string): string {
  const map: Record<string, string> = {
    avgSent: '平均句长',
    sentCv: '标点节奏 CV',
    avgPara: '平均段长',
    sentsPerPara: '每段句数',
    ttr: '字符级 TTR',
    bigramTtr: '二元组独特比',
    triRepeat: '3-gram 重复率',
    dialogRatio: '对白段占比',
    openType: '章首起笔类型',
  };
  return map[key] ?? key;
}

/** 某聚合工具覆盖的规则实际负责的指标集合（用于生成 metrics/markers enum） */
function targetsOf(ruleIds: string[]): { metrics: string[]; markers: string[] } {
  const metrics: string[] = [];
  const markers: string[] = [];
  for (const id of ruleIds) {
    const r = autoRules().find((x) => x.id === id);
    if (!r) continue;
    for (const t of r.targets) {
      if (t.startsWith('marker:')) {
        const name = t.slice(7);
        if (MARKER_KEYS.includes(name) && !markers.includes(name)) markers.push(name);
      } else if ((METRIC_KEYS as readonly string[]).includes(t) && !metrics.includes(t)) {
        metrics.push(t);
      }
    }
  }
  return { metrics, markers };
}

/** 派生四个聚合修正工具的 ToolSpec */
export function deriveFixToolSpecs(): ToolSpec[] {
  const out: ToolSpec[] = [];

  for (const g of AGG_GROUPS) {
    const { metrics, markers } = targetsOf(g.rules);
    const ruleList = g.rules.map((id) => `· ${id} ${ruleSummary(id)}`).join('\n');

    const params: ToolSpec['params'] = [
      {
        name: 'chapterIds',
        type: 'string[]',
        required: true,
        description: '要修改的章节 id 列表，如 ["37"]。一次最多 50 章。',
        maxLength: 50,
      },
    ];

    // 结构层用 metrics，其余用 markers；每个工具都提供对应的筛选参数
    if (metrics.length > 0) {
      params.push({
        name: 'metrics',
        type: 'string[]',
        required: false,
        description:
          `只修这些指标对应的规则；不传则修该层全部规则。可选值：${metrics.join(' | ')}。\n` +
          `该工具覆盖的规则：\n${ruleList}`,
        enum: metrics,
      });
    }
    if (markers.length > 0) {
      params.push({
        name: 'markers',
        type: 'string[]',
        required: false,
        description:
          `只修这些 AI 味标记对应的规则；不传则修该层全部规则。可选值：${markers.join(' | ')}。\n` +
          `该工具覆盖的规则：\n${ruleList}`,
        enum: markers,
      });
    }

    out.push({
      name: g.tool,
      displayName: g.display,
      description: `${g.desc}\n\n可用规则：\n${ruleList}`,
      params,
      danger: ToolDanger.Spillover,
      reversible: true,
      maxAffectedBytes: 8 * 1024,
      crossChapter: true,
      costHintMs: 800,
      idempotent: false,
      writes: true,
    });
  }

  // fix_synonym_rotation：FIX_FAMILIES 三族
  out.push({
    name: 'fix_synonym_rotation',
    displayName: '同义词等义轮换',
    description:
      '对重复出现的同义表达做等义轮换。' +
      '⚠️ 只有 place/same/inch 三族可用。' +
      '**没有 verb 族**：作者语料实测「说」出现 1356 次，而「道/问/念/应」近乎不存在，' +
      '把「说」轮换成它们等于用机器口吻覆盖作者口吻——这是刻意关闭的能力，不要尝试恢复它。',
    params: [
      {
        name: 'chapterIds',
        type: 'string[]',
        required: true,
        description: '要修改的章节 id 列表',
        maxLength: 50,
      },
      {
        name: 'families',
        type: 'string[]',
        required: false,
        description:
          '要轮换的族。不传 = 全部三族。**注意：没有 verb 族，传 verb 会被拒绝。**',
        enum: FIX_FAMILIES.map((f) => f.id),
      },
    ],
    danger: ToolDanger.Spillover,
    reversible: true,
    maxAffectedBytes: 8 * 1024,
    crossChapter: true,
    costHintMs: 600,
    idempotent: true,
    writes: true,
  });

  return out;
}

/** 负面知识文本：4 条 auto:false 的 why，供系统提示注入 */
export function negativeKnowledgeForPrompt(): string {
  const rules = negativeRules();
  if (rules.length === 0) return '';
  return [
    '以下能力**刻意不提供自动改法**，不要尝试调用工具去改它们：',
    ...rules.map((r) => `- 【${r.label}】${r.why}`),
    '',
    '如果用户要求改这些，请直接说明「这项必须作者处理」并解释原因，不要反复尝试。',
  ].join('\n');
}

/** 供测试用：某聚合工具实际覆盖的规则 id */
export function rulesOfTool(toolName: string): string[] {
  const g = AGG_GROUPS.find((x) => x.tool === toolName);
  if (g) return g.rules;
  if (toolName === 'fix_synonym_rotation') return FIX_FAMILIES.map((f) => f.id);
  return [];
}