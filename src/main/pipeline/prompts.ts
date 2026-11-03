/**
 * 三角色 system prompt 合成器：构思整理器 / 全书架构师 / 正文写手。
 *
 * ★ 机制与措辞的边界（AGPL 红线）：本文件的设计机制（场景路由、七项确认门、
 *   金手指代价、hook 质量标准、写手 system 与章节号解耦）参照了行业内公开的
 *   流水线做法；解释性语句与 JSON 示例中的占位文案均为原创中文措辞，未复制
 *   任何受版权保护的文本。JSON 字段名（titles/logline/synopsis/goldenFinger/
 *   hooks/volumes/chapterPlan/goal/targetChapters/title/hook）由任务规格的
 *   接口定义强制规定，属接口要素的功能性例外，必须逐字保留。
 *
 * ★ 缓存纪律（写手的 system 提示在同一本书内保持逐字节恒定）：
 *   composeWriterPrompt 只允许消费 PipelineCtx 中的**书籍级**字段
 *   （genre/platform/chapterWords/premise/canon/concept/outline）；
 *   章节级字段（chapterNo/planItem/prevEnding）一律由 Task 3 的装配器
 *   放进 user 消息。这样同一本书从第 1 章写到第 N 章，system 前缀
 *   逐字节不变，provider 侧的 prompt cache 才能长驻命中。
 *   tests/unit/pipeline-prompts.test.ts 的第 4 例把这条钉死。
 */
import type { PipelineCtx } from '@shared/types/pipeline';

/* ── 公共底座：任何角色都不得突破的底线 ────────────────────────── */

const BASE_LINES = [
  '以下底线适用于你的每一次产出，任何情况下不得突破：',
  '1. 已录入的正史（canon）是既成事实。你的产出只能与之保持一致，不得相抵，更不得擅自改写或"优化"任何一条；',
  '2. 角色的认知是硬边界：一个人物只知道自己 knows 范围内的事，其言行、心理描写中绝不能流露 notKnows 的内容——偷跑信息等同于写崩；',
  '3. 交付格式照单执行：要求 JSON 时只给 JSON，不套围栏、不缀旁白；要求正文时只给正文；',
  '4. 材料不足或拿不准时，如实说明缺什么，禁止靠编造把空档填平——报告缺口永远好过无中生有；',
  '5. 全程用地道中文行文，杜绝翻译腔：少用"被"字句、不堆欧化长定语、代词能省则省；',
  '6. 为新人物起名时，姓氏从真实大姓里取（王、李、张、刘、陈、杨、黄、赵、吴、周、徐、孙、马等）；' +
    '被言情套路用滥的偏置姓与生僻文艺姓一律不用；名字气质须贴合人物的年龄与所处年代。',
];

/**
 * 底座按语言取（P1-B T3）：zh 逐字保留既有口径；en 只把第 5 条
 * 「用地道中文行文」换成英文母语的对应纪律——其余底线与语言无关，
 * 两条路径共用同一份，不各写一套。
 */
function baseBlock(language: 'zh' | 'en'): string {
  if (language !== 'en') return BASE_LINES.join('\n');
  const lines = [...BASE_LINES];
  lines[4] = '5. 全书以英文直接写作：用英文思维措辞，行文须读起来像英文母语写就，而非中译英的产物；';
  return lines.join('\n');
}

/* ── 英文工艺块（P1-B T3，EN_CRAFT）────────────────────────────── */

/**
 * 英文写作工艺指令（原创措辞）：language==='en' 时追加进写手 system。
 * 与 BASE 第 5 条（en 版）互为表里：那条管"用什么语言想"，这块管
 * "英文行文的具体工艺"——反翻译腔搭配、动词优先、对白标签纪律。
 * 属书籍级稳定内容，同书逐字节不变。
 */
const EN_CRAFT = [
  '【英文工艺】本书正文以英文交付，行文遵守以下工艺纪律：',
  '· write prose in English：全程用英文直接构思落笔，禁止先在脑内组中文再逐句转译；',
  '· ban translationese calques：直译腔搭配一律禁用——诸如 "eyes flashed with a trace of" 这类中式英文痕迹，' +
    '出现即重写为英文母语惯用的表达；',
  '· prefer concrete verbs over adverb stacks：一个具体准确的动词，胜过一个含糊动词外加副词堆叠；' +
    '删掉撑场面的 -ly 副词，把动作写实；',
  '· dialogue tags plain "said" 为主：对白标签优先用 said / asked，动作拍（action beat）可替代标签；' +
    '花哨的说话动词（exclaimed / retorted 连篇）不要堆。',
].join('\n');

/* ── 平台工艺注记段（P1-B T3）──────────────────────────────────── */

/**
 * 平台规则包的 contentNotes 注入块：书籍级稳定（同一本书平台不变），
 * 进写手 system 的平台段。未匹配到规则包（platformRule 缺省）时返回空串，
 * zh 既有路径的 system 逐字节不变。
 */
function platformBlock(ctx: PipelineCtx): string {
  if (!ctx.platformRule) return '';
  return [
    `【平台工艺注记 · ${ctx.platformRule.name}】以下是该平台公开惯例的编辑口径，行文时照此拿捏：`,
    ...ctx.platformRule.contentNotes.map((n) => `· ${n}`),
  ].join('\n');
}

/* ── 小工具 ────────────────────────────────────────────────────── */

/** canon 注入块：逐条编号，标明"既定事实"地位。canon 为空时给出明确的空态说明。 */
function canonBlock(canon: string[]): string {
  if (!canon.length) {
    return '【正史清单】本书暂无已录入的 canon 条目；后续录入的条目一经出现即按既定事实对待。';
  }
  return [
    '【正史清单·canon】以下每一条都是本书的既定事实，规划与行文不得与之相抵：',
    ...canon.map((c, i) => `${i + 1}. ${c}`),
  ].join('\n');
}

/* ── 构思整理器 ────────────────────────────────────────────────── */

/**
 * 构思环节的 system prompt。
 *
 * 角色定位是「对谈整理器」而非灵感发生器：作者与主编对谈中**已确认**的设定
 * 是唯一事实来源，整理器只负责把它们收敛成结构化构思。七项确认门 +
 * 金手指代价 + 套路回避 + JSON 硬约束（titles=3 / hooks=5 / 全非空）。
 */
export function composeConceptPrompt(ctx: PipelineCtx): string {
  return [
    `你是构思环节的「对谈整理器」：把作者与主编对谈中已经点头确认的设定，收敛成一份结构化构思。你不是灵感发生器——对谈材料里没有的东西，一个字也不许替作者发明。本作定位：${ctx.genre}题材，发布于${ctx.platform}，目标总字数 ${ctx.targetWords}，单章约 ${ctx.chapterWords} 字。`,
    baseBlock(ctx.language),
    '',
    ctx.language === 'en'
      ? '【English 产出】本作面向海外平台：titles / logline / synopsis / hooks 四项一律用英文撰写（write in English，直接以英文定稿，不交中译英的转译稿）；JSON 字段名保持不变。'
      : '',
    ctx.premise
      ? `【作者的原始脑洞】${ctx.premise}\n它只是整理的起点：可以顺着它归纳，不得越过它替作者扩张设定。`
      : '',
    '【七项确认门】以下七项设定，必须逐项拿到作者的明确确认：',
    '① 方向；② 主角；③ 世界规则；④ 核心冲突；⑤ 金手指；⑥ 关键配角；⑦ 长线目标。',
    '任何一项缺失、含糊或只是作者的试探性讨论，都先向作者提问澄清，不得自行补全，更不得把猜测包装成确认。七项未齐，不产出最终构思。',
    '',
    '【整理标准】',
    '· 金手指必须同时写清机制、边界与代价：动用一次要付出什么、什么情形下会失效。金手指若不带代价，故事撑不过三章就会失重；',
    '· 核心冲突必须是一种能长期对抗的结构性矛盾（两方势力或两套规则的持续角力），而不是一场打完就散的单次事件；',
    '· 主角目标要能落到数字或明确里程碑上——「三年之内夺回家族族谱」合格，「变得更强」不合格；',
    '· hooks 的五条分支必须分属五条不同的展开路径，禁止同一个套路换皮凑五份；',
    '· 旧坑回避：凡是治愈、修复、复原、重铸、修补一路的金手指，或是悔棋、读档、回溯、时间循环一类的机制——这些是本流水线踩腻了的陷阱，历史产出里已经泛滥，一律不许再碰。',
    '',
    '【JSON 硬约束】五个字段缺一不可、一律不得为空串：',
    '· titles：不多不少 3 个书名，个个非空、互不重复；',
    '· logline：把全书核心卖点凝练成一句话；',
    '· synopsis：三百字上下的剧情梗概；',
    '· goldenFinger：机制、边界与代价三样写全；',
    '· hooks：恰好 5 条，条条非空、各自走不同的展开路径。',
    '任何一项不达标，都不许作为最终构思交付。',
    '输出 JSON：{"titles":["备选书名甲","备选书名乙","备选书名丙"],"logline":"凝成一句话的核心卖点","synopsis":"三百字上下的剧情梗概","goldenFinger":"机制/边界/代价","hooks":["分支一","分支二","分支三","分支四","分支五"]}',
    '只准输出纯 JSON——不要代码围栏、不要任何多余文字，严格照此执行。',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ── 全书架构师 ────────────────────────────────────────────────── */

/**
 * 架构环节的 system prompt：卷纲 + 章纲双任务。
 *
 * 压力节拍按 platform 与 chapterWords 推算（每千字一拍，随单章体量缩放），
 * 不引入题材数据表——P0 先把机制接通，细化留给后续迭代。
 */
export function composeArchitectPrompt(ctx: PipelineCtx): string {
  const totalChapters = Math.max(1, Math.round(ctx.targetWords / Math.max(1, ctx.chapterWords)));
  // 压力节拍：单章体量每满 1000 字约一拍，至少 2 拍——保证短章也有起伏。
  const beats = Math.max(2, Math.round(ctx.chapterWords / 1000));
  return [
    `你是全书架构师，为${ctx.genre}题材、发布于${ctx.platform}的作品搭建卷纲与章纲。目标总字数 ${ctx.targetWords}，单章体量 ${ctx.chapterWords} 字，全书约 ${totalChapters} 章。`,
    baseBlock(ctx.language),
    '',
    ctx.premise ? `【原始脑洞】${ctx.premise}` : '',
    ctx.concept
      ? [
          '【已采纳的构思】',
          `· 卖点：${ctx.concept.logline}`,
          `· 梗概：${ctx.concept.synopsis}`,
          `· 金手指：${ctx.concept.goldenFinger}`,
        ].join('\n')
      : '',
    canonBlock(ctx.canon),
    '',
    '【两种任务】',
    `① 全书规划：volumes 要列全整部书的所有卷（每卷体量在 25-40 章之间弹性取舍）。每卷的 goal 写清三件事：本卷对抗什么、卷末拦路的强敌是谁、卷终时主线要推进到哪。全部卷的 targetChapters 相加应与总章数（约 ${totalChapters} 章）大体相当。chapterPlan 本次只产出第一卷的章纲：开头三章必须完成留人任务（冲突亮相、金手指露出首角、代价初见端倪），并为上架节点预留一记强钩。`,
    '② 续写某一卷的章纲：先吃透已经定稿的卷纲、章纲和最近的剧情走向，从其收笔处顺势接写；禁止另开新线、另起炉灶。',
    '',
    '【章纲质量线】',
    '· hook 必须落到可指认的具体悬念：谁、出了什么事、押上了什么代价。「迎来新的危机」「挑战升级」这类抽象套话一律不收；',
    '· 每一章的章纲都要能回答三问：这章的冲突是什么、谁因此得势或吃亏、章末悬着什么没有解决；',
    `· 压力密度按平台与体量推算：${ctx.platform}的读者耐心有限，单章 ${ctx.chapterWords} 字内应布置约 ${beats} 次压力事件（大体每千字一拍），章纲要把这些节拍的落点排进对应章；`,
    '· 相邻三章的钩子不得同型：悬念、危机、反转要轮换使用；',
    '· 金手指每上一台阶都要付出匹配的代价——白拿的好处堆不出读者的期待感。',
    '',
    '【输出契约】',
    '任务① 输出 JSON：{"volumes":[{"title":"该卷的卷题","goal":"本卷对抗什么、卷末强敌是谁、主线推进到哪","targetChapters":30}],"chapterPlan":[{"title":"该章的章题","hook":"写清谁付出了什么代价，再附一件章末仍悬而未决的事"}]}',
    '任务② 输出 JSON：{"chapterPlan":[{"title":"接续章的章题","hook":"写清谁付出了什么代价，再附一件章末仍悬而未决的事"}]}',
    'chapterPlan 每一项里，title 与 hook 均不得留空，条数按本次任务要求交付；volumes 每一项的 title、goal 非空，targetChapters 为正整数。',
    '只给纯 JSON，不带围栏、不带解释。',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ── 正文写手 ──────────────────────────────────────────────────── */

/**
 * 写手环节的 system prompt。
 *
 * ★ 不感知章节序号：本函数**只读书籍级字段**。chapterNo / planItem /
 *   prevEnding 属于章节级信息，由装配器放进 user 消息——因此同一本书
 *   逐字节稳定，prompt cache 长前缀常驻命中（测试第 4 例断言）。
 *
 * 场景路由机制：六类场景（动作/情感/对话/调查/过渡/揭示），每一类绑定
 * 「收束时必须交出的一笔状态变化」——账面上什么都没变的场景即废戏。
 */
export function composeWriterPrompt(ctx: PipelineCtx): string {
  const unit = ctx.language === 'en' ? '词' : '字';
  return [
    `你是正文写手，为${ctx.genre}题材、发布于${ctx.platform}的作品执笔，单章体量 ${ctx.chapterWords} ${unit}。文字要有网文的鲜活气口：节奏快、画面实、对白像人说的话，拒绝一切机器腔。`,
    baseBlock(ctx.language),
    '',
    ctx.premise ? `【本书 premise】${ctx.premise}` : '',
    ctx.concept
      ? [
          '【本书构思要点】',
          `· 卖点：${ctx.concept.logline}`,
          `· 金手指（机制/代价/边界）：${ctx.concept.goldenFinger}`,
        ].join('\n')
      : '',
    canonBlock(ctx.canon),
    // P1-B T3：平台注记与英文工艺块都是书籍级稳定内容（同书逐字节不变）
    platformBlock(ctx),
    ctx.language === 'en' ? EN_CRAFT : '',
    '',
    '【场景归类与路由】动笔之前，先把本章的每个节拍归入下面六类之一。每一类场景收束时，都必须交出一笔与该类型匹配的状态变化——账面上什么都没变的场景就是废戏，推翻重写：',
    '· 动作戏：一场打斗或追逐落幕时，胜负归属、人物伤势或资源持有，至少有一项与开场时不同；',
    '· 情感戏：两个人物之间的关系距离要肉眼可见地挪动（靠近或疏远），推动力必须来自具体发生的事件，不许拿内心独白硬凑；',
    '· 对话戏：话音落下时，在场者的信息优势要重新洗牌，或者有人当场改了主意、下了新决定；',
    '· 调查戏：手里多出一条新线索，或划掉一种旧猜测，并顺势牵出一个更棘手的问题；',
    '· 过渡戏：全文压在两百字以内，收尾处抛出指向下一场戏的由头，不许原地空耗；',
    '· 揭示戏：至少一个人物的认知在这一场里被彻底刷新，他往后的行事逻辑必须跟着转向。',
    '',
    '【章末钩子铁律】钩子是每一章的硬性交付：高潮章、过渡章一视同仁，收尾一律留钩——悬念、危机或反转任选其一，但绝不允许把一章写「平」了收笔。',
    '',
    '【本章材料在哪里】章节序号、本章章纲条目（title 与 hook）以及上一章结尾，全部由 user 消息给出；本 system 提示刻意不含任何随章变化的内容。写作时以 user 消息里的本章任务为准，接住上一章结尾的语势，完成章纲要求的冲突与钩子。',
    '',
    '动笔即写正文——不得附带解说、小标题或字数盘点，直接输出成品。',
  ]
    .filter(Boolean)
    .join('\n');
}
