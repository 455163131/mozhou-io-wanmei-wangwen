/**
 * 改标题的**装配层**哨兵（§4 第 19 条①）。
 *
 * 本仓反复出现的形状是"repo 有方法、IPC 没通道、UI 没入口"（§4 第 3/4/13/14/17 条），
 * 而改标题这条链路要跨四处契约（shared 类型表 + shared 白名单 + preload 白名单 +
 * preload 两层 + 主进程 handler + 渲染层调用点）。少一处都是**编译通过、运行时静默失败**，
 * 所以行为测试（`chapter-set-title.test.ts`）之外必须再钉一层通路。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('A. 通道声明：类型表与两份白名单必须同时有', () => {
  const ipc = read('src/shared/types/ipc.ts');
  const preload = read('src/preload/api.ts');

  it('IpcInvokeMap 声明 chapter:set-title', () => {
    expect(ipc).toContain("'chapter:set-title': {");
  });
  it('shared IPC_CHANNELS 白名单含 chapter:set-title', () => {
    expect(ipc).toMatch(/^\s+'chapter:set-title',\s*$/m);
  });
  it('preload INVOKE_CHANNELS 白名单含 chapter:set-title（漏这里=运行时静默拒绝）', () => {
    expect(preload).toMatch(/^\s+'chapter:set-title',\s*$/m);
  });
});

describe('B. 契约形状', () => {
  const ipc = read('src/shared/types/ipc.ts');
  const at = ipc.indexOf("'chapter:set-title': {");
  const decl = ipc.slice(at, at + 220);

  it('req 带 chapterId 与 title，res 是 ChapterMeta', () => {
    expect(at).toBeGreaterThan(-1);
    expect(decl).toMatch(/req: \{[^}]*chapterId: string/);
    expect(decl).toMatch(/req: \{[^}]*title: string/);
    expect(decl).toMatch(/res: ChapterMeta/);
  });

  it('★ 注释里写清"不动 rev"（这是这条通道最容易被后人"顺手修好"的地方）', () => {
    const block = ipc.match(/(\/\*\*[\s\S]*?\*\/)\s*\n\s*'chapter:set-title': \{/) as RegExpMatchArray;
    expect(block, '没有紧邻的注释块，这条等于空过').not.toBeUndefined();
    expect(block?.[1]).toMatch(/rev/);
  });
});

describe('C. 主进程接住', () => {
  const register = read('src/main/ipc/register.ts');
  const at = register.indexOf("handle('chapter:set-title'");
  const body = register.slice(Math.max(0, at), at + 700);

  it("handle('chapter:set-title') 存在", () => {
    expect(at, '声明了通道却没人处理').toBeGreaterThan(-1);
  });

  it('未打开项目时抛结构化 E_INVALID_ARGS', () => {
    expect(body).toMatch(/!\w+\.project/);
    expect(body).toMatch(/MzError\('E_INVALID_ARGS'/);
  });

  it('★ 调 setTitle，projectId 取自 services 而不是入参（第 18 条的口径）', () => {
    expect(body).toMatch(/setTitle\(\s*\w+\.project\.id/);
    expect(body, '章节号必须由项目维度一起定位').not.toMatch(/setTitle\(\s*p\.chapterId/);
  });

  it('title 类型校验在主进程（渲染层不做校验逻辑）', () => {
    expect(body).toMatch(/typeof p\.title !== 'string'/);
  });

  it('改标题算一次改动：触发备份记账', () => {
    expect(body, '改名后不记账，自动备份不会被这次改动叫醒').toMatch(/noteEdit\(\)/);
  });
});

describe('D. repo 的 SQL 带项目维度', () => {
  const repo = read('src/main/db/repos/chapter-repo.ts');

  it('setTitle 存在且 UPDATE 带 project_id', () => {
    const at = repo.indexOf('setTitle(');
    expect(at).toBeGreaterThan(-1);
    const slice = repo.slice(at, at + 600);
    expect(slice).toMatch(/UPDATE chapters SET title = \? WHERE project_id = \? AND id = \?/);
  });

  it('★ SQL 里不许出现 rev / updated_at（改名不是编辑正文）', () => {
    const at = repo.indexOf('setTitle(');
    const sql = repo.slice(at, at + 600).match(/UPDATE chapters SET[^']*/)?.[0] ?? '';
    expect(sql.length, '哨兵本身别静默失效：setTitle 里应当有 UPDATE chapters').toBeGreaterThan(0);
    expect(sql).not.toMatch(/rev/);
    expect(sql).not.toMatch(/updated_at/);
  });
});

describe('E. preload 两层与渲染层真的接上', () => {
  const api = read('src/preload/api.ts');
  const impl = read('src/preload/index.ts');
  const tree = read('src/renderer/components/chapter-tree/ChapterTree.tsx');

  it('MzBridge 接口声明 setTitle', () => {
    expect(api).toMatch(/setTitle\([^\n]*'chapter:set-title'/);
  });
  it('preload 实现走 invoke，通道名写死为 chapter:set-title', () => {
    expect(impl).toMatch(/setTitle: \(chapterId, title\) => invoke\('chapter:set-title'/);
  });
  it('★ 渲染层真调用 api.chapter.setTitle（定义了没人调 = 用户依旧改不了名）', () => {
    expect(tree).toMatch(/chapter\.setTitle\(/);
  });
  it('渲染层改完用主进程返回值刷新章节表（不许只改内存乐观值）', () => {
    const at = tree.indexOf('chapter.setTitle(');
    expect(tree.slice(at, at + 500)).toMatch(/setChapters\(/);
  });
});
