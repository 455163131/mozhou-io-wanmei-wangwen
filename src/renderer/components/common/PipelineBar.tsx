/**
 * 管线条（P2-UI T2 · DRD §4.1）——八节点创作流水线状态条。
 *
 *   灵感 → 立项 → 世界观 → 骨架 → 章纲 → 正文 → 质检 → 定稿
 *
 * 它回答的是外壳里原来没有的一个问题：「这本书现在整条流水线走到哪了」。
 * 挂 write 与 gen 两个模式的 .body 顶部（App.tsx），专注模式一起收掉；
 * 其余模式（大纲管理/世界观设定/审稿/统计账本）各管一段，不重复播报。
 *
 * ★ 判定口径与它的全部理由都在 `./pipeline-stage.ts`（纯函数层，终审 Important-2③
 *   为了那七条行为用例能 import 才拆出去的——`.tsx` 归 tsconfig.web、`tests/**`
 *   归 DOM-free 的 tsconfig.node，同 inline-marks.ts 的先例）。本文件只做两件事：
 *   从 store 取同步可得的事实 → 交给 deriveStage → 按指针语义渲染八颗节点。
 */
import { useProjectStore } from '../../store';
import { usePipelineStore } from '../../store/pipeline';
import { deriveStage, PIPELINE_NODES, type PipelineEvidence } from './pipeline-stage';
import styles from './PipelineBar.module.css';

/** 对外沿用原来的 import 面（组件文件仍是管线条的公共入口） */
export { deriveStage, PIPELINE_NODES, type PipelineEvidence };

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
