/**
 * 人物记忆页（P2-B T6，mode: characters）接线钉。
 *
 * 前四条是 brief Step 1 的逐字钉：三栏+图谱骨架的类名标识、写侧通道
 * （knows/notKnows 手录走 ledger:patch、章×人快照走 charstate:set、正文零写入）、
 * 矩阵空格诚实「—」不编假快照、关系图纯 SVG 环形布局且不引第三方图库。
 *
 * 追加钉镜像 foreshadow-view-wiring 的 T4 审查修复波形状（同类页面不再重犯）：
 * pid 键重载（openProject 换书不重挂载，R13/GenView 口径）、load sequencer 位置钉
 * （守卫坐在最后一个 await 与第一批数据写之间，I-1 同族）、保存路径统一经
 * runWrite→load 复用同一守卫、页头显示名走 MODE_LABELS 单一来源、
 * 手录字段缺省「未登记」与矩阵空格「—」两套口径不许互相漂移（「—」只许出现在
 * 矩阵空格一处）、环形布局的 2πi/N 与边 hit 区真在代码里。
 *
 * ★ 多行正则一律走 CRLF 归一化后的 src（照 p2a-overlay-race 的读法）；
 * brief 四条保持逐字，用原始 view。
 */
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const view = readFileSync(join(process.cwd(), 'src/renderer/components/views/CharacterView.tsx'), 'utf8');

it('三栏+底部图谱骨架齐（列表/卡片/kb 双栏/矩阵）', () => {
  for (const k of ['charList', 'charCard', 'kbGrid', 'matrix']) expect(view).toContain(k);
});
it('knows/notKnows 编辑走 ledger:patch，快照走 charstate:set，无正文写入', () => {
  expect(view).toMatch(/ledger\.patch\(/);
  expect(view).toMatch(/charstate\.set\(/);
  expect(view).not.toMatch(/updateBody/);
});
it('矩阵单元=章×人，未填显示「—」不显示假快照', () => {
  expect(view).toMatch(/'—'|—/);
});
it('关系图为环形布局纯 SVG，边可点出详情（无第三方图库）', () => {
  expect(view).toMatch(/<svg/);
  expect(view).toMatch(/relations/);
  expect(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).not.toMatch(/"react-flow|cytoscape|d3"/);
});

// ── 追加钉（T4 审查修复波的形状在同类页面不再重犯）────────────────────────

const src = view.replace(/\r\n/g, '\n');

it('★ 项目切换重载：订阅 project?.id，load 键在 pid 上（R13/GenView 口径），不键 chapters', () => {
  expect(src).toMatch(/useProjectStore\(\(s\) => s\.project\)/);
  expect(src).toMatch(/const pid = project\?\.id \?\? null;/);
  // 效果键 [pid, load]：openProject 同帧刷 chapters，但矩阵列头跟着 store 走即可，
  // 键两个会双载。
  expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]{0,400}?void load\(\);\s*\}, \[pid, load\]\);/);
  expect(src).not.toMatch(/}, \[pid, chapters, load\]\)/);
});

it('★ load 持 sequencer：最后一个 await（charstate.list）回来判最新才许写数据（I-1 同族）', () => {
  expect(src).toMatch(/from '\.\.\/\.\.\/lib\/sequenced'/);
  expect(src).toMatch(/const loadSeqRef = useRef\(createSequencer\(\)\);/);
  expect(src).toMatch(/const seq = loadSeqRef\.current\.next\(\);/);
  const m = src.match(
    /await api\.charstate\.list\(pid\);\s*\n\s*if \(!loadSeqRef\.current\.isCurrent\(seq\)\) return;\s*\n\s*setChars\(/,
  );
  expect(m, '守卫缺席：旧项目在途的 load 会把别书的人物卡与快照盖进当前页').not.toBeNull();
});

it('★ 保存路径（patch/set/upsert）统一经 runWrite→load，刷新复用同一守卫', () => {
  expect(src).toMatch(/async function runWrite\(action: \(\) => Promise<void>\): Promise<void> \{/);
  expect(src).toMatch(/await action\(\);\s*\n\s*setModal\(null\);\s*\n\s*await load\(\);/);
  expect(src).toMatch(/ledger\.upsert\(/);
});

it('页头显示名走 MODE_LABELS 单一来源，不抄字面量', () => {
  expect(src).toMatch(/import \{ MODE_LABELS \} from '@shared\/constants\/modes'/);
  expect(src).toMatch(/\{MODE_LABELS\.characters\}/);
});

it('手录字段缺省显「未登记」；「—」只许矩阵空格一处，两口径不许漂移', () => {
  expect(src).toMatch(/<span className=\{styles\.unreg\}>未登记<\/span>/);
  expect(src).toMatch(/cell \? cell\.snapshot : '—'/);
  expect(src.split("'—'").length - 1, '「—」漏进手录字段——那里缺省是「未登记」').toBe(1);
});

it('★ 关系图环形布局：角度 = 2πi/N，边带宽容 hit 区与 <title>，无第三方图库', () => {
  expect(src).toMatch(/2 \* Math\.PI/);
  expect(src).toMatch(/className=\{styles\.edgeHit\}/);
  expect(src).toMatch(/<title>/);
});

it('★ CharacterView.module.css 零裸色（与 foreshadow 同规，双皮肤下裸 hex 必错一处）', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/components/views/CharacterView.module.css'), 'utf8');
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(css).toMatch(/var\(--mz-/);
});
