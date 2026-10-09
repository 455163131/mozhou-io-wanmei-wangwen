/**
 * §4 第 20 条①：CSS Module 里取不到的类名会渲染成 `class="undefined"`。
 *
 * `import styles from './x.module.css'` 之后，`styles.no` 这种点取值在 CSS 里
 * 没有对应规则时得到的是 `undefined`：**不报错、不警告，只是那块排版凭空没了**。
 * 修复前 `PlanView.tsx:216` 的「第 N 卷」就是这个形状（全仓唯一一处，实测口径见下）。
 *
 * 这里做四件事：
 *   A. 全仓扫一遍 `src` 下的每个 `.tsx`，任何点取值的 `styles.X` 必须能在**同名**
 *      `.module.css` 里找到 `.X` 规则；
 *   B. 单独钉住「第 N 卷」这个 span 真的有样式了，并且确认哨兵本身没静默失效
 *      （源码里确实还在用 `styles.no`）；
 *   C. 方括号动态取值 `styles[expr]`（§4 第 20 条②遗留边界）：这类键运行期才拼出来，
 *      静态读不到，所以改成**按取值域枚举**——每个站点在 DYNAMIC_SITES 表里声明它的
 *      取值从哪来（共享类型的联合，或同文件里的 `cls:` 字面量），把整个取值域展开成
 *      类名逐个查规则；
 *   D. `var(--mz-*)` 同款静默失效：CSS 取不到自定义属性时**也不报错**，声明直接按
 *      invalid-at-computed-value-time 丢掉。任何**无兜底**的 `var(--x)` 必须能在
 *      `src` 下的某个 `.module.css` / `tokens.css` 里找到 `--x:` 的定义。
 *
 * ★ 覆盖边界（仍如实写明）：C 组只覆盖 `styles[...]` 的**取值域是有限字面量联合**的站点。
 *   若某处写成 `styles[someStringVariable]` 且那个变量没有可枚举的取值域，本条会因
 *   「站点没进表」而失败——这是设计如此：表是逐站点人工核过的，不猜。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename, relative } from 'node:path';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** `styles.xxx` 点取值（不含 `styles[...]`） */
function usedClasses(tsx: string): string[] {
  return [...tsx.matchAll(/\bstyles\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
}

/** CSS 里出现的 `.xxx` 类名（值里的 `0.5px` 这类不会命中：点后面必须是字母或下划线） */
function definedClasses(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
}

describe('A. 点取值的 styles.X 必须在同名 module.css 里有规则', () => {
  const tsxFiles = walk(SRC, '.tsx');

  it('全仓有 tsx 配同名 module.css（哨兵本身别静默失效）', () => {
    const paired = tsxFiles.filter((f) => existsSync(f.replace(/\.tsx$/, '.module.css')));
    expect(paired.length, 'src/**/*.tsx 里至少该有几个用 CSS Module 的组件').toBeGreaterThan(5);
  });

  it('没有任何组件在用 CSS 里不存在的类名', () => {
    const problems: string[] = [];
    for (const f of tsxFiles) {
      const cssPath = f.replace(/\.tsx$/, '.module.css');
      const used = new Set(usedClasses(readFileSync(f, 'utf8')));
      if (used.size === 0) continue;
      if (!existsSync(cssPath)) {
        problems.push(`${basename(f)} 用了 ${[...used].join(', ')} 但没有同名 .module.css`);
        continue;
      }
      const defined = definedClasses(readFileSync(cssPath, 'utf8'));
      const missing = [...used].filter((c) => !defined.has(c));
      if (missing.length) problems.push(`${basename(f)} 缺类名: ${missing.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('B. 规划视图「第 N 卷」的序号必须有样式', () => {
  const tsxPath = join(SRC, 'renderer/components/views/PlanView.tsx');
  const cssPath = join(SRC, 'renderer/components/views/PlanView.module.css');

  it('源码确实还在用 styles.no（不然这条等于空过）', () => {
    expect(readFileSync(tsxPath, 'utf8')).toMatch(/\bstyles\.no\b/);
  });

  it('.no 规则存在且不是空的', () => {
    const css = readFileSync(cssPath, 'utf8');
    const rule = css.match(/\.no\s*\{([^}]*)\}/);
    expect(rule, 'PlanView.module.css 里没有 .no 规则').not.toBeNull();
    expect(rule![1].trim().length, '.no 规则是空花括号').toBeGreaterThan(0);
  });
});

// ── C. 方括号动态取值：按取值域枚举 ──────────────────────────────────────

/**
 * 取值域来源。
 * - `union`：`src/shared/types` 里的字面量联合类型；整条联合的每个成员都是一个类名。
 *   这里**刻意按联合全集校验**，而不是"当前实际会产出哪几个"——
 *   `StepStatus` 有 5 个成员，`loop.ts:282` 目前只产出 `succeeded`/`failed` 两个，
 *   但类型说得出、界面就该接得住：中止（`abortBtn`）是真有的入口，
 *   给 `aborted`/`rolled-back` 补样式是契约，等出事再补是赌。
 * - `literals`：同一 tsx 文件里的 `字段: '值'` 字面量集合（如 `cls: 'ok'`）。
 */
type Domain =
  | {
      kind: 'union';
      /** 联合类型声明所在文件（相对 src） */
      typeFile: string;
      type: string;
      /** 类名前缀，如 `lv-` */
      prefix?: string;
      /** 绑定证据所在文件（字段声明可能和类型声明不在同一个文件） */
      bindingFile: string;
      /** 证明这个表达式的字段确实是该联合类型标注的——不然表是在自说自话 */
      binding: RegExp;
    }
  | { kind: 'literals'; field: string };

/** 逐站点人工核对过的动态取值表（相对 src 的路径 + 方括号里的表达式原文） */
const DYNAMIC_SITES: { file: string; expr: string; domain: Domain }[] = [
  { file: 'renderer/components/agent/AgentPanel.tsx', expr: 'step.status', domain: { kind: 'union', typeFile: 'shared/types/agent.ts', type: 'StepStatus', bindingFile: 'shared/types/agent.ts', binding: /status\s*:\s*StepStatus/ } },
  { file: 'renderer/components/agent/AgentPanel.tsx', expr: 'm.cls', domain: { kind: 'literals', field: 'cls' } },
  { file: 'renderer/components/agent/AgentPanel.tsx', expr: 'badge.cls', domain: { kind: 'literals', field: 'cls' } },
  { file: 'renderer/components/flavor/FlavorPanel.tsx', expr: "'lv-' + report.level", domain: { kind: 'union', typeFile: 'shared/types/ai-flavor.ts', type: 'FlavorLevel', prefix: 'lv-', bindingFile: 'shared/types/ai-flavor.ts', binding: /level\s*:\s*FlavorLevel/ } },
  { file: 'renderer/components/flavor/FlavorPanel.tsx', expr: "'lv-' + d.level", domain: { kind: 'union', typeFile: 'shared/types/ai-flavor.ts', type: 'FlavorLevel', prefix: 'lv-', bindingFile: 'shared/types/ai-flavor.ts', binding: /level\s*:\s*FlavorLevel/ } },
  { file: 'renderer/components/flavor/FlavorPanel.tsx', expr: "'lv-' + h.level", domain: { kind: 'union', typeFile: 'shared/types/ai-flavor.ts', type: 'FlavorLevel', prefix: 'lv-', bindingFile: 'shared/types/ai-flavor.ts', binding: /level\s*:\s*FlavorLevel/ } },
  { file: 'renderer/components/health/HealthPanel.tsx', expr: 'issue.level', domain: { kind: 'union', typeFile: 'shared/types/tool.ts', type: 'Grade', bindingFile: 'shared/types/health.ts', binding: /level\s*:\s*Grade/ } },
  { file: 'renderer/components/views/ReviewView.tsx', expr: "'lv-' + report.level", domain: { kind: 'union', typeFile: 'shared/types/ai-flavor.ts', type: 'FlavorLevel', prefix: 'lv-', bindingFile: 'shared/types/ai-flavor.ts', binding: /level\s*:\s*FlavorLevel/ } },
  { file: 'renderer/components/views/ReviewView.tsx', expr: "'lv-' + d.level", domain: { kind: 'union', typeFile: 'shared/types/ai-flavor.ts', type: 'FlavorLevel', prefix: 'lv-', bindingFile: 'shared/types/ai-flavor.ts', binding: /level\s*:\s*FlavorLevel/ } },
];

const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

/** 源码里真实出现的每一处 `styles[...]` */
function dynamicSitesInSource(): { file: string; expr: string }[] {
  const out: { file: string; expr: string }[] = [];
  for (const f of walk(SRC, '.tsx')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bstyles\[([^\]]+)\]/g)) {
      out.push({ file: rel(f), expr: m[1].trim() });
    }
  }
  return out;
}

/** 把一个站点的取值域展开成候选类名全集 */
function classesForDomain(domain: Domain, tsxText: string): string[] {
  if (domain.kind === 'literals') {
    return [...tsxText.matchAll(new RegExp(String.raw`\b${domain.field}\s*:\s*'([^']+)'`, 'g'))].map(
      (m) => m[1],
    );
  }
  const src = readFileSync(join(SRC, domain.typeFile), 'utf8');
  const decl = src.match(new RegExp(`export type ${domain.type}\\s*=([\\s\\S]*?);`));
  if (!decl) throw new Error(`${domain.typeFile} 里找不到 export type ${domain.type}`);
  return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => (domain.prefix ?? '') + m[1]);
}

/** 差集：needed 里没在 defined 出现的（顺序保留、去重） */
function missingClasses(needed: string[], defined: Set<string>): string[] {
  return [...new Set(needed)].filter((c) => !defined.has(c));
}

describe('C. 方括号动态取值 styles[X] 的整个取值域都必须有规则', () => {
  it('哨兵没静默失效：源码里确有 11 处 styles[...]，且全部登记在表', () => {
    const found = dynamicSitesInSource();
    expect(found.length, '实测 styles[...] 站点数变了，请同步 DYNAMIC_SITES').toBe(11);
    const untabled = found.filter(
      (s) => !DYNAMIC_SITES.some((d) => d.file === s.file && d.expr === s.expr),
    );
    expect(untabled.map((s) => `${s.file} styles[${s.expr}]`)).toEqual([]);
  });

  it('表没过期：每个登记站点在源码里仍然逐字存在', () => {
    const found = new Set(dynamicSitesInSource().map((s) => `${s.file}|${s.expr}`));
    const stale = DYNAMIC_SITES.filter((s) => !found.has(`${s.file}|${s.expr}`));
    expect(stale.map((s) => `${s.file} styles[${s.expr}]`)).toEqual([]);
  });

  it('绑定成立：字段确实由表里声明的联合类型标注，且取值域非空', () => {
    for (const s of DYNAMIC_SITES) {
      const text = readFileSync(join(SRC, s.file), 'utf8');
      const classes = classesForDomain(s.domain, text);
      expect(classes.length, `${s.file} styles[${s.expr}] 的取值域解析成了空集`).toBeGreaterThan(0);
      if (s.domain.kind === 'union') {
        const bindingSrc = readFileSync(join(SRC, s.domain.bindingFile), 'utf8');
        expect(
          s.domain.binding.test(bindingSrc),
          `${s.domain.bindingFile} 里没有 ${s.domain.type} 标注的那个字段——表在自说自话`,
        ).toBe(true);
      }
    }
  });

  it('每个候选类名都能在同名 module.css 里找到规则', () => {
    const problems: string[] = [];
    for (const s of DYNAMIC_SITES) {
      const text = readFileSync(join(SRC, s.file), 'utf8');
      const classes = classesForDomain(s.domain, text);
      const cssPath = join(SRC, s.file.replace(/\.tsx$/, '.module.css'));
      if (!existsSync(cssPath)) {
        problems.push(`${s.file} 没有同名 .module.css（styles[${s.expr}]）`);
        continue;
      }
      const missing = missingClasses(classes, definedClasses(readFileSync(cssPath, 'utf8')));
      if (missing.length) {
        problems.push(`${basename(cssPath)} 缺类名: ${missing.join(', ')}（styles[${s.expr}]）`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('负对照：扫描器真的会咬（不存在的花名必须被抓出来）', () => {
    const defined = definedClasses(readFileSync(join(SRC, DYNAMIC_SITES[0].file.replace(/\.tsx$/, '.module.css')), 'utf8'));
    expect(missingClasses(['no-such-class-xyz'], defined)).toEqual(['no-such-class-xyz']);
    // 取值域解析器也不能只会吐空集：StepStatus 5 个、FlavorLevel 带前缀 5 个
    expect(classesForDomain(DYNAMIC_SITES[0].domain, '')).toHaveLength(5);
    expect(classesForDomain(DYNAMIC_SITES[3].domain, '')).toEqual([
      'lv-clean',
      'lv-mild',
      'lv-suspicious',
      'lv-heavy',
      'lv-severe',
    ]);
  });
});

// ── D. var(--x)：取不到定义同样是静默失效 ────────────────────────────────

describe('D. 无兜底的 var(--x) 必须在 src/**/*.css 里有定义', () => {
  const cssFiles = walk(SRC, '.css');

  const definedProps = (): Set<string> => {
    const s = new Set<string>();
    for (const f of cssFiles) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) s.add(m[1]);
    }
    return s;
  };

  it('哨兵没静默失效：全仓至少有几十个自定义属性、也至少有几十处 var() 取值', () => {
    expect(cssFiles.length).toBeGreaterThan(5);
    expect(definedProps().size).toBeGreaterThan(50);
    let uses = 0;
    for (const f of cssFiles) {
      uses += [...readFileSync(f, 'utf8').matchAll(/\bvar\(--/g)].length;
    }
    expect(uses).toBeGreaterThan(50);
  });

  it('没有任何 var(--x) 引用了不存在的属性（带兜底的除外）', () => {
    const defined = definedProps();
    const problems: string[] = [];
    for (const f of cssFiles) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/\bvar\(\s*(--[\w-]+)\s*(,)?/g)) {
          if (!defined.has(m[1]) && !m[2]) {
            problems.push(`${rel(f)}:${i + 1} var(${m[1]}) 无定义、无兜底`);
          }
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it('★ 第 20 条②自查：编辑器的行内线用的是有定义的 token（--mz-sem-err-fg 这个孤儿不许复活）', () => {
    const editorCss = readFileSync(
      join(SRC, 'renderer/components/editor/Editor.module.css'),
      'utf8',
    );
    expect(editorCss).not.toMatch(/--mz-sem-err-fg/);
    // 五档 AI 味 + 体检两档都得真拿到颜色：每条规则里必须有一次有定义的 var()
    const defined = definedProps();
    for (const cls of ['clean', 'mild', 'suspicious', 'heavy', 'severe', 'warn', 'risk']) {
      const rule = editorCss.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
      if (!rule) continue; // clean 可以没规则（不画线），其余由下一条测试兜
      const props = [...rule[1].matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
      for (const p of props) expect(defined.has(p), `.${cls} 里的 ${p} 没有定义`).toBe(true);
    }
  });
});
