/**
 * 短产出路径的进度播报器（E批「模型思考过程可见」）。
 *
 * 老板报障：「只是按钮显示抽卡中，卡一晚上我也不知道他到底在干什么」。
 * drawIdea / teardownRead 各自把 LlmClient 的流式增量（onDelta）喂进本播报器，
 * 播报器整形成 LlmProgress 事件交给服务层注入的 onProgress（生产装配走
 * push.send('llm:progress')，唯一推送出口）。
 *
 * ★ 诚实纪律（与 LlmProgress 类型注同源）：
 *   - elapsedMs 用 Date.now() 实测，不估不猜；
 *   - charsSeen 是真实收到的字符数（思考 + 正文），收到多少数多少；
 *   - thought 只带**尾部片段**（THOUGHT_TAIL_CAP 字），推送载荷限长，
 *     且渲染层必须标「片段」——它不是完整思考；
 *   - provider 没回 reasoning_content 时 thought 恒缺席，绝不编造；
 *   - fallback 的 note 携带真因（异常原文），不许换成写死空话。
 *
 * ★ 节流：SSE 增量可能每秒几十片，逐片转发会灌爆 IPC。这里按
 *   EMIT_MIN_INTERVAL_MS（200ms ⇒ ≤5 次/秒）收敛，但三种情况**必发**：
 *   首片（用户第一时间知道「有动静了」）、阶段切换（thinking↔writing）、
 *   终态（done/fallback，携带最终计数，节流不吞尾账）。
 */
import type { LlmProgress } from '@shared/types/provider';

/** thought 尾部片段限长（推送载荷纪律：不许把整段思考灌进 IPC） */
export const THOUGHT_TAIL_CAP = 200;

/** 增量事件的最小发射间隔（≈5 次/秒上限；终态事件不受此限） */
export const EMIT_MIN_INTERVAL_MS = 200;

export interface LlmProgressEmitter {
  /** 发起调用：attempt 1、elapsedMs 0 */
  start(): void;
  /** 流式增量（LlmClient onDelta 原样喂入） */
  onDelta(d: { content?: string; reasoning?: string }): void;
  /**
   * ★ 裁决修复波 H2：客户端告知「即将发起第 n 次尝试」。清零计数再播报——
   *   被 abort 的那一次收到的字符**不许**算进下一次（旧口径是跨尝试累加，
   *   「已接收 8200 字」里 8000 字其实没收到过）。
   */
  retry(n: number): void;
  /** live 产出完成（携最终计数与思考尾片段） */
  done(): void;
  /** 如实回落演示数据：note 必须是真因 */
  fallback(cause: string): void;
}

/** 异常 → 可披露的真因文本（fallback note 用；不吞原文、不加工成空话） */
export function progressCause(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createLlmProgressEmitter(
  scope: LlmProgress['scope'],
  onProgress: ((p: LlmProgress) => void) | undefined,
): LlmProgressEmitter {
  let t0 = 0;
  let charsSeen = 0;
  let thoughtBuf = '';
  let lastPhase: LlmProgress['phase'] | null = null;
  let lastEmitAt = 0;
  // ★ H2：真实尝试号——由 retry() 推进，没重试就恒 1（不编造也不谎报）
  let attemptNow = 1;

  const snapshot = (phase: LlmProgress['phase'], note?: string): LlmProgress => ({
    scope,
    phase,
    attempt: attemptNow,
    elapsedMs: t0 ? Date.now() - t0 : 0,
    charsSeen,
    ...(thoughtBuf ? { thought: thoughtBuf.slice(-THOUGHT_TAIL_CAP) } : {}),
    ...(note != null ? { note } : {}),
  });

  const emit = (p: LlmProgress): void => {
    onProgress?.(p);
    lastPhase = p.phase;
    lastEmitAt = Date.now();
  };

  return {
    start(): void {
      t0 = Date.now();
      charsSeen = 0;
      thoughtBuf = '';
      lastPhase = null;
      emit(snapshot('start'));
    },
    onDelta(d): void {
      if (!t0) return; // 没 start 过的增量不播（防御：不报无起点的等待）
      const phase: LlmProgress['phase'] = d.reasoning ? 'thinking' : 'writing';
      if (d.reasoning) {
        charsSeen += d.reasoning.length;
        thoughtBuf += d.reasoning;
      }
      if (d.content) charsSeen += d.content.length;
      // 必发三种：首片 / 阶段切换 / 到节流窗口；其余吞掉（终态自带最终计数）
      const now = Date.now();
      const isFirst = lastPhase === 'start';
      const phaseChanged = lastPhase !== phase;
      if (isFirst || phaseChanged || now - lastEmitAt >= EMIT_MIN_INTERVAL_MS) {
        emit(snapshot(phase));
      }
    },
    retry(n): void {
      // 清零是这条修复的全部要点：下一次尝试的字数与思考只属于下一次
      charsSeen = 0;
      thoughtBuf = '';
      attemptNow = n;
      lastEmitAt = 0; // 新尝试的第一片必发，不受上一轮的节流窗口压制
      emit(snapshot('retry', `第 ${n} 次尝试`));
    },
    done(): void {
      emit(snapshot('done'));
    },
    fallback(cause): void {
      emit(snapshot('fallback', cause));
    },
  };
}
