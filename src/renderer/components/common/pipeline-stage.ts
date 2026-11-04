/**
 * 管线条的状态推导（纯函数层，P2-UI T2 · DRD §4.1）。
 *
 * ★ 为什么单拆一个文件（§UI ·终审 Important-2③）：`deriveStage` 原来写在
 *   PipelineBar.tsx 里，而 `.tsx` 归 tsconfig.web.json、`tests/**` 归
 *   tsconfig.node.json（DOM-free、无 jsx）——终审要的那七条行为用例根本 import 不进来。
 *   本仓对此已有先例：`components/editor/inline-marks.ts` 也是这样把纯逻辑摘出来、
 *   再进 tsconfig.node 的 include 的（见那里与 vitest.config.ts 的注释）。
 *   组件侧（PipelineBar.tsx）只做装配与渲染，判定口径全在这里。
 *
 * ★ 状态推导口径（brief 钉的两颗锚 + 可观察证据）：
 *   - **无 adopted concept 草稿 = 灵感前段**：没打开项目 → 灵感 current；
 *     隔离区里还躺着 pending 的 concept 草稿（= 构思已产出但尚未采纳）→ 停在立项。
 *   - **有章 = 正文段**：`chapters.length > 0` 时最浅也是正文 current；
 *     出现 revised/done 章 → 质检 current；全 done → 定稿 current。
 *   - 中段两档走同步可得的证据：volumes 建了 → 骨架 done（章纲 current）；
 *     立了项但还没骨架 → 世界观 current。
 *   - 节点态 = 指针语义：指针之前全 done，指针处 current，其后 pending。
 *
 * ★ 一处如实写明的边界：`usePipelineStore.drafts` 只装 **pending** 草稿
 *   （GenView 的 `listDrafts(pid, 'pending')` 口径），「已采纳的 concept」在
 *   gen 模式之外不可见——所以 concept 采纳后若没建 volumes/章，条会停在
 *   世界观档。宁可停在前档，不许报超过证据的进度。
 */

/** 八节点（顺序即流水线顺序，DRD §4.1） */
export const PIPELINE_NODES = ['灵感', '立项', '世界观', '骨架', '章纲', '正文', '质检', '定稿'] as const;

/** 推导输入：只收同步可得的事实，不收任何需要现拉的数据 */
export interface PipelineEvidence {
  hasProject: boolean;
  hasVolumes: boolean;
  /** 隔离区里有 pending 的 concept 草稿（= 已产出未采纳 → 还没过立项关） */
  pendingConcept: boolean;
  chapterCount: number;
  /** status 为 revised 或 done 的章数（改过稿 = 质检已开始） */
  revisedOrDone: number;
  /** status 为 done 的章数（全 done = 定稿档） */
  doneCount: number;
}

/**
 * 返回 current 节点的下标 0..7。
 * 注：3（骨架）不会单独成为 current——它 done 的同一刻就是章纲的起点
 * （volumes 是可同步观察的布尔，没有「骨架建了一半」的中间态可报）。
 */
export function deriveStage(e: PipelineEvidence): number {
  if (e.chapterCount > 0) {
    // 有章 = 正文段（锚②）：再按章状态往质检/定稿推
    if (e.doneCount === e.chapterCount) return 7;
    if (e.revisedOrDone > 0) return 6;
    return 5;
  }
  if (!e.hasProject) return 0; // 还没立项，一切从灵感开始
  if (e.pendingConcept) return 1; // 有 pending concept = 还没过立项关（锚①）
  if (e.hasVolumes) return 4; // 骨架 done → 章纲 current（章列表本身即章纲的前身）
  return 2; // 立项 done → 世界观 current
}
