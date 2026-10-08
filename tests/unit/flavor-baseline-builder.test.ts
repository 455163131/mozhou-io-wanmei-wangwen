/**
 * 用户自建基线 builder 回归测试（T03）。
 *
 * ★ 六条验收（对应 team-lead 调和后的 spec）：
 *   1. **同口径**：手工用 `extractFlavorFeatures` + `percentiles` 算 3 章，与 `buildFlavorBaseline`
 *      输出**逐字段相等**（证明 builder 没另写统计）。
 *   2. **样本闸门**：< 10 章 → 不启用、warnings 有提示；单章 < 200 字 → 计入 `skipped`。
 *   3. **回退**：有效章不足 → 维度取默认值 + `calibrated:false`。
 *   4. **零膨胀 `corpusMaxCount`**：语料最大 2 次 → `corpusMaxCount===2`（denom=6 → 1 次=17）；
 *      最大 0 次 → `corpusMaxCount===0`（denom 兜底 → 1 次=33）。
 *   5. **端到端等价性**：用默认基线那 715 章同一批文本跑 builder，11 指标分位数应与
 *      `DEFAULT_FLAVOR_BASELINE` 基本一致（语料目录不存在时该组自动跳过）。
 *   6. **旧口径识别**：builder 产出的基线 `isBaselineStale()` 为 `false`。
 *
 * 注意：builder 的所有指标都从**同一批有效章**累积，故「某维度样本不足」在实现里是
 * **全维度一起回退**（各指标数组长度恒等于 `used`）——测试 3 按此实际语义断言。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFlavorFeatures, scoreZeroInflated, detectFlavor, FLAVOR_FEATURE_VERSION } from '@shared/ai-flavor/engine';
import {
  DEFAULT_FLAVOR_BASELINE,
  FLAVOR_METRIC_KEYS,
  isBaselineStale,
} from '@shared/ai-flavor/baseline';
import { percentiles } from '@main/db/repos/chapter-repo';
import {
  buildFlavorBaseline,
  DEFAULT_MIN_CHAPTERS,
  DEFAULT_MIN_CHARS_PER_CHAPTER,
} from '@main/flavor/baseline-builder';

const r4 = (x: number): number => Number(x.toFixed(4));

// ── 素材：三段无连接词 / 无对仗的中性正文（各 > 200 字）──────────────
// ★ 引擎 `chars = text.replace(/\s/g,'').length`（含标点）。种子各约 40 字，×6 后 ≥ 234 字，
//   稳过 builder 的默认 `minCharsPerChapter = 200` 闸门（×5 时 SEED_B 仅 195 会被跳过）。
const SEED_A = '他在街口站了一会儿，风从巷子里钻出来，卷起地上的纸片。路灯下有一只猫，趴着不动。';
const SEED_B = '她把杯子放在桌上，水汽从杯口慢慢升起来，又散在灯光里。窗外有车开过，声音很远。';
const SEED_C = '雪下了一夜，早上推开门，院子里白了一层。树枝上挂着水珠，亮得晃眼，他伸手接了一把。';
const CH_A = SEED_A.repeat(6);
const CH_B = SEED_B.repeat(6);
const CH_C = SEED_C.repeat(6);

/** 一「章」样本 */
const s = (chapterId: string, text: string) => ({ chapterId, text });

// ── 1. 同口径：builder 输出 == 手工 extractFlavorFeatures + percentiles ──

describe('★ 同口径（builder 不另写统计，与引擎/脚本同插值）', () => {
  it('3 章：每个指标的分位数逐字段等于「extractFlavorFeatures + percentiles」结果', () => {
    const bodies = [CH_A, CH_B, CH_C];
    const samples = bodies.map((b, i) => s(`c${i}`, b));
    const result = buildFlavorBaseline(samples, { minChapters: 3 }, FLAVOR_FEATURE_VERSION);
    expect(result.used).toBe(3);

    const feats = bodies.map((b) => extractFlavorFeatures(b));
    const hand = (sel: (f: ReturnType<typeof extractFlavorFeatures>) => number) => {
      const p = percentiles(feats.map(sel));
      return {
        p05: r4(p.p05),
        p25: r4(p.p25),
        p50: r4(p.p50),
        p75: r4(p.p75),
        p95: r4(p.p95),
        mean: r4(p.mean),
        min: r4(p.min),
        max: r4(p.max),
        calibrated: true,
      };
    };

    // 逐字段严格相等（不是「近似」）——这是「同一口径」的硬证据。
    expect(result.baseline.metrics.sent_cv).toEqual(hand((f) => f.sentCv));
    expect(result.baseline.metrics.ttr).toEqual(hand((f) => f.ttr));
    expect(result.baseline.metrics.tri_repeat).toEqual(hand((f) => f.triRepeat));
    expect(result.baseline.metrics.dialog_para_ratio).toEqual(hand((f) => f.dialogParaRatio));
    expect(result.baseline.metrics.comma_period_ratio).toEqual(hand((f) => f.commaPeriodRatio));
    expect(result.baseline.metrics.dash_ellipsis_per1000).toEqual(hand((f) => f.dashPer1000));

    // 零膨胀两项：p05..max 用**密度**（与手工一致），另带 corpusMaxCount
    expect(result.baseline.metrics.connector_per1000).toEqual({
      ...hand((f) => (f.chars > 0 ? (f.connectorCount * 1000) / f.chars : 0)),
      corpusMaxCount: 0,
    });
    expect(result.baseline.metrics.parallel_per100sent).toEqual({
      ...hand((f) => (f.sentCount > 0 ? (f.parallelCount * 100) / f.sentCount : 0)),
      corpusMaxCount: 0,
    });
  });
});

// ── 2. 样本闸门 ──────────────────────────────────────────────────────

describe('★ 样本闸门', () => {
  it('有效章数 < 10 → 不启用（warnings 有提示），且各指标标记未校准', () => {
    const samples = Array.from({ length: 9 }, (_, i) => s(`c${i}`, CH_A));
    const r = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);
    expect(DEFAULT_MIN_CHAPTERS).toBe(10);
    expect(r.used).toBe(9);
    expect(r.warnings.some((w) => w.includes('有效章节仅 9 章'))).toBe(true);
    for (const k of FLAVOR_METRIC_KEYS) {
      expect(r.baseline.metrics[k].calibrated).toBe(false);
    }
  });

  it('单章 < 200 字 → 计入 skipped，不参与分位', () => {
    const short = '太短了。'; // < 200 字
    const samples = [
      ...Array.from({ length: 11 }, (_, i) => s(`ok${i}`, CH_A)),
      s('short', short),
    ];
    const r = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);
    expect(r.used).toBe(11);
    expect(r.skipped).toBe(1);
    expect(r.warnings.some((w) => w.includes('跳过 1 章'))).toBe(true);
    expect(DEFAULT_MIN_CHARS_PER_CHAPTER).toBe(200);
  });
});

// ── 3. 回退：取默认值 + calibrated:false ─────────────────────────────

describe('★ 维度回退（样本不足时取默认值并标记未校准）', () => {
  it('有效章不足 → 该指标值 == DEFAULT 且 calibrated:false', () => {
    const samples = Array.from({ length: 5 }, (_, i) => s(`c${i}`, CH_A));
    const r = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);
    // builder 各指标数组长度恒 = used，故「样本不足」是全维度一起回退。
    for (const k of FLAVOR_METRIC_KEYS) {
      const m = r.baseline.metrics[k];
      expect(m.calibrated).toBe(false);
      // 值取自默认基线（不双重兜底）
      expect(m.p05).toBe(DEFAULT_FLAVOR_BASELINE.metrics[k].p05);
      expect(m.p95).toBe(DEFAULT_FLAVOR_BASELINE.metrics[k].p95);
    }
    expect(r.warnings.some((w) => w.includes('回退默认基线值'))).toBe(true);
  });

  it('★ 引擎侧：回退维度的 DimensionScore.calibrated 为 false', () => {
    const samples = Array.from({ length: 5 }, (_, i) => s(`c${i}`, CH_A));
    const { baseline } = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);
    const report = detectFlavor(CH_A, 'x', undefined, baseline);
    // 全维度回退 → 全部未校准
    for (const d of report.dimensions) expect(d.calibrated).toBe(false);
    expect(report.calibratedRatio).toBe(0);
  });
});

// ── 4. 零膨胀 corpusMaxCount ─────────────────────────────────────────

describe('★ 零膨胀 corpusMaxCount（计数口径，自适应）', () => {
  /** 造一章含 `maxConnectors` 个模板连接词（0/1/2）的「热点章」+ 11 章干净章 */
  function corpus(maxConnectors: number) {
    const parts: string[] = [];
    if (maxConnectors >= 1) parts.push('然而，' + CH_A.slice(3));
    else parts.push(CH_A);
    if (maxConnectors >= 2) parts.push('因此，' + CH_B.slice(3));
    return [
      s('hot', parts.join('')),
      ...Array.from({ length: 11 }, (_, i) => s(`c${i}`, CH_C)),
    ];
  }

  it('语料单章最多 2 次 → corpusMaxCount=2、denom=6 → 1 次 = 17', () => {
    const r = buildFlavorBaseline(corpus(2), {}, FLAVOR_FEATURE_VERSION);
    const cm = r.baseline.metrics.connector_per1000.corpusMaxCount;
    expect(cm).toBe(2);
    expect(scoreZeroInflated(1, cm!)).toBe(17);
    expect(scoreZeroInflated(2, cm!)).toBe(33);
    expect(scoreZeroInflated(6, cm!)).toBe(100);
  });

  it('语料从不用连接词 → corpusMaxCount=0（引擎侧 max(0,1) 兜底 → 1 次 = 33）', () => {
    const r = buildFlavorBaseline(corpus(0), {}, FLAVOR_FEATURE_VERSION);
    const cm = r.baseline.metrics.connector_per1000.corpusMaxCount;
    expect(cm).toBe(0);
    expect(scoreZeroInflated(1, cm!)).toBe(33);
  });
});

// ── 6. 旧口径识别 ────────────────────────────────────────────────────

describe('★ 旧口径识别', () => {
  it('builder 产出的基线不过期（engineVersion = 当前特征口径）', () => {
    const samples = Array.from({ length: 12 }, (_, i) => s(`c${i}`, CH_A));
    const r = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);
    expect(r.baseline.engineVersion).toBe(FLAVOR_FEATURE_VERSION);
    expect(r.baseline.source).toBe('user');
    expect(isBaselineStale(r.baseline)).toBe(false);
  });
});

// ── 5. 端到端等价性（默认基线那 715 章；语料不存在则跳过）─────────────

/**
 * 语料目录。**不许硬编码某台机器的绝对路径。**
 *
 * 修复前这里写死了 `C:/Users/Administrator/Doubao/chats/2026-09-25/new-chat/分章_修复`
 * ——某位开发者机器上的路径。换机器或在 CI 上，`describe.runIf` 会**静默跳过**，
 * 而 runIf 不改变用例总数，报告照样显示「全绿」，看不出少跑了什么。
 *
 * 这条例外的分量：全项目的 AI 味打分都锚在 `DEFAULT_FLAVOR_BASELINE` 上，
 * 而这是唯一验证「它能由真实语料重算出来」的用例。它悄悄不跑，
 * 等于出厂基线的可复现性完全无人看守。
 *
 * 现在的解析顺序：
 *   1. 环境变量 `MZ_FLAVOR_CORPUS`
 *   2. git-ignored 的 `scripts/.corpus-path`（单行 UTF-8 路径）
 * 走文件而不是只走环境变量，是因为 `scripts/test.cmd` 要求纯 ASCII
 * （cmd 以 ANSI/GBK 解析），而语料路径含中文，经 cmd 传递会被编码搞坏。
 *
 * 跳过时**必须打印警告**，让「没跑」这件事可见。
 */
const CORPUS_DIR = resolveCorpusDir();
const HAS_CORPUS = CORPUS_DIR !== '' && existsSync(CORPUS_DIR);
if (!HAS_CORPUS) {
  console.warn(
    '[flavor-baseline] ⚠️ 已跳过「端到端等价性」验证（builder vs DEFAULT_FLAVOR_BASELINE）。\n' +
      `  原因：${CORPUS_DIR === '' ? '未设置 MZ_FLAVOR_CORPUS，也没有 scripts/.corpus-path' : `目录不存在：${CORPUS_DIR}`}\n` +
      '  影响：出厂基线的可复现性本轮无人看守。\n' +
      '  要跑：设 MZ_FLAVOR_CORPUS=<语料目录>，或在 scripts/.corpus-path 写入该路径（已 gitignore）。',
  );
}

function resolveCorpusDir(): string {
  const fromEnv = process.env['MZ_FLAVOR_CORPUS'];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  try {
    const p = join(process.cwd(), 'scripts', '.corpus-path');
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  } catch {
    // 读不到就当没有，走跳过分支
  }
  return '';
}

describe.runIf(HAS_CORPUS)('★ 端到端等价性（builder vs DEFAULT_FLAVOR_BASELINE，715 章同批文本）', () => {
  it('11 个指标分位数基本一致（差异仅来自 DEFAULT 基线是用引擎「展示级 measured」算的）', () => {
    // 根因（已核实）：`scripts/compute-flavor-baseline.mjs` 逐章取的是 `detectFlavor().dimensions[].measured`
    //   —— 那是**引擎用于展示的舍入值**（comma/marker 保留 2 位、sent_cv/para_cv/opening/dialog 3 位、
    //   ttr/tri_repeat 4 位）；builder 取的是 `extractFlavorFeatures()` 的**原始特征值**（不舍入）。
    //   故差异量级正好等于各指标的展示舍入单位（comma/marker ≈5e-3，其余 ≤5e-4）；
    //   connector/parallel/dash 三项两侧都走计数/未舍入通路，故 maxΔ=0。
    //   即：builder 更精确，DEFAULT 常量才是带舍入噪声的一方，偏差 ≤0.005（远小于判据跨度，不影响打分）。
    /** 引擎口径的标题剥离：去掉首个非空行，其余原样保留（与 compute 脚本一致） */
    const chapterBody = (raw: string): string => {
      const lines = raw.split(/\r?\n/);
      const i = lines.findIndex((l) => l.trim().length > 0);
      return i < 0 ? '' : lines.slice(i + 1).join('\n');
    };
    const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md')).sort();
    const samples = files.map((f) =>
      s(f, chapterBody(readFileSync(join(CORPUS_DIR, f), 'utf8'))),
    );

    const r = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);
    expect(r.used).toBe(715);

    const fields = ['p05', 'p25', 'p50', 'p75', 'p95', 'mean', 'min', 'max'] as const;
    const rows: string[] = [];
    let worst = 0;
    for (const k of FLAVOR_METRIC_KEYS) {
      let maxDiff = 0;
      for (const fld of fields) {
        const d = Math.abs(r.baseline.metrics[k][fld] - DEFAULT_FLAVOR_BASELINE.metrics[k][fld]);
        if (d > maxDiff) maxDiff = d;
      }
      if (maxDiff > worst) worst = maxDiff;
      rows.push(`${k.padEnd(22)} maxΔ=${maxDiff.toExponential(2)}`);
    }
    // eslint-disable-next-line no-console
    console.log('[715 等价性] 各指标最大绝对偏差：\n' + rows.join('\n') + `\n累计最大偏差 = ${worst}`);

    // 阈值 0.01：所有差异应远小于它（实测见 console 输出）。
    for (const k of FLAVOR_METRIC_KEYS) {
      for (const fld of fields) {
        expect(
          Math.abs(r.baseline.metrics[k][fld] - DEFAULT_FLAVOR_BASELINE.metrics[k][fld]),
          `${k}.${fld}`,
        ).toBeLessThan(0.01);
      }
    }
  });
});
