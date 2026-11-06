/**
 * 伏笔台账页（mode: foreshadow，P2-B T4）。
 *
 * 数据面（全部复用既有通道，一页一条也不新开）：
 *   · 取数：`ledger.query('foreshadow')` → res.foreshadows（T4 起 ledger:query 带伏笔一路）；
 *   · 手改：`ledger.patch`（白名单 name/weight/chain/status/resolvedAt）与 `ledger.upsert`
 *     单条新建（id 走 `nextId('fs')`，与 Agent 侧 ledger-update 同一形状）；
 *   · 删除：`ledger.remove` + useConfirm 二次确认（危险动作纪律，同回滚入口）；
 *   · 证据：`chapter.get` 只读正文 → `excerptAround` 取 ±60 字窗口；空串回诚实 miss 行，
 *     不编上下文；跳章复用 `health.locateChapter` + store.setCurrent，正文永远只读。
 *
 * 布局照原型 05-foreshadow.html：上＝债务分趋势 SVG 柱（debtSeries 的纯渲染，
 * 章末口径 index i = 第 i+1 章写完时点；hover 走 SVG `<title>`，无 JS、不抢焦点），
 * 下＝台账表格（伏笔名/埋设章/权重/状态点/因果链/操作），右栏＝状态筛选 + 证据面板。
 * 色与间距一律 var(--mz-*) 令牌（wiring 测试钉死零裸色）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { useProjectStore } from '../../store';
import { useConfirm } from '../common/ConfirmDialog';
import type { Foreshadow } from '@shared/types/ledger';
import { debtSeries, excerptAround, ledgerStatus, OVERDUE_GAP_CHAPTERS } from '@shared/ledger-metrics';
import { nextId } from '@shared/util/id';
import styles from './ForeshadowView.module.css';

type StatusFilter = 'all' | 'unpaid' | 'overdue' | 'paid';
const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'unpaid', label: '未偿' },
  { id: 'overdue', label: '超期' },
  { id: 'paid', label: '已偿' },
];

type Modal =
  | { kind: 'add' }
  | { kind: 'edit'; f: Foreshadow }
  | { kind: 'resolve'; f: Foreshadow }
  | null;

interface Evidence {
  f: Foreshadow;
  busy: boolean;
  /** 埋设原文窗口；'' = 定位失败（诚实 miss 行） */
  planted: string;
  /** 回收原文窗口；null = 尚未回收不显示 */
  resolved: string | null;
  err: string | null;
}

export function ForeshadowView(): JSX.Element {
  const chapters = useProjectStore((s) => s.chapters);
  const [fs, setFs] = useState<Foreshadow[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [modal, setModal] = useState<Modal>(null);
  const [evi, setEvi] = useState<Evidence | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { confirm, node: confirmNode } = useConfirm();

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const r = await api.ledger.query('foreshadow');
      setFs(r.foreshadows);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** chapterId → 故事章号（章序 = chapters 下标 + 1，chapter:list 按 ord 排好序）。
   *  定位不到回 null——debtSeries/ledgerStatus 对 null 的口径是「不虚增、不判红」，
   *  这里不替主进程编章号。 */
  const noOf = useMemo(() => {
    const m = new Map<string, number>();
    chapters.forEach((c, i) => m.set(c.id, i + 1));
    return m;
  }, [chapters]);
  const plantedNo = useCallback(
    (f: Foreshadow): number | null => (f.plantedAt ? noOf.get(f.plantedAt.chapterId) ?? null : null),
    [noOf],
  );
  /** 回收章定位不到（章被删/坏 ref）时回 null，按「仍未偿」继续计债：
   *  账面保守方向是留债，不是悄悄销账（与 ledger-metrics 的「宁可少计债」相反侧
   *  在这里成立的原因：销账比留债更容易让作者误以为已回收）。 */
  const resolvedNo = useCallback(
    (f: Foreshadow): number | null =>
      f.status === 'resolved' && f.resolvedAt ? noOf.get(f.resolvedAt.chapterId) ?? null : null,
    [noOf],
  );

  const latestNo = chapters.length;
  const series = useMemo(
    () => debtSeries(fs, plantedNo, resolvedNo, latestNo),
    [fs, plantedNo, resolvedNo, latestNo],
  );

  const rows = useMemo(
    () =>
      fs.map((f) => {
        const pNo = plantedNo(f);
        return { f, pNo, st: ledgerStatus(f, pNo, latestNo) };
      }),
    [fs, plantedNo, latestNo],
  );
  const counts = useMemo(
    () => ({
      all: rows.length,
      unpaid: rows.filter((r) => r.f.status !== 'resolved').length,
      overdue: rows.filter((r) => r.st === 'red').length,
      paid: rows.filter((r) => r.f.status === 'resolved').length,
    }),
    [rows],
  );
  const shown = rows.filter((r) =>
    statusFilter === 'all'
      ? true
      : statusFilter === 'paid'
        ? r.f.status === 'resolved'
        : statusFilter === 'unpaid'
          ? r.f.status !== 'resolved'
          : r.st === 'red',
  );

  async function runWrite(action: () => Promise<void>): Promise<void> {
    setSubmitting(true);
    try {
      await action();
      setModal(null);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** 标记回收：弹章选择 → patch{status:'resolved', resolvedAt:{chapterId,0,''}}
   *  （T3 repo 的列同步会自动把 status 落列；这里显式带 status 走同一闸） */
  async function markResolved(id: string, chapterId: string): Promise<void> {
    await runWrite(async () => {
      await bridge().ledger.patch({
        kind: 'foreshadow',
        id,
        patch: { status: 'resolved', resolvedAt: { chapterId, offset: 0, quote: '' } },
      });
    });
  }
  /** 撤销回收：patch{status:'unresolved', resolvedAt:null}——T3 白名单收 null
   *  （ledger-repo.patch 的列同步分支对 resolvedAt===null 显式放行），不是绕闸。 */
  async function markUnresolved(id: string): Promise<void> {
    await runWrite(async () => {
      await bridge().ledger.patch({
        kind: 'foreshadow',
        id,
        patch: { status: 'unresolved', resolvedAt: null },
      });
    });
  }
  async function removeRow(f: Foreshadow): Promise<void> {
    const name = f.name && f.name.trim() ? `「${f.name}」` : '这条未登记名的伏笔';
    const ok = await confirm({
      title: `删除伏笔账条目：${name}`,
      body: `将把它从伏笔台账删除（埋设位置第 ${f.plantedAt.chapterId} 章）。出处与因果链一起消失，此操作不可撤销——之后 Agent 重新登记同一条会作为新条目回来。`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await runWrite(async () => {
      await bridge().ledger.remove({ kind: 'foreshadow', id: f.id });
    });
  }

  /** 定位证据：只读取正文 → excerptAround；同时跳章（setCurrent + locateChapter 预热
   *  编辑器行内标注——与体检共用那条通道）。miss（空串）如实显示，不硬凑上下文。 */
  async function locateEvidence(f: Foreshadow): Promise<void> {
    setEvi({ f, busy: true, planted: '', resolved: null, err: null });
    const api = bridge();
    try {
      const chap = await api.chapter.get(f.plantedAt.chapterId);
      const planted = excerptAround(chap.body, f.plantedAt.offset, f.plantedAt.quote);
      let resolved: string | null = null;
      if (f.status === 'resolved' && f.resolvedAt) {
        resolved = '';
        try {
          const rc = await api.chapter.get(f.resolvedAt.chapterId);
          resolved = excerptAround(rc.body, f.resolvedAt.offset, f.resolvedAt.quote);
        } catch {
          /* 回收章取不到正文：保留 ''，走 miss 行 */
        }
      }
      setEvi({ f, busy: false, planted, resolved, err: null });
    } catch (e) {
      setEvi({ f, busy: false, planted: '', resolved: null, err: errorText(e) });
    }
    useProjectStore.getState().setCurrent(f.plantedAt.chapterId);
    try {
      await api.health.locateChapter(f.plantedAt.chapterId);
    } catch {
      /* 跳章一侧的失败不拖垮证据显示 */
    }
  }

  const maxV = Math.max(1, ...series);
  const chartW = Math.max(series.length * 14, 140);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>伏笔台账</span>
        <span className={styles.sub}>埋设→回收全程可追 · 共 {fs.length} 条</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={() => void load()}>
          {busy ? '…' : '刷新'}
        </button>
        <button className={styles.btnPrimary} onClick={() => setModal({ kind: 'add' })}>
          ＋ 手工登记伏笔
        </button>
      </div>

      {err && <p className={styles.err}>{err}</p>}

      <div className={styles.grid}>
        <div className={styles.col}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>伏笔债务分 · 按章趋势</h3>
              <span className={styles.sub}>章末口径：未偿伏笔按权重累计（A=3 / B=2 / C=1）</span>
            </div>
            {series.length === 0 ? (
              <p className={styles.empty}>还没有章节，债务曲线要按章序展开才有数。</p>
            ) : (
              <svg
                className={styles.chart}
                viewBox={`0 0 ${chartW} 140`}
                role="img"
                aria-label="按章债务分柱状图"
              >
                {series.map((v, i) => {
                  const h = Math.round((v / maxV) * 104);
                  return (
                    <rect
                      key={i}
                      className={styles.bar}
                      x={i * 14 + 2}
                      y={118 - h}
                      width={10}
                      height={h}
                    >
                      <title>{`第 ${i + 1} 章 · 债务分 ${v}`}</title>
                    </rect>
                  );
                })}
                <line className={styles.axis} x1={0} y1={118} x2={chartW} y2={118} />
                {series.map((_, i) =>
                  i === 0 || (i + 1) % 10 === 0 || i === series.length - 1 ? (
                    <text key={`l${i}`} className={styles.chLabel} x={i * 14 + 7} y={132} textAnchor="middle">
                      {i + 1}
                    </text>
                  ) : null,
                )}
              </svg>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>伏笔清单</h3>
              <span className={styles.sub}>
                共 {rows.length} 条 · 显示 {shown.length} 条
              </span>
            </div>
            {!busy && rows.length === 0 && !err && (
              <div className={styles.empty}>
                台账还是空的。在对话里让 Agent 登记伏笔，或点右上「手工登记伏笔」
                把心里有数、正文还没落笔的钩子先入账。
              </div>
            )}
            {shown.length > 0 && (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>伏笔名</th>
                    <th>埋设章</th>
                    <th>权重</th>
                    <th>状态</th>
                    <th>因果链摘要</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ f, pNo, st }) => {
                    const label =
                      f.status === 'resolved' ? '已偿' : st === 'red' ? '超期' : '未偿';
                    const dotCls =
                      st === 'green'
                        ? styles.dotGreen
                        : st === 'red'
                          ? styles.dotRed
                          : styles.dotYellow;
                    return (
                      <tr key={f.id}>
                        <td>
                          {f.name && f.name.trim() ? (
                            <b>{f.name}</b>
                          ) : (
                            <span className={styles.unreg}>未登记</span>
                          )}
                        </td>
                        <td className={styles.monoCell}>
                          第 {f.plantedAt.chapterId} 章
                          {pNo === null && <span className={styles.unreg}>（定位失败）</span>}
                        </td>
                        <td>
                          {f.weight === 'A' || f.weight === 'B' || f.weight === 'C' ? (
                            <span
                              className={
                                f.weight === 'A'
                                  ? styles.tagGold
                                  : f.weight === 'B'
                                    ? styles.tagCyan
                                    : styles.tagGray
                              }
                            >
                              {f.weight}
                            </span>
                          ) : (
                            <span className={styles.unreg}>未登记</span>
                          )}
                        </td>
                        <td>
                          <span className={styles.statusCell} title={label}>
                            <span className={`${styles.dot} ${dotCls}`} aria-hidden="true" />
                            {label}
                          </span>
                        </td>
                        <td className={styles.chainCell}>{f.chain && f.chain.trim() ? f.chain : '—'}</td>
                        <td>
                          <span className={styles.ops}>
                            <button className={styles.btn} onClick={() => setModal({ kind: 'edit', f })}>
                              编辑
                            </button>
                            {f.status === 'resolved' ? (
                              <button className={styles.btn} onClick={() => void markUnresolved(f.id)}>
                                撤销回收
                              </button>
                            ) : (
                              <button className={styles.btn} onClick={() => setModal({ kind: 'resolve', f })}>
                                标记回收
                              </button>
                            )}
                            <button className={styles.btn} onClick={() => void locateEvidence(f)}>
                              定位证据
                            </button>
                            <button className={styles.btnDanger} onClick={() => void removeRow(f)}>
                              删除
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <aside className={styles.col}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>状态筛选</h3>
            </div>
            {STATUS_FILTERS.map((sf) => (
              <button
                key={sf.id}
                className={`${styles.filterItem} ${statusFilter === sf.id ? styles.filterOn : ''}`}
                onClick={() => setStatusFilter(sf.id)}
              >
                {sf.label}
                <span className={styles.count}>{counts[sf.id]}</span>
              </button>
            ))}
            <p className={styles.note}>
              判红口径：未偿伏笔距埋设超过 {OVERDUE_GAP_CHAPTERS} 章；权重缺省按 B 计（旧行不炸账）。
            </p>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>证据</h3>
            </div>
            {!evi && (
              <p className={styles.note}>点行内「定位证据」：读取埋设章原文窗口并跳到该章。正文只读，台账不改稿。</p>
            )}
            {evi && (
              <div className={styles.eviList}>
                <div className={styles.eviTitle}>
                  {evi.f.name && evi.f.name.trim() ? evi.f.name : <span className={styles.unreg}>未登记名</span>}
                </div>
                <div className={styles.eviBlock}>
                  <div className={styles.loc}>
                    埋设原文 · 第 {evi.f.plantedAt.chapterId} 章 · 偏移 {evi.f.plantedAt.offset} 字
                  </div>
                  {evi.busy ? (
                    <div className={styles.miss}>读取中…</div>
                  ) : evi.err ? (
                    <div className={styles.miss}>{evi.err}</div>
                  ) : evi.planted ? (
                    <blockquote className={styles.quote}>「{evi.planted}」</blockquote>
                  ) : (
                    <div className={styles.miss}>
                      埋设原文未登记或正文已改动——可在因果链摘要里手工补记
                    </div>
                  )}
                </div>
                {evi.f.status === 'resolved' && evi.f.resolvedAt && (
                  <div className={styles.eviBlock}>
                    <div className={styles.loc}>
                      回收原文 · 第 {evi.f.resolvedAt.chapterId} 章
                    </div>
                    {evi.resolved ? (
                      <blockquote className={styles.quote}>「{evi.resolved}」</blockquote>
                    ) : (
                      <div className={styles.miss}>回收原文未登记或正文已改动——以章号为准</div>
                    )}
                  </div>
                )}
                {evi.f.status !== 'resolved' && (
                  <div className={styles.eviBlock}>
                    <div className={styles.locMiss}>回收原文 · 尚未回收</div>
                    <div className={styles.miss}>债务分按拖欠章数持续累计，超期后在上方曲线里可见。</div>
                  </div>
                )}
                <div className={styles.eviBlock}>
                  <div className={styles.loc}>因果链摘要</div>
                  {evi.f.chain && evi.f.chain.trim() ? (
                    <p className={styles.chainText}>{evi.f.chain}</p>
                  ) : (
                    <div className={styles.miss}>未登记——可用行内「编辑」补记</div>
                  )}
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>

      {modal && (
        <ModalCard
          title={modal.kind === 'add' ? '手工登记伏笔' : modal.kind === 'edit' ? '编辑伏笔手录字段' : '标记回收 · 选择回收章'}
          onClose={() => setModal(null)}
          submitting={submitting}
        >
          {modal.kind === 'resolve' ? (
            <ResolveBody
              chapters={chapters}
              submitting={submitting}
              onOk={(chapterId) => void markResolved(modal.f.id, chapterId)}
              onCancel={() => setModal(null)}
            />
          ) : (
            <LedgerForm
              mode={modal.kind}
              initial={modal.kind === 'edit' ? modal.f : null}
              chapters={chapters}
              submitting={submitting}
              onOk={
                modal.kind === 'add'
                  ? (v) =>
                      void runWrite(async () => {
                        await bridge().ledger.upsert({
                          foreshadows: [
                            {
                              id: nextId('fs'),
                              plantedAt: { chapterId: v.chapterId, offset: 0, quote: '' },
                              plantedQuote: '',
                              status: 'unresolved',
                              resolvedAt: null,
                              name: v.name,
                              weight: v.weight,
                              chain: v.chain,
                            },
                          ],
                        });
                      })
                  : (v) =>
                      void runWrite(async () => {
                        await bridge().ledger.patch({
                          kind: 'foreshadow',
                          id: (modal as { kind: 'edit'; f: Foreshadow }).f.id,
                          patch: { name: v.name, weight: v.weight, chain: v.chain },
                        });
                      })
              }
              onCancel={() => setModal(null)}
            />
          )}
        </ModalCard>
      )}

      {confirmNode}
    </div>
  );
}

function ModalCard(props: {
  title: string;
  onClose: () => void;
  submitting: boolean;
  children: JSX.Element;
}): JSX.Element {
  return createPortal(
    <div className={styles.mask} onMouseDown={props.onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={props.title} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>{props.title}</div>
        <div className={styles.modalBody}>{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}

interface FormValue {
  name: string;
  chapterId: string;
  weight: 'A' | 'B' | 'C';
  chain: string;
}

function LedgerForm(props: {
  mode: 'add' | 'edit';
  initial: Foreshadow | null;
  chapters: Array<{ id: string; title: string }>;
  submitting: boolean;
  onOk: (v: FormValue) => void;
  onCancel: () => void;
}): JSX.Element {
  const init = props.initial;
  const [name, setName] = useState(init?.name ?? '');
  const [chapterId, setChapterId] = useState(init?.plantedAt?.chapterId ?? props.chapters[0]?.id ?? '');
  const [weight, setWeight] = useState<'A' | 'B' | 'C'>(init?.weight ?? 'B');
  const [chain, setChain] = useState(init?.chain ?? '');
  return (
    <div className={styles.formCol}>
      <p className={styles.note}>
        {props.mode === 'add'
          ? 'AI 自动追踪之外的兜底：心里有数但正文尚未落笔的伏笔先入账占位；埋设原文之后由「定位证据」核对。'
          : '只手改白名单字段（名 / 权重 / 因果链）；埋设位置是出处链，改它请删后重登记。'}
      </p>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>伏笔名 *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：艄公的旧船票" spellCheck={false} />
      </label>
      {props.mode === 'add' && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>埋设章 *</span>
          {props.chapters.length === 0 ? (
            <span className={styles.unreg}>还没有章节可选</span>
          ) : (
            <select value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
              {props.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  第 {c.id} 章 · {c.title}
                </option>
              ))}
            </select>
          )}
        </label>
      )}
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>权重</span>
          <select value={weight} onChange={(e) => setWeight(e.target.value as 'A' | 'B' | 'C')}>
            <option value="A">A · 主线命脉</option>
            <option value="B">B · 支线钩子</option>
            <option value="C">C · 氛围点缀</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>因果链摘要</span>
          <input value={chain} onChange={(e) => setChain(e.target.value)} placeholder="埋下什么 → 指向什么 → 计划何处回收" spellCheck={false} />
        </label>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={props.onCancel}>
          取消
        </button>
        <button
          className={styles.btnPrimary}
          disabled={props.submitting || (props.mode === 'add' && props.chapters.length === 0)}
          onClick={() => props.onOk({ name: name.trim(), chapterId, weight, chain: chain.trim() })}
        >
          {props.mode === 'add' ? '登记入账' : '保存手改'}
        </button>
      </div>
    </div>
  );
}

function ResolveBody(props: {
  chapters: Array<{ id: string; title: string }>;
  submitting: boolean;
  onOk: (chapterId: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [chapterId, setChapterId] = useState(props.chapters[0]?.id ?? '');
  return (
    <div className={styles.formCol}>
      <p className={styles.note}>
        选择回收章：台账按「章末口径」在该章章末销账，回收原文可稍后由 Agent 或手工补登。
      </p>
      {props.chapters.length === 0 ? (
        <span className={styles.unreg}>还没有章节可选</span>
      ) : (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>回收章 *</span>
          <select value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            {props.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                第 {c.id} 章 · {c.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={styles.actions}>
        <button className={styles.btn} onClick={props.onCancel}>
          取消
        </button>
        <button className={styles.btnPrimary} disabled={props.submitting || !chapterId} onClick={() => props.onOk(chapterId)}>
          确认回收
        </button>
      </div>
    </div>
  );
}
