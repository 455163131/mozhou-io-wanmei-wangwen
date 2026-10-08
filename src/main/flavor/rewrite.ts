/**
 * AI 味改写 · 局部重写引擎。
 *
 * ★ 硬约束：**只做局部重写，不做整篇重写**。
 *   整篇重写会丢掉作者的风格指纹，而风格恰恰是这个工具要保护的东西。
 *   所以本模块的所有操作都基于「命中片段的精确偏移」做定点替换，
 *   改动范围严格等于命中范围。
 *
 * ★ 两条路径的分工：
 *   - `auto-rule`：本地确定性改写，不调 LLM，可离线、可批量、零成本。
 *     适合「已知怎么改」的问题（模板连接词、套话标志词）。
 *   - `agent`：把片段 + 原因交给主 Agent 重新生成。
 *     适合「需要理解上下文才能改好」的问题（人物语气、情节衔接）。
 *   本文件只实现 `auto-rule`；`agent` 路径由 services 层构造 goal 调用 AgentHost。
 */
import type { FlavorDimension, FlavorHit, FlavorReport } from '@shared/types/ai-flavor';

/** 改写动作：把匹配到的片段替换成 `to`（空串=删除） */
export interface LocalRewrite {
  /** 替换文本。空串表示删除该片段 */
  to: string;
  /** 为什么这么改（会展示给用户） */
  why: string;
}

/**
 * 本地改写规则表。
 *
 * ★ 只收录**删除后句子仍通顺**的操作。
 *   凡是与上下文语法纠缠的（如「嘴角勾起一抹苦笑」——把「嘴角勾起」换成
 *   「笑了一下」会得到「他笑了一下一抹苦笑」这种病句），**一律不进本地规则**，
 *   交给 agent 路径。本地规则瞎改比不改更糟。
 *
 *   （这条原则是被测试实测抓出来的：最初的 replace 规则产出了病句。）
 */
export const LOCAL_REWRITE_RULES: {
  dimension: FlavorDimension;
  kind: string;
  rewrite: (matched: string) => LocalRewrite | null;
}[] = [
  {
    dimension: 'template-connector',
    kind: 'connector',
    // 书面承接词：删掉反而更顺（尾部标点由安全清理处理）
    rewrite: (m) => ({ to: '', why: `「${m}」是书面承接词，网文里删掉更自然` }),
  },
  {
    dimension: 'marker-density',
    kind: '顿了一下',
    rewrite: (m) => ({ to: '', why: `「${m}」是无信息量的停顿描写，删掉不损失情节` }),
  },
  {
    dimension: 'marker-density',
    kind: '深吸一口气',
    rewrite: (m) => ({ to: '', why: `「${m}」几乎不传递信息，删掉后动作更利落` }),
  },
  {
    dimension: 'marker-density',
    kind: '瞳孔紧缩',
    rewrite: (m) => ({ to: '', why: `「${m}」是网文套话里最被 AI 滥用的一种` }),
  },
  {
    dimension: 'marker-density',
    kind: '副词+动词',
    // ★ 只删副词、保留动词：「缓缓说道」→「说道」。
    //   整段删掉会把动词也带走，句子就废了。
    rewrite: (m) => {
      const adv = /^(缓缓|淡淡|轻轻|静静|默默|微微|幽幽|悠悠)(地)?/.exec(m);
      if (!adv) return null;
      const rest = m.slice(adv[0].length);
      return {
        to: rest,
        why: `删掉情绪副词「${adv[1]}」（「${m}」→「${rest}」），动词本身更有力`,
      };
    },
  },
];

/**
 * 安全护栏：单处删除后若产生病句，拒绝该处改动。
 *
 * ★ 这是「本地规则不瞎改」的最后一道闸。检测器给的是偏移，但**偏移是否正确、
 *   删完是否通顺**是另一回事——没有这道闸，「空气仿佛似乎凝固了」删掉匹配段后
 *   会剩下「，了。」这种残句。
 *
 * @returns 拒绝原因；null 表示通过
 */
export function rejectReason(original: string, offset: number, length: number, to: string): string | null {
  const before = original.slice(0, offset);
  const after = original.slice(offset + length);
  const result = before + to + after;

  // ① 重复/错乱标点
  if (/[，。！？；][，。！？；]/.test(result)) return '会产生重复标点';
  if (/^[，。！？；]/.test(after) && /[，。！？；]$/.test(before)) return '标点相邻冲突';

  // ② 删完后留下悬空的虚词（了/的/地/得/着/过）紧接标点
  if (to === '' && /^[了的得着过地][，。！？；]/.test(after)) {
    if (!/[了的得着过地]$/.test(before)) return '会留下悬空虚词';
  }

  // ③ 删完导致整段只剩标点
  const lineStart = Math.max(before.lastIndexOf('\n') + 1, before.lastIndexOf('。') + 1);
  const lineEnd = after.indexOf('\n');
  const tail = after.slice(0, lineEnd < 0 ? undefined : lineEnd);
  const whole = before.slice(lineStart) + to + tail;
  if (whole.replace(/[\s，。！？；：、"“”「」』『…—]/g, '').length === 0) {
    return '删除后该句只剩标点';
  }

  return null;
}

/** 单处改写的执行结果 */
export interface AppliedEdit {
  dimension: FlavorDimension;
  kind: string;
  from: string;
  to: string;
  offset: number;
  why: string;
}

export interface LocalRewriteResult {
  text: string;
  edits: AppliedEdit[];
  /** 因无本地规则或风险过高而跳过的命中数 */
  skipped: number;
  /** 被安全护栏拦下的改动（这些应改由 agent 路径处理） */
  rejected: { offset: number; reason: string }[];
}

/**
 * 执行局部改写。
 *
 * ★ 应用顺序必须**从后往前**：从后往前替换不会影响前面片段的偏移；
 *   若从前往后，每次替换都会让后面所有偏移失效（经典 off-by-N 陷阱）。
 */
export function applyLocalRewrites(
  text: string,
  hits: FlavorHit[],
  opts: { dimensions?: FlavorDimension[]; paragraphNos?: number[] } = {},
): LocalRewriteResult {
  const dimFilter = opts.dimensions && opts.dimensions.length > 0 ? new Set(opts.dimensions) : null;
  const paraFilter =
    opts.paragraphNos && opts.paragraphNos.length > 0 ? new Set(opts.paragraphNos) : null;

  interface Pending {
    offset: number;
    length: number; // 实际要替换的长度（可能因吞标点而延长）
    to: string;
    edit: AppliedEdit;
  }
  const pending: Pending[] = [];
  const rejectedEdit: { offset: number; reason: string }[] = [];
  let skipped = 0;

  for (const h of hits) {
    if (dimFilter && !dimFilter.has(h.dimension)) continue;
    if (paraFilter && !paraFilter.has(h.paragraphNo)) continue;

    const rule = LOCAL_REWRITE_RULES.find(
      (r) => r.dimension === h.dimension && r.kind === h.kind,
    );
    if (!rule) {
      skipped++; // 没有本地规则 → 留给 agent 路径
      continue;
    }

    // ★ 必须用 offset+length 从原文取，不能用带前后缀的 excerpt
    let from = text.slice(h.offset, h.offset + h.length);
    if (from.length === 0) {
      skipped++;
      continue;
    }
    const rw = rule.rewrite(from);
    if (!rw) {
      skipped++;
      continue;
    }

    let length = h.length;
    // ★ 删除时吞掉紧随其后的逗号/顿号，避免留下「，这一切」这种悬空标点
    if (rw.to === '' && /^[，、]/.test(text.slice(h.offset + length))) {
      length += 1;
      from += text.slice(h.offset + h.length, h.offset + length);
    }

    // ★ 安全护栏：删完不通顺就拒绝，宁可留着让 agent 改
    const bad = rejectReason(text, h.offset, length, rw.to);
    if (bad) {
      rejectedEdit.push({ offset: h.offset, reason: bad });
      skipped++;
      continue;
    }

    pending.push({
      offset: h.offset,
      length,
      to: rw.to,
      edit: {
        dimension: h.dimension,
        kind: h.kind,
        from,
        to: rw.to,
        offset: h.offset,
        why: rw.why,
      },
    });
  }

  // 去重 + 从后往前应用（从前往后会让后续偏移全部失效）
  const seen = new Set<number>();
  const unique = pending.filter((p) => {
    if (seen.has(p.offset)) return false;
    seen.add(p.offset);
    return true;
  });
  unique.sort((a, b) => b.offset - a.offset);

  let out = text;
  const edits: AppliedEdit[] = [];
  for (const p of unique) {
    out = out.slice(0, p.offset) + p.to + out.slice(p.offset + p.length);
    edits.push(p.edit);
  }

  edits.sort((a, b) => a.offset - b.offset);
  return { text: out, edits, skipped, rejected: rejectedEdit };
}

/**
 * 判断哪些命中「本地改不了、需要 agent」。
 * 用途：UI 上告诉用户「这 N 处需要 AI 帮忙」，而不是让用户以为自动改写没生效。
 */
export function needsAgent(hits: FlavorHit[]): FlavorHit[] {
  return hits.filter(
    (h) => !LOCAL_REWRITE_RULES.some((r) => r.dimension === h.dimension && r.kind === h.kind),
  );
}

/** 改写前后对比摘要 */
export interface RewriteDiff {
  beforeIndex: number;
  afterIndex: number;
  delta: number;
  changedCount: number;
  /** 变差的维度（局部改写也可能引入新问题，必须如实报告） */
  regressedDimensions: FlavorDimension[];
  improvedDimensions: FlavorDimension[];
}

/**
 * 对比两份报告。
 * ★ 必须能报出「变差」——局部改写真有可能按下葫芦浮起瓢
 *   （比如删掉连接词后句长变得更均匀）。只报好消息的对比是自欺。
 */
export function diffReports(before: FlavorReport, after: FlavorReport): RewriteDiff {
  const bMap = new Map(before.dimensions.map((d) => [d.dimension, d.score]));
  const improved: FlavorDimension[] = [];
  const regressed: FlavorDimension[] = [];
  for (const d of after.dimensions) {
    if (d.skipped) continue;
    const b = bMap.get(d.dimension);
    if (b === undefined) continue;
    if (d.score < b - 2) improved.push(d.dimension);
    else if (d.score > b + 2) regressed.push(d.dimension);
  }
  return {
    beforeIndex: before.index,
    afterIndex: after.index,
    delta: before.index - after.index,
    changedCount: 0,
    regressedDimensions: regressed,
    improvedDimensions: improved,
  };
}
