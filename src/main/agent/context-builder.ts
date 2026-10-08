/**
 * 上下文预算管理（架构 §1.4.2 / T17）。
 *
 * 四层上下文，每层独立预算：
 *   L1 常驻系统提示 + 工具 schema + 风格指纹（不可压）
 *   L2 当前 Plan（每轮重写，已完成项合并为一行）
 *   L3 工作集：当前聚焦章节全文 + 相邻章摘要 + 账本条目（per-chapter 动态分配）
 *   L4 历史 Observation（滑窗 + 压缩）
 *
 * ★ v1.1：**per-chapter 预算按 provider 的 maxContextTokens 动态收缩**，
 *   不能沿用云端数值——本地模型窗口小一个量级（4096/8192 vs 数万），
 *   超了会直接截断或报错（架构 §6.1 第 17 条）。
 *
 * ★ 继承原型的 `truncated` 标记：某章被截断时明确告诉模型「这章没给全」，
 *   否则模型会基于不完整文本做判断而不自知。
 */
import type { ContextBudget } from '@shared/constants/budget';
import { OBSERVATION_CHARS_CAP, RECENT_OBSERVATIONS_RAW } from '@shared/constants/budget';
import type { Observation, Plan } from '@shared/types/agent';
import { analyze } from '@shared/metrics-engine';

export interface ChapterSlice {
  chapterId: string;
  title: string;
  /** 截断后的正文 */
  body: string;
  /** 是否被截断——必须回传给模型，否则模型不知道自己看的不是全文 */
  truncated: boolean;
  originalChars: number;
  /** 章节摘要（供模型决定是否要展开全文） */
  summary: string;
}

export interface ContextBuildInput {
  goal: string;
  plan: Plan | null;
  /** 聚焦章节的全文 */
  focusBodies: Array<{ chapterId: string; title: string; body: string }>;
  /** 相邻章摘要（只给摘要不给全文，省预算） */
  neighborSummaries: Array<{ chapterId: string; summary: string }>;
  observations: Observation[];
  budget: ContextBudget;
}

/**
 * per-chapter 预算分配（继承并改进原型思路）：
 *   budgetChars = floor(CHARS_BUDGET / 章节数)，下限 200 字，上限 4000 字
 *   若某章正文 > 上限 → 截断并置 truncated=true，同时标记「需二次确认」
 *   若章节数 > 50 → 只带当前章全文 + 全书级统计摘要
 */
export function allocatePerChapter(
  focusBodies: Array<{ body: string }>,
  budget: ContextBudget,
): { perChapter: number; onlyFirstChapter: boolean } {
  // 章节数超阈值时只带当前章——架构 §1.4.2 明确要求
  const onlyFirstChapter = focusBodies.length > 50;
  const divisor = onlyFirstChapter ? 1 : focusBodies.length;
  const perChapter = Math.max(
    budget.perChapterFloor,
    Math.min(budget.perChapterCap, Math.floor(budget.l3Chars / Math.max(1, divisor))),
  );
  return { perChapter, onlyFirstChapter };
}

/** 章节摘要：纯统计 + 开头结尾摘句（确定性，不用模型，省 token） */
export function summarizeChapter(chapterId: string, title: string, body: string): string {
  const a = analyze(body);
  const firstSentence = body.split(/[。！？…]/)[0]?.slice(0, 40) ?? '';
  const lastSentence = body.split(/[。！？…]/).filter(Boolean).pop()?.slice(0, 40) ?? '';
  return (
    `【第${chapterId}章 ${title}】${a.chars}字 / ${a.paras}段 / 平均句长${a.raw.avgSent.toFixed(1)}字 / ` +
    `对白${(a.raw.dialogRatio * 100).toFixed(0)}%。开头：「${firstSentence}…」结尾：「…${lastSentence}」`
  );
}

export function buildContext(input: ContextBuildInput): {
  system: string;
  user: string;
  truncatedChapters: string[];
  estimatedChars: number;
} {
  const { budget, observations } = input;
  const parts: string[] = [];

  // ── L2 计划 ──
  if (input.plan) {
    const lines = input.plan.steps
      .map((s) => `${s.index}. ${s.intent}${s.rationale ? `（理由：${s.rationale}）` : ''}`)
      .join('\n');
    const skipped =
      input.plan.explicitlySkipped && input.plan.explicitlySkipped.length > 0
        ? `\n已决定不做：\n${input.plan.explicitlySkipped.map((s) => `- ${s.what}：${s.why}`).join('\n')}`
        : '';
    parts.push(`## 当前计划\n目标：${input.plan.goalRestated}\n${lines}${skipped}`);
  }

  // ── L3 工作集 ──
  const { perChapter, onlyFirstChapter } = allocatePerChapter(input.focusBodies, budget);
  const truncatedChapters: string[] = [];
  const bodyParts: string[] = [];

  const toShow = onlyFirstChapter ? input.focusBodies.slice(0, 1) : input.focusBodies;
  for (const c of toShow) {
    const stripped = c.body.replace(/\s/g, '');
    const willTruncate = stripped.length > perChapter;
    const body = willTruncate ? c.body.slice(0, perChapter) : c.body;
    if (willTruncate) truncatedChapters.push(c.chapterId);
    bodyParts.push(
      willTruncate
        ? `### 第${c.chapterId}章 ${c.title}（⚠️ 已截断：原文 ${stripped.length} 字，此处仅给前 ${perChapter} 字。` +
          `若需要看后半部分，请说明，我会重新读取。）\n${body}`
        : `### 第${c.chapterId}章 ${c.title}（全文 ${stripped.length} 字）\n${body}`,
    );
  }

  if (input.neighborSummaries.length > 0) {
    const summaries = input.neighborSummaries
      .slice(0, onlyFirstChapter ? 10 : 20)
      .map((s) => s.summary)
      .join('\n');
    bodyParts.push(`### 相邻章节摘要（仅摘要，非全文）\n${summaries}`);
  }

  parts.push(`## 正文\n\n${bodyParts.join('\n\n')}`);

  // ── L4 历史：最近 6 步保留原文，更早的压缩为一行 ──
  if (observations.length > 0) {
    const recent = observations.slice(-RECENT_OBSERVATIONS_RAW);
    const older = observations.slice(0, -RECENT_OBSERVATIONS_RAW);
    const recentLines = recent.map((o) => {
      const s = o.summary.length > OBSERVATION_CHARS_CAP
        ? `${o.summary.slice(0, OBSERVATION_CHARS_CAP)}…`
        : o.summary;
      return `- 步${o.stepNo} ${o.toolName}（${o.ok ? '成功' : '失败'}，${(o.durationMs / 1000).toFixed(1)}s）：${s}`;
    });
    // 规则压缩（架构 §5.2 V5：先做规则压缩，不够再加模型摘要——省 token）
    const olderLines = older.map(
      (o) => `步${o.stepNo} ${o.toolName} → ${o.ok ? '完成' : '失败'}，${(o.durationMs / 1000).toFixed(1)}s`,
    );
    const history = [...olderLines, ...recentLines].join('\n');
    parts.push(`## 已执行步骤（历史）\n${history}`);
  }

  const user = parts.join('\n\n');

  return {
    user,
    system: '',
    truncatedChapters,
    estimatedChars: user.length,
  };
}

/**
 * 压缩 Observation 为一行（供轨迹面板与历史压缩共用）。
 */
export function compressObservation(o: Observation): string {
  const status = o.ok ? '✓' : '✗';
  const secs = (o.durationMs / 1000).toFixed(1);
  const attempts = o.attempts && o.attempts.length > 0 ? ` 尝试:${o.attempts.join('→')}` : '';
  return `步${o.stepNo} ${status} ${o.toolName}(${secs}s) ${o.summary}${attempts}`;
}