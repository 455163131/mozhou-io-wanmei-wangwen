/**
 * 哈希工具（主进程专用）。
 *
 * 依赖 node:crypto，故不放shared 层——见shared/util/hash.ts 顶部的说明。
 * 用途：Agent 循环检测的双判据（架构 §1.4.1）。
 */
import { createHash } from 'node:crypto';
import { canonicalJSON, normalizeArgs } from '@shared/util/hash';
import type { ProjectBackup } from '@shared/types/project';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 判据 A 的指纹：hash(toolName + hash(canonicalJSON(normalizedArgs)))。
 * 摘要嵌套一层，避免超长参数直接进哈希输入。
 */
export function hashInvocation(toolName: string, args: unknown): string {
  const norm = normalizeArgs((args ?? {}) as Record<string, unknown>);
  return sha256(`${toolName}|${sha256(canonicalJSON(norm))}`);
}

/**
 * 判据 B 的项目状态指纹：sha256(全部章节正文 + 账本摘要)。
 *
 * 为什么用全部正文而非当前章：Agent 可能在 A/B 两章之间横跳，
 * 只看当前章会漏判这种振荡——这正是判据 B 存在的理由（架构 §1.4.1）。
 */
export function hashProjectState(
  chapters: Array<{ id: string; body: string }>,
  ledgerDigest = '',
): string {
  // 按 id 排序，保证章节顺序不影响指纹
  const sorted = chapters.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const h = createHash('sha256');
  for (const c of sorted) {
    h.update(c.id, 'utf8');
    h.update('', 'utf8');
    h.update(c.body, 'utf8');
    h.update('', 'utf8');
  }
  h.update('ledger:', 'utf8');
  h.update(ledgerDigest, 'utf8');
  return h.digest('hex');
}

/** 账本摘要：并入状态指纹，使「只改账本不改正文」也能被检测到 */
export function ledgerDigest(entries: Array<Record<string, unknown>>): string {
  const norm = entries
    .map((e) => canonicalJSON(e))
    .sort()
    .join('\n');
  return sha256(norm);
}

/**
 * 账本四类实体。直接取备份载荷的形状，不再手抄一份
 * —— 同一形状此前已在 `ProjectBackup.ledger` 与 services 里各写一遍。
 */
export type LedgerStateBundle = ProjectBackup['ledger'];

/**
 * 把账本摊平成 ledgerDigest 的输入。
 *
 * 逐条浅拷贝成对象字面量：账本类型是 interface，直接塞进
 * `Record<string, unknown>[]` 会缺隐式索引签名。
 */
export function ledgerStateEntries(ledger: LedgerStateBundle): Array<Record<string, unknown>> {
  return [
    ...ledger.characters.map((e) => ({ ...e })),
    ...ledger.numbers.map((e) => ({ ...e })),
    ...ledger.timeline.map((e) => ({ ...e })),
    ...ledger.foreshadows.map((e) => ({ ...e })),
  ];
}

export { canonicalJSON, normalizeArgs } from '@shared/util/hash';