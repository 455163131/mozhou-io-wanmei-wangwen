/**
 * 分章书中间文档（P2-D T2，零依赖导出线的共用形状）。
 *
 * 定位：doc→Buffer 各 builder（txt/md/epub/docx）的**唯一输入形状**。
 * T3 的装配层负责把项目库里的章节喂给 toChaptersDoc；本模块不 import
 * Repo、不碰磁盘、不 import node 原生模块（保持可被任意 main 侧调用）。
 *
 * ★ parasOf 语义（导出线的段落单一口径，测试即规格）：
 *   段界 = 空行运行（/\n\s*\n/，即"换行 + 可选水平空白 + 换行"及以上）；
 *   段内单个 \n 是**软换行**，不切段、原样保留在段字符串里。
 *   渲染口径：xhtml 段内 \n → <br/>；docx 一段一 <w:p>、段内 \n → <w:br/>。
 */

export interface ChapterDoc {
  /** 章标题（原文，未转义——转义是各 builder 出 XML 时的职责） */
  label: string;
  /** 章正文（原文，保留段内软换行） */
  body: string;
  /** 稳定锚点 id：'ch1'、'ch2'…（ncx/nav 的 fragment 用） */
  anchor: string;
}

export interface ChaptersDoc {
  title: string;
  author: string;
  lang: 'zh' | 'en';
  chapters: ChapterDoc[];
}

export interface ChapterInput {
  label: string;
  body: string;
}

export interface ChaptersDocInput {
  title: string;
  author?: string;
  lang?: 'zh' | 'en';
  chapters: ChapterInput[];
}

/**
 * XML 文本转义，& 必须先行（否则会把后加的实体再转一层）。
 * 覆盖 & < > " ' 五字符；'→&apos; 非 XML 1.0 预定义实体，
 * 但 XHTML 文档类型（实体集）与主流 XML 处理器均接受，EPUB/OPF 工具链惯用。
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 正文 → 视觉段落数组。见文件头语义说明：
 * 空行运行切段；每段 trim（吃掉段首尾游离空白行）；空段丢弃；
 * 段内软换行（单 \n）原样保留，交由各渲染器处理。
 */
export function parasOf(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** 原始章节输入 → 中间文档（author 缺省'作者'，lang 缺省'zh'，anchor 顺序编 'ch1'…）。 */
export function toChaptersDoc(input: ChaptersDocInput): ChaptersDoc {
  return {
    title: input.title,
    author: input.author ?? '作者',
    lang: input.lang ?? 'zh',
    chapters: input.chapters.map((c, i) => ({
      label: c.label,
      body: c.body,
      anchor: `ch${i + 1}`,
    })),
  };
}
