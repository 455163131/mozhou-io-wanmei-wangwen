/**
 * AI 味引擎 v2 校准回归测试（T02）。
 *
 * ★ 六条核心验收（对应 docs/FLAVOR_CALIBRATION_DESIGN.md §1.2 / §1.2.1 / §3.3 / A.5）：
 *   1. **零膨胀（计数口径）**：connector / parallel 语料 p95=0，绝不能让「1 次出现」直接跳满分，
 *      否则作者随手写个「然而」就被判 100（v1 的真实缺陷）。判据用**出现次数**而非密度，
 *      `denom = KZ × max(corpusMaxCount, 1)`（connector→33、parallel→17/33/100）。
 *   2. **长度无关性**：同一段含 1 个「然而」的文本，补足到 ~600 字与 ~3000 字得分**完全相同**——
 *      这是「改用计数口径」的核心目的（密度口径下短章会被过度惩罚）。
 *   3. **判据方向**：high-bad 边界取 p95、low-bad 边界取 p05——此方向曾被写反，
 *      故用正反两向的断言把它锁死。
 *   4. **三章真实原文回归**：v2 校准后这三章必须显著回落（旧值 3 / 17 / 28）到
 *      **2 / 9 / 13 且全部判为 clean**。
 *   5. **旧口径基线不得静默兜底**：缺 `corpusMaxCount`（含 `null`）的基线 → 零膨胀维度 unjudged + 披露，
 *      绝不 `?? 0` 猜一个 denom（否则 parallel 的「1 处」会被静默算成 33 而非 17）。
 *   6. **QA 修正回归**（D1/D2/D3）：D1 并排结构正则改惰性（相邻不再合并计数）；
 *      D2 `null` 字段等同缺字段；D3 基线非单调（p05>p95）→ unjudged 而非静默满分。
 *
 * ★ 三章正文**内联在本文件**（不读磁盘、不依赖绝对路径），取自作者定稿语料
 *   《系统面板永远是零》，与基线脚本 §A.5 用的是同一份。
 *
 * ★ B11 契约：`detectFlavor` 的入参是**章节正文（不含标题行）**。本文件用
 *   「body-only vs 标题+body」的对照测试证明「标题行影响可忽略（≤1 分）」，
 *   以此**锁定契约**——而不是去给引擎加「剥离首行」逻辑（那会误删第一段正文）。
 */
import { describe, it, expect } from 'vitest';
import {
  detectFlavor,
  PARALLEL_PATTERNS,
  scoreByDeviation,
  scoreZeroInflated,
} from '@shared/ai-flavor/engine';
import {
  DEFAULT_FLAVOR_BASELINE,
  type FlavorBaseline,
  type MetricBaseline,
} from '@shared/ai-flavor/baseline';
import { DEFAULT_FLAVOR_CONFIG } from '@shared/types/ai-flavor';

// ── 三章真实原文（body-only，内联）─────────────────────────────────────

/** 第 1 章 穷鬼也配（正文，不含标题行） */
const CH1 = `秦野站在青州国际大酒店的旋转门外，手插在兜里，捏着口袋里最后三十八块钱。

他本来不想来。

三天前，大学同学群炸了锅。赵天磊从省城回来，要在青州国际摆一桌，全班同学，他全包。群里刷了三百多条消息，秦野一条没回。直到今天下午，组织者张涛私聊他：“老同学一场，来吧。赵少特意点名让你来。”

“特意点名”这四个字，秦野盯着看了很久。

他还是来了。他想看看，四年过去，这些人能难看到什么程度。

包厢在七楼。门一推开，酒气和香水味扑面而来。长桌上摆着两排红酒，赵天磊坐在主位，西装笔挺，手腕上那块表在灯下反着光。

十几个人，几乎全到了。

秦野刚坐下，赵天磊就笑了。

“哟。”他拖长了调子，“这不是咱们班的学霸吗。当年高考六百多分，全年级第一的秦野。”

他端起酒杯晃了晃。

“现在在哪儿高就啊。”

包厢里静了一下，十几双眼睛齐刷刷看过来。

秦野拿起筷子，夹了口菜。

“宏发装饰，跑业务。”

“跑业务。”赵天磊把这三个字含在嘴里嚼了一遍，“就是那种……站在小区门口见人就递名片，人家还得绕着走的那种。”

哄笑。

秦野嚼着菜，没抬头。

“秦野，你现在一个月挣多少啊。”坐在斜对面的一个女生笑着问。

“够花。”

“够花是多少。”她追了一句。

秦野没答。

旁边有人接了话：“哎，你们还记得吗，高三那年秦野他爸厂子出事，全班都传他要去打工了。”

“记得记得。”

“后来他不是考上大学了吗。我还以为他能翻盘呢。”

“翻什么盘啊。”赵天磊笑了一声，“现在不还是在跑业务。”

秦野握着筷子的手，指节有点发白。

这时，坐在长桌另一头的老班长周敏忽然开口。

“行了，”她说，“吃饭吧。”

声音不大，包厢里却静了一下。

赵天磊瞥了她一眼，笑着摆手：“班长还是这么护着他。”

周敏没接话，低头喝汤。

秦野看了她一眼。

整个包厢里，只有她一个人没笑。

“天磊，别说了。”

又一个女声开口。

秦野的筷子顿了一下。

林菲坐在赵天磊右手边。

他谈了三年的女朋友。半年前分的手。

分手那天她站在他家楼下，说：“秦野，我等不起了。你爸留下的那堆债，你打算还到什么时候。”

现在她坐在赵天磊旁边，无名指上戴着一枚钻戒。

“秦野。”林菲看着他，语气很平，像在念一份通知，“我和天磊，下个月订婚。”

包厢里静了一秒。

然后是更响的笑。

有人起哄，有人拍桌子，有人扯着嗓子喊“恭喜赵少”。

秦野放下筷子，抬起头。

“挺好。”他说，“他比我强。至少他现在还不欠人三个月工资。”

笑声卡了一下。

有两个人低下头，假装喝汤。

赵天磊脸色变了变，很快又笑起来。他放下酒杯，身子往前倾。

“秦野，你嘴还是这么利。”

他顿了顿，慢条斯理地。

“不过，你爸当年欠的那笔钱，还完了吗。”

这一句，把秦野钉在了椅子上。

包厢里彻底安静了。

那笔钱。

四年前，父亲秦振国的建材厂出事，欠了供货商和银行两百多万。厂子倒了，人也没了。父亲走的时候，秦野刚上高三。

债是他一个人还的。打工、借钱、把老宅里的东西一件件卖出去。到去年年底，还剩六十多万。

而眼前这些人，四年前还在群里讨论“秦野他爸是不是跑路了”。

秦野的手指按在桌沿上，按得指节发白。

三秒钟。

这四年里，他想过无数次，如果再见到这些人会怎么样。他以为自己会掀桌子，会骂回去，会一拳砸在赵天磊脸上。

但真到了这一刻，他什么都没做。

他只是站起来。

他把椅子轻轻推回去，没有发出一点声音。

“你们慢用。”

他转身往外走。

身后是笑声。压抑了一下，然后毫无顾忌地炸开。

“穷鬼还装什么清高……”

“他爸要是活着，也得被他气死。”

门在他身后合上。

走廊很长，灯很亮。秦野走得很快，一步都没停。

路过洗手间的时候，他停下来，对着镜子看了一眼自己。

衬衫领口湿了一块，头发被汗黏在额头上，脸色难看得像一张揉过的纸。

他看了三秒钟，然后继续往前走。

直到进了电梯，门关上的那一刻，他才发现自己的手在抖。

外面在下暴雨。

雨点砸在酒店的台阶上，溅起一片水雾。秦野站在檐下，没有走。

他掏出手机。

屏幕上有三条未读。

一条是房东：“小秦，下个月房租记得按时啊，三号。”

一条是公司群。

【通知：因公司资金周转困难，本月工资延期发放，具体时间另行通知。】

群里没人回。

还有一条，是王大壮发来的：“哥，你在哪呢。我今晚炖了排骨，你来不来。”

秦野看着那条消息，看了很久。

他打了两个字：“不了。”

然后把手机塞回兜里。

三十八块。

一个月房租八百。下个月三号到期。

雨越下越大。

酒店门口停着一排车。来接人的，等人的，车灯连成一片，暖黄色的光打在湿漉漉的地面上。

秦野从那排车中间穿过去。

没有一个人看他。

他走下台阶，走进雨里。

他没有撑伞。他也没有伞。

雨水顺着头发淌进领口，冰得人一激灵。他仰起头，让雨砸在脸上。

四年了。

他一直在往前走，走得很慢，但他以为至少在往前走。

直到今天他才发现，他只是在原地踏步。而那些人，早就把他甩在了后面，还要回过头笑一笑。

“凭什么。”

他听见自己的声音，很小，被雨声盖住了。

“凭什么。”

他攥紧了拳头。

就在这时。

手机亮了。

不是微信，不是短信。

屏幕整个白了一片，白得刺眼，白得不像手机能发出的光。

一行字，一个字一个字地往外跳。

【检测到宿主强烈意愿】
【意愿强度：98.7%】
【钞能力系统绑定中……】
【3】
【2】
【1】`;

/** 第 237 章 留一张（正文，不含标题行） */
const CH237 = `恒昌厅挂满三十七张老照片，每一张上都少一个人，背面写着留一张。

第四百六十八天，上午。

江城。江城会展中心，二层。

恒昌厅的门锁着。

门是双开的，包着深色木皮，门牌上三个字，铜的，磨得发亮。

走廊里铺着地毯，地毯是暗红的，中间踩出一道浅色的印子。

会展中心很大，二层一共有十一个厅。

恒昌厅在最里头。

秦野从电梯口走过来，走了一分半钟。

门厅里有个前台，前台上摆着一块牌子，写着今天的会。

今天的会是建材行业的一个培训，在三号厅。

恒昌厅不在牌子上。

秦野在门口站了一会儿。

一个穿制服的人从走廊那头过来。

“您找谁。”

“这厅，”秦野说，“一年开几回会。”

那人看了他一眼。

“三四回。”

“其余时间呢。”

“锁着。”

“我能进去看看吗。”

那人犹豫了一下，从腰上取下一串钥匙。

钥匙串上挂着十几把，他挑了半天，挑出最里头那把。

“这厅，”他说，“有半年没开过了。”

“半年。”

“上一回是五月份，开了三天会。”他说，“会开完就锁上了。”

“五月份开的什么会。”

“不知道。”那人说，“我就管开门锁门。”

“看看可以。”他说，“别动东西。”

……

门开了。

灯是一排一排按亮起来的，从门口一直亮到最里头。

灯是筒灯，一共四排，亮起来的时候有轻微的电流声。

屋子里有股旧纸的味道，还有一点樟脑味。

地是木地板，打过蜡，人走上去有回声。

里面不像会场。

桌子椅子都堆在最里头那面墙的墙根，摞得整整齐齐，上面蒙着一层布。

这厅是按八百个座位建的，主席台也拆了，台板靠在墙边。

四面墙上，挂满了照片。

一张挨着一张，从门口一直挂到最里面那面墙。

照片是黑白的，也有彩色的，都装在同一种深色木框里。

框子一样大，挂的高度也一样，底下都对齐了。

照片下面有铜牌，铜牌上刻着年份和事由。

最小的照片巴掌大，最大的一张，有半人高。

秦野往里走。

地板上有几处划痕，是从墙边一直划到中间的，像是搬东西的时候蹭的。

墙上没有别的装饰，只有照片。

第一张，一九九八年，恒昌实业挂牌。

第二张，一九九九年，城北厂第一炉料出窑。

第三张，二〇〇三年，恒昌物流园开工。

第四张，二〇〇五年，恒昌物流的第一批车队。

第五张，二〇〇八年，城北厂扩建。

第六张，二〇一〇年，恒昌厅第一次办年会。

秦野一张一张看。

照片里都是人。

有的人在剪彩，有的人在签字，有的人在握手。

有的人站在料堆前头，戴着安全帽，脸上全是灰。

秦野一张一张看过去。

一九九八年到二〇一六年，十九年，三十几张照片。

照片里的楼越盖越高，人越站越多。

可每一张照片的边上，都留着一点空。

秦野走到最里面那面墙前。

那面墙上挂着最大的一张。

二〇一六年，恒昌实业成立十八周年。

照片里站着一排人，十来个人，穿着一样的深色西装。

最右边那个人，被剪掉了。

剪的时候是用尺子比着剪的，边上一点毛刺都没有。

留下的那个缺口，露出一小块白墙。

秦野把照片端平，缺口的高度跟旁边站着的人一样高。

那个人，跟他父亲差不多高。

剪口很齐，从上到下，一道直线。

秦野盯着那个剪口看了一会儿。

木框拿在手里，比看上去沉。

背板是薄木板，边角有点翘。

背板上贴着一张标签，标签上印着照相馆的名字，还有一排小字，是冲印的日期。

他把照片从墙上取下来。

照片背面，右下角，有一行钢笔字，写得很轻。

留一张。

秦野认得这个字。

这行字，跟第二百四十页上那一行，是同一只手。

写得很轻，像是怕把照片按坏。

墨是蓝黑的，洇开了一点。

秦野把照片翻过来又翻过去，看了两遍。

正面是三十几个人的合影，背面是三个字。

……

他把照片挂回原处，退了两步。

挂的时候，他把钉子对了两回才对准。

墙上那一处的漆比旁边浅一点，是常年不动的痕迹。

四面墙，一共三十七张照片。

他回过头，从第一张重新看起。

一九九八年那张，剪彩的人站了九个。

中间那一个，被人用刀片刮掉了脸。

一九九九年那张，站在窑口的人有六个。

最左边那个，整个身子都被剪掉了。

二〇〇三年那张，剪彩的绳子上，有两只手。

照片里只看得见一只手。

秦野一张一张数过去。

数到第三十七张，他停下来。

他数了两遍。

第一遍数到三十四，第二遍数到三十七。

三十七张。

从门口那张一九九八年的，到最里头那张二〇一九年冬天的，正好三十七张。

三十七张照片，三十七个位置。

每一个位置上，都少一个人。

少的那些，有的是剪掉的，有的是刮掉的，有的是用墨涂掉的。

剪掉的十七张，刮掉的九张，涂掉的十一张。

秦野把三种数了一遍，加起来三十七。

每一张，一种法子。

没有一张是用两种法子的。

秦野站在最后一张前头，看了一会儿。

照片上是二〇一九年冬天，恒昌厅办过一次年会。

一屋子人，举着杯子。

秦野在人群里找了一圈。

他没找到他父亲。

他又从左边找了一遍，从右边找了一遍。

中间那一排，站着的都是熟面孔。

一九九八年剪彩的那九个，在这张照片里还剩四个。

四个里，有三个已经不在江城了。

一张也没有。

秦野退到门口，把四面墙看了一遍。

从门口看，照片一张挨一张，一直排到最里头。

每一张都是热闹的。

剪彩的，签字的，握手的，举杯的。

三十七张照片，每一张上都少一个人。

少的那个，从来不在照片里。

秦野把灯关了。

屋子暗下来的时候，最后一张照片上那点光还亮了一会儿。

他出了门，那个穿制服的人还站在走廊里。

“看完了。”

“看完了。”秦野说。

“这厅里挂的都是老照片。”那人说，“挂了十几年了。”

“谁挂的。”

那人摇了摇头。

“我来的时候就在。”

秦野下了楼。

出了会展中心的大门，街上的灯都亮着。

他站在台阶上，把三十七张照片又过了一遍。

三十七张照片，三十七个人。

他一张也没有看见自己的父亲。`;

/** 第 574 章 一根线（正文，不含标题行） */
const CH574 = `协会三楼今天没开会。会议室的门锁着，门上的钥匙孔里插着一张纸片。

十一月一号下午，秦野在协会。那根线是下午取出来的。

姓刘的把前门那本簿子从柜子里取出来，翻到第七页，搁在长条桌上。

“得拿镊子。”他说，“手一碰，线就散了。”

秦野把镊子递过去。姓刘的把镊子尖伸进第七页跟第八页中间，夹住线的一头，慢慢往外拉。

线很短，一寸不到。拉出来的时候带着一点灰。

“线出来了。”

线搁在一张白纸上。线是白的，棉的。一头打着结，另一头是断的，断口平。

“这一头是剪的。”

“剪的。”姓刘的说，“剪子剪的，断口平。”

“那一头打着结。”

“打着结。”姓刘的说，“结很小，是拿手打的。”

放大镜压上去。线的粗细很匀，一路上没有粗的地方。

“这一根线。”

“一根。”姓刘的说，“就这一根。”

秦野把那只手套从铁皮柜里取出来，搁在白纸旁边。手套是左手的。棉线，洗过好几水，边上起了毛。

放大镜压在手套上。手套的边上，有一处抽了线。抽出来的地方留着一个线头，线头不长，半寸。

“这一处。”

“抽线的地方。”姓刘的说，“手套上的线抽了一根。”

线搁在手套旁边，两根比着看。一根是线头，半寸。一根是夹在簿子里的，一寸不到。

颜色一样，粗细一样。

“一样。”

“一样。”姓刘的说，“棉线的，白的，都是一个粗细。”

“断口呢。”

放大镜换到手套那根线头上。

“手套这一头是拽断的。”他说，“拽断的断口不平，带毛。”

“簿子里那一根。”

“簿子里那一根是剪断的。”姓刘的说，“剪断的断口平。”

两根线并排搁着。

“一根拽断的，一根剪断的。”

“一根拽断的，一根剪断的。”姓刘的说，“可颜色跟粗细一样。”

“一个线团上的。”

“一个线团上的。”姓刘的说，“拽一根，剪一根。”

线收进一只小纸袋。

“这一根，是什么时候夹进去的。”

“不知道。”姓刘的说，“簿子上的线，纸边上没有压痕。”

“没有压痕。”

“没有。”姓刘的说，“线搁在纸中间，不压纸。搁多久都不留痕。”

“那纸上有别的没有。”

第七页上也照了一遍。第七页是一页登记。上头几行字，是铅笔写的。

“这一页。”

“这一页。”姓刘的说，“字是铅笔写的，跟别页一样。”

簿子对着灯看。第七页跟第八页中间，空了很窄的一道缝。缝里没有别的东西了。

“就一根线。”

“就一根。”姓刘的说，“我翻过三遍。”

簿子合上。

“这只手套是十月二十号晚上搁进柜子的。”

“二十号。”姓刘的说，“十七号柜子里。”

“这根线夹在簿子里，簿子在协会。”

“在协会。”姓刘的说，“锁在柜子里。”

秦野把纸袋搁进铁皮柜。

“两样东西，一个线团。”

“一个线团。”姓刘的说，“可它们在两个地方。”

“两个地方。”

“一个在十七号。”姓刘的说，“一个在这儿。”

柜门关上。

“手套上的线是拽断的，簿子里的线是剪断的。”

“拽断的，剪断的。”姓刘的说。

“拽断的那一根，是戴手套的人拽的。”

“簿子里这一根，是从哪一头剪的。”

“从结那一头往上剪的。”姓刘的说，“剪口离结一寸不到。”

“那剩下的线呢。”

“不知道。”姓刘的说，“剪下来的那一头，没在簿子里。”

“剪下来的那一头有多长。”

“说不好。”姓刘的说，“手套那根线头半寸，簿子里这一根一寸不到。两根加起来，不到两寸。”

“两寸。”

“两寸。”姓刘的说，“一个线团上的线，剪两寸，看不出来。”

“这根线是什么时候夹进簿子的。”

“不知道。”姓刘的说，“簿子一年一本，这一本是一九九三年到二〇〇三年。”

“十一年。”

“十一年。”姓刘的说，“这一页是第七页，一九九三年的登记。”

“一九九三年。”

“一九九三年。”姓刘的说，“线夹在第七页跟第八页中间，纸边上没有压痕。”

“没有压痕，就是搁进去的时候纸是松的。”

“纸是松的。”姓刘的说，“翻到那一页，纸中间有缝，线就搁得下。”

“这一根线，跟那只手套。”

“一个线团上的。”姓刘的说，“颜色、粗细，都一样。”

“手套是十月二十号晚上搁进柜子的。”

“二十号。”姓刘的说，“线在簿子里，簿子锁在协会。”

“两样东西，两个地方。”

“两个地方。”姓刘的说，“可它们是一个线团上的。”

“那这个线团在哪儿。”

“不知道。”姓刘的说，“线团不在协会。”

“在十七号吗。”

“不知道。”姓刘的说，“十七号那一只手套，边上抽了一根线。抽线的地方留着线头。”

“线头半寸。”

“半寸。”姓刘的说，“抽出来的那一根，在谁手里，不知道。”

“两寸线。”

“两寸。”姓刘的说，“一寸不到夹在簿子里，半寸留在手套上。”

“还差半寸。”

“还差半寸。”姓刘的说，“半寸线，找不出来。”

“找不出来。”

“找不出来。”姓刘的说，“可半寸线也能当记号。”

“什么记号。”

“线头的断口。”姓刘的说，“剪断的断口平，拽断的断口带毛。两头的断口对得上，就是一根线。”

“这一根线，先搁在这儿。”

“搁在这儿。”姓刘的说，“跟手套搁一块儿。”

“两样东西。”

“两样。”姓刘的说，“一只手套，一根线。”

“这一根线，能不能搁回去。”

“搁不回去。”姓刘的说，“线出来了，就塞不回原来的缝。”

“那就搁在这儿。”

“搁在这儿。”姓刘的说，“拿一张纸包上，写上日子。”

“写哪一天。”

“今天。”姓刘的说，“十一月一号，从第七页取出来的。”

“两寸线，包在一张纸里。”

“包着。”姓刘的说，“跟手套搁一块儿。”

“是。”姓刘的说，“剪断的那一根，是谁剪的，簿子上不写。”`;

// ── 1. 零膨胀软饱和 ──────────────────────────────────────────────────

describe('★ 零膨胀软饱和（**计数口径**，长度无关；connector p95=0，绝不能让 1 次出现即满分）', () => {
  /**
   * 语料实测画像（见 baseline.ts）。
   * ★ 判据走**计数口径**：`denom = KZ × max(corpusMaxCount, 1)`，与章节长度无关。
   *   `corpusMaxCount` = 语料中「单章出现次数」最大值，由基线脚本机械派生
   *   （connector=1、parallel=2，见 data/corpus_flavor_baseline.json）。
   */
  const connector: MetricBaseline = {
    p05: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p95: 0,
    mean: 0.0007,
    min: 0,
    max: 0.4708,
    corpusMaxCount: 1,
  };
  /** 语料实测的 parallel 画像（corpusMaxCount=2） */
  const parallel: MetricBaseline = {
    p05: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p95: 0,
    mean: 0.0112,
    min: 0,
    max: 1.8519,
    corpusMaxCount: 2,
  };

  it('★ connector 红线：出现 1 次 = 33、0 次 = 0、3 次 = 100', () => {
    // denom = 3 × max(1, 1) = 3
    expect(scoreZeroInflated(1, connector.corpusMaxCount!, 3)).toBe(33);
    expect(scoreZeroInflated(0, connector.corpusMaxCount!, 3)).toBe(0);
    expect(scoreZeroInflated(3, connector.corpusMaxCount!, 3)).toBe(100);
  });

  it('★ parallel 红线：1 / 2 / 6 次 = 17 / 33 / 100', () => {
    // denom = 3 × max(2, 1) = 6
    expect(scoreZeroInflated(1, parallel.corpusMaxCount!, 3)).toBe(17);
    expect(scoreZeroInflated(2, parallel.corpusMaxCount!, 3)).toBe(33);
    expect(scoreZeroInflated(6, parallel.corpusMaxCount!, 3)).toBe(100);
  });

  it('★ 恒有 corpusMaxCount / denom ≡ 1/3（作者自己最极端的一章也只有 33 分）', () => {
    expect(scoreZeroInflated(connector.corpusMaxCount!, connector.corpusMaxCount!, 3)).toBe(33);
    expect(scoreZeroInflated(parallel.corpusMaxCount!, parallel.corpusMaxCount!, 3)).toBe(33);
  });

  it('★ 对照：主公式对同一个正值会直接跳满（这正是必须换零膨胀的根因）', () => {
    // 主公式边界 p95=0：任意正值即 d>0 → span=ε → 直接 100
    const main = scoreByDeviation(1, connector, 'high-bad');
    expect(main.score).toBe(100);
    expect(scoreZeroInflated(1, connector.corpusMaxCount!, 3)).toBeLessThan(50);
  });

  it('★ 长度无关性（本例证伪的核心）：同一段含 1 个「然而」的文本，补足到 ~600 字与 ~3000 字，得分完全相同（都 33）', () => {
    const core = '然而，他站在门口看了一会儿。';
    const filler = '他继续向前走着，没有回头。'; // 无模板连接词 / 无对仗结构
    const short600 = core + filler.repeat(45); // ≈ 599 字
    const long3000 = core + filler.repeat(229); // ≈ 2991 字

    const rs = detectFlavor(short600, 'short', DEFAULT_FLAVOR_CONFIG);
    const rl = detectFlavor(long3000, 'long', DEFAULT_FLAVOR_CONFIG);
    const sc = rs.dimensions.find((d) => d.dimension === 'template-connector')!;
    const lc = rl.dimensions.find((d) => d.dimension === 'template-connector')!;

    // 长度确实差了 ~5 倍（证明「长度无关」不是靠长度相近糊弄过去）
    expect(rl.chars).toBeGreaterThan(rs.chars * 4);
    // 计数都是 1 → 得分必须完全相同
    expect(sc.measured).toBe(1);
    expect(lc.measured).toBe(1);
    expect(sc.score).toBe(33);
    expect(lc.score).toBe(33);
    expect(sc.score).toBe(lc.score);
  });

  it('★ 端到端：真实章节里只多插 1 个「然而」，模板连接词维度不跳满（恰好 33）', () => {
    const withOne = CH237.replace('恒昌厅挂满', '然而，恒昌厅挂满');
    const r = detectFlavor(withOne, 'x', DEFAULT_FLAVOR_CONFIG);
    const tc = r.dimensions.find((d) => d.dimension === 'template-connector')!;
    expect(tc.measured).toBe(1);
    expect(tc.score).toBe(33);
  });

  it('★ connector=0 的章节该维度恒为 0（不误伤正常网文）', () => {
    const r = detectFlavor(CH237, 'x', DEFAULT_FLAVOR_CONFIG);
    const tc = r.dimensions.find((d) => d.dimension === 'template-connector')!;
    expect(tc.measured).toBe(0);
    expect(tc.score).toBe(0);
  });
});

// ── 1.5 旧口径基线（缺 corpusMaxCount）必须 unjudged + 披露，绝不静默兜底 ──

describe('★ 旧口径基线（缺 corpusMaxCount）→ unjudged + 披露，绝不静默兜底', () => {
  /**
   * 造一个「旧密度口径」基线：两个零膨胀指标都**没有** `corpusMaxCount`。
   * 语义 = 当年只存密度形态、没有计数字段的历史基线。
   */
  function oldDensityBaseline(): FlavorBaseline {
    const conn = { ...DEFAULT_FLAVOR_BASELINE.metrics.connector_per1000 };
    const para = { ...DEFAULT_FLAVOR_BASELINE.metrics.parallel_per100sent };
    delete conn.corpusMaxCount;
    delete para.corpusMaxCount;
    return {
      ...DEFAULT_FLAVOR_BASELINE,
      metrics: {
        ...DEFAULT_FLAVOR_BASELINE.metrics,
        connector_per1000: conn,
        parallel_per100sent: para,
      },
    };
  }

  it('★ 缺 corpusMaxCount → 该维度 skipped、不参与总评、且带可披露提示（绝不猜 33）', () => {
    const baseline = oldDensityBaseline();
    // CH237 里插入 1 个「然而」→ 计数 = 1；旧口径下**不能**给 33，应 unjudged。
    const withOne = CH237.replace('恒昌厅挂满', '然而，恒昌厅挂满');
    const r = detectFlavor(withOne, 'x', DEFAULT_FLAVOR_CONFIG, baseline);

    const tc = r.dimensions.find((d) => d.dimension === 'template-connector')!;
    expect(tc.skipped).toBe(true);
    expect(tc.score).toBe(0);
    expect(tc.note).toContain('旧口径');
    expect(tc.note).toContain('重建基线');

    // parallel 同样不可判（旧基线缺字段 → 不能静默按 denom=3 把 1 处算成 33）
    const ps = r.dimensions.find((d) => d.dimension === 'parallel-structure')!;
    expect(ps.skipped).toBe(true);

    // 这两维不参与总评：参与维度数 = 10 - 2 = 8
    expect(r.dimensions.filter((d) => !d.skipped)).toHaveLength(8);
  });

  it('★ 对照：同一基线补齐 corpusMaxCount 后该维度恢复判分（1 处 → 33）', () => {
    const baseline = oldDensityBaseline();
    const fixed: FlavorBaseline = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        connector_per1000: { ...baseline.metrics.connector_per1000, corpusMaxCount: 1 },
        parallel_per100sent: { ...baseline.metrics.parallel_per100sent, corpusMaxCount: 2 },
      },
    };
    const withOne = CH237.replace('恒昌厅挂满', '然而，恒昌厅挂满');
    const r = detectFlavor(withOne, 'x', DEFAULT_FLAVOR_CONFIG, fixed);
    const tc = r.dimensions.find((d) => d.dimension === 'template-connector')!;
    expect(tc.skipped).toBe(false);
    expect(tc.score).toBe(33);
  });

  it('★ corpusMaxCount === 0 是合法值（≠ 旧口径）：按 denom = max(0,1)×3 = 3 判分', () => {
    // 纯函数层：0 会被 max(0,1) 兜底为 1 → denom=3
    expect(scoreZeroInflated(1, 0, 3)).toBe(33);
    // 引擎层：corpusMaxCount=0 **不等于** undefined，必须正常判分而非 unjudged
    const baseline: FlavorBaseline = {
      ...DEFAULT_FLAVOR_BASELINE,
      metrics: {
        ...DEFAULT_FLAVOR_BASELINE.metrics,
        connector_per1000: { ...DEFAULT_FLAVOR_BASELINE.metrics.connector_per1000, corpusMaxCount: 0 },
      },
    };
    const withOne = CH237.replace('恒昌厅挂满', '然而，恒昌厅挂满');
    const r = detectFlavor(withOne, 'x', DEFAULT_FLAVOR_CONFIG, baseline);
    const tc = r.dimensions.find((d) => d.dimension === 'template-connector')!;
    expect(tc.skipped).toBe(false);
    expect(tc.score).toBe(33);
  });
});

// ── 1.6 QA 修正回归（D1 贪婪正则 / D2 null 序列化 / D3 基线单调性）──────

describe('★ QA 修正回归：D1 惰性正则 / D2 null 字段 / D3 基线单调性', () => {
  it('★ D1 正则已改惰性：单个「仿佛…一般」模式不再吞并相邻结构（贪婪写法得 1，惰性得 3）', () => {
    const pattern = PARALLEL_PATTERNS.find((p) => p.source.startsWith('仿佛'))!;
    const re = new RegExp(pattern.source, 'g');
    const s = '仿佛A一般仿佛B一般仿佛C一般';
    let n = 0;
    while (re.exec(s) !== null) n++;
    expect(n).toBe(3); // 贪婪 `.{0,12}` 会合并成 1 个 match
  });

  it('★ D1 端到端：6 个紧邻的「仿佛X一般」计 6 处 → parallel 维度 100（corpusMaxCount=2）', () => {
    // 每句 2 处紧邻结构；3 句 = 6 处；再补 2 句使 sentCount=5（满足该维度 ≥5 的判分门槛）。
    const text = '仿佛A一般仿佛B一般。'.repeat(3) + '他走了。他来了。';
    const r = detectFlavor(text, 'x', DEFAULT_FLAVOR_CONFIG);
    const par = r.dimensions.find((d) => d.dimension === 'parallel-structure')!;
    expect(par.measured).toBe(6);
    expect(par.score).toBe(100); // denom = 3 × 2 = 6
  });

  it('★ D2 corpusMaxCount === null（序列化丢失）→ 同样按旧口径 unjudged + 披露（不是静默判分）', () => {
    const conn = {
      ...DEFAULT_FLAVOR_BASELINE.metrics.connector_per1000,
      corpusMaxCount: null as unknown as number, // 模拟 JSON 里的显式 null
    };
    const baseline: FlavorBaseline = {
      ...DEFAULT_FLAVOR_BASELINE,
      metrics: { ...DEFAULT_FLAVOR_BASELINE.metrics, connector_per1000: conn },
    };
    const withOne = CH237.replace('恒昌厅挂满', '然而，恒昌厅挂满');
    const r = detectFlavor(withOne, 'x', DEFAULT_FLAVOR_CONFIG, baseline);
    const tc = r.dimensions.find((d) => d.dimension === 'template-connector')!;
    expect(tc.skipped).toBe(true);
    expect(tc.score).toBe(0);
    expect(tc.note).toContain('旧口径');
  });

  it('★ D3 基线非单调（p05 > p95）→ scoreByDeviation 判 unjudged，绝不静默给 100', () => {
    const broken: MetricBaseline = {
      p05: 0.9,
      p25: 0.9,
      p50: 0.9,
      p75: 0.9,
      p95: 0.1,
      mean: 0.9,
      min: 0,
      max: 1,
    };
    // 无护栏时 span = ε → d 巨大 → 100；护栏后应 unjudged 且 score=0
    const s = scoreByDeviation(0.5, broken, 'high-bad');
    expect(s.unjudged).toBe(true);
    expect(s.score).toBe(0);
  });

  it('★ D3 引擎层：把 sent_cv 基线改成非单调 → 该维度 skipped + 披露，不参与总评', () => {
    const baseline: FlavorBaseline = {
      ...DEFAULT_FLAVOR_BASELINE,
      metrics: {
        ...DEFAULT_FLAVOR_BASELINE.metrics,
        sent_cv: { ...DEFAULT_FLAVOR_BASELINE.metrics.sent_cv, p05: 0.9, p95: 0.1 },
      },
    };
    const r = detectFlavor(CH1, 'x', DEFAULT_FLAVOR_CONFIG, baseline);
    const sr = r.dimensions.find((d) => d.dimension === 'sentence-rhythm')!;
    expect(sr.skipped).toBe(true);
    expect(sr.score).toBe(0);
    expect(sr.note).toContain('异常');
  });
});

// ── 2. 判据方向 ──────────────────────────────────────────────────────

describe('★ 判据方向（曾被写反，此处正反两向锁死）', () => {
  // 虚构一份分位数画像，p05=0.4、p95=0.9，带宽 span=0.5
  const base: MetricBaseline = {
    p05: 0.4,
    p25: 0.5,
    p50: 0.6,
    p75: 0.7,
    p95: 0.9,
    mean: 0.6,
    min: 0.3,
    max: 1.0,
  };

  it('high-bad：正常边界是 p95——等于 p95 不扣分，低于 p95 也不扣分', () => {
    expect(scoreByDeviation(base.p95, base, 'high-bad').score).toBe(0);
    expect(scoreByDeviation(base.p05, base, 'high-bad').score).toBe(0);
    expect(scoreByDeviation(base.min, base, 'high-bad').score).toBe(0);
  });

  it('high-bad：超过 p95 才开始扣分', () => {
    expect(scoreByDeviation(1.4, base, 'high-bad').score).toBeGreaterThan(0);
  });

  it('low-bad：正常边界是 p05——等于 p05 不扣分，高于 p05 也不扣分', () => {
    expect(scoreByDeviation(base.p05, base, 'low-bad').score).toBe(0);
    expect(scoreByDeviation(base.p95, base, 'low-bad').score).toBe(0);
    expect(scoreByDeviation(base.max, base, 'low-bad').score).toBe(0);
  });

  it('low-bad：低于 p05 才开始扣分', () => {
    expect(scoreByDeviation(0.0, base, 'low-bad').score).toBeGreaterThan(0);
  });

  it('★ 方向写反会得出相反结论（此断言即护栏）', () => {
    const tooHigh = 1.4;
    const tooLow = 0.0;
    // 「高得离谱」在 high-bad 下扣分、在 low-bad 下不扣
    expect(scoreByDeviation(tooHigh, base, 'high-bad').score).toBeGreaterThan(0);
    expect(scoreByDeviation(tooHigh, base, 'low-bad').score).toBe(0);
    // 「低得离谱」反之
    expect(scoreByDeviation(tooLow, base, 'low-bad').score).toBeGreaterThan(0);
    expect(scoreByDeviation(tooLow, base, 'high-bad').score).toBe(0);
  });
});

// ── 2.5 标点双信号（comma + dash 子信号，均为 high-bad）──────────────

describe('★ punctuation-pattern 双信号（dash 子信号方向必须为 high-bad）', () => {
  // ★ 回归锁：dash 子信号不是任何维度的**主指标**，实现里若用「按指标反查维度」来定方向，
  //   dash 会落进兜底（low-bad）→ 恒 0 分（死代码）。此测试确保 dash 生效。
  it('★ 破折号/省略号密集时标点维度扣分（dash 子信号生效）', () => {
    const dashy = '他站住——回头看——没有人——风很冷——他继续走——天黑了——灯亮了——'.repeat(8);
    const r = detectFlavor(dashy, 'x', DEFAULT_FLAVOR_CONFIG);
    const p = r.dimensions.find((d) => d.dimension === 'punctuation-pattern')!;
    expect(p.score).toBeGreaterThan(0);
    expect(p.note).toContain('破折号');
  });

  it('逗号与破折号都干净时标点维度为 0（不误伤）', () => {
    const calm = '他走了。她没说话。天黑了。他点了根烟。风很大。他缩了缩脖子。'.repeat(8);
    const r = detectFlavor(calm, 'x', DEFAULT_FLAVOR_CONFIG);
    const p = r.dimensions.find((d) => d.dimension === 'punctuation-pattern')!;
    expect(p.score).toBe(0);
  });
});

// ── 3. 三章真实原文回归 ──────────────────────────────────────────────

describe('★ 三章真实原文回归（v2 校准后应回落且判为干净）', () => {
  // 旧（v1）三章指数约为 3 / 17 / 28；v2 目标 2 / 9 / 13，且全部 clean。
  // 断言用精确值：这三章是校准的「零点」，一旦漂移必须立刻发现。
  it('第 1 章：index = 2，clean', () => {
    const r = detectFlavor(CH1, 'ch1');
    expect(r.sufficient).toBe(true);
    expect(r.index).toBe(2);
    expect(r.level).toBe('clean');
  });

  it('第 237 章：index = 9，clean', () => {
    const r = detectFlavor(CH237, 'ch237');
    expect(r.index).toBe(9);
    expect(r.level).toBe('clean');
  });

  it('第 574 章：index = 13，clean', () => {
    const r = detectFlavor(CH574, 'ch574');
    expect(r.index).toBe(13);
    expect(r.level).toBe('clean');
  });

  it('★ ch237 的「短语重复」归 0（旧口径误报 32 → 新口径 0，见设计 §2.2）', () => {
    // tri_repeat=0.195 < 语料 p95=0.3825 → 落在正常带内，不该扣分。
    const r = detectFlavor(CH237, 'ch237', DEFAULT_FLAVOR_CONFIG);
    const pr = r.dimensions.find((d) => d.dimension === 'phrase-repetition')!;
    expect(pr.score).toBe(0);
  });
});

// ── 4. B11 契约：标题行影响可忽略（不是给引擎加剥离逻辑）────────────

describe('★ B11 预处理契约：标题行的存在与否影响可忽略', () => {
  /**
   * ★★ 这条测试锁的是一个**契约**，不是一段逻辑：
   *   `detectFlavor` 的入参是「章节正文，不含标题行」——数据层已把标题与正文分离
   *   （Chapter.body 天然不含标题，chapter_bodies 表也只存 body）。
   *
   *   ⚠️ **不要**为了「消除标题行差异」去给引擎/特征提取加「删掉首个非空行」的逻辑：
   *   传进来的已经是正文，再删首行就是把**第一段正文**当标题删掉（每章丢一段）。
   *   两套口径其实一致（基线「去标题后测」≡ 引擎「只测 body」），本就无需特殊处理。
   *   此处的断言只是把「影响可忽略」这一点固定下来，防止日后有人误加剥离逻辑。
   */
  it('★ body-only 与「标题+body」的指数差 ≤ 1（证明标题行影响可忽略）', () => {
    const bodyOnly = detectFlavor(CH1, 'b');
    const withTitle = detectFlavor(`第1章 穷鬼也配\n\n${CH1}`, 't');
    expect(Math.abs(bodyOnly.index - withTitle.index)).toBeLessThanOrEqual(1);
  });

  it('★ 对三章均成立（标题行不是判定的关键变量）', () => {
    const pairs: [string, string][] = [
      ['ch1', '第1章 穷鬼也配'],
      ['ch237', '第237章 留一张'],
      ['ch574', '第574章 一根线'],
    ];
    for (const [id, title] of pairs) {
      const body = id === 'ch1' ? CH1 : id === 'ch237' ? CH237 : CH574;
      const bodyOnly = detectFlavor(body, id);
      const withTitle = detectFlavor(`${title}\n\n${body}`, id);
      expect(Math.abs(bodyOnly.index - withTitle.index), `${id} 标题行影响应 ≤1`).toBeLessThanOrEqual(1);
    }
  });
});
