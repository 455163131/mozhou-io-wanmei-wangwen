/**
 * 规则引擎：安全同义词族 + 13 条 auto 规则 + 4 条负面知识（架构 T07）。
 *
 * ★ 本文件的核心约束（架构 §6第 2 条铁律）：
 *   移植后必须 `grep -rn "document\.\|window\." src/main/` 命中数为 0。
 *   下面所有代码原本假设在浏览器里跑，一处 DOM 引用就是移植错了。
 *
 * ★ 变体只允许取作者自己语料中真实出现过的表达（715 章实测词频，见 05_质量审查报告 §7）：
 *   verb 族（说→道/问/念/应）**整族关闭**——语料实测 X的说 1356 次，
 *   而 X的问 17、X的应 2、X的念 2、X道 0 次。把「说」轮换成其余形态
 *   = 用机器口吻覆盖作者口吻。故 fix_synonym_rotation 的 families 里**没有** verb 族，
 *   系统提示必须显式告诉模型这一点，否则模型会尝试一个不存在的能力。
 *
 *   全部为确定性字符串规则：无 LLM、无网络、无随机；只做等义改写，
 *   不改动人名/地名/金额/日期/吨位/张数，不删除剧情事实。
 */
import type { Edit } from '@shared/types/tool';
import { inQuote } from '@shared/util/text-zh';

// ───────────────────────── 安全同义词族 ─────────────────────────

export const FIX_PLACE = ['搁在', '放在', '摆在'];
export const FIX_SAME = ['一样', '一个样'];
export const FIX_INCH = ['一寸不到', '不到一寸'];

export interface FixFamily {
  id: string;
  label: string;
  layer: string;
  re: () => RegExp;
  slot: number;
  variants: string[];
}

/**
 * ⚠️ **只有 3 族，没有 verb 族**。这是基于 715 章实测词频的决策，不可随意放开。
 * 若将来要加，必须先确认变体在作者真实语料中的频次，否则就是用机器口吻覆盖作者口吻。
 */
export const FIX_FAMILIES: FixFamily[] = [
  {
    id: 'place',
    label: '置物动词轮换',
    layer: '表达层',
    // 「压在」语义不同（施压），已排除
    re: () => /(搁在|放在|摆在|压在|丢在|扔在)(?=[^，。！？]{0,8}[，。])/g,
    slot: 1,
    variants: FIX_PLACE,
  },
  {
    id: 'same',
    label: '「一样」轮换',
    layer: '表达层',
    re: () => /(一样|相同|一个样)(?=[，。”])/g,
    slot: 1,
    variants: FIX_SAME,
  },
  {
    id: 'inch',
    label: '「一寸不到」轮换',
    layer: '素材层',
    re: () => /(一寸不到|不到一寸)/g,
    slot: 1,
    variants: FIX_INCH,
  },
];

export function familyById(id: string): FixFamily | undefined {
  return FIX_FAMILIES.find((f) => f.id === id);
}

interface FamilyHit {
  at: number;
  slotStart: number;
  slotText: string;
}

/**
 * 找可改的槽位。**全局守卫，此处不得放宽**：
 *   - 引号内是人物语言，是本书要「立」的核心资产，任何族都不得改写台词
 *     （旧版曾让六个族越界改台词，实测把「"不知道。"」改成「"说不准。"」，已修）
 *   - 槽位含阿拉伯数字者是事实锚点，一律不动
 */
function fixFamilyHits(text: string, fam: FixFamily): FamilyHit[] {
  const re = fam.re();
  const out: FamilyHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slotText = m[fam.slot] ?? '';
    const slotStart = m.index + m[0].length - slotText.length;
    const guarded = inQuote(text, slotStart) || /[0-9０-９]/.test(slotText);
    if (!guarded) out.push({ at: m.index, slotStart, slotText });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/**
 * 轮换按「出现次序取模」定位目标词形—— 因此天然幂等：再跑一次改动数为 0。
 * 这个幂等性很重要：它是循环检测判据 A 豁免 idempotent 工具的依据。
 */
function fixFamilyApply(text: string, fam: FixFamily): { text: string; changes: Edit[] } {
  const hits = fixFamilyHits(text, fam);
  const changes: Edit[] = [];
  // 少于 3 次不改：少量重复不是 AI 味特征，改了只是噪音
  if (hits.length < 3) return { text, changes };

  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const target = fam.variants[i % fam.variants.length];
    if (h.slotText === target) continue;
    out = out.slice(0, h.slotStart) + target + out.slice(h.slotStart + h.slotText.length);
    changes.push({
      before: h.slotText,
      after: target,
      at: h.slotStart,
      note: `${fam.label}：同一表述在章内重复 ${hits.length} 次 → 「${h.slotText}」改为「${target}」`,
      ruleId: `family:${fam.id}`,
    });
  }
  return { text: out, changes: changes.reverse() };
}

export function fixFamilies(
  text: string,
  ids: string[],
): { text: string; changes: Edit[] } {
  let cur = text;
  const changes: Edit[] = [];
  for (const id of ids) {
    const fam = familyById(id);
    if (!fam) continue;
    const r = fixFamilyApply(cur, fam);
    if (r.changes.length) {
      changes.push(...r.changes);
      cur = r.text;
    }
  }
  return { text: cur, changes };
}

// ───────────────────────── 句子/段落切分工具 ─────────────────────────

/** 按句末标点切句，**保留标点**——拼接回去与原文逐字相同 */
export function splitSentences(p: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < p.length; i++) {
    cur += p[i];
    if ('。！？…'.indexOf(p[i]) >= 0) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 去标点去空白后的长度——「有效字数」 */
export function plainLen(s: string): number {
  return s.replace(/[。！？…]/g, '').replace(/\s/g, '').length;
}

function hasQuote(s: string): boolean {
  return /[“”「」]/.test(s);
}

// ───────────────────────── F7–F11 修正函数 ─────────────────────────

/** F7 正向：相邻两句合计 ≤34 字且均为叙述句 → 「甲。乙。」并为「甲，乙。」 */
export function fixMergeShortSentences(text: string, maxCombined = 34): { text: string; changes: Edit[] } {
  const changes: Edit[] = [];
  let out = '';
  let g = 0;
  const paras = text.split('\n');
  paras.forEach((p, pi) => {
    const sents = splitSentences(p);
    let i = 0;
    while (i < sents.length) {
      const a = sents[i];
      const b = sents[i + 1];
      const ok =
        b &&
        !hasQuote(a) &&
        !hasQuote(b) &&
        plainLen(a) >= 2 &&
        plainLen(b) >= 2 &&
        plainLen(a) + plainLen(b) <= maxCombined;
      if (ok) {
        const after = a.replace(/[。！？…]$/, '') + '，' + b;
        changes.push({
          before: a + b,
          after,
          at: g,
          note: `短句合并：两句合计 ${plainLen(a) + plainLen(b)} 字 → 并为一句`,
          ruleId: 'F7',
        });
        out += after;
        g += a.length + b.length;
        i += 2;
      } else {
        out += a;
        g += a.length;
        i += 1;
      }
    }
    if (pi < paras.length - 1) {
      out += '\n';
      g += 1;
    }
  });
  return { text: out, changes };
}

/** F7 反向：平均句长偏长 → 过长句（>30 字）在最靠近中点的停顿处断成两句 */
export function fixSplitLongSentences(text: string, maxLen = 30): { text: string; changes: Edit[] } {
  const changes: Edit[] = [];
  let out = '';
  let g = 0;
  const paras = text.split('\n');
  paras.forEach((p, pi) => {
    splitSentences(p).forEach((s) => {
      const at = g;
      let rep: string | null = null;
      if (!hasQuote(s) && plainLen(s) > maxLen) {
        const cuts: number[] = [];
        for (let i = 1; i < s.length - 1; i++) if (s[i] === '、' || s[i] === '，') cuts.push(i);
        let best = -1;
        let bestDev = Infinity;
        cuts.forEach((i) => {
          const dev = Math.abs(i - s.length / 2);
          if (dev < bestDev) {
            bestDev = dev;
            best = i;
          }
        });
        if (best > 0) rep = `${s.slice(0, best)}。${s.slice(best + 1)}`;
      }
      out += rep || s;
      if (rep) {
        changes.push({
          before: s,
          after: rep,
          at,
          note: `长句切分：${plainLen(s)} 字长句在停顿处断成两句`,
          ruleId: 'F7',
        });
      }
      g += s.length;
    });
    if (pi < paras.length - 1) {
      out += '\n';
      g += 1;
    }
  });
  return { text: out, changes };
}

/** F8 长短交错：过长句（>32 字）在顿号处断开 → 拉高句长离散度 */
export function fixRhythmSpread(text: string): { text: string; changes: Edit[] } {
  const changes: Edit[] = [];
  let out = '';
  let g = 0;
  const paras = text.split('\n');
  paras.forEach((p, pi) => {
    splitSentences(p).forEach((s) => {
      const at = g;
      const plain = plainLen(s);
      let rep: string | null = null;
      if (plain > 32 && s.indexOf('、') >= 0 && !hasQuote(s)) {
        const parts = s.split('、');
        let best = -1;
        let bestDev = Infinity;
        let acc = 0;
        for (let i = 1; i < parts.length; i++) {
          acc += parts[i - 1].length + 1;
          const dev = Math.abs(acc - s.length / 2);
          if (dev < bestDev) {
            bestDev = dev;
            best = i;
          }
        }
        if (best > 0) rep = `${parts.slice(0, best).join('、')}。${parts.slice(best).join('、')}`;
      }
      out += rep || s;
      if (rep) {
        changes.push({
          before: s,
          after: rep,
          at,
          note: `长短交错：过长句（${plain} 字）在顿号处断开`,
          ruleId: 'F8',
        });
      }
      g += s.length;
    });
    if (pi < paras.length - 1) {
      out += '\n';
      g += 1;
    }
  });
  return { text: out, changes };
}

/**
 * F9 段落合并：相邻两段合计 ≤32 字 → 合并为一段。
 *
 * ★ 一个说话人一段的硬保护：两段都含引号 = 两个说话人的台词，
 * 合并会把「一人一段」的对白格式压成一段，读者分不清谁在说，
 * 属破坏人物语言的硬伤，故禁止合并；叙述段与对白段之间仍可合并。
 */
export function fixMergeParas(text: string, maxLen = 32): { text: string; changes: Edit[] } {
  const paras = text.split('\n');
  const starts: number[] = [];
  let g = 0;
  paras.forEach((p) => {
    starts.push(g);
    g += p.length + 1;
  });
  const res: string[] = [];
  const changes: Edit[] = [];
  let i = 0;
  while (i < paras.length) {
    const cur = paras[i];
    const next = paras[i + 1];
    const twoSpeakers = cur && next && hasQuote(cur) && hasQuote(next);
    if (
      next !== undefined &&
      cur.trim() &&
      next.trim() &&
      !twoSpeakers &&
      (cur + next).replace(/\s/g, '').length <= maxLen
    ) {
      res.push(cur + next);
      changes.push({
        before: `${cur}\n${next}`,
        after: cur + next,
        at: starts[i],
        note: `段落合并：相邻两段合计 ${(cur + next).replace(/\s/g, '').length} 字（一句一段墙）→ 并为一段`,
        ruleId: 'F9',
      });
      i += 2;
    } else {
      res.push(cur);
      i += 1;
    }
  }
  return { text: res.join('\n'), changes };
}

/** F10 段落偏长：>40 字的段落在靠近中点的句界处切为两段 */
export function fixSplitLongParas(text: string, maxLen = 40): { text: string; changes: Edit[] } {
  const paras = text.split('\n');
  const res: string[] = [];
  const changes: Edit[] = [];
  let g = 0;
  paras.forEach((p) => {
    const at = g;
    g += p.length + 1;
    const plain = p.replace(/\s/g, '');
    if (plain.length > maxLen) {
      const sents = splitSentences(p);
      if (sents.length >= 2) {
        let best = -1;
        let bestDev = Infinity;
        let acc = 0;
        for (let i = 0; i < sents.length - 1; i++) {
          acc += sents[i].length;
          const dev = Math.abs(acc - p.length / 2);
          if (dev < bestDev) {
            bestDev = dev;
            best = i;
          }
        }
        if (best >= 0) {
          const a = sents.slice(0, best + 1).join('');
          const b = sents.slice(best + 1).join('');
          if (b.trim()) {
            res.push(a);
            res.push(b);
            changes.push({
              before: p,
              after: `${a}\n${b}`,
              at,
              note: `长段切分：${plain.length} 字段落在中点句界处切为两段`,
              ruleId: 'F10',
            });
            return;
          }
        }
      }
    }
    res.push(p);
  });
  return { text: res.join('\n'), changes };
}

/** F11 一X一X 叠词 → 一XX（只去掉冗余的一个「一」，不删信息） */
export function fixDoubleWords(text: string): { text: string; changes: Edit[] } {
  const re = /一(.)一\1/g;
  const hits: Array<{ at: number; before: string; after: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // 只处理汉字，不处理「一 1」「一a」这类
    if (/[\u4e00-\u9fa5]/.test(m[1]) && !inQuote(text, m.index)) {
      hits.push({ at: m.index, before: m[0], after: `一${m[1]}${m[1]}` });
    }
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  let out = text;
  const changes: Edit[] = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    out = out.slice(0, h.at) + h.after + out.slice(h.at + h.before.length);
    changes.push({
      before: h.before,
      after: h.after,
      at: h.at,
      note: `叠词降重：${h.before} → ${h.after}（去掉冗余的一个「一」）`,
      ruleId: 'F11',
    });
  }
  return { text: out, changes: changes.reverse() };
}