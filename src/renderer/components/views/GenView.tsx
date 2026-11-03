/**
 * 生成模式（P0 T6）：立项参数 + 分步执行 + 草稿采纳/丢弃。
 *
 * 让用户在 UI 里跑通「空库 → 第一章草稿 → 采纳」的最短路径，三区块：
 *
 *  ① 立项卡：genre/platform/chapterWords 经 `project:set-gen` 写 v12 真列
 *     （数值口径在 ProjectRepo.setPipelineParams：拒非整数/负数）。
 *     targetWords/premise **只读展示**——前者建项目时定（services.pipelineCtx
 *     缺省兜 30 万），后者由已采纳构思的 logline 回填，两者都没有写通道，
 *     这里不给假入口（画一个存不进去的输入框比不画更糟）。
 *  ② 执行卡：三按钮直调 T5 六通道；busy 各键独立；订阅 pipeline:progress
 *     推送（SUBSCRIBE_CHANNELS 已含），失败红字直报 e.message（含 error code，
 *     不拟人化、不含糊）。
 *  ③ 草稿卡：pending 列表（kind/role/时间/前 80 字预览）+ 采纳/丢弃。
 *     采纳 chapter 草稿 = 正文入正稿唯一入口，成功后刷新章节树
 *     （setChapters → App 挂在 chapters 上的 dash 重算订阅会跟着走）。
 *
 * ★ store 用 usePipelineStore（immer+subscribeWithSelector），全部 selector 订阅
 *   ——progress 每条推送都写一次，无选择器会让整棵视图树跟着每条推送重渲染。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, errorText, hasBridge } from '../../hooks/use-mz-bridge';
import { useProjectStore } from '../../store';
import { usePipelineStore } from '../../store/pipeline';
import type { Draft } from '@shared/types/pipeline';
import styles from './GenView.module.css';

const KIND_LABEL: Record<string, string> = { concept: '构思', outline: '大纲', chapter: '正文' };
const ROLE_LABEL: Record<string, string> = { concept: '构思', architect: '架构', writer: '写手' };
const STEP_LABEL: Record<string, string> = {
  concept: '构思',
  outline: '卷纲章纲',
  draft: '正文草稿',
  adopt: '采纳',
};

/** 失败文案：直报「code: message」。preload 已把 __mzError 转成带 code 的 Error。 */
function failText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    return typeof code === 'string' && code ? `${code}: ${e.message}` : e.message;
  }
  return errorText(e);
}

export function GenView(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const setChapters = useProjectStore((s) => s.setChapters);
  const drafts = usePipelineStore((s) => s.drafts);
  const busy = usePipelineStore((s) => s.busy);
  const progress = usePipelineStore((s) => s.progress);
  const progressFailed = usePipelineStore((s) => s.progressFailed);
  const setDrafts = usePipelineStore((s) => s.setDrafts);
  const setBusy = usePipelineStore((s) => s.setBusy);
  const setProgress = usePipelineStore((s) => s.setProgress);

  // 立项表单（本地态；保存成功后用 set-gen 回读的库内真值对齐）
  const [genre, setGenre] = useState('');
  const [platform, setPlatform] = useState('');
  const [chapterWords, setChapterWords] = useState('');
  // 写第 N 章的入参（chapterNo 从 1 起算；planItem 两项都是契约必填）
  const [chapterNo, setChapterNo] = useState('1');
  const [chTitle, setChTitle] = useState('');
  const [chHook, setChHook] = useState('');

  const pid = project?.id ?? null;

  const refreshDrafts = useCallback(async () => {
    if (!pid || !hasBridge()) return;
    try {
      setDrafts(await bridge().pipeline.listDrafts(pid, 'pending'));
    } catch (e) {
      setProgress(`失败：${failText(e)}`, true);
    }
  }, [pid, setDrafts, setProgress]);

  /** 挂载：拉一次 pending 草稿 + 订阅 progress 推送（卸载必须退订） */
  useEffect(() => {
    void refreshDrafts();
    if (!hasBridge()) return;
    const off = bridge().pipeline.onProgress((p) => {
      // R13 守卫：切换项目后，前一本书的 progress 推送不许串写当前状态行
      if (p.projectId !== pid) return;
      const step = STEP_LABEL[p.step] ?? p.step;
      if (p.state === 'failed') {
        // failed 的 detail 由主进程拼成「code: message」真因，原样红字直报
        setProgress(`失败（${step}）：${p.detail ?? '无详情'}`, true);
      } else if (p.state === 'running') {
        setProgress(`${step}：执行中…`);
      } else {
        setProgress(`${step}：完成`);
      }
      if (p.state === 'done') void refreshDrafts();
    });
    return off;
  }, [refreshDrafts, setProgress]);

  /** 三执行按钮与参数保存共用的包装：busy 上锁 → 状态行 → 失败红字 → 成功刷草稿 */
  const run = useCallback(
    async (key: string, label: string, fn: () => Promise<void>, okMsg: string) => {
      setBusy(key, true);
      setProgress(`${label}：执行中…`);
      try {
        await fn();
        setProgress(okMsg);
        await refreshDrafts();
      } catch (e) {
        setProgress(`失败：${failText(e)}`, true);
      } finally {
        setBusy(key, false);
      }
    },
    [refreshDrafts, setBusy, setProgress],
  );

  const saveParams = (): void => {
    if (!pid) return;
    // 空串 = 未设定（库里 0 就是未设定，services.pipelineCtx 会回退 2000 兜底）
    const words = chapterWords.trim() === '' ? 0 : Number(chapterWords);
    if (!Number.isInteger(words) || words < 0) {
      setProgress('失败：E_INVALID_ARGS: 单章字数必须是非负整数（留空 = 未设定）', true);
      return;
    }
    void run(
      'params',
      '保存立项参数',
      async () => {
        const r = await bridge().project.setGen(pid, genre.trim(), platform.trim(), words);
        // 用库内真值对齐表单：用户看到的就是下一次生成实际吃到的参数
        setGenre(r.genre);
        setPlatform(r.platform);
        setChapterWords(r.chapterWords > 0 ? String(r.chapterWords) : '');
      },
      '立项参数已保存',
    );
  };

  const onConcept = (): void => {
    if (!pid) return;
    void run('concept', '生成构思', async () => {
      await bridge().pipeline.runConcept(pid);
    }, '构思草稿已生成，请在草稿区采纳');
  };

  const onOutline = (): void => {
    if (!pid) return;
    void run('outline', '生成卷纲章纲', async () => {
      await bridge().pipeline.runOutline(pid);
    }, '大纲草稿已生成，请在草稿区采纳');
  };

  const onDraft = (): void => {
    if (!pid) return;
    const no = Number(chapterNo);
    if (!Number.isInteger(no) || no < 1) {
      setProgress('失败：E_INVALID_ARGS: 章节号必须是正整数（从 1 起算）', true);
      return;
    }
    const title = chTitle.trim();
    const hook = chHook.trim();
    if (!title || !hook) {
      setProgress('失败：E_INVALID_ARGS: 章节标题与钩子不能为空', true);
      return;
    }
    void run('draft', `写第${no}章草稿`, async () => {
      await bridge().pipeline.writeDraft(pid, no, { title, hook });
    }, '正文草稿已生成，请在草稿区采纳');
  };

  const adopt = async (d: Draft): Promise<void> => {
    const key = `adopt:${d.id}`;
    setBusy(key, true);
    try {
      const r = await bridge().pipeline.adoptDraft(d.id);
      if (r.chapterId) {
        // 采纳 chapter 草稿 → 正文已入正稿：刷新章节树
        setChapters(await bridge().chapter.list());
        setProgress(`已采纳：写入第 ${r.chapterId} 章`);
      } else {
        setProgress('已采纳（作为后续生成步骤的输入）');
      }
      await refreshDrafts();
    } catch (e) {
      setProgress(`失败：${failText(e)}`, true);
    } finally {
      setBusy(key, false);
    }
  };

  const discard = async (d: Draft): Promise<void> => {
    const key = `discard:${d.id}`;
    setBusy(key, true);
    try {
      await bridge().pipeline.discardDraft(d.id);
      setProgress('已丢弃（单向终局，不可改判）');
      await refreshDrafts();
    } catch (e) {
      setProgress(`失败：${failText(e)}`, true);
    } finally {
      setBusy(key, false);
    }
  };

  if (!project) {
    return (
      <div className={styles.wrap}>
        <p className={styles.empty}>请先打开项目（点击顶栏书名选择目录），再进入生成模式。</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.crumb}>
        <b>生成</b>
        <span className={styles.sep}>·</span>
        <span>《{project.name}》立项 → 构思 → 大纲 → 正文草稿 → 采纳入正稿</span>
      </div>

      {progress && (
        <p className={progressFailed ? styles.progressFail : styles.progress} role="status">
          {progress}
        </p>
      )}

      {/* ① 立项卡 */}
      <section className={styles.card}>
        <h2 className={styles.cardHead}>立项参数</h2>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>题材</span>
            <input
              className={styles.input}
              value={genre}
              maxLength={40}
              disabled={busy.params}
              placeholder="如「古风玄幻」，留空 = 未设定"
              aria-label="题材"
              onChange={(e) => setGenre(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>平台</span>
            <input
              className={styles.input}
              value={platform}
              maxLength={40}
              disabled={busy.params}
              placeholder="如「番茄」，留空 = 未设定"
              aria-label="平台"
              onChange={(e) => setPlatform(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>单章字数</span>
            <input
              className={styles.input}
              value={chapterWords}
              inputMode="numeric"
              disabled={busy.params}
              placeholder="如 2000，留空 = 未设定（兜 2000）"
              aria-label="单章字数"
              onChange={(e) => setChapterWords(e.target.value)}
            />
          </label>
        </div>
        <div className={styles.readonly}>
          <span>全书目标字数：{project.targetWords > 0 ? `${project.targetWords.toLocaleString()} 字` : '未设定（生成时兜 30 万）'}</span>
          <span>作者前提（premise）：由已采纳构思的卖点回填，无独立入口</span>
        </div>
        <div className={styles.row}>
          <button className={styles.btnPrimary} onClick={saveParams} disabled={busy.params}>
            {busy.params ? '保存中…' : '保存立项参数'}
          </button>
        </div>
      </section>

      {/* ② 执行卡 */}
      <section className={styles.card}>
        <h2 className={styles.cardHead}>分步执行</h2>
        <div className={styles.row}>
          <button className={styles.btn} onClick={onConcept} disabled={busy.concept}>
            {busy.concept ? '构思生成中…' : '生成构思'}
          </button>
          <button className={styles.btn} onClick={onOutline} disabled={busy.outline}>
            {busy.outline ? '大纲生成中…' : '生成卷纲章纲'}
          </button>
        </div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>章节号</span>
            <input
              className={styles.input}
              value={chapterNo}
              inputMode="numeric"
              disabled={busy.draft}
              aria-label="章节号"
              onChange={(e) => setChapterNo(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>本章标题</span>
            <input
              className={styles.input}
              value={chTitle}
              maxLength={60}
              disabled={busy.draft}
              placeholder="如「雾中拾玉」"
              aria-label="本章标题"
              onChange={(e) => setChTitle(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>本章钩子</span>
            <input
              className={styles.input}
              value={chHook}
              maxLength={120}
              disabled={busy.draft}
              placeholder="如「玉佩里传出心跳声」"
              aria-label="本章钩子"
              onChange={(e) => setChHook(e.target.value)}
            />
          </label>
        </div>
        <div className={styles.row}>
          <button className={styles.btn} onClick={onDraft} disabled={busy.draft}>
            {busy.draft ? `第${chapterNo || '?'}章写作中…` : `写第${chapterNo || 'N'}章草稿`}
          </button>
        </div>
      </section>

      {/* ③ 草稿卡 */}
      <section className={styles.card}>
        <h2 className={styles.cardHead}>草稿区（pending {drafts.length} 条）</h2>
        {drafts.length === 0 ? (
          <p className={styles.empty}>
            暂无待处理草稿。产物只进草稿隔离区——采纳才入正稿（定稿主权在你）。
          </p>
        ) : (
          <ul className={styles.drafts}>
            {drafts.map((d) => (
              <li key={d.id} className={styles.draft}>
                <div className={styles.draftTop}>
                  <span className={styles.kind}>{KIND_LABEL[d.kind] ?? d.kind}</span>
                  <span className={styles.role}>{ROLE_LABEL[d.role] ?? d.role}</span>
                  <span className={styles.time}>{new Date(d.createdAt).toLocaleString()}</span>
                </div>
                <p className={styles.preview}>{d.content.slice(0, 80)}{d.content.length > 80 ? '…' : ''}</p>
                <div className={styles.actions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={busy[`adopt:${d.id}`] || busy[`discard:${d.id}`]}
                    onClick={() => void adopt(d)}
                  >
                    {busy[`adopt:${d.id}`] ? '采纳中…' : '采纳'}
                  </button>
                  <button
                    className={styles.btn}
                    disabled={busy[`adopt:${d.id}`] || busy[`discard:${d.id}`]}
                    onClick={() => void discard(d)}
                  >
                    {busy[`discard:${d.id}`] ? '丢弃中…' : '丢弃'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
