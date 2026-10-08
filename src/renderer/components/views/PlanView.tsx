/**
 * 规划模式：卷册总览 + 分卷进度 + 建卷/拖拽排序（§4 第 4 条）。
 *
 * 卷列表取自 store（`project:volumes`），这样在规划视图里建卷或拖动顺序之后，
 * 章节树的分组会跟着一起变——两处读的是同一份 volumes。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { useProjectStore } from '../../store';
import type { DashStats } from '@shared/types/ipc';
import type { Volume } from '@shared/types/project';
import styles from './PlanView.module.css';

export function PlanView(): JSX.Element {
  const volumes = useProjectStore((s) => s.volumes);
  const setVolumes = useProjectStore((s) => s.setVolumes);
  const [stats, setStats] = useState<DashStats | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const [v, s] = await Promise.all([api.project.volumes(), api.aiFlavor.dashStats()]);
      setVolumes(v);
      setStats(s);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [setVolumes]);

  useEffect(() => {
    void load();
  }, [load]);

  const createVolume = async (): Promise<void> => {
    const api = bridge();
    if (!api) return;
    const title = draftTitle.trim();
    if (!title) return;
    setSaving(true);
    setErr(null);
    try {
      const created = await api.project.createVolume(title);
      setVolumes([...volumes, created]);
      setDraftTitle('');
      // 进度聚合（每卷章数/字数）只有主进程算得出来，建完刷一次
      const s = await api.aiFlavor.dashStats();
      setStats(s);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  /** 把 fromId 挪到 toId 的位置上，其余保持相对顺序 */
  const movedIds = (fromId: string, toId: string): string[] => {
    const ids = volumes.map((v) => v.id).filter((id) => id !== fromId);
    const at = ids.indexOf(toId);
    if (at < 0) return volumes.map((v) => v.id);
    ids.splice(at, 0, fromId);
    return ids;
  };

  const reorder = async (fromId: string, targetId: string): Promise<void> => {
    setDragId(null);
    setOverId(null);
    if (fromId === targetId) return;
    const api = bridge();
    if (!api) return;
    const ids = movedIds(fromId, targetId);
    // 先本地生效再等主进程：拖动后的视觉反馈必须是即时的
    setVolumes(ids.map((id) => volumes.find((v) => v.id === id) as Volume));
    setErr(null);
    try {
      const res = await api.project.reorderVolumes(ids);
      setVolumes(res);
    } catch (e) {
      setErr(errorText(e));
      void load();
    }
  };

  const progressOf = (volumeId: string): { chapters: number; chars: number; pct: number } => {
    const v = stats?.volumes.find((x) => x.id === volumeId);
    return { chapters: v?.chapters ?? 0, chars: v?.chars ?? 0, pct: v?.progressPct ?? 0 };
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.crumb}>
        <b>《{stats ? `${stats.totalChars > 0 ? (stats.totalChars / 10000).toFixed(1) : '0'} 万字` : '…'}》</b>
        <span className={styles.sep}>·</span>
        <span>{stats?.chapterCount ?? 0} 章</span>
        <span className={styles.sep}>·</span>
        <span>{volumes.length} 卷</span>
      </div>

      {err && <p className={styles.err}>{err}</p>}
      {busy && !stats && <p className={styles.note}>加载中…</p>}

      <div className={styles.newform}>
        <input
          className={styles.input}
          value={draftTitle}
          maxLength={40}
          disabled={saving}
          placeholder="新建分卷标题，如「第一卷 风起」"
          aria-label="新建分卷标题"
          onChange={(e) => {
            setDraftTitle(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createVolume();
          }}
        />
        <button
          className={styles.btn}
          disabled={saving || draftTitle.trim().length === 0}
          onClick={() => void createVolume()}
        >
          {saving ? '创建中…' : '新建分卷'}
        </button>
        <span className={styles.hint}>直接拖动下方卡片可调卷序</span>
      </div>

      {stats && (
        <>
          <div className={styles.bookg}>
            <div className={styles.bh}>
              <b>全书总览</b>
            </div>
            <div className={styles.row}>
              <span>
                <span className={styles.k}>总字数</span>
                {stats.totalChars.toLocaleString()} 字
              </span>
              <span>
                <span className={styles.k}>总章数</span>
                {stats.chapterCount}
              </span>
              <span>
                <span className={styles.k}>已发布</span>
                {stats.byStatus.done} 章
              </span>
              <span>
                <span className={styles.k}>待审</span>
                {stats.byStatus.revised} 章
              </span>
              <span>
                <span className={styles.k}>草稿</span>
                {stats.byStatus.draft} 章
              </span>
              <span>
                <span className={styles.k}>大纲</span>
                {stats.byStatus.todo} 章
              </span>
              <span>
                <span className={styles.k}>检查点</span>
                {stats.checkpoints}
              </span>
            </div>
          </div>

          <div className={styles.volsGrid}>
            {volumes.map((v, i) => {
              const p = progressOf(v.id);
              const cls = [
                styles.oc,
                dragId === v.id ? styles.ocDrag : '',
                overId === v.id && dragId !== null && dragId !== v.id ? styles.ocOver : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={v.id}
                  className={cls}
                  draggable
                  title="拖动可调整卷序"
                  onDragStart={() => {
                    setDragId(v.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (overId !== v.id) setOverId(v.id);
                  }}
                  onDragLeave={() => {
                    setOverId((cur) => (cur === v.id ? null : cur));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragId;
                    if (from) void reorder(from, v.id);
                    else {
                      setOverId(null);
                    }
                  }}
                >
                  <div className={styles.oh}>
                    <span className={styles.no}>第 {i + 1} 卷</span>
                  </div>
                  <div className={styles.ot}>{v.title}</div>
                  <div className={styles.os}>
                    {p.chapters} 章 · {p.chars.toLocaleString()} 字
                  </div>
                  <div className={styles.ob}>
                    <i className={styles.fill} style={{ width: `${Math.min(100, p.pct)}%` }} />
                  </div>
                  <div className={styles.om}>
                    <span>稳定稿进度 {p.pct}%</span>
                  </div>
                </div>
              );
            })}
            {volumes.length === 0 && !busy && (
              <div className={styles.add}>
                还没有分卷。
                <br />
                用上方输入框建第一卷，或在对话里让 Agent 做卷册规划。
              </div>
            )}
          </div>

          <p className={styles.note}>
            数据来自章节库实时聚合（状态计数 / 卷内稳定稿占比）。卷序拖动后由主进程整体重写
            ord，落库成功才会保留；报错会自动回读一次，界面上不会出现"看着改了、其实没改"。
          </p>
        </>
      )}
    </div>
  );
}
