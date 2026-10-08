/**
 * 审稿模式：AI 味检测报告（真实数据：aiFlavor:scan）。
 * 逐章检测 → 总指数 + 维度得分 + 命中清单（原因 / 改法）。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import type { FlavorScanResult } from '@shared/types/ipc';
import type { ChapterMeta } from '@shared/types/project';
import styles from './ReviewView.module.css';

const LEVEL_LABEL: Record<string, string> = {
  clean: '干净',
  mild: '轻微',
  suspicious: '可疑',
  heavy: '偏重',
  severe: '严重',
};

export function ReviewView(): JSX.Element {
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [report, setReport] = useState<FlavorScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const api = bridge();
        if (!api) return;
        const list = await api.chapter.list();
        setChapters(list);
        setChapterId(list[0]?.id ?? null);
      } catch (e) {
        setErr(errorText(e));
      }
    })();
  }, []);

  const scan = useCallback(async () => {
    if (!chapterId) return;
    setBusy(true);
    setErr(null);
    setReport(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const res = await api.aiFlavor.scan([chapterId]);
      setReport(res[0] ?? null);
      if (!res[0]) setErr('该章节无可检测内容');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [chapterId]);

  const active = (report?.dimensions ?? []).filter((d) => !d.skipped && d.score > 0);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>审稿 · AI 味检测</span>
        <select
          className={styles.select}
          value={chapterId ?? ''}
          onChange={(e) => setChapterId(e.target.value)}
        >
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button className={styles.btnPri} disabled={busy || !chapterId} onClick={() => void scan()}>
          {busy ? '检测中…' : '开始审查'}
        </button>
      </div>

      {err && <p className={styles.err}>{err}</p>}
      {!report && !busy && !err && (
        <div className={styles.empty}>
          选一章，点「开始审查」。
          <br />
            判据来自「离你自己的正常写作范围有多远」——所有结论都能对回命中片段，可自行核对。
        </div>
      )}

      {report && (
        <>
          <div className={`${styles.scoreBox} ${styles['lv-' + report.level]}`}>
            <div className={styles.scoreNum}>{report.index}</div>
            <div className={styles.scoreMeta}>
              <div>
                AI 味指数 · <b>{LEVEL_LABEL[report.level] ?? report.level}</b>
              </div>
              <div className={styles.dim}>
                {report.chars} 字 / {report.paragraphs} 段 / {report.hits.length} 处命中 · 主导：
                {report.dominantDimension ?? '—'}
              </div>
            </div>
          </div>

          {active.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>维度得分</div>
              {active.map((d) => (
                <div key={d.dimension} className={styles.dimRow}>
                  <span className={styles.dimName}>{d.dimension}</span>
                  <span className={styles.barWrap}>
                    <span
                      className={`${styles.bar} ${styles['lv-' + d.level]}`}
                      style={{ width: `${Math.min(100, d.score)}%` }}
                    />
                  </span>
                  <span className={styles.dimScore}>{d.score}</span>
                  <div className={styles.dimNote}>{d.note}</div>
                </div>
              ))}
            </div>
          )}

          {report.hits.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>命中片段（{report.hits.length}）</div>
              {report.hits.slice(0, 40).map((h, i) => (
                <div key={`${h.offset}-${i}`} className={styles.hit}>
                  <div className={styles.hitHead}>
                    <span className={styles.tag}>{h.kind}</span>
                    <span className={styles.hitPara}>第{h.paragraphNo}段</span>
                  </div>
                  {h.excerpt && <div className={styles.excerpt}>{h.excerpt}</div>}
                  <div className={styles.reason}>{h.reason}</div>
                  <div className={styles.advice}>→ {h.advice}</div>
                </div>
              ))}
            </div>
          )}

          <p className={styles.note}>
            本检测是「写作体检」：给出可核对的统计事实与修改建议，不构成「是否 AI 生成」的判定。
          </p>
        </>
      )}
    </div>
  );
}
