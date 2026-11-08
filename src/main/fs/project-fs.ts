/**
 * 路径规范化与原子写（架构 T10）。
 *
 * ★ 防目录穿越：渲染层传来的任何路径都必须在项目根目录内。
 *   这是安全边界——否则渲染层（或被注入的脚本）能读写项目外的任意文件。
 */
import { promises as fs } from 'node:fs';
import { resolve, sep, join, relative, isAbsolute, normalize, dirname } from 'node:path';
import { MzError } from '@shared/types/ipc';

/**
 * 把用户提供的相对路径解析为项目内的绝对路径，并确保不越界。
 * @throws E_NOT_PROJECT_FILE 路径越界
 */
export function resolveInProject(rootDir: string, relativePath: string): string {
  const root = resolve(rootDir);
  const target = isAbsolute(relativePath)
    ? resolve(relativePath)
    : resolve(join(root, normalize(relativePath)));

  const rel = relative(root, target);
  // rel 以 '..' 开头、或为空（等于根）、或是绝对路径 => 越界
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new MzError(
      'E_NOT_PROJECT_FILE',
      `路径越界：${relativePath} 不在项目目录 ${root} 内。`,
      { root, target },
    );
  }
  return target;
}

/** 判断候选路径是否在项目内 */
export function isInsideProject(rootDir: string, candidate: string): boolean {
  try {
    resolveInProject(rootDir, candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子写：先写临时文件、fsync 落盘、再 rename，最后 fsync 父目录。
 * 避免写到一半崩溃导致文件损坏——对用户正文这是不可接受的。
 *
 * ★ 为什么必须 fsync（修复前缺失）：
 *   只 writeFile + rename 的话，数据可能还在 OS page cache 里。断电/蓝屏时
 *   rename 的目录项可能先于文件内容落盘，结果是**一个 0 字节或截断的章节文件**
 *   ——恰好是本函数注释声称要杜绝的那个失败。参照 novelWriter 的存储实现：
 *   「写临时文件 → 成功后删旧 → 替换」，且落盘后再替换。
 *
 * ★ P2-D T3：content 扩为 `string | Buffer`——导出线（epub/docx/zip）产的是
 *   二进制 Buffer。tmp+writeFile+fsync+rename 的原子性对两种形态同样成立
 *   （Buffer 走同一 write 路径，'utf8' 编码参数对 Buffer 无副作用）。
 */
export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync(); // 数据落盘，再谈替换
  } catch (e) {
    await fh.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fh.close();

  try {
    await fs.rename(tmp, path);
  } catch (e) {
    // rename 失败则清理临时文件，不留垃圾
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }

  // 目录项也要落盘，否则 rename 本身可能丢失。
  // Windows 上打开目录通常会 EPERM/EISDIR —— best-effort，失败不影响正确性
  // （NTFS 的 rename 是元数据 journal 保护的），故静默忽略。
  await fsyncDir(dirname(path));
}

/** 把目录项刷到磁盘。平台不支持时静默返回（见 atomicWrite 注释）。 */
async function fsyncDir(dir: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // 平台/权限不支持目录 fsync，忽略
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** 列出目录下的子目录 */
export async function listDirs(path: string): Promise<string[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** 路径分隔符处理：Windows 与 POSIX 都支持 */
export function toNativePath(p: string): string {
  return sep === '\\' ? p.replace(/\//g, '\\') : p;
}