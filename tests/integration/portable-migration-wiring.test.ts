/**
 * 便携版旧数据迁移的**装配层**哨兵（§4 第 14 条①）。
 *
 * `migrateLegacyUserData()` 本身有 10 条真目录行为测试兜着
 * （`tests/unit/portable-migration.test.ts`）。本文件只管一件事：**入口有没有在
 * 正确的时间点调它**。这是本仓库反复出现的失败模式——逻辑对，喂给它的是空气：
 *
 *   · 调用挪到 `app.setPath('userData', …)` 之后 → 来源目录取到的就是便携目录本身，
 *     永远判成 same-dir，迁移等于没做；
 *   · 调用挪到 `new AppServices()` 之后 → 空库已经在便携目录里建好了，
 *     永远判成 target-busy，老用户照样看到空列表；
 *   · 没包进 try → 迁移抛一下，应用直接起不来（比不迁移严重得多）。
 *
 * index.ts 顶层就调 `app.requestSingleInstanceLock()`，在 `ELECTRON_RUN_AS_NODE=1`
 * 下 app API 全不可用，入口无法实例化，所以这层只能盯源码文本
 * （同 portable-data-dir.test.ts 的 B 组口径）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const entry = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
const migration = readFileSync(join(__dirname, '../../src/main/portable-migration.ts'), 'utf8');
const services = readFileSync(join(__dirname, '../../src/main/services.ts'), 'utf8');

describe('A. 入口真的接上了迁移，而且接在对的时间点', () => {
  it('从 ./portable-migration 取值并调用', () => {
    expect(entry).toMatch(/from\s+['"]\.\/portable-migration['"]/);
    expect(entry).toContain('migrateLegacyUserData(');
  });

  it('★ 来源目录 = 被覆盖之前的默认 userData（取晚了就等于自己搬自己）', () => {
    // 只认真代码那一行：注释里也写着 app.getPath('userData')，用 indexOf 会挑到注释上，
    // 顺序断言就变成永远为真的空话。
    const getAt = entry.search(/^\s*const legacyDir = app\.getPath\('userData'\);\s*$/m);
    const setAt = entry.search(/^\s*app\.setPath\(\s*['"]userData['"]/m);
    expect(getAt, '入口没有取"覆盖前的默认 userData"，迁移就没有来源目录').toBeGreaterThanOrEqual(0);
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(getAt, 'setPath 之后再读 userData 拿到的是便携目录，迁移会永远判成 same-dir').toBeLessThan(setAt);
    expect(entry.slice(getAt, setAt)).toMatch(/migrateLegacyUserData\(/);
  });

  it('★ 迁移必须早于 new AppServices()（晚一步空库已建好，永远判成 target-busy）', () => {
    const callAt = entry.indexOf('migrateLegacyUserData(');
    const useAt = entry.indexOf('new AppServices()');
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(useAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeLessThan(useAt);
  });

  it('传进去的是 legacyDir + targetDir 两个路径，没有第三份口径', () => {
    const call = entry.slice(entry.indexOf('migrateLegacyUserData('), entry.indexOf('migrateLegacyUserData(') + 200);
    expect(call).toMatch(/legacyDir/);
    expect(call).toMatch(/targetDir:\s*portableDir/);
  });

  it('★ 整段仍在 try/catch 里：迁移炸了不许挡住应用启动', () => {
    const callAt = entry.indexOf('migrateLegacyUserData(');
    const block = entry.slice(callAt, entry.indexOf('new AppServices()'));
    expect(entry.slice(0, callAt).split('try {').length).toBeGreaterThan(1);
    expect(block).toMatch(/catch\s*\(/);
  });

  it('三种结果各有日志：migrated 记账、failed 报错误、skipped 说清是哪条闸', () => {
    const at = entry.indexOf('migrateLegacyUserData(');
    const block = entry.slice(at, at + 900);
    expect(block).toMatch(/status\s*===\s*'migrated'[\s\S]*console\.log/);
    expect(block).toMatch(/status\s*===\s*'failed'[\s\S]*console\.error/);
    expect(block, '静默 skip 会让"为什么还是空的"变成无头案').toMatch(/reason/);
  });
});

describe('B. 迁移模块自身的边界', () => {
  it('★ 不 import electron：路径全由调用方注入，才能喂真目录做行为测试', () => {
    expect(migration).not.toMatch(/from\s+['"]electron['"]/);
    expect(migration).not.toMatch(/app\.getPath/);
  });

  it('★ 书稿信号与 services 打开的库名同源（各写一份字面量，改名后迁移会静默失效）', () => {
    expect(migration).toMatch(/import\s*\{[^}]*DB_FILENAME[^}]*\}\s*from\s*'\.\/data-dir'/);
    expect(services).toMatch(/openDatabase\(\s*join\(\s*app\.getPath\('userData'\)\s*,\s*DB_FILENAME\s*\)\s*\)/);
    expect(services, 'services.ts 里不该再出现裸的库名字面量').not.toMatch(/['"]mozhou\.db['"]/);
  });

  it('归档只改名不删除：源码里不许出现递归删除旧目录的调用', () => {
    expect(migration).toContain('renameSync(');
    expect(migration).not.toMatch(/\brmSync\(/);
  });
});
