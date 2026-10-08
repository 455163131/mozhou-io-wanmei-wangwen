/**
 * 写策略判定（架构 §1.3 / T18）。
 *
 * ★ v1.1 语义变更的落点：**确认强度由 writePolicy 独立决定，不再由 danger 单方面决定**。
 *
 * 危险等级（danger）现在只表示「回滚成本」，不表示「要不要问用户」。
 * 三种模式：
 *   preview-only  —— 写操作只产出预览，永不落盘（最保守）
 *   auto-with-undo—— 自动执行 + 强制快照 + 随时可回滚（老板默认）
 *   ask-per-tool  —— danger ≥ autoApproveThreshold 的逐次确认
 *
 * ★★ **hardStopThreshold 不可被任何策略覆盖**：
 *   danger ≥ hardStop（默认 Irreversible=4）的工具**永不自动执行**，
 *   即使 policy 是 auto-with-undo。这条不能配成「自动」——
 *   export 写项目外会覆盖用户已有文件，出错的代价不是「多点一次」能比的。
 */
import { ToolDanger, type ToolSpec, type WritePolicyConfig } from '@shared/types/tool';

export type WriteDecision =
  /** 允许直接执行 */
  | { action: 'execute'; reason: string }
  /** 只做预览，不落盘 */
  | { action: 'preview-only'; reason: string }
  /** 需要用户确认 */
  | { action: 'need-approval'; reason: string }
  /** 硬性禁止 */
  | { action: 'blocked'; reason: string };

export function decideWrite(spec: ToolSpec, cfg: WritePolicyConfig): WriteDecision {
  // 只读工具永远直接执行
  if (!spec.writes) {
    return { action: 'execute', reason: '只读工具，无副作用' };
  }

  // ★ hardStop 优先于一切策略，不可被覆盖
  if (spec.danger >= cfg.hardStopThreshold) {
    return {
      action: 'need-approval',
      reason:
        `该工具回滚成本为 ★${spec.danger}（${dangerLabel(spec.danger)}），` +
        `已达到硬停阈值 ★${cfg.hardStopThreshold}。` +
        `即使当前策略是「自动执行 + 可回滚」，这类操作也必须你亲自确认。`,
    };
  }

  switch (cfg.policy) {
    case 'preview-only':
      return {
        action: 'preview-only',
        reason: '当前写策略为「只预览不落盘」，已生成 diff 待你确认。',
      };

    case 'auto-with-undo': {
      // ★ 修复记录（QA 缺口 2）：此前这里无条件 return 'execute'，
      //   danger 只出现在文案里，实际不参与判定 —— 意味着 ★2 与 ★3 的写工具
      //   在自动模式下被同等对待，危险分级形同虚设。
      //
      // ★ 二次修复：判据不能**只看 danger**。
      //   全部修正工具（derive-from-rules.ts:151）的 danger 是 Spillover(★2)，
      //   却都带 crossChapter:true —— 于是下面这条 `danger >= CrossScope` 永不成立，
      //   跨章确认**从来没有触发过**。而跨章批量改写的回滚会连带覆盖同批其它章的
      //   手动修改，代价明显高于单章改动，正是最需要用户点头的那一类。
      const crossesChapters = spec.crossChapter || spec.danger >= ToolDanger.CrossScope;
      if (crossesChapters && spec.danger < cfg.hardStopThreshold) {
        return {
          action: 'need-approval',
          reason:
            `该工具跨章改动（回滚成本 ★${spec.danger} ${dangerLabel(spec.danger)}）。` +
            `回滚会连带覆盖同批其它章的手动修改，代价高于单章改动，故需你确认。` +
            `若希望这类操作也自动执行，可把 autoApproveThreshold 调到 ★${spec.danger}。`,
        };
      }
      return {
        action: 'execute',
        reason:
          `自动执行（策略：auto-with-undo）。回滚成本 ★${spec.danger}（${dangerLabel(spec.danger)}），` +
          `执行前会强制落 checkpoint，可随时回滚。`,
      };
    }

    case 'ask-per-tool': {
      if (spec.danger >= cfg.autoApproveThreshold) {
        return {
          action: 'need-approval',
          reason:
            `当前写策略为「逐次确认」，该工具回滚成本 ★${spec.danger} ≥ 阈值 ★${cfg.autoApproveThreshold}，` +
            `需要你确认。`,
        };
      }
      return {
        action: 'execute',
        reason: `逐次确认模式下，★${spec.danger} 低于阈值 ★${cfg.autoApproveThreshold}，自动放行。`,
      };
    }

    default:
      // ★ fail-closed：未知策略一律要求确认，绝不默认放行。
      //   修复前这里是 `{ action: 'execute', reason: '未知策略，按自动执行处理' }`
      //   —— 安全闸门在遇到不认识的输入时选择了「放行」，方向完全反了。
      //   策略值来自渲染层/配置文件，任何拼写错误或未来新增的枚举都会落到这里，
      //   而写工具改的是用户正文。宁可多问一次，不可静默落盘。
      return {
        action: 'need-approval',
        reason:
          `写策略取值无法识别（${String(cfg.policy)}），出于安全已要求你确认。` +
          `可选值：preview-only | auto-with-undo | ask-per-tool。`,
      };
  }
}

export function dangerLabel(d: ToolDanger): string {
  switch (d) {
    case ToolDanger.Precise:
      return '精确可还原';
    case ToolDanger.Spillover:
      return '按章可回滚';
    case ToolDanger.CrossScope:
      return '跨章，回滚粒度粗';
    case ToolDanger.Irreversible:
      return '影响项目外部';
    case ToolDanger.Destructive:
      return '破坏不可再生劳动';
    default:
      return '未知';
  }
}

/** 单章 vs 跨章决定 checkpoint 粒度：跨章按批 */
export function checkpointGranularity(spec: ToolSpec): 'per-chapter' | 'per-batch' {
  return spec.crossChapter ? 'per-batch' : 'per-chapter';
}

/** 该工具单次调用的最大受影响字节（校验入参是否超预算） */
export function assertWithinBudget(spec: ToolSpec, chapters: string[], bodyOf: (id: string) => string): void {
  let total = 0;
  for (const id of chapters) {
    const body = bodyOf(id);
    total += Buffer.byteLength(body ?? '', 'utf8');
  }
  // 允许 2 倍余量：maxAffectedBytes 是「典型值」，实际章节可略超
  if (total > spec.maxAffectedBytes * chapters.length * 2) {
    throw new Error(
      `受影响正文 ${(total / 1024).toFixed(0)}KB 超出该工具预算 ` +
        `${((spec.maxAffectedBytes * chapters.length * 2) / 1024).toFixed(0)}KB。` +
        `请减少单次处理的章节数。`,
    );
  }
}