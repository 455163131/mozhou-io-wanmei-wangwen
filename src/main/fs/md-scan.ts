/**
 * 扫项目 `chapters/` 里的 .md（§4 第 19 条②）。
 *
 * ★ 与 `md-import.ts` 分工：这里只管"磁盘上有哪些稿子"，那些判断（认号、判编码、
 *   排队）留在纯模块里。分开是因为只有这一处需要 fs，把 fs 混进判定逻辑就没法
 *   脱离运行时断言了。
 * ★ 只收**顶层文件**、只收 `.md`：子目录是分卷的事，递归会把不属于这本书的稿子拉进来；
 *   扩展名按不区分大小写比（Windows 上 `.MD` 很常见）。
 * ★ 本模块**只读**：不删、不改名、不移动任何文件。导入口径错了时，原件必须在原地。
 */
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

export interface MarkdownFile {
  fileName: string;
  raw: Buffer;
}

/**
 * 读目录里的 .md。目录不存在（新项目还没写过稿）返回空数组；
 * ★ 其他读失败（权限、被占用）**照抛** —— 那不等于"没有旧稿"，
 *   把它吞了会让用户以为目录是空的。
 */
export async function scanMarkdownChapters(dir: string): Promise<MarkdownFile[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }

  const out: MarkdownFile[] = [];
  for (const e of dirents) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith('.md')) continue;
    out.push({ fileName: e.name, raw: await fs.readFile(join(dir, e.name)) });
  }
  return out;
}
