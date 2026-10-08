/**
 * AI 建议规则 R1–R6（架构 T07）。
 *
 * 移植自 `_src/template.html:1476-1545` 的 `genSuggestions()`。
 * F1–F6 六条 auto 规则包装的是这里的产物（`fixFromSuggestionRule`），
 * 故本文件是 F1–F6 的数据来源。
 */
import { inQuote } from '@shared/util/text-zh';

export interface Suggestion {
  rule: string;
  ruleLabel: string;
  before: string;
  after: string;
  start: number;
  layer: string;
  note: string;
}

/** R1 观感替代的候选映射（template.html:1459-1464） */
const R1_MAP: Array<[RegExp, string]> = [
  [/很久|好久/, '没再看第二眼'],
  [/一会儿|一会/, '视线没有落点'],
  [/几遍|两遍|三遍|一遍/, '只在心里过了一遍'],
  [/几秒|两秒|三秒|一秒/, '喉咙动了一下'],
];

/** R2 停顿替代的候选映射（template.html:1470-1473） */
const R2_MAP: Array<[RegExp, string]> = [
  [/一愣|愣住/, '后槽牙咬了一下'],
  [/愣(了一下|了愣)/, '手上的动作停了半拍'],
];

export function suggestReplacement1(matched: string): string {
  for (const [re, rep] of R1_MAP) if (re.test(matched)) return rep;
  return '眼神没有聚焦';
}

export function suggestReplacement2(matched: string): string {
  for (const [re, rep] of R2_MAP) if (re.test(matched)) return rep;
  return '动作顿了半拍';
}

/**
 * 生成建议列表。
 * 去重规则：同一 start 且同一 before 只保留一条——多条规则可能命中同一片段。
 */
export function genSuggestions(text: string): Suggestion[] {
  const sugs: Suggestion[] = [];
  const push = (o: Suggestion): void => {
    if (!sugs.some((s) => s.start === o.start && s.before === o.before)) sugs.push(o);
  };

  // ── R1 观感替代：看 + 时长 ──
  // 只对「观感类精确」（数字＋遍/秒/眼）开火；「看了很久 / 看了一会儿」
  // 已是目标形态的印象式表达，不再改写。「几眼/几下」的「几」是模糊量词，
  // 同属印象式，故有意不入字符类（不视为漏写）。
  {
    const re =
      /(盯着|看着|望着|打量着|端详着)?\s*看(了|着)(几遍|两遍|三遍|一遍|几秒|两秒|三秒|一秒|[一二三四五六七八九十百千两0-9]+(遍|秒|眼|下))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = m[0];
      push({
        rule: 'R1',
        ruleLabel: '观感替代',
        before,
        after: suggestReplacement1(before),
        start: m.index,
        layer: '表达层',
        note: `「${before}」用观看时长代替反应 → 改具体动作 / 印象式表达`,
      });
    }
  }

  // ── R2 万能停顿 / 愣 ──
  {
    const re = /(不由得)?(一愣|愣住|愣(了一下|了愣)|顿了一下|顿了顿|停了一下)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = m[0];
      push({
        rule: 'R2',
        ruleLabel: '停顿替代',
        before,
        after: suggestReplacement2(before),
        start: m.index,
        layer: '表达层',
        note: `「${before}」为万能停顿 → 用具体生理反应 / 动作中断替代`,
      });
    }
  }

  // ── R3 置物句族同段 ≥2 次才改：单次出现不是 AI 味特征 ──
  {
    const paras = text.split('\n');
    let base = 0;
    paras.forEach((p) => {
      const re = /把[^，。！？“「]{0,10}(放在|搁在|摊在|摆在|压在|丢在|扔在|按在|贴在)/g;
      const hits: Array<{ at: number; before: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(p)) !== null) hits.push({ at: base + m.index, before: m[0] });
      if (hits.length >= 2) {
        hits.forEach((h, i) =>
          push({
            rule: 'R3',
            ruleLabel: '置物句去重',
            before: h.before,
            after: h.before.replace(
              /放在|搁在|摊在|摆在|压在|丢在|扔在|按在|贴在/,
              ['放在', '搁在', '摊在', '摆在'][i % 4],
            ),
            start: h.at,
            layer: '表达层',
            note: `同一段出现 ${hits.length} 次「把X＋置物动词」→ 合并或改一处`,
          }),
        );
      }
      base += p.length + 1;
    });
  }

  // ── R4 抬起头 / 低头（动作三板斧）──
  {
    const re = /(抬起头|低下头|抬头看|低头看)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      push({
        rule: 'R4',
        ruleLabel: '动作三板斧',
        before: m[0],
        after: m[0].indexOf('低') === 0 ? '把脸埋进碗里' : '把脸从窗外收回来',
        start: m.index,
        layer: '表达层',
        note: `「${m[0]}」为高频动作 → 换成有指向的具体动作`,
      });
    }
  }

  // ── R5 没说话 / 没答（万能留白）──
  {
    const re = /没(说话|答|出声|应声|吭声)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      push({
        rule: 'R5',
        ruleLabel: '留白替代',
        before: m[0],
        after: '把话头掐了',
        start: m.index,
        layer: '表达层',
        note: `「${m[0]}」为万能留白 → 改成有信息量的动作或对话`,
      });
    }
  }

  // ── R6 章首时间+地点公式 → 挪到第二段 ──
  {
    const first = (text.split('\n')[0] || '').trim();
    if (/^[一二三四五六七八九十百千零两0-9]+(月|号|日|年|点)/.test(first) && first.length < 24) {
      const paras = text.split('\n');
      push({
        rule: 'R6',
        ruleLabel: '章首公式',
        before: `${first}\n${paras[1] || ''}`,
        after: `${paras[1] || ''}\n${first}`,
        start: 0,
        layer: '结构层',
        note: '章首为「时间+地点」公式 → 把时间挪到第二段，先给画面',
      });
    }
  }

  return sugs.sort((a, b) => a.start - b.start);
}

/** 判断位置是否落在引号内——人物语言一律不改（供调用方使用） */
export function positionInQuote(text: string, idx: number): boolean {
  return inQuote(text, idx);
}