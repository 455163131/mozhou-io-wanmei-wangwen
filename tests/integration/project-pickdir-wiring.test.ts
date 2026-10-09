/**
 * §4 第 29 条：打开 / 切换项目用的是 `window.prompt` 让用户**手打绝对路径**。
 *
 * ★ 实测到的修复前事实：
 *   - `App.tsx:138` 是 `const dir = window.prompt('输入项目目录的绝对路径：')`。
 *     这不是文件夹选择器——用户得自己拼出 `C:\Users\...\我的书` 这种字符串。
 *     而这是网文作者**进这个应用的第一个动作**，目标用户恰好是不碰路径的人。
 *   - 全仓 `grep -rn "dialog" src/main` 零命中（只有一处 `dialogRatio` 是无关字段）：
 *     Electron 的 `dialog.showOpenDialog` **从来没被用过**。
 *   - 副作用：这条也是截图自动化开不了项目的原因（prompt 是 Chromium 自绘的，
 *     不是 `#32770` 原生对话框，粘贴+回车那套打不进去）。
 *
 * 本文件验的是"通道四处齐 + 渲染层真的走它 + 取消不许当错误"。
 * 三份 invoke 清单的**集合相等**（B 组）是顺带补的总闸：
 * push 侧第 25 条已经有了，invoke 侧一直缺——而 §5 记的坑 3 就是"漏一处白名单，
 * 运行时静默拒绝"，靠每条通道各写三遍断言防不住后来人。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const ipcTypes = read('../../src/shared/types/ipc.ts');
const preloadApi = read('../../src/preload/api.ts');
const register = read('../../src/main/ipc/register.ts');
const appTsx = read('../../src/renderer/App.tsx');

const CH = 'project:pick-dir';
const rendererRoot = dirname(fileURLToPath(new URL('../../src/renderer/App.tsx', import.meta.url)));

describe('A. 四处清单必须齐（漏任何一处都是运行时静默失败）', () => {
  it('IpcInvokeMap 有这条的键，且 res 可为 null（取消是正常结果不是错误）', () => {
    expect(ipcTypes).toContain(`'${CH}'`);
    const m = new RegExp(`'${CH}':\\s*\\{([^}]*)\\}`).exec(ipcTypes);
    expect(m, '声明体解析不出来').not.toBeNull();
    expect(m![1]).toMatch(/req:\s*void/);
    expect(m![1], 'res 不含 null 的话，用户按取消就变成抛错').toMatch(/res:\s*string\s*\|\s*null/);
  });

  it('shared 的 IPC_CHANNELS 白名单含它', () => {
    const at = ipcTypes.indexOf('IPC_CHANNELS');
    expect(at).toBeGreaterThan(0);
    expect(ipcTypes.slice(at).includes(`'${CH}'`), 'IPC_CHANNELS 少一行').toBe(true);
  });

  it('preload 的 INVOKE_CHANNELS 含它（漏这里＝preload 直接拒绝转发）', () => {
    const at = preloadApi.indexOf('INVOKE_CHANNELS');
    expect(at).toBeGreaterThan(0);
    expect(preloadApi.slice(at).includes(`'${CH}'`), 'src/preload/api.ts 的 INVOKE_CHANNELS 少一行').toBe(true);
  });

  it('preload 的接口类型上有对应方法，且 index.ts 真有实现', () => {
    expect(preloadApi).toMatch(/pickDir\s*\(\s*\)\s*:\s*Promise<\s*IpcInvokeMap\['project:pick-dir'\]\['res'\]\s*>/);
    // 类型声明与实现是两个文件（api.ts 只放 MzBridge 类型，index.ts 才是桥对象）。
    // 只加类型的话 TS2741 会拦下，但这条断言让"漏实现"在测试层就红，不用等编译。
    const impl = read('../../src/preload/index.ts');
    expect(impl).toMatch(/pickDir:\s*\(\)\s*=>\s*invoke\('project:pick-dir'\)/);
  });

  it('主进程有 handler，且真的用原生目录选择器', () => {
    const at = register.indexOf(`handle('${CH}'`);
    expect(at, 'handler 没注册').toBeGreaterThan(0);
    const block = register.slice(at, at + 700);
    expect(block).toMatch(/showOpenDialog/);
    expect(block, '没开 openDirectory 就是文件选择器，选不了书稿目录').toMatch(/openDirectory/);
    expect(block, '取消必须返回 null，不能抛').toMatch(/canceled/);
  });
});

describe('B. 三份 invoke 清单必须逐个相等（总闸，防 §5 坑 3 复发）', () => {
  const mapKeys = (() => {
    const at = ipcTypes.indexOf('interface IpcInvokeMap');
    const open = ipcTypes.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < ipcTypes.length; i++) {
      if (ipcTypes[i] === '{') depth++;
      else if (ipcTypes[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return [...ipcTypes.slice(open, end).matchAll(/^\s*'([\w:-]+)':\s*\{/gm)].map((m) => m[1]).sort();
  })();

  const listFrom = (src: string, decl: RegExp): string[] => {
    const m = decl.exec(src);
    // ★ 不能用 indexOf(名字)：`IPC_CHANNELS` 在文件顶部的注释和第 464 行的
    //   `(IPC_CHANNELS as readonly string[])` 里都出现过，indexOf 会先命中那个
    //   `string[]`，于是切出一个空数组——第一版就是这么假红成"清单是空的"。
    if (!m || m.index === undefined) throw new Error(`找不到声明：${decl}`);
    const open = src.indexOf('[', m.index + m[0].length - 1);
    const close = src.indexOf(']', open);
    return [...src.slice(open, close).matchAll(/'([\w:-]+)'/g)].map((x) => x[1]).sort();
  };

  it('IpcInvokeMap 的键非空且无重复', () => {
    expect(mapKeys.length).toBeGreaterThan(40);
    expect(new Set(mapKeys).size, '有重复键').toBe(mapKeys.length);
  });

  it('shared IPC_CHANNELS 与类型表逐个相等', () => {
    expect(listFrom(ipcTypes, /export const IPC_CHANNELS\s*=\s*\[/)).toEqual(mapKeys);
  });

  it('preload INVOKE_CHANNELS 与类型表逐个相等', () => {
    expect(listFrom(preloadApi, /INVOKE_CHANNELS[^=]*=\s*\[/)).toEqual(mapKeys);
  });

  it('每个通道在 register.ts 里都有 handler（不多不少）', () => {
    // 允许 `handle(\n  'channel',` 这种多行写法——本仓有 18 处是这样的
    const handled = [...register.matchAll(/handle\(\s*'([\w:-]+)'/g)].map((x) => x[1]).sort();
    expect(handled).toEqual(mapKeys);
  });
});

describe('C. 渲染层必须真的走它，浏览器模态只减不增', () => {
  /**
   * 还欠着的浏览器模态。**这是棘轮不是免罪**：数对不上就红，
   * 修掉一处就把条目删掉；新加一处直接红。
   * 两处都是 `window.confirm` 问"要不要强制回滚"——最该被设计的一句话
   * （要说清撤回到哪、丢多少改动），现在是一条浏览器灰条。等 in-app 确认框。
   */
  const BROWSER_MODAL_DEBT: Record<string, number> = {
    'components/agent/AgentPanel.tsx': 1,
    'components/history/HistoryTimeline.tsx': 1,
  };

  /** 剥掉块注释与行注释：不剥的话，我自己写的"这里曾经是 window.prompt"会被当代码判红 */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const rendererFiles = (exts: RegExp): string[] => {
    const out: string[] = [];
    const walk = (d: string, base: string): void => {
      for (const n of readdirSync(d)) {
        const full = join(d, n);
        const rel = base ? `${base}/${n}` : n;
        if (statSync(full).isDirectory()) walk(full, rel);
        else if (exts.test(n)) out.push(rel);
      }
    };
    walk(rendererRoot, '');
    return out;
  };

  it('window.prompt / alert / confirm 的出现次数必须逐个文件对上台账（新一处就红，少一处也要红）', () => {
    const offenders: string[] = [];
    for (const rel of rendererFiles(/\.(ts|tsx)$/)) {
      const src = stripComments(read(`../../src/renderer/${rel}`));
      const n = (src.match(/window\.(prompt|alert|confirm)\s*\(/g) ?? []).length;
      if (n !== (BROWSER_MODAL_DEBT[rel] ?? 0)) {
        offenders.push(`${rel}: 实见 ${n}，台账 ${(BROWSER_MODAL_DEBT[rel] ?? 0)}（修掉就删条目，新增就是错）`);
      }
    }
    expect(offenders, `浏览器模态与台账不符：\n${offenders.join('\n')}`).toEqual([]);
    // 台账本身不许过期
    for (const rel of Object.keys(BROWSER_MODAL_DEBT)) {
      expect(existsSync(fileURLToPath(new URL(`../../src/renderer/${rel}`, import.meta.url))), `${rel} 已不存在，台账要删`).toBe(true);
    }
  });

  it('打开项目这条路径上不许再有 window.prompt（App.tsx 必须为 0）', () => {
    expect(stripComments(appTsx)).not.toMatch(/window\.(prompt|alert|confirm)\s*\(/);
  });

  it('openProject() 先 pickDir 再 open，且取消时静默返回', () => {
    const at = appTsx.indexOf('async function openProject');
    expect(at, 'openProject 不见了').toBeGreaterThan(0);
    const block = appTsx.slice(at, at + 700);
    expect(block, '没走目录选择器').toMatch(/project\.pickDir\(\)/);
    expect(block, '取消必须早退，不能把 null 当目录去 open').toMatch(/if\s*\(\s*!dir\s*\)\s*return/);
    expect(block).toMatch(/project\.open\(\s*dir\s*\)/);
  });
});
