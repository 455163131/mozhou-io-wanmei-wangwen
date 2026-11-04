/**
 * §UI ·终审 Important-2③ —— PipelineBar 的 `deriveStage` 行为用例（7 组合）。
 *
 * 为什么这条以前没有：管线条是 T2 新加的「只读播报器」，T2/T3/T4 的门禁全部钉在
 * **接线**（组件被 import、挂在 write/gen 的 .body 顶部、八节点顺序、CSS 文件存在），
 * 没有一条钉**推导本身**。而它输出的恰好是用户理解全书进度的唯一入口——
 * `stage` 差一档，条上「当前」那颗节点就指错地方，且**不会有任何报错**。
 *
 * ★ 七档对应的正是 deriveStage 的七个出口（0/1/2/4/5/6/7；3=骨架永不为 current，
 *   volumes 是同步可得的布尔，没有「建了一半」的中间态可报）。每条用例都从
 *   文件头那两条锚出发：
 *     锚① 无 adopted concept（有 pending concept 草稿）→ 停在立项；
 *     锚② 有章 → 至少到正文；revised/done 出现 → 质检；全 done → 定稿。
 *   外加「宁可停在前档，不许报超过证据的进度」这条边界纪律。
 *
 * 环境说明：`deriveStage` 是纯函数（不读 store、不碰 DOM），所以本文件在
 * environment:'node' 下直接 import 调用它——同 editor-store.test.ts 的口径。
 * 它是**独立模块** `components/common/pipeline-stage.ts` 而不是 PipelineBar.tsx：
 * `.tsx` 归 tsconfig.web.json，而 tests/** 归 DOM-free 的 tsconfig.node.json（无 jsx），
 * 从组件文件 import 会让 `npm run typecheck` 报 TS6142。拆分口径照
 * `components/editor/inline-marks.ts`（两处注释都写了这件事）。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveStage,
  PIPELINE_NODES,
  type PipelineEvidence,
} from '@renderer/components/common/pipeline-stage';

/** 全 false 的基线：没打开项目、没章、没草稿 */
const NONE: PipelineEvidence = {
  hasProject: false,
  hasVolumes: false,
  pendingConcept: false,
  chapterCount: 0,
  revisedOrDone: 0,
  doneCount: 0,
};
const ev = (patch: Partial<PipelineEvidence>): PipelineEvidence => ({ ...NONE, ...patch });

describe('deriveStage · 七个出口各一条行为用例（纯函数，不碰 store）', () => {
  it('① 灵感(0)：没打开项目——一切从灵感开始，与其余证据无关', () => {
    expect(deriveStage(ev({}))).toBe(0);
    // 无项目时即使有章数也不该出现（数据不一致的防御：锚② 优先，但这里钉的是「先判项目」的形状）
    expect(deriveStage(ev({ hasVolumes: true, pendingConcept: true })), '无项目却往前报进度').toBe(0);
  });

  it('② 立项(1)：隔离区里还躺着 pending 的 concept 草稿 = 构思已产出但没采纳（锚①）', () => {
    expect(deriveStage(ev({ hasProject: true, pendingConcept: true }))).toBe(1);
    expect(
      deriveStage(ev({ hasProject: true, pendingConcept: true, hasVolumes: true })),
      'pending concept 压过了 volumes：没采纳的构思不该把条推到章纲',
    ).toBe(1);
  });

  it('③ 世界观(2)：开了项目、concept 已采纳（无 pending）、还没建卷', () => {
    expect(deriveStage(ev({ hasProject: true }))).toBe(2);
  });

  it('④ 章纲(4)：volumes 建了 → 骨架同刻 done，指针落到章纲', () => {
    expect(deriveStage(ev({ hasProject: true, hasVolumes: true }))).toBe(4);
  });

  it('⑤ 骨架(3) 永不为 current（deriveStage 只有 0/1/2/4/5/6/7 七个出口）', () => {
    const seen = new Set<number>();
    for (const hasProject of [false, true])
      for (const hasVolumes of [false, true])
        for (const pendingConcept of [false, true])
          for (const chapterCount of [0, 3])
            for (const revisedOrDone of [0, chapterCount])
              for (const doneCount of [0, revisedOrDone]) {
                seen.add(deriveStage(ev({ hasProject, hasVolumes, pendingConcept, chapterCount, revisedOrDone, doneCount })));
              }
    expect([...seen].sort((a, b) => a - b), '出口集漂了：3 档不该出现，其余六档必须都在').toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(PIPELINE_NODES[3]).toBe('骨架');
  });

  it('⑥ 正文(5)：有章但一章都没改过稿（锚②的起点）', () => {
    expect(deriveStage(ev({ hasProject: true, hasVolumes: true, chapterCount: 5 }))).toBe(5);
    expect(
      deriveStage(ev({ hasProject: true, chapterCount: 5, revisedOrDone: 0, doneCount: 0 })),
      '章数优先于项目/卷证据：有章就至少到正文',
    ).toBe(5);
  });

  it('⑦ 质检(6)：出现 revised 或 done 的章 = 质检已开始（但还没全过）', () => {
    expect(deriveStage(ev({ hasProject: true, chapterCount: 5, revisedOrDone: 1 }))).toBe(6);
    expect(deriveStage(ev({ hasProject: true, chapterCount: 5, revisedOrDone: 4, doneCount: 3 }))).toBe(6);
  });

  it('⑧ 定稿(7)：全部章 done', () => {
    expect(deriveStage(ev({ hasProject: true, chapterCount: 5, revisedOrDone: 5, doneCount: 5 }))).toBe(7);
    expect(
      deriveStage(ev({ hasProject: true, chapterCount: 1, revisedOrDone: 1, doneCount: 1 })),
      '单章 done 也算定稿：口径是「全 done」而不是「够多 done」',
    ).toBe(7);
  });
});

describe('deriveStage · 边界纪律（不许报超过证据的进度）', () => {
  it('★ 采纳后没建卷也没建章 → 停在世界观，不许跳到章纲/正文', () => {
    expect(deriveStage(ev({ hasProject: true, hasVolumes: false, chapterCount: 0 }))).toBe(2);
  });

  it('★ doneCount 超过 revisedOrDone 的脏数据不往前推（只认「全 done」这一条线）', () => {
    // 真实数据里 done ⊆ revisedOrDone；构造不满足包含关系的脏输入时，
    // 判据仍是 doneCount === chapterCount，不许因为 doneCount 大就报定稿。
    expect(deriveStage(ev({ hasProject: true, chapterCount: 4, revisedOrDone: 2, doneCount: 3 }))).toBe(6);
    expect(deriveStage(ev({ hasProject: true, chapterCount: 4, revisedOrDone: 0, doneCount: 4 })),
      'done 全等于章数时报的却是别的档').toBe(7);
  });
});
