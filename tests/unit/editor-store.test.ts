/**
 * editor-store 脏标记回归测试。
 *
 * ★★★ 本文件针对一个会让用户手写正文永不落盘的缺陷 ★★★
 *
 * 缺陷形态（修复前）：
 *   setBody: (body) => set((s) => {
 *     s.body = body;                        // 先赋值
 *     s.dirty = body !== s.body || s.dirty; // 再自比 → 恒 false
 *   })
 * immer 的 draft 上赋值后再与入参自比必然相等，dirty 永远置不上真。
 *
 * 危害链（三个消费点同时失效）：
 *   - Editor.tsx 的保存按钮 `disabled={!dirty}` → 永久禁用
 *   - Editor.tsx / use-agent-stream.ts 的 Ctrl+S 分支 `if (!dirty) return` → 直接返回
 *   - use-agent-stream.ts 的 1.5s 自动保存 `subscribe(selector, ...)` 监听 dirty → 永不触发
 * 结果：用户在编辑器里敲的字一个都不会写进 SQLite。
 *
 * 这类缺陷 281 个既有用例一个都抓不到，因为渲染层此前 0 覆盖
 * （vitest environment:'node' 且无 jsdom）。但 zustand store 是 DOM-free 的纯状态机，
 * 在 node 环境下完全可测——本文件即为此而写。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, useProjectStore } from '@renderer/store';
import type { ChapterMeta } from '@shared/types/project';

/** 每个用例前把 store 复位到确定的初始态（zustand store 是模块级单例，必须显式重置） */
function resetEditor(): void {
  useEditorStore.setState({ body: '', rev: 1, dirty: false, saving: false });
}

describe('editor-store · dirty 脏标记（手写正文能否落盘的唯一开关）', () => {
  beforeEach(() => {
    resetEditor();
  });

  it('★ 载入后首次输入必须置脏（修复前此处为 false → 正文永不保存）', () => {
    useEditorStore.getState().load('原文', 3);
    expect(useEditorStore.getState().dirty).toBe(false);

    useEditorStore.getState().setBody('原文改了');
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().body).toBe('原文改了');
  });

  it('★ 连续输入每次都保持脏，不会因中途比较而丢失', () => {
    useEditorStore.getState().load('', 1);
    for (const s of ['他', '他看', '他看了', '他看了很久']) {
      useEditorStore.getState().setBody(s);
      expect(useEditorStore.getState().dirty).toBe(true);
    }
    expect(useEditorStore.getState().body).toBe('他看了很久');
  });

  it('内容未变时不应误置脏（否则保存按钮会无意义地常亮）', () => {
    useEditorStore.getState().load('同样的内容', 5);
    useEditorStore.getState().setBody('同样的内容');
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().rev).toBe(5);
  });

  it('完整保存周期：load → 编辑 → 脏 → markClean → 干净 → 再编辑 → 脏', () => {
    const s = useEditorStore.getState();
    s.load('v1', 1);
    expect(useEditorStore.getState().dirty).toBe(false);

    s.setBody('v2');
    expect(useEditorStore.getState().dirty).toBe(true);

    // 保存成功后主进程回传新 rev
    useEditorStore.getState().markClean(2);
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().rev).toBe(2);

    useEditorStore.getState().setBody('v3');
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('markClean 只清 dirty，不动 body（保存不应改写用户正在看的内容）', () => {
    useEditorStore.getState().load('正文', 1);
    useEditorStore.getState().setBody('正文已改');
    useEditorStore.getState().markClean(2);
    expect(useEditorStore.getState().body).toBe('正文已改');
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('删除到空串也算改动，必须置脏（清空全章是高危操作，不能不保存）', () => {
    useEditorStore.getState().load('一整章正文', 7);
    useEditorStore.getState().setBody('');
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().body).toBe('');
  });

  it('仅空白字符变化也置脏（中文排版里空格/换行是有意义的）', () => {
    useEditorStore.getState().load('第一段', 1);
    useEditorStore.getState().setBody('第一段\n');
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('setSaving 与 dirty 互不干扰', () => {
    useEditorStore.getState().load('x', 1);
    useEditorStore.getState().setBody('y');
    useEditorStore.getState().setSaving(true);
    expect(useEditorStore.getState().saving).toBe(true);
    expect(useEditorStore.getState().dirty).toBe(true); // 保存中仍是脏，直到 markClean
    useEditorStore.getState().setSaving(false);
    expect(useEditorStore.getState().saving).toBe(false);
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('load 会覆盖未保存的编辑并清脏（切章语义）——此行为需配合切章前的 dirty 守卫', () => {
    useEditorStore.getState().load('第一章', 1);
    useEditorStore.getState().setBody('第一章未保存的改动');
    expect(useEditorStore.getState().dirty).toBe(true);

    useEditorStore.getState().load('第二章', 1);
    expect(useEditorStore.getState().body).toBe('第二章');
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('rev 随 load 更新，供乐观锁回传', () => {
    useEditorStore.getState().load('a', 42);
    expect(useEditorStore.getState().rev).toBe(42);
    useEditorStore.getState().setBody('b');
    expect(useEditorStore.getState().rev).toBe(42); // 编辑不改 rev，只有保存成功才推进
  });
});

describe('project-store · 章节列表与当前章（与 dirty 语义相关的部分）', () => {
  const meta = (id: string, order: number): ChapterMeta => ({
    id,
    projectId: 'p1',
    title: `第${order}章`,
    volumeId: 'v1',
    order,
    status: 'draft',
    charCount: 100,
    rev: 1,
    updatedAt: 0,
  });

  beforeEach(() => {
    useProjectStore.setState({
      project: null,
      chapters: [],
      volumes: [],
      currentChapterId: null,
      loading: false,
      error: null,
    });
  });

  it('setChapters 在无当前章时自动选第一章（避免空白编辑器）', () => {
    useProjectStore.getState().setChapters([meta('c1', 1), meta('c2', 2)]);
    expect(useProjectStore.getState().currentChapterId).toBe('c1');
  });

  it('setChapters 保留仍然存在的当前章（切章不被列表刷新打断）', () => {
    useProjectStore.getState().setChapters([meta('c1', 1), meta('c2', 2)]);
    useProjectStore.getState().setCurrent('c2');
    useProjectStore.getState().setChapters([meta('c1', 1), meta('c2', 2), meta('c3', 3)]);
    expect(useProjectStore.getState().currentChapterId).toBe('c2');
  });

  it('当前章已被删除时回落到第一章，而非留下悬空 id', () => {
    useProjectStore.getState().setChapters([meta('c1', 1), meta('c2', 2)]);
    useProjectStore.getState().setCurrent('c2');
    useProjectStore.getState().setChapters([meta('c1', 1)]);
    expect(useProjectStore.getState().currentChapterId).toBe('c1');
  });

  it('空列表 → currentChapterId 归 null', () => {
    useProjectStore.getState().setChapters([meta('c1', 1)]);
    useProjectStore.getState().setChapters([]);
    expect(useProjectStore.getState().currentChapterId).toBeNull();
  });

  it('upsertChapterMeta 更新已有项、追加新项', () => {
    useProjectStore.getState().setChapters([meta('c1', 1)]);
    useProjectStore.getState().upsertChapterMeta({ ...meta('c1', 1), charCount: 999 });
    expect(useProjectStore.getState().chapters).toHaveLength(1);
    expect(useProjectStore.getState().chapters[0].charCount).toBe(999);

    useProjectStore.getState().upsertChapterMeta(meta('c2', 2));
    expect(useProjectStore.getState().chapters.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('setProject(null) 连带清空章节/分卷/当前章（关项目不留残影）', () => {
    useProjectStore.getState().setChapters([meta('c1', 1)]);
    useProjectStore.getState().setProject(null);
    expect(useProjectStore.getState().chapters).toEqual([]);
    expect(useProjectStore.getState().volumes).toEqual([]);
    expect(useProjectStore.getState().currentChapterId).toBeNull();
  });
});
