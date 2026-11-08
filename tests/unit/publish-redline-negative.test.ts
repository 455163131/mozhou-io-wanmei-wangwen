// tests/unit/publish-redline-negative.test.ts —— 红线负对照（R46 源码扫描）
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 递归收集目录内 .ts 文件 */
function tsFiles(dir: string): string[] {
  let out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(tsFiles(p));
    else if (f.endsWith('.ts') || f.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const DIRS = ['src/main/export', 'src/shared/publish'];
// T6 会把 'src/main/publish' 追加进来——见 Task 6 Step 3。
const FORBIDDEN = [
  /fetch\(/, /require\(\s*['"]node:https?\s*['"]\s*\)/, /require\(\s*['"]node:net['"]\s*\)/,
  /from\s+['"]node:https?['"]/, /from\s+['"]node:net['"]/, /child_process/, /\bexec\(/,
  /updateBody/, /writeBody/,
];

describe('发布/导出红线：零外发零正文写（负对照钉）', () => {
  it('目录在册（哨兵别空转）', () => {
    expect(tsFiles('src/main/export').length).toBeGreaterThan(0);
    expect(tsFiles('src/shared/publish').length).toBeGreaterThan(0);
  });
  for (const dir of DIRS) {
    for (const f of tsFiles(dir)) {
      const src = readFileSync(f, 'utf8');
      for (const re of FORBIDDEN) {
        it(`${f.replace(/\\/g, '/')} 不含 ${re.source}`, () => {
          expect(src).not.toMatch(re);
        });
      }
    }
  }
});
