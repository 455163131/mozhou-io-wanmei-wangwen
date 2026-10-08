/**
 * ★ 便携版的数据必须跟着 exe 走 —— §4 第 8 条。
 *
 * 缺陷形态：`electron-builder.yml:21` 打了 `portable` 目标，但主进程从没读过
 * `PORTABLE_EXECUTABLE_DIR`。portable 启动器把这个变量注入主进程环境，
 * 指向 **exe 自己所在的目录**；不读它，`app.getPath('userData')` 就还是
 * `%APPDATA%\墨舟写作台`。于是「便携版」名不副实：
 *
 *   · 拷到 U 盘带走，书稿和账本留在原来那台机器上；
 *   · 换一台电脑双击同一个 exe，打开的是一个空项目列表——
 *     用户会以为数据丢了（其实还在上一台机器的 %APPDATA% 里）。
 *
 * 修法只有一处装配：在**第一个 `app.getPath('userData')` 被读之前**
 * `app.setPath('userData', 便携目录)`。db / 备份 / keyring / `app:getPaths`
 * 四个消费点都从同一个 getter 取值（实测：services.ts:85,92、keyring.ts:21、
 * ipc/register.ts:61），所以改一次全部生效，不必逐个调用点加分支。
 *
 * 两层断言：
 *   A. 行为层：`portableDataDir()` 是纯函数（只吃 env，不碰 electron），
 *      直接喂真 env 断言真返回值；
 *   B. 装配哨兵：直接盯 `src/main/index.ts` 源码——
 *      接线被删、或者被挪到 `new AppServices()` **之后**，立刻红。
 *
 * B 层为什么用源码文本：index.ts 顶层就调 `app.requestSingleInstanceLock()`，
 * 而测试跑在 `ELECTRON_RUN_AS_NODE=1` 下（见 scripts/test.cmd），
 * 此时 electron 导出的是可执行文件路径字符串，app API 全都不可用，
 * 入口文件没法实例化（同 apikey-wiring.test.ts / ledger-statehash-wiring.test.ts 的处理）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { portableDataDir, PORTABLE_DATA_DIRNAME } from '@main/data-dir';

/** 把测试里的路径统一到当前平台的分隔符，避免把断言写成只能在 Windows 过 */
const p = (...parts: string[]): string => join(...parts);

describe('A. portableDataDir · 只吃 env 的纯解析', () => {
  it('portable 启动器注入了 PORTABLE_EXECUTABLE_DIR → 数据目录在该 exe 目录下', () => {
    const exeDir = p('D:', 'Apps', 'mozhou');
    const got = portableDataDir({ PORTABLE_EXECUTABLE_DIR: exeDir });

    expect(got).not.toBeNull();
    // 必须是 exe 旁边的**一个子目录**：直接摊在 exe 目录会把 mozhou.db、
    // 备份、凭据文件和 exe 混在一层，用户没法只拷 exe 升级、也没法整目录备份
    expect(dirname(got as string)).toBe(exeDir);
    expect(got).toBe(p(exeDir, PORTABLE_DATA_DIRNAME));
  });

  it('数据子目录名必须是 ASCII 短名（不用中文目录名）', () => {
    // better-sqlite3 是原生模块，路径要穿过它的 UTF-8/宽字符转换；
    // 中文名在部分非 Unicode 环境（老系统、某些同步盘）是已知雷区。
    // 这里冻结的是「形状」而不是具体名字——改名不影响装配，但不该改成中文。
    expect(PORTABLE_DATA_DIRNAME).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('安装版 / 开发模式没有这个变量 → 返回 null，数据目录保持 %APPDATA%', () => {
    // 返回 null 而不是造一个当前目录，是本条修复的安全边界：
    // NSIS 版一旦也被改走，卸载/升级路径会全变
    expect(portableDataDir({})).toBeNull();
  });

  it('变量存在但是空串或纯空白 → 同样算没注入，不能拼出相对路径', () => {
    // join('', 'mozhou-data') = 'mozhou-data'（相对进程 cwd）——
    // 数据会落到「双击 exe 时的工作目录」，那是最容易被清掉的地方
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '' })).toBeNull();
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '   ' })).toBeNull();
  });

  it('exe 目录带尾分隔符（盘根、带斜杠的拷贝路径）→ 不产生重复分隔符', () => {
    const got = portableDataDir({ PORTABLE_EXECUTABLE_DIR: `D:${sep}Apps${sep}` });
    expect(got).toBe(p('D:', 'Apps', PORTABLE_DATA_DIRNAME));
    expect(got).not.toMatch(/[\\/]{2}/);

    const root = portableDataDir({ PORTABLE_EXECUTABLE_DIR: `${sep}` });
    expect(root).not.toBeNull();
    expect(dirname(root as string)).toBe(p(sep));
  });

  it('★ 不传参数时读的是 process.env —— 证明真实运行路径接得上', () => {
    const key = 'PORTABLE_EXECUTABLE_DIR';
    const saved = process.env[key];
    const exeDir = p('E:', 'usb');
    try {
      process.env[key] = exeDir;
      expect(portableDataDir()).toBe(p(exeDir, PORTABLE_DATA_DIRNAME));
      delete process.env[key];
      expect(portableDataDir()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});

describe('B. 装配哨兵：index.ts 必须在读 userData 之前设置便携目录', () => {
  /**
   * 这一层盯的是**接线本身**。portableDataDir() 写得再对，
   * 只要入口没调它、或者调晚了，便携版照样写 %APPDATA%——
   * 与已修的闸门②（§4 第 0 条）、判据 B 账本（§4 第 9 条）同一个失败模式。
   */
  const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');

  it('入口从 ./data-dir 取值，并真的调用了 app.setPath', () => {
    expect(src).toMatch(/from\s+['"]\.\/data-dir['"]/);
    expect(src).toContain('portableDataDir(');
    expect(src).toMatch(/app\.setPath\(\s*['"]userData['"]/);
  });

  it('★ 设置必须发生在 new AppServices() 之前（晚一步等于没设置）', () => {
    const setAt = src.search(/app\.setPath\(\s*['"]userData['"]/);
    const useAt = src.indexOf('new AppServices()');
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(useAt).toBeGreaterThanOrEqual(0);
    expect(setAt).toBeLessThan(useAt);
  });

  it('★ 目录还不存在时必须先递归建出来', () => {
    // app.setPath 不负责创建目录。U 盘上新解压的 exe 旁边没有 mozhou-data，
    // better-sqlite3 打开不存在的目录会直接抛 → 服务初始化失败 → 应用起不来。
    const line = src
      .split('\n')
      .find((l) => /mkdirSync\([^)]*portable/i.test(l));
    expect(line, '便携目录没有 mkdirSync，全新 U 盘会打不开数据库').toBeTruthy();
    expect(line).toContain('recursive');
  });

  it('★ 建目录失败（只读介质、权限不足）不许让应用打不开', () => {
    // 便携 exe 常被放在光驱、写保护的 U 盘、只读的共享盘上。
    // 那里 mkdirSync 会抛：宁可退回 %APPDATA% 并留下日志，也不能双击没反应。
    const at = src.indexOf('portableDataDir(');
    expect(at).toBeGreaterThanOrEqual(0);
    const block = src.slice(at, src.indexOf('new AppServices()'));
    expect(src.slice(Math.max(0, at - 200), at)).toContain('try {');
    expect(block).toMatch(/catch\s*\(/);
    expect(block).toContain('console.error');
  });
});
