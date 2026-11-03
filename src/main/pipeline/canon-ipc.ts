/**
 * P1-A T2：canon 三条 IPC 通道的 handler 实现（canon:list / canon:add / canon:remove）。
 *
 * ★ 分工与 pipeline/ipc.ts 同款：register.ts 只做通道登记，业务语义全在这里；
 *   口径（trim/去空行/判空、按录入序、幂等删除）长在 CanonRepo，本文件不复制，
 *   只补 IPC 边界的形状守卫与项目一致性校验——不许拿 A 书的 id 管理 B 书的铁律。
 *
 * ★ T1 评审 minor-1 统一口径：CanonRepo 的 E_INVALID_ARGS 经 IPC 边界透传时
 *   带 detail {retryable:false}——渲染层据此不画重试按钮（空文本重试一万次
 *   还是空文本）。本文件自抛的边界校验错误同口径。
 *
 * ★ 依赖收口成结构化的 CanonIpcServices：AppServices 结构化满足它
 *   （db / currentProjectId 都是它的公开成员），测试用真 SQLite 也能满足——
 *   本文件不 import electron。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
import type { CanonEntry } from '@shared/types/pipeline';
import { CanonRepo } from '../db/repos/canon-repo';

/* ── 依赖契约 ──────────────────────────────────────────────────── */

/** AppServices 结构化满足本接口 */
export interface CanonIpcServices {
  db: Database;
  currentProjectId(): string | null;
}

/* ── 小工具 ────────────────────────────────────────────────────── */

/** 边界校验错误：E_INVALID_ARGS 一律带 retryable:false（minor-1 口径） */
function invalid(message: string): MzError {
  return new MzError('E_INVALID_ARGS', message, { retryable: false });
}

/** 项目校验：必须打开项目，且传入的 projectId 就是当前项目（与 pipeline 六通道同款） */
function assertCurrentProject(s: CanonIpcServices, projectId: string): void {
  if (typeof projectId !== 'string' || !projectId) {
    throw invalid('projectId 必须是非空字符串');
  }
  const cur = s.currentProjectId();
  if (!cur) throw invalid('未打开项目，无法管理世界观铁律');
  if (cur !== projectId) {
    throw invalid(`projectId 与当前打开的项目不一致：传入 ${projectId}，当前打开 ${cur}`);
  }
}

/** CanonRepo 抛出的 E_INVALID_ARGS（如空文本）透传时补 detail {retryable:false} */
function rethrowWithRetryable(e: unknown): never {
  if (e instanceof MzError && e.code === 'E_INVALID_ARGS') {
    throw new MzError(e.code, e.message, { retryable: false });
  }
  throw e;
}

/* ── 三通道 ────────────────────────────────────────────────────── */

export function listCanon(s: CanonIpcServices, p: { projectId: string }): CanonEntry[] {
  assertCurrentProject(s, p.projectId);
  return new CanonRepo(s.db).list(p.projectId);
}

export function addCanon(s: CanonIpcServices, p: { projectId: string; text: string }): CanonEntry {
  assertCurrentProject(s, p.projectId);
  if (typeof p.text !== 'string') throw invalid('text 必须是字符串');
  try {
    // trim/去空行/判空的口径在 repo（清洗后为空 → E_INVALID_ARGS），这里只透传
    return new CanonRepo(s.db).add(p.projectId, p.text);
  } catch (e) {
    rethrowWithRetryable(e);
  }
}

export function removeCanon(
  s: CanonIpcServices,
  p: { projectId: string; id: string },
): { ok: boolean } {
  assertCurrentProject(s, p.projectId);
  if (typeof p.id !== 'string' || !p.id) throw invalid('id 必须是非空字符串');
  // 不存在返回 false 而不抛（repo 口径：删除是幂等的收尾动作）
  return { ok: new CanonRepo(s.db).remove(p.projectId, p.id) };
}
