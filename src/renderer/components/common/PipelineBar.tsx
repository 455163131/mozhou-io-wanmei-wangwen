/**
 * 管线条（P2-UI T2 · DRD §4.1）——八节点创作流水线状态条。
 *
 *   灵感 → 立项 → 世界观 → 骨架 → 章纲 → 正文 → 质检 → 定稿
 *
 * 它回答的是外壳里原来没有的一个问题：「这本书现在整条流水线走到哪了」。
 * 挂 write 与 gen 两个模式的 .body 顶部（App.tsx），专注模式一起收掉；
 * 其余模式（大纲管理/世界观设定/审稿/统计账本）各管一段，不重复播报。
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
import { useProjectStore } from '../../store';
import { usePipelineStore } from '../../store/pipeline';
import styles from './PipelineBar.module.css';

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

export function PipelineBar(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const chapters = useProjectStore((s) => s.chapters);
  const volumes = useProjectStore((s) => s.volumes);
  const drafts = usePipelineStore((s) => s.drafts);

  const stage = deriveStage({
    hasProject: project !== null,
    hasVolumes: volumes.length > 0,
    pendingConcept: drafts.some((d) => d.kind === 'concept' && d.status === 'pending'),
    chapterCount: chapters.length,
    revisedOrDone: chapters.filter((c) => c.status === 'revised' || c.status === 'done').length,
    doneCount: chapters.filter((c) => c.status === 'done').length,
  });

  return (
    <div className={styles.bar} role="group" aria-label="创作流水线进度">
      <ol className={styles.track}>
        {PIPELINE_NODES.map((label, i) => (
          <li
            key={label}
            className={`${styles.node} ${
              i < stage ? styles.nodeDone : i === stage ? styles.nodeCurrent : styles.nodePending
            }`}
            aria-current={i === stage ? 'step' : undefined}
          >
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.nodeLabel}>{label}</span>
          </li>
        ))}
      </ol>
      <span className={styles.stageNow}>{PIPELINE_NODES[stage]} · 当前</span>
    </div>
  );
}
