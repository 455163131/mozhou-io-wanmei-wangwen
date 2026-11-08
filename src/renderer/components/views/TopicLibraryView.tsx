/**
 * 选题库页（mode: topics，P2-C T6）——灵感线四页的收口。
 *
 * 三态生命周期（互斥分栏 + 计数）：待立项 → 已立项 | 已放弃，单向终局
 *   （状态机在 TopicRepo.setStatus，非法流转在门口抛 E_TOPIC_STATE，这里不放宽）。
 *   · 取数：`topic.list()` 一次拿全三态（全局子系统：选题在立项之前就存在，
 *     **不键当前项目 id**、不随换书重挂载——口径同扫榜/脑洞/拆书三页）。
 *   · 立项（R5）：先走既有 `project.pickDir()` 原生目录选择（取消静默返回，
 *     第 29 条口径），再 `topic.promote(topicId, dir)`——主进程先建/开项目、
 *     把选题卡的一句话前提播进 projects.premise 真列（PD-1），置已立项 + 回填关联。
 *     新书打开后由 project:opened 推送刷新 store，本页不另起 open 链路。
 *   · 放弃：危险动作，useConfirm danger 二次确认后走 `topic.abandon`（终态不可改判）。
 *   · 已立项卡显示关联书名，「打开这本书」复用既有 `project.open` 流（幂等守卫在 openProject）。
 *
 * 异步纪律（I-1 同族）：取数持一条 sequencer（lib/sequenced），await 回来判
 *   isCurrent 才许落状态——旧响应后到不许盖新账。
 * ★ 会话防重复提交（T3/T5 评审口径）：per-item pending 标记——一张卡的动作
 *   进行期间该卡两个按钮全部禁用，双击/连点不会落两次 promote/abandon。
 * 色与间距一律 var(--mz-*) 令牌；实底 CTA（btnPrimary，立项键）已入 SOLID_BUTTON_CENSUS。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { useConfirm } from '../common/ConfirmDialog';
import type { Topic, TopicStatus } from '@shared/types/inspiration';
import type { Project } from '@shared/types/project';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './TopicLibraryView.module.css';

/** 三态固定序（与 TopicStatus 联合逐字同集合；生命周期单向） */
const STATUSES: TopicStatus[] = ['待立项', '已立项', '已放弃'];

/** 建档时间 → YYYY-MM-DD（本地日，不引时区库；列表展示用） */
function dateText(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 来源如实标注：套用卡建的选题记来源卡（sourceCardId），其余为直接建档 */
function sourceText(t: Topic): string {
  return t.sourceCardId ? '来源：灵感卡套用' : '来源：直接建档';
}

/** 卡内进行中的动作（该卡按钮全禁用防连点） */
type PendingAction = 'promote' | 'abandon' | 'open';

export function TopicLibraryView(): JSX.Element {
  /** null = 还没拿到过数据（与「拿到但为空」两种诚实态分开画） */
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(true);
  const [filter, setFilter] = useState<TopicStatus>('待立项');
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, PendingAction>>({});
  const { confirm, node: confirmNode } = useConfirm();

  const loadSeqRef = useRef(createSequencer());
  /** ★ 终审修复波 T6①：跨动作一条 sequencer——promote/abandon/openLinked 起手 next()，
   *  await 回来的 setNotice/setErr 只有仍是最新动作才许落笔（load 同款时效口径）。
   *  只闸 UI 通知，不闸动作本身：已点下去的立项/放弃照常执行完，clearPending 无条件。 */
  const actionSeqRef = useRef(createSequencer());

  const load = useCallback(async (): Promise<void> => {
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    try {
      const [ts, ps] = await Promise.all([bridge().topic.list(), bridge().project.list()]);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setTopics(ts);
      setProjects(ps);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, []);

  useEffect(() => {
    // 全局子系统：只取一次数，不键 project——换书不重挂载本页（spec §4）。
    void load();
  }, [load]);

  function markPending(id: string, action: PendingAction): void {
    setPending((m) => ({ ...m, [id]: action }));
  }
  function clearPending(id: string): void {
    setPending((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  }

  /** 立项（R5）：先既有目录选择器（取消静默），再主进程建/开项目 + 播 premise。 */
  async function promote(t: Topic): Promise<void> {
    if (pending[t.id]) return;
    const seq = actionSeqRef.current.next();
    markPending(t.id, 'promote');
    setErr(null);
    setNotice(null);
    try {
      const dir = await bridge().project.pickDir();
      if (!dir) return; // 取消是正常结果（第 29 条），静默返回不记错误
      const r = await bridge().topic.promote(t.id, dir);
      if (r === null) return; // 防御：UI 已自持 dir，主进程侧取消同样静默
      // ★ T7/BLOCK-T7：premiseKept=true 说明这本书已有非空不同的一句话故事、本次未覆写——
      //   如实补一句提示（可在写作坊自行改订），不静默假装播进去了。
      if (actionSeqRef.current.isCurrent(seq)) {
        setNotice(
          r.premiseKept
            ? `《${t.title}》已立项：本书已有一句话故事，未覆盖（可在写作坊自行改订），目录已打开——去「写作坊」继续。`
            : `《${t.title}》已立项：一句话前提已播进新书，目录已打开——去「写作坊」继续。`,
        );
      }
      await load();
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      clearPending(t.id);
    }
  }

  /** 放弃：不可逆终局，danger 二次确认（ForeshadowView removeRow 同款纪律）。 */
  async function abandon(t: Topic): Promise<void> {
    if (pending[t.id]) return;
    const ok = await confirm({
      title: `放弃选题：《${t.title}》`,
      body: '放弃是终局决定：这条选题会进「已放弃」栏且不可改判——它的一句话前提仍留在选题卡上，但不再出现在待立项池。想再立同一题材，请从灵感卡重新套用建一条新选题。',
      danger: true,
      confirmText: '放弃',
    });
    if (!ok) return;
    const seq = actionSeqRef.current.next();
    markPending(t.id, 'abandon');
    setErr(null);
    setNotice(null);
    try {
      await bridge().topic.abandon(t.id);
      if (actionSeqRef.current.isCurrent(seq)) setNotice(`《${t.title}》已放弃（终态，不可改判）。`);
      await load();
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      clearPending(t.id);
    }
  }

  /** 打开已立项关联的书：project.open 既有流（幂等守卫 + opened 推送刷 store）。 */
  async function openLinked(t: Topic, p: Project): Promise<void> {
    if (pending[t.id]) return;
    const seq = actionSeqRef.current.next();
    markPending(t.id, 'open');
    setErr(null);
    setNotice(null);
    try {
      await bridge().project.open(p.rootDir);
      if (actionSeqRef.current.isCurrent(seq)) setNotice(`已打开《${p.name}》——切到「写作坊」即可继续这本新书。`);
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      clearPending(t.id);
    }
  }

  const counts: Record<TopicStatus, number> = { 待立项: 0, 已立项: 0, 已放弃: 0 };
  for (const t of topics ?? []) counts[t.status] += 1;
  const shown = (topics ?? []).filter((t) => t.status === filter);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.topics}</span>
        <span className={styles.sub}>灵感线收口 · 待立项 → 已立项 | 已放弃（单向终局）· 立项会把一句话前提播进新书</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={() => void load()}>
          {busy ? '读取中…' : '刷新'}
        </button>
      </div>

      <div className={styles.tabs}>
        {STATUSES.map((s) => (
          <button
            key={s}
            className={`${styles.tab} ${filter === s ? styles.tabOn : ''}`}
            disabled={busy}
            onClick={() => setFilter(s)}
          >
            {s} <span className={styles.count}>{topics ? counts[s] : '…'}</span>
          </button>
        ))}
      </div>

      {err && <p className={styles.err}>{err}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      {busy && topics === null && <p className={styles.empty}>正在读取选题库…</p>}
      {!busy && topics !== null && shown.length === 0 && (
        <p className={styles.empty}>
          {filter === '待立项'
            ? '待立项池是空的——去「扫榜热榜 / 抽脑洞 / 拆书报告」收藏卡片，再点「套用」，选题就会出现在这里。'
            : filter === '已立项'
              ? '还没有立项过的选题。待立项栏里点「立项」，选好新书目录即可建档，一句话前提会播进项目。'
              : '没有已放弃的选题。放弃是终局决定——这一栏空着通常是好事。'}
        </p>
      )}

      {shown.length > 0 && (
        <div className={styles.grid}>
          {shown.map((t) => {
            const act = pending[t.id];
            const linked = t.projectId ? projects.find((p) => p.id === t.projectId) : undefined;
            return (
              <article key={t.id} className={styles.card}>
                <div className={styles.cardTitle}>{t.title}</div>
                <p className={styles.premise}>{t.premise}</p>
                <p className={styles.meta}>
                  {sourceText(t)} · {dateText(t.createdAt)}
                </p>
                {t.status === '待立项' && (
                  <div className={styles.ops}>
                    <button className={styles.btnPrimary} disabled={!!act} onClick={() => void promote(t)}>
                      {act === 'promote' ? '立项中…' : '立项'}
                    </button>
                    <button className={styles.btnDanger} disabled={!!act} onClick={() => void abandon(t)}>
                      {act === 'abandon' ? '放弃中…' : '放弃'}
                    </button>
                  </div>
                )}
                {t.status === '已立项' && (
                  <div className={styles.ops}>
                    {linked ? (
                      <>
                        <span className={styles.linked}>已关联《{linked.name}》</span>
                        <button className={styles.btn} disabled={!!act} onClick={() => void openLinked(t, linked)}>
                          {act === 'open' ? '打开中…' : '打开这本书'}
                        </button>
                      </>
                    ) : (
                      <span className={styles.linked}>关联项目未在册（目录可能已移除或换机）</span>
                    )}
                  </div>
                )}
                {t.status === '已放弃' && (
                  <p className={styles.meta}>已放弃（终态，不可改判）</p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {confirmNode}
    </div>
  );
}
