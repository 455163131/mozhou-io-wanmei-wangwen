/**
 * AI 味检测面板（独立板块入口）。
 *
 * ★ 与「体检」「Agent」并列，但**零耦合**：只通过 window.mz.aiFlavor.* 通信，
 *   不引用任何 health/* 或 expert/* 的代码。删掉本文件不影响其他板块。
 *
 * ★ 呈现原则（朱雀调研的结论）：**给事实，不给判决**。
 *   不写「你有 87% 是 AI」，而是写「第 3 段句长集中在 22–26 字」「逗号/句号比 4.2」。
 *   所有结论都必须能对回命中片段，用户可自行核对。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText, hasBridge } from '../../hooks/use-mz-bridge';
import type {
  FlavorScanResult,
  FlavorBaselineInfo,
  FlavorRebuildResult,
} from '@shared/types/ipc';
import styles from './FlavorPanel.module.css';

type RewritePath = 'auto-rule' | 'agent';

interface RewriteState {
  changedCount: number;
  beforeIndex: number;
  afterIndex: number;
  delta: number;
  newText: string;
  edits: { from: string; to: string; offset: number; why: string }[];
  rejected: { offset: number; reason: string }[];
  agentHandoff: { count: number; offsets: number[] };
  runId?: string;
  message: string;
}

const LEVEL_LABEL: Record<string, string> = {
  clean: '干净',
  mild: '轻微',
  suspicious: '可疑',
  heavy: '偏重',
  severe: '严重',
};

export function FlavorPanel(): JSX.Element {
  const [report, setReport] = useState<FlavorScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [about, setAbout] = useState<{ disclaimer: string; engineVersion: string } | null>(null);
  const [rewrite, setRewrite] = useState<RewriteState | null>(null);
  const [selectedPara, setSelectedPara] = useState<number | null>(null);
  /** 当前生效基线的摘要（T04：让用户知道「这份分数基于谁的标准」） */
  const [binfo, setBinfo] = useState<FlavorBaselineInfo | null>(null);
  const [reb, setReb] = useState<FlavorRebuildResult | null>(null);
  const [rebBusy, setRebBusy] = useState(false);

  useEffect(() => {
    if (!hasBridge()) return; // preload 缺失时同步 throw 会逃出 promise 链，必须先守卫
    void bridge()
      ?.aiFlavor.about()
      .then(setAbout)
      .catch(() => undefined);
  }, []);

  /** 拉取当前生效基线摘要。基线信息缺失不阻断主流程（静默忽略）。 */
  const loadBaseline = useCallback(async () => {
    try {
      const info = await bridge()?.aiFlavor.baseline();
      if (info) setBinfo(info);
    } catch {
      /* 基线信息拿不到就不显示来源栏，不影响检测 */
    }
  }, []);

  const scan = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setRewrite(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const res = await api.aiFlavor.scan();
      // 面板聚焦当前章：取第一章/唯一一章的结果
      setReport(res[0] ?? null);
      if (res.length === 0) setErr('项目中没有章节可检测');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * 用当前项目语料重建用户基线。
   * ★ 重建成功后自动重扫一次——基线变了，旧分数就不可比，必须让用户立刻看到新基线下的分数。
   */
  const rebuild = useCallback(async () => {
    setRebBusy(true);
    setErr(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const res = await api.aiFlavor.rebuildBaseline();
      setReb(res);
      await loadBaseline();
      if (res.saved) await scan();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setRebBusy(false);
    }
  }, [loadBaseline, scan]);

  const doRewrite = useCallback(
    async (path: RewritePath) => {
      if (!report) return;
      setBusy(true);
      setErr(null);
      try {
        const api = bridge();
        if (!api) throw new Error('未连接到主进程');
        const res = (await api.aiFlavor.rewrite({
          chapterId: report.chapterId,
          path,
          dryRun: path === 'agent', // agent 路径不落盘，只派活
          paragraphNos: selectedPara ? [selectedPara] : undefined,
        })) as RewriteState;
        setRewrite(res);
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [report, selectedPara],
  );

  /** 基线来源栏（T04）：一眼可辨「这份分数基于谁的标准」。三态：内置 / 你的 / 陈旧 */
  const baselineBar = binfo ? (
    <div
      className={`${styles.baselineBar} ${
        binfo.stale
          ? styles.baselineStale
          : binfo.source === 'user'
            ? styles.baselineUser
            : ''
      }`}
    >
      <div className={styles.baselineRow}>
        <span className={styles.baselineTag}>
          {binfo.source === 'user' ? '你的语料' : '内置示例基线'}
        </span>
        <span className={styles.baselineText}>
          {binfo.corpus} · {binfo.chapters} 章
        </span>
        <button className={styles.link} disabled={rebBusy} onClick={() => void rebuild()}>
          {rebBusy ? '重建中…' : '用本项目重建'}
        </button>
      </div>
      {binfo.stale && (
        <div className={styles.baselineWarn}>
          当前基线由旧口径（特征版本 {binfo.engineVersion}）生成，建议重建以保证可比。
        </div>
      )}
      {reb && (
        <div className={styles.rebResult}>
          {reb.saved
            ? `已用你的语料重建基线：${reb.used} 章参与${
                reb.skipped > 0 ? `，${reb.skipped} 章因字数不足跳过` : ''
              }。已按新基线重新检测。`
            : `有效章数 ${reb.used}，不足 10 章，未启用你的基线（仍用内置示例基线）。`}
          {reb.warnings.length > 0 && (
            <div className={styles.rebWarn}>{reb.warnings.join('；')}</div>
          )}
        </div>
      )}
    </div>
  ) : null;

  if (!report) {
    return (
      <div className={styles.root}>
        <div className={styles.head}>
          <span className={styles.title}>AI 味检测</span>
          <button className={styles.btn} disabled={busy} onClick={() => void scan()}>
            {busy ? '检测中…' : '开始检测'}
          </button>
        </div>
        {baselineBar}
        {about && <p className={styles.note}>{about.disclaimer}</p>}
        {err && <p className={styles.err}>{err}</p>}
      </div>
    );
  }

  /** 参与总评的全部维度（含得分为 0 的——正常带可视化对它们同样有意义） */
  const active = report.dimensions.filter((d) => !d.skipped);
  const badParas = report.paragraphs_.filter((p) => p.hitCount > 0);

  /** 置信度（设计 §5.3）：样本充分性 × 已校准占比 × 陈旧惩罚 */
  const confLevel = (() => {
    if (!report.sufficient) return '低';
    const p = (report.calibratedRatio ?? 1) * (report.baselineStale ? 0.7 : 1);
    return p >= 0.85 ? '高' : p >= 0.5 ? '中' : '低';
  })();

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>AI 味检测</span>
        <button className={styles.btn} disabled={busy} onClick={() => void scan()}>
          {busy ? '…' : '重新检测'}
        </button>
      </div>

      {baselineBar}

      {/* 总分 */}
      <div className={`${styles.scoreBox} ${styles['lv-' + report.level]}`}>
        <div className={styles.scoreNum}>{report.index}</div>
        <div className={styles.scoreMeta}>
          <div>
            总指数 · <b>{LEVEL_LABEL[report.level] ?? report.level}</b>
          </div>
          <div className={styles.dim}>
            {report.chars} 字 / {report.paragraphs} 段 / {report.hits.length} 处命中
          </div>
          <div className={styles.dim}>
            主导问题：{report.dominantDimension ?? '—'}
          </div>
          <div className={styles.dim}>
            置信度：<b>{confLevel}</b>（已校准维度占{' '}
            {Math.round((report.calibratedRatio ?? 1) * 100)}%）
          </div>
        </div>
      </div>

      {!report.sufficient && (
        <p className={styles.warn}>{report.insufficientReason}</p>
      )}

      {/* 维度得分（正常带可视化：一眼可辨「实测落在你自己的正常范围内还是外」） */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>维度得分（点击可只看这一段）</div>
        {active.map((d) => {
          // 正常带几何：[p05, p95] 高亮带 + measured 竖线标记。
          // 零膨胀维度（band 为 null）没有「正常带」概念（人写恒为 0），
          // 走计数口径、由 note 呈现「出现 N 处｜约 N 次/章才算显著」。
          const band = d.band ?? null;
          const measured = d.measured ?? 0;
          const scaleMax = band ? Math.max(band[1], measured) * 1.15 || 1 : 0;
          const pct = (v: number) =>
            Math.max(0, Math.min(100, scaleMax > 0 ? (v / scaleMax) * 100 : 0));
          const g = band
            ? {
                left: pct(band[0]),
                width: Math.max(0, pct(band[1]) - pct(band[0])),
                marker: pct(measured),
              }
            : null;
          const uncal = d.calibrated === false;
          return (
            <div key={d.dimension} className={styles.dimRow}>
              <span className={styles.dimName}>
                {d.dimension}
                {uncal && (
                  <span
                    className={styles.uncal}
                    title='该维度未用你的语料校准（样本不足或基线回退）'
                  >
                    未校准
                  </span>
                )}
              </span>
              {g ? (
                <span className={styles.barWrap}>
                  <span className={styles.track}>
                    <span
                      className={styles.band}
                      style={{ left: `${g.left}%`, width: `${g.width}%` }}
                    />
                    <span
                      className={`${styles.marker} ${styles['lv-' + d.level]}`}
                      style={{ left: `${g.marker}%` }}
                    />
                  </span>
                </span>
              ) : (
                <span className={styles.barWrap}>
                  <span
                    className={`${styles.bar} ${styles['lv-' + d.level]}`}
                    style={{ width: `${Math.min(100, d.score)}%` }}
                  />
                </span>
              )}
              <span className={styles.dimScore}>{d.score}</span>
              <div className={styles.dimNote}>
                {band
                  ? `实测 ${measured}｜你的正常范围 [${band[0]}, ${band[1]}]｜偏离 ${
                      d.deviation ?? 0
                    } 个带宽`
                  : d.note}
                {uncal && '（未校准：按内置示例基线判定）'}
              </div>
            </div>
          );
        })}
        {active.length === 0 && <p className={styles.note}>各维度均未发现问题。</p>}
      </div>

      {/* 问题段落 */}
      {badParas.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            问题段落（{badParas.length}/{report.paragraphs}）
          </div>
          <div className={styles.paraList}>
            {badParas.slice(0, 24).map((p) => (
              <button
                key={p.no}
                className={`${styles.paraChip} ${selectedPara === p.no ? styles.paraOn : ''}`}
                onClick={() => setSelectedPara(selectedPara === p.no ? null : p.no)}
                title={`${p.hitCount} 处命中，主要问题：${p.topDimension ?? '—'}`}
              >
                第{p.no}段 · {p.score}
              </button>
            ))}
          </div>
          {selectedPara && (
            <p className={styles.note}>
              已选中第 {selectedPara} 段，改写将只作用于这一段。
              <button className={styles.link} onClick={() => setSelectedPara(null)}>
                取消选择
              </button>
            </p>
          )}
        </div>
      )}

      {/* 命中清单：每处都有原因和改法 */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>命中片段（{report.hits.length}）</div>
        <div className={styles.hitList}>
          {report.hits.slice(0, 60).map((h, i) => (
            <div key={`${h.offset}-${i}`} className={styles.hit}>
              <div className={styles.hitHead}>
                <span className={`${styles.tag} ${styles['lv-' + h.level]}`}>{h.kind}</span>
                <span className={styles.hitPara}>第{h.paragraphNo}段</span>
              </div>
              {h.excerpt && <div className={styles.excerpt}>{h.excerpt}</div>}
              <div className={styles.reason}>{h.reason}</div>
              <div className={styles.advice}>→ {h.advice}</div>
            </div>
          ))}
          {report.hits.length === 0 && <p className={styles.note}>未发现命中片段。</p>}
        </div>
      </div>

      {/* 两条改写路径 */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>改写（两条路径，只做局部重写）</div>
        <div className={styles.actions}>
          <button
            className={styles.btnPrimary}
            disabled={busy || report.hits.length === 0}
            onClick={() => void doRewrite('auto-rule')}
          >
            一键自动改写（本地规则）
          </button>
          <button
            className={styles.btn}
            disabled={busy || report.hits.length === 0}
            onClick={() => void doRewrite('agent')}
          >
            交给主 Agent 重写
          </button>
        </div>
        <p className={styles.note}>
          自动改写不调用模型、可离线；遇到需要理解上下文的片段会明确列出并建议交给 Agent。
        </p>
      </div>

      {/* 改写结果：前后分对比 */}
      {rewrite && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>改写结果</div>
          <div className={styles.compare}>
            <span>{rewrite.beforeIndex}</span>
            <span className={styles.arrow}>→</span>
            <span className={rewrite.delta >= 0 ? styles.down : styles.up}>
              {rewrite.afterIndex}
            </span>
            <span className={styles.delta}>
              {rewrite.delta >= 0 ? `↓${rewrite.delta}` : `↑${-rewrite.delta}`}
            </span>
          </div>
          <p className={styles.note}>{rewrite.message}</p>
          {rewrite.edits.length > 0 && (
            <div className={styles.hitList}>
              {rewrite.edits.slice(0, 20).map((e, i) => (
                <div key={i} className={styles.hit}>
                  <div className={styles.excerpt}>
                    「{e.from}」→「{e.to || '（删除）'}」
                  </div>
                  <div className={styles.advice}>→ {e.why}</div>
                </div>
              ))}
            </div>
          )}
          {rewrite.rejected.length > 0 && (
            <p className={styles.note}>
              {rewrite.rejected.length} 处被安全护栏拦下（改动会破坏句子），已转交 Agent 路径。
            </p>
          )}
          {rewrite.agentHandoff.count > 0 && (
            <p className={styles.note}>
              另有 {rewrite.agentHandoff.count} 处需要 AI 介入
              {rewrite.runId ? `（已派给 run ${rewrite.runId}）` : ''}。
            </p>
          )}
        </div>
      )}

      {about && <p className={styles.disclaimer}>{about.disclaimer}</p>}
      {err && <p className={styles.err}>{err}</p>}
    </div>
  );
}
