/**
 * 仪表盘：全部来自 dash:stats 真实聚合（日增量 / 状态计数 / 卷进度 / 检查点 / LLM 用量）。
 *
 * ★ 「今日新增 / 连更 / 本月净增 / 稿费预估」这一排以前是没有的——库里每章只存
 *   `updated_at` 一个瞬时戳，改一次覆盖一次，"今天写了多少字"在数据结构上问不出来
 *   （§4 第 3 条）。现在它来自 `daily_writes` 表：净增，可为负，记账点在正文落库那一处。
 * 只有「追读率」仍然如实标注未接入：那是读者行为数据，本地算不出来，
 * 不拿"章均字数"之类的代理指标冒充它。
 */
import { useEffect, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { refreshDash } from '../../hooks/use-dash';
import { useDashStore } from '../../store';
import styles from './DashboardView.module.css';

const wan = (n: number): string =>
  Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(1)} 万` : n.toLocaleString();

/** 正数带 + 号：净增可以是负的（那天删了字），不给符号会让人读成 0 */
const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${wan(n)}`;

export function DashboardView(): JSX.Element {
  /**
   * ★ 第 30 条：以前这里自己 `useState<DashStats|null>` + 自己取数，
   *   与底栏是两份独立副本——底栏停在 0 而这里显示新数（或反过来）就是这么来的。
   *   现在读同一个 store，取数只有 `hooks/use-dash.ts` 一处。
   */
  const stats = useDashStore((s) => s.dash);
  const err = useDashStore((s) => s.error);
  const setErr = useDashStore((s) => s.setError);
  const [busy, setBusy] = useState(true);
  const [price, setPrice] = useState('');
  const [savingPrice, setSavingPrice] = useState(false);

  useEffect(() => {
    // 函数定义在 effect 内部：它只用一次，提到组件体里就会进依赖数组、每轮重跑
    let alive = true;
    void (async () => {
      setBusy(true);
      await refreshDash();
      if (alive) setBusy(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const savePrice = async (): Promise<void> => {
    const api = bridge();
    if (!api || !stats) return;
    const n = Number(price);
    // 只挡明显不是数字的输入；口径（非负有限）由主进程那一条校验负责
    if (price.trim() === '' || !Number.isFinite(n)) {
      setErr('千字单价要填数字。清空请输入 0。');
      return;
    }
    setSavingPrice(true);
    setErr(null);
    try {
      await api.project.setPrice(n);
      await refreshDash();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSavingPrice(false);
    }
  };

  if (err && !stats) return <div className={styles.wrap}><p className={styles.err}>{err}</p></div>;
  if (!stats) {
    return (
      <div className={styles.wrap}>
        <p className={styles.note}>{busy ? '加载中…' : '打开项目后查看统计。'}</p>
      </div>
    );
  }

  const statusRows: [string, number][] = [
    ['已发布', stats.byStatus.done],
    ['待审', stats.byStatus.revised],
    ['草稿', stats.byStatus.draft],
    ['大纲', stats.byStatus.todo],
  ];
  const maxStatus = Math.max(1, ...statusRows.map(([, n]) => n));
  const week = stats.daily.week;
  const maxDay = Math.max(1, ...week.map((w) => w.delta));
  const weekTotal = week.reduce((s, w) => s + w.delta, 0);

  return (
    <div className={styles.wrap}>
      <div className={styles.deltaRow}>
        <div className={styles.stat}>
          <div className={styles.sk}>今日净增</div>
          <div className={styles.sv}>
            {signed(stats.daily.today)}
            <small> 字</small>
          </div>
          <div className={styles.sd}>昨日 {signed(stats.daily.yesterday)} 字</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>连更</div>
          <div className={styles.sv}>
            {stats.daily.streakDays}
            <small> 天</small>
          </div>
          <div className={styles.sd}>
            {stats.daily.today > 0
              ? '今天已经写了，继续保持'
              : '今天还没动笔（连更从昨天起算，没断）'}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>本月净增</div>
          <div className={styles.sv}>
            {signed(stats.daily.monthNet)}
            <small> 字</small>
          </div>
          <div className={styles.sd}>
            {stats.pricePerK > 0
              ? `稿费预估 ¥${stats.monthPay.toLocaleString()}（${stats.pricePerK} 元/千字）`
              : '稿费预估：未设单价'}
          </div>
        </div>
      </div>

      <div className={styles.statRow}>
        <div className={styles.stat}>
          <div className={styles.sk}>全书字数</div>
          <div className={styles.sv}>
            {wan(stats.totalChars)}
            <small> 字</small>
          </div>
          <div className={styles.sd}>{stats.chapterCount} 章</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>已发布 / 待审</div>
          <div className={styles.sv}>
            {stats.byStatus.done}
            <small> / {stats.byStatus.revised} 章</small>
          </div>
          <div className={styles.sd}>草稿 {stats.byStatus.draft} · 大纲 {stats.byStatus.todo}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>卷册</div>
          <div className={styles.sv}>
            {stats.volumes.length}
            <small> 卷</small>
          </div>
          <div className={styles.sd}>
            {stats.volumes.map((v) => v.title.replace(/^第/, '').split(' ')[0]).join(' · ') || '未分卷'}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.sk}>检查点（改动历史）</div>
          <div className={styles.sv}>{stats.checkpoints}</div>
          <div className={styles.sd}>回滚粒度 = Agent 每步</div>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.ph}>
            近 7 天净增
            <span className={styles.phSp}>本周 {signed(weekTotal)} 字</span>
          </div>
          {week.map((w, i) => (
            <div key={w.day} className={styles.hbar}>
              <span className={styles.hn}>{i === week.length - 1 ? '今天' : w.day.slice(5)}</span>
              <div className={styles.hb}>
                <i style={{ width: `${Math.round((Math.max(0, w.delta) / maxDay) * 100)}%` }} />
              </div>
              <span className={styles.hv}>{signed(w.delta)}</span>
            </div>
          ))}
        </div>

        <div className={styles.panel}>
          <div className={styles.ph}>千字单价（稿费预估用）</div>
          <div className={styles.priceRow}>
            <input
              className={styles.input}
              type="number"
              min={0}
              step={1}
              value={price}
              placeholder={stats.pricePerK > 0 ? `当前 ${stats.pricePerK} 元/千字` : '未设置'}
              onChange={(e) => {
                setPrice(e.target.value);
              }}
            />
            <button
              className={styles.btn}
              type="button"
              disabled={savingPrice || price.trim() === ''}
              onClick={() => void savePrice()}
            >
              {savingPrice ? '保存中…' : '设置'}
            </button>
          </div>
          <p className={styles.note}>
            预估口径 = 本月净增千字 × 单价，只按本应用记录的净字数算，
            不等于任何平台的实际结算。单价留空/为 0 时不显示钱数。
          </p>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.ph}>分卷进度（稳定稿字数占比）</div>
          {stats.volumes.length === 0 && <p className={styles.note}>还没有分卷。</p>}
          {stats.volumes.map((v) => (
            <div key={v.id} className={styles.hbar}>
              <span className={styles.hn}>{v.title}</span>
              <div className={styles.hb}>
                <i style={{ width: `${Math.min(100, v.progressPct)}%` }} />
              </div>
              <span className={styles.hv}>{v.progressPct}%</span>
            </div>
          ))}
        </div>

        <div className={styles.panel}>
          <div className={styles.ph}>章节状态分布</div>
          {statusRows.map(([label, n]) => (
            <div key={label} className={styles.hbar}>
              <span className={styles.hn}>{label}</span>
              <div className={styles.hb}>
                <i
                  className={styles.fill}
                  style={{ width: `${Math.round((n / maxStatus) * 100)}%` }}
                />
              </div>
              <span className={styles.hv}>{n} 章</span>
            </div>
          ))}
        </div>
      </div>

      {stats.llm && (
        <div className={styles.panel}>
          <div className={styles.ph}>
            Agent 循环 · LLM 用量（本次运行累计）
            <span className={styles.phSp}>{stats.llm.requests} 次调用</span>
          </div>
          <div className={styles.usage}>
            <span>输入 {stats.llm.tokensIn.toLocaleString()} tok</span>
            <span>输出 {stats.llm.tokensOut.toLocaleString()} tok</span>
            <span className={styles.cost}>
              成本 ¥{stats.llm.costCny.toFixed(4)}
            </span>
          </div>
        </div>
      )}

      {err && <p className={styles.err}>{err}</p>}

      <p className={styles.note}>
        净增 = 新字数 − 旧字数，删掉的那部分会如实扣掉。
        「追读率」需要发布平台的读者数据，本地算不出来，未接入也不放代理指标。
      </p>
    </div>
  );
}
