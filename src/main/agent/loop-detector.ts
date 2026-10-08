/**
 * 双判据循环检测（架构 §1.4.1 判据 ④，**最关键的设计**）。
 *
 * 为什么需要两个判据——它们抓的是完全不同的病：
 *
 *   判据 A「同参数重复调用」：抓「无脑重试」。
 *     key = hash(toolName + canonicalJSON(normalizedArgs))，窗口内出现 ≥3 次即判定。
 *     ⚠️ A 会**误报**「合法地多次调同一只读工具」（如连续查 3 次账本），
 *        所以要给 idempotent:true 的工具豁免——这也是 ToolSpec 保留 idempotent 字段的原因。
 *
 *   判据 B「状态指纹无变化」：抓「换了工具但状态没变」与「在 A/B 两个状态间横跳」。
 *     每步结束算 projectTextHash = sha256(全部章节正文 + 账本摘要)。
 *     序列 [h1,h2,h1,h2,h1] → LOOP_STATE_OSCILLATION
 *     全部相同 → LOOP_NO_EFFECT
 *
 * ★ **只有 A 会漏掉「换了工具但状态没变」和「横跳」**——这是 B 存在的全部理由。
 */
import {
  LOOP_ARG_THRESHOLD,
  LOOP_ARG_WINDOW,
  LOOP_FINGERPRINT_WINDOW,
  LOOP_OSCILLATION_MIN_REPEATS,
} from '@shared/constants/budget';
import { hashInvocation } from '../util/hash';
import type { LoopVerdict } from './budget-guard';

interface ArgRecord {
  hash: string;
  toolName: string;
  idempotent: boolean;
}

export class LoopDetector {
  /** 判据 A 的调用记录（滑动窗口） */
  private argWindow: ArgRecord[] = [];
  /** 判据 B 的状态指纹序列 */
  private fingerprintWindow: string[] = [];

  /**
   * 每步开始前记录一次工具调用（判据 A）。
   * @param idempotent 幂等工具豁免：重复调用安全，不算循环
   */
  recordInvocation(toolName: string, args: unknown, idempotent: boolean): LoopVerdict | null {
    const hash = hashInvocation(toolName, args);
    this.argWindow.push({ hash, toolName, idempotent });
    if (this.argWindow.length > LOOP_ARG_WINDOW) this.argWindow.shift();

    // 幂等工具豁免
    if (idempotent) return null;

    const sameCount = this.argWindow.filter((r) => r.hash === hash).length;
    if (sameCount >= LOOP_ARG_THRESHOLD) {
      return {
        kind: 'repeat-arg',
        toolName,
        times: sameCount,
        argsHash: hash.slice(0, 12),
      };
    }
    return null;
  }

  /**
   * 每步结束后记录状态指纹（判据 B）。
   * @returns 命中振荡/无变化时返回 verdict，否则 null
   */
  recordState(hash: string): LoopVerdict | null {
    this.fingerprintWindow.push(hash);
    if (this.fingerprintWindow.length > LOOP_FINGERPRINT_WINDOW) this.fingerprintWindow.shift();

    const win = this.fingerprintWindow;

    // ① 全部相同 → LOOP_NO_EFFECT。
    //    必须在长度门槛**之前**判定：no-effect 只需 3 步相同，
    //    若放在门槛后会被 6 步下限挡住，导致「改了但没变」抓不到。
    if (win.length >= 3 && win.every((h) => h === win[0])) {
      return { kind: 'no-effect', unchangedSteps: win.length };
    }

    // ② ABAB 振荡：找周期为 p 的重复模式，重复 ≥3 个周期即判定。
    //    例：[h1,h2,h1,h2,h1,h2] → p=2，3 个周期 → 振荡。
    for (let period = 1; period * 2 <= win.length; period++) {
      const cycles = Math.floor(win.length / period);
      if (cycles < LOOP_OSCILLATION_MIN_REPEATS) continue;
      // 该周期内必须严格重复
      let periodic = true;
      for (let i = period; i < win.length; i++) {
        if (win[i] !== win[i - period]) {
          periodic = false;
          break;
        }
      }
      if (periodic && new Set(win.slice(0, period)).size >= 1 && period >= 1) {
        // period=1 且全同已在 ① 处理过，这里只处理 period≥2 的往复
        if (period === 1) continue;
        const pattern = win.slice(0, period).map((h) => h.slice(0, 6)).join('→');
        return { kind: 'oscillation', pattern };
      }
    }

    return null;
  }

  /** 只读判据 A 的窗口内容，供 UI 展示「为什么判定为循环」 */
  argWindowSnapshot(): Array<{ toolName: string; hash: string; idempotent: boolean }> {
    return this.argWindow.map((r) => ({
      toolName: r.toolName,
      hash: r.hash.slice(0, 12),
      idempotent: r.idempotent,
    }));
  }

  fingerprintWindowSnapshot(): string[] {
    return this.fingerprintWindow.map((h) => h.slice(0, 8));
  }

  reset(): void {
    this.argWindow = [];
    this.fingerprintWindow = [];
  }
}