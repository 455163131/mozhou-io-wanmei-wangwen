/**
 * 纯文本 / Markdown 章节文档渲染（P2-D T2，零依赖）。
 *
 * 只产 string——落盘与 zip 装配归 T3（文件名形状也在 T3）。
 * 分隔口径：章块之间以独占一行的 '---'（即 '\n---\n' join）分隔。
 */
import type { ChaptersDoc } from './book-doc';

const SEP = '\n---\n';

export function txtDoc(doc: ChaptersDoc): string {
  return doc.chapters.map((c) => `${c.label}\n\n${c.body}`).join(SEP);
}

export function mdDoc(doc: ChaptersDoc): string {
  return doc.chapters.map((c) => `## ${c.label}\n\n${c.body}`).join(SEP);
}
