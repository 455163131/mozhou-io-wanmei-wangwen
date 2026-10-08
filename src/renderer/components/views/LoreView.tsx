/**
 * 设定模式：设定集（真实数据：ledger:query → CharacterProfile）。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import type { CharacterProfile } from '@shared/types/ledger';
import styles from './LoreView.module.css';

export function LoreView(): JSX.Element {
  const [chars, setChars] = useState<CharacterProfile[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const r = await api.ledger.query('all');
      setChars(r.characters);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kw = q.trim();
  const shown = kw
    ? chars.filter(
        (c) => c.name.includes(kw) || c.role.includes(kw) || (c.note || '').includes(kw),
      )
    : chars;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>设定集</span>
        <div className={styles.search}>
          <input
            value={q}
            placeholder="搜索名称 / 身份 / 备注…"
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button className={styles.refresh} disabled={busy} onClick={() => void load()}>
          {busy ? '…' : '刷新'}
        </button>
      </div>

      {err && <p className={styles.err}>{err}</p>}

      {!busy && chars.length === 0 && !err && (
        <div className={styles.empty}>
          设定集还是空的。
          <br />
          在对话里让 Agent 记录人物设定（如「记住：林晚，女主角，26 岁，法医」），
          <br />
          记录会带出处存入设定账本，这里会自动出现。
        </div>
      )}

      {shown.length > 0 && (
        <div className={styles.grid}>
          {shown.map((c) => (
            <div key={c.id} className={styles.card}>
              <div className={styles.ch}>
                <span className={styles.av}>{c.name.slice(0, 1)}</span>
                <span className={styles.ht}>
                  <b>{c.name}</b>
                  <span>
                    {c.role}
                    {c.age ? ` · ${c.age}` : ''}
                  </span>
                </span>
              </div>
              {c.note && <div className={styles.note}>{c.note}</div>}
              <div className={styles.lf}>
                <span>来源 {c.refs.length} 条</span>
                <span>{new Date(c.updatedAt).toLocaleDateString('zh-CN')}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {busy && chars.length > 0 && <p className={styles.note}>刷新中…</p>}
    </div>
  );
}
