/**
 * 规划模式：卷册总览 + 分卷进度（真实数据：project:volumes + chapterRepo 聚合）。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import type { DashStats } from '@shared/types/ipc';
import type { Volume } from '@shared/types/project';
import styles from './PlanView.module.css';

export function PlanView(): JSX.Element {
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [stats, setStats] = useState<DashStats | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const [v, s] = await Promise.all([api.project.volumes(), api.aiFlavor.dashStats()]);
      setVolumes(v);
      setStats(s);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const progressOf = (volumeId: string): { chapters: number; chars: number; pct: number } => {
    const v = stats?.volumes.find((x) => x.id === volumeId);
    return { chapters: v?.chapters ?? 0, chars: v?.chars ?? 0, pct: v?.progressPct ?? 0 };
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.crumb}>
        <b>《{stats ? `${stats.totalChars > 0 ? (stats.totalChars / 10000).toFixed(1) : '0'} 万字` : '…'}》</b>
        <span className={styles.sep}>·</span>
        <span>{stats?.chapterCount ?? 0} 章</span>
        <span className={styles.sep}>·</span>
        <span>{volumes.length} 卷</span>
      </div>

      {err && <p className={styles.err}>{err}</p>}
      {busy && !stats && <p className={styles.note}>加载中…</p>}

      {stats && (
        <>
          <div className={styles.bookg}>
            <div className={styles.bh}>
              <b>全书总览</b>
            </div>
            <div className={styles.row}>
              <span>
                <span className={styles.k}>总字数</span>
                {stats.totalChars.toLocaleString()} 字
              </span>
              <span>
                <span className={styles.k}>总章数</span>
                {stats.chapterCount}
              </span>
              <span>
                <span className={styles.k}>已发布</span>
                {stats.byStatus.done} 章
              </span>
              <span>
                <span className={styles.k}>待审</span>
                {stats.byStatus.revised} 章
              </span>
              <span>
                <span className={styles.k}>草稿</span>
                {stats.byStatus.draft} 章
              </span>
              <span>
                <span className={styles.k}>大纲</span>
                {stats.byStatus.todo} 章
              </span>
              <span>
                <span className={styles.k}>检查点</span>
                {stats.checkpoints}
              </span>
            </div>
          </div>

          <div className={styles.volsGrid}>
            {volumes.map((v, i) => {
              const p = progressOf(v.id);
              return (
                <div key={v.id} className={styles.oc}>
                  <div className={styles.oh}>
                    <span className={styles.no}>第 {i + 1} 卷</span>
                  </div>
                  <div className={styles.ot}>{v.title}</div>
                  <div className={styles.os}>
                    {p.chapters} 章 · {p.chars.toLocaleString()} 字
                  </div>
                  <div className={styles.ob}>
                    <i className={styles.fill} style={{ width: `${Math.min(100, p.pct)}%` }} />
                  </div>
                  <div className={styles.om}>
                    <span>稳定稿进度 {p.pct}%</span>
                  </div>
                </div>
              );
            })}
            {volumes.length === 0 && !busy && (
              <div className={styles.add}>
                还没有分卷。
                <br />
                在对话里让 Agent 建立卷册规划。
              </div>
            )}
          </div>

          <p className={styles.note}>
            数据来自章节库实时聚合（状态计数 / 卷内稳定稿占比）。新建分卷与拖拽排序将在后续版本接入。
          </p>
        </>
      )}
    </div>
  );
}
