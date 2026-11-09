// tests/integration/d-batch-wiring.test.ts
//
// ★ D批「能力可见」接线哨兵（R46 源扫描口径，照 trending-import-wiring 模式）。
//
// 背景：两处后端能力在 UI 上不可见——
//   D1：pipeline:write-draft 的 handler 一直回传装配裁剪 trace（TrimTrace[]），
//       但 IPC unwrap 只取 draftId，渲染层没有任何审计面板；
//   D2：覆盖层后端开放五角色（concept/architect/writer/idea/teardown），
//       PromptView 只摆了三行可编辑，idea/teardown 没有 UI 入口。
//
// 诚实纪律锚：
//   - D1 是 channel RESHAPE（照 publish:queue res 加 staged 真源先例）：
//     invoke 100 / push 18 / sentinel CH 40 三本账一枚不动；
//   - trace 缺失 = 契约破损 → E_INTERNAL 诚实失败，绝不静默补 []
//     （handler 唯一 ok:true 出口恒带 trace；显式空数组才是合法空值）；
//   - GenView 审计面板走原生 <details> 折叠，不新增实底按钮
//     （SOLID_BUTTON_CENSUS 保持 19）；CSS 全令牌（--mz-*），无裸 hex；
//   - PromptView 五行可编辑与 shared OverlayRole 联合逐字一致；
//     灰显 6 角色（SOON_ROLES）不动；cache 失效注记只对写手角色成立，措辞如实。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { IPC_CHANNELS, IPC_PUSH_CHANNELS } from '@shared/types/ipc';
import { INVOKE_CHANNELS, SUBSCRIBE_CHANNELS } from '../../src/preload/api';

const read = (rel: string): string => readFileSync(rel, 'utf8').replace(/\r\n/g, '\n');

const ipcSrc = read('src/shared/types/ipc.ts');
const sharedPipelineSrc = read('src/shared/types/pipeline.ts');
const assembleSrc = read('src/main/pipeline/assemble.ts');
const mainIpcSrc = read('src/main/pipeline/ipc.ts');
const apiSrc = read('src/preload/api.ts');
const genSrc = read('src/renderer/components/views/GenView.tsx');
const genCss = read('src/renderer/components/views/GenView.module.css');
const promptSrc = read('src/renderer/components/views/PromptView.tsx');

describe('A. D1：write-draft res  reshape 带 trace（TrimTrace 单源在 shared）', () => {
  it('shared/types/ipc.ts：write-draft res = { draftId; trace: TrimTrace[] }，且 import 自 ./pipeline', () => {
    expect(ipcSrc).toMatch(/'pipeline:write-draft':\s*\{\s*req:[\s\S]*?res:\s*\{\s*draftId:\s*string;\s*trace:\s*TrimTrace\[\]\s*\}/);
    expect(ipcSrc).toMatch(/import type \{[^}]*TrimTrace[^}]*\} from '\.\/pipeline'/);
  });

  it('concept/outline 的 res 保持 {draftId}（unwrapDraftId 口径不动）', () => {
    expect(ipcSrc).toMatch(/'pipeline:run-concept':\s*\{\s*req:\s*\{\s*projectId:\s*string\s*\};\s*res:\s*\{\s*draftId:\s*string\s*\}\s*\}/);
    const outlineAt = ipcSrc.indexOf("'pipeline:run-outline'");
    expect(outlineAt).toBeGreaterThan(-1);
    // 只取 outline 条目本体（到下一个文档注释为止）——write-draft 的注释里
    // 合法地提到 trace，不许把邻座的注释算进 outline 的负对照窗口
    const outlineBlock = ipcSrc.slice(outlineAt, ipcSrc.indexOf('/**', outlineAt));
    expect(outlineBlock).toMatch(/res:\s*\{\s*draftId:\s*string\s*\}/);
    expect(outlineBlock).not.toMatch(/trace/);
  });

  it('TrimTrace 单源在 shared/types/pipeline.ts（字段注释随迁）；assemble.ts 只 import + re-export，不再本地定义', () => {
    expect(sharedPipelineSrc).toMatch(/export type TrimTrace = \{/);
    expect(sharedPipelineSrc).toMatch(/kept=全文保留/);
    expect(sharedPipelineSrc).toMatch(/slot: string;/);
    expect(sharedPipelineSrc).toMatch(/before: number;/);
    expect(sharedPipelineSrc).toMatch(/after: number;/);
    expect(sharedPipelineSrc).toMatch(/reason: string;/);
    expect(assembleSrc).not.toMatch(/export type TrimTrace = \{/);
    expect(assembleSrc).toMatch(/import type \{[^}]*TrimTrace[^}]*\} from '@shared\/types\/pipeline'/);
    expect(assembleSrc).toMatch(/export type \{ TrimTrace \}/);
  });

  it('main/pipeline/ipc.ts：专用 unwrapDraftTrace 校验 draftId + trace；缺 trace 诚实失败，不静默补 []', () => {
    expect(mainIpcSrc).toMatch(/function unwrapDraftTrace\(res: ToolResult\): \{ draftId: string; trace: TrimTrace\[\] \}/);
    expect(mainIpcSrc).toContain('生成成功但未返回 trace');
    // writeDraft 改用 unwrapDraftTrace；concept/outline 仍走 unwrapDraftId
    const wdAt = mainIpcSrc.indexOf('export function writeDraft');
    expect(wdAt).toBeGreaterThan(-1);
    const wdBody = mainIpcSrc.slice(wdAt, mainIpcSrc.indexOf('/* ── 草稿管理三通道'));
    expect(wdBody).toMatch(/return unwrapDraftTrace\(/);
    expect(wdBody).not.toMatch(/unwrapDraftId\(/);
    // 负对照：任何「trace 缺席就兜空数组」的静默默认都不许出现
    expect(mainIpcSrc).not.toMatch(/trace\s*(\?\?|\|\|)\s*\[\]/);
  });

  it('preload/api.ts：writeDraft 签名仍从 IpcInvokeMap 推导（类型自动跟上，无需手改）', () => {
    expect(apiSrc).toMatch(/writeDraft\([\s\S]*?\): Promise<IpcInvokeMap\['pipeline:write-draft'\]\['res'\]>/);
  });
});

describe('B. D1：GenView 捕获 r.trace 并渲染「装配裁剪审计」details', () => {
  it('draftTrace 状态（TrimTrace[] | null）；onDraft 捕获 r.trace，run 起手清空', () => {
    expect(genSrc).toMatch(/import type \{[^}]*TrimTrace[^}]*\} from '@shared\/types\/pipeline'/);
    expect(genSrc).toMatch(/useState<TrimTrace\[\] \| null>\(null\)/);
    expect(genSrc).toMatch(/setDraftTrace\(null\);\s*\n\s*const r = await bridge\(\)\.pipeline\.writeDraft\(pid, no, \{ title, hook \}\);/);
    expect(genSrc).toMatch(/setDraftTrace\(r\.trace\)/);
    // 迟到守卫：await 回来先对当前项目 id，切书后的旧响应不许落面板
    expect(genSrc).toMatch(/useProjectStore\.getState\(\)\.project\?\.id !== pid\) return;\s*\n\s*setDraftTrace\(r\.trace\)/);
  });

  it('切换项目清空审计（pid 键控，不许把 A 书的裁剪记录挂到 B 书名下）', () => {
    expect(genSrc).toMatch(/useEffect\(\(\) => \{\s*setDraftTrace\(null\);\s*\}, \[pid\]\)/);
  });

  it('原生 <details> 折叠面板：summary 带栏数；action 三档中文标签；before→after tokens；reason 原文', () => {
    expect(genSrc).toMatch(/<details className=\{styles\.traceAudit\}>/);
    expect(genSrc).toMatch(/装配裁剪审计（\{draftTrace\.length\} 栏）/);
    expect(genSrc).toMatch(/kept: '全文保留'/);
    expect(genSrc).toMatch(/compressed: '截断'/);
    expect(genSrc).toMatch(/dropped: '整条丢弃'/);
    expect(genSrc).toMatch(/\{t\.before\}→\{t\.after\} tokens/);
    expect(genSrc).toMatch(/\{t\.reason\}/);
    expect(genSrc).toContain('本次生成无装配裁剪记录');
  });

  it('负对照：审计面板不新增按钮（原生 summary 即折叠开关，实底台账保持 19）', () => {
    const at = genSrc.indexOf('<details');
    expect(at).toBeGreaterThan(-1);
    const block = genSrc.slice(at, genSrc.indexOf('</details>', at));
    expect(block).not.toMatch(/<button/);
    expect(block).not.toMatch(/btnPrimary/);
  });

  it('审计 CSS 全令牌：traceAudit/traceRow 有规则，无裸 hex，间距/字号走 --mz-*', () => {
    expect(genCss).toMatch(/\.traceAudit\s*\{/);
    expect(genCss).toMatch(/\.traceRow\s*\{/);
    const stripped = genCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const auditAt = stripped.indexOf('.traceAudit');
    const auditTail = stripped.slice(auditAt);
    expect(auditTail).toMatch(/var\(--mz-/);
    expect(auditTail).not.toMatch(/font-size:\s*\d/);
    expect(auditTail).not.toMatch(/(?:padding|gap|margin|border-radius):\s*\d+(\.\d+)?px/);
  });
});

describe('C. D2：PromptView 五行可编辑（与 shared OverlayRole 逐字一致）', () => {
  it('EDIT_ROLES 含全部五角色，idea/teardown 标签用 脑洞/拆书 短称', () => {
    // 取「紧邻文档注释 + 声明」整块——五角色口径写在注释里，窗口要把注释包进来
    const m = promptSrc.match(/(?:\/\*\*[\s\S]*?\*\/\s*)?const EDIT_ROLES[\s\S]*?\];/);
    expect(m).not.toBeNull();
    const block = m![0];
    for (const role of ['concept', 'architect', 'writer', 'idea', 'teardown']) {
      expect(block).toContain(`role: '${role}'`);
    }
    expect(block).toMatch(/role: 'idea', label: '脑洞'/);
    expect(block).toMatch(/role: 'teardown', label: '拆书'/);
    expect(block).toContain('五角色');
  });

  it('首帧 Promise.all 拉全五角色 + skills.list；setStates 含 idea/teardown（I-1 守卫不动）', () => {
    expect(promptSrc).toMatch(/Promise\.all\(\[\s*fetchRole\('concept'\),\s*fetchRole\('architect'\),\s*fetchRole\('writer'\),\s*fetchRole\('idea'\),\s*fetchRole\('teardown'\),\s*bridge\(\)\.skills\.list\(\),?\s*\]\)/);
    expect(promptSrc).toMatch(/if \(!seqRef\.current\.isCurrent\(seq\)\) return;\s*\n\s*setStates\(\{ concept, architect, writer, idea, teardown \}\)/);
  });

  it('SOON_ROLES 灰显 6 角色不动（idea/teardown 从来不在其中）', () => {
    expect(promptSrc).toMatch(/const SOON_ROLES = \['总编', '扫榜', '审稿', '史官', '润色', '记忆管家'\];/);
  });

  it('头注释与文案如实：五行可编辑；cache 失效注记只归写手；placeholder 不再绑死三角色', () => {
    expect(promptSrc).toContain('五行可编辑');
    expect(promptSrc).toContain('写手角色的改动会使其 prompt cache 失效');
    expect(promptSrc).not.toContain('改动会使写手 prompt cache 失效');
    expect(promptSrc).not.toContain('写手/架构/构思之外没有的固定要求');
  });
});

describe('D. 负对照：三本通道账 + 实底按钮台账一枚不动', () => {
  it('invoke 100 / push 18（RESHAPE 不开新通道）', () => {
    expect(IPC_CHANNELS).toHaveLength(100);
    expect(INVOKE_CHANNELS).toHaveLength(100);
    expect([...IPC_CHANNELS].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(IPC_PUSH_CHANNELS).toHaveLength(18);
    expect(SUBSCRIBE_CHANNELS).toHaveLength(18);
  });

  it('sentinel CH 台账保持 40（write-draft 本就在列，改形不改名）', () => {
    const sentinel = read('tests/integration/pipeline-ipc-sentinel.test.ts');
    const m = sentinel.match(/const CH = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    expect(m![1].split(',')).toHaveLength(40);
    expect(sentinel).toMatch(/总 40 通道/);
    expect(m![1]).toContain("'pipeline:write-draft'");
  });

  it('SOLID_BUTTON_CENSUS 保持 19（details/summary 是原生折叠，不是新 CTA）', () => {
    const censusSrc = read('tests/unit/p2ui-t4-smoke-fixes.test.ts');
    const m = censusSrc.match(/const SOLID_BUTTON_CENSUS = \[([\s\S]*?)\];/);
    expect(m).not.toBeNull();
    const entries = m![1].match(/'[^']+'/g) ?? [];
    expect(entries).toHaveLength(19);
  });
});