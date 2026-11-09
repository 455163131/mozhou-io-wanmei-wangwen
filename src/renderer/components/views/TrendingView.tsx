/**
 * 扫榜热榜页（mode: trends，P2-C T3）。
 *
 * 数据面（全部复用 T2 既有通道，一页一条也不新开）：
 *   · 取数：`trending.fetch(platform)` → {entries,source,error?}；T3/R9 起每条 entry
 *     已由主进程幂等落 kind='trend' 卡并回填 cardId——本页收藏/套用直接拿它走
 *     `inspiration.collect(cardId)` / `topic.createFromCard(cardId)`，无需再入库。
 *   · 诚实纪律（DRD §7）：source==='live' 打「实时」青标，source==='manual' 打
 *     「手动导入」中性标（C批：用户粘贴的真榜单，既没实时抓取、也不是演示集），
 *     其余「演示数据」黄标；回落时 error 带真因（robots 禁止 / 非 200 / 解析失败 /
 *     网络错），如实展示不静默；heat===null 显「热度未提供」，绝不编造热度数字。
 *   · 手动导入（C批）：`trending.importChart(platform, text)` 粘贴文本/CSV 诚实入库，
 *     导入目标=当前选中平台 Tab；与 load 共用一条 sequencer——迟到的导入不许盖新抓取。
 *
 * ★ 全局子系统：灵感卡片在书籍立项之前就存在，本页不键 project?.id、不随 openProject
 *   重载（spec §4）；初始抓一次默认平台，切 Tab 即重抓。
 *
 * 异步纪律（I-1 同族）：平台 Tab 连点时旧响应后到不许盖新榜——load 持一条 sequencer
 *   （lib/sequenced），await 回来判最新才许落状态。色与间距一律 var(--mz-*) 令牌。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import type { ChartEntry, ChartFetchResult, Platform } from '@shared/types/inspiration';
import { MODE_LABELS } from '@shared/constants/modes';
import styles from './TrendingView.module.css';

const PLATFORMS: Platform[] = ['番茄', '晋江', '起点'];

/** 热度数字格式化：仅在确有可信数字时调用（heat!==null）；万档缩写同榜单口径 */
function heatText(heat: number): string {
  return heat >= 10000 ? `${(heat / 10000).toFixed(1)}万` : String(heat);
}

export function TrendingView(): JSX.Element {
  const [platform, setPlatform] = useState<Platform>('番茄');
  const [result, setResult] = useState<ChartFetchResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** C批手动导入：粘贴框文本（导入目标=当前平台 Tab；空文本禁点导入） */
  const [importText, setImportText] = useState('');
  /** cardId → 'collect' | 'apply'：该卡正在进行的动作（禁用按钮防连点） */
  const [pending, setPending] = useState<Record<string, 'collect' | 'apply'>>({});
  /** 已收藏的 cardId 集（本会话内即时反馈，避免重复点收藏） */
  const [collected, setCollected] = useState<Set<string>>(new Set());
  /** ★ 终审修复波 D：本会话已套用的 cardId 集（镜像 collected 口径）——
   *  TopicRepo.insert 无 sourceCardId 去重，套用成功即 pending 清空、按钮回可点，
   *  再点一次就往选题池堆一条重复待立项。前端会话级闸住（后端不加去重，裁决如此）。 */
  const [applied, setApplied] = useState<Set<string>>(new Set());

  const loadSeqRef = useRef(createSequencer());

  const load = useCallback(async (p: Platform) => {
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await bridge().trending.fetch(p);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setResult(r);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, []);

  useEffect(() => {
    // 全局子系统：只键平台，不键 project——切 Tab 重抓，换书不重挂载本页。
    void load(platform);
  }, [platform, load]);

  /** C批手动导入：粘贴文本/CSV → trending.importChart（导入目标=当前平台 Tab）。
   *  与 load 共用 loadSeqRef 一条 sequencer——迟到的导入不许盖更新的抓取（反之亦然），
   *  每个 await（含 catch/finally）回来判 isCurrent 才许落状态（I-1 同族）。 */
  async function importChart(): Promise<void> {
    if (busy || importText.trim().length === 0) return;
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await bridge().trending.importChart(platform, importText);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setResult(r);
      // ★ H3：计数口径如实——旧写法把 dedup 命中的旧卡也算「已导入」，重复贴
      //   同一份榜单会报「已导入 200 条」而实际新增 0 条。
      setNotice(
        `新增 ${r.inserted ?? 0} 条，命中已存在 ${r.deduped ?? 0} 条（手动导入·非实时抓取；命中项不改写旧卡）`,
      );
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }

  /** 收藏进选题池：拿 R9 回填的 cardId 走 inspiration.collect；成功即时打标。 */
  async function collect(entry: ChartEntry): Promise<void> {
    const cardId = entry.cardId;
    if (!cardId || pending[cardId] || collected.has(cardId)) return;
    setPending((m) => ({ ...m, [cardId]: 'collect' }));
    setErr(null);
    setNotice(null);
    try {
      await bridge().inspiration.collect(cardId);
      setCollected((s) => new Set(s).add(cardId));
      // ★ 终审修复波 C（诚实口径）：收藏池的渲染层浏览页是 P2-C 后收口项——
      //   文案不再暗示「池子随时可翻」，如实标注后续收口。
      setNotice(`已收藏《${entry.title}》入灵感池（灵感池浏览页 P2-C 后收口）`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setPending((m) => {
        const next = { ...m };
        delete next[cardId];
        return next;
      });
    }
  }

  /** 套用为选题：topic.createFromCard → 待立项选题（premise 由主进程按 trend 派生）。
   *  ★ D：成功后置入会话级 applied 集——按钮转「已套用」禁用，重点击不再堆重复选题。 */
  async function apply(entry: ChartEntry): Promise<void> {
    const cardId = entry.cardId;
    if (!cardId || pending[cardId] || applied.has(cardId)) return;
    setPending((m) => ({ ...m, [cardId]: 'apply' }));
    setErr(null);
    setNotice(null);
    try {
      await bridge().topic.createFromCard(cardId);
      setApplied((s) => new Set(s).add(cardId));
      setNotice(`《${entry.title}》已套用入选题库（待立项）`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setPending((m) => {
        const next = { ...m };
        delete next[cardId];
        return next;
      });
    }
  }

  const entries = result?.entries ?? [];
  const isLive = result?.source === 'live';

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.trends}</span>
        <span className={styles.sub}>三站公开榜单 · 礼貌直抓 · 支持手动导入 · 收藏进选题池 / 套用为选题</span>
        <span className={styles.spacer} />
        {result && (
          <span className={result.source === 'manual' ? styles.badgeManual : isLive ? styles.badgeLive : styles.badgeDemo}>
            {result.source === 'manual' ? '手动导入' : isLive ? '实时' : '演示数据'}
          </span>
        )}
        <button className={styles.btnPrimary} disabled={busy} onClick={() => void load(platform)}>
          {busy ? '抓取中…' : '刷新榜单'}
        </button>
      </div>

      <div className={styles.tabs}>
        {PLATFORMS.map((p) => (
          <button
            key={p}
            className={`${styles.tab} ${platform === p ? styles.tabOn : ''}`}
            disabled={busy}
            onClick={() => setPlatform(p)}
          >
            {p}
          </button>
        ))}
      </div>

      {/* C批手动导入面板：粘贴文本/CSV → 当前平台 Tab；描边按钮（不新增实底 CTA，台账保持 19） */}
      <div className={styles.importPanel}>
        <textarea
          className={styles.importText}
          value={importText}
          disabled={busy}
          placeholder={'手动导入榜单（每行一本）：排名,书名,作者,热度,链接,标签\nCSV/TSV 均可，只有书名必填；示例：1,《长河渡口》,驿舟子,27.7万,https://…,现实|群像\n也可直接粘贴裸书名，一行一本（排名按行序，热度如实留空）'}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div className={styles.importOps}>
          <span className={styles.importHint}>导入到当前平台「{platform}」· 诚实标注「手动导入」，非实时抓取</span>
          <button
            className={styles.btn}
            disabled={busy || importText.trim().length === 0}
            onClick={() => void importChart()}
          >
            导入为榜单
          </button>
        </div>
      </div>

      {result && result.source === 'demo' && result.error && (
        <p className={styles.fallbackNote}>已回落演示集 · 真因：{result.error}</p>
      )}
      {err && <p className={styles.err}>{err}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      {busy && !result && <p className={styles.empty}>正在抓取{platform}榜单…</p>}
      {!busy && entries.length === 0 && !err && (
        <p className={styles.empty}>
          {result ? '该平台暂无榜单条目。' : '尚未取得榜单——点右上「刷新榜单」重试。'}
        </p>
      )}

      {entries.length > 0 && (
        <div className={styles.grid}>
          {entries.map((entry) => {
            const cardId = entry.cardId;
            const act = cardId ? pending[cardId] : undefined;
            const isCollected = cardId ? collected.has(cardId) : false;
            const isApplied = cardId ? applied.has(cardId) : false;
            return (
              <article key={cardId ?? `${entry.platform}-${entry.rank}`} className={styles.book}>
                <div className={styles.bookHead}>
                  <span className={styles.rank}>{entry.rank}</span>
                  <span className={styles.bookTitle}>{entry.title}</span>
                </div>
                <span className={styles.author}>{entry.author || '佚名'}</span>
                {entry.heat === null ? (
                  <span className={styles.heatMiss}>热度未提供</span>
                ) : (
                  <span className={styles.heat}>热度 {heatText(entry.heat)}</span>
                )}
                {entry.tags.length > 0 && (
                  <div className={styles.tags}>
                    {entry.tags.map((t) => (
                      <span key={t} className={styles.tag}>{t}</span>
                    ))}
                  </div>
                )}
                <div className={styles.bookOps}>
                  <button
                    className={styles.btn}
                    disabled={!cardId || !!act || isCollected}
                    onClick={() => void collect(entry)}
                  >
                    {isCollected ? '已收藏' : act === 'collect' ? '收藏中…' : '收藏'}
                  </button>
                  <button
                    className={styles.btn}
                    disabled={!cardId || !!act || isApplied}
                    onClick={() => void apply(entry)}
                  >
                    {isApplied ? '已套用' : act === 'apply' ? '套用中…' : '套用'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}