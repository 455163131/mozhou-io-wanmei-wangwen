// tests/integration/teardown-view-wiring.test.ts —— P2-C T5 拆书报告页接线（R46：读源码文本，不挂载）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const modes = readFileSync('src/shared/constants/modes.ts', 'utf8');
const app = readFileSync('src/renderer/App.tsx', 'utf8');
const palette = readFileSync('src/renderer/components/common/CommandPalette.tsx', 'utf8');
const view = readFileSync('src/renderer/components/views/TeardownView.tsx', 'utf8');
const service = readFileSync('src/main/inspiration/teardown-service.ts', 'utf8');
const sharedTypes = readFileSync('src/shared/types/inspiration.ts', 'utf8');
describe('拆书报告页接线', () => {
  it('modes.ts 注册 teardown + 四字 label', () => {
    expect(modes).toMatch(/'teardown'/);
    expect(modes).toMatch(/teardown:\s*'拆书报告'/);
  });
  it('App.tsx 灵感组 soon 占位转正为 mode 且分派 TeardownView（原地替换，不许双入口）', () => {
    expect(app).not.toMatch(/soon-teardown/);
    expect(app).toMatch(/id:\s*'teardown'/);
    expect(app).toMatch(/mode\s*===\s*'teardown'\s*&&\s*<TeardownView/);
    expect(app).toMatch(/case\s*'mode:teardown'/);
  });
  it('CommandPalette 有 mode:teardown 命令', () => {
    expect(palette).toMatch(/id:\s*'mode:teardown'/);
  });
  it('TeardownView 走 sequencer + 零token结构统计秒出 + AI 精读八维 + live/演示明示 + 存入灵感库', () => {
    expect(view).toMatch(/createSequencer/);
    expect(view).toMatch(/零\s*token/);
    expect(view).toMatch(/teardown\.structure/);
    expect(view).toMatch(/teardown\.read|精读/);
    expect(view).toMatch(/演示|实时/);
    expect(view).toMatch(/saveDimension|存入灵感库/);
  });
  it('TeardownView 选已导入书只走只读通道（绝不写正文：update/create/import 都不许出现）', () => {
    expect(view).not.toMatch(/chapter\.update|chapter\.create|importMarkdown/);
  });
  // ★ 终审修复波 T5①：saveDim 的 await 后写入要过时效闸——重点「结构统计」换了报告后，
  //   旧 saveDim 的迟到响应不许把新报告的该维标成「已存入」（captured-reportId + ref 口径）。
  it('TeardownView saveDim 有 captured-reportId 时效闸（迟到的旧报告响应不落新报告状态）', () => {
    expect(view).toMatch(/reportIdRef/);
    expect(view).toMatch(/capturedReportId/);
  });
  // ── B批①：runRead 同款时效闸——精读在飞时报告被换，迟到八维不许画到新报告头上，且如实告知不静默 ──
  it('B批①：runRead 有 captured-reportId 时效闸 + 丢弃如实告知（不静默吞）', () => {
    expect(view).toMatch(/capturedReadReportId\s*=\s*report\.reportId/);
    expect(view).toMatch(/reportIdRef\.current !== capturedReadReportId/);
    expect(view).toMatch(/精读结果已丢弃/);
    // 闸在 await 之后、setRead 之前（先对账再落状态）
    const gated = view.slice(view.indexOf('capturedReadReportId'));
    expect(gated.indexOf('reportIdRef.current !== capturedReadReportId')).toBeLessThan(gated.indexOf('setRead(r)'));
  });
  // ── B批②：两大 CTA 互斥禁用——精读在飞时「结构统计」必须禁用（正是 B批① 竞态的触发口）──
  it('B批②：结构统计与 AI 精读按钮互斥禁用（busyStruct × busyRead 双向都挡）', () => {
    expect(view).toMatch(/disabled=\{busyStruct \|\| busyRead \|\| text\.trim\(\)\.length === 0\}/);
    expect(view).toMatch(/disabled=\{!report \|\| busyRead \|\| busyStruct\}/);
  });
  // ── B批③：「模型产出」失实——精读只喂 structureBrief（统计+引文+人名），模型从未读原文 ──
  it('B批③：八维精读 live 标签如实写「模型推断·未读原文」，不许再写「模型产出」', () => {
    expect(view).not.toMatch(/模型产出/);
    expect(view).toMatch(/模型推断·基于结构统计·未读原文/);
  });
  // ── B批④：引文长度标签写真界——snippetAround(radius=16) 窗口 ≤32 字，「≤16 字」是假的 ──
  it('B批④：view/service/shared 类型注释的引文长度一律写 ≤32 字，「≤16 字」清零', () => {
    expect(view).toMatch(/引文 ≤32 字/);
    expect(view).not.toMatch(/≤16 字/);
    expect(service).not.toMatch(/≤16 字/);
    expect(sharedTypes).not.toMatch(/≤16 字/);
  });
  // ── B批⑤：LCS 合规裁决不许算完即扔——passed=false 时 view 上屏真因（compliance.note 原文）──
  it('B批⑤：TeardownView 消费 structure.compliance 裁决，passed=false 上屏警告原文', () => {
    expect(view).toMatch(/s\.compliance && !s\.compliance\.passed/);
    expect(view).toMatch(/版权合规警告/);
    expect(view).toMatch(/\{s\.compliance\.note\}/);
    expect(service).toMatch(/compliance:\s*dr\.ok && dr\.data/); // 服务端确实把裁决塞进 structure，不再解构即扔
    expect(service).not.toMatch(/原样生效/); // 旧注释「版权守卫原样生效」失实，必须随修复更新
  });
  // ── B批⑥：每条演示兜底路径的回落真因都要在界面上看得到（4afa140 已接 fallbackNote，此钉防回归）──
  it('B批⑥：演示兜底说明旁展示 fallbackNote 回落真因（llm:progress fallback 事件）', () => {
    expect(view).toMatch(/useLlmProgress\('teardown', busyRead\)/);
    expect(view).toMatch(/本次回落真因：\$\{fallbackNote\}/);
    expect(service).toMatch(/progress\.fallback\(progressCause\(e\)\)/);
  });
});
