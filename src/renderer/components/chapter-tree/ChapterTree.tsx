/**
 * 章节树（架构 T11）。虚拟化窗口 50 章（架构 §1.9）。
 *
 * 拖拽（§4 第 4 条）：章拖到另一章上 = 改全局 ord；章拖到卷标题上 = 改 volumeId。
 * 两种都会乐观生效一次、再以主进程返回的整表为准覆盖，失败回读，避免"界面改了库没改"。
 *
 * 建章（§4 第 17 条）：标题框 + 「新建章节」，章节号由主进程算，这里只交标题和归属卷。
 * 新章跟着当前章所在卷走，建完立刻回读整表并选中——不然点了按钮像没反应。
 *
 * 改名（§4 第 19 条①）：双击某章进入行内改名，Enter/失焦提交、Esc 取消。
 * 提交后以主进程返回的 meta 覆盖那一行——改名不动 `rev`，编辑器里正在写的正文
 * 不该因为改标题而撞乐观锁。
 */
import { useMemo, useState } from 'react';
import { useProjectStore } from '../../store';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { CHAPTER_TREE_WINDOW } from '@shared/constants/metrics';
import type { ChapterMeta } from '@shared/types/project';
import styles from './ChapterTree.module.css';

const STATUS_MARK: Record<string, string> = {
  todo: '○',
  draft: '◐',
  revised: '◑',
  done: '●',
};

/** 「未分卷」分组在 map 里的键；真实卷 id 不会长这样 */
const NONE_KEY = '__none__';

export function ChapterTree(): JSX.Element {
  const chapters = useProjectStore((s) => s.chapters);
  const volumes = useProjectStore((s) => s.volumes);
  const current = useProjectStore((s) => s.currentChapterId);
  const setCurrent = useProjectStore((s) => s.setCurrent);
  const setChapters = useProjectStore((s) => s.setChapters);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // 按卷分组；无卷的放「未分卷」
  const grouped = useMemo(() => {
    const map = new Map<string, typeof chapters>();
    for (const v of volumes) map.set(v.id, []);
    map.set(NONE_KEY, []);
    for (const c of chapters) {
      const key = c.volumeId ?? NONE_KEY;
      if (!map.has(key)) map.set(key, []);
      (map.get(key) as typeof chapters).push(c);
    }
    return map;
  }, [chapters, volumes]);

  // 虚拟化：只渲染当前章附近的窗口（粗粒度——按分组而非按行）
  const windowed = useMemo(() => {
    const idx = chapters.findIndex((c) => c.id === current);
    if (idx < 0) return chapters;
    const half = Math.floor(CHAPTER_TREE_WINDOW / 2);
    const start = Math.max(0, idx - half);
    const end = Math.min(chapters.length, start + CHAPTER_TREE_WINDOW);
    return chapters.slice(start, end);
  }, [chapters, current]);

  /**
   * 新建一章。空标题也允许（先建章再想名字是写作常态），所以这里**不**禁用按钮；
   * `creating` 挡住连点——真正的防重复是主进程按最大号算号，连点会建出 1、2 两章。
   */
  const createChapter = async (): Promise<void> => {
    const api = bridge();
    if (!api || creating) return;
    setCreating(true);
    setErr(null);
    try {
      const volumeId = chapters.find((c) => c.id === current)?.volumeId ?? null;
      const created = await api.chapter.create({ title: draftTitle.trim(), volumeId });
      setDraftTitle('');
      // 整表回读：新章的 ord 由主进程定，界面不猜
      setChapters(await api.chapter.list());
      setCurrent(created.id);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setCreating(false);
    }
  };

  /**
   * 提交改名（§4 第 19 条①）。空标题也放行——与建章同口径，界面按 `第N章` 兜底。
   * 先把输入框关掉再发请求：Enter 提交后紧接着的失焦会再触发一次，两次改名打到
   * 同一个标题上虽然无害，但会多一次备份记账和一次整表回读。
   * 失败时整表回读：宁可看到旧名，也不要"界面新名 / 库里旧名"两张脸。
   */
  const commitRename = async (): Promise<void> => {
    const api = bridge();
    if (!api || renamingId === null) return;
    const chapterId = renamingId;
    const title = renameValue;
    setRenamingId(null);
    setErr(null);
    try {
      const updated = await api.chapter.setTitle(chapterId, title);
      setChapters(chapters.map((c) => (c.id === updated.id ? updated : c)));
    } catch (e) {
      setErr(errorText(e));
      const fresh = await api.chapter.list().catch(() => null);
      if (fresh) setChapters(fresh);
    }
  };

  const newForm = (
    <div className={styles.newform}>
      <input
        className={styles.input}
        value={draftTitle}
        maxLength={40}
        disabled={creating}
        placeholder="新章标题，可留空"
        aria-label="新建章节标题"
        onChange={(e) => {
          setDraftTitle(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void createChapter();
        }}
      />
      <button
        className={styles.btn}
        disabled={creating}
        onClick={() => void createChapter()}
      >
        {creating ? '建章中…' : '新建章节'}
      </button>
    </div>
  );

  /** 把拖动的章落到 targetId 之前；跨卷时先落卷再落序 */
  const dropOnChapter = async (targetId: string): Promise<void> => {
    const fromId = dragId;
    setDragId(null);
    setOverKey(null);
    if (!fromId || fromId === targetId || moving) return;
    const api = bridge();
    if (!api) return;
    const from = chapters.find((c) => c.id === fromId);
    const to = chapters.find((c) => c.id === targetId);
    if (!from || !to) return;

    const ids = chapters.map((c) => c.id).filter((id) => id !== fromId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(at, 0, fromId);

    setMoving(true);
    setErr(null);
    try {
      if (from.volumeId !== to.volumeId) await api.chapter.setVolume(fromId, to.volumeId);
      setChapters(ids.map((id) => chapters.find((c) => c.id === id) as ChapterMeta));
      setChapters(await api.chapter.reorder(ids));
    } catch (e) {
      setErr(errorText(e));
      const fresh = await api.chapter.list().catch(() => null);
      if (fresh) setChapters(fresh);
    } finally {
      setMoving(false);
    }
  };

  /** 拖到卷标题上：只换卷，不动全局序 */
  const dropOnVolume = async (volumeKey: string): Promise<void> => {
    const fromId = dragId;
    setDragId(null);
    setOverKey(null);
    if (!fromId || moving) return;
    const api = bridge();
    if (!api) return;
    const from = chapters.find((c) => c.id === fromId);
    const targetVolumeId = volumeKey === NONE_KEY ? null : volumeKey;
    if (!from || from.volumeId === targetVolumeId) return;

    setMoving(true);
    setErr(null);
    try {
      const updated = await api.chapter.setVolume(fromId, targetVolumeId);
      setChapters(chapters.map((c) => (c.id === fromId ? updated : c)));
    } catch (e) {
      setErr(errorText(e));
      const fresh = await api.chapter.list().catch(() => null);
      if (fresh) setChapters(fresh);
    } finally {
      setMoving(false);
    }
  };

  if (chapters.length === 0) {
    return (
      <div className={styles.tree}>
        <div className={styles.title}>章节（0）</div>
        {err && <div className={styles.err}>{err}</div>}
        {newForm}
        <div className={styles.empty}>
          还没有章节。
          <br />
          起个标题，点「新建章节」就能开始写。
        </div>
      </div>
    );
  }

  const ordered = [...volumes.map((v) => [v.id, v.title] as const), [NONE_KEY, '未分卷'] as const];

  return (
    <div className={styles.tree}>
      <div className={styles.title}>章节（{chapters.length}）</div>
      {err && <div className={styles.err}>{err}</div>}
      {newForm}
      {ordered.map(([vid, vtitle]) => {
        const list = grouped.get(vid) ?? [];
        if (list.length === 0) return null;
        // 只显示窗口内的章
        const visible = list.filter((c) => windowed.some((w) => w.id === c.id));
        if (visible.length === 0) return null;
        return (
          <div
            key={vid}
            className={`${styles.volume} ${overKey === vid && dragId !== null ? styles.volumeOver : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (overKey !== vid) setOverKey(vid);
            }}
            onDrop={(e) => {
              e.preventDefault();
              void dropOnVolume(vid);
            }}
          >
            <div className={styles.volumeTitle} title="把章节拖到这里可换卷">
              {vtitle}
            </div>
            {visible.map((c) => {
              if (renamingId === c.id) {
                return (
                  <div key={c.id} className={`${styles.node} ${styles.active}`}>
                    <span className={styles.status}>{STATUS_MARK[c.status] ?? '○'}</span>
                    <input
                      className={styles.input}
                      value={renameValue}
                      maxLength={40}
                      autoFocus
                      aria-label="修改章节标题"
                      onChange={(e) => {
                        setRenameValue(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename();
                        else if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => {
                        void commitRename();
                      }}
                    />
                    <span className={styles.chars}>{c.charCount}</span>
                  </div>
                );
              }
              return (
                <button
                  key={c.id}
                  className={`${styles.node} ${c.id === current ? styles.active : ''} ${
                    dragId === c.id ? styles.nodeDrag : ''
                  } ${overKey === c.id && dragId !== null && dragId !== c.id ? styles.nodeOver : ''}`}
                  draggable
                  onClick={() => setCurrent(c.id)}
                  onDoubleClick={() => {
                    setErr(null);
                    setRenameValue(c.title);
                    setRenamingId(c.id);
                  }}
                  onDragStart={() => {
                    setDragId(c.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverKey(null);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    if (overKey !== c.id) setOverKey(c.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void dropOnChapter(c.id);
                  }}
                  title={`${c.title || `第${c.id}章`}（${c.charCount} 字）拖动可改顺序，拖到卷名上可换卷，双击可改标题`}
                >
                  <span className={styles.status}>{STATUS_MARK[c.status] ?? '○'}</span>
                  <span className={styles.nodeTitle}>{c.title || `第${c.id}章`}</span>
                  <span className={styles.chars}>{c.charCount}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      {moving && <div className={styles.virtualNote}>正在保存章节顺序…</div>}
      {chapters.length > CHAPTER_TREE_WINDOW && (
        <div className={styles.virtualNote}>
          虚拟化：当前只渲染 {CHAPTER_TREE_WINDOW} 章（共 {chapters.length} 章）
        </div>
      )}
    </div>
  );
}
