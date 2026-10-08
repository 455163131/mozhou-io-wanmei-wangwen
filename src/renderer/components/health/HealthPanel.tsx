/**
 * 体检面板（架构 T13）。
 *
 * ★ 修复审查发现 MZ-009：两个 marker（抬起头/低头、没说话）会扣健康分但不在任何 layer，
 *   UI 两处都不显示 → 24 分扣得莫名其妙。
 *   本面板**遍历全部 issues**（而非按 layer 过滤），保证「凡是扣分的必显示」。
 */
import { useEffect } from 'react';
import { useHealthStore, useProjectStore } from '../../store';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import type { AnalysisIssue } from '@shared/types/health';
import styles from './HealthPanel.module.css';

const METRIC_KEYS = [
  'avgSent', 'sentCv', 'avgPara', 'sentsPerPara', 'ttr', 'bigramTtr', 'triRepeat', 'dialogRatio',
] as const;

function fmt(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) < 1 ? v.toFixed(decimals) : v.toFixed(Math.min(2, decimals));
}

function IssueRow({ issue }: { issue: AnalysisIssue }): JSX.Element {
  const pct = Math.round(issue.deviation * 100);
  return (
    <div className={`${styles.issue} ${styles[issue.level]}`}>
      <div className={styles.issueLabel}>{issue.label}</div>
      <div className={styles.issueValue}>
        {fmt(issue.value, issue.unit === '/千字' ? 3 : 2)}
        {issue.unit}
      </div>
      <div className={styles.issueBand}>
        基线 [{fmt(issue.band[0], 2)}, {fmt(issue.band[1], 2)}]
      </div>
      {pct > 0 && <div className={styles.issueDev}>超基线 {pct}%</div>}
    </div>
  );
}

export function HealthPanel(): JSX.Element {
  const currentChapter = useProjectStore((s) => s.currentChapterId);
  const analyses = useHealthStore((s) => s.analyses);
  const loading = useHealthStore((s) => s.loading);
  const report = useHealthStore((s) => s.report);

  useEffect(() => {
    void loadReport();
  }, []);

  async function loadReport(): Promise<void> {
    useHealthStore.getState().setLoading(true);
    try {
      const r = await bridge().health.report();
      useHealthStore.getState().setReport(r);
    } catch (e) {
      useProjectStore.getState().setError(errorText(e));
    } finally {
      useHealthStore.getState().setLoading(false);
    }
  }

  const analysis = analyses.find((a) => a.chapterId === currentChapter);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>体检</span>
        <button className={styles.refresh} onClick={() => void loadReport()} disabled={loading}>
          {loading ? '计算中…' : '刷新'}
        </button>
      </div>

      {/* ★ 基线来源必须标注：不能让用户误以为示例基线是他自己的 */}
      {report && (
        <div className={styles.baselineNote} title="风格基线决定各项指标的合格区间">
          {report.baselineSource}
        </div>
      )}

      {analysis ? (
        <>
          <div className={styles.scoreRow}>
            {/* 分数配色：≥80 绿 / ≥60 黄 / <60 红，与基线分位数无关（绝对刻度） */}
            <div
              className={`${styles.score} ${
                analysis.score >= 80 ? styles.ok : analysis.score >= 60 ? styles.warn : styles.risk
              }`}
            >
              {Math.round(analysis.score)}
            </div>
            <div className={styles.scoreMeta}>
              <div>{analysis.chars} 字 · {analysis.paras} 段 · {analysis.sents} 句</div>
              <div className={styles.openType}>章首：{analysis.openType}</div>
            </div>
          </div>

          {/* 样本不足：如实说「还不能判」，而不是给一个无意义的低分（修复 MZ-018） */}
          {!analysis.sufficient && (
            <div className={styles.insufficient}>
              本章还不足 100 字，指标尚未稳定 —— 写够后诊断才有意义。
            </div>
          )}

          {/* 原始指标 */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>文体指标</div>
            <div className={styles.metricGrid}>
              {METRIC_KEYS.map((k) => {
                const issue = analysis.issues.find((i) => i.key === k);
                return (
                  <div key={k} className={`${styles.metric} ${issue ? styles[issue.level] : ''}`}>
                    <span className={styles.metricLabel}>{issue?.label ?? k}</span>
                    <span className={styles.metricValue}>{fmt(analysis.raw[k] ?? 0, 3)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ★ 全部 issues，不按 layer 过滤 —— 凡是扣分的必显示 */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>偏离项（{analysis.issues.length}）</div>
            {analysis.issues.length === 0 ? (
              <div className={styles.allOk}>各项都在基线区间内。</div>
            ) : (
              analysis.issues.map((i) => <IssueRow key={i.key} issue={i} />)
            )}
          </div>
        </>
      ) : (
        <div className={styles.empty}>
          {loading ? '正在计算…' : '打开项目后显示体检结果。'}
        </div>
      )}

      {/* 全书共性问题 */}
      {report && report.commonIssues.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>全书共性问题</div>
          {report.commonIssues.slice(0, 5).map((c) => (
            <div key={c.key} className={styles.commonRow}>
              <span>{c.label}</span>
              <span className={styles.commonCount}>
                {c.hitChapters} 章 · {Math.round(c.ratio * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}