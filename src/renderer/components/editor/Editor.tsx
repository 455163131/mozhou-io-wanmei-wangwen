/**
 * 正文编辑器（架构 T12）。
 *
 * ⚠️【待验证 V1】架构建议改用 CodeMirror 6，但「CM6 在 10 万字中文长文的
 * 滚动 FPS 与 IME 延迟」尚未实测（§5.2 V1 要求 T12 开工前验证）。
 * 本期先用 textarea + 受控更新实现，**把编辑器抽象成组件**，
 * 这样 V1 验证不通过时可替换内部实现而不动调用方。
 *
 * 审稿行内标注（§4 第 7 条 + 第 20 条②）：textarea 里放不进 HTML，所以波浪线画在**背后一层镜像 div**
 * 上（文字透明、只有 `text-decoration-color` 显色），textarea 透明地叠在上面。
 * ★ 两层必须逐参数同排版，所以字号/行距/字距/内边距在 CSS 里由一条规则同时给两边；
 *   宽度则由 `syncLayer()` 把镜像层收成 textarea 的 `clientWidth`——textarea 的滚动条
 *   占掉的那一条如果不让出来，两层可排版宽度差一个 gutter，整行波浪线会往右偏。
 * ★ 区间来自 `inline-marks.ts`：每条命中按 excerpt 逐字回验过才画，正文一改就整批消失，
 *   绝不把线画到别的句子上。所以这里**不**在输入时重跑检测，只如实说明"标注已停"。
 *   两个数据源同理都是"上一次检测的结果"：AI 味取 `aiFlavor.latest`，
 *   体检取 `health.locateChapter`（只在切章时取一次，不跟着自动保存重算——
 *   跟着保存节奏重算就是每停手 1.5 秒重跑一遍体检，标注会忽隐忽现）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore, useProjectStore } from '../../store';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { saveNow } from '../../hooks/use-agent-stream';
import {
  marksFromHits,
  marksFromLocations,
  mergeMarks,
  segmentsOf,
  type InlineMark,
} from './inline-marks';
import type { FlavorScanResult } from '@shared/types/ipc';
import type { LocatedIssue } from '@shared/types/health';
import styles from './Editor.module.css';

const LEVEL_CLASS: Record<string, string> = {
  /** 体检的两档（AnalysisIssue.level 用的就是 Grade，比全部 AI 味档位轻，见 inline-marks.ts） */
  warn: styles.warn,
  risk: styles.risk,
  mild: styles.mild,
  suspicious: styles.suspicious,
  heavy: styles.heavy,
  severe: styles.severe,
};

export function Editor(): JSX.Element {
  const currentChapter = useProjectStore((s) => s.currentChapterId);
  const body = useEditorStore((s) => s.body);
  const setBody = useEditorStore((s) => s.setBody);
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const chapters = useProjectStore((s) => s.chapters);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [scan, setScan] = useState<FlavorScanResult | null>(null);
  /** 体检命中（§4 第 20 条②）：主进程在同一份正文快照上算好的可画坐标 */
  const [healthIssues, setHealthIssues] = useState<LocatedIssue[] | null>(null);
  const [showMarks, setShowMarks] = useState(true);
  const [caretMark, setCaretMark] = useState<InlineMark | null>(null);

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

  /**
   * 标注的数据源 = 这一章**上一次**检测的报告（`aiFlavor:latest`，主进程从库里读）。
   * 不在编辑器里自动重测：检测是显式动作，边敲边跑既慢又让标注忽隐忽现。
   */
  useEffect(() => {
    setScan(null);
    setCaretMark(null);
    if (!currentChapter) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await bridge().aiFlavor.latest(currentChapter);
        if (!cancelled) setScan(res);
      } catch {
        // 标注是锦上添花：拿不到就不画，绝不因为它失败打扰写作主链路
        if (!cancelled) setScan(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentChapter]);

  /**
   * 体检命中的数据源同理是"上一次体检"，但这条链**必须一次调到底**（§4 第 20 条②）：
   * `locateChapter` 在主进程里用同一份正文同时算出"哪些项超标"和"超标在哪一片"，
   * 渲染层按指标循环调的话，中间自动保存一落盘两边就对不上了。
   */
  useEffect(() => {
    setHealthIssues(null);
    if (!currentChapter) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await bridge().health.locateChapter(currentChapter);
        if (!cancelled) setHealthIssues(list);
      } catch {
        // 拿不到就什么都不画，绝不因为标注打扰写作主链路
        if (!cancelled) setHealthIssues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentChapter]);

  /**
   * 两个来源各自映射（都带逐字回验），再并成不重叠的区间。
   * ★ 段落级体检命中会盖住句子里的 AI 味标志词，合并时以更细的那一档着色，
   *   两边的原因文案都留在 `caretMark` 那一行里。
   */
  const marks = useMemo(
    () =>
      showMarks
        ? mergeMarks([...marksFromHits(scan?.hits, body), ...marksFromLocations(healthIssues, body)])
        : [],
    [showMarks, scan, healthIssues, body],
  );
  const segments = useMemo(() => segmentsOf(body, marks), [body, marks]);

  /** 镜像层跟 textarea 同滚同宽（滚动条那条要让出来） */
  const syncLayer = (): void => {
    const ta = taRef.current;
    const bd = backdropRef.current;
    if (!ta || !bd) return;
    bd.style.width = `${ta.clientWidth}px`;
    bd.scrollTop = ta.scrollTop;
    bd.scrollLeft = ta.scrollLeft;
  };

  useEffect(() => {
    syncLayer();
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      syncLayer();
    });
    ro.observe(ta);
    return () => {
      ro.disconnect();
    };
    // segments 变化会改变内容与滚动高度，跟着重算一次
  }, [segments]);

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
  /**
   * 报告有命中、却一条都没画出来——两种原因要分开说，不能都推给"你改过正文"。
   * 体检里 `length === 0` 的那些是主进程明说"这个指标定位不到"（TTR 那类全书统计），
   * 它们本来就不该参与"有命中却没画上"的判断，否则一句多余的解释常驻在工具栏下面。
   */
  const flavorHits = scan?.hits ?? [];
  const healthDrawable = (healthIssues ?? []).filter((l) => l.length > 0);
  const hasHits = flavorHits.length + healthDrawable.length > 0;
  const missingExcerpt =
    flavorHits.some((h) => !h.excerpt) || healthDrawable.some((l) => !l.excerpt);
  const blockedByEdit = showMarks && hasHits && marks.length === 0 && !missingExcerpt;
  const blockedByExcerpt = showMarks && hasHits && marks.length === 0 && missingExcerpt;

  /**
   * 光标落在哪条标注上，就把那条的原因与改法写在工具栏下方。
   * ★ 只能这么做：textarea 盖在镜像层上面，`title` 提示永远触发不了（镜像层还是
   *   pointer-events: none）。位置由波浪线给，理由由这一行给。
   */
  const reportCaret = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    setCaretMark(marks.find((m) => pos >= m.start && pos < m.end) ?? null);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.chapterTitle}>{meta?.title ?? '未选择章节'}</span>
        <span className={styles.stats}>
          {body.replace(/\s/g, '').length} 字
          {dirty && <span className={styles.dirty}> · 未保存</span>}
          {saving && <span className={styles.saving}> · 保存中…</span>}
        </span>
        {currentChapter && (
          <label
            className={styles.markToggle}
            title="按上一次 AI 味检测与体检的结果，在正文下画波浪线（正文一改就停）"
          >
            <input
              type="checkbox"
              checked={showMarks}
              onChange={(e) => {
                setShowMarks(e.target.checked);
                setCaretMark(null);
              }}
            />
            行内标注
            {marks.length > 0 && <span className={styles.markCount}>{marks.length}</span>}
          </label>
        )}
        <button className={styles.saveBtn} onClick={() => void saveNow()} disabled={!dirty || saving}>
          保存
        </button>
      </div>
      {caretMark && <div className={styles.markNote}>{caretMark.title}</div>}
      {!caretMark && blockedByEdit && (
        <div className={styles.markNote}>
          正文相对上次检测已改动，行内标注已停 —— 到审稿模式重新检测即可恢复。
        </div>
      )}
      {!caretMark && blockedByExcerpt && (
        <div className={styles.markNote}>
          上次检测没有回传原文片段，无法逐字定位，行内标注不画 —— 重新检测一次即可恢复。
        </div>
      )}
      <div className={styles.stage}>
        <div ref={backdropRef} className={styles.backdrop} aria-hidden="true">
          {segments.map((seg, i) =>
            seg.mark ? (
              <span
                key={`${seg.mark.start}-${i}`}
                className={`${styles.mark} ${LEVEL_CLASS[seg.mark.level] ?? styles.heavy}`}
              >
                {seg.text}
              </span>
            ) : (
              <span key={`p-${i}`}>{seg.text}</span>
            ),
          )}
        </div>
        <textarea
          ref={taRef}
          className={styles.area}
          value={body}
          placeholder="在这里写正文…"
          onChange={(e) => setBody(e.target.value)}
          onScroll={syncLayer}
          onClick={reportCaret}
          onKeyUp={reportCaret}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
