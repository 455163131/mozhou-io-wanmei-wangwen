/**
 * 章节树（架构 T11）。虚拟化窗口 50 章（架构 §1.9）。
 */
import { useMemo } from 'react';
import { useProjectStore } from '../../store';
import { CHAPTER_TREE_WINDOW } from '@shared/constants/metrics';
import styles from './ChapterTree.module.css';

const STATUS_MARK: Record<string, string> = {
  todo: '○',
  draft: '◐',
  revised: '◑',
  done: '●',
};

export function ChapterTree(): JSX.Element {
  const chapters = useProjectStore((s) => s.chapters);
  const volumes = useProjectStore((s) => s.volumes);
  const current = useProjectStore((s) => s.currentChapterId);
  const setCurrent = useProjectStore((s) => s.setCurrent);

  // 按卷分组；无卷的放「未分卷」
  const grouped = useMemo(() => {
    const map = new Map<string, typeof chapters>();
    for (const v of volumes) map.set(v.id, []);
    map.set('__none__', []);
    for (const c of chapters) {
      const key = c.volumeId ?? '__none__';
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

  if (chapters.length === 0) {
    return (
      <div className={styles.empty}>
        还没有章节。
        <br />
        打开或新建一个项目开始。
      </div>
    );
  }

  const ordered = [...volumes.map((v) => [v.id, v.title] as const), ['__none__', '未分卷'] as const];

  return (
    <div className={styles.tree}>
      <div className={styles.title}>章节（{chapters.length}）</div>
      {ordered.map(([vid, vtitle]) => {
        const list = grouped.get(vid) ?? [];
        if (list.length === 0) return null;
        // 只显示窗口内的章
        const visible = list.filter((c) => windowed.some((w) => w.id === c.id));
        if (visible.length === 0) return null;
        return (
          <div key={vid} className={styles.volume}>
            <div className={styles.volumeTitle}>{vtitle}</div>
            {visible.map((c) => (
              <button
                key={c.id}
                className={`${styles.node} ${c.id === current ? styles.active : ''}`}
                onClick={() => setCurrent(c.id)}
                title={`${c.title || `第${c.id}章`}（${c.charCount} 字）`}
              >
                <span className={styles.status}>{STATUS_MARK[c.status] ?? '○'}</span>
                <span className={styles.nodeTitle}>{c.title || `第${c.id}章`}</span>
                <span className={styles.chars}>{c.charCount}</span>
              </button>
            ))}
          </div>
        );
      })}
      {chapters.length > CHAPTER_TREE_WINDOW && (
        <div className={styles.virtualNote}>
          虚拟化：当前只渲染 {CHAPTER_TREE_WINDOW} 章（共 {chapters.length} 章）
        </div>
      )}
    </div>
  );
}