/**
 * §4 第 20 条①：CSS Module 里取不到的类名会渲染成 `class="undefined"`。
 *
 * `import styles from './x.module.css'` 之后，`styles.no` 这种点取值在 CSS 里
 * 没有对应规则时得到的是 `undefined`：**不报错、不警告，只是那块排版凭空没了**。
 * 修复前 `PlanView.tsx:216` 的「第 N 卷」就是这个形状（全仓唯一一处，实测口径见下）。
 *
 * 这里做两件事：
 *   A. 全仓扫一遍 `src` 下的每个 `.tsx`，任何点取值的 `styles.X` 必须能在**同名**
 *      `.module.css` 里找到 `.X` 规则；
 *   B. 单独钉住「第 N 卷」这个 span 真的有样式了，并且确认哨兵本身没静默失效
 *      （源码里确实还在用 `styles.no`）。
 *
 * ★ 覆盖边界（如实写明，别把这个测试当成全保险）：**方括号动态取值不在本条的射程内**
 *   （`styles[issue.level]`、`styles['lv-' + report.level]` 这几处的键是运行期拼出来的，
 *   源码里静态读不到）。它们需要按 level/status 的取值域另立一条，见 §4 第 20 条②。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
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
  const tsxFiles = walk(SRC);

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
