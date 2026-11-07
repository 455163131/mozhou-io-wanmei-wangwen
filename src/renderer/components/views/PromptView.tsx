/**
 * 提示词与技能（P2-A T4，DRD §4.1 系统组 / §3.2「提示词 = 内置基线 + 覆盖层」）。
 *
 * 三区块把已融进代码的资产摆到明面：
 *  ① 角色覆盖层列表：concept/architect/writer 三行可编辑（已覆盖/默认徽标 +
 *     温度值）；其余 6 角色（总编/扫榜/审稿/史官/润色/记忆管家）灰显说明行 +
 *     「待质检闭环接入后开放」——不画假入口（计划 Global Constraints 第 2 条）。
 *     soon 行走 **div + aria-disabled**，不用 disabled 属性：它是说明态不是死
 *     按钮，读屏器应能读到注记文本（disabled 会把子树移出无障碍树）。
 *  ② 编辑区（选中角色后展开）：温度输入（留空 = 内置默认，0~2 校验红字直报）、
 *     附加要求 textarea、「保存」（overlay:save）、「恢复默认」（二次确认后
 *     overlay:remove，删文件即恢复默认的文件机制）、overlay:get 的 warnings
 *     黄字逐条直报（损坏回退不静默吞）。追加口径（「基线 + \n\n【作者附加要求】\n
 *     + trim」）住在主进程 compose 层（T2），**本层不复制拼接逻辑**——只做
 *     一行提示文案，UI 里出现的任何"预览拼接"都不许成为第二份口径。
 *  ③ craft-skills 六卡（skills:list：标题/角色/触发词 chips/正文）+ 命中预览
 *     输入框（debounce 250ms 调 skills:match {text, role:'writer'}——与装配器
 *     同一内核的纯判定，UI 不重写触发词匹配），命中卡金描边 + 右侧命中列表。
 *
 * 通道纪律：只走 bridge()（window.mz 白名单），失败红字直报「code: message」，
 * detail.retryable===false 的空错也不画重试按钮（本层没有重试入口，改完再存
 * 就是重试）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, errorText, hasBridge } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { useConfirm } from '../common/ConfirmDialog';
import type { CraftSkillInfo, OverlayRole } from '@shared/types/ipc';
import styles from './PromptView.module.css';

/** 覆盖层开放的三角色（与 shared OverlayRole 联合逐字一致），label 与 GenView ROLE_LABEL 同词 */
const EDIT_ROLES: { role: OverlayRole; label: string }[] = [
  { role: 'concept', label: '构思' },
  { role: 'architect', label: '架构' },
  { role: 'writer', label: '写手' },
];

/** 尚未接入覆盖层的 6 角色（灰显说明行，不画可点入口） */
const SOON_ROLES = ['总编', '扫榜', '审稿', '史官', '润色', '记忆管家'];

const SKILL_ROLE_LABEL: Record<string, string> = {
  writer: '写手',
  architect: '架构',
  polisher: '润色',
};

/** overlay:get 的 UI 侧摘要（template 字段本层不用——恢复默认是删文件，不回填模板） */
interface OverlayState {
  exists: boolean;
  /** null = 沿用内置温度 */
  temperature: number | null;
  additional: string;
  warnings: string[];
}

/** 失败文案：直报「code: message」（与 GenView 同口径，不拟人化、不含糊） */
function failText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    return typeof code === 'string' && code ? `${code}: ${e.message}` : e.message;
  }
  return errorText(e);
}

async function fetchRole(role: OverlayRole): Promise<OverlayState> {
  const r = await bridge().overlay.get(role);
  return {
    exists: r.exists,
    temperature: r.overlay ? r.overlay.temperature : null,
    additional: r.overlay ? r.overlay.additional : '',
    warnings: r.warnings,
  };
}

export function PromptView(): JSX.Element {
  const [states, setStates] = useState<Partial<Record<OverlayRole, OverlayState>>>({});
  const [selected, setSelected] = useState<OverlayRole>('writer');
  const [tempText, setTempText] = useState('');
  const [additional, setAdditional] = useState('');
  /** 表单/操作红字（温度校验、保存失败） */
  const [fieldError, setFieldError] = useState<string | null>(null);
  /** 通道级失败红字（加载失败） */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [skills, setSkills] = useState<CraftSkillInfo[]>([]);
  const [hitText, setHitText] = useState('');
  const [hitIds, setHitIds] = useState<string[]>([]);

  /**
   * 请求序号守卫（终审 I-1）：见 lib/sequenced。角色切换是「切换即拉取」，
   * 慢的旧响应后到会盖掉新表单、保存即串档。故每次动作领一个序号，
   * await 回来后只有仍是最新的那一次才许落地——规则只有一条：**用户动作赢**。
   * 终审修复波并批#4：回到 T4/T6 同款 plain form——null! 占位常驻一条
   * no-non-null-assertion 警告；createSequencer() 每渲染空转一次的成本可忽略。
   */
  const seqRef = useRef(createSequencer());

  const { confirm, node: confirmNode } = useConfirm();

  /**
   * 首帧：三行覆盖层摘要 + 技能表一起拉。
   * ★ I-1：迟到的首帧不许盖掉用户已选角色——领号后判最新才回填。
   */
  useEffect(() => {
    if (!hasBridge()) {
      setLoadError('preload 未加载成功 —— 覆盖层与技能通道不可用。');
      return;
    }
    void (async () => {
      const seq = seqRef.current.next();
      try {
        const [concept, architect, writer, list] = await Promise.all([
          fetchRole('concept'),
          fetchRole('architect'),
          fetchRole('writer'),
          bridge().skills.list(),
        ]);
        if (!seqRef.current.isCurrent(seq)) return;
        setStates({ concept, architect, writer });
        setSkills(list);
        setTempText(writer.temperature === null ? '' : String(writer.temperature));
        setAdditional(writer.additional);
      } catch (e) {
        if (seqRef.current.isCurrent(seq)) setLoadError(failText(e));
      }
    })();
  }, []);

  /**
   * 选中角色：拉该角色最新覆盖层并回填表单（warnings 随 get 直报）。
   * ★ I-1：先领号——选中标题立即更新不滞后，但表单回填要等 await 回来后确认
   *   "我还是最新一次"才落地，否则慢的旧角色响应会盖掉用户刚点的选择。
   *   起手清 loadError：用户动作即消除上一次的加载红字（P2-A T4 minor 移交）。
   */
  const openRole = useCallback(async (role: OverlayRole): Promise<void> => {
    const seq = seqRef.current.next();
    setSelected(role);
    setFieldError(null);
    setLoadError(null);
    try {
      const st = await fetchRole(role);
      if (!seqRef.current.isCurrent(seq)) return;
      setStates((prev) => ({ ...prev, [role]: st }));
      setTempText(st.temperature === null ? '' : String(st.temperature));
      setAdditional(st.additional);
    } catch (e) {
      if (seqRef.current.isCurrent(seq)) setLoadError(failText(e));
    }
  }, []);

  /**
   * 命中预览：debounce 250ms 调 skills:match（role 固定 writer——通道只开放
   * writer/architect，写手是触发词匹配的主消费者）。空输入不发 RPC，直接清空。
   */
  useEffect(() => {
    const q = hitText.trim();
    if (!q || !hasBridge()) {
      setHitIds([]);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await bridge().skills.match(q, 'writer');
          setHitIds(r.ids);
        } catch {
          // 预览通道失败不打红字惊扰编辑：命中列表清空本身就是可见的「未命中」态
          setHitIds([]);
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [hitText]);

  async function onSave(): Promise<void> {
    setFieldError(null);
    const t = tempText.trim();
    let temperature: number | null = null;
    if (t !== '') {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        setFieldError('温度必须是 0~2 之间的数；留空表示沿用内置默认。');
        return;
      }
      temperature = n;
    }
    setBusy(true);
    try {
      await bridge().overlay.save(selected, temperature, additional);
      const st = await fetchRole(selected);
      setStates((prev) => ({ ...prev, [selected]: st }));
    } catch (e) {
      setFieldError(failText(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 恢复默认 = 删覆盖层文件（文件机制，T1 口径）；危险动作必须二次确认。
   * ★ Fix round1（I-1 同族）：确认与 remove/fetch 在途期间角色行并不禁点，
   *   迟到的恢复会把新选角色的表单清空、后续保存即写空串。故确认即领号，
   *   await 回来后判最新才许做无条件表单写；按键位写 setStates 本身 slot-safe 保留。
   */
  async function onRestoreDefault(): Promise<void> {
    const label = EDIT_ROLES.find((r) => r.role === selected)?.label ?? selected;
    const ok = await confirm({
      title: `恢复「${label}」默认提示词`,
      body: '将删除该角色的覆盖层文件，回到内置基线。你保存过的附加要求与温度覆盖会一并丢失。',
      warn: '这是有意变更：写手 prompt cache 会因此失效。',
      confirmText: '恢复默认',
      danger: true,
    });
    if (!ok) return;
    const seq = seqRef.current.next();
    setBusy(true);
    try {
      await bridge().overlay.remove(selected);
      const st = await fetchRole(selected);
      setStates((prev) => ({ ...prev, [selected]: st }));
      if (!seqRef.current.isCurrent(seq)) return;
      setTempText('');
      setAdditional('');
      setFieldError(null);
    } catch (e) {
      if (seqRef.current.isCurrent(seq)) setFieldError(failText(e));
    } finally {
      setBusy(false);
    }
  }

  const cur = states[selected];
  const hitTitles = skills.filter((s) => hitIds.includes(s.id));

  return (
    <div className={styles.wrap}>
      {loadError && <p className={styles.failBar}>{loadError}</p>}

      {/* ① 角色覆盖层列表 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>角色覆盖层</h3>
        <p className={styles.sectionHint}>
          内置基线之上追加你的固定要求；删除覆盖层文件即恢复默认。
        </p>
        <div className={styles.roleList} role="list">
          {EDIT_ROLES.map(({ role, label }) => {
            const st = states[role];
            const isSel = role === selected;
            return (
              <button
                key={role}
                type="button"
                className={`${styles.roleRow} ${isSel ? styles.roleOn : ''}`}
                aria-pressed={isSel}
                onClick={() => void openRole(role)}
              >
                <span className={styles.roleName}>{label}</span>
                {st && st.exists ? (
                  <span className={styles.badgeDone}>已覆盖</span>
                ) : (
                  <span className={styles.badgeDefault}>默认</span>
                )}
                <span className={styles.badgeTemp}>
                  {st ? (st.temperature === null ? '温度 内置' : `温度 ${st.temperature}`) : '温度 —'}
                </span>
              </button>
            );
          })}
          {SOON_ROLES.map((label) => (
            <div key={label} role="listitem" aria-disabled className={`${styles.roleRow} ${styles.roleSoon}`}>
              <span className={styles.roleName}>{label}</span>
              <span className={styles.soonNote}>待质检闭环接入后开放</span>
            </div>
          ))}
        </div>
      </section>

      {/* ② 编辑区（选中角色后展开） */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          编辑 · {EDIT_ROLES.find((r) => r.role === selected)?.label ?? selected}
        </h3>
        {cur ? (
          <div className={styles.editor}>
            {cur.warnings.length > 0 &&
              cur.warnings.map((w, i) => (
                <p key={`${w}-${i}`} className={styles.warnLine}>
                  {w}
                </p>
              ))}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>温度（0~2）</span>
              <input
                className={styles.input}
                type="text"
                inputMode="decimal"
                value={tempText}
                placeholder="留空=内置默认"
                onChange={(e) => setTempText(e.target.value)}
              />
            </label>
            {fieldError && <p className={styles.errText}>{fieldError}</p>}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>附加要求</span>
              <textarea
                className={styles.textarea}
                value={additional}
                placeholder="写手/架构/构思之外没有的固定要求，每次生成都带上这段…"
                onChange={(e) => setAdditional(e.target.value)}
              />
            </label>
            <p className={styles.hintLine}>
              覆盖层会追加到该角色 system 末尾；改动会使写手 prompt cache 失效。
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.btnPrimary} disabled={busy} onClick={() => void onSave()}>
                保存
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                disabled={busy || !cur.exists}
                onClick={() => void onRestoreDefault()}
              >
                恢复默认
              </button>
            </div>
          </div>
        ) : (
          <p className={styles.hintLine}>覆盖层加载中…</p>
        )}
      </section>

      {/* ③ craft-skills 六卡 + 命中预览 */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>工艺技能（craft-skills）</h3>
        <p className={styles.sectionHint}>
          触发词命中的写法守则会自动注入写手上下文；这里输入一段话即可预览命中结果。
        </p>
        <div className={styles.hitRow}>
          <input
            className={`${styles.input} ${styles.hitInput}`}
            type="text"
            value={hitText}
            placeholder="输入正文片段或需求描述（如：写一章带钩子的对话对峙）…"
            onChange={(e) => setHitText(e.target.value)}
          />
          <div className={styles.hitList} aria-live="polite">
            {hitText.trim() === '' ? (
              <span className={styles.hitEmpty}>输入后实时预览</span>
            ) : hitTitles.length === 0 ? (
              <span className={styles.hitEmpty}>暂无命中</span>
            ) : (
              hitTitles.map((s) => (
                <span key={s.id} className={styles.hitItem}>
                  {s.title}
                </span>
              ))
            )}
          </div>
        </div>
        <div className={styles.skillsGrid}>
          {skills.map((s) => (
            <article
              key={s.id}
              className={`${styles.card} ${hitIds.includes(s.id) ? styles.cardHit : ''}`}
            >
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>{s.title}</span>
                <span className={styles.cardRoles}>{s.roles.map((r) => SKILL_ROLE_LABEL[r] ?? r).join(' / ')}</span>
              </div>
              <div className={styles.chips}>
                {s.triggers.map((t) => (
                  <span key={t} className={styles.chip}>
                    {t}
                  </span>
                ))}
              </div>
              <p className={styles.cardBody}>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      {confirmNode}
    </div>
  );
}
