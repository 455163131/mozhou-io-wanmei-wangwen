/** 单调 ID 生成：runId / checkpointId / stepNo 统一走这里，便于排查与排序。 */

let seq = 0;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${randomSuffix()}`;
}

export function nextSeq(): number {
  seq += 1;
  return seq;
}

export function newRunId(): string {
  return nextId('run');
}

export function newCheckpointId(): string {
  return nextId('ckpt');
}

/** 字节数人类可读化，用于轨迹面板展示 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 耗时人类可读化 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}