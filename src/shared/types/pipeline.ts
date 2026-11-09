/**
 * P0 生成流水线的共享类型与产出物校验。
 *
 * ★ 为什么放 shared：构思/架构/写手三个环节的产出（ConceptOut / OutlineOut）
 *   既要被主进程的 pipeline 装配器消费，也要在渲染层展示与编辑——
 *   契约必须放在两侧都能 import 的位置，且**只有一份**。
 *
 * ★ 为什么带 zod：这三个产出全部来自 LLM 的 JSON 回复，字段缺失、
 *   空串充数、数组条数不对是常态而非意外。入库/入装配器之前先过
 *   schema，坏数据在门口就被拦下，而不是渗进正文生成环节。
 */
import { z } from 'zod';
import type { PlatformRule } from '../constants/platforms';

/* ── 流水线上下文 ──────────────────────────────────────────────── */

/**
 * 一次生成流水线的全部共享上下文。
 *
 * 字段分两层：
 * - 书籍级（genre/platform/chapterWords/targetWords/premise/canon/concept/outline/
 *   language/platformRule）：同一本书内恒定——写手 system 只吃这一层，
 *   因此同书逐字节稳定，命中 prompt cache；
 * - 章节级（chapterNo/planItem/prevEnding）：逐章变化——**只进 user 消息**
 *   （由 Task 3 的装配器注入），绝不进 system。
 */
export interface PipelineCtx {
  /** 题材，如「古风玄幻」 */
  genre: string;
  /** 发布平台，如「番茄」 */
  platform: string;
  /** 单章目标字数（language='en' 且海外平台时语义为英文词数，见 R26） */
  chapterWords: number;
  /** 全书目标总字数 */
  targetWords: number;
  /** 作者的原始脑洞/前提，一句话 */
  premise: string;
  /** 正史设定清单（既定事实，任何环节不得与之相抵） */
  canon: string[];
  /** 作品语言（P1-B T3）：'zh' 中文（缺省口径）/ 'en' 英文（海外平台） */
  language: 'zh' | 'en';
  /** 匹配到的平台规则包（按 platform 名/id 匹配 PLATFORM_RULES；匹配不到缺省） */
  platformRule?: PlatformRule;
  /** 构思环节产出（构思完成后回填） */
  concept?: ConceptOut;
  /** 架构环节产出（大纲完成后回填） */
  outline?: OutlineOut;
  /** 本章的章节序号（从 1 起算）——章节级字段，不进 system */
  chapterNo?: number;
  /** 本章章纲条目——章节级字段，不进 system */
  planItem?: { title: string; hook: string };
  /** 上一章结尾片段（衔接用）——章节级字段，不进 system */
  prevEnding?: string;
  /**
   * 伏笔台账·未偿行（P2-B T7）：一条未偿伏笔一行，行内带「权重X」标签
   * （装配侧据此还原条目级牺牲 rank）。台账随作者改账而变，属装配数据而非
   * 稳定性锚点——**只进 user 的 foreshadow 槽，绝不进 system**（R45）。
   */
  foreshadowLines: string[];
  /**
   * 人物近况行（P2-B T7）：一人一行（最新快照 + 知/不知边界）。
   * 同 foreshadowLines：只进 user 的 cast 槽，不进 system（R45）。
   */
  castLines: string[];
}

/* ── 世界观铁律（canon，P1-A T2 上移到 shared：IPC 契约 canon:list/add/remove 的 res/req） ── */

/**
 * 一条世界观铁律（project_canon 表的一行）。
 * 定义放 shared 的原因与 Draft 相同：既是主进程 CanonRepo 的返回类型，
 * 也是 IPC 契约的载荷类型——契约只有一份，两侧 import 同一处。
 */
export interface CanonEntry {
  id: string;
  projectId: string;
  text: string;
  createdAt: number;
}

/* ── 草稿隔离区记录（T5 上移到 shared：IPC 契约 pipeline:list-drafts 的 res） ── */

/** 草稿状态：pending → adopted | discarded 单向流转（终局决定，不可改判） */
export type DraftStatus = 'pending' | 'adopted' | 'discarded';

/** role ∈ 'concept'|'architect'|'writer'；kind ∈ 'concept'|'outline'|'chapter' */
export interface Draft {
  id: string;
  projectId: string;
  chapterId: string | null;
  role: string;
  kind: string;
  content: string;
  status: DraftStatus;
  createdAt: number;
}

/* ── 装配裁剪留痕（D批 D1 上移到 shared：IPC 契约 pipeline:write-draft 的 res） ── */

/**
 * 一次裁剪动作的留痕：装配透明原则的载体，逐条可回查。
 * 定义放 shared 的原因与 Draft 相同：既是主进程装配器（assemble.ts）的产出类型，
 * 也是 IPC 契约的载荷类型——契约只有一份，两侧 import 同一处。
 */
export type TrimTrace = {
  /** 栏位名（prevEnding / synopsis / hooks / craftSkills / foreshadow / cast） */
  slot: string;
  /** kept=全文保留；compressed=被截断；dropped=被整条丢弃 */
  action: 'kept' | 'compressed' | 'dropped';
  /** 裁剪前该栏位的 token 估算 */
  before: number;
  /** 裁剪后该栏位的 token 估算 */
  after: number;
  /** 为什么裁、怎么裁的——说真话，不拟人化 */
  reason: string;
};

/* ── 构思产出 ──────────────────────────────────────────────────── */

export interface ConceptOut {
  /** 恰好 3 个互不重复的书名 */
  titles: string[];
  /** 一句凝出的核心卖点 */
  logline: string;
  /** 三百字上下的剧情梗概 */
  synopsis: string;
  /** 金手指设定：机制/边界/代价，三样写全 */
  goldenFinger: string;
  /** 恰好 5 条彼此有差异的脑洞分支 */
  hooks: string[];
}

/** 非空字符串（先去首尾空白再判空：全空格串等同空串充数） */
const NonEmptyStr = z.string().trim().min(1);

export const ConceptSchema = z.object({
  titles: z.array(NonEmptyStr).length(3, 'titles 需为 3 个非空且不重复的书名'),
  logline: NonEmptyStr,
  synopsis: NonEmptyStr,
  goldenFinger: NonEmptyStr,
  hooks: z.array(NonEmptyStr).length(5, 'hooks 需为 5 条非空的差异化分支'),
});

/* ── 架构产出 ──────────────────────────────────────────────────── */

export interface OutlineOut {
  /** 全书卷纲：必须列全所有卷 */
  volumes: { title: string; goal: string; targetChapters: number }[];
  /** 章纲（本次任务覆盖的卷）：每项 title/hook 非空 */
  chapterPlan: { title: string; hook: string }[];
}

export const OutlineSchema = z.object({
  volumes: z
    .array(
      z.object({
        title: NonEmptyStr,
        goal: NonEmptyStr,
        targetChapters: z.number().int().positive(),
      }),
    )
    .min(1, 'volumes 至少 1 卷'),
  chapterPlan: z
    .array(
      z.object({
        title: NonEmptyStr,
        hook: NonEmptyStr,
      }),
    )
    .min(1, 'chapterPlan 至少 1 章'),
});

/**
 * 架构师任务②（续写某一卷的章纲）的局部契约：只产出 chapterPlan。
 * 校验通过后由调用方（pipeline/tools.ts）与既有 outline.volumes 合并成
 * 完整 OutlineOut 再入草稿——续写不该逼模型把全书卷纲重吐一遍。
 */
export const ChapterPlanSchema = z.object({
  chapterPlan: z
    .array(
      z.object({
        title: NonEmptyStr,
        hook: NonEmptyStr,
      }),
    )
    .min(1, 'chapterPlan 至少 1 章'),
});
