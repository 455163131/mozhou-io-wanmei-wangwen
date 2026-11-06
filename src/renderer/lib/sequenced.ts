/**
 * 请求序号守卫（P2-A 终审 I-1）：连续切换角色时旧请求后到会盖掉新表单，
 * 保存可把 A 角色文字写进 B 角色文件。规则只有一条——**用户动作赢**：
 * 每次发起 next()，await 回来后只有 isCurrent(seq) 才许落地状态。
 */
export interface Sequencer {
  next(): number;
  isCurrent(seq: number): boolean;
}

export function createSequencer(): Sequencer {
  let last = 0;
  return {
    next: () => ++last,
    // ★ seq 恒 >0 才算合法：0 是"未发起"哨兵，last 初值也是 0，
    //   若写成 seq === last 会让空 sequencer 的 isCurrent(0) 误判为最新。
    isCurrent: (seq: number) => seq > 0 && seq === last,
  };
}
