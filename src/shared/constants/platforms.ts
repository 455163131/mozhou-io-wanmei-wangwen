/**
 * 平台规则包（P1-B T3）：国内三平台 + 海外三平台。
 *
 * ★ 内容红线：contentNotes 全部是对公开平台惯例的**原创概括**
 *   （读者留存甜区 / 更新节奏 / 排版惯例等），不复制任何平台条款原文。
 *
 * ★ chapterWords 语义分口径（裁决 R26）：
 *   - market 'cn'：字符数（现状口径）；
 *   - market 'overseas'：**英文词数**——writeDraft 的不足阈值按 language
 *     分口径计数，海外平台的 chapterWords 即「单章目标词数」。
 *
 * ★ 匹配口径：buildPipelineCtx 按 projects.platform 与本表的 name 或 id
 *   相等匹配；匹配不到时 platformRule 缺省（prompt 不注入平台段）。
 */
export interface PlatformRule {
  /** 稳定标识（小写英文），如 'webnovel' */
  id: string;
  /** 展示名，与立项参数 platform 字段对得上，如 'Webnovel' / '番茄' */
  name: string;
  market: 'cn' | 'overseas';
  /** 单章目标体量：cn=字符数，overseas=英文词数 */
  chapterWords: number;
  /** 平台工艺注记（原创概括的公开惯例），进写手 system 平台段（书籍级稳定） */
  contentNotes: string[];
}

export const PLATFORM_RULES: PlatformRule[] = [
  {
    id: 'fanqie',
    name: '番茄',
    market: 'cn',
    chapterWords: 8000,
    contentNotes: [
      '免费阅读生态靠留存说话：开头三章把冲突和金手指亮出来，慢热开局容易被划走',
      '日更节奏稳定比单日爆更影响推荐',
      '段落偏短、对白密，适配手机端竖屏阅读',
    ],
  },
  {
    id: 'qidian',
    name: '起点',
    market: 'cn',
    chapterWords: 6000,
    contentNotes: [
      '付费读者看重体系感：力量等级与升级节点要交代清楚',
      '上架节点前留一记强钩是惯例',
      '章末单章自查：这一章读者花钱买到了什么推进',
    ],
  },
  {
    id: 'jinjiang',
    name: '晋江',
    market: 'cn',
    chapterWords: 5000,
    contentNotes: [
      '情感线推进要落到具体互动上，读者对关系温度的变化敏感',
      '作话（作者有话说）惯例：章末简短互动，不在正文里夹带',
      '排版惯例：段落间空行、避免大段密排',
    ],
  },
  {
    id: 'webnovel',
    name: 'Webnovel',
    market: 'overseas',
    chapterWords: 2000,
    contentNotes: [
      '每章 1.5k-2.5k 英文词为留存甜区',
      '合成词与系统提示框遵循平台排版惯例',
      '避免未完结章末无钩子（留存指标敏感）',
    ],
  },
  {
    id: 'royalroad',
    name: 'Royal Road',
    market: 'overseas',
    chapterWords: 2500,
    contentNotes: [
      'progression 读者期待稳定更新节奏',
      '作者注(A/N)惯例：章末简短互动语',
      '蓝框/系统界面描述保持格式一致',
    ],
  },
  {
    id: 'kdp-serials',
    name: 'KDP Serials',
    market: 'overseas',
    chapterWords: 3000,
    contentNotes: [
      '整本书完稿导向：伏笔回收率要求高于连载平台',
      '章节可无钩子但须有场景闭环',
    ],
  },
];
