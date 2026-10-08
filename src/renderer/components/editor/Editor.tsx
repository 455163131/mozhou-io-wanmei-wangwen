/**
 * 正文编辑器（架构 T12）。
 *
 * ⚠️【待验证 V1】架构建议改用 CodeMirror 6，但「CM6 在 10 万字中文长文的
 * 滚动 FPS 与 IME 延迟」尚未实测（§5.2 V1 要求 T12 开工前验证）。
 * 本期先用 textarea + 受控更新实现，**把编辑器抽象成组件**，
 * 这样 V1 验证不通过时可替换内部实现而不动调用方。
 */
import { useEffect, useRef } from 'react';
import { useEditorStore, useProjectStore } from '../../store';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { saveNow } from '../../hooks/use-agent-stream';
import styles from './Editor.module.css';

export function Editor(): JSX.Element {
  const currentChapter = useProjectStore((s) => s.currentChapterId);
  const body = useEditorStore((s) => s.body);
  const setBody = useEditorStore((s) => s.setBody);
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const chapters = useProjectStore((s) => s.chapters);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 切章时载入
  useEffect(() => {
    if (!currentChapter) {
      useEditorStore.getState().load('', 1);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ch = await bridge().chapter.get(currentChapter);
        if (!cancelled) useEditorStore.getState().load(ch.body, ch.meta.rev);
      } catch (e) {
        if (!cancelled) useProjectStore.getState().setError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentChapter]);

  // Ctrl+S 立即保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const meta = chapters.find((c) => c.id === currentChapter);

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.chapterTitle}>{meta?.title ?? '未选择章节'}</span>
        <span className={styles.stats}>
          {body.replace(/\s/g, '').length} 字
          {dirty && <span className={styles.dirty}> · 未保存</span>}
          {saving && <span className={styles.saving}> · 保存中…</span>}
        </span>
        <button className={styles.saveBtn} onClick={() => void saveNow()} disabled={!dirty || saving}>
          保存
        </button>
      </div>
      <textarea
        ref={taRef}
        className={styles.area}
        value={body}
        placeholder="在这里写正文…"
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}