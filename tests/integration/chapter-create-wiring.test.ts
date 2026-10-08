/**
 * 新建章节的**装配层**哨兵（§4 第 17 条）。
 *
 * 为什么又是源码文本断言：`AppServices` 与主进程入口在测试里构造不出来
 * （`ELECTRON_RUN_AS_NODE` 下拿不到 electron 的 `app`），沿用本仓既有先例
 * （`volume-order-wiring.test.ts`、`daily-delta-wiring.test.ts`）。
 *
 * ★ 第 17 条的病灶正是装配层：`ChapterRepo.insert` 逻辑一直是好的，全仓零调用方，
 *   于是 chapters 表恒为空——单测能过是因为测试自己造数据。行为测试
 *   （`chapter-create.test.ts`）之外必须再钉一层通路，否则"repo 有方法、
 *   IPC 没通道、UI 没入口"会第三次发生。
 *
 * 钉六件事：
 *   1. 类型映射表 + 两份白名单三处都有 `chapter:create`（漏一处=编译通过、运行时静默拒绝）；
 *   2. 主进程真的 handle，未打开项目时抛结构化 `E_INVALID_ARGS`；
 *   3. ★ 请求体里**没有 id**：章节号由主进程算。前端传主键，双击就多一章或撞主键；
 *   4. handle 调的是 `createChapter(project.id, …)`，projectId 取自 services 而非入参；
 *   5. preload 两层（接口声明 + 实现）都接上；
 *   6. 渲染层真调用，且建完立刻回读列表并选中新章——否则用户点了没反应。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('A. 通道声明：类型表与两份白名单必须同时有', () => {
  const ipc = read('src/shared/types/ipc.ts');
  const preload = read('src/preload/api.ts');

  it('IpcInvokeMap 声明 chapter:create', () => {
    expect(ipc, '没有类型映射，渲染层拿不到出入参类型').toContain("'chapter:create': {");
  });
  it('shared IPC_CHANNELS 白名单含 chapter:create', () => {
    expect(ipc).toMatch(/^\s+'chapter:create',\s*$/m);
  });
  it('preload INVOKE_CHANNELS 白名单含 chapter:create', () => {
    expect(preload).toMatch(/^\s+'chapter:create',\s*$/m);
  });
});

describe('B. 请求体不含主键', () => {
  const ipc = read('src/shared/types/ipc.ts');

  it('★ req 只有 title 与 volumeId，没有 id', () => {
    const at = ipc.indexOf("'chapter:create': {");
    expect(at).toBeGreaterThan(-1);
    const decl = ipc.slice(at, at + 200);
    expect(decl).toMatch(/req: \{[^}]*title: string/);
    expect(decl).toMatch(/req: \{[^}]*volumeId: string \| null/);
    expect(decl.slice(0, decl.indexOf('}')), '主键由前端传进来等于让界面决定主键').not.toMatch(/\bid\??:/);
  });

  it('res 是 ChapterMeta（新建后界面要立刻拿到号、ord、rev）', () => {
    const at = ipc.indexOf("'chapter:create': {");
    expect(ipc.slice(at, at + 200)).toMatch(/res: ChapterMeta/);
  });
});

describe('C. 主进程接住', () => {
  const register = read('src/main/ipc/register.ts');
  const at = register.indexOf("handle('chapter:create'");

  it("handle('chapter:create') 存在", () => {
    expect(at, '声明了通道却没人处理').toBeGreaterThan(-1);
  });

  it('未打开项目时抛结构化 E_INVALID_ARGS', () => {
    const body = register.slice(at, at + 700);
    expect(body).toMatch(/!\w+\.project/);
    expect(body).toMatch(/MzError\('E_INVALID_ARGS'/);
  });

  it('★ 调 createChapter，projectId 取自 services 而不是入参', () => {
    const body = register.slice(at, at + 700);
    expect(body).toMatch(/createChapter\(\s*\w+\.project\.id/);
    expect(body, '界面传来的号被当成主键用了').not.toMatch(/p\.id\b/);
  });

  it('title 类型校验在主进程（渲染层不做校验逻辑）', () => {
    const body = register.slice(at, at + 700);
    expect(body).toMatch(/typeof p\.title !== 'string'/);
  });

  it('建章算一次改动：触发备份记账', () => {
    const body = register.slice(at, at + 700);
    expect(body, '新建章节后不记账，自动备份不会被这次改动叫醒').toMatch(/noteEdit\(\)/);
  });
});

describe('D. preload 两层都接上', () => {
  const api = read('src/preload/api.ts');
  const impl = read('src/preload/index.ts');

  it('MzBridge 接口声明 create', () => {
    expect(api).toMatch(/create\(\s*payload:[^)]*chapter:create/);
  });
  it('实现走 invoke，通道名写死为 chapter:create', () => {
    expect(impl).toMatch(/create: \(payload\) => invoke\('chapter:create', payload\)/);
  });
});

describe('E. 渲染层真的调用', () => {
  const tree = read('src/renderer/components/chapter-tree/ChapterTree.tsx');

  it('调用 chapter.create', () => {
    expect(tree).toMatch(/chapter\.create\(/);
  });
  it('★ 建完回读整表并选中新章（点了没反应是第 17 条的原始症状）', () => {
    expect(tree).toMatch(/chapter\.list\(\)/);
    expect(tree).toMatch(/setCurrent\(/);
  });
  it('空态文案不再是「打开或新建一个项目」这种把人堵在原地的话', () => {
    expect(tree, '还没有章节时应该给出建章入口').not.toContain('打开或新建一个项目开始。');
  });
});
