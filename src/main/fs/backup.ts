/**
 * 三层备份轮转（架构 §1.8）。
 *
 * ★ 关键约束：**绝不为「每步改一章」存一份全量快照**。
 *   单章 7.5KB × 深度 50 = 0.38MB；全量 3.75MB × 50 = 187MB——**差 500 倍**。
 *   全量备份只在三个时机做：用户主动保存 / 应用退出 / 每 30 分钟空闲。
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
import { ensureDir, atomicWrite } from './project-fs';

export interface BackupStats {
  path: string;
  bytes: number;
  trigger: BackupTrigger;
  at: number;
}

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
   * 判断当前是否满足空闲备份条件：无编辑 5 分钟 且 无 run，且距上次备份 ≥30 分钟。
   */
  isIdle(now = Date.now()): boolean {
    return (
      now - this.lastEditAt >= IDLE_THRESHOLD_MS &&
      now - this.lastBackupAt >= IDLE_BACKUP_INTERVAL_MS
    );
  }

  /**
   * 做一次全量备份（.mzproj 压缩包）。
   * 保留最近 BACKUP_KEEP_COUNT 份，更老的删除。
   */
  async backup(trigger: BackupTrigger, projectName: string, payload: unknown): Promise<BackupStats> {
    const dir = join(this.rootDir, BACKUP_DIR);
    await ensureDir(dir);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = join(dir, `${projectName}_${stamp}_${trigger}.mzproj`);
    // 项目规模不大（~3MB），直接写 JSON 而不引压缩库——
    // 少一个原生依赖，打包时少一个 ABI 风险
    await atomicWrite(file, JSON.stringify({ project: projectName, at: Date.now(), payload }, null, 1));
    const st = await fs.stat(file);
    this.lastBackupAt = Date.now();

    await this.rotate(dir);
    return { path: file, bytes: st.size, trigger, at: Date.now() };
  }

  /** 轮转：只保留最近 N 份 */
  private async rotate(dir: string): Promise<void> {
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.mzproj'))
      .sort()
      .reverse();
    for (const f of files.slice(BACKUP_KEEP_COUNT)) {
      await fs.unlink(join(dir, f)).catch(() => undefined);
    }
  }

  /** 启动空闲备份定时器 */
  startIdleWatcher(isRunActive: () => boolean, doBackup: () => Promise<void>): void {
    this.stopIdleWatcher();
    this.timer = setInterval(() => {
      if (isRunActive()) return;
      if (!this.isIdle()) return;
      void doBackup();
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