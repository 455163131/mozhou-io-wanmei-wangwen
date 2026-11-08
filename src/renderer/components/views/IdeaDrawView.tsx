/**
 * 抽脑洞页（mode: idea，P2-C T4）。
 *
 * 数据面：`idea.draw()` → {card,source}；主进程选方向（反重复）→ LLM 产出 → zod →
 *   落 kind='idea' 卡，回卡**自带 id**——本页收藏/套用直接拿 card.id 走
 *   `inspiration.collect(cardId)` / `topic.createFromCard(cardId)`，无需再入库。
 *
 * 诚实纪律（DRD §7）：source==='live' 打「实时」青标，否则「演示」黄标 + 明示
 *   「未配置模型或生成失败，非真实模型产出」——演示占位绝不冒充模型脑洞。
 *
 * ★ 全局子系统：灵感卡片在书籍立项之前就存在，本页不键 project?.id、不随 openProject
 *   重载（spec §4）；进页不自动抽（省 token），由作者点「抽一张脑洞」起抽。
 *
 * 异步纪律（I-1 同族）：连点「再抽一张」时旧响应后到不许盖新卡——draw 持一条 sequencer
 *   （lib/sequenced），await 回来判最新才许落状态。色与间距一律 var(--mz-*) 令牌。
 */
import { useCallback, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { useLlmProgress } from '../../hooks/use-llm-progress';
import { LlmProgressStrip } from '../common/LlmProgressStrip';
import { createSequencer } from '../../lib/sequenced';
import type { IdeaPayload, InspirationCard } from '@shared/types/inspiration';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './IdeaDrawView.module.css';

export function IdeaDrawView(): JSX.Element {
  const [card, setCard] = useState<InspirationCard | null>(null);
  const [source, setSource] = useState<'live' | 'demo' | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 本会话抽卡计数（含演示卡——演示也是一抽，如实计数） */
  const [drawCount, setDrawCount] = useState(0);
  /** 当前卡正在进行的动作（禁用按钮防连点） */
  const [pending, setPending] = useState<'collect' | 'apply' | null>(null);
  const [collected, setCollected] = useState(false);
  /** ★ 终审修复波 D：本会话当前卡是否已套用——TopicRepo.insert 无 sourceCardId 去重，
   *  套用成功后 pending 清空按钮回可点，再点会堆重复待立项。会话级闸住，新抽一张才复位。 */
  const [applied, setApplied] = useState(false);

  const drawSeqRef = useRef(createSequencer());

  /** ★ E批「模型思考过程可见」：busy 期间订阅 llm:progress（scope='idea'）——
   *  等待秒数/阶段/已收字数/思考片段如实展示；fallbackNote 在 busy 结束后
   *  仍保留，演示徽标旁一直看得到回落真因（下一轮重抽才清空）。 */
  const { progress, fallbackNote } = useLlmProgress('idea', busy);

  const draw = useCallback(async () => {
    const seq = drawSeqRef.current.next();
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await bridge().idea.draw();
      if (!drawSeqRef.current.isCurrent(seq)) return;
      setCard(r.card);
      setSource(r.source);
      setCollected(r.card.collected === 1);
      setApplied(false); // 新卡新账：套用闸只闸同一张卡的重复点击
      setPending(null);
      setDrawCount((n) => n + 1);
    } catch (e) {
      if (drawSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (drawSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, []);

  /** 收藏进选题池：拿 drawIdea 回的 card.id 走 inspiration.collect；成功即时打标。 */
  async function collect(): Promise<void> {
    if (!card || pending || collected) return;
    setPending('collect');
    setErr(null);
    setNotice(null);
    try {
      await bridge().inspiration.collect(card.id);
      setCollected(true);
      // ★ 终审修复波 C（诚实口径）：收藏池的渲染层浏览页是 P2-C 后收口项，文案不暗示池子随时可翻。
      setNotice('已收藏入灵感池（灵感池浏览页 P2-C 后收口）');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setPending(null);
    }
  }

  /** 套用为选题：topic.createFromCard → 待立项选题（premise 由主进程按 idea payload 派生）。
   *  ★ D：成功后本卡转「已套用」禁用，防重点击堆重复选题。 */
  async function apply(): Promise<void> {
    if (!card || pending || applied) return;
    setPending('apply');
    setErr(null);
    setNotice(null);
    try {
      await bridge().topic.createFromCard(card.id);
      setApplied(true);
      setNotice('已套用入选题库（待立项）');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setPending(null);
    }
  }

  const payload = card ? (card.payload as IdeaPayload) : null;
  const isLive = source === 'live';

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.idea}</span>
        <span className={styles.sub}>24 方向种子池 · 反重复 · 收藏进选题池 / 套用立项</span>
        <span className={styles.spacer} />
        <span className={styles.drawCount}>已抽 {drawCount} 张</span>
        {card && (
          <span className={isLive ? styles.badgeLive : styles.badgeDemo}>
            {isLive ? '实时' : '演示'}
          </span>
        )}
        <button className={styles.btnPrimary} disabled={busy} onClick={() => void draw()}>
          {busy ? '抽卡中…' : card ? '再抽一张' : '抽一张脑洞'}
        </button>
      </div>

      {card && !isLive && (
        <p className={styles.fallbackNote}>
          演示占位 · 未配置模型或生成失败，非真实模型产出（live=false）。配置 API Key 后再抽即得实时脑洞。
          {fallbackNote ? `本次回落真因：${fallbackNote}` : ''}
        </p>
      )}
      {err && <p className={styles.err}>{err}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      {busy && progress && <LlmProgressStrip progress={progress} />}
      {busy && !progress && !card && <p className={styles.empty}>正在抽脑洞…</p>}
      {!card && !busy && (
        <p className={styles.empty}>
          尚未抽卡——点右上「抽一张脑洞」开始。方向避开近期已抽，连抽不重样；全抽过后自动重置种子池。
        </p>
      )}

      {card && payload && (
        <article className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.direction}>{payload.direction}</span>
            {payload.genre && <span className={styles.genre}>{payload.genre}</span>}
          </div>
          <p className={styles.premise}>{payload.premise}</p>
          {payload.hook && <p className={styles.hook}>开篇钩子：{payload.hook}</p>}
          <div className={styles.ops}>
            <button
              className={styles.btn}
              disabled={!!pending || collected}
              onClick={() => void collect()}
            >
              {collected ? '已收藏' : pending === 'collect' ? '收藏中…' : '收藏'}
            </button>
            <button className={styles.btn} disabled={!!pending || applied} onClick={() => void apply()}>
              {applied ? '已套用' : pending === 'apply' ? '套用中…' : '套用立项'}
            </button>
          </div>
        </article>
      )}
    </div>
  );
}