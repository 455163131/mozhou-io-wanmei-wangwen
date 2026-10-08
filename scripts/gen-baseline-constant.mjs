/**
 * 基线常量生成器（确定性、零依赖，只用 node 内置）。
 *
 * 用途：语料更新 / 引擎口径变更后，一条命令重写
 *   `src/shared/ai-flavor/baseline.ts` 里的 **metrics 常量块**——
 * 避免手工把 11 个指标 × 8 个分位抄错（手工抄录是本项目已发生过的事故类型）。
 *
 * 只重写两处标记之间的内容：
 *   - engineVersion：`/* @generated:engineVersion:start *​/ … /* @generated:engineVersion:end *​/`
 *     （写成**字面量**——语义是「生成该基线时的**特征提取口径**版本」，不能引用实时常量。
 *      注意不是 FLAVOR_ENGINE_VERSION，详见 baseline.ts 注释。）
 *   - metrics：`/* @generated:metrics:start *​/ … /* @generated:metrics:end *​/`
 * 标记之外（类型定义、其余顶层字段、注释）一律不动。
 *
 * 输入：data/corpus_flavor_baseline.json（由 scripts/compute-flavor-baseline.mjs 产出）
 * 输出：src/shared/ai-flavor/baseline.ts（原地重写常量块）
 * 运行：node scripts/gen-baseline-constant.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JSON_IN = path.join(ROOT, 'data', 'corpus_flavor_baseline.json');
const TS_OUT = path.join(ROOT, 'src', 'shared', 'ai-flavor', 'baseline.ts');

/** 与 baseline.ts 的 FLAVOR_METRIC_KEYS 保持同一顺序（顺序固定，避免 diff 噪声） */
const METRIC_KEYS = [
  'sent_cv',
  'para_cv',
  'ttr',
  'tri_repeat',
  'opening_dup_ratio',
  'connector_per1000',
  'ai_marker_per1000',
  'comma_period_ratio',
  'dash_ellipsis_per1000',
  'dialog_para_ratio',
  'parallel_per100sent',
];

const START = '/* @generated:metrics:start */';
const END = '/* @generated:metrics:end */';
const EV_START = '/* @generated:engineVersion:start */';
const EV_END = '/* @generated:engineVersion:end */';

/** 零膨胀指标的注记（p95===0 时自动加，说明「0 是数据事实不是缺失」） */
const ZERO_INFLATION_NOTE = '    // 零膨胀：本语料 ≥95% 章节为 0（人写几乎不出现；只有 AI 腔才会非零）';

function fmt(v) {
  // JSON 里的数已是定值，直接原样输出，避免再次舍入引入漂移
  return String(v);
}

function buildMetricsBlock(percentiles) {
  const lines = ['  metrics: {'];
  for (const k of METRIC_KEYS) {
    const m = percentiles[k];
    if (!m) throw new Error(`JSON 缺少指标 ${k}`);
    for (const f of ['p05', 'p25', 'p50', 'p75', 'p95', 'mean', 'min', 'max']) {
      if (typeof m[f] !== 'number') throw new Error(`指标 ${k} 缺少字段 ${f}`);
    }
    if (m.p95 === 0) lines.push(ZERO_INFLATION_NOTE);
    // ★ 零膨胀指标额外烙 `corpusMaxCount`（语料单章出现次数最大值），判据层计数口径用。
    //   机械派生自 JSON（compute 脚本已按逐章原始计数算出），不手抄。
    const tail =
      typeof m.corpusMaxCount === 'number' ? `, corpusMaxCount: ${fmt(m.corpusMaxCount)}` : '';
    lines.push(
      `    ${k}: { p05: ${fmt(m.p05)}, p25: ${fmt(m.p25)}, p50: ${fmt(m.p50)}, p75: ${fmt(m.p75)}, ` +
        `p95: ${fmt(m.p95)}, mean: ${fmt(m.mean)}, min: ${fmt(m.min)}, max: ${fmt(m.max)}${tail} },`,
    );
  }
  lines.push('  },');
  return lines.join('\n');
}

/** 把 src 中 start/end 标记之间的内容替换为 inner（保留标记行本身） */
function replaceRegion(src, start, end, inner) {
  const s = src.indexOf(start);
  const e = src.indexOf(end);
  if (s < 0 || e < 0 || e < s) throw new Error(`找不到标记对：${start}`);
  return src.slice(0, s + start.length) + inner + src.slice(e);
}

function main() {
  if (!fs.existsSync(JSON_IN)) throw new Error(`找不到输入：${JSON_IN}`);
  const json = JSON.parse(fs.readFileSync(JSON_IN, 'utf8'));
  if (!json.percentiles) throw new Error('输入 JSON 缺少 percentiles 字段');
  // ★ engineVersion 字段的值 = 「生成该基线时的**特征提取口径**版本」。
  //   优先取 featureVersion（新脚本会写）；旧 JSON 只有 engineVersion（旧脚本未区分打分/特征，
  //   但当时特征提取即全体口径，取它不影响结果）。
  const featureVersion = json.featureVersion ?? json.engineVersion;
  if (typeof featureVersion !== 'string' || !featureVersion) {
    throw new Error('输入 JSON 缺少 featureVersion / engineVersion');
  }

  const src = fs.readFileSync(TS_OUT, 'utf8');

  // 1) 特征版本：写成**字面量**（语义 = 生成该基线时的特征提取口径版本，不能引用实时常量）
  const evInner = `\n  engineVersion: '${featureVersion}',\n  `;
  // 2) 11 个指标常量块
  const metricsBlock = buildMetricsBlock(json.percentiles);

  let next = replaceRegion(src, EV_START, EV_END, evInner);
  next = replaceRegion(next, START, END, `\n${metricsBlock}\n  `);

  if (next === src) {
    console.log('基线常量已是最新，无需改动。');
  } else {
    fs.writeFileSync(TS_OUT, next, 'utf8');
    console.log('已重写基线常量块 →', TS_OUT);
  }
  console.log('featureVersion(JSON):', featureVersion, '| chapters:', json.corpus?.chapters_ok);
  console.log(
    '⚠️ 提醒：若该版本 ≠ engine.ts 的 FLAVOR_FEATURE_VERSION，说明**特征提取口径**已变；' +
      'isBaselineStale() 会据此报「基线过期」，请确认是否需要重算基线。' +
      '（注意：只改打分逻辑【不该】bump 特征版本，也【不该】报过期。）',
  );
}

main();
