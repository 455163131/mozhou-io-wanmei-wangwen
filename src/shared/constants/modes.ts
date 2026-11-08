/**
 * 模式显示名的**唯一来源**（§UI ·终审 Important-3，2026-11-04 收口）。
 *
 * ★ 修复前它有三份手写副本，彼此靠注释约定同步（「加模式时两处一起改」）：
 *   1. `App.tsx` 的 `MODE_LABELS`（面包屑 + 左导航 NAV_GROUPS 的 label）；
 *   2. `CommandPalette.tsx` 的 `MODE_LABEL`（面板底栏「当前：」）；
 *   3. `CommandPalette.tsx` 的 `COMMANDS[].label`（`切换到 写作坊` 那六个字面量）。
 *   三副本的形状是本项目栽过最多次的那一类（第 30 条的 dash、第 20 条的类名、
 *   R35③ 的皮肤名）：改一处不改两处**不会有任何报错**，只会在界面上出现
 *   「导航叫 A、面包屑叫 B、面板叫 C」。本文件把三份收成一份，由
 *   `tests/integration/shell-r1-wiring.test.ts` A 组双向钉：
 *   清单↔分派的 id 集逐字相等，且**显示名只能来自这里**。
 *
 * 键集合同时是 `Mode` 类型的唯一真相（App.tsx 的 `type Mode` 取 `WorkMode`）。
 * 放在 shared 层而不是 renderer 层：命令面板与外壳分属两个目录，任何一侧
 * import 另一侧都会形成组件间的横向依赖（外壳 ↔ 面板本来是父子关系）。
 */

/** 十六种工作模式（id 与命令面板的 `mode:*` 命令、App 的 onRun 分派逐字同源；
 *  ★ P2-B T4：资产组的「伏笔台账」从 soon 占位转正为真 mode；
 *  ★ P2-B T6：资产组的「人物记忆」同样原地转正；
 *  ★ P2-C T3：灵感组的「扫榜热榜」同样原地转正；
 *  ★ P2-C T4：灵感组的「抽脑洞」同样原地转正；
 *  ★ P2-C T5：灵感组的「拆书报告」同样原地转正；
 *  ★ P2-C T6：灵感组的「选题库」同样原地转正——灵感线四页收口；
 *  ★ P2-D T5：输出组的「导出中心」同样原地转正；
 *  ★ P2-D T6：输出组**新增**「发布排期」真 mode——它没有过 soon 占位行，
 *     是 P2-UI T2 四组 IA 定稿里本就排定的发布线页，不是 soon 转正（SOON 钉不动）。
 *  ★ P2-E ①：灵感组**新增**「灵感池」真 mode——P2-C 遗留的卡片浏览收口页，
 *     消费既有 inspiration:list/remove 双通道（同样非 soon 转正，SOON 钉不动）。 */
export type WorkMode = 'write' | 'plan' | 'lore' | 'review' | 'dash' | 'gen' | 'prompt' | 'foreshadow' | 'characters' | 'trends' | 'idea' | 'teardown' | 'topics' | 'export' | 'publish' | 'pool';

/**
 * 显示名。四字档是展开态导航的宽度账（`--mz-layout-rail-expanded-w` 184px 里
 * 图标 + 标签 + 内边距的余额，见 App.module.css `.railLabel`），不许随手加长；
 * `生成·导演台` 与 `提示词与技能` 是仅有的两个六字例外——它们都是无「设计中」
 * chip 的真 mode 行，拿得到整行余量（R41 的 184px 档最坏余额 7.64px 按六字算过）。
 */
export const MODE_LABELS: Record<WorkMode, string> = {
  write: '写作坊',
  plan: '大纲管理',
  lore: '世界观设定',
  review: '审稿报告',
  dash: '统计账本',
  gen: '生成·导演台',
  prompt: '提示词与技能',
  // ★ P2-B T4：伏笔台账页（四字档，同 soon 时期的路标名，导航行原地转正）。
  foreshadow: '伏笔台账',
  // ★ P2-B T6：人物记忆页（四字档，同 soon 时期的路标名，导航行原地转正）。
  characters: '人物记忆',
  // ★ P2-C T3：扫榜热榜页（四字档，同 soon 时期的路标名，导航行原地转正）。
  trends: '扫榜热榜',
  // ★ P2-C T4：抽脑洞页（三字档，同 soon 时期的路标名，导航行原地转正）。
  idea: '抽脑洞',
  // ★ P2-C T5：拆书报告页（四字档，同 soon 时期的路标名，导航行原地转正）。
  teardown: '拆书报告',
  // ★ P2-C T6：选题库页（三字档，同 soon 时期的路标名，导航行原地转正）。
  topics: '选题库',
  // ★ P2-D T5：导出中心页（四字档，同 soon 时期的路标名，导航行原地转正）。
  export: '导出中心',
  // ★ P2-D T6：发布排期页（四字档，新增真 mode——非 soon 转正，路标名也是它）。
  publish: '发布排期',
  // ★ P2-E ①：灵感池页（三字档，新增真 mode——卡片浏览收口，非 soon 转正）。
  pool: '灵感池',
};

/**
 * 任意字符串 → 显示名。
 * 命令面板的 `mode` prop 是 `string`（它不认识 App 的 Mode 联合类型），
 * 认不出的一律原样回显——显示一个陌生的 id 好过显示 `undefined`。
 */
export function modeLabel(mode: string): string {
  return (MODE_LABELS as Record<string, string>)[mode] ?? mode;
}
