/**
 * 账本登记工具（§4 第 13 条的写入口）。
 *
 * ★ 为什么必须有这个工具：修复前 `query_ledger` 读的是四个"只 get 不 set"的内存 Map，
 *   账本恒为空 → Agent 每次都"看不见前文设定"，S2 跨章一致性对账没有数据来源。
 *   repo（`db/repos/ledger-repo.ts`）让"能写"成立，本文件让"真有人写"成立。
 *
 * ★ 出处是硬要求，不是可选项：架构 §1.7 的原话是"让 Agent 引用人物设定时能给出证据，
 *   而不是凭空断言"。所以每条 ref 必须给出**章 id + 原文引文**，本工具会：
 *     1. 真去读那一章的正文，确认引文逐字存在（不存在就整批拒绝，而不是收下断言）；
 *     2. 用 indexOf 回填 offset（模型不可能自己算出字符偏移）。
 *   id 同样由系统生成，模型不许自编：自编 id 会让"同一人物登记两次"变成两条不同事实。
 *   重复登记同一人物/同一锚点时**复用已有 id**，于是登记是幂等的（判据 A 不误伤）。
 */
import type { ToolContext, ToolResult } from '@shared/types/tool';
import type {
  CharacterProfile,
  Foreshadow,
  LedgerCounts,
  NumberAnchor,
  SourceRef,
  TimelineEvent,
} from '@shared/types/ledger';
import { nextId } from '@shared/util/id';
import type { LedgerDeps } from './ledger-query';
import type { ReadOnlyDeps } from './analyze';

/** 核验出处要读正文、报错要说章名，所以除了账本依赖还要只读依赖里的这两个 */
export type UpdateLedgerDeps = LedgerDeps & Pick<ReadOnlyDeps, 'getBodies' | 'chapterTitle'>;

/** 模型只需要给「哪章 + 原文短句」，offset 与 id 由系统补 */
interface DraftRef {
  chapterId: string;
  quote: string;
}

/** 人物卡草稿：id / refs 的 offset / updatedAt 由系统补 */
interface DraftCharacter {
  name: string;
  role?: string;
  age?: string;
  note?: string;
  refs?: DraftRef[];
}

export interface UpdateLedgerArgs {
  characters?: DraftCharacter[];
  numbers?: Array<{ value: string; subject: string; unit?: string; numeric?: number; refs?: DraftRef[] }>;
  timeline?: Array<{ when: string; what: string; refs?: DraftRef[] }>;
  foreshadows?: Array<{
    plantedChapterId: string;
    plantedQuote: string;
    status?: Foreshadow['status'];
    resolvedChapterId?: string;
    resolvedQuote?: string;
  }>;
}

export interface UpdateLedgerData extends LedgerCounts {
  /** 本批被核验过的出处条数（写进结果里，让 Agent 知道证据链是真的走过正文） */
  refsVerified: number;
}

/** 「3.5万」→ 35000；模型给的 numeric 优先，缺省或非法时才自己折算 */
export function parseNumeric(value: string, given?: number): number {
  if (typeof given === 'number' && Number.isFinite(given)) return given;
  const m = /^(-?\d+(?:\.\d+)?)\s*(亿|万|千)?/.exec(value.trim());
  if (!m) return Number.NaN;
  const base = Number(m[1]);
  const mult = m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : m[2] === '千' ? 1e3 : 1;
  return base * mult;
}

export async function updateLedger(
  args: UpdateLedgerArgs,
  _ctx: ToolContext,
  deps: UpdateLedgerDeps,
): Promise<ToolResult<UpdateLedgerData>> {
  const started = Date.now();
  const fail = (message: string): ToolResult<UpdateLedgerData> => ({
    ok: false,
    durationMs: Date.now() - started,
    error: { code: 'E_INVALID_ARGS', message, retryable: false },
  });

  const projectId = deps.currentProjectId();
  if (!projectId) return fail('尚未打开项目，无法登记账本。');

  const characters = args.characters ?? [];
  const numbers = args.numbers ?? [];
  const timeline = args.timeline ?? [];
  const foreshadows = args.foreshadows ?? [];
  if (characters.length + numbers.length + timeline.length + foreshadows.length === 0) {
    return fail('entries 全空：至少登记一条人物卡 / 数字锚点 / 时间线 / 伏笔。');
  }

  // ★ 出处是硬要求（架构 §1.7）：没有引文的"事实"就是本项目最反对的凭空断言
  const noRef = [
    ...characters.map((c, i) => (c.refs?.length ? null : `人物卡[${i}]「${c.name}」`)),
    ...numbers.map((n, i) => (n.refs?.length ? null : `数字锚点[${i}]「${n.subject}」`)),
    ...timeline.map((t, i) => (t.refs?.length ? null : `时间线[${i}]「${t.when}」`)),
  ].filter((x): x is string => x !== null);
  if (noRef.length > 0) {
    return fail(
      `这些条目一条出处都没有，本批拒绝：${noRef.join('、')}。` +
        '每条必须带 refs:[{chapterId, quote}]，quote 要能在所引章节里逐字找到。',
    );
  }
  const badNum = numbers.find((n) => !Number.isFinite(parseNumeric(n.value, n.numeric)));
  if (badNum) {
    return fail(`数字锚点「${badNum.value}」归一化不出数值，请给 numeric，或可解析的写法（如 3.5万 / 1200）。`);
  }

  // ── 1. 先把所有出处摊开，一次批量读正文核验（引文必须逐字存在于所引章节）──
  const draftRefs: DraftRef[] = [];
  for (const c of characters) draftRefs.push(...(c.refs ?? []));
  for (const n of numbers) draftRefs.push(...(n.refs ?? []));
  for (const t of timeline) draftRefs.push(...(t.refs ?? []));
  for (const f of foreshadows) {
    draftRefs.push({ chapterId: f.plantedChapterId, quote: f.plantedQuote });
    if (f.resolvedChapterId && f.resolvedQuote) {
      draftRefs.push({ chapterId: f.resolvedChapterId, quote: f.resolvedQuote });
    }
  }

  const ids = [...new Set(draftRefs.map((r) => r.chapterId))];
  const bodies = await deps.getBodies(ids);
  const bad: string[] = [];
  for (const r of draftRefs) {
    const body = bodies.get(r.chapterId);
    if (body === undefined) {
      bad.push(`章节 ${r.chapterId} 不存在（引文「${r.quote.slice(0, 12)}…」无出处）`);
    } else if (r.quote.trim() === '' || body.indexOf(r.quote) < 0) {
      bad.push(`「${r.quote.slice(0, 20)}」在 ${deps.chapterTitle(r.chapterId)} 里逐字找不到`);
    }
  }
  if (bad.length > 0) {
    // 整批拒绝：收下三条真证据 + 一条编的，等于给后面所有引用掺了假
    return fail(`出处核验未通过，本批一条都没登记：\n· ${bad.join('\n· ')}`);
  }

  // quote 一律保留模型给的那句原文（"逐字"才有意义），offset 由系统回查填入。
  // 不用 ledger-query 的 makeRef：它是"只有偏移、没有引文"时截上下文用的，
  // 这里引文已知，套上去会把短引文换成一段上下文，反而看不出模型声明的是哪几个字。
  const realRef = (r: DraftRef): SourceRef => {
    // 上面的核验已保证这一章存在且含该引文，这里只需再定位一次
    const body = bodies.get(r.chapterId) ?? '';
    return { chapterId: r.chapterId, offset: body.indexOf(r.quote), quote: r.quote };
  };

  // ── 2. 复用已有 id：同一人物/同一锚点再登记 = 覆盖，而不是多出一条"事实" ──
  const now = Date.now();
  const oldChars = deps.characters(projectId);
  const builtChars: CharacterProfile[] = characters.map((c) => {
    const hit = oldChars.find((x) => x.name === c.name);
    return {
      id: hit?.id ?? nextId('chr'),
      name: c.name,
      role: c.role ?? '',
      age: c.age ?? '',
      note: c.note ?? '',
      refs: (c.refs ?? []).map(realRef),
      updatedAt: now,
    };
  });

  const oldNums = deps.numbers(projectId);
  const builtNums: NumberAnchor[] = numbers.map((n) => {
    const hit = oldNums.find((x) => x.subject === n.subject && x.value === n.value);
    return {
      id: hit?.id ?? nextId('num'),
      value: n.value,
      numeric: parseNumeric(n.value, n.numeric),
      unit: n.unit ?? '',
      subject: n.subject,
      refs: (n.refs ?? []).map(realRef),
    };
  });

  const oldTl = deps.timeline(projectId);
  const builtTl: TimelineEvent[] = timeline.map((t) => {
    const hit = oldTl.find((x) => x.when === t.when && x.what === t.what);
    return { id: hit?.id ?? nextId('tl'), when: t.when, what: t.what, refs: (t.refs ?? []).map(realRef) };
  });

  const oldFs = deps.foreshadows(projectId);
  const builtFs: Foreshadow[] = foreshadows.map((f) => {
    const hit = oldFs.find((x) => x.plantedAt.quote === f.plantedQuote);
    const status: Foreshadow['status'] = f.status ?? (f.resolvedChapterId ? 'resolved' : 'unresolved');
    return {
      id: hit?.id ?? nextId('fs'),
      plantedAt: realRef({ chapterId: f.plantedChapterId, quote: f.plantedQuote }),
      plantedQuote: f.plantedQuote,
      resolvedAt:
        f.resolvedChapterId && f.resolvedQuote
          ? realRef({ chapterId: f.resolvedChapterId, quote: f.resolvedQuote })
          : null,
      status,
    };
  });

  // ── 3. 落库 ──
  try {
    const counts = deps.upsertLedger(projectId, {
      characters: builtChars,
      numbers: builtNums,
      timeline: builtTl,
      foreshadows: builtFs,
    });
    return { ok: true, data: { ...counts, refsVerified: draftRefs.length }, durationMs: Date.now() - started };
  } catch (e) {
    return fail(`账本登记失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
