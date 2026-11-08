/**
 * llm:progress 推送 → 短产出路径等待状态（E批「模型思考过程可见」）。
 *
 * 老板报障：「只是按钮显示抽卡中，卡一晚上我也不知道他到底在干什么」。
 * 本 hook 订阅唯一推送出口发来的 LlmProgress（主进程服务层节流 ≤5 次/秒），
 * 按 scope 过滤（idea / teardown 两页各挂一份，互不串台），并叠加一条
 * **渲染层自己的 1s tick**——两次事件之间「已等待 N 秒」也必须在走，
 * 端点黑洞时（一个事件都收不到）用户看到的仍是如实递增的等待秒数。
 *
 * ★ 诚实纪律：
 *   - 没收到任何事件时 phase 停在 'start'（文案「连接模型」）——这是实况
 *     （invoke 已发出、在等模型接上），不是假进度；绝不捏造百分比或假思考；
 *   - thought 只是主进程转发来的**尾部片段**（provider 没回 reasoning_content
 *     则恒 null），展示时必须标「片段/非完整」，缺席时明示「该模型未返回思考内容」；
 *   - fallbackNote 在 busy 结束后**保留**——演示徽标旁要能一直看到回落真因，
 *     直到下一次重跑才清空。
 *
 * ★ 生命周期：active=false（或卸载 / scope 变化）即退订 + 清 tick，progress 归零；
 *   订阅走既有 onAgentEvent（window.mz.agent.on 泛型通道），不新造桥形状。
 */
import { useEffect, useState } from 'react';
import { onAgentEvent } from './use-mz-bridge';
import type { LlmProgress } from '@shared/types/provider';

/** 状态条要渲染的等待快照（全部字段来自真实观测，无推测值） */
export interface LlmProgressView {
  phase: LlmProgress['phase'];
  attempt: number;
  /** 已流回的字符数（思考 + 正文，收到多少数多少） */
  charsSeen: number;
  /** 思考尾部片段；provider 未返回 reasoning_content 时为 null（绝不编造） */
  thought: string | null;
  note: string | null;
  /** 渲染层自测的已等待秒数（1s tick，两次事件之间也在走） */
  waitedSec: number;
}

export function useLlmProgress(
  scope: LlmProgress['scope'],
  active: boolean,
): { progress: LlmProgressView | null; fallbackNote: string | null } {
  const [progress, setProgress] = useState<LlmProgressView | null>(null);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const t0 = Date.now();
    const waited = (): number => Math.floor((Date.now() - t0) / 1000);
    // 新一轮开始：清上一轮状态与回落真因（fallbackNote 到下一轮才清，busy 结束后仍可见）
    setFallbackNote(null);
    setProgress({ phase: 'start', attempt: 1, charsSeen: 0, thought: null, note: null, waitedSec: 0 });
    // 渲染层 1s tick：等待秒数不依赖主进程事件节奏
    const tick = setInterval(() => {
      setProgress((p) => (p ? { ...p, waitedSec: waited() } : p));
    }, 1000);
    const off = onAgentEvent('llm:progress', (p) => {
      if (p.scope !== scope) return;
      if (p.phase === 'fallback' && p.note) setFallbackNote(p.note);
      setProgress((prev) => ({
        phase: p.phase,
        attempt: p.attempt,
        charsSeen: p.charsSeen,
        // thought 只前进不回退：后续增量事件可能不带 thought（节流窗口内的
        // 尾片段仍在主进程累积），保留已见的最新片段
        thought: p.thought ?? prev?.thought ?? null,
        note: p.note ?? prev?.note ?? null,
        waitedSec: waited(),
      }));
    });
    return () => {
      off();
      clearInterval(tick);
    };
  }, [scope, active]);

  return { progress, fallbackNote };
}
