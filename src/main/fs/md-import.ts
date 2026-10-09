/**
 * 把 `chapters/*.md` 旧稿认出来、排好队（§4 第 19 条②）。
 *
 * ★ 纯模块：不 import fs、不 import electron —— 「哪个文件能进库、哪个要跳过」
 *   是全仓最容易出争议的判断，必须能脱离运行时直接喂 Buffer 断言。
 *   真正的读写在 `services.importMarkdownChapters()` 里。
 *
 * ★ 三条口径（写下来，免得后人以为是随手如此）：
 *   · **绝不覆盖**：库里已有同号 → skipped，磁盘那份不动它。库里那份可能正在被
 *     编辑器改、可能是 Agent 刚写的，拿 md 盖掉等于删用户的字。
 *   · **编码先 UTF-8 再 GBK**：旧稿大量是 Windows 记事本的 ANSI(GBK)。只按 UTF-8 读
 *     会解出一堆乱码，而乱码写进库远比"导入失败"难发现；两个都解不开就不导入。
 *   · **认不出章号就不猜**：猜号等于把正文塞进错的章节位置，让作者的引用全打乱。
 *     章号只从**文件名**取（`第12章 …` / `012 …`），md 里的 `#` 标题只当章名。
 */

/** 解码结果：`ok:false` 表示两种编码都解不开 */
export type MdDecode =
  | { ok: true; text: string; encoding: 'utf-8' | 'gbk' }
  | { ok: false };

/** 待入库的一条（章号沿用文件名里的号，不是 repo 现算的） */
export interface MdDraft {
  fileName: string;
  number: number;
  /** 主键里的章节号（`String(number)`） */
  id: string;
  title: string;
  body: string;
}

/** 没入库的一条，reason 必须让用户能对着文件名动手 */
export interface MdRejected {
  fileName: string;
  reason: string;
}

export interface MdImportPlan {
  imported: MdDraft[];
  skipped: MdRejected[];
  unresolved: MdRejected[];
}

/**
 * UTF-8（TextDecoder 默认顺带剥 BOM）→ 失败再试 GBK → 再失败就判"解不开"。
 * ★ 两边都用 `fatal: true`：非 fatal 的 UTF-8 解码会把非法字节替换成 U+FFFD 并"成功"，
 *   于是乱码被当成正文写进库。
 */
export function decodeMarkdownBytes(raw: Buffer): MdDecode {
  try {
    return {
      ok: true,
      encoding: 'utf-8',
      text: new TextDecoder('utf-8', { fatal: true }).decode(raw),
    };
  } catch {
    // 落到 GBK
  }
  try {
    return {
      ok: true,
      encoding: 'gbk',
      text: new TextDecoder('gbk', { fatal: true }).decode(raw),
    };
  } catch {
    return { ok: false };
  }
}

/** 从 `第N章 标题` / `N 标题` 这类名字里取号与名；取不到号返回 null */
function splitNumberAndTitle(stem: string): { number: number | null; title: string } {
  const zh = /^第\s*(\d{1,4})\s*章\s*[-—_：:、.\s]*(.*)$/u.exec(stem);
  if (zh) return { number: Number(zh[1]), title: zh[2].trim() };
  const digits = /^(\d{1,4})\s*[-—_：:、.\s]*(.*)$/u.exec(stem);
  if (digits) return { number: Number(digits[1]), title: digits[2].trim() };
  return { number: null, title: stem.trim() };
}

/** `第N章` 前缀（标题行里也常带）*/
function stripChapterPrefix(title: string): string {
  const m = /^第\s*\d{1,4}\s*章\s*[-—_：:、.\s]*(.*)$/u.exec(title);
  return (m ? m[1] : title).trim();
}

export interface MdParsed {
  /** 文件名里的章号；null = 认不出 */
  number: number | null;
  /** 章名：md 首行 `# ` 标题优先，其次文件名里号后面的部分；可能为空 */
  title: string;
  /** 正文（首行章名已吃掉，CRLF 已归一成 LF） */
  body: string;
}

/** 文件名 + 已解码文本 → 章号 / 标题 / 正文 */
export function parseMarkdownChapter(fileName: string, text: string): MdParsed {
  const stem = fileName.replace(/\.[^.]*$/u, '');
  const fromName = splitNumberAndTitle(stem);
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');

  // 一级标题才算章名；`## 小节` 是正文的一部分，原样留着
  const heading = /^#\s+(.+?)\s*$/u.exec(lines[0] ?? '');
  const title = (heading ? stripChapterPrefix(heading[1]) : fromName.title).trim();
  const rest = heading ? lines.slice(1).join('\n') : lines.join('\n');

  return { number: fromName.number, title, body: rest.replace(/^\n+/u, '').trimEnd() };
}

/**
 * 排队：哪些能进库、哪些跳过（同号）、哪些报不出来（认不出号/解不开码/空文件）。
 *
 * `imported` 按**章号升序**排（不是文件名字典序 —— `第10章` 会排在 `第9章` 前面），
 * 这样 repo 追加的 `ord` 就是作者读的顺位。
 */
export function planMarkdownImport(
  files: ReadonlyArray<{ fileName: string; raw: Buffer }>,
  existingIds: readonly string[],
): MdImportPlan {
  const taken = new Set(existingIds);
  const imported: MdDraft[] = [];
  const skipped: MdRejected[] = [];
  const unresolved: MdRejected[] = [];

  for (const f of files) {
    const decoded = decodeMarkdownBytes(f.raw);
    if (!decoded.ok) {
      unresolved.push({
        fileName: f.fileName,
        reason: '编码既不是 UTF-8 也不是 GBK，解不出正文（用记事本"另存为 → UTF-8"后重试）',
      });
      continue;
    }
    const p = parseMarkdownChapter(f.fileName, decoded.text);
    if (p.number === null) {
      unresolved.push({
        fileName: f.fileName,
        reason: '文件名认不出章号，请把文件名改成「第12章 标题.md」这种写法（章号用阿拉伯数字）',
      });
      continue;
    }
    if (p.body.trim() === '') {
      unresolved.push({ fileName: f.fileName, reason: '文件是空的（没有正文），没有导入' });
      continue;
    }
    imported.push({ fileName: f.fileName, number: p.number, id: String(p.number), title: p.title, body: p.body });
  }

  imported.sort((a, b) => a.number - b.number);

  const ordered: MdDraft[] = [];
  const usedHere = new Map<string, string>();
  for (const d of imported) {
    if (taken.has(d.id)) {
      skipped.push({
        fileName: d.fileName,
        reason: `库里已有第${d.number}章，这份正文没动它（要替换请先在库里删掉那一章）`,
      });
      continue;
    }
    const first = usedHere.get(d.id);
    if (first !== undefined) {
      skipped.push({
        fileName: d.fileName,
        reason: `本次导入里第${d.number}章已由「${first}」占过，这份没导入`,
      });
      continue;
    }
    usedHere.set(d.id, d.fileName);
    ordered.push(d);
  }

  return { imported: ordered, skipped, unresolved };
}
