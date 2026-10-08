/**
 * 稳定序列化工具（架构 §1.4.1 循环检测判据 A 依赖它）。
 *
 * ⚠️ **为什么这个文件里没有 sha256**：
 * 架构目录清单把 hash.ts 列在 shared/util，但同一份文档又规定
 * 「shared 禁止 import Node/Electron」——这两条冲突。
 * 按「分层铁律优先」处理：把纯函数留在 shared，依赖 node:crypto 的哈希
 * 移到 `src/main/util/hash.ts`（哈希只在主进程需要：循环检测、指纹计算）。
 * 这样 shared 层保持可在渲染进程运行，且不破坏架构的目录意图。
 */

/** 稳定序列化：对象键按字典序排列，保证与插入顺序无关 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortValue);
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out: Record<string, unknown> = {};
  for (const [k, val] of entries) {
    if (val !== undefined) out[k] = sortValue(val);
  }
  return out;
}

/**
 * 归一化工具参数：剔除不影响语义的差异，
 * 避免「同一个调用被当成不同调用」而漏报循环。
 *
 * 为什么要归一化：模型两次发出 `{"chapterIds":["1"]}` 与 `{"chapterIds":["1"],"note":" "}`
 * 是语义等价的，若不归一化指纹就不同，判据 A 会漏报。
 */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') continue;
      out[k] = trimmed;
      continue;
    }
    if (Array.isArray(v)) {
      const arr = v
        .map((x) => (typeof x === 'string' ? x.trim() : x))
        .filter((x) => x !== '');
      // 数组对「传给工具的集合」通常无序，排序以稳定指纹
      out[k] = arr.slice().sort();
      continue;
    }
    out[k] = typeof v === 'object' ? normalizeArgs(v as Record<string, unknown>) : v;
  }
  return out;
}

/** 掩码 Key：只显示首 4 与末 3。**明文永不返回渲染层** */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}•••${key.slice(-3)}`;
}