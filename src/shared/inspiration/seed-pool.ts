/**
 * 抽脑洞种子池（P2-C T4）。
 *
 * ★ 24 条**原创**方向标签：只是网文常见题材/流派的功能性归类词（重生复仇、
 *   系统流、无限流……），不含任何受版权保护的具体作品设定或文案——方向是
 *   「往哪类脑洞去想」的路标，不是抄来的故事。AGPL 红线同 prompts.ts。
 *
 * ★ 反重复铁律：drawDirection 是纯函数（history + rand 进，方向出），把近期
 *   已抽过的方向从候选池里滤掉，剩池里按 rand() 取一；剩池空（24 条全抽过）
 *   → 重置用全池，绝不卡死。idea-service 把 repo.ideaHistory() 的方向喂回来，
 *   连抽自然避开旧方向。rand 可注入（测试用定值），生产缺省 Math.random。
 */

/** 24 条原创方向标签（注册序即候选序；无重复，seed-pool.test.ts 钉死） */
export const SEED_DIRECTIONS: string[] = [
  '重生复仇',
  '系统流',
  '无限流',
  '末世求生',
  '洪荒封神',
  '都市异能',
  '悬疑推理',
  '科幻星际',
  '历史架空',
  '武侠仙侠',
  '游戏竞技',
  '灵异志怪',
  '穿越种田',
  '宫斗宅斗',
  '军事谍战',
  '体育竞技',
  '美食经营',
  '直播文娱',
  '刑侦探案',
  '修真长生',
  '机甲战争',
  '诡秘复苏',
  '乡土现实',
  '星际贸易',
];

/**
 * 从种子池抽一个方向，避开 history 里近期已抽过的方向。
 * @param history 已抽方向（新在前即可，顺序不影响去重）
 * @param rand    [0,1) 随机源；生产 Math.random，测试可注入定值
 * @returns 候选池里的一个方向；候选池空（全抽过）→ 重置全池再抽（不卡死）
 */
export function drawDirection(history: string[], rand: () => number): string {
  const drawn = new Set(history);
  let pool = SEED_DIRECTIONS.filter((d) => !drawn.has(d));
  if (pool.length === 0) pool = [...SEED_DIRECTIONS];
  const idx = Math.floor(rand() * pool.length);
  // rand() 理论上 <1，但注入源可能给到 1：夹到末位，绝不越界回 undefined。
  return pool[Math.min(idx, pool.length - 1)];
}