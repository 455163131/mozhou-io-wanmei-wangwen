# 715 章 AI 味全维度基线（corpus_flavor_baseline）

- **engineVersion**: `2.0.0`
- **engine.ts md5（口径 pin）**: `88d5a88ebf4b2f5292abaaeb6be72ab8`（1249 行）
- **词表规模**: TEMPLATE_CONNECTORS=18、AI_MARKERS=9（含朱雀 P1 副词+动词）、PARALLEL_PATTERNS=10
- **语料**: `C:/Users/Administrator/Doubao/chats/2026-09-25/new-chat/分章_修复`
- **章节**: 715/715 成功，0 跳过
- **样本不足（<200 字，引擎 sufficient=false）**: 0
- **分位数口径**: linear interpolation on sorted values: idx=(n-1)*p, numpy default
- **预处理**: drop first non-empty line (title); keep remaining lines verbatim (blank-line separated)

## 一、11 维指标分位数

| 指标 | n | p05 | p25 | p50 | p75 | p95 | mean | min | max |
|---|---|---|---|---|---|---|---|---|---|
| sent_cv | 715 | 0.4907 | 0.53 | 0.558 | 0.591 | 0.6403 | 0.5611 | 0.455 | 0.721 |
| para_cv | 715 | 0.584 | 0.653 | 0.718 | 0.7965 | 0.938 | 0.733 | 0.446 | 1.146 |
| ttr | 715 | 0.1232 | 0.1449 | 0.1561 | 0.1698 | 0.1937 | 0.1573 | 0.1002 | 0.2404 |
| tri_repeat | 715 | 0.1914 | 0.2409 | 0.2778 | 0.3145 | 0.3825 | 0.2791 | 0.0885 | 0.4767 |
| opening_dup_ratio | 715 | 0.077 | 0.099 | 0.124 | 0.1585 | 0.214 | 0.1314 | 0.049 | 0.274 |
| connector_per1000 | 715 | 0 | 0 | 0 | 0 | 0 | 0.0007 | 0 | 0.4708 |
| ai_marker_per1000 | 715 | 0 | 0.47 | 0.94 | 1.435 | 2.353 | 0.9764 | 0 | 3.06 |
| comma_period_ratio | 715 | 0.487 | 0.59 | 0.69 | 0.8 | 0.99 | 0.7079 | 0.38 | 1.27 |
| dash_ellipsis_per1000 | 715 | 0 | 0 | 0 | 0.4637 | 1.9283 | 0.3299 | 0 | 4.9706 |
| dialog_para_ratio | 715 | 0.4028 | 0.56 | 0.656 | 0.736 | 0.827 | 0.6416 | 0.089 | 0.905 |
| parallel_per100sent | 715 | 0 | 0 | 0 | 0 | 0 | 0.0112 | 0 | 1.8519 |

## 二、口径（与 engine.ts 对齐）

- **sent_cv**: engine<dim sentence-rhythm>.measured = cvOf(sentence nospace lengths) = pstdev/mean
- **para_cv**: engine<dim paragraph-rhythm>.measured = cvOf(paragraph nospace lengths); recorded even when dialog-paced (score=0)
- **ttr**: engine<dim lexical-diversity>.measured = |unique single chars| / chars(nospace)
- **tri_repeat**: engine<dim phrase-repetition>.measured = (triCount - |unique trigrams|) / triCount, trigram = 3 consecutive chars over nospace
- **opening_dup_ratio**: engine<dim opening-pattern>.measured = maxDup2charSentHead / sentenceCount
- **connector_per1000**: 密度 = connector_count * 1000 / chars（仅展示/历史对照）；★ 判据走**计数口径** connector_count，见 corpusMaxCount
- **ai_marker_per1000**: engine<dim marker-density>.measured = AI_MARKERS hits * 1000 / chars
- **comma_period_ratio**: engine<dim punctuation-pattern>.measured = commaCount/periodCount (comma=[，,、；;] period=[。！？!?]; if period=0 and comma>0 -> 6)
- **dash_ellipsis_per1000**: (PUNCT_DASH + PUNCT_ELLIPSIS) hits * 1000 / chars; engine.ts regexes verbatim (engine does NOT expose this as measured)
- **dialog_para_ratio**: engine<dim dialog-ratio>.measured = paragraphs matching /[“"「][^”"」]{1,400}[”"」]/ / paragraphCount
- **parallel_per100sent**: 密度 = parallel_count * 100 / sentenceCount（仅展示/历史对照）；★ 判据走**计数口径** parallel_count，见 corpusMaxCount

## 三、辅助指标（供交叉验证）

| 指标 | n | p05 | p25 | p50 | p75 | p95 | mean | min | max |
|---|---|---|---|---|---|---|---|---|---|
| avg_sent | 715 | 10.6025 | 11.595 | 12.404 | 13.4195 | 15.0167 | 12.5842 | 8.832 | 20.582 |
| avg_para | 715 | 12.453 | 14.9965 | 18.748 | 22.757 | 28.9989 | 19.4212 | 9.564 | 45.614 |
| sents_per_para | 715 | 1.0949 | 1.2323 | 1.469 | 1.6991 | 2.1153 | 1.5108 | 0.9185 | 3.2273 |
| chars | 715 | 2012.7 | 2049.5 | 2104 | 2177 | 2286 | 2119.4462 | 2000 | 2300 |
| paras | 715 | 73 | 94 | 113 | 141.5 | 170.3 | 117.3608 | 44 | 220 |
| sents | 715 | 137 | 155 | 168 | 181 | 201 | 168.3105 | 98 | 234 |
| connector_count | 715 | 0 | 0 | 0 | 0 | 0 | 0.0014 | 0 | 1 |
| parallel_count | 715 | 0 | 0 | 0 | 0 | 0 | 0.014 | 0 | 2 |

## 四、交叉验证（对旧 corpus_baseline / corpus_distribution）

mine = 按章算术平均（我们 computed 的 mean）；old = corpus_distribution.mean（首选）或 corpus_baseline.summary.aggregate_weighted（回退）。exceed5pct=true 表示偏差 >5%，需排查口径差异；带 `disclosure` 字段的项**已确认是口径差异而非数据错误**（证据来自复算，见该项 disclosure 与 deviationAnalysis），不要当成基线算错。

| 指标 | 本次(按章均值) | 旧基线 | 偏差% | >5% |
|---|---|---|---|---|
| sent_cv | 0.5611 | 0.664 | -15.5 | ⚠️ 是 |
| ttr | 0.1573 | 0.157 | 0.19 | 否 |
| tri_repeat | 0.2791 | 0.279 | 0.04 | 否 |
| dialog_para_ratio | 0.6416 | 0.642 | -0.06 | 否 |
| avg_para | 19.4212 | 19.421 | 0 | 否 |
| avg_sent | 12.5842 | 11.729 | 7.29 | ⚠️ 是 |
| sents_per_para | 1.5108 | 1.515 | -0.28 | 否 |

偏差 >5% 的项：sent_cv、avg_sent

> ⚠️ **口径差异披露（不是数据错误）**：
> - **sent_cv**：口径差异，**不是数据错误**：旧基线把标点（含句末标点/逗号）排除在句长之外，引擎口径包含标点。按旧口径复算得 0.6687（相对旧值 0.71%）；4 个与句长无关的指标（ttr / tri_repeat / dialog_para_ratio / avg_para）偏差均 <0.3%。交付值采用引擎口径。
> - **avg_sent**：口径差异：旧 avg_sent = (chars − sents)/sents（每句恰扣 1 个句末标点），非引擎的句长均值。按旧口径复算得 11.7622；avg_sent 非本次交付指标，仅作辅助参照。

### 4.1 偏差根因（复算验证）

- 自洽性：ttr / tri_repeat / dialog_para_ratio / avg_para 均与句长无关，故 4 项偏差 <0.3%；sent_cv / avg_sent 依赖句长，是唯二偏差项 —— 与「标点是唯一差异」的假设自洽。

**sent_cv**（explained）
- 根因：句长口径差异：旧基线将标点（含句末标点/逗号）排除在句长之外；engine.ts:611 口径包含标点。
- 引擎口径值：0.5611
- 旧发布值：0.664
- 按旧口径复算：0.6687（相对旧值 0.71%）
- 结论：按旧口径复算后偏差收敛到 ±2% 内 —— 偏差 100% 来自标点约定，计算本身无错。交付值采用引擎口径。

**avg_sent**（explained）
- 根因：旧基线 avg_sent = (chars - sents)/sents（每句恰扣 1 个句末标点）；不等同于引擎的句长均值。
- 引擎口径值：12.5842
- 旧发布值：11.729
- 按旧口径复算：11.7622（相对旧值 0.28%）
- 结论：按旧口径复算后偏差 <0.3% —— 偏差来自句长约定。avg_sent 非本次交付指标，仅作辅助参照。

### 4.2 旧口径复现值（证据，非交付口径）

| 指标 | mean | p50 | n | 说明 |
|---|---|---|---|---|
| sent_cv_excl_punct | 0.6687 | 0.6654 | 715 | 标点排除版句长 CV |
| avg_sent_minus1 | 11.7622 | 11.527 | 715 | (chars-sents)/sents |

## 五、校准提示（实测事实，供引擎阈值复校）

### 5.1 paragraph-rhythm 对本语料 100% 不参与判定
- 引擎规则：dimParagraphRhythm（v2）: 对白段占比≥85% 且 句/段≤1.05（「对白墙」）→ 该维度 skipped=true，不参与总评
- 实测：段落中位 min 8 / p50 14 / max 37；跳过 0/715 章，参与 715 章
- 结论：v2 起护栏只看对白占比（不再看段长）。本语料 0/715 章被判为「对白墙」而 skipped，其余 715 章正常参与 paragraph-rhythm 判定。

### 5.2 comma_period_ratio 与引擎「人写 1.2~2.5」断言不符
- 引擎断言：engine 注释称「人写网文常见 1.2~2.5」，scale(good=2.5, bad=5.5)
- 实测：mean 0.7079 / p50 0.69 / min 0.38 / max 1.27；落在 1.2~2.5 的章数 1/715
- 结论：实测该书逗号/句号比 min 0.38 / p50 0.69 / max 1.27，仅 1/715 章落在引擎断言的「1.2~2.5」内——引擎的「人写基准 2.5」对本语料偏高，建议复校 good 锚点（实测人写 ≈0.7）。当前不会产生误报（低于 2.5 一律 score=0），但 note 文案会误导。

### 5.3 sent_cv 与引擎「人写 >0.55」断言
- 引擎断言：dimSentenceRhythm: 注释称「人写中文小说句长 CV 通常 >0.55」，scale(good=0.6, bad=0.25)
- 实测：mean 0.5611 / p25 0.53 / p50 0.558
- 结论：实测 mean 0.5611、p25 0.53，约半数章节 <0.55——「人写 >0.55」仅为边缘成立；按 scale(0.6,0.25) 人写文本会稳定拿到 ~10~25 分。若需零误报可考虑下调 good 锚点。
