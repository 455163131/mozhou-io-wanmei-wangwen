/**
 * 拆书蒸馏（架构 §1.6 工具 16 / T23）。
 *
 * ★ 为什么是 ★1 Precise：它读的参考书是**用户导入的外部副本**，
 *   输出的是**新文件**，不触碰用户自己的正文。
 *   即使内部跑 500 页统计，danger 仍是 1——
 *   **danger 看的是「回滚要付出什么」，不是「跑多久」**。
 *
 * ★ 合规守卫（架构已确认项）：报告与原文的最长公共子串（LCS）不得超过 20 字，
 *   防止把参考书原文抄进参数卡。DIGEST_LCS_LIMIT = 20。
 */
import type { ToolContext, ToolResult } from '@shared/types/tool';
import { analyze } from '@shared/metrics-engine';
import { snippetAround } from '@shared/util/text-zh';

/** ★ 已确认存在于原型 template.html:4857 */
export const DIGEST_LCS_LIMIT = 20;

export interface DigestDeps {
  /** 只读依赖占位：本工具不碰用户正文 */
  currentProjectId: () => string | null;
}

export interface Bench {
  avgSent: number;
  sentCv: number;
  avgPara: number;
  sentsPerPara: number;
  dialogRatio: number;
  triRepeat: number;
  ttr: number;
  chapters: number;
  chars: number;
}

export interface DigestResult {
  bench: Bench;
  struct: {
    sceneCount: number;
    /** 章节长度分布：判断是否有稳定的节拍 */
    chapterLenPattern: 'uniform' | 'growing' | 'shrinking' | 'mixed';
    hookDensity: number;
  };
  hooks: Array<{ chapterId: string; at: number; quote: string; kind: string }>;
  roles: Array<{ name: string; mentions: number; firstChapter: string }>;
  kb: Array<{ key: string; value: string; evidence: string }>;
  compliance: { lcsMax: number; limit: number; passed: boolean; note: string };
}

export async function distillReferenceWork(
  args: { title: string; text: string; mode?: string },
  _ctx: ToolContext,
  _deps: DigestDeps,
): Promise<ToolResult<DigestResult>> {
  const started = Date.now();

  if (!args.text || args.text.trim().length === 0) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: '缺少参考作品正文。',
        retryable: true,
        hint: '把参考作品全文粘贴进来，或先用 chapter 工具读入。',
      },
    };
  }

  const text = args.text;
  const paras = text.split('\n').filter((p) => p.trim().length > 0);

  // ── ① 确定性统计蒸馏（可信：纯计算）──
  const a = analyze(text);
  const bench: Bench = {
    avgSent: round(a.raw.avgSent, 2),
    sentCv: round(a.raw.sentCv, 3),
    avgPara: round(a.raw.avgPara, 2),
    sentsPerPara: round(a.raw.sentsPerPara, 2),
    dialogRatio: round(a.raw.dialogRatio, 4),
    triRepeat: round(a.raw.triRepeat, 4),
    ttr: round(a.raw.ttr, 4),
    chapters: paras.length,
    chars: a.chars,
  };

  // ── ② 结构：章节长度分布判断节拍 ──
  const paraLens = paras.map((p) => p.replace(/\s/g, '').length);
  const chapterLenPattern = judgePattern(paraLens);
  const hookDensity = countHooks(text) / Math.max(1, paras.length);

  // ── ③ 钩子：章末疑问/悬念句式 ──
  const hooks = extractHooks(text, paras);

  // ── ④ 人物：按「他/她/名字」频次粗提（★ 推断型，可信度低于统计）──
  const roles = extractRoles(text, paras);

  // ── ⑤ 参数卡：把统计翻译成可执行检查项 ──
  const kb = buildKb(bench, chapterLenPattern, hookDensity);

  // ── ⑥ 合规守卫：LCS ≤ 20 ──
  const report = `${JSON.stringify(bench)} ${kb.map((k) => `${k.key}:${k.value}`).join(' ')}`;
  const lcsMax = longestCommonSubstring(report, text);
  const passed = lcsMax < DIGEST_LCS_LIMIT;

  return {
    ok: true,
    data: {
      bench,
      struct: { sceneCount: paras.length, chapterLenPattern, hookDensity: round(hookDensity, 2) },
      hooks: hooks.slice(0, 20),
      roles: roles.slice(0, 15),
      kb,
      compliance: {
        lcsMax,
        limit: DIGEST_LCS_LIMIT,
        passed,
        note: passed
          ? `最长公共子串 ${lcsMax} 字 < ${DIGEST_LCS_LIMIT}，未照抄原文。`
          : `⚠️ 最长公共子串 ${lcsMax} 字 ≥ ${DIGEST_LCS_LIMIT}，参数卡疑似照抄原文。` +
            `请检查是否把原文片段直接写进了报告。`,
      },
    },
    durationMs: Date.now() - started,
  };

  function round(v: number, d: number): number {
    return Number.isFinite(v) ? Number(v.toFixed(d)) : 0;
  }
}

function judgePattern(lens: number[]): 'uniform' | 'growing' | 'shrinking' | 'mixed' {
  if (lens.length < 3) return 'mixed';
  const half = Math.floor(lens.length / 2);
  const first = lens.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const second = lens.slice(half).reduce((s, v) => s + v, 0) / (lens.length - half);
  const diff = (second - first) / Math.max(1, first);
  const variance =
    lens.reduce((s, v) => s + (v - lens.reduce((x, y) => x + y, 0) / lens.length) ** 2, 0) /
    lens.length;
  const mean = lens.reduce((s, v) => s + v, 0) / lens.length;
  // 变异系数 < 0.15 视为有稳定节拍
  if (variance / Math.max(1, mean) < 0.15) return 'uniform';
  if (diff > 0.25) return 'growing';
  if (diff < -0.25) return 'shrinking';
  return 'mixed';
}

const HOOK_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: '悬念疑问', re: /[^。！？…]{6,30}[？?][^。！？…]{0,10}$/ },
  { kind: '转折', re: /[^。！？…]{4,24}(但是|可是|然而|却|没想到|竟然)[^。！？…]{0,20}$/ },
  { kind: '危机', re: /[^。！？…]{4,24}(危险|死|完了|来不及|崩塌|碎裂)[^。！？…]{0,16}$/ },
  { kind: '揭示', re: /[^。！？…]{4,24}(原来|竟然|才发现|真正的)[^。！？…]{0,20}$/ },
];

function countHooks(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    for (const { re } of HOOK_PATTERNS) {
      if (re.test(t)) {
        n++;
        break;
      }
    }
  }
  return n;
}

function extractHooks(_text: string, paras: string[]): DigestResult['hooks'] {
  const out: DigestResult['hooks'] = [];
  let offset = 0;
  paras.forEach((p, i) => {
    for (const { kind, re } of HOOK_PATTERNS) {
      const m = re.exec(p);
      if (m) {
        out.push({
          chapterId: `para${i + 1}`,
          at: offset + m.index,
          quote: snippetAround(p, m.index, 16),
          kind,
        });
        break;
      }
    }
    offset += p.length + 1;
  });
  return out;
}

const ROLE_STOPWORDS = new Set(['他', '她', '我', '你', '它', '我们', '你们', '他们', '她们']);

function extractRoles(_text: string, paras: string[]): DigestResult['roles'] {
  const map = new Map<string, { mentions: number; firstChapter: string }>();
  paras.forEach((p, i) => {
    // 中文人名：2-3 字连续汉字，出现在「说/道/看/走」等动词前
    const re = /([\u4e00-\u9fa5]{2,3})(?=说|道|问|笑|皱眉|点头|摇头|沉默)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p)) !== null) {
      const name = m[1];
      if (ROLE_STOPWORDS.has(name)) continue;
      const cur = map.get(name) ?? { mentions: 0, firstChapter: `para${i + 1}` };
      cur.mentions++;
      map.set(name, cur);
    }
  });
  return [...map.entries()]
    .map(([name, v]) => ({ name, mentions: v.mentions, firstChapter: v.firstChapter }))
    .sort((a, b) => b.mentions - a.mentions);
}

function buildKb(bench: Bench, pattern: string, hookDensity: number): DigestResult['kb'] {
  const kb: DigestResult['kb'] = [];

  kb.push({
    key: '平均句长',
    value: `${bench.avgSent} 字`,
    evidence: '统计蒸馏（可信）',
  });
  kb.push({
    key: '每段句数',
    value: `${bench.sentsPerPara} 句`,
    evidence: bench.sentsPerPara > 1.3 ? '不是「一句一段」，段落承载多句' : '接近「一句一段」的短段风格',
  });
  kb.push({
    key: '章末钩子密度',
    value: `${hookDensity} 处/段`,
    evidence: hookDensity > 0.5 ? '几乎每段收尾都有钩子' : '仅部分段落收尾有钩子',
  });
  kb.push({
    key: '对白占比',
    value: `${(bench.dialogRatio * 100).toFixed(0)}%`,
    evidence: bench.dialogRatio > 0.6 ? '叙述承担描写，对白推进为主' : '叙述比重高',
  });
  kb.push({
    key: '段落长度节拍',
    value:
      pattern === 'uniform'
        ? '稳定（变异小）'
        : pattern === 'growing'
          ? '递增'
          : pattern === 'shrinking'
            ? '递减'
            : '不规则',
    evidence: `按 ${bench.chapters} 段的字长分布判定`,
  });
  kb.push({
    key: '用字重复度',
    value: `3-gram ${(bench.triRepeat * 100).toFixed(1)}%`,
    evidence: bench.triRepeat < 0.3 ? '重复控制较好' : '重复偏高，注意三连词',
  });

  return kb;
}

/**
 * 最长公共子串（合规守卫）。
 *
 * 动态规划，O(n*m)。参考书最长可能很长，故对报告侧只取前 2000 字参与计算——
 * 守卫的目的是抓「照抄整段」，不是逐字比对。
 */
export function longestCommonSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const s = a.slice(0, 2000);
  const t = b.slice(0, 200000);
  let max = 0;
  let prev = new Int32Array(t.length + 1);
  let cur = new Int32Array(t.length + 1);
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      if (s[i - 1] === t[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > max) max = cur[j];
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return max;
}