/**
 * craft-skills：写作工艺技能注册表（P1-B Task 1）。
 *
 * ★ 版权红线声明：本文件的六条 skill **机制**参照商业写作资产方法论
 *   （WinkNovel / NovelCraft 的公开工艺思路），但全部正文均为原创中文
 *   可执行指令，未逐字复制任何商业提示词文本。
 *
 * ★ 用途：装配器（assemble.ts）按「本章章纲标题 + 章末钩子 + 题材」做
 *   触发词子串匹配，命中的 skill 以可压缩槽（craftSkills，sacrificeRank 2，
 *   hardCap 1200 tokens）注入写手 user 上下文。注册序即匹配返回序。
 */

/** skill 适用的流水线角色 */
export type CraftRole = 'writer' | 'architect' | 'polisher';

/** 一条写作工艺技能：触发词任一子串命中即入选，roles 决定注入给谁。 */
export type CraftSkill = {
  id: string;
  title: string;
  triggers: string[];
  roles: CraftRole[];
  body: string;
};

/**
 * 六条注册技能。顺序即 matchSkills 的返回顺序（注册序）。
 * 正文全部为原创措辞的可执行指令，每条 3-5 行。
 */
export const CRAFT_SKILLS: CraftSkill[] = [
  {
    id: 'causal-outline',
    title: '因果链章纲',
    triggers: ['卷纲', '章纲', '大纲'],
    roles: ['architect'],
    // 机制参照 WinkNovel outline 因果句硬规则，文本原创。
    body: [
      '章纲里的每一句都必须写成因果链：「因为A，所以B，但C」。',
      'A 是上一章留下的既成事实，B 是主角由此被迫采取的动作，C 是动作引出的意外阻力。',
      '禁止把章纲写成事件罗列（先…然后…接着…）——罗列句一律重写为因果句后再交付。',
      '自查方法：遮住任意一句，若上下文读不出「为什么会这样」，该句不合格。',
    ].join('\n'),
  },
  {
    id: 'chapter-hook',
    title: '章末钩子三件套',
    triggers: ['钩子', '章末', '结尾'],
    roles: ['writer'],
    // 机制参照 WinkNovel 章末钩子工艺，文本原创。
    body: [
      '章末钩子三件套，缺一件就不算收章：',
      '一、已付代价的实物——本章冲突在主角手里或身上留下一个看得见的东西（伤、信件、破损的器物）；',
      '二、未解的问题——这个实物指向一个本章内绝不回答的疑问；',
      '三、下章第一个动作的引子——最后一句必须让读者能预见主角接下来不得不做的那件事。',
      '只把钩子亮出来，不解释它，更不在本章内解决它。',
    ].join('\n'),
  },
  {
    id: 'five-senses-open',
    title: '五感切入开场',
    triggers: ['开篇', '开场', '第一章'],
    roles: ['writer'],
    // 机制参照 WinkNovel 五感切入，文本原创。
    body: [
      '开场第一句先给一个可感知的物理细节：温度、声音或气味，三选一只写一个。',
      '第二句起才允许出现人物——让读者先站进场景，再看见站在场景里的人。',
      '禁止用天气综述、时代背景或人物履历开章；这些信息由后续动作自然带出。',
      '自查方法：遮住第一段，若读者说不出「此刻身处何地、身体感觉到什么」，重写。',
    ].join('\n'),
  },
  {
    id: 'subtext-dialogue',
    title: '潜台词交锋',
    triggers: ['对话', '谈判', '对峙'],
    roles: ['writer'],
    // 机制参照 WinkNovel 潜台词交锋，文本原创。
    body: [
      '写对话前先在草稿外给双方各定一个不说出口的目的，两者必须互相冲突。',
      '台词只允许说表面事：价钱、天气、旧物、流程——真实目的靠停顿、岔题、答非所问泄露。',
      '任何一方直接说出自己的目的，该段对话作废重写。',
      '收束条件：表面事谈成了或谈崩了，但两个隐藏目的都仍未摊牌。',
    ].join('\n'),
  },
  {
    id: 'de-ai-sentence',
    title: '去AI句式',
    triggers: ['润色', '去AI', '文风'],
    roles: ['writer'],
    // 机制参照 WinkNovel 去AI句式表方法论，不搬表，文本原创。
    body: [
      '连续三句里出现「仿佛」「宛如」「不禁」中的任意组合，立即删掉其中两个，最多留一个。',
      '抽象情绪词（愤怒、悲伤、紧张、绝望）不许直接写——改成一个能被镜头拍出来的动作。',
      '例：不写「她很紧张」，写「她把同一颗纽扣系了三次」。',
      '每章交稿前通读一遍，专挑比喻堆叠句与情绪形容词句下手。',
    ].join('\n'),
  },
  {
    id: 'words-hard-cap',
    title: '字数硬约束',
    triggers: ['字数', '目标'],
    roles: ['writer'],
    // 机制参照 NovelCraft 字数硬控制，文本原创。
    body: [
      '本章字数目标是硬约束，不是参考值：写到目标的九成时，必须开始收束冲突。',
      '收束靠砍支线、并场景、提前引爆对峙，绝不靠加描写、加回忆、加环境说明凑字。',
      '超目标一成即视为失败稿——宁可提前一章留钩子，也不许注水拖长。',
      '动笔前先按目标字数反推场景数，每个场景分配额度，写到额度就切下一场。',
    ].join('\n'),
  },
];

/**
 * 触发匹配：text 含某 skill 任一触发词子串、且该 skill 的 roles 含指定角色，
 * 即入选；返回顺序保持注册序。
 */
export function matchSkills(text: string, role: CraftRole): CraftSkill[] {
  return CRAFT_SKILLS.filter((s) => s.roles.includes(role) && s.triggers.some((t) => text.includes(t)));
}
