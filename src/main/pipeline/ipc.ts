/**
 * P0 生成流水线 T5：六条 IPC 通道的 handler 实现。
 *
 * ★ 分工：register.ts 只做通道登记，本文件承载全部业务语义——
 *   生成三通道（run-concept / run-outline / write-draft）直调 T4 的
 *   pipelineHandlers（与注册进 ToolRegistry 的是同一份实现，两处永不漂移），
 *   并用 pipeline:progress 推送包裹 running/done/failed；
 *   adopt/discard/list 直连 DraftRepo 与 ChapterRepo。
 *
 * ★ 定稿主权（架构红线）：正文入正稿的**唯一入口**是 adoptDraft——
 *   kind=chapter 且无 chapterId 时 ChapterRepo.createChapter 建章；
 *   带 chapterId 而指向章尚不存在时按 R14/R15（终评 C1 + 控制器裁决）：
 *   基准 nextNo = 现有章 id 最大可解析号 + 1（无章则 1，不用 count——删章/
 *   导入书会让章号非连续）。恰为 nextNo 则回退建章（带对齐断言）后写入
 *   （流水线草稿 chapterId=章号字符串，空库首章必经此路）；跳章（>nextNo）
 *   E_PIPELINE_STATE 硬拦；空洞号（<nextNo 且不存在，R16）同样硬拦直报。
 *   随后一律经 updateBody(pid, id, content, rev) 写入（乐观锁 + 日增量记账
 *   都长在 updateBody 里，绕开它就是绕开账本）。生成环节只写 drafts 隔离区。
 *
 * ★ failed 的 detail 带真因（error.code + message），不拟人化：
 *   用户看到的就是库里/模型里真实发生的事。
 *
 * ★ 依赖收口成结构化的 PipelineIpcServices：AppServices 结构化满足它，
 *   测试用真 SQLite + 假 push 也能满足——本文件不 import electron。
 */
import type { Database } from 'better-sqlite3';
import { MzError } from '@shared/types/ipc';
import type { IpcPushChannel, IpcPushMap } from '@shared/types/ipc';
import type { ToolContext, ToolResult } from '@shared/types/tool';
import type { Draft, DraftStatus } from '@shared/types/pipeline';
import type { ChapterRepo } from '../db/repos/chapter-repo';
import { DraftRepo } from '../db/repos/draft-repo';
import type { PipelineHandlers } from './tools';

/* ── 依赖契约 ──────────────────────────────────────────────────── */

/** AppServices 结构化满足本接口（db / chapterRepo / push / backup 都是它的公开成员） */
export interface PipelineIpcServices {
  db: Database;
  chapterRepo: ChapterRepo;
  push: { send<K extends IpcPushChannel>(channel: K, payload: IpcPushMap[K]): void };
  backup: { noteEdit(): void };
  currentProjectId(): string | null;
  /** T4 的三个生成 handler（services 侧与 ToolRegistry 共用同一份 deps） */
  pipelineHandlers(): PipelineHandlers;
}

type Progress = IpcPushMap['pipeline:progress'];

/* ── 小工具 ────────────────────────────────────────────────────── */

/**
 * 生成 handler 的调用上下文。流水线不走工具快照通道：
 * 产物只进草稿区，正稿写入发生在 adopt（updateBody 自带乐观锁与记账）。
 */
function toolCtx(): ToolContext {
  return {
    runId: 'pipeline-ipc',
    stepNo: 0,
    dryRun: true,
    requireCheckpoint: async () => {
      throw new MzError('E_CHECKPOINT_FAILED', '生成流水线不走工具快照通道');
    },
    signal: new AbortController().signal,
    logger: () => undefined,
  };
}

/** 生成通道的项目校验：必须打开项目，且传入的 projectId 就是当前项目（不许跨书生成） */
function assertCurrentProject(s: PipelineIpcServices, projectId: string): void {
  if (typeof projectId !== 'string' || !projectId) {
    throw new MzError('E_INVALID_ARGS', 'projectId 必须是非空字符串');
  }
  const cur = s.currentProjectId();
  if (!cur) throw new MzError('E_INVALID_ARGS', '未打开项目，无法执行生成流水线');
  if (cur !== projectId) {
    throw new MzError(
      'E_INVALID_ARGS',
      `projectId 与当前打开的项目不一致：传入 ${projectId}，当前打开 ${cur}`,
    );
  }
}

/** ToolResult → {draftId}；失败转 MzError（retryable 放进 detail，渲染层据此决定是否给重试按钮） */
function unwrapDraftId(res: ToolResult): { draftId: string } {
  if (!res.ok || !res.data) {
    const e = res.error;
    throw new MzError(e?.code ?? 'E_INTERNAL', e?.message ?? '生成失败（handler 未给出原因）', {
      retryable: e?.retryable ?? false,
    });
  }
  const data = res.data as { draftId?: unknown };
  if (typeof data.draftId !== 'string') {
    throw new MzError('E_INTERNAL', '生成成功但未返回 draftId');
  }
  return { draftId: data.draftId };
}

/** running/done/failed 三态包裹：failed 的 detail 带真因（code+message），随后原样上抛 */
async function withProgress<T>(
  s: PipelineIpcServices,
  projectId: string,
  step: Progress['step'],
  fn: () => Promise<T> | T,
): Promise<T> {
  s.push.send('pipeline:progress', { projectId, step, state: 'running' });
  try {
    const out = await fn();
    s.push.send('pipeline:progress', { projectId, step, state: 'done' });
    return out;
  } catch (e) {
    const code = e instanceof MzError ? String(e.code) : 'E_INTERNAL';
    const message = e instanceof Error ? e.message : String(e);
    s.push.send('pipeline:progress', { projectId, step, state: 'failed', detail: `${code}: ${message}` });
    throw e instanceof MzError ? e : new MzError('E_INTERNAL', message);
  }
}

/* ── 生成三通道 ────────────────────────────────────────────────── */

export function runConcept(s: PipelineIpcServices, projectId: string): Promise<{ draftId: string }> {
  return withProgress(s, projectId, 'concept', async () => {
    assertCurrentProject(s, projectId);
    return unwrapDraftId(await s.pipelineHandlers().concept({}, toolCtx()));
  });
}

export function runOutline(
  s: PipelineIpcServices,
  p: { projectId: string; volumeIndex?: number },
): Promise<{ draftId: string }> {
  return withProgress(s, p.projectId, 'outline', async () => {
    assertCurrentProject(s, p.projectId);
    const args: { volumeIndex?: number } = {};
    if (p.volumeIndex !== undefined) {
      if (!Number.isInteger(p.volumeIndex) || p.volumeIndex < 0) {
        throw new MzError('E_INVALID_ARGS', 'volumeIndex 必须是非负整数（0 起的卷索引）');
      }
      args.volumeIndex = p.volumeIndex;
    }
    // Carry-1（续写需已采纳卷纲 → E_PIPELINE_STATE）在 handler 内前置校验，
    // 这里只透传——两处共用同一份实现，不在 IPC 层复制口径。
    return unwrapDraftId(await s.pipelineHandlers().outline(args, toolCtx()));
  });
}

export function writeDraft(
  s: PipelineIpcServices,
  p: { projectId: string; chapterNo: number; planItem: { title: string; hook: string } },
): Promise<{ draftId: string }> {
  return withProgress(s, p.projectId, 'draft', async () => {
    assertCurrentProject(s, p.projectId);
    // Carry-2（chapterNo 正整数校验 → E_INVALID_ARGS retryable:false）在 handler 内，
    // IPC 层不另立一套口径。
    return unwrapDraftId(
      await s.pipelineHandlers().writeDraft({ chapterNo: p.chapterNo, planItem: p.planItem }, toolCtx()),
    );
  });
}

/* ── 草稿管理三通道 ────────────────────────────────────────────── */

const DRAFT_STATUSES: readonly DraftStatus[] = ['pending', 'adopted', 'discarded'];

export function listDrafts(s: PipelineIpcServices, p: { projectId: string; status?: DraftStatus }): Draft[] {
  if (typeof p.projectId !== 'string' || !p.projectId) {
    throw new MzError('E_INVALID_ARGS', 'projectId 必须是非空字符串');
  }
  if (p.status !== undefined && !DRAFT_STATUSES.includes(p.status)) {
    throw new MzError('E_INVALID_ARGS', `未知的草稿状态：${String(p.status)}`);
  }
  return new DraftRepo(s.db).list(p.projectId, p.status);
}

/**
 * 采纳草稿（正文入正稿的唯一入口）。
 *
 * 顺序纪律：先做全部校验，再写正稿，最后 setStatus——better-sqlite3 全程同步，
 * 一个事件循环拍内完成，中间不可能被别的写操作插进来（乐观锁形同虚设的场景不存在）。
 * 已终态的草稿在这里被拦下，正稿一个字都不会被动。
 */
export async function adoptDraft(s: PipelineIpcServices, draftId: string): Promise<{ chapterId: string | null }> {
  const drafts = new DraftRepo(s.db);
  const d = drafts.get(draftId);
  if (!d) throw new MzError('E_DRAFT_STATE', `草稿不存在：${draftId}`);
  return withProgress(s, d.projectId, 'adopt', () => {
    if (d.status !== 'pending') {
      throw new MzError('E_DRAFT_STATE', `不允许的状态流转：${d.status} → adopted`);
    }
    let chapterId: string | null = null;
    if (d.kind === 'chapter') chapterId = writeCanon(s, d);
    // concept/outline：仅标记 adopted（作为后续步骤 getCtx 的输入源），不碰正稿
    drafts.setStatus(draftId, 'adopted');
    return { chapterId };
  });
}

/** kind=chapter 的采纳：无章号建章，有章号写进该章；一律经 updateBody 落正文 */
function writeCanon(s: PipelineIpcServices, d: Draft): string {
  const pid = d.projectId;
  if (d.chapterId == null) {
    // 无章号：主进程按「现有最大号 + 1」建章（章号是主键，绝不让调用方传）
    const created = s.chapterRepo.createChapter(pid, { title: '' });
    const updated = s.chapterRepo.updateBody(pid, created.id, d.content, created.rev);
    return afterCanonWrite(s, updated.id, updated.rev);
  }
  const ch = s.chapterRepo.get(pid, d.chapterId);
  if (ch) {
    // 指向章存在：维持现状写进该章（updateBody 自带 rev 乐观锁）
    const updated = s.chapterRepo.updateBody(pid, d.chapterId, d.content, ch.meta.rev);
    return afterCanonWrite(s, updated.id, updated.rev);
  }
  // ★ R14（终评 C1）→ R15/R16（控制器裁决）：指向章不存在。流水线草稿的
  //   chapterId = 章号字符串（tools.ts writeDraft 落草稿时恒设 String(chapterNo)），
  //   空库上采纳第 1 章必然走到这里——不能一律拒。基准**不用 count**：删章或
  //   导入书会让章号非连续（如现有 {1,5}，count=2），"恰为下一章"会算错。
  //   nextNo = 现有章 id 中最大可解析号 + 1（无章则 1），用 listMeta 取 id 计算，
  //   与 ChapterRepo.createChapter 的建号口径一致（chapter-repo.ts）。分四支：
  //   · chapterNo === nextNo → createChapter + 对齐断言 + updateBody。
  //     章号仍由库侧算，绝不让调用方传主键的纪律不破；
  //   · chapterNo > nextNo → 防跳章硬拦；
  //   · chapterNo < nextNo → 空洞号（已被删除或从未存在）直报 E_PIPELINE_STATE（R16）；
  //   · 非章号形状 → E_INVALID_ARGS 直报章节不存在。
  const chapterNo = Number(d.chapterId);
  const nextNo = nextChapterNo(s.chapterRepo.listMeta(pid));
  if (Number.isInteger(chapterNo) && chapterNo >= 1) {
    if (chapterNo === nextNo) {
      const created = s.chapterRepo.createChapter(pid, { title: '' });
      // ★ R15 对齐断言（必须在 updateBody 之前）：库侧建出的号与期望不符时
      //   宁可失败，也不能让正文静默落进错误章（修复前 {1,5} 库上指向 "3" 的
      //   草稿会被建成第 6 章并写入正文）。
      if (created.id !== String(chapterNo)) {
        throw new MzError(
          'E_PIPELINE_STATE',
          `建章对齐失败：期望第 ${chapterNo} 章，库侧建成第 ${created.id} 章`,
          { retryable: false },
        );
      }
      const updated = s.chapterRepo.updateBody(pid, created.id, d.content, created.rev);
      return afterCanonWrite(s, updated.id, updated.rev);
    }
    if (chapterNo > nextNo) {
      throw new MzError(
        'E_PIPELINE_STATE',
        `不能跳章：本书现有章号到 ${nextNo - 1}，第 ${chapterNo} 章尚不存在，请先写第 ${nextNo} 章`,
        { retryable: false },
      );
    }
    // chapterNo < nextNo 且指向章不存在（存在分支已在上方 get 处排除）→ 空洞号（R16）
    throw new MzError(
      'E_PIPELINE_STATE',
      `第 ${chapterNo} 章是空洞号（已被删除或从未存在）：下一个可写章号是 ${nextNo}`,
      { retryable: false },
    );
  }
  // 非章号形状的 chapterId：维持原判——直报章节不存在
  throw new MzError(
    'E_INVALID_ARGS',
    `章节不存在：${d.chapterId}（草稿指向的章号尚未建章；先建章，或改用不带章号的草稿）`,
  );
}

/**
 * R15 建章/防跳章基准：现有章 id 中最大可解析号 + 1（无章则 1）。
 * 与 ChapterRepo.createChapter 的算号口径逐字一致（Number.isFinite 过滤
 * 非数字 id，楔子/番外这类占位不参与算号），保证「恰为下一章」判断与
 * 库侧实际建出的号永远对齐。
 */
function nextChapterNo(metas: ReadonlyArray<{ id: string }>): number {
  let maxNo = 0;
  for (const m of metas) {
    const n = Number(m.id);
    if (Number.isFinite(n) && n > maxNo) maxNo = n;
  }
  return maxNo + 1;
}

function afterCanonWrite(s: PipelineIpcServices, chapterId: string, rev: number): string {
  s.backup.noteEdit();
  // source:'user'——采纳是作者的显式决定，不是 Agent 自动写入
  s.push.send('chapter:changed', { chapterId, rev, source: 'user' });
  return chapterId;
}

export async function discardDraft(s: PipelineIpcServices, draftId: string): Promise<{ ok: true }> {
  // 不存在的草稿 / 非法流转由 repo 抛 E_DRAFT_STATE，这里不另立口径
  new DraftRepo(s.db).setStatus(draftId, 'discarded');
  return { ok: true };
}
