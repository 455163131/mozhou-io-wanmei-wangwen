/**
 * 灵感池页（mode: pool，P2-E ①）——P2-C 遗留的卡片浏览收口。
 *
 * inspiration:list / inspiration:remove 两通道在 P2-C T2 就四处齐全，
 * 但此前零渲染消费者（收藏只在各产出页顺手点，收进来之后没处看）——本页补上：
 *   · 默认看**已收藏**（kind='collected'），tab 切 全部/热榜/脑洞/拆书。
 *   · 全局子系统：卡片在书籍立项**之前**就存在，不键当前项目 id、
 *     不随换书重挂载、不挂项目门（口径同扫榜/脑洞/拆书/选题库四页）。
 *   · 删除走 danger 二次确认（useConfirm），per-card pending 防连点。
 *   · 演示兜底卡如实打「演示数据」徽标（payload.live===false），不冒充真抓取。
 *
 * 异步纪律（I-1 同族）：load/action 各持一条 sequencer，每个 await（含 catch/finally）
 *   回来判 isCurrent 才许落状态。本页无实底 CTA（删除只描边 .btnDanger），不入台账。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { useConfirm } from '../common/ConfirmDialog';
import type { InspirationCard, CardKind, TrendPayload, IdeaPayload, TeardownPayload } from '@shared/types/inspiration';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './InspirationPoolView.module.css';

/** tab 取值：collected=已收藏（默认）/ all=全部 / 其余按 kind 过滤 */
type PoolTab = 'collected' | 'all' | CardKind;

const TABS: { id: PoolTab; label: string }[] = [
  { id: 'collected', label: '已收藏' },
  { id: 'all', label: '全部' },
  { id: 'trend', label: '热榜' },
  { id: 'idea', label: '脑洞' },
  { id: 'teardown', label: '拆书' },
];

const KIND_LABELS: Record<CardKind, string> = { trend: '热榜', idea: '脑洞', teardown: '拆书' };

/** 建档时间 → YYYY-MM-DD（本地日，不引时区库；列表展示用，同 TopicLibraryView） */
function dateText(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 卡片内容摘要：按 kind 取 payload 的真字段，缺字段显示空态不编造 */
function summary(c: InspirationCard): string {
  if (c.kind === 'trend') {
    const p = c.payload as TrendPayload;
    const tags = p.tags?.length ? ` · ${p.tags.join(' / ')}` : '';
    return `${p.platform}${p.author ? ` · ${p.author}` : ''}${tags}`;
  }
  if (c.kind === 'idea') {
    const p = c.payload as IdeaPayload;
    return p.premise || p.direction;
  }
  const p = c.payload as TeardownPayload;
  return `${p.bookTitle} · ${p.dimension}：${p.summary}`;
}

/** 演示兜底如实标注：trend/idea 的 payload.live 是权威记录；teardown 无 live 字段不猜 */
function isDemo(c: InspirationCard): boolean {
  if (c.kind === 'teardown') return false;
  return (c.payload as TrendPayload | IdeaPayload).live === false;
}

export function InspirationPoolView(): JSX.Element {
  /** null = 还没拿到过数据（与「拿到但为空」两种诚实态分开画） */
  const [cards, setCards] = useState<InspirationCard[] | null>(null);
  const [tab, setTab] = useState<PoolTab>('collected');
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { confirm, node: confirmNode } = useConfirm();

  const loadSeqRef = useRef(createSequencer());
  const actionSeqRef = useRef(createSequencer());

  const load = useCallback(async (t: PoolTab): Promise<void> => {
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    try {
      const list = await bridge().inspiration.list(t === 'all' ? undefined : t);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setCards(list);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, []);

  useEffect(() => {
    // 全局子系统：只键 tab，不键 project——换书不重挂载本页。
    void load(tab);
  }, [load, tab]);

  /** 删除：不可逆，danger 二次确认；删后重取当前 tab（库侧 remove 是幂等收尾口径） */
  async function removeCard(c: InspirationCard): Promise<void> {
    if (pendingId) return;
    const ok = await confirm({
      title: `删除灵感卡：《${c.title}》`,
      body: '删除不可恢复：这张卡会从灵感池移除。若它已被套用成选题，选题本身不受影响（选题是独立账）。',
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    const seq = actionSeqRef.current.next();
    setPendingId(c.id);
    setErr(null);
    setNotice(null);
    try {
      await bridge().inspiration.remove(c.id);
      if (actionSeqRef.current.isCurrent(seq)) setNotice(`《${c.title}》已删除。`);
      await load(tab);
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.pool}</span>
        <span className={styles.sub}>灵感线各页收藏的卡片都在这里 · 全局池（不随书籍切换）· 删除不可恢复</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={() => void load(tab)}>
          {busy ? '读取中…' : '刷新'}
        </button>
      </div>

      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabOn : ''}`}
            disabled={busy}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {err && <p className={styles.errRow}>{err}</p>}
      {notice && <p className={styles.noticeRow}>{notice}</p>}

      {cards === null ? (
        <p className={styles.empty}>读取中…</p>
      ) : cards.length === 0 ? (
        <p className={styles.empty}>
          {tab === 'collected'
            ? '还没有收藏任何灵感卡——去「扫榜热榜 / 抽脑洞 / 拆书报告」点收藏，卡片就会进这里。'
            : '这个分类下还没有卡片。'}
        </p>
      ) : (
        <div className={styles.grid}>
          {cards.map((c) => (
            <div key={c.id} className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.kindTag}>{KIND_LABELS[c.kind]}</span>
                <span className={styles.cardTitle}>{c.title}</span>
                {c.collected === 1 && <span className={styles.collectedTag}>已收藏</span>}
                {isDemo(c) && <span className={styles.demoTag}>演示数据</span>}
              </div>
              <p className={styles.cardSummary}>{summary(c)}</p>
              <div className={styles.cardFoot}>
                <span className={styles.meta}>
                  {c.sourceLabel} · {dateText(c.createdAt)}
                </span>
                <span className={styles.spacer} />
                <button
                  className={styles.btnDanger}
                  disabled={busy || pendingId !== null}
                  onClick={() => void removeCard(c)}
                >
                  {pendingId === c.id ? '删除中…' : '删除'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {confirmNode}
    </div>
  );
}