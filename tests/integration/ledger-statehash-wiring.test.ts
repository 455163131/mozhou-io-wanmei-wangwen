/**
 * ★ 判据 B 的状态指纹必须把**账本**算进去 —— 装配层测试。
 *
 * 为什么单独开一个文件：
 *
 *   `util/hash.ts` 里 `ledgerDigest()` 的注释写着「使『只改账本不改正文』也能被检测到」，
 *   而唯一的生产调用点 `services.ts:computeStateHash()` 传的是 **`ledgerDigest([])`**
 *   —— 恒定的空数组。摘要算得再对也是常数，于是：
 *
 *     · Agent 只改账本（补人物设定、加数字锚点）而没动正文时，
 *       状态指纹逐字不变 → 循环检测判据 B 判定 `no-effect` →
 *       Agent 被告知「你刚才那步什么都没改」，而它确实改了。
 *
 *   这与已修复的闸门②（§4 第 0 条）是**同一个失败模式**：单元逻辑正确、
 *   注释意图正确，装配点没喂数据。277→445 个用例全绿也发现不了，
 *   因为既有测试测的都是 `hashProjectState`/`ledgerDigest` 本身。
 *
 * 因此本文件分两层：
 *   A. 行为层：真 `hashProjectState` + 真 `ledgerDigest` + 真账本类型，
 *      证明「只改账本 → 指纹变」「重排 → 指纹不变」；
 *   B. 装配哨兵：直接盯 services.ts 的源码，接线被删就红。
 *
 * B 层为什么用源码文本断言：services.ts 顶层 import 了 electron 的 `app`，
 * 测试跑在 `ELECTRON_RUN_AS_NODE=1` 下（见 scripts/test.cmd），此时
 * `app.getPath()` 不可用，AppServices 构造不起来（同 apikey-wiring.test.ts 的处理）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hashProjectState,
  ledgerDigest,
  ledgerStateEntries,
  type LedgerStateBundle,
} from '@main/util/hash';
import type {
  CharacterProfile,
  Foreshadow,
  NumberAnchor,
  TimelineEvent,
} from '@shared/types/ledger';

const CHAPTERS = [
  { id: '1', body: '第一章正文。' },
  { id: '2', body: '第二章正文完全不同。' },
];

const EMPTY: LedgerStateBundle = {
  characters: [],
  numbers: [],
  timeline: [],
  foreshadows: [],
};

const CHARACTER: CharacterProfile = {
  id: 'ch-1',
  name: '林九',
  role: '主角',
  age: '十九岁',
  note: '左眉有疤',
  refs: [{ chapterId: '1', offset: 3, quote: '林九' }],
  updatedAt: 1700000000000,
};

const NUMBER: NumberAnchor = {
  id: 'n-1',
  value: '3.5万',
  numeric: 35000,
  unit: '灵石',
  subject: '林九欠下的债',
  refs: [{ chapterId: '2', offset: 0, quote: '3.5万' }],
};

const EVENT: TimelineEvent = {
  id: 't-1',
  when: '第三日',
  what: '林九与师父决裂',
  refs: [{ chapterId: '2', offset: 12, quote: '决裂' }],
};

const FORESHADOW: Foreshadow = {
  id: 'f-1',
  plantedAt: { chapterId: '1', offset: 5, quote: '门后那把旧伞' },
  plantedQuote: '他没有回头拿伞',
  resolvedAt: null,
  status: 'unresolved',
};

/** 指纹：正文固定，只换账本 */
function fingerprint(bundle: LedgerStateBundle): string {
  return hashProjectState(CHAPTERS, ledgerDigest(ledgerStateEntries(bundle)));
}

describe('A. 行为层：账本变化必须改变状态指纹', () => {
  it('★ 只改账本、正文一字未动 → 指纹必须不同', () => {
    const before = fingerprint(EMPTY);
    const after = fingerprint({ ...EMPTY, characters: [CHARACTER] });
    expect(after).not.toBe(before);
  });

  it('★ 四类账本（人物/数字/时间线/伏笔）任一类进账本都会改变指纹', () => {
    const base = fingerprint(EMPTY);
    const cases: Array<[string, LedgerStateBundle]> = [
      ['characters', { ...EMPTY, characters: [CHARACTER] }],
      ['numbers', { ...EMPTY, numbers: [NUMBER] }],
      ['timeline', { ...EMPTY, timeline: [EVENT] }],
      ['foreshadows', { ...EMPTY, foreshadows: [FORESHADOW] }],
    ];
    for (const [kind, bundle] of cases) {
      expect(fingerprint(bundle), `${kind} 没有被算进状态指纹`).not.toBe(base);
    }
  });

  it('同一批账本、登记顺序不同 → 指纹必须相同（不能误报 no-effect 的反面）', () => {
    const a: LedgerStateBundle = {
      ...EMPTY,
      characters: [CHARACTER, { ...CHARACTER, id: 'ch-2', name: '师父' }],
    };
    const b: LedgerStateBundle = {
      ...EMPTY,
      characters: [{ ...CHARACTER, id: 'ch-2', name: '师父' }, CHARACTER],
    };
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('账本字段值变化（同一条目改设定）→ 指纹必须变', () => {
    expect(fingerprint({ ...EMPTY, characters: [{ ...CHARACTER, note: '右眉有疤' }] })).not.toBe(
      fingerprint({ ...EMPTY, characters: [CHARACTER] }),
    );
  });
});

describe('B. 装配哨兵：services.ts 必须把真账本喂进 ledgerDigest', () => {
  const src = readFileSync(join(__dirname, '../../src/main/services.ts'), 'utf8');

  /** 切出 computeStateHash 的函数体 */
  function body(): string {
    const start = src.indexOf('async computeStateHash(');
    expect(start, 'services.ts 里找不到 computeStateHash').toBeGreaterThanOrEqual(0);
    const rest = src.slice(start);
    const end = rest.indexOf('\n  }');
    return rest.slice(0, end);
  }

  it('★ computeStateHash 不许再传空数组字面量', () => {
    const fn = body();
    expect(fn.includes('ledgerDigest([])'), 'computeStateHash 又退回 ledgerDigest([]) 了').toBe(
      false,
    );
    expect(fn).toContain('ledgerStateEntries');
  });

  it('传给指纹的必须是**当前项目**的账本（四类都取）', () => {
    const fn = body();
    for (const getter of ['characters(', 'numbers(', 'timeline(', 'foreshadows(']) {
      expect(fn.includes(getter), `computeStateHash 漏了 ${getter.replace('(', '')}`).toBe(true);
    }
  });

  it('ledgerStateEntries 是 services 从 util/hash 引入的那个符号', () => {
    const importLine = src
      .split('\n')
      .find((l) => l.includes('ledgerStateEntries') && l.includes('import'));
    expect(importLine, 'services.ts 没有 import ledgerStateEntries').toBeTruthy();
    expect(importLine).toContain('./util/hash');
  });
});
