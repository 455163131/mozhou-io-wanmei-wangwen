/**
 * 导出中心页（mode: export，P2-D T5）。
 *
 * 数据面（全部复用 T3 三通道，一页一条也不新开）：
 *   · 导出：`exportArtifact(req)` → {path, bytes}；成败都落主进程历史（T3 语义），
 *     本页拿到的 err 就是真因，如实上屏不粉饰。
 *   · 预览：`exportPreview(req)`——**真字节**：预览与同参导出走同一构建函数，
 *     字节逐字相等（T2/T3 单点构建纪律），只读不落盘、不入历史。
 *   · 历史：`exportHistory(50)`——每次导出成功后随 load 链重取，表新在前。
 *   · 范围取数：分卷走 `project.volumes()`（load 链）；自选章列表来自 store
 *     chapters（openProject/bootstrap 已灌好，本页不重取、也永不写正文）。
 *   dest 口径：本页固定 `dest:'project'`（写项目根，★2）——'external'（文档目录根）
 *   按 ★4「永不自动」纪律不做默认路径，spec 要素清单里也没有 dest 选择器。
 *
 * ★ 按项目作用域（P2D-R3 controller 裁决，ForeshadowView R13 口径）：导出面向成书
 *   正文——本页键 project?.id；未打开项目显「未打开项目——导出面向成书正文，请先开一本」
 *   诚实空态，一条 bridge 都不发。
 *
 * 竞态纪律（P2-C 修复波口径，I-1 同族）：一条 load 链（初始 volumes+history、
 *   导出成功后的历史重取都走它）+ 一条 action 链（预览/导出互斥），每个 await
 *   回来都判 isCurrent——包括 catch 与 finally。action pending 期间两个按钮全禁；
 *   任何配置输入的改动都给 action 链 bump next()——按旧范围构建的「预览真字节」
 *   结果不许在范围/格式变更后续命，在途响应落地即作废（导出文件本身已由主进程
 *   落盘并入历史，刷新即可见，页面不撤不回写）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { useProjectStore } from '../../store';
import type { Volume } from '@shared/types/project';
import type {
  ExportFormat,
  ExportHistoryRow,
  ExportPreviewRes,
  ExportRunReq,
  ExportScope,
} from '@shared/types/export';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './ExportView.module.css';

/** 历史表一次拉 50 条（brief 口径 exportHistory(50)；主进程上限 200，这里用不到） */
const HISTORY_LIMIT = 50;

/** 格式五选（与 ExportFormat 联合逐字同集合同序） */
const FORMATS: ExportFormat[] = ['txt', 'md', 'epub', 'docx', 'zip'];

type ScopeKind = 'book' | 'volume' | 'chapters';
const SCOPE_TABS: Array<{ id: ScopeKind; label: string }> = [
  { id: 'book', label: '全书' },
  { id: 'volume', label: '分卷' },
  { id: 'chapters', label: '自选章' },
];

/** 千分位字节数（导出/预览/历史三处同一口径） */
function bytesText(n: number): string {
  return n.toLocaleString();
}

/**
 * ExportScope → 中文一句话（纯本地函数，历史表与状态行共用；不另开取数）。
 * 卷已删（历史里的 volumeId 不在当前 volumes）时如实标「已删除」，不拿 id 冒充标题。
 */
function scopeLabel(scope: ExportScope, volumes: Volume[]): string {
  if (scope.kind === 'book') return '全书';
  if (scope.kind === 'volume') {
    const v = volumes.find((x) => x.id === scope.volumeId);
    return v ? `卷「${v.title}」` : '卷（已删除）';
  }
  return `自选 ${scope.chapterIds.length} 章`;
}

export function ExportView(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const chapters = useProjectStore((s) => s.chapters);

  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [history, setHistory] = useState<ExportHistoryRow[]>([]);
  const [scopeKind, setScopeKind] = useState<ScopeKind>('book');
  const [volumeId, setVolumeId] = useState('');
  const [chapterIds, setChapterIds] = useState<string[]>([]);
  const [format, setFormat] = useState<ExportFormat>('txt');
  const [baseName, setBaseName] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExportPreviewRes | null>(null);

  const loadSeqRef = useRef(createSequencer());
  const actionSeqRef = useRef(createSequencer());

  /** load 链①：卷清单 + 历史（初始各一次）。两个 await 之间也判序，旧书迟到的
   *  volumes 不许盖新书的（换书时链已 bump）。 */
  const load = useCallback(async () => {
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    try {
      const vols = await bridge().project.volumes();
      if (!loadSeqRef.current.isCurrent(seq)) return;
      const hist = await bridge().exportHistory(HISTORY_LIMIT);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setVolumes(vols);
      setHistory(hist);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, []);

  /** load 链②：导出成功后的历史重取——与初始 load 共用一条链（P2-C 口径）。 */
  const reloadHistory = useCallback(async () => {
    const seq = loadSeqRef.current.next();
    try {
      const hist = await bridge().exportHistory(HISTORY_LIMIT);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setHistory(hist);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    }
  }, []);

  /** 配置变更的统一入口：在途 preview/export 的响应落地即作废，预览面板即刻清空
   *  （见文件头竞态纪律）。actionBusy 一并释放：被作废的那次动作不再占用按钮。 */
  const invalidateAction = useCallback(() => {
    actionSeqRef.current.next();
    setPreview(null);
    setActionBusy(false);
  }, []);

  const pid = project?.id ?? null;

  useEffect(() => {
    // ★ R13 同款切换守卫（ForeshadowView 口径）：openProject 原地换 project+chapters、
    //   modeHost 不重挂载，本页只键 pid 不键 chapters——同一帧两路刷新，键两个会双载。
    //   换书＝旧书选择全清（旧书章 id 对新书无效）+ 卷/历史整链重取。
    invalidateAction();
    setVolumeId('');
    setChapterIds([]);
    setBaseName('');
    setNotice(null);
    if (pid) {
      void load();
    } else {
      // 未打开项目：不发明一条 bridge 调用；在途旧书响应 bump 即废。
      loadSeqRef.current.next();
      setBusy(false);
      setVolumes([]);
      setHistory([]);
      setErr(null);
    }
  }, [pid, load, invalidateAction]);

  /** 卷下拉的生效值：volumeId 失配（换书/卷被删）时回落首卷，不拿坏 id 发请求。 */
  const curVolId = volumes.some((v) => v.id === volumeId) ? volumeId : volumes[0]?.id ?? '';

  /** 当前配置解析出的有效范围；null＝「无有效范围」，两个动作按钮都禁用。 */
  function currentScope(): ExportScope | null {
    if (!project) return null;
    if (scopeKind === 'book') return { kind: 'book' };
    if (scopeKind === 'volume') return curVolId ? { kind: 'volume', volumeId: curVolId } : null;
    return chapterIds.length > 0 ? { kind: 'chapters', chapterIds } : null;
  }
  const scope = currentScope();

  async function run(kind: 'preview' | 'export'): Promise<void> {
    if (!project || !scope) return;
    const trimmed = baseName.trim();
    // req 在点击那一刻定格（含当时的 scope）——此后任何配置变更都只配作废它。
    const req: ExportRunReq = {
      format,
      scope,
      dest: 'project',
      ...(trimmed ? { baseName: trimmed } : {}),
    };
    const seq = actionSeqRef.current.next();
    setActionBusy(true);
    setErr(null);
    setNotice(null);
    try {
      if (kind === 'preview') {
        const p = await bridge().exportPreview(req);
        if (!actionSeqRef.current.isCurrent(seq)) return;
        setPreview(p);
      } else {
        const r = await bridge().exportArtifact(req);
        if (!actionSeqRef.current.isCurrent(seq)) return;
        setNotice(`已导出 ${r.path} · ${bytesText(r.bytes)} 字节`);
        await reloadHistory();
      }
    } catch (e) {
      // 失败显真因（E_NOT_FOUND / E_INVALID_ARGS / 磁盘错……），不写「导出失败」了事。
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (actionSeqRef.current.isCurrent(seq)) setActionBusy(false);
    }
  }

  // ── 配置变更入口（全部先作废在途动作，再落新值）──
  function pickScope(k: ScopeKind): void {
    invalidateAction();
    setScopeKind(k);
  }
  function pickFormat(f: ExportFormat): void {
    invalidateAction();
    setFormat(f);
  }
  function toggleChapter(id: string): void {
    invalidateAction();
    setChapterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const canRun = !!project && scope !== null && !busy && !actionBusy;
  const selSet = new Set(chapterIds);

  if (!project) {
    return (
      <div className={styles.wrap}>
        <div className={styles.head}>
          <span className={styles.title}>{MODE_LABELS.export}</span>
          <span className={styles.sub}>成书正文 · txt/md/epub/docx/zip · 预览即真字节</span>
        </div>
        <p className={styles.empty}>未打开项目——导出面向成书正文，请先开一本。</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.export}</span>
        <span className={styles.sub}>范围三级 × 格式五种 · 预览与导出字节逐字相等 · 历史成败都记</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy || actionBusy} onClick={() => void load()}>
          {busy ? '…' : '刷新'}
        </button>
        <button className={styles.btn} disabled={!canRun} onClick={() => void run('preview')}>
          {actionBusy ? '…' : '预览（真字节）'}
        </button>
        <button className={styles.btnPrimary} disabled={!canRun} onClick={() => void run('export')}>
          {actionBusy ? '导出中…' : '导出'}
        </button>
      </div>

      {err && <p className={styles.err}>{err}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>导出配置</h3>
          <span className={styles.sub}>
            当前范围：{scope ? scopeLabel(scope, volumes) : '无有效范围（按钮已禁用）'}
          </span>
        </div>

        <div className={styles.tabs}>
          {SCOPE_TABS.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${scopeKind === t.id ? styles.tabOn : ''}`}
              onClick={() => pickScope(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {scopeKind === 'volume' &&
          (volumes.length === 0 ? (
            <p className={styles.note}>
              这本书还没有分卷——先到「大纲管理」建卷；无卷可选时分卷范围导出不可用。
            </p>
          ) : (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>选择卷</span>
              <select
                value={curVolId}
                onChange={(e) => {
                  invalidateAction();
                  setVolumeId(e.target.value);
                }}
              >
                {volumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    第 {v.order} 卷 · {v.title}
                  </option>
                ))}
              </select>
            </label>
          ))}

        {scopeKind === 'chapters' &&
          (chapters.length === 0 ? (
            <p className={styles.note}>还没有章节——先到「写作坊」写好正文再来自选。</p>
          ) : (
            <div className={styles.chapterBox}>
              <span className={styles.note}>已选 {chapterIds.length} / {chapters.length} 章（按章序导出所选）</span>
              {chapters.map((c) => (
                <label key={c.id} className={styles.chapterRow}>
                  <input type="checkbox" checked={selSet.has(c.id)} onChange={() => toggleChapter(c.id)} />
                  <span>
                    第 {c.id} 章 · {c.title}
                  </span>
                </label>
              ))}
            </div>
          ))}

        <div className={styles.tabs}>
          {FORMATS.map((f) => (
            <button
              key={f}
              className={`${styles.tab} ${format === f ? styles.tabOn : ''}`}
              onClick={() => pickFormat(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>文件名（可选，留空＝书名）</span>
          <input
            value={baseName}
            onChange={(e) => {
              invalidateAction();
              setBaseName(e.target.value);
            }}
            placeholder={project.name}
            spellCheck={false}
          />
        </label>
      </section>

      {preview && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>预览（真字节）</h3>
            <span className={styles.sub}>
              {format} · {bytesText(preview.bytes)} 字节——与同参导出文件逐字相等，未落盘
            </span>
          </div>
          <ul className={styles.tocList}>
            {preview.toc.map((t, i) => (
              <li key={`${t.label}-${i}`} className={styles.tocRow}>
                <span>{t.label}</span>
                <span className={styles.tocChars}>{bytesText(t.chars)} 字</span>
              </li>
            ))}
          </ul>
          <blockquote className={styles.quote}>「{preview.sample}」</blockquote>
          {preview.warnings.length > 0 && (
            <div className={styles.warnList}>
              {preview.warnings.map((w, i) => (
                <p key={`${w}-${i}`} className={styles.warnRow}>
                  警告：{w}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>导出历史</h3>
          <span className={styles.sub}>最近 {history.length} 条 · 成功失败都记账</span>
        </div>
        {history.length === 0 ? (
          <p className={styles.note}>还没有导出记录——配好范围点右上「导出」，成功后这里即见。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>格式</th>
                <th>范围</th>
                <th>状态</th>
                <th>路径</th>
                <th>字节</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td className={styles.monoCell}>{row.format}</td>
                  <td>{scopeLabel(row.scope, volumes)}</td>
                  <td>
                    <span
                      className={styles.statusCell}
                      title={row.status === 'fail' ? row.error ?? '失败原因未登记' : undefined}
                    >
                      <span
                        className={`${styles.dot} ${row.status === 'ok' ? styles.dotOk : styles.dotFail}`}
                        aria-hidden="true"
                      />
                      {row.status === 'ok' ? '成功' : '失败'}
                    </span>
                  </td>
                  <td className={styles.pathCell}>{row.path ?? '—'}</td>
                  <td className={styles.monoCell}>{row.bytes === null ? '—' : bytesText(row.bytes)}</td>
                  <td className={styles.monoCell}>{new Date(row.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
