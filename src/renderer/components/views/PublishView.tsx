/**
 * 发布排期页（mode: publish，P2-D T6）。
 *
 * 数据面（全部复用 T6 五通道，一条也不新开）：
 *   · 计划：`publish.planList(true)` / `publish.planSave(req)`——req 形里没有
 *     projectId，服务端取当前项目，越权他书 by construction 不可能。
 *   · 队列：`publish.queue(planId)`——**服务端推导**（P2D-R1：体量机检吃正文，
 *     渲染层拿不到就不许装算得出；页面只读回 items/warnings/plan，不本地排期）。
 *   · 暂存：`publish.stage(planId, chapterIds)`——chapterIds 即已批准集（P2D-R2），
 *     服务端逐章独立再清洗后写项目内 staging/<platform>/ 文件；本页预览用
 *     **同一个** cleanForPublish、同入参（预览即所得），但结果从不回传服务端。
 *   · 标记：`publish.markPublished(planId, chapterId)`——人工回执，useConfirm
 *     非 danger 档（不是销毁性动作）。
 *
 * ★ 按项目作用域（P2D-R3 口径，同 ExportView）：键 project?.id；未打开项目显
 *   诚实空态，一条 bridge 都不发。
 *
 * ★ 暂存态显示是会话快照：publish:queue 契约 res 只有 {plan, items, warnings}
 *   （队列不入库，纯函数推导），staging 行不随队列回带——本页从 stage/mark 的
 *   **响应**累积会话内的 暂存/已发布 标记；跨会话状态以后端闸为准（已发布章再
 *   stage 必被 skipped，不存在页面显示说错了就能换稿的路径）。此取舍如实写在这，
 *   不假装队列响应里有它没有的东西。
 *
 * 竞态纪律（照 ExportView 形状，P2-C 修复波口径）：一条 load 链（计划+队列，
 *   选中卡切换即整链重走）+ 一条 action 链（planSave/清洗预览取正文/stage/mark
 *   互斥），每个 await 回来都判 isCurrent——含 catch 与 finally。配置输入的改动
 *   （平台下拉/日期/节奏/勾选）都走 invalidateAction() 漏斗：在途动作响应落地即
 *   作废且释放 actionBusy；换计划/换书再叠 resetSession（批准集与 diff 缓存
 *   属旧计划会话态，一条也不带进新计划）。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { useConfirm } from '../common/ConfirmDialog';
import { useProjectStore } from '../../store';
import { PLATFORM_RULES } from '@shared/constants/platforms';
import { cleanForPublish } from '@shared/publish/clean';
import { validateChapter } from '@shared/publish/schedule';
import type { Cadence, CleanResult, PublishPlan, PublishQueueRes } from '@shared/types/publish';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './PublishView.module.css';

/** 节奏单选四档（与 Cadence 联合逐字同集合同序） */
const CADENCES: Array<{ id: Cadence; label: string }> = [
  { id: 'daily', label: '日更' },
  { id: 'every2', label: '隔日更' },
  { id: 'weekly', label: '周更' },
  { id: 'custom', label: '自定义' },
];

/**
 * P2D-R5：date input → 当日本地正午 ms。排期只吃「哪天」的语义，落 12:00 是为了
 * 躲开 DST 拨跳的凌晨窗口——plannedAt 是纯毫秒加法（schedule.ts 纪律），若起日
 * 恰落在某天不存在/被影子化的时刻，整条排期会差一小时；正午是全日最稳的时刻。
 */
function startAtFromLocalNoon(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return new Date(y, mo - 1, d, 12).getTime();
}

/** ms → date input 形（yyyy-mm-dd，本地日） */
function localDateInput(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 平台展示名：id/name 双判（与 buildPipelineCtx/publish-ipc 同式，plan 存 id，双判是读侧防御） */
function platformName(platform: string): string {
  const r = PLATFORM_RULES.find((x) => x.id === platform || x.name === platform);
  return r ? r.name : `${platform}（规则未在册）`;
}

function cadenceText(p: PublishPlan): string {
  if (p.cadence === 'custom') return `自定义 · 每 ${p.intervalDays} 天一章`;
  return ({ daily: '日更 · 每天一章', every2: '隔日更 · 每 2 天一章', weekly: '周更 · 每 7 天一章' })[p.cadence];
}

function statusText(s: PublishPlan['status']): string {
  return s === 'active' ? '进行中' : s === 'paused' ? '已暂停' : '已归档';
}

function statusChipCls(s: PublishPlan['status']): string {
  return s === 'active' ? styles.chipPass : s === 'paused' ? styles.chipWarn : styles.chipMute;
}

/** diff 表里的截断（码点切片防切破代理对；原文含换行/空白——code 元素保真显示） */
function clip(s: string, max = 40): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

const EDIT_ROWS_MAX = 20;

export function PublishView(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const pid = project?.id ?? null;

  const [plans, setPlans] = useState<PublishPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [queue, setQueue] = useState<PublishQueueRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 上一次 stage 的 skipped 明细（随行显示真因，不吞） */
  const [skips, setSkips] = useState<Record<string, string>>({});

  // ── 新建/编辑表单 ──
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string>(PLATFORM_RULES[0]?.id ?? 'fanqie');
  const [dateStr, setDateStr] = useState('');
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [customDays, setCustomDays] = useState('3');

  // ── 清洗预览（会话闸：批准 = 勾选且看过 diff，P2D-R2 提交即批准集）──
  const [approvedIds, setApprovedIds] = useState<string[]>([]);
  const [diffs, setDiffs] = useState<Record<string, CleanResult>>({});
  const [sessionStaging, setSessionStaging] = useState<Record<string, 'staged' | 'published'>>({});

  const loadSeqRef = useRef(createSequencer());
  const actionSeqRef = useRef(createSequencer());
  const { confirm, node: confirmNode } = useConfirm();

  // 派生数据面（在回调之前算好：toggleApproval/runStage 闭包引用的就是这一份）
  const selectedPlan = queue?.plan ?? null;
  const rule = selectedPlan
    ? PLATFORM_RULES.find((r) => r.id === selectedPlan.platform || r.name === selectedPlan.platform) ?? null
    : null;
  const market = rule?.market ?? 'cn';
  const canStage = selectedPlan !== null && approvedIds.length > 0 && !busy && !actionBusy;

  /** load 链：计划清单 +（有效选中的）队列，一条链两个 await，之间也判鲜。 */
  const load = useCallback(async (planId: string | null): Promise<void> => {
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    try {
      const ps = await bridge().publish.planList(true);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setPlans(ps);
      const cur = planId && ps.some((p) => p.id === planId) ? planId : ps[0]?.id ?? null;
      setSelectedPlanId(cur);
      if (cur === null) {
        setQueue(null);
        return; // 零计划是诚实空态不是错误
      }
      const q = await bridge().publish.queue(cur);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setQueue(q);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) {
        setErr(errorText(e));
        setQueue(null);
      }
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, []);

  /** 配置/动作变更的统一漏斗：在途动作响应落地即作废，且不再占用按钮。 */
  const invalidateAction = useCallback(() => {
    actionSeqRef.current.next();
    setActionBusy(false);
  }, []);

  /** 换计划/换书的会话态清零：批准集、diff 缓存、暂存快照、skips 一条都不续命。 */
  const resetSession = useCallback(() => {
    invalidateAction();
    setApprovedIds([]);
    setDiffs({});
    setSessionStaging({});
    setSkips({});
    setNotice(null);
  }, [invalidateAction]);

  useEffect(() => {
    // ★ R13 同款切换守卫（ExportView 口径）：只键 pid——换书＝旧书选择全清 + 整链重取。
    resetSession();
    setFormOpen(false);
    setEditingId(null);
    if (pid) {
      void load(null);
    } else {
      // 未打开项目：不发明一条 bridge 调用；在途旧书响应 bump 即废。
      loadSeqRef.current.next();
      setBusy(false);
      setPlans([]);
      setSelectedPlanId(null);
      setQueue(null);
      setErr(null);
    }
  }, [pid, load, resetSession]);

  function pickPlan(id: string): void {
    resetSession();
    void load(id);
  }

  function openCreate(): void {
    invalidateAction();
    setEditingId(null);
    setPlatform(PLATFORM_RULES[0]?.id ?? 'fanqie');
    setCadence('daily');
    setCustomDays('3');
    setDateStr(localDateInput(Date.now()));
    setFormOpen(true);
    setErr(null);
  }

  function openEdit(p: PublishPlan): void {
    invalidateAction();
    setEditingId(p.id);
    setPlatform(p.platform);
    setCadence(p.cadence);
    setCustomDays(String(p.intervalDays));
    setDateStr(localDateInput(p.startAt));
    setFormOpen(true);
    setErr(null);
  }

  async function runSavePlan(): Promise<void> {
    const startAt = startAtFromLocalNoon(dateStr);
    if (startAt === null) {
      setErr('起始日还没选——排期只吃「哪天」，页面按本地正午换算 ms（P2D-R5）。');
      return;
    }
    const seq = actionSeqRef.current.next();
    setActionBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const plan = await bridge().publish.planSave({
        ...(editingId ? { id: editingId } : {}),
        platform,
        cadence,
        ...(cadence === 'custom' ? { intervalDays: Number(customDays) } : {}),
        startAt,
      });
      if (!actionSeqRef.current.isCurrent(seq)) return;
      setFormOpen(false);
      setEditingId(null);
      resetSession();
      // load 自带链守卫（其内 next()+判鲜），陈旧时内部即弃——其后本页无状态写。
      await load(plan.id);
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (actionSeqRef.current.isCurrent(seq)) setActionBusy(false);
    }
  }

  /** 勾选 = 批准动作的一半：勾上即展开 diff（取正文一次并缓存）；取消即收回批准。 */
  async function toggleApproval(chapterId: string): Promise<void> {
    if (approvedIds.includes(chapterId)) {
      invalidateAction();
      setApprovedIds((prev) => prev.filter((x) => x !== chapterId));
      return;
    }
    setApprovedIds((prev) => [...prev, chapterId]);
    if (diffs[chapterId]) return; // 缓存内 = 本会话已看过；正文中改请点「刷新」重走队列
    const seq = actionSeqRef.current.next();
    setActionBusy(true);
    setErr(null);
    try {
      const ch = await bridge().chapter.get(chapterId);
      if (!actionSeqRef.current.isCurrent(seq)) return;
      setDiffs((prev) => ({ ...prev, [chapterId]: cleanForPublish(ch.body, market) }));
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (actionSeqRef.current.isCurrent(seq)) setActionBusy(false);
    }
  }

  async function runStage(): Promise<void> {
    if (!selectedPlan || approvedIds.length === 0) return;
    const seq = actionSeqRef.current.next();
    setActionBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const out = await bridge().publish.stage(selectedPlan.id, [...approvedIds]);
      if (!actionSeqRef.current.isCurrent(seq)) return;
      setSkips(Object.fromEntries(out.skipped.map((s) => [s.chapterId, s.reason])));
      setSessionStaging((prev) => {
        const next = { ...prev };
        for (const s of out.staged) next[s.chapterId] = 'staged';
        // 服务端说「已发布不许换稿」= 这一章确已发布：把会话快照纠正过来
        for (const s of out.skipped) if (s.reason.includes('已发布')) next[s.chapterId] = 'published';
        return next;
      });
      setApprovedIds([]); // 提交即消费：批准集不清就会让人以为还能一键重发
      setNotice(
        `已暂存 ${out.staged.length} 章 · 跳过 ${out.skipped.length} 章（真因随行显示）。` +
          '文件只写在项目内 staging/ 目录，本页不发起任何网络请求——发布动作本身归人。',
      );
      await load(selectedPlan.id);
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (actionSeqRef.current.isCurrent(seq)) setActionBusy(false);
    }
  }

  async function runMark(chapterId: string, title: string): Promise<void> {
    if (!selectedPlan) return;
    const okc = await confirm({
      title: `标记已发布：${title}`,
      body: '确认这一章已经按排期发到平台上吗？标记后该章进「已发布」态——发布工具不会再对它换稿暂存（已发布不许悄悄改历史），要改只能人工处理。',
      confirmText: '标记已发布',
    });
    if (!okc) return;
    const seq = actionSeqRef.current.next();
    setActionBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const row = await bridge().publish.markPublished(selectedPlan.id, chapterId);
      if (!actionSeqRef.current.isCurrent(seq)) return;
      setSessionStaging((prev) => ({ ...prev, [chapterId]: 'published' }));
      setNotice(`已标记发布：第 ${chapterId} 章 · ${row.publishedAt === null ? '时刻未登记（异常）' : new Date(row.publishedAt).toLocaleString()}`);
    } catch (e) {
      if (actionSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (actionSeqRef.current.isCurrent(seq)) setActionBusy(false);
    }
  }

  if (!project) {
    return (
      <div className={styles.wrap}>
        <div className={styles.head}>
          <span className={styles.title}>{MODE_LABELS.publish}</span>
          <span className={styles.sub}>定稿章排期 · 队列服务端推导 · 暂存只写项目内</span>
        </div>
        <p className={styles.empty}>未打开项目——发布排期面向定稿正稿，请先开一本。</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {confirmNode}
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.publish}</span>
        <span className={styles.sub}>计划 × 队列 × 清洗预览 × 人工发布回执 · 发布线零自动外发</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy || actionBusy} onClick={() => void load(selectedPlanId)}>
          {busy ? '…' : '刷新'}
        </button>
        <button className={styles.btn} disabled={busy || actionBusy} onClick={openCreate}>
          新建计划
        </button>
      </div>

      {err && <p className={styles.err}>{err}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      {/* ── 计划卡列表 ── */}
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>排期计划</h3>
          <span className={styles.sub}>platform 存规则 id；archived 终态也列出（只读）</span>
        </div>
        {plans.length === 0 && !formOpen ? (
          <p className={styles.note}>还没有排期计划——点右上「新建计划」，选平台、起始日与更新节奏。队列按库内章序纯推导，不入库。</p>
        ) : (
          <div className={styles.planGrid}>
            {plans.map((p) => (
              <div key={p.id} className={`${styles.planCard} ${p.id === selectedPlanId ? styles.planCardOn : ''}`}>
                <button
                  className={styles.planPick}
                  onClick={() => pickPlan(p.id)}
                  title="选中后在下方展开该计划的发布队列"
                >
                  {platformName(p.platform)} · {cadenceText(p)}
                </button>
                <span className={styles.sub}>起始 {new Date(p.startAt).toLocaleDateString()}</span>
                <span className={`${styles.chip} ${statusChipCls(p.status)}`}>{statusText(p.status)}</span>
                <button className={styles.btn} disabled={busy || actionBusy} onClick={() => openEdit(p)}>
                  编辑
                </button>
              </div>
            ))}
          </div>
        )}

        {formOpen && (
          <div className={styles.fields}>
            <span className={styles.fieldLabel}>{editingId ? `编辑计划（${editingId}）` : '新建计划'}</span>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>平台（PLATFORM_RULES 六项，存 id）</span>
              <select
                value={platform}
                onChange={(e) => {
                  invalidateAction();
                  setPlatform(e.target.value);
                }}
              >
                {PLATFORM_RULES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>起始日（本地正午换算 ms，P2D-R5）</span>
              <input
                type="date"
                value={dateStr}
                onChange={(e) => {
                  invalidateAction();
                  setDateStr(e.target.value);
                }}
              />
            </label>
            <div className={styles.tabs}>
              {CADENCES.map((c) => (
                <button
                  key={c.id}
                  className={`${styles.tab} ${cadence === c.id ? styles.tabOn : ''}`}
                  onClick={() => {
                    invalidateAction();
                    setCadence(c.id);
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {cadence === 'custom' && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>间隔天数（≥1 整数）</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={customDays}
                  onChange={(e) => {
                    invalidateAction();
                    setCustomDays(e.target.value);
                  }}
                />
              </label>
            )}
            <div className={styles.row}>
              <button className={styles.btn} disabled={busy || actionBusy} onClick={() => void runSavePlan()}>
                {actionBusy ? '…' : '保存计划'}
              </button>
              <button
                className={styles.btn}
                onClick={() => {
                  setFormOpen(false);
                  setEditingId(null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── 选中计划的队列 ── */}
      {selectedPlan && queue && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>发布队列 · {platformName(selectedPlan.platform)}</h3>
            <span className={styles.sub}>
              {cadenceText(selectedPlan)} · 起 {new Date(selectedPlan.startAt).toLocaleDateString()} ·
              应发日 = 起日 + 纯毫秒加法
            </span>
            <span className={styles.spacer} />
            <button className={styles.btnPrimary} disabled={!canStage} onClick={() => void runStage()}>
              {actionBusy ? '…' : `暂存已批准 ${approvedIds.length} 章`}
            </button>
          </div>
          <p className={styles.note}>
            批准 = 勾选并看过清洗 diff（P2D-R2 提交即批准集）；服务端对每章独立再清洗，不信任本页预览结果。
          </p>

          {queue.warnings.length > 0 && (
            <div>
              {queue.warnings.map((w, i) => (
                <p key={`${w}-${i}`} className={styles.warnRow}>
                  警告：{w}
                </p>
              ))}
            </div>
          )}

          {rule ? (
            <details className={styles.notes}>
              <summary className={styles.note}>人工核对清单（平台惯例，非机检）</summary>
              <ul className={styles.notesList}>
                {rule.contentNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          ) : (
            <p className={styles.warnRow}>平台规则未在册——体量目标与排版惯例请人工核对（非机检项）。</p>
          )}

          {queue.items.length === 0 ? (
            <p className={styles.note}>
              队列是空的——发布线只收 revised/done 定稿章；上面 warnings 里就是被跳过的未定稿章。
            </p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>批准</th>
                  <th>章序</th>
                  <th>标题</th>
                  <th>应发日</th>
                  <th>体量机检</th>
                  <th>暂存态</th>
                  <th>动作</th>
                </tr>
              </thead>
              <tbody>
                {queue.items.map((item) => {
                  const details = validateChapter(item);
                  const st = sessionStaging[item.chapterId];
                  const approved = approvedIds.includes(item.chapterId);
                  const diff = diffs[item.chapterId];
                  return (
                    <Fragment key={item.chapterId}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            checked={approved}
                            disabled={busy || actionBusy}
                            onChange={() => void toggleApproval(item.chapterId)}
                            title="勾选即批准暂存（先看清洗 diff）"
                          />
                        </td>
                        <td className={styles.monoCell}>{item.ord}</td>
                        <td>{item.title}</td>
                        <td className={styles.monoCell}>
                          {item.plannedAt === null ? '—' : new Date(item.plannedAt).toLocaleDateString()}
                        </td>
                        <td title={details.join('；')}>
                          <span
                            className={`${styles.dot} ${item.meetsSize ? styles.dotOk : styles.dotWarn}`}
                            aria-hidden="true"
                          />{' '}
                          {item.size}
                          {item.sizeUnit} / 目标 ≥{item.minSize}
                          {item.sizeUnit}
                        </td>
                        <td>
                          {st === 'published' ? (
                            <span className={`${styles.chip} ${styles.chipPass}`}>已发布</span>
                          ) : st === 'staged' ? (
                            <span className={`${styles.chip} ${styles.chipWarn}`}>暂存</span>
                          ) : (
                            <span className={`${styles.chip} ${styles.chipMute}`}>未暂存</span>
                          )}
                        </td>
                        <td>
                          {st === 'staged' && (
                            <button
                              className={styles.btn}
                              disabled={busy || actionBusy}
                              onClick={() => void runMark(item.chapterId, item.title)}
                            >
                              标记已发布
                            </button>
                          )}
                        </td>
                      </tr>
                      {skips[item.chapterId] && (
                        <tr className={styles.skipRow}>
                          <td colSpan={7}>已跳过第 {item.chapterId} 章：{skips[item.chapterId]}</td>
                        </tr>
                      )}
                      {approved && (
                        <tr>
                          <td colSpan={7} className={styles.diffCell}>
                            {diff ? (
                              <>
                                <p className={styles.note}>
                                  清洗预览：{diff.edits.length} 处编辑（与服务端暂存同一函数、同入参——预览即所得）
                                </p>
                                {diff.edits.length > 0 && (
                                  <>
                                    {diff.edits.slice(0, EDIT_ROWS_MAX).map((ed, i) => (
                                      <div key={`${ed.rule}-${ed.at}-${i}`} className={styles.editRow}>
                                        <span className={styles.editRule}>{ed.rule}</span>
                                        <code className={styles.snippet}>before: {clip(ed.before)}</code>
                                        <code className={styles.snippet}>after: {clip(ed.after)}</code>
                                      </div>
                                    ))}
                                    {diff.edits.length > EDIT_ROWS_MAX && (
                                      <p className={styles.note}>其余 {diff.edits.length - EDIT_ROWS_MAX} 处略（计数已含）。</p>
                                    )}
                                  </>
                                )}
                              </>
                            ) : (
                              <p className={styles.note}>正在取正文并清洗（每章一次）…</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* 表外 skipped 兜底：id 不在队列表（如暂存时才存在的形状）也要把真因摆出来，不吞 */}
          {Object.entries(skips)
            .filter(([id]) => !queue.items.some((i) => i.chapterId === id))
            .map(([id, reason]) => (
              <p key={id} className={styles.warnRow}>
                已跳过第 {id} 章：{reason}
              </p>
            ))}
        </section>
      )}
    </div>
  );
}
