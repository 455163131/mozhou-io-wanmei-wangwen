/**
 * AI 味检测引擎测试。
 *
 * ★ 验收条件写成可执行的话：**AI 生成的坏文本必须比人类好文本得分高**。
 *   这是检测器的唯一存在理由，如果这条不成立，其他测试全绿也没意义。
 */
import { describe, it, expect } from 'vitest';
import { detectFlavor, splitParagraphs, splitSentences } from '@shared/ai-flavor/engine';
import { DEFAULT_FLAVOR_CONFIG, FLAVOR_DISCLAIMER } from '@shared/types/ai-flavor';

// ── 对照样本 ─────────────────────────────────────────────────────────

/**
 * 人类写法：长短句交错、口语、有对白、用词散。
 * ★ 长度必须超过 minChars(200)，否则会被判样本不足而指数为 0——
 *   那是「样本不足保护」在生效，不是检测能力有问题。
 */
const HUMAN = `他把碗放下，站起身来。
"你不吃了？" 她问。
"不吃了。" 他抹了把嘴，"饱了。"
窗外有辆卡车开过去，轰隆隆的，震得玻璃响。他看了一眼，又想不起来自己刚才要说什么。
她没再问。两个人就那么坐着，听那车声远了，没了。
过了很久，他说："我明天走。"
"嗯。" 她答得很快，像是早就知道。
屋子里静下来。灶上还坐着水，咕嘟咕嘟地响。
他伸手去够烟盒，摸了两下没摸到。算了。
街上有人吆喝卖豆腐。天快黑了，巷口那盏灯还没亮起来。
她起身收了碗，水声哗哗的。他听见她在厨房里哼了半句什么，又停了。
"路上小心。" 她端着碗出来的时候说。
他点点头，没接话。有些话说出来反而不好收场。
门口那只猫蹭了蹭他的裤脚，转身钻进门缝里去了。`;

/** AI 写法：句式均匀、套话密集、无对白、模板连接词、对仗工整、长句压读 */
const AI_FLAVOR = `他顿了一下，深吸一口气，瞳孔骤然紧缩。
然而，这一切都是那么不易察觉。
他嘴角勾起一抹苦笑，空气仿佛似乎凝固了。
与此同时，复杂的情绪涌上心头。
仿佛有什么东西破碎了一般，他不禁沉默起来。
不是他不愿意，而是他不能。
不仅仅是身体的疲惫，更是灵魂的倦怠。
然而就在这时，他忽然明白了什么。
那一刻，时间仿佛静止了。
他缓缓抬起头，淡淡一笑，看着远方，眼神里有着难以言喻的复杂情绪。
随着年岁的增长，他逐渐意识到，有些东西注定无法挽回，而在这样的时刻，他只能默默地站在原地。
综上所述，这一切都显得那么苍白无力，却又是如此刻骨铭心。
他轻轻叹了口气，悠悠地说道，有些事情，终究是回不去了。
值得注意的是，他从未想过会是这样的结局，因此他选择了沉默。`;

// ── 核心验收：正负对照 ───────────────────────────────────────────────

describe('★ 核心验收：坏文本必须比好文本得分高', () => {
  it('AI 腔文本得分显著高于人写文本', () => {
    const human = detectFlavor(HUMAN, 'h', DEFAULT_FLAVOR_CONFIG);
    const ai = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    expect(ai.index).toBeGreaterThan(human.index);
    // 不是「高一点」，而是要拉开差距
    expect(ai.index - human.index).toBeGreaterThan(20);
  });

  it('人写文本不应被判为 AI（误报控制）', () => {
    const human = detectFlavor(HUMAN, 'h', DEFAULT_FLAVOR_CONFIG);
    expect(human.index).toBeLessThan(55);
  });

  it('AI 腔文本应被判为明显 AI', () => {
    const ai = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    expect(ai.index).toBeGreaterThan(45);
  });
});

// ── 样本不足 ─────────────────────────────────────────────────────────

describe('★ 样本不足必须认怂（短文本不冤枉作者）', () => {
  it('低于 minChars 时不出总评，标记 sufficient=false', () => {
    const r = detectFlavor('他走了。', 'x', DEFAULT_FLAVOR_CONFIG);
    expect(r.sufficient).toBe(false);
    expect(r.index).toBe(0);
    expect(r.insufficientReason).toContain('低于最小样本量');
  });

  it('空文本不崩，返回干净结果', () => {
    const r = detectFlavor('', 'x', DEFAULT_FLAVOR_CONFIG);
    expect(r.chars).toBe(0);
    expect(r.hits).toEqual([]);
    expect(r.sufficient).toBe(false);
  });

  it('★ 非字符串入参不抛错（编辑器清空 / 脏数据）', () => {
    expect(() => detectFlavor(null as never, 'x')).not.toThrow();
    expect(() => detectFlavor(undefined as never, 'x')).not.toThrow();
    expect(() => detectFlavor(123 as never, 'x')).not.toThrow();
  });
});

// ── 中文格式兼容 ─────────────────────────────────────────────────────

describe('★ 中文三种分段格式都要认', () => {
  it('空行分段（Markdown 风格）', () => {
    const p = splitParagraphs('第一段。\n\n第二段。\n\n第三段。');
    expect(p).toHaveLength(3);
  });

  it('★ 一段一行、段间不空行（最常见的 .txt 小说）', () => {
    const p = splitParagraphs('第一段。\n第二段。\n第三段。');
    expect(p).toHaveLength(3);
  });

  it('★ 定宽折行（古籍/PDF 复制）应合并为一段', () => {
    // 每行都不以句末标点结尾 → 判为折行
    const wrapped = '他慢慢地走过去，\n看着窗外的雨，\n心里想着那个人，\n忽然就笑了';
    const p = splitParagraphs(wrapped);
    expect(p).toHaveLength(1);
  });

  it('段落偏移能正确定位回原文', () => {
    const text = '甲段。\n\n乙段。';
    const p = splitParagraphs(text);
    for (const slice of p) {
      const back = text.slice(slice.start, slice.end);
      expect(back).toContain(slice.text.slice(0, 2));
    }
  });
});

describe('★ 三种引号都要认（对白占比判定）', () => {
  // ★ 样本必须超过各维度的内部地板（对白维度硬要求 200 字），
  //   否则 measured 为 null——那是样本不足保护，不是引号识别有问题。
  const filler =
    '他坐在那儿，看着窗外。天一点点暗下来，巷口的灯还没亮。他想起许多年前的事，那些人、那些没说出口的话，都散在风里了，连个影子也没剩下。\n' +
    '街上有人吆喝卖豆腐。孩子放学回来，书包扔在门口，跑出去就没影了。锅里的水开了，咕嘟咕嘟地响。他起身去关火，顺手把窗子推开一条缝，凉气灌进来。\n' +
    '院子里的石榴树掉了一地叶子。去年这时候还在结果，今年不知怎么就枯了半边。他蹲下去捡了两片，捏在手里，又觉得没什么意思，随手扔了。天彻底黑透了。';

  it('弯引号 “”', () => {
    const text = `“你好。”他说。\n${filler}`;
    const r = detectFlavor(text, 'x', DEFAULT_FLAVOR_CONFIG);
    const m = r.dimensions.find((d) => d.dimension === 'dialog-ratio')!.measured;
    expect(m).not.toBeNull();
    expect(m!).toBeGreaterThan(0);
  });

  it('角引号 「」', () => {
    const text = `「你好。」他说。\n${filler}`;
    const r = detectFlavor(text, 'x', DEFAULT_FLAVOR_CONFIG);
    const m = r.dimensions.find((d) => d.dimension === 'dialog-ratio')!.measured;
    expect(m).not.toBeNull();
    expect(m!).toBeGreaterThan(0);
  });

  it('直引号 ""', () => {
    const text = `"你好。"他说。\n${filler}`;
    const r = detectFlavor(text, 'x', DEFAULT_FLAVOR_CONFIG);
    const m = r.dimensions.find((d) => d.dimension === 'dialog-ratio')!.measured;
    expect(m).not.toBeNull();
    expect(m!).toBeGreaterThan(0);
  });
});

// ── 命中定位 ─────────────────────────────────────────────────────────

describe('★ 命中必须能定位到原文', () => {
  it('每个 hit 的 offset+length 能从原文取回对应文本', () => {
    const r = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      const back = AI_FLAVOR.slice(h.offset, h.offset + h.length);
      expect(back.length).toBe(h.length);
      // 标志词命中应能取回非空文本
      if (h.dimension === 'marker-density' && h.kind !== '空气仿佛凝固') {
        expect(back.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('★ 每个 hit 都带原因与改法（只报问题不给理由的检测器没人信）', () => {
    const r = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    for (const h of r.hits) {
      expect(h.reason.length).toBeGreaterThan(4);
      expect(h.advice.length).toBeGreaterThan(4);
      expect(h.paragraphNo).toBeGreaterThanOrEqual(0);
    }
  });

  it('命中带段落归属，可定位到第几段', () => {
    const r = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    const withPara = r.hits.filter((h) => h.paragraphNo > 0);
    expect(withPara.length).toBeGreaterThan(0);
  });
});

// ── 维度与配置 ───────────────────────────────────────────────────────

describe('维度开关与配置', () => {
  it('★ 关闭某维度后该维度 skipped 且不参与总评', () => {
    const cfg = {
      ...DEFAULT_FLAVOR_CONFIG,
      dimensions: { ...DEFAULT_FLAVOR_CONFIG.dimensions, 'marker-density': false },
    };
    const r = detectFlavor(AI_FLAVOR, 'a', cfg);
    const md = r.dimensions.find((d) => d.dimension === 'marker-density')!;
    expect(md.skipped).toBe(true);
    expect(md.score).toBe(0);
    expect(md.note).toContain('关闭');
  });

  it('★ 全关维度时总评不崩（权重和为 0）', () => {
    const allOff = Object.fromEntries(
      Object.keys(DEFAULT_FLAVOR_CONFIG.dimensions).map((k) => [k, false]),
    );
    const cfg = { ...DEFAULT_FLAVOR_CONFIG, dimensions: allOff as never };
    const r = detectFlavor(AI_FLAVOR, 'a', cfg);
    expect(r.index).toBe(0);
  });

  it('★ 阈值可配，影响等级判定', () => {
    const strict = {
      ...DEFAULT_FLAVOR_CONFIG,
      thresholds: { clean: 5, mild: 10, suspicious: 15, heavy: 20 },
    };
    const loose = {
      ...DEFAULT_FLAVOR_CONFIG,
      thresholds: { clean: 90, mild: 95, suspicious: 96, heavy: 97 },
    };
    const a = detectFlavor(AI_FLAVOR, 'a', strict);
    const b = detectFlavor(AI_FLAVOR, 'a', loose);
    expect(a.level).not.toBe(b.level);
  });

  it('★ maxHits 截断生效（防长文压垮 UI）', () => {
    const cfg = { ...DEFAULT_FLAVOR_CONFIG, maxHits: 3 };
    const r = detectFlavor(AI_FLAVOR, 'a', cfg);
    expect(r.hits.length).toBeLessThanOrEqual(3);
  });

  it('includeExcerpts=false 时不回传片段（省传输）', () => {
    const cfg = { ...DEFAULT_FLAVOR_CONFIG, includeExcerpts: false };
    const r = detectFlavor(AI_FLAVOR, 'a', cfg);
    for (const h of r.hits) expect(h.excerpt).toBe('');
  });

  it('每个维度都给了可读的 note', () => {
    const r = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    expect(r.dimensions).toHaveLength(10);
    for (const d of r.dimensions) expect(d.note.length).toBeGreaterThan(2);
  });
});

// ── 主导维度与段落分 ─────────────────────────────────────────────────

describe('主导维度与分段得分', () => {
  it('★ 能识别出主导维度（用户优先改这个）', () => {
    const r = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    expect(r.dominantDimension).not.toBeNull();
  });

  it('★ 段落得分能指出问题段落（AI 样本几乎段段有问题）', () => {
    const r = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    const bad = r.paragraphs_.filter((p) => p.hitCount > 0);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0].topDimension).not.toBeNull();
  });

  it('人写文本的问题段落明显少于 AI 样本', () => {
    const human = detectFlavor(HUMAN, 'h', DEFAULT_FLAVOR_CONFIG);
    const ai = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    const humanBad = human.paragraphs_.filter((p) => p.hitCount > 0).length;
    const aiBad = ai.paragraphs_.filter((p) => p.hitCount > 0).length;
    expect(aiBad).toBeGreaterThan(humanBad);
  });
});

// ── 低置信信号 ───────────────────────────────────────────────────────

describe('★ 一X一X 叠词按低置信处理（正常中文极常见）', () => {
  it('叠词的严重度低于套话标志词', () => {
    const text = '他一步一步走过来，又一天一天地等，最后一字一字地写完。';
    const r = detectFlavor(text, 'x', { ...DEFAULT_FLAVOR_CONFIG, minChars: 10 });
    const dieci = r.hits.find((h) => h.kind === '一X一X 叠词');
    expect(dieci).toBeDefined();
    expect(dieci!.severity).toBeLessThan(50);
    expect(dieci!.advice).toContain('低置信');
  });
});

// ── 网文场景误报防护 ─────────────────────────────────────────────────

describe('★ 网文场景误报防护（朱雀调研警告的头号风险）', () => {
  it('★ 对白墙不应被判为「段落节奏像 AI」', () => {
    // v2 护栏口径：对白段 ≥85% 且几乎一句一段 → 判为「对白墙」，不参与段落节奏判定。
    // ★ 旧 v1 护栏用「段落中位<120 字就跳过」，对网文 715/715 章永久失效（实测），
    //   已在 v2 移除；此处样本刻意做成「对白占绝大多数」以满足新护栏。
    const dialogPaced = `"你来了。"\n"嗯。"\n"坐吧。"\n"好。"\n"喝点什么？"\n"水就行。"\n"最近怎么样？"\n"还行。"\n"那就好。"\n"多谢。"\n"客气什么。"\n"那我先走了。"\n"路上小心。"\n"知道了。"\n"回头见。"\n他坐下了。`;
    const r = detectFlavor(dialogPaced, 'x', DEFAULT_FLAVOR_CONFIG);
    const pr = r.dimensions.find((d) => d.dimension === 'paragraph-rhythm')!;
    expect(pr.score).toBeLessThan(60);
    expect(pr.note).toContain('对白驱动');
  });

  it('段落长而无对白、且高度整齐时才判为节奏问题', () => {
    // v2 护栏只看「对白占比」，不再看段落长度：本样本无对白 → 走正常判定；
    // 六段等长 → para_cv≈0 → 远低于语料 p05，扣分。
    const longPara =
      '他走在路上，看着两旁的树，心里想着一些事情，这些事情说不上重要，但也放不下，' +
      '就这样一直走着，路灯一盏一盏亮起来，把他的影子拉得很长，又收得很短，' +
      '他想起了许多年前的那个下午，那时候他还年轻，什么都敢想，什么都不怕，' +
      '如今却连一句想说的话都要在心里来回掂量，最后什么也没说出口，只是继续往前走。';
    const longUniform = Array.from({ length: 6 }, () => longPara).join('\n\n');
    const r = detectFlavor(longUniform, 'x', DEFAULT_FLAVOR_CONFIG);
    const pr = r.dimensions.find((d) => d.dimension === 'paragraph-rhythm')!;
    expect(pr.score).toBeGreaterThan(60);
  });
});

// ── 逗号/句号比（朱雀调研 P0-2）───────────────────────────────────────

describe('★ 标点维度含逗号/句号比（长句压读）', () => {
  it('逗号一路到底的长句会被识别为压读', () => {
    const longClause =
      '他站在门口，看着院子里那棵树，想起小时候在树下乘凉，想起母亲喊他吃饭，想起那些再也回不去的日子，忽然觉得眼睛有些发酸，却什么也说不出，只是站着，站了很久，直到天完全黑了下来，才慢慢转身回屋。';
    const r = detectFlavor(longClause.repeat(3), 'x', DEFAULT_FLAVOR_CONFIG);
    const p = r.dimensions.find((d) => d.dimension === 'punctuation-pattern')!;
    expect(p.measured).toBeGreaterThan(2.5);
    expect(p.note).toContain('逗号/句号比');
  });

  it('短句为主时逗号/句号比正常', () => {
    const short = '他走了。她没说话。天黑了。他点了根烟。风很大。他缩了缩脖子。';
    // 样本需 >200 字才能让标点维度参与计算
    const r = detectFlavor(short.repeat(10), 'x', DEFAULT_FLAVOR_CONFIG);
    const p = r.dimensions.find((d) => d.dimension === 'punctuation-pattern')!;
    expect(p.measured).not.toBeNull();
    expect(p.measured!).toBeLessThan(1);
  });
});

// ── 副词+动词结构（朱雀调研 P1）─────────────────────────────────────

describe('★ 副词+动词结构命中（网文高频 AI 腔）', () => {
  it('「缓缓说道」「淡淡一笑」被命中且给出改法', () => {
    const text =
      '他缓缓说道，这件事不必再提。她淡淡一笑，没有接话。他轻轻叹了口气，转身走了。' +
      '他默默站着，看天色一点点暗下去，又想起许多旧事，心里说不出是什么滋味，只觉得累。'.repeat(3);
    const r = detectFlavor(text, 'x', DEFAULT_FLAVOR_CONFIG);
    const hit = r.hits.find((h) => h.kind === '副词+动词');
    expect(hit).toBeDefined();
    expect(hit!.advice).toContain('副词');
  });
});

// ── 免责声明 ─────────────────────────────────────────────────────────

describe('产品定位：写作体检而非 AI 判决', () => {
  it('★ 免责声明存在且明确否定「据此断定是否 AI 生成」', () => {
    expect(FLAVOR_DISCLAIMER).toContain('写作体检');
    expect(FLAVOR_DISCLAIMER).toContain('不能据此断定');
    expect(FLAVOR_DISCLAIMER).toContain('网文');
  });
});

// ── 引擎版本 ─────────────────────────────────────────────────────────

describe('报告元信息', () => {
  it('★ 报告带引擎版本（前后对比时判断口径是否变化）', () => {
    const r = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    expect(r.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('★ 批量检测确定性：同输入两次结果一致（无随机）', () => {
    const a = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    const b = detectFlavor(AI_FLAVOR, 'a', DEFAULT_FLAVOR_CONFIG);
    expect(a.index).toBe(b.index);
    expect(a.hits.length).toBe(b.hits.length);
    expect(a.hits.map((h) => h.offset)).toEqual(b.hits.map((h) => h.offset));
  });
});

// ── 句子切分 ─────────────────────────────────────────────────────────

describe('句子切分', () => {
  it('按中文句末标点切分', () => {
    const s = splitSentences('他走了。她没说话！真的吗？');
    expect(s).toHaveLength(3);
  });

  it('★ 闭引号后的句号也算句末', () => {
    const s = splitSentences('“你来了。”他说。');
    expect(s.length).toBeGreaterThanOrEqual(1);
  });

  it('带 baseOffset 时偏移正确', () => {
    const s = splitSentences('他走了。', 100);
    expect(s[0].start).toBe(100);
  });
});
