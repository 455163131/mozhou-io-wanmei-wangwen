# AI 味校准 · 验收报告

- 时间：2026-10-07T18:28:36.753Z
- 引擎版本：2.0.0｜特征口径：1.0.0
- 结果：**9/9 通过**

| 编号 | 检查项 | 结果 | 说明 |
|---|---|---|---|
| C1 | 三章真实原文回归 | ✅ PASS | 实测 2 / 9 / 13，期望 2 / 9 / 13（判据口径漂移护栏） |
| C2 | 零膨胀计数红线 | ✅ PASS | connector 0次→0(期望0)；connector 1次→33(期望33)；connector 3次→100(期望100)；parallel 1次→17(期望17)；parallel 2次→33(期望33)；parallel 6次→100(期望100) |
| C3 | 长度无关性 | ✅ PASS | 167/567/2967 字（各含 1 个「然而」）→ 33/33/33，期望恒 33 |
| C4 | 方向正确性（sent_cv 为 low-bad） | ✅ PASS | 均匀句长（CV≈0）→ 100（期望 >80）；长短交错（CV 高于 p95）→ 0（期望 0） |
| C5 | 值域 [0,100] / 无 NaN / 确定性 | ✅ PASS | 7 类对抗输入全部落在 [0,100]，两次运行逐字段一致 |
| C6 | 基线数据可复现（builder vs 提交 JSON） | ✅ PASS | used=715/715；p95 最大偏差 0.0e+0（），阈值 0.01 |
| C7 | builder ≡ DEFAULT_FLAVOR_BASELINE | ✅ PASS | p95 最大偏差 3.9e-3（comma_period_ratio），阈值 0.01 —— 超标即「用户重建基线换了把尺」 |
| C6b | 零膨胀 corpusMaxCount 与提交值一致 | ✅ PASS | connector=1（期望 1）、parallel=2（期望 2） |
| C8 | 引擎漂移检测（engine.ts md5 = 基线 enginePin） | ✅ PASS | md5=76e30388… 与基线一致 |
