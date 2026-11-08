/**
 * 拆书报告页（mode: teardown，P2-C T5）。
 *
 * 两段式，账目分开：
 *   ① 「结构统计（秒出·零token）」：主进程复用 digest 蒸馏 + metrics-engine 统计，
 *      纯计算不调模型——点一下即出 bench/节拍/钩子样例/人物粗提并落报告库。
 *   ② 「AI 精读八维（按需）」：真花 token 的一步，由作者自己点；无 Key/产出坏
 *      如实回落演示兜底，徽标「演示」+ 未精读维度逐条标「演示·未精读」，
 *      绝不冒充模型精读（DRD §7 诚实纪律，同抽脑洞/扫榜的兜底明示）。
 *   每维「存入灵感库」→ kind='teardown' 摘要卡（回卡自带 id，收藏/套用走既有通道）。
 *
 * ★ 取文两条路都只读：粘贴 textarea，或「载入当前项目正文」走 chapter.list /
 *   chapter.get 既有**只读**通道——本页永不写正文（body 写只住 ChapterRepo.updateBody，
 *   这里不碰）。
 * ★ 全局子系统：拆书报告不键 project，进页不自动跑（结构统计虽免费，也等作者给文）。
 *
 * 异步纪律（I-1 同族）：结构统计/精读/取正文各持一条 sequencer（lib/sequenced），
 *   每个 await 回来先判 isCurrent，旧响应后到不许盖新状态。
 * ★ 会话守卫（T3/T4 评审先例）：同一维「存入灵感库」点了即置「已存入」，
 *   pending 期间全维按钮禁用——同报告同维双击会落重复卡。
 */
import { useCallback, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { TEARDOWN_DEMO_MARK } from '@shared/types/inspiration';
import type { TeardownDims, TeardownStructure } from '@shared/types/inspiration';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './TeardownView.module.css';

/** 八维固定维序（与 TeardownDimsSchema 键序、teardown-service TEARDOWN_DIMENSIONS 同集合） */
const DIM_KEYS: (keyof TeardownDims)[] = ['定位', '结构', '节奏', '爽点钩子', '伏笔', '人物', '文风', '可借鉴'];

/** 载入当前项目正文的章数上限（拆书统计取样足够，又不至于拖垮大书） */
const IMPORT_CHAPTER_CAP = 50;

export function TeardownView(): JSX.Element {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [report, setReport] = useState<{ reportId: string; structure: TeardownStructure } | null>(null);
  const [read, setRead] = useState<{ dims: TeardownDims; source: 'live' | 'demo' } | null>(null);
  const [busyStruct, setBusyStruct] = useState(false);
  const [busyRead, setBusyRead] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在保存的维度（禁用全部维按钮防连点）；本会话已存入的维度集（防落重复卡） */
  const [savingDim, setSavingDim] = useState<string | null>(null);
  const [savedDims, setSavedDims] = useState<Set<string>>(new Set());

  const structSeqRef = useRef(createSequencer());
  const readSeqRef = useRef(createSequencer());
  const importSeqRef = useRef(createSequencer());

  /** 只读取文：chapter.list + chapter.get 既有只读通道，绝不写正文。 */
  const loadChapters = useCallback(async () => {
    const seq = importSeqRef.current.next();
    setBusyImport(true);
    setErr(null);
    setNotice(null);
    try {
      const metas = await bridge().chapter.list();
      if (!importSeqRef.current.isCurrent(seq)) return;
      const picked = metas.slice(0, IMPORT_CHAPTER_CAP);
      if (picked.length === 0) {
        setErr('当前项目没有章节：先在写作坊导入或新建章节，再取正文拆书。');
        return;
      }
      const chunks: string[] = [];
      for (const m of picked) {
        const ch = await bridge().chapter.get(m.id);
        if (!importSeqRef.current.isCurrent(seq)) return;
        chunks.push(`${m.title || `第${m.id}章`}\n${ch.body}`);
      }
      setText(chunks.join('\n'));
      setNotice(
        metas.length > picked.length
          ? `已取入前 ${picked.length} 章正文（共 ${metas.length} 章，只读未改动）——拆书取样足够，如需更多请分段粘贴。`
          : `已取入全部 ${picked.length} 章正文（只读，未改动任何章节）。`,
      );
    } catch (e) {
      if (importSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (importSeqRef.current.isCurrent(seq)) setBusyImport(false);
    }
  }, []);

  /** ① 结构统计：零 token，秒出。 */
  const runStructure = useCallback(async () => {
    const seq = structSeqRef.current.next();
    setBusyStruct(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await bridge().teardown.structure(title, text);
      if (!structSeqRef.current.isCurrent(seq)) return;
      setReport(r);
      setRead(null);
      setSavedDims(new Set());
      setNotice('结构统计完成——纯计算零 token，未调用模型。');
    } catch (e) {
      if (structSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (structSeqRef.current.isCurrent(seq)) setBusyStruct(false);
    }
  }, [title, text]);

  /** ② 八维精读：按需 LLM；失败如实演示兜底（source='demo'）。 */
  const runRead = useCallback(async () => {
    if (!report) return;
    const seq = readSeqRef.current.next();
    setBusyRead(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await bridge().teardown.read(report.reportId);
      if (!readSeqRef.current.isCurrent(seq)) return;
      setRead(r);
      setSavedDims(new Set());
      if (r.source === 'demo') setNotice('八维走了演示兜底（未配置模型或产出未过契约）——配置 API Key 后重点即得实时精读。');
    } catch (e) {
      if (readSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (readSeqRef.current.isCurrent(seq)) setBusyRead(false);
    }
  }, [report]);

  /** 一维存灵感库：同维本会话只许存一次（防重复卡）。 */
  async function saveDim(dimension: keyof TeardownDims): Promise<void> {
    if (!report || savingDim || savedDims.has(dimension)) return;
    setSavingDim(dimension);
    setErr(null);
    setNotice(null);
    try {
      const card = await bridge().teardown.saveDimension(report.reportId, dimension);
      setSavedDims((s) => new Set(s).add(dimension));
      setNotice(`已存入灵感库：「${card.title}」`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSavingDim(null);
    }
  }

  const s = report?.structure ?? null;
  const stats: { k: string; v: string }[] = [];
  if (s) {
    stats.push({ k: '字数', v: String(s.analyze.chars) });
    stats.push({ k: '段落', v: String(s.analyze.paras) });
    stats.push({ k: '句子', v: String(s.analyze.sents) });
    stats.push({ k: '平均句长', v: `${s.analyze.avgSent.toFixed(1)} 字` });
    stats.push({ k: '对白占比', v: `${(s.analyze.dialogRatio * 100).toFixed(1)}%` });
    stats.push({ k: '起笔类型', v: s.analyze.openType || '不可判' });
    if (s.bench) {
      stats.push({ k: '每段句数', v: s.bench.sentsPerPara.toFixed(2) });
      stats.push({ k: '句长变异', v: s.bench.sentCv.toFixed(3) });
      stats.push({ k: 'TTR', v: s.bench.ttr.toFixed(4) });
      stats.push({ k: '3-gram 重复', v: `${(s.bench.triRepeat * 100).toFixed(1)}%` });
    }
    if (s.struct) {
      stats.push({ k: '段长节拍', v: s.struct.chapterLenPattern });
      stats.push({ k: '钩子密度', v: `${s.struct.hookDensity.toFixed(2)} 处/段` });
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.teardown}</span>
        <span className={styles.sub}>粘贴范文或取当前项目正文（只读） · 结构统计秒出零 token · 八维精读按需</span>
        <span className={styles.spacer} />
        {read && (
          <span className={read.source === 'live' ? styles.badgeLive : styles.badgeDemo}>
            {read.source === 'live' ? '实时' : TEARDOWN_DEMO_MARK}
          </span>
        )}
      </div>

      <div className={styles.form}>
        <input
          className={styles.bookTitle}
          value={title}
          placeholder="范文名（留空按「未命名范文」入库）"
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className={styles.paste}
          value={text}
          rows={8}
          placeholder="把要拆的范文正文粘贴进来（或点下方「载入当前项目正文」走只读取文）"
          onChange={(e) => setText(e.target.value)}
        />
        <div className={styles.ops}>
          <button className={styles.btn} disabled={busyImport} onClick={() => void loadChapters()}>
            {busyImport ? '取文中…' : '载入当前项目正文（只读）'}
          </button>
          <button
            className={styles.btnPrimary}
            disabled={busyStruct || text.trim().length === 0}
            onClick={() => void runStructure()}
          >
            {busyStruct ? '统计中…' : '结构统计（秒出 · 零token）'}
          </button>
          <button
            className={styles.btnPrimary}
            disabled={!report || busyRead || busyStruct}
            onClick={() => void runRead()}
          >
            {busyRead ? '精读中…' : 'AI 精读八维（按需）'}
          </button>
        </div>
      </div>

      {err && <p className={styles.err}>{err}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      {!report && (
        <p className={styles.empty}>
          尚无拆书报告——给范文起个名、贴上正文，点「结构统计（秒出·零token）」。结构统计全程纯计算不调模型；
          「AI 精读八维」才花 token，可不点。取正文只走只读通道，绝不改动任何章节。
        </p>
      )}

      {s && (
        <section className={styles.section}>
          <h3 className={styles.sectionHead}>结构统计（零 token 复用 digest + metrics）</h3>
          <div className={styles.statGrid}>
            {stats.map((x) => (
              <div key={x.k} className={styles.stat}>
                <span className={styles.statKey}>{x.k}</span>
                <span className={styles.statVal}>{x.v}</span>
              </div>
            ))}
          </div>
          {s.hooks.length > 0 && (
            <>
              <h4 className={styles.subHead}>钩子样例（引文 ≤16 字，LCS 合规守卫在上游）</h4>
              <ul className={styles.hookList}>
                {s.hooks.slice(0, 8).map((h, i) => (
                  <li key={`${h.chapterId}-${i}`} className={styles.hook}>
                    「{h.quote}」<span className={styles.hookKind}>{h.kind}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {s.roles.length > 0 && (
            <>
              <h4 className={styles.subHead}>人物粗提（频次推断，可信度低于统计）</h4>
              <div className={styles.roleList}>
                {s.roles.slice(0, 8).map((r) => (
                  <span key={r.name} className={styles.role}>
                    {r.name} ×{r.mentions}
                  </span>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {read && (
        <section className={styles.section}>
          <h3 className={styles.sectionHead}>八维精读（{read.source === 'live' ? '模型产出' : '演示兜底'}）</h3>
          {read.source === 'demo' && (
            <p className={styles.fallbackNote}>
              本次未走模型：统计可确定的维度如实给统计句，其余维度标「演示·未精读」——配置 API Key 后重点「AI 精读八维」即得实时拆解。
            </p>
          )}
          <div className={styles.dimGrid}>
            {DIM_KEYS.map((d) => (
              <article key={d} className={styles.dimCard}>
                <div className={styles.dimHead}>
                  <span className={styles.dimName}>{d}</span>
                  {read.source === 'demo' && <span className={styles.dimDemoTag}>{TEARDOWN_DEMO_MARK}</span>}
                </div>
                <p className={styles.dimText}>{read.dims[d]}</p>
                <div className={styles.dimOps}>
                  <button
                    className={styles.btn}
                    disabled={!!savingDim || savedDims.has(d)}
                    onClick={() => void saveDim(d)}
                  >
                    {savedDims.has(d) ? '已存入' : savingDim === d ? '存入中…' : '存入灵感库'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
