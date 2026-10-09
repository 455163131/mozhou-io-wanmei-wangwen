/**
 * 相邻项 A：C8 的引擎 pin 不该把**本机工作区的行尾**钉成口径。
 *
 * 症状（实测）：`data/corpus_flavor_baseline.json` 里 pin 的是 `88d5a88e…`，
 * 而 `git cat-file -p HEAD:src/shared/ai-flavor/engine.ts` 的字节 md5 是 `22437e38…`。
 * 两者只差一件事：仓库 `.gitattributes:3` 写的是 `* text=auto eol=lf`，本机
 * `core.autocrlf=true`，所以**工作区是 CRLF、版本库里是 LF**（字节数 53693 vs 52445，
 * 差的正好是 1248 个 `\r` = 行数）。
 *
 * 后果：换一台机器（或任何以 LF 检出的人）跑 `verify-flavor-acceptance.mjs`，C8 必然
 * 报「改了引擎但没重算基线」——而引擎一个字符都没动。pin 钉死的是**编辑器行为**，不是代码。
 *
 * 修法：哈希前先归一化行尾（CRLF→LF），两个脚本共用 `scripts/lib-engine-bundle.mjs`
 * 里的同一个函数——本项目最忌讳的就是两处口径各写一份然后漂移。
 *
 * ★ 为什么用动态 import 拿 .mjs：tsconfig.node.json 没开 allowJs，静态 import 会打断
 *   typecheck；变量式说明符 TS 不去解析，运行期由 vitest 的 node 环境正常加载。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENGINE_SRC = join(ROOT, 'src/shared/ai-flavor/engine.ts');
const BASELINE_JSON = join(ROOT, 'data/corpus_flavor_baseline.json');
const LIB = join(ROOT, 'scripts/lib-engine-bundle.mjs');
const COMPUTE = join(ROOT, 'scripts/compute-flavor-baseline.mjs');
const VERIFY = join(ROOT, 'scripts/verify-flavor-acceptance.mjs');

type LibMod = {
  md5Normalized: (text: string) => string;
  engineSourceMd5: () => string;
};

const libPath = new URL('../../scripts/lib-engine-bundle.mjs', import.meta.url).href;
const lib: LibMod = await import(libPath);

const rawMd5 = (buf: Buffer): string => crypto.createHash('md5').update(buf).digest('hex');

describe('A. md5Normalized：行尾不同的同一份内容必须得到同一个哈希', () => {
  it('CRLF 与 LF 归一化后同哈希；不归一化时不同（证明归一化确实在起作用）', () => {
    const lf = "line one\nline two\n";
    const crlf = "line one\r\nline two\r\n";
    expect(lib.md5Normalized(crlf)).toBe(lib.md5Normalized(lf));
    expect(rawMd5(Buffer.from(crlf, 'utf8'))).not.toBe(rawMd5(Buffer.from(lf, 'utf8')));
  });

  it('负对照：内容真的变了就必须换哈希（归一化不是把什么都抹平）', () => {
    expect(lib.md5Normalized('a\nb')).not.toBe(lib.md5Normalized('a\nb\nc'));
  });
});

describe('B. engineSourceMd5：读的是 engine.ts，钉的是归一化后的内容', () => {
  it('与当场读取源码归一化后的哈希一致（不是抄来的常量）', () => {
    const text = readFileSync(ENGINE_SRC, 'utf8');
    expect(lib.engineSourceMd5()).toBe(lib.md5Normalized(text));
  });

  it('跨行尾稳定：把源码换成 CRLF 再算一次，结果不变', () => {
    const lf = readFileSync(ENGINE_SRC, 'utf8').replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(lib.md5Normalized(crlf)).toBe(lib.engineSourceMd5());
    expect(lib.md5Normalized(lf)).toBe(lib.engineSourceMd5());
  });
});

describe('C. 落盘的 pin 已经是归一化口径，两个脚本都不再各自哈希原始字节', () => {
  it('基线 JSON 里的 engineSrcMd5 = engineSourceMd5()', () => {
    const pin = JSON.parse(readFileSync(BASELINE_JSON, 'utf8')).enginePin;
    expect(pin.engineSrcMd5).toBe(lib.engineSourceMd5());
  });

  it('如果本机工作区是 CRLF，pin 就不等于原始字节哈希（钉的绝不是行尾）', () => {
    const bytes = readFileSync(ENGINE_SRC);
    if (bytes.includes(0x0d)) {
      expect(JSON.parse(readFileSync(BASELINE_JSON, 'utf8')).enginePin.engineSrcMd5).not.toBe(
        rawMd5(bytes),
      );
    }
  });

  it('共享模块导出这两个函数（两个脚本才有共用可言）', () => {
    const libSrc = readFileSync(LIB, 'utf8');
    expect(libSrc).toMatch(/export function md5Normalized/);
    expect(libSrc).toMatch(/export function engineSourceMd5/);
  });

  it('compute 与 verify 都改成调用 engineSourceMd5()，且不再对 ENGINE_SRC 求原始 md5', () => {
    for (const [name, src] of [
      ['compute-flavor-baseline.mjs', readFileSync(COMPUTE, 'utf8')],
      ['verify-flavor-acceptance.mjs', readFileSync(VERIFY, 'utf8')],
    ]) {
      expect(src, `${name} 没有用共享的 engineSourceMd5()`).toMatch(/engineSourceMd5\(\)/);
      expect(src, `${name} 还在对 ENGINE_SRC 求原始字节哈希`).not.toMatch(
        /md5\(\s*fs\.readFileSync\(\s*ENGINE_SRC\s*\)\s*\)/,
      );
    }
  });
});
