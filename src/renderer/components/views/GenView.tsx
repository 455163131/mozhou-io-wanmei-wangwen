/**
 * 生成模式（P0 T6）：立项参数 + 世界观铁律 + 分步执行 + 草稿采纳/丢弃。
 *
 * 让用户在 UI 里跑通「空库 → 第一章草稿 → 采纳」的最短路径，四区块：
 *
 *  ① 立项卡：genre/platform/chapterWords/language 经 `project:set-gen` 写 v12/v14
 *     真列（数值口径在 ProjectRepo.setPipelineParams：拒非整数/负数；language
 *     只收 'zh'|'en'）。P1-B T4：platform 从自由文本换成 PLATFORM_RULES 分组
 *     select（国内/海外两个 optgroup，选项即规则包 name——buildPipelineCtx 按
 *     name/id 匹配平台规则包）；language 单选 zh/en（缺省 zh，与库列缺省一致）。
 *     targetWords/premise **只读展示**——前者建项目时定（services.pipelineCtx
 *     缺省兜 30 万），后者由已采纳构思的 logline 回填，两者都没有写通道，
 *     这里不给假入口（画一个存不进去的输入框比不画更糟）。
 *  ② 铁律卡（canon，P1-A T4）：保护层真数据源的录入入口。挂载拉 canon:list；
 *     输入框+添加按钮走 canon:add（清洗口径在 CanonRepo，本层不复制）；
 *     每行删除按钮走 canon:remove（幂等收尾），成功后刷新列表。
 *     失败红字直报「code: message」；detail.retryable===false 时不画重试
 *     按钮（空文本重试一万次还是空文本，minor-1 口径）。
 *  ③ 执行卡：三按钮直调 T5 六通道；busy 各键独立；订阅 pipeline:progress
 *     推送（SUBSCRIBE_CHANNELS 已含），失败红字直报 e.message（含 error code，
 *     不拟人化、不含糊）。
 *  ④ 草稿卡：pending 列表（kind/role/时间/前 80 字预览）+ 采纳/丢弃。
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
import type { CanonEntry, Draft } from '@shared/types/pipeline';
import { PLATFORM_RULES } from '@shared/constants/platforms';
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

/**
 * P1-A T4：错误是否值得重试——preload 把 MzError 的 detail 原样挂在 Error 上。
 * detail.retryable===false 时不画重试按钮（minor-1 口径：空文本重试一万次
 * 还是空文本）；detail 缺席或 retryable 非 false 一律按可重试处理。
 */
function retryableOf(e: unknown): boolean {
  const detail = e instanceof Error ? (e as Error & { detail?: unknown }).detail : undefined;
  return (detail as { retryable?: unknown } | undefined)?.retryable !== false;
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
  // language 单选 zh/en（P1-B T4）：缺省 zh，与 v14 库列 DEFAULT 'zh' 一致
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  // 写第 N 章的入参（chapterNo 从 1 起算；planItem 两项都是契约必填）
  const [chapterNo, setChapterNo] = useState('1');
  const [chTitle, setChTitle] = useState('');
  const [chHook, setChHook] = useState('');
  // 铁律 canon（P1-A T4）：列表本地态；busy 走 pipeline store（键
  // 'canonAdd' / `canonRemove:${id}`，与 adopt/discard 同口径）。
  const [canon, setCanon] = useState<CanonEntry[]>([]);
  const [canonText, setCanonText] = useState('');
  // 失败红字（code: message）；retry 仅在 detail.retryable!==false 时给出
  const [canonErr, setCanonErr] = useState<{ text: string; retry?: () => void } | null>(null);

  const pid = project?.id ?? null;

  const refreshDrafts = useCallback(async () => {
    if (!pid || !hasBridge()) return;
    try {
      setDrafts(await bridge().pipeline.listDrafts(pid, 'pending'));
    } catch (e) {
      setProgress(`失败：${failText(e)}`, true);
    }
  }, [pid, setDrafts, setProgress]);

  /** canon 列表刷新（挂载拉一次；add/remove 成功后再拉——列表永远来自库，不做本地增删） */
  const refreshCanon = useCallback(async (): Promise<void> => {
    if (!pid || !hasBridge()) return;
    try {
      setCanon(await bridge().canon.list(pid));
    } catch (e) {
      setCanonErr({
        text: `失败：${failText(e)}`,
        retry: retryableOf(e) ? () => void refreshCanon() : undefined,
      });
    }
  }, [pid]);

  /** 添加铁律：清洗口径在 CanonRepo（trim/去空行/判空），本层不复制、失败直报真因 */
  const submitCanon = useCallback(
    async (raw: string): Promise<void> => {
      if (!pid || !hasBridge()) return;
      const text = raw.trim();
      if (!text) {
        // 本地预检与 repo 同文案口径；不可重试（retryable:false 语义 → 不画重试按钮）
        setCanonErr({ text: '失败：E_INVALID_ARGS: canon 条目不能为空' });
        return;
      }
      setBusy('canonAdd', true);
      try {
        await bridge().canon.add(pid, text);
        setCanonText('');
        setCanonErr(null);
        await refreshCanon();
      } catch (e) {
        setCanonErr({
          text: `失败：${failText(e)}`,
          retry: retryableOf(e) ? () => void submitCanon(text) : undefined,
        });
      } finally {
        setBusy('canonAdd', false);
      }
    },
    [pid, refreshCanon, setBusy],
  );

  /** 删除铁律：remove 后刷新列表（remove 幂等，不存在也不炸——repo 口径） */
  const removeCanon = useCallback(
    async (entry: CanonEntry): Promise<void> => {
      if (!pid || !hasBridge()) return;
      setBusy(`canonRemove:${entry.id}`, true);
      try {
        await bridge().canon.remove(pid, entry.id);
        setCanonErr(null);
        await refreshCanon();
      } catch (e) {
        setCanonErr({
          text: `失败：${failText(e)}`,
          retry: retryableOf(e) ? () => void removeCanon(entry) : undefined,
        });
      } finally {
        setBusy(`canonRemove:${entry.id}`, false);
      }
    },
    [pid, refreshCanon, setBusy],
  );

  /** 挂载：拉一次 pending 草稿 + canon 列表 + 订阅 progress 推送（卸载必须退订） */
  useEffect(() => {
    void refreshDrafts();
    void refreshCanon();
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
  }, [pid, refreshCanon, refreshDrafts, setProgress]);

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
      setProgress(`失败：E_INVALID_ARGS: ${language === 'en' ? '单章词数' : '单章字数'}必须是非负整数（留空 = 未设定）`, true);
      return;
    }
    void run(
      'params',
      '保存立项参数',
      async () => {
        const r = await bridge().project.setGen(pid, genre.trim(), platform.trim(), words, language);
        // 用库内真值对齐表单：用户看到的就是下一次生成实际吃到的参数
        setGenre(r.genre);
        setPlatform(r.platform);
        setChapterWords(r.chapterWords > 0 ? String(r.chapterWords) : '');
        setLanguage(r.language);
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
            <select
              className={styles.input}
              value={platform}
              disabled={busy.params}
              aria-label="平台"
              onChange={(e) => setPlatform(e.target.value)}
            >
              {/* 空值 = 未设定（buildPipelineCtx 匹配不到规则包 → 不注入平台段） */}
              <option value="">未设定</option>
              <optgroup label="国内">
                {PLATFORM_RULES.filter((p) => p.market === 'cn').map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </optgroup>
              <optgroup label="海外">
                {PLATFORM_RULES.filter((p) => p.market === 'overseas').map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{language === 'en' ? '单章词数' : '单章字数'}</span>
            <input
              className={styles.input}
              value={chapterWords}
              inputMode="numeric"
              disabled={busy.params}
              placeholder="如 2000，留空 = 未设定（兜 2000）"
              aria-label={language === 'en' ? '单章词数' : '单章字数'}
              onChange={(e) => setChapterWords(e.target.value)}
            />
          </label>
        </div>
        {/* language 单选 zh/en（P1-B T4）：进立项卡，随 set-gen 落库 v14 language 列。
            fieldset 只做语义分组（不带 disabled——两个 radio 各自带 disabled 已足够，
            避免多出一个 fieldset 禁用宿主）。 */}
        <fieldset className={styles.langSet}>
          <legend className={styles.label}>语言</legend>
          <label className={styles.langOpt}>
            <input
              type="radio"
              name="gen-language"
              value="zh"
              checked={language === 'zh'}
              disabled={busy.params}
              onChange={() => setLanguage('zh')}
            />
            <span>中文（zh）</span>
          </label>
          <label className={styles.langOpt}>
            <input
              type="radio"
              name="gen-language"
              value="en"
              checked={language === 'en'}
              disabled={busy.params}
              onChange={() => setLanguage('en')}
            />
            <span>English（en）</span>
          </label>
        </fieldset>
        <div className={styles.readonly}>
          <span>全书目标字数：{project.targetWords > 0 ? `${project.targetWords.toLocaleString()} ${language === 'en' ? 'words（词）' : '字'}` : '未设定（生成时兜 30 万）'}</span>
          <span>作者前提（premise）：由已采纳构思的卖点回填，无独立入口</span>
        </div>
        <div className={styles.row}>
          <button className={styles.btnPrimary} onClick={saveParams} disabled={busy.params}>
            {busy.params ? '保存中…' : '保存立项参数'}
          </button>
        </div>
      </section>

      {/* ② 铁律卡（canon，P1-A T4）：保护层真数据源的录入入口 */}
      <section className={styles.card}>
        <h2 className={styles.cardHead}>世界观铁律（canon {canon.length} 条）</h2>
        {canon.length === 0 ? (
          <p className={styles.empty}>还没有铁律：保护层空转，史官查穿帮会少一层依据</p>
        ) : (
          <ul className={styles.canonList}>
            {canon.map((c) => (
              <li key={c.id} className={styles.canonRow}>
                <span className={styles.canonText}>{c.text}</span>
                <button
                  className={styles.btn}
                  disabled={busy[`canonRemove:${c.id}`] || busy.canonAdd}
                  aria-label={`删除铁律：${c.text.slice(0, 20)}`}
                  onClick={() => void removeCanon(c)}
                >
                  {busy[`canonRemove:${c.id}`] ? '删除中…' : '删除'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.canonAdd}>
          <input
            className={styles.input}
            value={canonText}
            disabled={busy.canonAdd}
            placeholder="如「玉佩内时间流速 3000:3，不可逆」"
            aria-label="铁律文本"
            onChange={(e) => setCanonText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy.canonAdd) void submitCanon(canonText);
            }}
          />
          <button className={styles.btnPrimary} disabled={busy.canonAdd} onClick={() => void submitCanon(canonText)}>
            {busy.canonAdd ? '添加中…' : '添加铁律'}
          </button>
        </div>
        {canonErr && (
          <div className={styles.canonErrRow}>
            <p className={styles.progressFail} role="alert">{canonErr.text}</p>
            {/* detail.retryable===false 不画重试按钮：重试不会让非法输入变合法 */}
            {canonErr.retry && (
              <button className={styles.btn} disabled={busy.canonAdd} onClick={canonErr.retry}>
                重试
              </button>
            )}
          </div>
        )}
      </section>

      {/* ③ 执行卡 */}
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

      {/* ④ 草稿卡 */}
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
