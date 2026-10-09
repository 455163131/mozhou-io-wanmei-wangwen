/**
 * 行内标注的**装配层**哨兵（§4 第 7 条）。
 *
 * 区间映射本身是纯函数，已由 `tests/unit/inline-marks.test.ts`（19 条，含与真引擎对表）钉死。
 * 本仓库反复出的事故形状是"逻辑对、喂给它的是空气"，所以再加一层通路断言：
 * 映射函数存在≠编辑器真的用它；用了≠镜像层真的和 textarea 对齐了。
 *
 * 这一层最能骗人的地方是**看起来对**：波浪线偏半个字、或叠在错误的行上，
 * 肉眼扫一眼Demo 发现不了，作者照着改却改在别处。所以钉的全是"会不会错位"的结构性条件：
 *   1. 编辑器真的调用映射，且数据源是上一次检测（`latest`），不是每敲几下就重测；
 *   2. 两层的排版参数由**同一条 CSS 规则**给出（各自另写一份早晚漂移）；
 *   3. 滚动同步 + 宽度同步都在（textarea 的滚动条那条必须让出来）；
 *   4. 镜像层不吃鼠标、不抢焦点，且对读屏隐藏；
 *   5. 拦下来不画时必须说明原因，不能静默地把标注变没。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const editor = read('src/renderer/components/editor/Editor.tsx');
const css = read('src/renderer/components/editor/Editor.module.css');

/**
 * 取单个类的规则块。★ 必须从行首的点号开始找：`.stage > .area {` 里也含 `.area {`，
 * 直接 indexOf 会命中共用那条，把"两边各自另写一份"的检查做成假阳性/假阴性。
 */
function block(name: string): string {
  const at = css.indexOf(`\n.${name} {`);
  expect(at, `CSS 里没有 .${name} 这条规则`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('\n}', at));
}

describe('A. 编辑器真的用上了映射层', () => {
  it('从 ./inline-marks 引入映射层（第 20 条②之后又多两个：体检映射 + 跨源合并）', () => {
    // 原来钉的是字面顺序 `marksFromHits, segmentsOf`，加进 marksFromLocations/mergeMarks
    // 之后顺序变了。改成"同一条 import 里两个名字都在"，比按顺序匹配更经得起改名。
    const imp = editor.match(/import \{([^}]*)\} from '\.\/inline-marks'/);
    expect(imp, '编辑器没从 ./inline-marks 引入映射层').not.toBeNull();
    expect(imp![1]).toContain('marksFromHits');
    expect(imp![1]).toContain('segmentsOf');
    expect(editor).toMatch(/marksFromHits\(/);
    expect(editor).toMatch(/segmentsOf\(/);
  });

  it('★ 数据源是「上一次检测」（latest），编辑器里不自动重测', () => {
    expect(editor).toMatch(/aiFlavor\.latest\(/);
    expect(editor, '边敲边跑检测会把写作框变成统计机，也让标注忽隐忽现').not.toMatch(/aiFlavor\.scan\(/);
  });

  it('区间随正文重算：正文一改，标注自己就消失了', () => {
    expect(editor).toMatch(/marksFromHits\(scan\?\.hits, body\)/);
  });

  it('有开关（用户要能关掉），且被拦下时给出解释而不是静默', () => {
    expect(editor).toMatch(/showMarks/);
    expect(editor).toMatch(/blockedByEdit/);
    expect(editor).toContain('行内标注已停');
    expect(editor).toMatch(/blockedByExcerpt/);
    expect(editor, '报告没带 excerpt 与"你改过正文"是两回事，得分开说').toContain('没有回传原文片段');
  });

  it('命中原因走「光标定位」这一行，不走 title（textarea 盖在上面，title 永远触发不了）', () => {
    expect(editor).toMatch(/selectionStart/);
    expect(editor, '把说明写在镜像层的 title 上等于没写').not.toMatch(/title=\{seg\.mark\.title\}/);
  });
});

describe('B. 两层不会错位', () => {
  it('★ 滚动同步：镜像层跟着 textarea 走', () => {
    expect(editor).toMatch(/bd\.scrollTop = ta\.scrollTop/);
    expect(editor).toMatch(/onScroll=\{syncLayer\}/);
  });

  it('★ 宽度同步：让出 textarea 滚动条占掉的那一条，否则整行偏右', () => {
    expect(editor).toMatch(/ta\.clientWidth/);
    expect(editor).toMatch(/bd\.style\.width/);
  });

  it('尺寸变化也重算（ResizeObserver），不只是滚动时', () => {
    expect(editor).toMatch(/ResizeObserver/);
    expect(editor).toMatch(/ro\.observe\(ta\)/);
  });

  it('★ 排版参数由一条同时覆盖两层的规则给出', () => {
    expect(css).toMatch(/\.stage > \.area,\s*\.stage > \.backdrop \{/);
    // 两边各自再写一份 font-size/line-height/padding 就是错位的开始
    for (const name of ['area', 'backdrop'] as const) {
      const b = block(name);
      expect(b, `.${name} 自己又写了一份字号，两层会漂移`).not.toMatch(/font-size/);
      expect(b, `.${name} 自己又写了一份行距`).not.toMatch(/line-height/);
      expect(b, `.${name} 自己又写了一份内边距`).not.toMatch(/padding/);
    }
  });

  it('镜像层文字透明、只让波浪线显色；textarea 透明地叠在上面', () => {
    const b = block('backdrop');
    expect(b).toMatch(/color: transparent/);
    expect(b).toMatch(/pointer-events: none/);
    expect(b).toMatch(/z-index: 0/);
    const a = block('area');
    expect(a).toMatch(/z-index: 1/);
    expect(a).toMatch(/background: transparent/);
  });

  it('波浪线按档位着色，四档都要有（缺一档就会 fallback 到重档、把轻问题报成重问题）', () => {
    expect(css).toMatch(/text-decoration-style: wavy/);
    for (const lvl of ['mild', 'suspicious', 'heavy', 'severe']) {
      expect(css, `缺 ${lvl} 档`).toMatch(new RegExp(`\\.${lvl} \\{[^}]*text-decoration-color`));
      expect(editor, `${lvl} 档没接上类名`).toMatch(new RegExp(`${lvl}: styles\\.${lvl}`));
    }
  });

  it('镜像层对读屏隐藏（否则一份透明文本会被朗读两遍）', () => {
    expect(editor).toMatch(/aria-hidden="true"/);
  });
});
