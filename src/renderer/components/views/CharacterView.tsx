/**
 * 人物记忆页（mode: characters，P2-B T6）。
 *
 * 数据面（全部复用既有通道，一页一条也不新开）：
 *   · 取数：`ledger.query('all')` → res.characters（与伏笔同读一本账）；
 *   · 手改：`ledger.patch({kind:'character'})`——五个档案 textarea + knows/notKnows
 *     条列 + relations 数组，**一次调用**带走白名单字段（结构字段 id/refs/updatedAt
 *     不碰，改了就是伪造出处链，见 ledger-repo 的 PATCH_WHITELIST 注释）；
 *   · 新建：`ledger.upsert` 单条，id 走 `nextId('chr')`（与 Agent 侧 ledger-update
 *     同一形状同一把闸）；
 *   · 矩阵：`charstate.list(projectId)` 读全部快照、`charstate.set` 写一格
 *     （同人同章覆盖、空快照主进程拒收；charstate 没有删除通道——只覆盖不清账，
 *     所以 UI 也不提供"清空格"，免得造出一条不存在的写路径）；
 *   · 正文：本页一条也不写，章号列头直接吃 store.chapters 的 ord 序（R13 口径，
 *     章序 = 下标 + 1，同 ForeshadowView 的 noOf）。
 *
 * 布局照原型 06-character.html：三栏 = 左人物列表 / 中人物卡（显示+编辑两态，
 * 手录字段缺省显「未登记」，不替作者编设定）/ 右章×人矩阵（空格只显「—」，
 * 点格弹 modal 编辑快照）；底部关系图谱为纯 SVG 环形布局（angle = 2πi/N，
 * 不引第三方图库——package.json 零新增依赖被 wiring 测试钉死），边带宽容 hit 区
 * 与 <title>，点边在右侧详情行显 label + 第 N 章 / 未标章。
 * 色与间距一律 var(--mz-*) 令牌（wiring 测试与 theme-ink C 组钉死零裸色）。
 *
 * 异步纪律（T4 审查修复波同款，不再重犯）：openProject 换书不重挂载本页——
 * 初始 load 键在 project?.id 上（R13/GenView 口径）；load 持一条 sequencer，
 * 切书先清旧书数据并作废在途请求；保存（patch/set/upsert）统一经 runWrite→load
 * 复用同一守卫，await 回来判最新才许落状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { bridge, errorText } from '../../hooks/use-mz-bridge';
import { createSequencer } from '../../lib/sequenced';
import { useProjectStore, useSnapshotHandoff } from '../../store';
import type { CharState, CharacterProfile } from '@shared/types/ledger';
import { MODE_LABELS } from '@shared/constants/modes';
import { nextId } from '@shared/util/id';
import styles from './CharacterView.module.css';

interface RelationItem {
  to: string;
  label: string;
  chapter?: number;
}

type Modal =
  | { kind: 'add' }
  | { kind: 'cell'; characterId: string; characterName: string; chapterNo: number; snapshot: string }
  | null;

interface EdgeDetail {
  /** `甲 · 乙`——两个人物名 */
  title: string;
  label: string;
  /** 登记的生效章；null = 未标章 */
  chapter: number | null;
}

/** 人物名首字（头像圈里的字）；空名理论上进不了库（name 是索引列），兜底给「？」 */
function initial(name: string): string {
  const t = (name ?? '').trim();
  return t === '' ? '？' : [...t][0];
}

export function CharacterView(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const chapters = useProjectStore((s) => s.chapters);
  const [chars, setChars] = useState<CharacterProfile[]>([]);
  const [states, setStates] = useState<CharState[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [edgeInfo, setEdgeInfo] = useState<EdgeDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 竞态守卫（I-1 同族，sequenced T1）：load 是唯一异步取数面；
  // 三条保存路径都经 runWrite→load 回来，共用这一条序号链判最新。
  const loadSeqRef = useRef(createSequencer());

  const pid = project?.id ?? null;

  const load = useCallback(async () => {
    const seq = loadSeqRef.current.next();
    setBusy(true);
    setErr(null);
    try {
      const api = bridge();
      if (!api) throw new Error('未连接到主进程');
      const r = await api.ledger.query('all');
      let st: CharState[] = [];
      if (pid) st = await api.charstate.list(pid);
      if (!loadSeqRef.current.isCurrent(seq)) return;
      setChars(r.characters);
      setStates(st);
    } catch (e) {
      if (loadSeqRef.current.isCurrent(seq)) setErr(errorText(e));
    } finally {
      if (loadSeqRef.current.isCurrent(seq)) setBusy(false);
    }
  }, [pid]);

  useEffect(() => {
    // ★ R13 同款切换守卫（GenView/ForeshadowView 口径）：openProject 原地换
    //   project+chapters、modeHost 不重挂载——切书先清旧书数据与选择、作废在途
    //   load，再按新书重取；矩阵列头跟着 store.chapters 走，不键它（键两个会双载）。
    setChars([]);
    setStates([]);
    setSelId(null);
    setEdgeInfo(null);
    setModal(null);
    loadSeqRef.current.next();
    void load();
  }, [pid, load]);

  /**
   * ★ P2-E ②：长期记忆页「载入编辑器」的交接草稿在这里消费——取数完成（busy=false）
   * 后开既有 cell 弹窗预填快照，take 读一次即清；保存仍走 charstate:set 由作者确认。
   * 人物已删/跨书草稿找不到人：如实报错不静默吞（草稿已被 take 清掉，不会反复弹）。
   */
  const handoffDraft = useSnapshotHandoff((s) => s.draft);
  useEffect(() => {
    if (!handoffDraft || busy) return;
    const d = useSnapshotHandoff.getState().take();
    if (!d) return;
    const ch = chars.find((c) => c.id === d.characterId);
    if (!ch) {
      setErr('快照对应的人物已不存在（可能已被删除或属于另一本书），未载入编辑器。');
      return;
    }
    setSelId(ch.id);
    setModal({ kind: 'cell', characterId: ch.id, characterName: ch.name, chapterNo: d.chapterNo, snapshot: d.snapshot });
  }, [handoffDraft, busy, chars]);

  /** 没选中就回落第一位（原型口径）；删书清空后为 null。 */
  const sel = chars.find((c) => c.id === selId) ?? chars[0] ?? null;

  function stateFor(characterId: string, no: number): CharState | undefined {
    return states.find((s) => s.characterId === characterId && s.chapterNo === no);
  }

  async function runWrite(action: () => Promise<void>): Promise<void> {
    setSubmitting(true);
    try {
      await action();
      setModal(null);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** 卡片保存：八个白名单手录字段一次 patch 带走（name/refs/updatedAt 不在名单也不碰） */
  async function saveProfile(ch: CharacterProfile, patch: Record<string, unknown>): Promise<void> {
    await runWrite(async () => {
      await bridge().ledger.patch({ kind: 'character', id: ch.id, patch });
    });
  }

  /** 矩阵一格：同人同章覆盖；空快照主进程当场拒收（E_INVALID_ARGS），弹窗按钮同口径禁用 */
  async function saveCell(characterId: string, chapterNo: number, snapshot: string): Promise<void> {
    await runWrite(async () => {
      await bridge().charstate.set({ characterId, chapterNo, snapshot });
    });
  }

  /** 新建：upsert 单条骨架卡（id 与 Agent 侧同形），手录字段随后进卡片「编辑」补 */
  async function addChar(name: string, role: string): Promise<void> {
    const id = nextId('chr');
    await runWrite(async () => {
      await bridge().ledger.upsert({
        characters: [{ id, name, role, age: '', note: '', refs: [], updatedAt: Date.now() }],
      });
    });
    setSelId(id);
  }

  /* ── 关系图：环形布局（angle = 2πi/N），椭圆投影配 960×300 的宽 viewBox ── */

  const positions = useMemo(() => {
    const n = Math.max(1, chars.length);
    const cx = 480;
    const cy = 150;
    const rx = 380;
    const ry = 100;
    return chars.map((c, i) => {
      const angle = (2 * Math.PI * i) / n;
      return { c, x: cx + rx * Math.cos(angle - Math.PI / 2), y: cy + ry * Math.sin(angle - Math.PI / 2) };
    });
  }, [chars]);

  /** 边 = 各人物卡 relations 里目标仍在本表的条目；悬空 to（人物已删）跳过不画假线。 */
  const edges = useMemo(() => {
    const byId = new Map(positions.map((p) => [p.c.id, p]));
    const out: Array<{ key: string; from: (typeof positions)[number]; to: (typeof positions)[number]; rel: RelationItem }> = [];
    for (const p of positions) {
      const rels: RelationItem[] = p.c.relations ?? [];
      rels.forEach((rel, j) => {
        if (!rel || typeof rel.to !== 'string') return;
        const target = byId.get(rel.to);
        if (!target || target.c.id === p.c.id) return;
        if (typeof rel.label !== 'string' || rel.label.trim() === '') return;
        out.push({ key: `${p.c.id}:${j}`, from: p, to: target, rel });
      });
    }
    return out;
  }, [positions]);

  const latestNo = chapters.length;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{MODE_LABELS.characters}</span>
        <span className={styles.sub}>
          人物 {chars.length} · 快照 {states.length} · 共 {latestNo} 章
        </span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={busy} onClick={() => void load()}>
          {busy ? '…' : '刷新'}
        </button>
        <button className={styles.btnPrimary} onClick={() => setModal({ kind: 'add' })}>
          ＋ 新建人物
        </button>
      </div>

      {err && <p className={styles.err}>{err}</p>}

      <div className={styles.grid}>
        {/* 左栏：人物列表（name + role，缺省显「未登记」） */}
        <aside className={styles.col}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>人物档案</h3>
              <span className={styles.sub}>{chars.length} 人</span>
            </div>
            {!busy && chars.length === 0 && !err && (
              <div className={styles.empty}>
                台账里还没有人物。在对话里让 Agent 登记，或点右上「＋新建人物」
                先立一张卡，手录字段进卡片「编辑」再补。
              </div>
            )}
            <div className={styles.charList}>
              {chars.map((c) => (
                <button
                  key={c.id}
                  className={`${styles.charRow} ${sel?.id === c.id ? styles.charRowOn : ''}`}
                  onClick={() => setSelId(c.id)}
                >
                  <span className={styles.avatar}>{initial(c.name)}</span>
                  <span className={styles.charMeta}>
                    <b className={styles.charName}>{c.name}</b>
                    {c.role && c.role.trim() !== '' ? (
                      <span className={styles.charRole}>{c.role}</span>
                    ) : (
                      <span className={styles.unreg}>未登记</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        {/* 中栏：人物卡（key=人物 id：切人即重挂载，编辑草稿不带过书） */}
        <section className={styles.charCard}>
          {sel ? (
            <CharCard
              key={sel.id}
              ch={sel}
              all={chars}
              submitting={submitting}
              onSave={(patch) => void saveProfile(sel, patch)}
            />
          ) : (
            <p className={styles.empty}>左边点一个人物，卡片就在这里展开。</p>
          )}
        </section>

        {/* 右栏：章×人矩阵（行=人物、列=章号，格=快照有无） */}
        <aside className={styles.col}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h3 className={styles.cardTitle}>章×人状态矩阵</h3>
              <span className={styles.sub}>点单元格登记/覆盖该章快照</span>
            </div>
            {latestNo === 0 ? (
              <p className={styles.empty}>还没有章节——矩阵列头按章序展开才有数。</p>
            ) : (
              <div className={styles.matrixScroll}>
                <table className={styles.matrix}>
                  <thead>
                    <tr>
                      <th>人物</th>
                      {chapters.map((_, i) => (
                        <th key={i}>{i + 1}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {chars.map((c) => (
                      <tr key={c.id}>
                        <td className={sel?.id === c.id ? `${styles.mName} ${styles.mNameOn}` : styles.mName}>
                          {c.name}
                        </td>
                        {chapters.map((_, i) => {
                          const no = i + 1;
                          const cell = stateFor(c.id, no);
                          return (
                            <td key={no} className={styles.mCell}>
                              <button
                                className={cell ? styles.chip : `${styles.chip} ${styles.chipOff}`}
                                title={cell ? cell.snapshot : '该章未记账：点击登记快照'}
                                onClick={() =>
                                  setModal({
                                    kind: 'cell',
                                    characterId: c.id,
                                    characterName: c.name,
                                    chapterNo: no,
                                    snapshot: cell ? cell.snapshot : '',
                                  })
                                }
                              >
                                {cell ? cell.snapshot : '—'}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className={styles.note}>
              空格只显「—」：没记过快照就是没记过，本页不替人物编「当时处境」。
            </p>
          </section>
        </aside>
      </div>

      {/* 底部：关系图谱（纯 SVG 环形布局，边可点出详情） */}
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>人物关系图谱</h3>
          <span className={styles.sub}>点一条关系边，右侧显示它的标签与登记章</span>
        </div>
        {chars.length < 2 ? (
          <p className={styles.empty}>人物不足两位——环形布局要至少两个人才连得出边；先立两张卡。</p>
        ) : (
          <div className={styles.relGrid}>
            <svg className={styles.relSvg} viewBox="0 0 960 300" role="img" aria-label="人物关系环形图">
              {edges.map((e) => (
                <g
                  key={e.key}
                  className={styles.edge}
                  onClick={() =>
                    setEdgeInfo({
                      title: `${e.from.c.name} · ${e.to.c.name}`,
                      label: e.rel.label,
                      chapter:
                        typeof e.rel.chapter === 'number' && Number.isInteger(e.rel.chapter) && e.rel.chapter >= 1
                          ? e.rel.chapter
                          : null,
                    })
                  }
                >
                  <line className={styles.edgeLine} x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y} />
                  <line className={styles.edgeHit} x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}>
                    <title>{`${e.from.c.name} · ${e.to.c.name}：${e.rel.label}`}</title>
                  </line>
                  <text className={styles.edgeLabel} x={(e.from.x + e.to.x) / 2} y={(e.from.y + e.to.y) / 2 - 5} textAnchor="middle">
                    {e.rel.label}
                  </text>
                </g>
              ))}
              {positions.map((p) => (
                <g key={p.c.id}>
                  <circle className={styles.nodeCircle} cx={p.x} cy={p.y} r={20} />
                  <text className={styles.nodeInitial} x={p.x} y={p.y + 6} textAnchor="middle">
                    {initial(p.c.name)}
                  </text>
                  <text className={styles.nodeName} x={p.x} y={p.y - 28} textAnchor="middle">
                    {p.c.name}
                    {p.c.role && p.c.role.trim() !== '' ? ` · ${p.c.role}` : ''}
                  </text>
                </g>
              ))}
            </svg>
            <div className={styles.relPanel}>
              {!edgeInfo ? (
                <p className={styles.note}>还没点边。边上悬停有摘要，点击这里出详情。</p>
              ) : (
                <>
                  <div className={styles.relTitle}>{edgeInfo.title}</div>
                  <div className={styles.relLine}>{edgeInfo.label}</div>
                  <div className={styles.relLine}>{edgeInfo.chapter === null ? '未标章' : `第 ${edgeInfo.chapter} 章`}</div>
                </>
              )}
            </div>
          </div>
        )}
        {chars.length >= 2 && edges.length === 0 && (
          <p className={styles.note}>还没有可画的关系——在卡片「编辑」里为 TA 挂上与其他人物的关系。</p>
        )}
      </section>

      {modal?.kind === 'cell' && (
        <ModalCard title={`${modal.characterName} · 第 ${modal.chapterNo} 章 状态快照`} onClose={() => setModal(null)} submitting={submitting}>
          <CellBody
            initialSnapshot={modal.snapshot}
            submitting={submitting}
            onOk={(snapshot) => void saveCell(modal.characterId, modal.chapterNo, snapshot)}
            onCancel={() => setModal(null)}
          />
        </ModalCard>
      )}
      {modal?.kind === 'add' && (
        <ModalCard title="新建人物卡" onClose={() => setModal(null)} submitting={submitting}>
          <AddBody
            submitting={submitting}
            onOk={(name, role) => void addChar(name, role)}
            onCancel={() => setModal(null)}
          />
        </ModalCard>
      )}
    </div>
  );
}

/* ───────────────────────── 人物卡（显示 / 编辑两态） ───────────────────────── */

function CharCard(props: {
  ch: CharacterProfile;
  all: CharacterProfile[];
  submitting: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}): JSX.Element {
  const { ch } = props;
  const [editing, setEditing] = useState(false);
  const nameOf = (id: string): string => props.all.find((c) => c.id === id)?.name ?? id;
  const rels: RelationItem[] = ch.relations ?? [];

  if (editing) {
    return (
      <ProfileForm
        ch={ch}
        others={props.all.filter((c) => c.id !== ch.id)}
        submitting={props.submitting}
        onSave={(patch) => {
          setEditing(false);
          props.onSave(patch);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <>
      <div className={styles.nameRow}>
        <span className={styles.avatarBig}>{initial(ch.name)}</span>
        <div>
          <h2 className={styles.charNameBig}>{ch.name}</h2>
          <span className={styles.tag}>{ch.role && ch.role.trim() !== '' ? ch.role : <span className={styles.unreg}>未登记</span>}</span>
        </div>
      </div>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>档案 · 手录</h3>
        <span className={styles.sub}>Agent 旧行没这些字段——缺省一律「未登记」，不替你编</span>
      </div>
      <div className={styles.fields}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldK}>当前目标</span>
          <span className={styles.fieldV}>
            <Hand v={ch.goals} />
          </span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldK}>性格</span>
          <span className={styles.fieldV}>
            <Hand v={ch.personality} />
          </span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldK}>语声口吻</span>
          <span className={styles.fieldV}>
            <Hand v={ch.voice} />
          </span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldK}>外貌</span>
          <span className={styles.fieldV}>
            <Hand v={ch.appearance} />
          </span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldK}>人物弧线</span>
          <span className={styles.fieldV}>
            <Hand v={ch.arc} />
          </span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldK}>关系</span>
          <span className={styles.fieldV}>
            {rels.length === 0 ? (
              <span className={styles.unreg}>未登记</span>
            ) : (
              rels.map((r, i) => (
                <div key={i} className={styles.relLine}>
                  与 {nameOf(r.to)}：{r.label}（{typeof r.chapter === 'number' && r.chapter >= 1 ? `第 ${r.chapter} 章` : '未标章'}）
                </div>
              ))
            )}
          </span>
        </div>
      </div>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>知识边界</h3>
        <span className={styles.sub}>knows=已知 / notKnows=不该知道（说出即穿帮）</span>
      </div>
      <div className={styles.kbGrid}>
        <div className={styles.kbCol}>
          <div className={styles.kbHead}>knows · 已知</div>
          {(ch.knows ?? []).length === 0 ? (
            <span className={styles.unreg}>未登记</span>
          ) : (
            (ch.knows ?? []).map((k, i) => (
              <div key={i} className={styles.kbItem}>
                {k}
              </div>
            ))
          )}
        </div>
        <div className={styles.kbCol}>
          <div className={styles.kbHead}>notKnows · 未知</div>
          {(ch.notKnows ?? []).length === 0 ? (
            <span className={styles.unreg}>未登记</span>
          ) : (
            (ch.notKnows ?? []).map((k, i) => (
              <div key={i} className={styles.kbItem}>
                {k}
              </div>
            ))
          )}
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btnPrimary} onClick={() => setEditing(true)}>
          编辑手录档案
        </button>
      </div>
    </>
  );
}

/** 手录字段缺省口径：空串/缺字段都显「未登记」。矩阵空格的「—」是另一套口径，不许漂到这里。 */
function Hand({ v }: { v?: string }): JSX.Element {
  return v && v.trim() !== '' ? <>{v}</> : <span className={styles.unreg}>未登记</span>;
}

/* ───────────────────────── 编辑表单（一次 patch 带走全部白名单手录字段） ───────────────────────── */

function ProfileForm(props: {
  ch: CharacterProfile;
  others: CharacterProfile[];
  submitting: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  onCancel: () => void;
}): JSX.Element {
  const { ch } = props;
  const [goals, setGoals] = useState(ch.goals ?? '');
  const [personality, setPersonality] = useState(ch.personality ?? '');
  const [voice, setVoice] = useState(ch.voice ?? '');
  const [appearance, setAppearance] = useState(ch.appearance ?? '');
  const [arc, setArc] = useState(ch.arc ?? '');
  const [knows, setKnows] = useState<string[]>(ch.knows ?? []);
  const [notKnows, setNotKnows] = useState<string[]>(ch.notKnows ?? []);
  const [relations, setRelations] = useState<RelationItem[]>(ch.relations ?? []);
  const [knowsDraft, setKnowsDraft] = useState('');
  const [notKnowsDraft, setNotKnowsDraft] = useState('');
  const [relTo, setRelTo] = useState(props.others[0]?.id ?? '');
  const [relLabel, setRelLabel] = useState('');
  const [relChapter, setRelChapter] = useState('');
  const [vErr, setVErr] = useState<string | null>(null);

  function addKb(which: 'knows' | 'notKnows'): void {
    const t = (which === 'knows' ? knowsDraft : notKnowsDraft).trim();
    if (t === '') return;
    if (which === 'knows') {
      setKnows((v) => [...v, t]);
      setKnowsDraft('');
    } else {
      setNotKnows((v) => [...v, t]);
      setNotKnowsDraft('');
    }
  }
  function addRelation(): void {
    const label = relLabel.trim();
    if (relTo === '' || label === '') return;
    const n = relChapter.trim() === '' ? undefined : Number(relChapter);
    const chapter = n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
    setRelations((v) => [...v, { to: relTo, label, chapter }]);
    setRelLabel('');
    setRelChapter('');
  }

  /** 写侧先行校验：knows/notKnows 必须是 string[]（repo 也会拒），relations 指不到人就是死链 */
  function save(): void {
    for (const [name, list] of [
      ['knows', knows],
      ['notKnows', notKnows],
    ] as const) {
      if (list.some((k) => typeof k !== 'string' || k.trim() === '')) {
        setVErr(`${name} 里有空白条目：先删掉再保存。`);
        return;
      }
    }
    for (const r of relations) {
      if (typeof r.to !== 'string' || r.to === '' || r.to === ch.id) {
        setVErr('关系必须指向其他人物——不能指自己，也不能没有目标。');
        return;
      }
      if (!props.others.some((o) => o.id === r.to)) {
        setVErr('有关系的对方已不在本书人物表里（可能已被删除）：移除这条再保存。');
        return;
      }
      if (typeof r.label !== 'string' || r.label.trim() === '') {
        setVErr('每条关系都要有标签（师徒/同盟/敌对…）。');
        return;
      }
      if (r.chapter !== undefined && (!Number.isInteger(r.chapter) || r.chapter < 1)) {
        setVErr('关系的登记章要是不小于 1 的整数（不想标就留空）。');
        return;
      }
    }
    setVErr(null);
    props.onSave({
      goals: goals.trim(),
      personality: personality.trim(),
      voice: voice.trim(),
      appearance: appearance.trim(),
      arc: arc.trim(),
      knows: knows.map((k) => k.trim()),
      notKnows: notKnows.map((k) => k.trim()),
      relations: relations.map((r) =>
        r.chapter === undefined ? { to: r.to, label: r.label.trim() } : { to: r.to, label: r.label.trim(), chapter: r.chapter },
      ),
    });
  }

  return (
    <div className={styles.formCol}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>编辑手录档案 · {ch.name}</h3>
        <span className={styles.sub}>保存=一次 ledger.patch 带走以下全部字段；名/出处链不在手改名单</span>
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>当前目标</span>
        <textarea className={styles.ta} value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="TA 现在最想要什么" spellCheck={false} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>性格</span>
        <textarea className={styles.ta} value={personality} onChange={(e) => setPersonality(e.target.value)} placeholder="一句话立得住的那种" spellCheck={false} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>语声口吻</span>
        <textarea className={styles.ta} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="对白一致性的参考：口头禅/句式/节奏" spellCheck={false} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>外貌</span>
        <textarea className={styles.ta} value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder="可被误认的最小特征集" spellCheck={false} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>人物弧线</span>
        <textarea className={styles.ta} value={arc} onChange={(e) => setArc(e.target.value)} placeholder="从哪走向哪（可含计划章号）" spellCheck={false} />
      </label>

      <div className={styles.kbGrid}>
        <div className={styles.kbCol}>
          <div className={styles.kbHead}>knows · 已知</div>
          {knows.map((k, i) => (
            <div key={i} className={styles.kbItem}>
              <span className={styles.kbGrow}>{k}</span>
              <button className={styles.kbDel} onClick={() => setKnows((v) => v.filter((_, j) => j !== i))}>
                删
              </button>
            </div>
          ))}
          <div className={styles.kbAddRow}>
            <input className={styles.kbGrow} value={knowsDraft} onChange={(e) => setKnowsDraft(e.target.value)} placeholder="TA 知道的情报" spellCheck={false} />
            <button className={styles.kbAdd} onClick={() => addKb('knows')}>
              ＋
            </button>
          </div>
        </div>
        <div className={styles.kbCol}>
          <div className={styles.kbHead}>notKnows · 未知</div>
          {notKnows.map((k, i) => (
            <div key={i} className={styles.kbItem}>
              <span className={styles.kbGrow}>{k}</span>
              <button className={styles.kbDel} onClick={() => setNotKnows((v) => v.filter((_, j) => j !== i))}>
                删
              </button>
            </div>
          ))}
          <div className={styles.kbAddRow}>
            <input className={styles.kbGrow} value={notKnowsDraft} onChange={(e) => setNotKnowsDraft(e.target.value)} placeholder="TA 说出即穿帮的信息" spellCheck={false} />
            <button className={styles.kbAdd} onClick={() => addKb('notKnows')}>
              ＋
            </button>
          </div>
        </div>
      </div>

      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>关系</h3>
        <span className={styles.sub}>整数组覆盖保存；对方必须是本书已登记的人物</span>
      </div>
      {relations.map((r, i) => (
        <div key={i} className={styles.relRow}>
          <select className={styles.relSel} value={r.to} onChange={(e) => setRelations((v) => v.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}>
            {props.others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <input className={styles.kbGrow} value={r.label} onChange={(e) => setRelations((v) => v.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="标签" spellCheck={false} />
          <input className={styles.relInp} type="number" min={1} value={r.chapter ?? ''} onChange={(e) => setRelations((v) => v.map((x, j) => (j === i ? { ...x, chapter: e.target.value === '' ? undefined : Number(e.target.value) } : x)))} placeholder="章" />
          <button className={styles.kbDel} onClick={() => setRelations((v) => v.filter((_, j) => j !== i))}>
            删
          </button>
        </div>
      ))}
      <div className={styles.relRow}>
        {props.others.length === 0 ? (
          <span className={styles.unreg}>本书还没有其他人物可挂关系</span>
        ) : (
          <>
            <select className={styles.relSel} value={relTo} onChange={(e) => setRelTo(e.target.value)}>
              {props.others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <input className={styles.kbGrow} value={relLabel} onChange={(e) => setRelLabel(e.target.value)} placeholder="标签（师徒/同盟…）" spellCheck={false} />
            <input className={styles.relInp} type="number" min={1} value={relChapter} onChange={(e) => setRelChapter(e.target.value)} placeholder="章(选填)" />
            <button className={styles.kbAdd} onClick={addRelation}>
              ＋挂关系
            </button>
          </>
        )}
      </div>

      {vErr && <p className={styles.err}>{vErr}</p>}
      <div className={styles.actions}>
        <button className={styles.btn} onClick={props.onCancel}>
          取消
        </button>
        <button className={styles.btnPrimary} disabled={props.submitting} onClick={save}>
          保存手录
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── 弹窗（快照格子 / 新建人物） ───────────────────────── */

function ModalCard(props: {
  title: string;
  onClose: () => void;
  submitting: boolean;
  children: JSX.Element;
}): JSX.Element {
  return createPortal(
    <div className={styles.mask} onMouseDown={props.onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={props.title} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>{props.title}</div>
        <div className={styles.modalBody}>{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}

function CellBody(props: {
  initialSnapshot: string;
  submitting: boolean;
  onOk: (snapshot: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [v, setV] = useState(props.initialSnapshot);
  return (
    <div className={styles.formCol}>
      <p className={styles.note}>
        {props.initialSnapshot === ''
          ? '这一格还没记过：写下 TA 在本章末的处境（修为/持有物/关系/认知变化都可以，一句话说清就行）。'
          : '已有快照：保存即覆盖旧内容。charstate 没有删除通道——旧快照只能被新内容覆盖，不能清账。'}
      </p>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>状态快照 *（空快照主进程拒收）</span>
        <textarea className={styles.ta} value={v} onChange={(e) => setV(e.target.value)} placeholder="例：练气五层 · 持残卷 · 与沈青梧同行" spellCheck={false} />
      </label>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={props.onCancel}>
          取消
        </button>
        <button className={styles.btnPrimary} disabled={props.submitting || v.trim() === ''} onClick={() => props.onOk(v.trim())}>
          保存快照
        </button>
      </div>
    </div>
  );
}

function AddBody(props: { submitting: boolean; onOk: (name: string, role: string) => void; onCancel: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  return (
    <div className={styles.formCol}>
      <p className={styles.note}>先立骨架卡（名 + 定位）；目标/性格/知识边界等手录字段进卡片「编辑」再补。</p>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>人物名 *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：林渡" spellCheck={false} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>定位</span>
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例：主角 / 女主 / 反派 / 龙套" spellCheck={false} />
      </label>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={props.onCancel}>
          取消
        </button>
        <button className={styles.btnPrimary} disabled={props.submitting || name.trim() === ''} onClick={() => props.onOk(name.trim(), role.trim())}>
          建卡入账
        </button>
      </div>
    </div>
  );
}
