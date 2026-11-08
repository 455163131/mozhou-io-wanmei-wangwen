/**
 * 长期记忆页（mode: longterm，P2-E ②）——DRD §4.3 三栏落地，最后一个 soon 转正。
 *
 *   ① 事件流：ledger_timeline 全量（ledger:query res 扩路，P2-B「同一本账」先例），
 *      按章筛选（refs.chapterId → store.chapters 序位，与人物记忆矩阵同口径）；
 *      数字锚点（ledger_numbers）附在本栏尾部——同为 Agent 证据账，只读不改。
 *   ② 人物状态投影：characters 当前值紧凑投影（只读；手录在「人物记忆」页）。
 *   ③ 章节快报快照：charstate:list 按章分组回看。「可恢复」裁决（2026-11-08 批准）：
 *      复制到剪贴板 + 载入人物记忆页既有矩阵编辑器（useSnapshotHandoff 草稿 →
 *      CharacterView 开 cell 弹窗预填，保存仍走 charstate:set 由作者确认）——
 *      不新开写语义，快照本身是文本不是结构字段，一键覆盖人物卡会伪造出处。
 *
 * 项目门（P2D-R3 口径）：键 pid；未打开项目诚实空态、零桥调用；换书重取。
 * 异步纪律（I-1 同族）：load 持 sequencer，每个 await（含 catch/finally）判 isCurrent。
 * 本页无实底 CTA（复制/载入均描边档 .btn），不入 SOLID_BUTTON_CENSUS。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { useProjectStore, useSnapshotHandoff } from '../../store';
import type { CharacterProfile, TimelineEvent, NumberAnchor, CharState } from '@shared/types/ledger';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './LongTermView.module.css';

interface LedgerSlice {
  characters: CharacterProfile[];
  timeline: TimelineEvent[];
  numbers: NumberAnchor[];
}

export function LongTermView(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const chapters = useProjectStore((s) => s.chapters);
  const [ledger, setLedger] = useState<LedgerSlice | null>(null);
  const [states, setStates] = useState<CharState[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 'all' 或章序位（i+1，与人物记忆矩阵列头同口径） */
  const [filter, setFilter] = useState<number | 'all'>('all');

  const loadSeqRef = useRef(createSequencer());
  /** 动作通知闸（TopicLibraryView 同款）：clipboard 慢 resolve 不许把「已复制」
   *  写回换书/新动作之后的页面；只闸 UI 通知，不闸复制动作本身。 */
  const actionSeqRef = useRef(createSequencer());
  const pid = project?.id ?? null;

  const load = useCallback(async (): Promise<void> => {
    if (!pid) return; // 项目门：未打开项目零桥调用
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    try {
      const api = bridge();
      const [r, st] = await Promise.all([api.ledger.query('all'), api.charstate.list(pid)]);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setLedger({ characters: r.characters, timeline: r.timeline, numbers: r.numbers });
      setStates(st);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, [pid]);

  useEffect(() => {
    // R13 同款切换守卫：换书先清旧账、作废在途 load，再按新书重取。
    setLedger(null);
    setStates([]);
    setFilter('all');
    setNotice(null);
    loadSeqRef.current.next();
    if (pid) void load();
    else setBusy(false);
  }, [pid, load]);

  /** chapterId → 章序位（i+1）；找不到返回 0（章节已删或跨书引用，如实标注） */
  const chapterNoOf = useCallback(
    (chapterId: string): number => {
      const i = chapters.findIndex((c) => c.id === chapterId);
      return i < 0 ? 0 : i + 1;
    },
    [chapters],
  );

  const events = useMemo(() => {
    const all = ledger?.timeline ?? [];
    if (filter === 'all') return all;
    return all.filter((ev) => ev.refs.some((r) => chapterNoOf(r.chapterId) === filter));
  }, [ledger, filter, chapterNoOf]);

  /** 快照按章分组（章号升序，库侧已排序，这里只分组不重排） */
  const snapshotGroups = useMemo(() => {
    const m = new Map<number, CharState[]>();
    for (const s of states) {
      const arr = m.get(s.chapterNo) ?? [];
      arr.push(s);
      m.set(s.chapterNo, arr);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [states]);

  const charName = useCallback(
    (id: string): string => ledger?.characters.find((c) => c.id === id)?.name ?? '（人物已删除）',
    [ledger],
  );

  async function copySnapshot(text: string): Promise<void> {
    const seq = actionSeqRef.current.next();
    setErr(null);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(text);
      if (actionSeqRef.current.isCurrent(seq)) setNotice('快照已复制到剪贴板。');
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(`复制失败：${errorText(e)}`);
    }
  }

  function loadIntoEditor(s: CharState): void {
    actionSeqRef.current.next();
    useSnapshotHandoff.getState().offer({ characterId: s.characterId, chapterNo: s.chapterNo, snapshot: s.snapshot });
    setErr(null);
    setNotice(`已把「${charName(s.characterId)} · 第 ${s.chapterNo} 章」快照预填进交接草稿——切到「人物记忆」即见编辑弹窗，保存与否由你确认。`);
  }

  if (!pid) {
    return (
      <div className={styles.wrap}>
        <div className={styles.head}>
          <span className={styles.title}>{MODE_LABELS.longterm}</span>
        </div>
        <p className={styles.empty}>未打开项目——长期记忆是项目内资产（事件流/人物投影/章节快照都键这本书）。先在「选题库」立项或打开一本已有书籍。</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.longterm}</span>
        <span className={styles.sub}>事件流 · 人物状态投影 · 章节快报快照（DRD §4.3 三栏）· 只读回看，编辑在各自原页</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={() => void load()}>
          {busy ? '读取中…' : '刷新'}
        </button>
      </div>

      {err && <p className={styles.errRow}>{err}</p>}
      {notice && <p className={styles.noticeRow}>{notice}</p>}

      {ledger === null ? (
        <p className={styles.empty}>{busy ? '读取中…' : '暂无数据。'}</p>
      ) : (
        <div className={styles.cols}>
          {/* ① 事件流（按章筛选）+ 数字锚点 */}
          <section className={styles.col}>
            <div className={styles.colHead}>
              <h3 className={styles.colTitle}>事件流</h3>
              <select
                className={styles.select}
                value={filter === 'all' ? 'all' : String(filter)}
                disabled={busy}
                onChange={(e) => setFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              >
                <option value="all">全部章节</option>
                {chapters.map((c, i) => (
                  <option key={c.id} value={String(i + 1)}>
                    第 {i + 1} 章 {c.title}
                  </option>
                ))}
              </select>
            </div>
            {events.length === 0 ? (
              <p className={styles.empty}>
                {filter === 'all' ? '还没有时间线事件——Agent 登记（ledger 工具）或后续章节生成会逐步入账。' : '这一章没有登记过时间线事件。'}
              </p>
            ) : (
              <ul className={styles.eventList}>
                {events.map((ev) => (
                  <li key={ev.id} className={styles.event}>
                    <span className={styles.eventWhen}>{ev.when}</span>
                    <span className={styles.eventWhat}>{ev.what}</span>
                    {ev.refs.length > 0 && (
                      <span className={styles.eventRefs}>
                        {ev.refs.map((r, i) => {
                          const no = chapterNoOf(r.chapterId);
                          return (
                            <span key={i} className={styles.refChip}>
                              {no === 0 ? '出处章节已不在本书' : `第 ${no} 章`}「{r.quote}」
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <h4 className={styles.subHead}>数字锚点</h4>
            {ledger.numbers.length === 0 ? (
              <p className={styles.empty}>还没有数字锚点。</p>
            ) : (
              <ul className={styles.eventList}>
                {ledger.numbers.map((n) => (
                  <li key={n.id} className={styles.event}>
                    <span className={styles.eventWhat}>
                      {n.subject}：{n.value} {n.unit}
                    </span>
                    {n.refs.length > 0 && (
                      <span className={styles.eventRefs}>
                        {n.refs.map((r, i) => {
                          const no = chapterNoOf(r.chapterId);
                          return (
                            <span key={i} className={styles.refChip}>
                              {no === 0 ? '出处章节已不在本书' : `第 ${no} 章`}「{r.quote}」
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ② 人物状态投影（当前值，只读） */}
          <section className={styles.col}>
            <div className={styles.colHead}>
              <h3 className={styles.colTitle}>人物状态投影</h3>
              <span className={styles.sub}>当前值 · 手录在「人物记忆」</span>
            </div>
            {ledger.characters.length === 0 ? (
              <p className={styles.empty}>还没有人物卡。</p>
            ) : (
              <ul className={styles.eventList}>
                {ledger.characters.map((c) => (
                  <li key={c.id} className={styles.projCard}>
                    <span className={styles.projName}>
                      {c.name} <span className={styles.projRole}>{c.role || '未登记定位'}</span>
                    </span>
                    <span className={styles.projField}>目标：{c.goals?.trim() ? c.goals : '未登记'}</span>
                    <span className={styles.projField}>
                      已知 {c.knows?.length ?? 0} 条 · 不应知 {c.notKnows?.length ?? 0} 条
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ③ 章节快报快照（可复制 / 可载入编辑器） */}
          <section className={styles.col}>
            <div className={styles.colHead}>
              <h3 className={styles.colTitle}>章节快报快照</h3>
              <span className={styles.sub}>charstate 只覆盖不清账</span>
            </div>
            {snapshotGroups.length === 0 ? (
              <p className={styles.empty}>还没有章节快照——在「人物记忆」的章×人矩阵里登记。</p>
            ) : (
              snapshotGroups.map(([no, arr]) => (
                <div key={no} className={styles.snapGroup}>
                  <h4 className={styles.subHead}>第 {no} 章</h4>
                  {arr.map((s) => (
                    <div key={s.id} className={styles.snapCard}>
                      <span className={styles.projName}>{charName(s.characterId)}</span>
                      <p className={styles.snapText}>{s.snapshot}</p>
                      <div className={styles.snapOps}>
                        <button className={styles.btn} disabled={busy} onClick={() => void copySnapshot(s.snapshot)}>
                          复制快照
                        </button>
                        <button className={styles.btn} disabled={busy} onClick={() => loadIntoEditor(s)}>
                          载入编辑器
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}