/**
 * 仪表盘：全部来自 dash:stats 真实聚合（状态计数 / 卷进度 / 检查点 / LLM 用量）。
 * mock 稿里的「今日新增 / 连更 / 稿费预估 / 追读率」需要发布平台数据，未接入 —— 不造假数。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import type { DashStats } from '@shared/types/ipc';
import styles from './DashboardView.module.css';

export function DashboardView(): JSX.Element {
  const [stats, setStats] = useState<DashStats | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      setStats(await api.aiFlavor.dashStats());
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (err) return <div className={styles.wrap}><p className={styles.err}>{err}</p></div>;
  if (!stats) {
    return (
      <div className={styles.wrap}>
        <p className={styles.note}>{busy ? '加载中…' : '打开项目后查看统计。'}</p>
      </div>
    );
  }

  const wan = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : n.toLocaleString());
  const statusRows: [string, number][] = [
    ['已发布', stats.byStatus.done],
    ['待审', stats.byStatus.revised],
    ['草稿', stats.byStatus.draft],
    ['大纲', stats.byStatus.todo],
  ];
  const maxStatus = Math.max(1, ...statusRows.map(([, n]) => n));

  return (
    <div className={styles.wrap}>
      <div className={styles.statRow}>
        <div className={styles.stat}>
          <div className={styles.sk}>全书字数</div>
          <div className={styles.sv}>
            {wan(stats.totalChars)}
            <small> 字</small>
          </div>
          <div className={styles.sd}>{stats.chapterCount} 章</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>已发布 / 待审</div>
          <div className={styles.sv}>
            {stats.byStatus.done}
            <small> / {stats.byStatus.revised} 章</small>
          </div>
          <div className={styles.sd}>草稿 {stats.byStatus.draft} · 大纲 {stats.byStatus.todo}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>卷册</div>
          <div className={styles.sv}>
            {stats.volumes.length}
            <small> 卷</small>
          </div>
          <div className={styles.sd}>
            {stats.volumes.map((v) => v.title.replace(/^第/, '').split(' ')[0]).join(' · ') || '未分卷'}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>检查点（改动历史）</div>
          <div className={styles.sv}>{stats.checkpoints}</div>
          <div className={styles.sd}>回滚粒度 = Agent 每步</div>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.ph}>分卷进度（稳定稿字数占比）</div>
          {stats.volumes.length === 0 && <p className={styles.note}>还没有分卷。</p>}
          {stats.volumes.map((v) => (
            <div key={v.id} className={styles.hbar}>
              <span className={styles.hn}>{v.title}</span>
              <div className={styles.hb}>
                <i style={{ width: `${Math.min(100, v.progressPct)}%` }} />
              </div>
              <span className={styles.hv}>{v.progressPct}%</span>
            </div>
          ))}
        </div>

        <div className={styles.panel}>
          <div className={styles.ph}>章节状态分布</div>
          {statusRows.map(([label, n]) => (
            <div key={label} className={styles.hbar}>
              <span className={styles.hn}>{label}</span>
              <div className={styles.hb}>
                <i
                  className={styles.fill}
                  style={{ width: `${Math.round((n / maxStatus) * 100)}%` }}
                />
              </div>
              <span className={styles.hv}>{n} 章</span>
            </div>
          ))}
        </div>
      </div>

      {stats.llm && (
        <div className={styles.panel}>
          <div className={styles.ph}>
            Agent 循环 · LLM 用量（本次运行累计）
            <span className={styles.phSp}>{stats.llm.requests} 次调用</span>
          </div>
          <div className={styles.usage}>
            <span>输入 {stats.llm.tokensIn.toLocaleString()} tok</span>
            <span>输出 {stats.llm.tokensOut.toLocaleString()} tok</span>
            <span className={styles.cost}>
              成本 ¥{stats.llm.costCny.toFixed(4)}
            </span>
          </div>
        </div>
      )}

      <p className={styles.note}>
        「今日新增 / 连更天数 / 稿费预估」需要发布平台数据，后续接入；当前全部指标来自章节库与
        Agent 运行时，无占位数据。
      </p>
    </div>
  );
}
