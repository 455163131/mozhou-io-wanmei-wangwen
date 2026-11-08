/**
 * 导出线共享契约（P2-D T1）。
 *
 * 契约单份（口径同 pipeline.ts/inspiration.ts）：main 侧 Repo/服务与
 * renderer 侧都 import 本文件，不允许第二份形状。export_history 只记
 * 事实（成功/失败都落），fail 行 path/bytes 为 null、error 存真因。
 */

export type ExportFormat = 'txt' | 'md' | 'epub' | 'docx' | 'zip';
export type ExportScope =
  | { kind: 'book' }
  | { kind: 'volume'; volumeId: string }
  | { kind: 'chapters'; chapterIds: string[] };

export interface ExportRunReq {
  format: ExportFormat;
  scope: ExportScope;
  /** 'project' 写项目根（★2）；'external' 写文档目录根（★4，永不自动） */
  dest: 'project' | 'external';
  /** 缺省=书名；仍过安全化 + resolveInProject */
  baseName?: string;
}
export interface ExportRunRes { path: string; bytes: number }
export interface ExportPreviewRes {
  /** 真字节：与同参导出逐字相等（同一构建函数） */
  bytes: number;
  toc: Array<{ label: string; chars: number }>;
  sample: string;
  warnings: string[];
}
export interface ExportHistoryRow {
  id: string; projectId: string; format: ExportFormat; scope: ExportScope;
  dest: 'project' | 'external'; path: string | null; bytes: number | null;
  status: 'ok' | 'fail'; error: string | null; createdAt: number;
}
export type ExportHistoryInsert = Omit<ExportHistoryRow, 'id' | 'createdAt'>;
