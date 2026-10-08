/**
 * 只读工具实现：体检 / 报告 / 定位 / 规则表（架构 §1.6 工具 1-4）。
 *
 * 全部 ★1 Precise（只读 + 精确可还原），不落 checkpoint。
 */
import type { ToolContext, ToolResult } from '@shared/types/tool';
import type { ChapterAnalysis, AnalysisIssue, IssueLocation, RuleInfo } from '@shared/types/health';
import { analyze, judge, isSufficient, healthScore, MARKERS } from '@shared/metrics-engine';
import { MARKER_KEYS } from '@shared/metrics-engine';
import { autoRules, negativeRules } from '../../rule-engine/fix-rules';
import { snippetAround } from '@shared/util/text-zh';
import type { BaselineLike } from '../../rule-engine/plan-fixes';

export interface ReadOnlyDeps {
  /** 批量取正文 */
  getBodies: (chapterIds: string[]) => Promise<Map<string, string>>;
  /** 取章节标题（结果里要给用户看得懂的章名） */
  chapterTitle: (id: string) => string;
  /** 取全部章节 id（不传 chapterIds 时用） */
  allChapterIds: () => Promise<string[]>;
  baseline: () => BaselineLike;
}

/** 单章分析：把 metrics-engine 的输出转成 ChapterAnalysis */
export function analyzeOne(
  chapterId: string,
  body: string,
  baseline: BaselineLike,
): ChapterAnalysis {
  const a = analyze(body);
  const sufficient = isSufficient(a.chars);
  const items = judge({
    raw: a.raw,
    per1000: a.per1000,
    metrics: baseline.metrics,
    markerDensity: baseline.markerDensity,
  });

  const issues: AnalysisIssue[] = items
    .filter((i) => i.level !== 'ok')
    .map((i) => ({
      key: i.key,
      label: i.label,
      value: i.value,
      unit: i.unit,
      band: i.band,
      level: i.level,
      deviation: i.deviation,
    }));

  return {
    chapterId,
    chars: a.chars,
    paras: a.paras,
    sents: a.sents,
    raw: a.raw as unknown as Record<string, number>,
    per1000: a.per1000,
    markerHits: a.markerHits,
    openType: a.openType,
    score: healthScore(items, sufficient),
    issues,
    sufficient,
  };
}

/** 工具 1：analyze_chapter */
export async function analyzeChapter(
  args: { chapterIds?: string[] },
  _ctx: ToolContext,
  deps: ReadOnlyDeps,
): Promise<ToolResult<{ chapters: ChapterAnalysis[] }>> {
  const started = Date.now();
  try {
    const ids = args.chapterIds?.length ? args.chapterIds : await deps.allChapterIds();
    if (ids.length === 0) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_INVALID_ARGS',
          message: '项目里还没有任何章节，无法分析。',
          retryable: false,
          hint: '先让用户创建章节或导入稿件。',
        },
      };
    }

    const bodies = await deps.getBodies(ids);
    const baseline = deps.baseline();
    const chapters = ids
      .filter((id) => bodies.has(id))
      .map((id) => analyzeOne(id, bodies.get(id) as string, baseline));

    return { ok: true, data: { chapters }, durationMs: Date.now() - started };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INTERNAL',
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      },
    };
  }
}

/** 工具 2：get_health_report —— 全书体检汇总 */
export async function getHealthReport(
  args: { chapterIds?: string[] },
  _ctx: ToolContext,
  deps: ReadOnlyDeps,
): Promise<
  ToolResult<{
    baselineSource: string;
    sampleChapters: number;
    chapters: ChapterAnalysis[];
    commonIssues: Array<{ key: string; label: string; hitChapters: number; ratio: number }>;
    avgScore: number;
  }>
> {
  const started = Date.now();
  try {
    const ids = args.chapterIds?.length ? args.chapterIds : await deps.allChapterIds();
    const bodies = await deps.getBodies(ids);
    const baseline = deps.baseline();
    const chapters = ids
      .filter((id) => bodies.has(id))
      .map((id) => analyzeOne(id, bodies.get(id) as string, baseline));

    // 共性问题统计：命中率最高的指标
    const hitCount = new Map<string, { label: string; count: number }>();
    const total = chapters.length || 1;
    for (const c of chapters) {
      for (const i of c.issues) {
        const cur = hitCount.get(i.key) ?? { label: i.label, count: 0 };
        cur.count += 1;
        hitCount.set(i.key, cur);
      }
    }
    const commonIssues = [...hitCount.entries()]
      .map(([key, v]) => ({ key, label: v.label, hitChapters: v.count, ratio: v.count / total }))
      .sort((a, b) => b.hitChapters - a.hitChapters)
      .slice(0, 10);

    const scored = chapters.filter((c) => c.sufficient);
    const avgScore =
      scored.length > 0 ? scored.reduce((s, c) => s + c.score, 0) / scored.length : 0;

    return {
      ok: true,
      data: {
        baselineSource: baseline.source,
        sampleChapters: Object.keys(baseline.metrics).length,
        chapters,
        commonIssues,
        avgScore,
      },
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: { code: 'E_INTERNAL', message: String(e), retryable: true },
    };
  }
}

/** 工具 3：locate_issues —— 逐字可寻的偏移，供 UI 高亮与 Agent 定位 */
export async function locateIssues(
  args: { metric: string; chapterIds?: string[] },
  _ctx: ToolContext,
  deps: ReadOnlyDeps,
): Promise<ToolResult<{ locations: IssueLocation[] }>> {
  const started = Date.now();
  try {
    if (!args.metric) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: {
          code: 'E_INVALID_ARGS',
          message: '缺少必填参数 metric：要定位哪个指标？',
          retryable: true,
          hint: 'metric 取值见指标清单，如 avgSent / triRepeat / marker:顿/停了一下',
        },
      };
    }

    const ids = args.chapterIds?.length ? args.chapterIds : await deps.allChapterIds();
    const bodies = await deps.getBodies(ids);
    const locations: IssueLocation[] = [];

    for (const id of ids) {
      const body = bodies.get(id);
      if (body === undefined) continue;
      locations.push(...locateInChapter(id, body, args.metric));
    }

    return { ok: true, data: { locations }, durationMs: Date.now() - started };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: { code: 'E_INTERNAL', message: String(e), retryable: true },
    };
  }
}

/** 在单章内定位某指标的具体位置 */
function locateInChapter(chapterId: string, body: string, metric: string): IssueLocation[] {
  const out: IssueLocation[] = [];

  // marker 类：直接找命中位置
  if (metric.startsWith('marker:')) {
    const name = metric.slice(7);
    const re = MARKERS[name];
    if (!re) return out;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(body)) !== null) {
      out.push({
        chapterId,
        at: m.index,
        quote: snippetAround(body, m.index, 14),
        note: `命中标记「${name}」`,
      });
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
    return out;
  }

  // openType：定位首行
  if (metric === 'openType') {
    const firstLine = body.split('\n')[0] ?? '';
    const timeOpen = /^[一二三四五六七八九十百千零两0-9]+(月|号|日|年|点)/.test(firstLine.trim());
    out.push({
      chapterId,
      at: 0,
      quote: snippetAround(body, 0, 20),
      note: timeOpen
        ? '章首为「时间+地点」公式，建议把时间挪到第二段，先给画面'
        : '章首为叙述/动作起笔',
    });
    return out;
  }

  // 结构类指标：定位最长句/最长段（偏离的主要来源）
  if (metric === 'avgSent' || metric === 'sentCv') {
    // 最长的几句
    const sentences = body
      .split(/(?<=[。！？…])/)
      .map((s) => ({ s, at: body.indexOf(s) }))
      .filter((x) => x.s.trim().length > 0)
      .sort((x, y) => y.s.length - x.s.length)
      .slice(0, 3);
    for (const x of sentences) {
      out.push({
        chapterId,
        at: x.at,
        quote: snippetAround(body, x.at, 18),
        note: '较长的句子（影响句长分布）',
      });
    }
    return out;
  }
  if (metric === 'avgPara' || metric === 'sentsPerPara') {
    const paras = body.split('\n');
    // 偏移必须按文档顺序逐段累加。用 body.indexOf(段落) 反查会让重复段落
    // 的两条命中都落到首次出现处，而 at 是给 replace_phrase / UI 高亮用的。
    let offset = 0;
    const list = paras
      .map((p) => {
        const at = offset;
        offset += p.length + 1;
        return { p, at };
      })
      .sort((x, y) => y.p.length - x.p.length)
      .slice(0, 3);
    for (const x of list) {
      out.push({
        chapterId,
        at: x.at,
        quote: snippetAround(body, x.at, 18),
        note: '段落长度影响段落级指标',
      });
    }
    return out;
  }

  // 其余指标（TTR 类）：给出全书级说明，不逐句定位
  out.push({
    chapterId,
    at: 0,
    quote: snippetAround(body, 0, 20),
    note: `该指标反映全书用字多样性，无法定位到具体位置；建议用 fix_repetition 处理。`,
  });
  return out;
}

/** 工具 4：list_fix_rules —— 让 Agent 自己读规则表 */
export async function listFixRules(
  args: { layer?: string },
  _ctx: ToolContext,
): Promise<ToolResult<{ rules: RuleInfo[]; negativeKnowledge: string }>> {
  const started = Date.now();
  const filterLayer = args.layer;
  const pick = <T extends { layer: string }>(arr: T[]): T[] =>
    filterLayer ? arr.filter((r) => r.layer === filterLayer) : arr;

  const rules: RuleInfo[] = [
    ...pick(autoRules()).map((r) => ({
      id: r.id,
      label: r.label,
      layer: r.layer,
      targets: r.targets,
      auto: true,
    })),
    ...pick(negativeRules()).map((r) => ({
      id: r.id,
      label: r.label,
      layer: r.layer,
      targets: r.targets,
      auto: false,
      why: r.why,
    })),
  ];

  return {
    ok: true,
    data: {
      rules,
      negativeKnowledge:
        '标记 auto:false 的规则**没有自动改法**，其 why 说明了原因。用户若要求改这些，' +
        '请直接转述 why 并说明必须作者处理，不要尝试其它工具绕过。',
    },
    durationMs: Date.now() - started,
  };
}

export { MARKER_KEYS };