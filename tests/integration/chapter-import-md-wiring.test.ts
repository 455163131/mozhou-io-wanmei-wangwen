/**
 * 「导入 chapters/*.md」的**装配层**哨兵（§4 第 19 条②）。
 *
 * 这条链跨 6 个文件（IPC 契约四处同步 + services + 界面），本仓反复出的正是
 * "逻辑对、喂给它的是空气"（§4 第 3/9/10/13/14①/17/18 条）。纯函数与 repo 都测过了，
 * 但通道没接、白名单漏填、handler 没调 services、界面没有入口 —— 用户照样导入不了。
 *
 * 另外钉两条**设计约束**（不是随手写的，是这条的口径）：
 *   · 打开项目时**绝不自动导入**：自动扫描会在用户没点任何东西的情况下写库，
 *     一旦解析口径不符就成了"我的书自己变了"；只允许显式点一下。
 *   · 导入**不动磁盘上的 md**：非破坏性 —— 搬走、改名、删除都不行，
 *     万一导入口径不对，原件还在。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const ipc = read('src/shared/types/ipc.ts');
const api = read('src/preload/api.ts');
const bridge = read('src/preload/index.ts');
const register = read('src/main/ipc/register.ts');
const services = read('src/main/services.ts');
const project = read('src/shared/types/project.ts');
const tree = read('src/renderer/components/chapter-tree/ChapterTree.tsx');

describe('A. 契约四处同步（§5 坑 3）', () => {
  it('IpcInvokeMap 声明 chapter:import-md，req 是 void（导入不需要参数）', () => {
    expect(ipc).toMatch(/'chapter:import-md':\s*\{\s*req:\s*void;\s*res:\s*MdImportOutcome/);
  });

  it('★ shared IPC_CHANNELS 白名单里有它 —— 漏这一行 invoke 会被桥接层直接拒掉', () => {
    expect(ipc, 'src/shared/types/ipc.ts 的 IPC_CHANNELS 少一行').toMatch(
      /^\s+'chapter:import-md',\s*$/m,
    );
  });

  it('preload/api.ts：接口方法 + 它自己的 INVOKE_CHANNELS 都有', () => {
    expect(api).toMatch(/importMarkdown\s*\(\s*\):[^;]*'chapter:import-md'/);
    expect(api, 'src/preload/api.ts 的 INVOKE_CHANNELS 少一行（漏这里=运行时静默拒绝）').toMatch(
      /^\s+'chapter:import-md',\s*$/m,
    );
  });

  it('preload/index.ts：真的把方法接到 invoke 上', () => {
    expect(bridge).toMatch(/importMarkdown:\s*\(\)\s*=>\s*invoke\('chapter:import-md'/);
  });

  it('主进程 handler 调 services 的导入，且没项目时明确报错', () => {
    const at = register.indexOf("handle('chapter:import-md'");
    expect(at, '主进程没有 chapter:import-md handler').toBeGreaterThan(-1);
    const body = register.slice(at, at + 500);
    expect(body).toMatch(/importMarkdownChapters\(/);
    expect(body).toMatch(/未打开项目/);
  });
});

describe('B. 返回类型：三个桶一个都不能少', () => {
  it('MdImportOutcome 在共享类型里声明（渲染层要知道跳过了什么）', () => {
    const at = project.indexOf('export interface MdImportOutcome');
    expect(at, 'MdImportOutcome 没声明').toBeGreaterThan(-1);
    const body = project.slice(at, at + 900);
    for (const k of ['scanned', 'imported', 'skipped', 'unresolved']) {
      expect(body, `少了 ${k} 就等于把它悄悄吞了`).toContain(k);
    }
  });

  it('每个条目带 fileName 与 reason（用户要能对着文件名改）', () => {
    const at = project.indexOf('export interface MdImportOutcome');
    const body = project.slice(at, at + 900);
    expect(body).toContain('fileName');
    expect(body).toMatch(/reason/);
  });
});

describe('C. services 的扫描与入库', () => {
  /** 取方法体：从方法名起到本类方法结束的那个 `\n  }` 为止（窗口太宽会连坐到别的方法） */
  const methodBody = (name: string): string => {
    const at = services.indexOf(name);
    expect(at, `services.ts 里没有 ${name}`).toBeGreaterThan(-1);
    const end = services.indexOf('\n  }', at);
    expect(end, `${name} 的方法体结尾没找到`).toBeGreaterThan(at);
    return services.slice(at, end);
  };

  it('importMarkdownChapters 扫的是当前项目的 chapters 目录', () => {
    const body = methodBody('importMarkdownChapters');
    expect(body).toMatch(/scanMarkdownChapters\(/);
    expect(body).toMatch(/'chapters'/);
    expect(body).toMatch(/rootDir/);
  });

  it('★ 扫描模块用的是 withFileTypes + isFile，且只读', () => {
    const scan = read('src/main/fs/md-scan.ts');
    expect(scan).toMatch(/readdir\([^)]*withFileTypes/);
    expect(scan).toMatch(/isFile\(\)/);
    expect(scan).toMatch(/\.md/);
    expect(scan, '扫描模块写盘就等于破坏原件').not.toMatch(/writeFile|unlink|rmSync|renameSync/);
  });

  it('排队用纯函数，入库走 repo 的 importChapters（不是 createChapter 自己算号）', () => {
    const body = methodBody('importMarkdownChapters');
    expect(body).toMatch(/planMarkdownImport\(/);
    expect(body, '导入必须沿用文件名里的章号').toMatch(/importChapters\(/);
    expect(body).not.toMatch(/createChapter\(/);
  });

  it('★ 非破坏性：导入不删、不改名、不动磁盘上的 md', () => {
    const body = methodBody('importMarkdownChapters');
    expect(body).not.toMatch(/unlink|rmSync|renameSync|writeFile/);
    expect(read('src/main/fs/md-import.ts')).not.toMatch(/node:fs/);
  });

  it('★ 打开项目时不许自动导入（写库必须用户点一下）', () => {
    const at = services.indexOf('async openProject');
    expect(at).toBeGreaterThan(-1);
    const body = services.slice(at, services.indexOf('\n  }', at));
    expect(body, 'openProject 里调了导入 = 静默改库').not.toMatch(/importMarkdownChapters/);
  });

  it('导入了东西就记一次编辑（备份触发口径与建章一致）', () => {
    expect(methodBody('importMarkdownChapters')).toMatch(/noteEdit\(\)/);
  });
});

describe('D. 界面真的有入口', () => {
  it('章节树调用导入，并把结果按三个桶说给用户', () => {
    expect(tree).toMatch(/chapter\.importMarkdown\(\)/);
    expect(tree).toMatch(/unresolved/);
    expect(tree).toMatch(/skipped/);
  });

  it('★ 导入完整表回读：新章的 ord 由主进程定，界面不猜', () => {
    const at = tree.indexOf('importMarkdown()');
    expect(at).toBeGreaterThan(-1);
    const body = tree.slice(at, at + 900);
    expect(body).toMatch(/chapter\.list\(\)/);
    expect(body).toMatch(/setChapters\(/);
  });

  it('按钮文案要让旧稿用户看得懂（不是"刷新""同步"这种含糊词）', () => {
    expect(tree).toMatch(/导入/);
    expect(tree).toMatch(/\.md|旧稿/);
  });

  it('用的样式类必须在同名 module.css 里存在（第 20 条①刚栽过）', () => {
    const css = read('src/renderer/components/chapter-tree/ChapterTree.module.css');
    for (const m of tree.matchAll(/\bstyles\.([A-Za-z_][\w-]*)/g)) {
      expect(css, `ChapterTree.module.css 缺 .${m[1]}`).toContain(`.${m[1]}`);
    }
  });
});
