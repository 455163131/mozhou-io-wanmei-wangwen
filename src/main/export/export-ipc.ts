/**
 * 导出三通道的业务实现（P2-D T3，spec §4/§6）。
 *
 * scope 解析 → 中间文档 → 单点构建（预览与导出走同一 buildContent，
 * 字节诚实同源——预览的 bytes 就是导出的 bytes，不是估算）→
 * 安全化落名（★2/★4 目录语义照旧：'project' 写项目根、'external' 写文档根）→
 * 成败都入历史（ok 行在写盘之后；fail 行 path/bytes null、error 存真因再原样抛）。
 *
 * 红线：本模块零网络零正文写——写只发生在本项目根/文档根的导出新文件。
 * P2D-R4：旧内联 md/csv/假 zip（拼接文本冒 zip）随 register.ts 旧块一并退役；
 * csv 不在新 format 枚举里，坏值在 zod 门口拦（invalid() 口径同 inspiration-ipc）。
 *
 * register.ts 只做一行式委托（canon/overlay/inspiration 同款模式），
 * 行为用例直测本模块函数（tests/unit/export-ipc.test.ts，真 :memory: 库 + mkdtemp 根）。
 */
import { z } from 'zod';
import { MzError } from '@shared/types/ipc';
import type {
  ExportFormat,
  ExportHistoryRow,
  ExportPreviewRes,
  ExportRunReq,
  ExportRunRes,
  ExportScope,
} from '@shared/types/export';
import type { ChapterMeta } from '@shared/types/project';
import type { ChapterRepo } from '../db/repos/chapter-repo';
import type { ExportHistoryRepo } from '../db/repos/export-history-repo';
import { ensureDir, atomicWrite, resolveInProject } from '../fs/project-fs';
import { toChaptersDoc, type ChaptersDoc } from './book-doc';
import { txtDoc, mdDoc } from './txt-md';
import { buildEpub } from './epub-builder';
import { buildDocx } from './docx-builder';
import { buildZip } from './zip-writer';

/** 当前打开项目的最小面（AppServices.project 结构化满足） */
export interface ExportProject {
  id: string;
  name: string;
  rootDir: string;
}

/** register.ts 从 AppServices 拼出的最小依赖面（getProject 为 null = 未打开项目） */
export interface ExportIpcDeps {
  getProject: () => ExportProject | null;
  chapters: ChapterRepo;
  documentsDir: string;
  history: ExportHistoryRepo;
}

/* ── 边界 zod（IPC 入参在门口拦，坏值不透传到构建/磁盘）────────────── */

const ScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('book') }),
  z.object({ kind: z.literal('volume'), volumeId: z.string().min(1) }),
  z.object({ kind: z.literal('chapters'), chapterIds: z.array(z.string().min(1)).min(1) }),
]);
/**
 * ★ T7 携带修复：`z.ZodType<ExportRunReq>` 显式形护——schema 与契约漂移时
 * 编译期立红，不靠 gate() 出口处的那枚 `as` 兜住（该 as 已随之退役）。
 */
const ReqSchema: z.ZodType<ExportRunReq> = z.object({
  format: z.enum(['txt', 'md', 'epub', 'docx', 'zip']),
  scope: ScopeSchema,
  dest: z.enum(['project', 'external']),
  baseName: z.string().min(1).max(80).optional(),
});
const HistoryArgSchema = z.object({ limit: z.number().int().min(1).max(200).optional() });

function invalid(channel: string, issue: z.ZodError): never {
  throw new MzError('E_INVALID_ARGS', `${channel} 入参非法：${issue.issues.map((i) => i.message).join('；')}`, {
    retryable: false,
  });
}

const EXT: Record<ExportFormat, string> = { txt: 'txt', md: 'md', epub: 'epub', docx: 'docx', zip: 'zip' };

/** 控制字符判定（<0x20）。不用 \u0000-\u001f 正则——lint 明令 no-control-regex。 */
function hasControlChar(s: string): boolean {
  return [...s].some((ch) => ch.charCodeAt(0) < 0x20);
}

/**
 * 落名安全化：分隔符/`..`/控制字符一律拒绝（E_INVALID_ARGS 在任何 fs 触碰之前）。
 * resolveInProject 仍是最后防线（相对路径口径），这里是门口就拦。
 */
function safeBaseName(raw: string): string {
  if (/[/\\]|\.\./.test(raw) || hasControlChar(raw)) throw new MzError('E_INVALID_ARGS', `导出文件名非法：${raw}`);
  return raw.trim();
}

/** 文件系统名里的非法字符集（Windows 保留 + 路径分隔） */
const ILLEGAL_NAME_CHARS = '\\/:*?"<>|';

/** zip 条目名安全化：剥 Windows/POSIX 非法字符与控制字符，空白串收为 '_'，空形回退 '章'+n */
function safeEntryLabel(raw: string, n: number): string {
  const cleaned = [...raw]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && !ILLEGAL_NAME_CHARS.includes(ch))
    .join('')
    .trim()
    .replace(/\s+/g, '_');
  return cleaned || `章${n}`;
}

function resolveTargets(deps: ExportIpcDeps, project: ExportProject, scope: ExportScope): ChapterMeta[] {
  const metas = deps.chapters.listMeta(project.id);
  if (scope.kind === 'book') return metas;
  if (scope.kind === 'volume') return metas.filter((m) => m.volumeId === scope.volumeId); // 空卷 → 上层 E_NOT_FOUND
  const byId = new Map(metas.map((m) => [m.id, m]));
  const missing = scope.chapterIds.filter((id) => !byId.has(id));
  if (missing.length) throw new MzError('E_NOT_FOUND', `章节不存在：${missing.join('、')}`);
  const want = new Set(scope.chapterIds);
  return metas.filter((m) => want.has(m.id)); // 显式 id 也按库内序导出（章序是作品事实，不按请求序）
}

/** 中间文档：标题兜底 `第N章`（空标题是写作常态，不是数据错误） */
function toDoc(deps: ExportIpcDeps, project: ExportProject, targets: ChapterMeta[]): ChaptersDoc {
  const bodies = deps.chapters.getBodies(
    project.id,
    targets.map((m) => m.id),
  );
  return toChaptersDoc({
    title: project.name,
    chapters: targets.map((m) => ({ label: m.title || `第${m.id}章`, body: bodies.get(m.id) ?? '' })),
  });
}

interface Built {
  content: Buffer;
  toc: Array<{ label: string; chars: number }>;
  sample: string;
  warnings: string[];
}

/**
 * 单点构建——预览与导出**唯一**的内容入口（字节诚实的结构性保证）。
 * 未定稿章（todo/draft）照含，但 warnings 如实记；空范围是 E_NOT_FOUND 不是空文件。
 */
async function buildContent(deps: ExportIpcDeps, project: ExportProject, req: ExportRunReq): Promise<Built> {
  const targets = resolveTargets(deps, project, req.scope);
  if (targets.length === 0) throw new MzError('E_NOT_FOUND', '所选范围内没有章节');
  const doc = toDoc(deps, project, targets);
  const warnings = targets
    .filter((m) => m.status === 'todo' || m.status === 'draft')
    .map((m) => `含未定稿章 ${m.title || m.id}（导出照含，历史行如实记）`);
  const toc = doc.chapters.map((c) => ({ label: c.label, chars: c.body.replace(/\s/g, '').length }));
  // sample：首章正文剥空白后前 120 字（预览卡展示用）
  const sample = doc.chapters[0].body.replace(/\s/g, '').slice(0, 120);
  let content: Buffer;
  if (req.format === 'txt') content = Buffer.from(txtDoc(doc), 'utf8');
  else if (req.format === 'md') content = Buffer.from(mdDoc(doc), 'utf8');
  else if (req.format === 'epub') content = buildEpub(doc);
  else if (req.format === 'docx') content = buildDocx(doc);
  else
    content = buildZip([
      ...doc.chapters.map((c, i) => ({
        name: `${String(i + 1).padStart(4, '0')}_${safeEntryLabel(c.label, i + 1)}.txt`,
        data: Buffer.from(`${c.label}\n\n${c.body}`, 'utf8'),
      })),
      {
        name: 'manifest.txt',
        data: Buffer.from(`《${doc.title}》导出包\n` + toc.map((t) => `- ${t.label}（${t.chars} 字）`).join('\n'), 'utf8'),
      },
    ]);
  return { content, toc, sample, warnings };
}

/** 入口公共校验：zod → 项目已打开。返回窄化后的 req 与项目（之后不再有空形）。 */
function gate(deps: ExportIpcDeps, channel: string, args: unknown): { req: ExportRunReq; project: ExportProject } {
  const parsed = ReqSchema.safeParse(args);
  if (!parsed.success) invalid(channel, parsed.error);
  const project = deps.getProject();
  if (!project) throw new MzError('E_INVALID_ARGS', '未打开项目');
  return { req: parsed.data, project };
}

/** export:run —— 构建 → 落盘（原子写）→ ok 行；任何一步失败 → fail 行带真因再原样抛。 */
export async function runExportIpc(deps: ExportIpcDeps, args: unknown): Promise<ExportRunRes> {
  const { req, project } = gate(deps, 'export:run', args);
  try {
    const baseName = safeBaseName(req.baseName ?? project.name);
    const { content } = await buildContent(deps, project, req);
    const dir = req.dest === 'external' ? deps.documentsDir : project.rootDir;
    await ensureDir(dir);
    const fullPath = resolveInProject(dir, `${baseName}.${EXT[req.format]}`);
    await atomicWrite(fullPath, content);
    deps.history.insert({
      projectId: project.id,
      format: req.format,
      scope: req.scope,
      dest: req.dest,
      path: fullPath,
      bytes: content.length,
      status: 'ok',
      error: null,
    });
    return { path: fullPath, bytes: content.length };
  } catch (e) {
    // fail 行存真因（EACCES/磁盘满/缺章的原始 message），不是拟人的'导出失败'
    // ★ T7 携带修复：历史账本尽力而为——账本自己写不进（锁库/磁盘满）不能冒名
    // 顶替原始错误；吞掉的只是二次故障，rethrow 的永远是最初那个真因。
    try {
      deps.history.insert({
        projectId: project.id,
        format: req.format,
        scope: req.scope,
        dest: req.dest,
        path: null,
        bytes: null,
        status: 'fail',
        error: e instanceof Error ? e.message : String(e),
      });
    } catch {
      /* 历史尽力而为——原始错误才是主角 */
    }
    throw e;
  }
}

/**
 * export:preview —— 只读动作：同一 buildContent 出真字节，**不写盘、不入历史**。
 * req 复用 ExportRunReq 形（少一处漂移）：dest 字段在预览时被忽略，字节与 dest 无关。
 */
export async function previewExportIpc(deps: ExportIpcDeps, args: unknown): Promise<ExportPreviewRes> {
  const { req, project } = gate(deps, 'export:preview', args);
  const { content, toc, sample, warnings } = await buildContent(deps, project, req);
  return { bytes: content.length, toc, sample, warnings };
}

/** export:history —— 最近导出记录（新在前），默认 50 条。 */
export function historyIpc(deps: ExportIpcDeps, args: unknown): ExportHistoryRow[] {
  const parsed = HistoryArgSchema.safeParse(args ?? {});
  if (!parsed.success) invalid('export:history', parsed.error);
  return deps.history.listRecent(parsed.data.limit ?? 50);
}
