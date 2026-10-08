/**
 * 账本查询工具（架构 §1.6 工具 5 / T09）。
 *
 * ★ refs 字段是刻意保留的原型设计：每个属性都带原文出处，
 *   让 Agent 引用人物设定时能给出证据，而不是凭空断言。
 */
import type { ToolContext, ToolResult } from '@shared/types/tool';
import type {
  CharacterProfile,
  LedgerConflict,
  LedgerCounts,
  LedgerEntries,
  NumberAnchor,
  TimelineEvent,
  Foreshadow,
} from '@shared/types/ledger';
import { snippetAround } from '@shared/util/text-zh';

export interface LedgerDeps {
  characters: (projectId: string, subject?: string) => CharacterProfile[];
  numbers: (projectId: string, subject?: string) => NumberAnchor[];
  timeline: (projectId: string) => TimelineEvent[];
  foreshadows: (projectId: string) => Foreshadow[];
  conflicts: (projectId: string, kind?: string) => LedgerConflict[];
  /**
   * 写入口（§4 第 13 条）。此前四个 mem* Map 只有读、没有写，
   * 所以账本连会话内都恒为空——这个方法是那条缺失的边。
   */
  upsertLedger: (projectId: string, entries: LedgerEntries) => LedgerCounts;
  currentProjectId: () => string | null;
}

export interface LedgerQueryResult {
  characters: CharacterProfile[];
  numbers: NumberAnchor[];
  timeline: TimelineEvent[];
  foreshadows: Foreshadow[];
  conflicts: LedgerConflict[];
}

export async function queryLedger(
  args: { kind?: string; subject?: string },
  _ctx: ToolContext,
  deps: LedgerDeps,
): Promise<ToolResult<LedgerQueryResult>> {
  const started = Date.now();
  const projectId = deps.currentProjectId();
  if (!projectId) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: {
        code: 'E_INVALID_ARGS',
        message: '尚未打开项目，无法查询账本。',
        retryable: false,
      },
    };
  }

  const kind = args.kind ?? 'all';
  const subject = args.subject;
  const want = (k: string): boolean => kind === 'all' || kind === k;

  const result: LedgerQueryResult = {
    characters: want('characters') ? deps.characters(projectId, subject) : [],
    numbers: want('numbers') ? deps.numbers(projectId, subject) : [],
    timeline: want('timeline') ? deps.timeline(projectId) : [],
    foreshadows: want('foreshadows') ? deps.foreshadows(projectId) : [],
    conflicts: want('conflicts') ? deps.conflicts(projectId, kind === 'all' ? undefined : kind) : [],
  };

  const empty =
    result.characters.length === 0 &&
    result.numbers.length === 0 &&
    result.timeline.length === 0 &&
    result.foreshadows.length === 0 &&
    result.conflicts.length === 0;

  return {
    ok: true,
    data: result,
    durationMs: Date.now() - started,
    // 空结果不是错误——如实返回，让 Agent 知道「没有就是没有」
    ...(empty ? {} : {}),
  };
}

/**
 * 冲突检测：同一主体的两处陈述矛盾。
 *
 * ★ 关键设计：**系统不裁决谁对**，只并列两处原文交给作者（对应 N2 的 why）。
 *   系统无法判断是人物卡登记错了还是正文写错了——强行统一会引入更严重的问题。
 */
export function detectConflicts(
  characters: CharacterProfile[],
  numbers: NumberAnchor[],
  timeline: TimelineEvent[],
): LedgerConflict[] {
  const conflicts: LedgerConflict[] = [];

  // 年龄冲突：同名人物有多个不同年龄，且都带出处
  const byName = new Map<string, CharacterProfile[]>();
  for (const c of characters) {
    const arr = byName.get(c.name) ?? [];
    arr.push(c);
    byName.set(c.name, arr);
  }
  for (const [name, arr] of byName) {
    const ages = [...new Set(arr.map((c) => c.age).filter(Boolean))];
    if (ages.length > 1) {
      conflicts.push({
        id: `conflict_age_${name}`,
        kind: 'character',
        subject: name,
        sides: arr
          .filter((c) => c.age)
          .map((c) => ({
            ref: c.refs[0] ?? { chapterId: '', offset: 0, quote: '' },
            claim: `年龄登记为 ${c.age}`,
            value: c.age,
          })),
        whyUndecidable:
          `「${name}」在${arr.length} 处被登记为不同年龄（${ages.join(' / ')}）。` +
          `系统无法判断是人物卡登记错了，还是正文写错了——必须作者裁决。`,
      });
    }
  }

  // 数字冲突：同一 subject + unit 下不同数值
  const byKey = new Map<string, NumberAnchor[]>();
  for (const n of numbers) {
    const key = `${n.subject}|${n.unit}`;
    const arr = byKey.get(key) ?? [];
    arr.push(n);
    byKey.set(key, arr);
  }
  for (const [key, arr] of byKey) {
    const values = [...new Set(arr.map((n) => n.numeric))];
    if (values.length > 1) {
      const [subject, unit] = key.split('|');
      conflicts.push({
        id: `conflict_num_${key}`,
        kind: 'number',
        subject,
        sides: arr.map((n) => ({
          ref: n.refs[0] ?? { chapterId: '', offset: 0, quote: '' },
          claim: `${subject}的${unit}`,
          value: n.value,
        })),
        whyUndecidable:
          `「${subject}」的${unit}出现 ${values.join(' / ')} 多个值。` +
          `数字是事实锚点，系统一律不自动改动，必须作者裁决哪个是对的。`,
      });
    }
  }

  // 时间线冲突：同一 when 有互斥的 what
  const byWhen = new Map<string, TimelineEvent[]>();
  for (const t of timeline) {
    const arr = byWhen.get(t.when) ?? [];
    arr.push(t);
    byWhen.set(t.when, arr);
  }
  for (const [when, arr] of byWhen) {
    if (arr.length > 1 && new Set(arr.map((t) => t.what)).size > 1) {
      conflicts.push({
        id: `conflict_tl_${when}`,
        kind: 'timeline',
        subject: when,
        sides: arr.map((t) => ({
          ref: t.refs[0] ?? { chapterId: '', offset: 0, quote: '' },
          claim: t.what,
          value: t.what,
        })),
        whyUndecidable: `时间点「${when}」上有 ${arr.length} 件互斥的事，可能需要作者判断先后。`,
      });
    }
  }

  return conflicts;
}

/** 从原文构造带出处的引用 */
export function makeRef(
  chapterId: string,
  body: string,
  at: number,
  radius = 14,
): { chapterId: string; offset: number; quote: string } {
  return { chapterId, offset: at, quote: snippetAround(body, at, radius) };
}