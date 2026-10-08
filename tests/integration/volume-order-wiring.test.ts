/**
 * 分卷/排序的**装配层**哨兵（§4 第 4 条）。
 *
 * 为什么又是源码文本断言而不是起真服务：`AppServices` 与主进程入口在测试里构造不出来
 * （`ELECTRON_RUN_AS_NODE` 下拿不到 electron 的 `app`），这是本仓既有先例
 * （`apikey-wiring.test.ts`、`ledger-statehash-wiring.test.ts`、`portable-data-dir.test.ts`）。
 *
 * ★ 这一层才是第 4 条的真正病灶：`ProjectRepo.insertVolume` 的逻辑一直是好的，
 *   全仓却**没有任何调用方**——repo 有方法、IPC 没通道、UI 没入口，
 *   于是「规划视图只读展示」。本仓库反复出现的正是这种"逻辑对、喂给它的是空气"的
 *   装配层缺陷，所以行为测试（volume-order.test.ts）之外必须再钉一层通路。
 *
 * 钉五件事：
 *   1. 类型映射表里有这四个通道（写错通道名 typecheck 就会红）；
 *   2. 两份白名单都有（`shared` 的 IPC_CHANNELS 与 preload 的 INVOKE_CHANNELS）——
 *      漏一处就是"编译通过、运行时静默拒绝"；
 *   3. 主进程真的 handle 了，且 project 级通道在未打开项目时抛结构化的 E_INVALID_ARGS
 *      （只读通道 `project:volumes` 返回空数组是另一口径，写通道不能静默成功）；
 *   4. 渲染层真的调用（不是只加了通道没人用）；
 *   5. 调用后回写 store，UI 不会停留在拖拽前的旧顺序。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const NEW_CHANNELS = [
  'project:create-volume',
  'project:reorder-volumes',
  'chapter:reorder',
  'chapter:set-volume',
] as const;

describe('A. 通道声明：类型表与两份白名单必须同时有', () => {
  const ipc = read('src/shared/types/ipc.ts');
  const preload = read('src/preload/api.ts');

  for (const ch of NEW_CHANNELS) {
    it(`IpcInvokeMap 声明 ${ch}`, () => {
      expect(ipc, `${ch} 没有类型映射，渲染层拿不到出入参类型`).toContain(`'${ch}': {`);
    });
    it(`shared IPC_CHANNELS 白名单含 ${ch}`, () => {
      expect(ipc).toMatch(new RegExp(`^\\s+'${ch}',\\s*$`, 'm'));
    });
    it(`preload INVOKE_CHANNELS 白名单含 ${ch}`, () => {
      expect(preload).toMatch(new RegExp(`^\\s+'${ch}',\\s*$`, 'm'));
    });
  }
});

describe('B. 主进程真的接住，且未打开项目时抛结构化错误', () => {
  const register = read('src/main/ipc/register.ts');

  for (const ch of NEW_CHANNELS) {
    it(`handle('${ch}') 存在`, () => {
      expect(register, `${ch} 声明了却没人处理`).toContain(`handle('${ch}'`);
    });
  }

  it('四条写通道在未打开项目时都抛结构化错误，而不是读 null.id 抛 TypeError', () => {
    for (const ch of NEW_CHANNELS) {
      const at = register.indexOf(`handle('${ch}'`);
      expect(at, `找不到 ${ch}`).toBeGreaterThan(-1);
      const body = register.slice(at, at + 500);
      expect(body, `${ch} 未先判项目是否已打开，会读到 null.id 抛 TypeError`).toMatch(/!\w+\.project/);
      expect(body, `${ch} 没抛 MzError，preload 那侧还原不成用户可读的错误`).toMatch(
        /MzError\('E_INVALID_ARGS'/,
      );
    }
  });

  it('只读通道在未打开项目时仍返回空数组（写通道要报错，读通道不该炸树）', () => {
    const at = register.indexOf("handle('chapter:list'");
    expect(at).toBeGreaterThan(-1);
    expect(register.slice(at, at + 200)).toMatch(/if \(!\w+\.project\) return \[\];/);
  });

  it('建卷走 repo 的 createVolume，不在 IPC 层自己拼 ord', () => {
    const at = register.indexOf("handle('project:create-volume'");
    const body = register.slice(at, at + 600);
    expect(body).toMatch(/projectRepo\.createVolume\(/);
    expect(body, 'IPC 层自己数 ord 会与 repo 的追加逻辑两套口径').not.toMatch(/volumes\([^)]*\)\.length/);
  });
});

describe('C. 渲染层真的调用，并且调用后回写 store', () => {
  const plan = read('src/renderer/components/views/PlanView.tsx');
  const tree = read('src/renderer/components/chapter-tree/ChapterTree.tsx');

  it('规划视图有真实的新建卷入口（不再是"将在后续版本接入"）', () => {
    expect(plan).toMatch(/project\.createVolume\(/);
    expect(plan, '还留着"后续版本接入"的占位话术').not.toMatch(/将在后续版本接入/);
  });

  it('规划视图能拖拽重排卷，并把返回的新顺序写回 store', () => {
    expect(plan).toMatch(/project\.reorderVolumes\(/);
    expect(plan).toMatch(/draggable/);
    expect(plan, '重排后没回写 volumes，界面会停在拖拽前的旧顺序').toMatch(/setVolumes\(/);
  });

  it('章节树能拖拽重排与跨卷移动，并回写 chapters', () => {
    expect(tree).toMatch(/chapter\.reorder\(/);
    expect(tree).toMatch(/chapter\.setVolume\(/);
    expect(tree).toMatch(/draggable/);
    expect(tree, '重排后没回写 chapters').toMatch(/setChapters\(/);
  });
});
