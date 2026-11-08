/**
 * 短产出路径等待状态条（E批「模型思考过程可见」）。
 *
 * 抽脑洞 / 拆书精读 busy 期间如实展示：已等待秒数（渲染层 tick）/ 当前阶段 /
 * 已接收字数 / 思考尾部片段 / 回落真因。数据全部来自主进程真实观测
 * （LlmProgress），本组件零加工、零推测：
 *   - 阶段文案照 phase 直译，没收到事件就是「连接模型」，不编百分比；
 *   - thought 缺席（provider 未返回 reasoning_content）时明示
 *     「该模型未返回思考内容」，绝不伪造思考；
 *   - thought 在场时标注「尾部片段（非完整思考）」——它本来就不是全文；
 *   - fallback 时把 note 里的真因原样展示。
 * 无按钮（不进 SOLID_BUTTON_CENSUS）；样式全走 --mz- 令牌。
 */
import type { LlmProgressView } from '../../hooks/use-llm-progress';
import styles from './LlmProgressStrip.module.css';

const PHASE_TEXT: Record<LlmProgressView['phase'], string> = {
  start: '连接模型',
  thinking: '模型思考中',
  writing: '正在产出',
  retry: '重试中',
  done: '产出完成',
  error: '出错',
  fallback: '已回落演示数据',
};

export function LlmProgressStrip({ progress }: { progress: LlmProgressView }): JSX.Element {
  const { phase, charsSeen, thought, note, waitedSec } = progress;
  // 思考行只在真有动静后展示：一个字都没收到时说「未返回思考内容」是抢答
  const received = charsSeen > 0 || phase === 'done' || phase === 'fallback';
  return (
    <div className={styles.strip}>
      <div className={styles.row}>
        <span className={styles.metric}>已等待 {waitedSec} 秒</span>
        <span className={styles.phase}>{PHASE_TEXT[phase]}</span>
        <span className={styles.metric}>已接收 {charsSeen} 字</span>
      </div>
      {received && (
        <p className={styles.thought}>
          {thought
            ? `思考片段（尾部 ${thought.length} 字，非完整思考）：${thought}`
            : '该模型未返回思考内容'}
        </p>
      )}
      {phase === 'fallback' && note && <p className={styles.note}>回落真因：{note}</p>}
    </div>
  );
}
