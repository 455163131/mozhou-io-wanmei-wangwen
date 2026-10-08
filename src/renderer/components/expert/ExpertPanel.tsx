/**
 * 专家团面板（阶段三交付物：UI 手动触发入口 + 结果可视化）。
 *
 * ★ 核心设计：**冲突必须显眼**。冲突是专家团最有价值的信息，
 *   不能埋在列表里。「defer（待作者裁决）」项要有明确的拍板入口。
 *
 * ★ 只通过 window.mz.expert.* 通信，不引用主进程代码。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText, hasBridge } from '../../hooks/use-mz-bridge';
import type { ExpertStage } from '@shared/types/ipc';
import styles from './ExpertPanel.module.css';

interface RoleInfo {
  key: string;
  displayName: string;
  mission: string;
  defaultWeight: number;
}

interface Verdict {
  dimension: string;
  decision: 'accept' | 'reject' | 'defer';
  suggestion: string;
  confidence: number;
  opinions: {
    role: string;
    severity: string;
    verdict: string;
    evidence: string;
    suggestion: string;
    crossBoundary?: boolean;
    effectiveWeight?: number;
  }[];
  conflict?: { description: string; parties: string[]; ruleLabel: string };
}

interface ReviewReport {
  stage: ExpertStage;
  verdicts: Verdict[];
  summary: { critical: number; major: number; minor: number; needAuthor: number; conflicted: number };
  narration: string;
}

const STAGE_LABEL: Record<ExpertStage, string> = {
  outline: '大纲评审',
  chapter: '章节评审',
  'post-polish': '润色后复检',
};

const DEFAULT_ROLES: Record<ExpertStage, string[]> = {
  outline: ['structure', 'genre'],
  chapter: ['structure', 'character', 'dialogue', 'prose', 'reader', 'genre'],
  'post-polish': ['prose', 'reader'],
};

const ROLE_NAME: Record<string, string> = {
  structure: '结构师',
  character: '人物塑造师',
  dialogue: '对白作家',
  prose: '文字编辑',
  reader: '读者代表',
  genre: '类型守门人',
};

export function ExpertPanel(): JSX.Element {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [stage, setStage] = useState<ExpertStage>('chapter');
  const [picked, setPicked] = useState<string[]>(DEFAULT_ROLES.chapter);
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ role: string; reason: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, 'accept' | 'reject'>>({});

  useEffect(() => {
    if (!hasBridge()) return; // preload 缺失时同步 throw 会逃出 promise 链，必须先守卫
    void bridge()
      ?.expert.roles()
      .then((r) => setRoles(r as RoleInfo[]))
      .catch(() => undefined);
  }, []);

  const onStage = useCallback((s: ExpertStage) => {
    setStage(s);
    setPicked(DEFAULT_ROLES[s]); // 换阶段时重置为该阶段默认角色组合
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setReport(null);
    setFailures([]);
    setDecided({});
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      // 评审对象：当前项目的全部章节（可后续接入选中章节）
      const chapters = await api.chapter.list();
      const ids = chapters.slice(0, 5).map((c) => c.id);
      if (ids.length === 0) throw new Error('项目中没有章节');
      const res = await api.expert.review(stage, ids, picked);
      setReport(res.report as ReviewReport);
      setReviewId(res.reviewId);
      setFailures(res.failures as { role: string; reason: string }[]);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [stage, picked]);

  /** 作者对 defer 项拍板 */
  const decide = useCallback(
    async (dimension: string, decision: 'accept' | 'reject') => {
      if (!reviewId) return;
      try {
        await bridge()?.expert.decide(reviewId, dimension, decision);
        setDecided((d) => ({ ...d, [dimension]: decision }));
      } catch (e) {
        setErr(errorText(e));
      }
    },
    [reviewId],
  );

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>专家团评审</span>
        <button className={styles.btnPrimary} disabled={busy} onClick={() => void run()}>
          {busy ? '评审中…' : '开始评审'}
        </button>
      </div>

      {/* 阶段选择 */}
      <div className={styles.row}>
        {(Object.keys(STAGE_LABEL) as ExpertStage[]).map((s) => (
          <button
            key={s}
            className={`${styles.chip} ${stage === s ? styles.chipOn : ''}`}
            onClick={() => onStage(s)}
          >
            {STAGE_LABEL[s]}
          </button>
        ))}
      </div>

      {/* 角色多选（按需加载的可见化：选几个就跑几个） */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          激活专家（{picked.length}/{roles.length}，未勾选的不参与、不产生费用）
        </div>
        <div className={styles.row}>
          {roles.map((r) => (
            <button
              key={r.key}
              className={`${styles.chip} ${picked.includes(r.key) ? styles.chipOn : ''}`}
              onClick={() =>
                setPicked((p) =>
                  p.includes(r.key) ? p.filter((x) => x !== r.key) : [...p, r.key],
                )
              }
              title={r.mission}
            >
              {r.displayName}
            </button>
          ))}
        </div>
      </div>

      {err && <p className={styles.err}>{err}</p>}

      {failures.length > 0 && (
        <p className={styles.warn}>
          以下专家未完成评审，意见不完整：
          {failures.map((f) => `${ROLE_NAME[f.role] ?? f.role}（${f.reason}）`).join('、')}
        </p>
      )}

      {report && (
        <>
          {/* 汇总 */}
          <div className={styles.section}>
            <div className={styles.summary}>
              <span>严重 {report.summary.critical}</span>
              <span>待改 {report.summary.major}</span>
              <span className={report.summary.conflicted > 0 ? styles.hot : ''}>
                冲突 {report.summary.conflicted}
              </span>
              <span className={report.summary.needAuthor > 0 ? styles.hot : ''}>
                待你裁决 {report.summary.needAuthor}
              </span>
            </div>
          </div>

          {/* 裁决结果 */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>评审结论</div>
            <div className={styles.list}>
              {report.verdicts.map((v) => (
                <div
                  key={v.dimension}
                  className={`${styles.card} ${v.conflict ? styles.cardConflict : ''}`}
                >
                  <div className={styles.cardHead}>
                    <span className={styles.dimTag}>{v.dimension}</span>
                    {v.conflict && <span className={styles.conflictTag}>冲突 · {v.conflict.ruleLabel}</span>}
                    <span className={styles.decisionTag}>{v.decision}</span>
                    <span className={styles.conf}>{(v.confidence * 100).toFixed(0)}%</span>
                  </div>

                  {/* ★ 冲突双方都摆出来，这是最有价值的信息 */}
                  {v.conflict && (
                    <div className={styles.conflictBody}>
                      {v.opinions.map((o, i) => (
                        <div key={i} className={styles.opinion}>
                          <b>{ROLE_NAME[o.role] ?? o.role}</b>
                          <span className={styles.sev}>({o.severity})</span>
                          {o.crossBoundary && (
                            <span className={styles.cross}>越界·已降权</span>
                          )}
                          <div className={styles.opText}>{o.suggestion}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {!v.conflict && v.suggestion && (
                    <div className={styles.suggestion}>{v.suggestion}</div>
                  )}

                  {/* defer 项：作者拍板入口 */}
                  {v.decision === 'defer' && (
                    <div className={styles.decideRow}>
                      {decided[v.dimension] ? (
                        <span className={styles.decided}>
                          已裁决：{decided[v.dimension] === 'accept' ? '采纳' : '不采纳'}
                        </span>
                      ) : (
                        <>
                          <span className={styles.needYou}>需你判断：</span>
                          <button
                            className={styles.chip}
                            onClick={() => void decide(v.dimension, 'accept')}
                          >
                            采纳建议
                          </button>
                          <button
                            className={styles.chip}
                            onClick={() => void decide(v.dimension, 'reject')}
                          >
                            保持原样
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {report.verdicts.length === 0 && (
                <p className={styles.note}>本次评审没有产出维度结论。</p>
              )}
            </div>
          </div>
        </>
      )}

      <p className={styles.note}>
        专家只出意见、不改稿。要采纳哪些由你决定——意见冲突处正是最有价值的信息。
      </p>
    </div>
  );
}
