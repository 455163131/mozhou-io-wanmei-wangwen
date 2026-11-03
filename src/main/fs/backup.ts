/**
 * 三层备份轮转（架构 §1.8）。
 *
 * ★ 关键约束：**绝不为「每步改一章」存一份全量快照**。
 *   单章 7.5KB × 深度 50 = 0.38MB；全量 3.75MB × 50 = 187MB——**差 500 倍**。
 *   全量备份只在三个时机做：用户主动保存 / 应用退出 / 每 30 分钟空闲。
 *
 * ★★ 备份必须含正文 ★★
 *   修复前 `backup()` 收到的 payload 是 `{ at: Date.now() }`——一个纯时间戳，
 *   落盘的 `.mzproj` 里没有任何章节内容。三个触发时机中也只有「手动保存」接了线
 *   （`startIdleWatcher` 无调用者、退出路径只调 `closeDatabase()`）。
 *   结果是：注释里写着的三层备份，实际是**零层**，用户没有任何可恢复的稿件副本。
 *   对一个稿件丢失即灾难的写作应用，这是不可接受的。
 *
 *   现在：payload 是 `ProjectBackup`（含全部章节正文 + 账本 + 完整性自检字段），
 *   并提供 `readBackup()` 做读回校验——备份若不可读回，等于没有备份。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  BACKUP_DIR,
  BACKUP_KEEP_COUNT,
  IDLE_BACKUP_INTERVAL_MS,
  IDLE_THRESHOLD_MS,
  type BackupTrigger,
} from '@shared/constants/checkpoint';
import {
  PROJECT_BACKUP_FORMAT_VERSION,
  type ProjectBackup,
} from '@shared/types/project';
import { ensureDir, atomicWrite, pathExists } from './project-fs';
import { countChars } from '@shared/util/text-zh';

export interface BackupStats {
  path: string;
  bytes: number;
  trigger: BackupTrigger;
  at: number;
}

/** 读回校验的结果：要么给出可用的备份，要么明确说清为什么不可用 */
export type ReadBackupResult =
  | { ok: true; backup: ProjectBackup; path: string }
  | { ok: false; reason: string; path: string };

export class BackupManager {
  private lastBackupAt = 0;
  private lastEditAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly rootDir: string) {}

  /** 记录一次编辑（用于判断空闲） */
  noteEdit(): void {
    this.lastEditAt = Date.now();
  }

  /**
   * 判断当前是否满足空闲备份条件：无编辑 5 分钟 且 **无 run**，且距上次备份 ≥30 分钟。
   *
   * @param runActive 是否有 Agent run 正在执行。修复前这个参数不存在，
   *   注释承诺的「无 run」判定从未实现——run 执行中途插入一次全量备份，
   *   会拍到半改状态，恢复出来比不恢复更难理解。
   */
  isIdle(now = Date.now(), runActive = false): boolean {
    if (runActive) return false;
    return (
      now - this.lastEditAt >= IDLE_THRESHOLD_MS &&
      now - this.lastBackupAt >= IDLE_BACKUP_INTERVAL_MS
    );
  }

  /**
   * 做一次全量备份（.mzproj）。
   * 保留最近 BACKUP_KEEP_COUNT 份，更老的删除。
   *
   * @param payload 必须含正文的完整快照。类型上强制为 ProjectBackup，
   *   避免再出现「传个时间戳进来也算备份成功」的形态。
   */
  async backup(
    trigger: BackupTrigger,
    projectName: string,
    payload: ProjectBackup,
  ): Promise<BackupStats> {
    const dir = join(this.rootDir, BACKUP_DIR);
    await ensureDir(dir);

    // ★ 精确到毫秒，并在仍冲突时追加序号。
    //   修复前只精确到秒：同一秒内的两次备份（例如快速连按两次 Ctrl+S）
    //   会算出同一个文件名并**互相覆盖**，于是「保留最近 5 份」实际只剩 4 份，
    //   且被覆盖掉的恰恰是刚写的那份。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    // 项目名可能含文件系统非法字符（用户自取的），必须清洗，否则写盘直接失败
    const safeName = sanitizeForFileName(projectName);
    let file = join(dir, `${safeName}_${stamp}_${trigger}.mzproj`);
    for (let i = 1; await pathExists(file); i++) {
      file = join(dir, `${safeName}_${stamp}_${trigger}_${i}.mzproj`);
    }
    // 项目规模不大（~3.75MB），直接写 JSON 而不引压缩库——
    // 少一个原生依赖，打包时少一个 ABI 风险。
    // atomicWrite 内部已 fsync，断电不会留下半截文件。
    await atomicWrite(file, JSON.stringify(payload));
    const st = await fs.stat(file);
    this.lastBackupAt = Date.now();

    await this.rotate();
    return { path: file, bytes: st.size, trigger, at: this.lastBackupAt };
  }

  /** 列出全部备份，按时间倒序（最新的在前） */
  async listBackups(): Promise<BackupStats[]> {
    const dir = join(this.rootDir, BACKUP_DIR);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return []; // 目录不存在 = 还没备份过，不是错误
    }
    const files = names.filter((f) => f.endsWith('.mzproj'));
    const stats = await Promise.all(
      files.map(async (f) => {
        const path = join(dir, f);
        const st = await fs.stat(path).catch(() => null);
        return st ? { path, bytes: st.size, trigger: triggerOf(f), at: st.mtimeMs } : null;
      }),
    );
    return stats
      .filter((s): s is BackupStats => s !== null)
      .sort((a, b) => b.at - a.at);
  }

  /**
   * 读回一份备份并做完整性自检。
   *
   * ★ 备份的价值只在「能读回来」时才成立。这里显式校验格式版本、必填结构与
   *   integrity 自洽性，任何一项不过都返回明确原因，而不是把半个对象交给调用方。
   */
  async readBackup(path: string): Promise<ReadBackupResult> {
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch (e) {
      return { ok: false, path, reason: `读取失败：${(e as Error).message}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, path, reason: `JSON 解析失败（文件可能被截断）：${(e as Error).message}` };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, path, reason: '内容不是对象' };
    }
    const b = parsed as Partial<ProjectBackup>;

    if (b.formatVersion !== PROJECT_BACKUP_FORMAT_VERSION) {
      return {
        ok: false,
        path,
        reason: `格式版本不识别：${String(b.formatVersion)}（本程序支持 v${PROJECT_BACKUP_FORMAT_VERSION}）。` +
          '这份备份可能来自更新版本的墨书，或来自修复前只写了时间戳的空备份。',
      };
    }
    if (!b.project || !Array.isArray(b.chapters)) {
      return { ok: false, path, reason: '缺少 project 或 chapters 字段' };
    }
    // ★ 关键自检：修复前的空备份能通过上面所有结构检查吗？不能——它没有 chapters。
    //   这条正是把「看起来是备份、其实只有时间戳」的文件挡在门外的判据。
    //   字数口径必须与 services.buildBackupPayload 一致（同用 countChars），
    //   否则自检会因为口径不同而误报「备份不完整」。
    const totalChars = b.chapters.reduce(
      (sum, c) => sum + (typeof c?.body === 'string' ? countChars(c.body) : 0),
      0,
    );
    if (b.integrity && b.integrity.chapterCount !== b.chapters.length) {
      return {
        ok: false,
        path,
        reason: `完整性校验失败：声明 ${b.integrity.chapterCount} 章，实际读到 ${b.chapters.length} 章`,
      };
    }
    if (b.integrity && Math.abs(b.integrity.totalChars - totalChars) > 0) {
      return {
        ok: false,
        path,
        reason: `完整性校验失败：声明 ${b.integrity.totalChars} 字，实际读到 ${totalChars} 字`,
      };
    }

    return { ok: true, backup: b as ProjectBackup, path };
  }

  /**
   * 轮转：只保留最近 N 份。
   *
   * ★ 按 mtime 排序而非文件名字典序。修复前用 `.sort()` 直接排文件名，
   *   而文件名以 projectName 开头——项目改名后新旧备份混排，
   *   被删掉的可能是最新那份。
   */
  private async rotate(): Promise<void> {
    const all = await this.listBackups();
    // listBackups 已按时间倒序；只保留前 BACKUP_KEEP_COUNT 份
    for (const old of all.slice(BACKUP_KEEP_COUNT)) {
      await fs.unlink(old.path).catch(() => undefined);
    }
  }

  /** 启动空闲备份定时器 */
  startIdleWatcher(isRunActive: () => boolean, doBackup: () => Promise<void>): void {
    this.stopIdleWatcher();
    this.timer = setInterval(() => {
      if (!this.isIdle(Date.now(), isRunActive())) return;
      void doBackup().catch(() => undefined);
    }, 60_000);
    // 不阻止进程退出
    this.timer.unref?.();
  }

  stopIdleWatcher(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Windows/POSIX 都不允许的文件名字符，统一换成下划线 */
function sanitizeForFileName(name: string): string {
  // C0 控制字符必须一并清掉：它们能出现在用户自取的项目名里（复制粘贴带入），
  // 留着会让文件名在终端/资源管理器里表现诡异，也可能截断日志。
  // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符，见上
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  // 兜底：全被清洗掉或为空时给个稳定占位，避免产出 `__2026-....mzproj` 这类怪名字
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'project';
}

/**
 * 从文件名还原触发时机（无法识别时按 manual-save 归类，仅供展示）。
 * ★ 用 contains 而非「取最后一段」：同秒冲突时文件名会带 `_1` 这样的去重后缀，
 *   取最后一段会把触发时机读成 "1"。
 */
function triggerOf(fileName: string): BackupTrigger {
  if (fileName.includes('_app-exit')) return 'app-exit';
  if (fileName.includes('_idle-30min')) return 'idle-30min';
  return 'manual-save';
}
