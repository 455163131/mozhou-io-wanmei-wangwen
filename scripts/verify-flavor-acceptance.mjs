/**
 * AI 味校准 · 一键验收脚本（T05）。
 *
 * ★ 目的：把 QA 与主理人**手工做过**的整条验收链固化成一条命令，任何人在
 *   改动引擎/基线/词表之后都能立即自检，而不是等下一轮 QA 才发现问题。
 *
 * 覆盖 8 项检查（每项都对应历史上真实出过的问题）：
 *   C1 三章真实原文回归 2/9/13     —— 判据口径是否漂移（回归护栏）
 *   C2 零膨胀计数红线              —— 「1 个字眼定生死」bug 的护栏
 *   C3 长度无关性                  —— 密度口径回归的护栏（600 字=100 分那次）
 *   C4 方向正确性                  —— high-bad/low-bad 边界取反的护栏
 *   C5 值域与确定性                —— NaN/Infinity/负分/随机性
 *   C6 基线数据可复现              —— builder(715章) vs 提交的 JSON（改数据没重算）
 *   C7 builder ≡ DEFAULT_FLAVOR    —— 用户自建基线与内置基线同口径
 *   C8 引擎漂移检测                —— engine.ts 归一化 md5 vs 基线 enginePin（改引擎没重算基线）
 *
 * 运行：node scripts/verify-flavor-acceptance.mjs [--out data/flavor_acceptance_report.md]
 * 退出码：全部通过 = 0；任一 FAIL = 1（可直接接 CI）。
 *
 * ★ 与 compute 脚本共用同一份 bundle 装配（./lib-engine-bundle.mjs），口径零漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, loadEngineBundle, engineSourceMd5 } from './lib-engine-bundle.mjs';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// ── 数据源（与 compute 脚本同源）──────────────────────────────────────
const DEMO_CHAPTERS =
  'C:/Users/Administrator/WorkBuddy AI/2026-10-07-08-51-57/outputs/demo_chapters.json';
const CORPUS_SRC = 'C:/Users/Administrator/Doubao/chats/2026-09-25/new-chat/分章_修复';
const DATA_JSON = path.join(ROOT, 'data', 'corpus_flavor_baseline.json');

/** `--out <file>`：把验收报告写成 markdown（可选） */
const argv = process.argv.slice(2);
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;

/** builder bundle（T03 的 buildFlavorBaseline + DEFAULT_FLAVOR_BASELINE） */
const BUILDER_SRC = path.join(ROOT, 'src', 'main', 'flavor', 'baseline-builder.ts');
const BUILDER_BUNDLE = path.join(__dirname, '.builder-bundle.mjs');
/** baseline 常量 bundle（DEFAULT_FLAVOR_BASELINE / isBaselineStale） */
const BASELINE_SRC = path.join(ROOT, 'src', 'shared', 'ai-flavor', 'baseline.ts');
const BASELINE_BUNDLE = path.join(__dirname, '.baseline-bundle.mjs');

// ── 结果收集 ─────────────────────────────────────────────────────────
const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass: Boolean(pass), detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 装配三个 bundle ──────────────────────────────────────────────────
function buildExtra(entry, outfile, extraAlias = {}) {
  const esbuild = createRequire(import.meta.url)('esbuild');
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: {
      '@shared': path.join(ROOT, 'src', 'shared'),
      '@main': path.join(ROOT, 'src', 'main'),
      ...extraAlias,
    },
    // chapter-repo 只 type-import better-sqlite3（esbuild 会剔除类型导入），
    // 但显式 external 更稳：万一将来引入运行时依赖也不会把原生模块打进 bundle。
    external: ['better-sqlite3', 'electron'],
    outfile,
    logLevel: 'warning',
  });
}

console.log('AI 味校准 · 验收脚本');
console.log('='.repeat(64));

const engine = await loadEngineBundle();

buildExtra(BUILDER_SRC, BUILDER_BUNDLE);
buildExtra(BASELINE_SRC, BASELINE_BUNDLE);
const builder = await import(pathToFileURL(BUILDER_BUNDLE).href);
const baselineMod = await import(pathToFileURL(BASELINE_BUNDLE).href);
const {
  buildFlavorBaseline,
} = builder;
const {
  DEFAULT_FLAVOR_BASELINE,
} = baselineMod;

const { detectFlavor, FLAVOR_ENGINE_VERSION, FLAVOR_FEATURE_VERSION } = engine;
const CFG = undefined; // 省略 → 用引擎默认配置（与 detectFlavor 生产路径一致）

// ── 语料读取（与 compute 脚本同口径：去首行标题，其余原样）──────────
function readCorpusSamples() {
  const files = fs.readdirSync(CORPUS_SRC).filter((f) => f.endsWith('.md'));
  return files.map((f) => {
    const lines = fs.readFileSync(path.join(CORPUS_SRC, f), 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim().length > 0);
    return { chapterId: f, text: lines.slice(i + 1).join('\n') };
  });
}

function readDemoChapters() {
  const j = JSON.parse(fs.readFileSync(DEMO_CHAPTERS, 'utf8'));
  return j.map((c) => ({ no: c.no, body: c.body }));
}

// ── C1 三章真实原文回归 ──────────────────────────────────────────────
function c1() {
  const chs = readDemoChapters();
  const idx = chs.map((c) => detectFlavor(c.body, String(c.no), CFG).index);
  const pass = idx.length === 3 && idx[0] === 2 && idx[1] === 9 && idx[2] === 13;
  check('C1', '三章真实原文回归', pass, `实测 ${idx.join(' / ')}，期望 2 / 9 / 13（判据口径漂移护栏）`);
}

// ── C2 零膨胀计数红线 ────────────────────────────────────────────────
function c2() {
  const filler = '他走在路上，看着两旁的树，心里想着一些事情。'.repeat(40);
  const dimOf = (t, name) =>
    detectFlavor(t, 'x', CFG).dimensions.find((d) => d.dimension === name);
  const ok = [];
  // connector：corpusMaxCount=1 → denom=3 → 0次=0 / 1次=33 / 3次=100
  for (const [n, want] of [[0, 0], [1, 33], [3, 100]]) {
    const conn = ['然而', '因此', '与此同时'].slice(0, n).map((w) => `${w}，`).join('');
    const d = dimOf(filler + conn, 'template-connector');
    ok.push(`connector ${n}次→${d.score}(期望${want})`);
    if (d.score !== want) return check('C2', '零膨胀计数红线', false, ok.join('；'));
  }
  // parallel：corpusMaxCount=2 → denom=6 → 1次=17 / 2次=33 / 6次=100
  for (const [n, want] of [[1, 17], [2, 33], [6, 100]]) {
    const d = dimOf(filler + '不是他不愿，而是他不能。'.repeat(n), 'parallel-structure');
    ok.push(`parallel ${n}次→${d.score}(期望${want})`);
    if (d.score !== want) return check('C2', '零膨胀计数红线', false, ok.join('；'));
  }
  check('C2', '零膨胀计数红线', true, ok.join('；'));
}

// ── C3 长度无关性（密度口径回归的护栏）──────────────────────────────
function c3() {
  const dim = (t) =>
    detectFlavor(t, 'x', CFG).dimensions.find((d) => d.dimension === 'template-connector').score;
  const short = '他走了。'.repeat(140) + '然而，天黑了。';
  const mid = '他走了。'.repeat(280) + '然而，天黑了。';
  const long = '他走了。'.repeat(740) + '然而，天黑了。';
  const a = dim(short), b = dim(mid), c = dim(long);
  const pass = a === b && b === c && a === 33;
  check('C3', '长度无关性', pass, `167/567/2967 字（各含 1 个「然而」）→ ${a}/${b}/${c}，期望恒 33`);
}

// ── C4 方向正确性（low-bad 边界取上侧 = 大错，本项目真踩过）─────────
function c4() {
  const dim = (t) =>
    detectFlavor(t, 'x', CFG).dimensions.find((d) => d.dimension === 'sentence-rhythm').score;
  // 句长极度均匀（CV≈0，远低于 p05=0.4907）→ 应得高分
  const uniform = dim('他走了。'.repeat(400));
  // 句长剧烈交错（CV 高，高于 p95=0.6403）→ 落在正常带外上侧 → 必须 0 分
  const longSent =
    '他走在那条看不到尽头的路上，看着两旁不断向后退去的树影，心里想着一些说不上重要却也放不下的事情。';
  const varied = dim((longSent + '他走了。').repeat(60));
  const pass = uniform > 80 && varied === 0;
  check(
    'C4',
    '方向正确性（sent_cv 为 low-bad）',
    pass,
    `均匀句长（CV≈0）→ ${uniform}（期望 >80）；长短交错（CV 高于 p95）→ ${varied}（期望 0）`,
  );
}

// ── C5 值域与确定性 ──────────────────────────────────────────────────
function c5() {
  const inputs = [
    '', '   ', '。！？', '他走了。', '然而，'.repeat(50),
    '他走了。'.repeat(3000), // 1.2 万字
    '“对白。”「角引。」"直引。"',
  ];
  let bad = '';
  const snap = (t) =>
    detectFlavor(t, 'x', CFG).dimensions.map((d) => d.score).join(',');
  let deterministic = true;
  for (const t of inputs) {
    const r1 = detectFlavor(t, 'x', CFG);
    const label = `len=${String(t.length).padStart(6)}`;
    const scores = [r1.index, ...r1.dimensions.map((d) => d.score)];
    if (scores.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) {
      bad += `${label} 出现越界/NaN；`;
    }
    if (snap(t) !== snap(t)) deterministic = false;
  }
  check(
    'C5',
    '值域 [0,100] / 无 NaN / 确定性',
    bad === '' && deterministic,
    bad || `7 类对抗输入全部落在 [0,100]，两次运行${deterministic ? '逐字段一致' : '不一致'}`,
  );
}

// ── C6/C7 基线复现与等价（715 章）───────────────────────────────────
function c6c7() {
  const samples = readCorpusSamples();
  const r = buildFlavorBaseline(samples, {}, FLAVOR_FEATURE_VERSION);
  const committed = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
  const keys = Object.keys(DEFAULT_FLAVOR_BASELINE.metrics);

  // C6 vs 提交的 JSON（percentiles）
  let d6 = 0, worst6 = '';
  for (const k of keys) {
    const committedP95 = committed.metrics?.[k]?.p95;
    if (committedP95 === undefined) continue;
    const d = Math.abs(r.baseline.metrics[k].p95 - committedP95);
    if (d > d6) { d6 = d; worst6 = k; }
  }
  check(
    'C6',
    '基线数据可复现（builder vs 提交 JSON）',
    r.used === 715 && d6 <= 0.01,
    `used=${r.used}/${samples.length}；p95 最大偏差 ${d6.toExponential(1)}（${worst6}），阈值 0.01`,
  );

  // C7 vs DEFAULT_FLAVOR_BASELINE（用户自建基线必须与内置基线同口径）
  let d7 = 0, worst7 = '';
  for (const k of keys) {
    const d = Math.abs(r.baseline.metrics[k].p95 - DEFAULT_FLAVOR_BASELINE.metrics[k].p95);
    if (d > d7) { d7 = d; worst7 = k; }
  }
  check(
    'C7',
    'builder ≡ DEFAULT_FLAVOR_BASELINE',
    d7 <= 0.01,
    `p95 最大偏差 ${d7.toExponential(1)}（${worst7}），阈值 0.01 —— 超标即「用户重建基线换了把尺」`,
  );

  // 附带：corpusMaxCount 必须与提交值一致（connector=1 / parallel=2）
  const cmc = {
    connector: r.baseline.metrics.connector_per1000.corpusMaxCount,
    parallel: r.baseline.metrics.parallel_per100sent.corpusMaxCount,
  };
  check(
    'C6b',
    '零膨胀 corpusMaxCount 与提交值一致',
    cmc.connector === 1 && cmc.parallel === 2,
    `connector=${cmc.connector}（期望 1）、parallel=${cmc.parallel}（期望 2）`,
  );
}

// ── C8 引擎漂移检测（改引擎没重算基线）──────────────────────────────
function c8() {
  const dataJson = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
  const pinned = dataJson.enginePin?.engineSrcMd5 ?? null;
  const current = engineSourceMd5();
  const pass = pinned !== null && pinned === current;
  check(
    'C8',
    '引擎漂移检测（engine.ts 行尾归一化 md5 = 基线 enginePin）',
    pass,
    pass
      ? `md5=${current.slice(0, 8)}… 与基线一致（口径：CRLF→LF 归一化后求，与本机行尾无关）`
      : `engine.ts md5=${current.slice(0, 8)}… ≠ 基线 pin=${String(pinned).slice(0, 8)}… —— 改了引擎但没重算基线，分数与基线不可比！`,
  );
}

// ── 执行 ─────────────────────────────────────────────────────────────
c1();
c2();
c3();
c4();
c5();
c6c7();
c8();

const failed = results.filter((r) => !r.pass);
console.log('');
console.log('='.repeat(64));
console.log(
  `验收结果：${results.length - failed.length}/${results.length} 通过` +
    (failed.length ? `，失败：${failed.map((f) => f.id).join('、')}` : '，全部通过'),
);
console.log(`引擎版本 ${FLAVOR_ENGINE_VERSION} ｜ 特征口径 ${FLAVOR_FEATURE_VERSION}`);

if (OUT) {
  const md = [
    '# AI 味校准 · 验收报告',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 引擎版本：${FLAVOR_ENGINE_VERSION}｜特征口径：${FLAVOR_FEATURE_VERSION}`,
    `- 结果：**${results.length - failed.length}/${results.length} 通过**${failed.length ? `（失败：${failed.map((f) => f.id).join('、')}）` : ''}`,
    '',
    '| 编号 | 检查项 | 结果 | 说明 |',
    '|---|---|---|---|',
    ...results.map(
      (r) => `| ${r.id} | ${r.name} | ${r.pass ? '✅ PASS' : '❌ FAIL'} | ${r.detail} |`,
    ),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md, 'utf8');
  console.log(`报告已写入：${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);
}

process.exit(failed.length ? 1 : 0);
