# 专家团功能设计（小说写作方向）

> 在墨舟写作 Agent 中集成「专家团」——一组以不同写作视角审视同一段文本，产出结构化评审意见，冲突时按显式规则裁决。
> 范围**只聚焦小说写作**，不扩展到其他领域。

---

## 一、专家团构成

### 1.1 为什么需要「团」而不是单个评审

单视角评审有个结构性缺陷：它只能看见自己关心的问题。人物塑造的评委会漏掉节奏，节奏评委会漏掉对白白描。

专家团的价值不在「多找问题」，而在**让冲突暴露出来**——同一个问题，不同视角的判断常常相反，而这个矛盾恰恰是最有价值的信息。

### 1.2 六个角色（只覆盖小说写作）

| 角色 | key | 职责边界 | 明确**不**负责 |
|---|---|---|---|
| **结构师** | `structure` | 情节结构、大纲完整性、节奏分布、卷幕张力、场景衔接 | 不管字句、不管人物性格合理性 |
| **人物塑造师** | `character` | 人物动机一致性、性格前后统一、人物弧光、关系网合理性 | 不管句式、不管节奏 |
| **对白作家** | `dialogue` | 对白是否承担潜台词、是否千人一面、是否沦为信息搬运 | 不管情节结构、不管描写 |
| **文字 editors** | `prose` | 病句、冗余、AI 腔、描写堆砌、感官失真 | 不管结构、不管人物 |
| **读者代表** | `reader` | 弃书风险点、爽点分布、节奏体感、代入感 | 只提读者直觉，不做技术判断 |
| **类型守门人** | `genre` | 类型惯例符合度（金手指/系统流/言情/悬疑等各自的读者预期） | 不管文笔、不管结构 |

**为什么是这六个**：它们覆盖了网文写作的全部主要修改方向，且视角之间**存在真实的意见冲突可能**（不是硬凑）。例如「读者代表」会觉得「节奏慢但氛围好」，而「结构师」会说「节奏就是慢」——这种分歧需要裁决机制处理。

### 1.3 职责边界用数据表达，不是靠 prompt 约束

每个角色的边界由 `focus`（关注维度）和 `ignore`（明确不看的维度）两个字段**在代码里声明**：

```ts
{
  key: 'character',
  focus: ['motivation', 'personality-consistency', 'character-arc', 'relationship'],
  ignore: ['syntax', 'pacing', 'word-choice'],
}
```

裁决阶段会用它做两件事：
1. **越界意见降权**——角色提了 `ignore` 里的维度，该意见在汇总时权重打折
2. **冲突判定**——只有同一维度上、且双方都不 ignore 的意见，才算真冲突

---

## 二、协作方式

### 2.1 两阶段：独立评审 → 汇总裁决

**不采用「专家之间对话」的形式**。理由：多轮互相讨论会放大 token 成本，且容易让后发言的专家被前一个带偏（锚定效应），导致意见趋同——恰好失去「暴露冲突」的价值。

```
阶段一：独立评审（并行）
  每位被激活的专家独立看同一份文本，各自产出
  ExpertOpinion[] { role, dimension, severity, verdict, evidence, suggestion }
  ★ 各专家看不到彼此的结论 → 避免趋同

阶段二：汇总裁决（串行，一次判定）
  1. 分组：按 dimension 聚合同维度意见
  2. 越界降权：意见的 dimension ∈ 该角色.ignore → 权重 × 0.3
  3. 冲突检测：同 dimension 上 severity 差异 ≥ 2 级 → 标记为冲突
  4. 裁决：对每个冲突维度按 §3.2 规则裁决
  5. 输出评审报告
```

### 2.2 专家只在被需要时加载

**关键性能设计**：专家评审走的是 **LLM 调用**，成本敏感。

- 默认**关闭**（配置项 `enabled: false`）
- 启用后也不是每次 Agent 循环都调，而是**按触发时机**（见 §5）
- 每次评审**只激活相关角色**（如「润色前评审」只激活 `prose` + `reader`；「大纲评审」只激活 `structure` + `genre`），其余角色不加载
- 角色定义是**静态数据**（不占运行时），只有被激活时才构造 prompt 并发起 LLM 调用

**不影响原流程性能的具体保证**：
1. 专家评审是**独立工具**，不在 Agent 主循环的必经路径上——Agent 循环的 `tools` 列表按需注入
2. 每次评审有独立预算（`maxTokens`/`maxCostCny`），**不与 Agent 循环共享预算池**——专家评审超支不会把 Agent 循环带停
3. 评审结果落库，**同一章节同一阶段不重复评审**（除非用户显式要求重审）

---

## 三、意见汇总与冲突裁决

### 3.1 汇总规则

所有意见按 `dimension`（修改维度）聚合，每维度产出一条结论：

```
维度结论 {
  dimension: 'pacing'
  意见列表: ExpertOpinion[]      // 谁说的
  裁决: 'accept' | 'reject' | 'defer'
  最终建议: string
  置信度: 0~1
  冲突: { 是否冲突, 分歧描述, 裁决依据 }
}
```

**严重度（severity）四级**：`critical`（必须改）/ `major`（该改）/ `minor`（可改）/ `nit`（风格偏好）

**去重规则**：同一 dimension 下措辞相近的意见合并，保留最严的 severity + 合并证据。

### 3.2 冲突裁决规则（按序执行，先命中先生效）

| 优先级 | 规则 | 说明 |
|---|---|---|
| 1 | **硬约束优先** | 若一方的 `verdict: 'block'` 且另一方不是，采纳 `block`。理由：阻断类意见（如人物设定自相矛盾）不应被「风格偏好」覆盖 |
| 2 | **严重度优先** | 严重度差 ≥ 2 级时，采纳更严的一方 |
| 3 | **角色权重** | 同严重度时按角色权重（`weight` 字段）裁决 |
| 4 | **类型惯例优先** | 涉及类型惯例的维度（`genre` 角色的 `ignore` 不含该维度时），采纳 `genre` 专家意见 |
| 5 | **弃权** | 以上都无法裁决 → `defer`，**明确交给作者判断**，不硬凑结论 |

**关键设计：`defer` 是一等公民**。专家团不应该假装总能给出答案。当出现真冲突时，输出「角色 A 认为 X，角色 B 认为 Y，作者决定」比输出一个勉强的结论有价值得多。

**权重配置**（可被用户覆盖）：
```
structure: 1.0  character: 1.0  dialogue: 0.9
prose: 0.9      reader: 0.8    genre: 1.0
```
`reader` 权重最低不是因为它不重要，而是因为它**不做技术判断**——它的意见是「体感」，与「诊断」不同量纲，在维度冲突时应让位于可验证的判断。

### 3.3 输出呈现

**给用户看的东西（渲染层）**：

```
┌─ 专家团评审 · 第 37 章 ─────────────────────┐
│ 激活角色：结构师 · 文字 editors · 读者代表 3/6  │
├─────────────────────────────────────────────┤
│ ▲ critical  节奏  结构师 vs 读者代表 [冲突]  │
│   结构师：本章三幕无转折，高潮缺席            │
│   读者代表：读得下去，悬念在第 2 段就建立了   │
│   → 裁决：defer（请作者判断）[作者决定]     │
│                                              │
│ ▲ major    对白  对白作家                     │
│   「她说」出现 7 次，缺潜台词                │
│   → 建议：改写为动作承载信息                  │
│                                              │
│ ▲ minor    描写  文字 editors                 │
│   第 3 段「月光洒在窗台上」与第 5 段重复      │
│   → 建议：保留其一                            │
├─────────────────────────────────────────────┤
│ 汇总：critical 1（待裁决）· major 2 · minor 3│
│ 下一步：[采纳全部建议] [仅采纳无冲突项] [忽略]│
└─────────────────────────────────────────────┘
```

**设计要点**：
- **冲突要显眼**，不能埋在列表里——冲突信息是最有价值的
- **「裁决依据」必须写出来**，不能让用户面对一个没有理由的结论
- `defer` 项要有明确的「请作者判断」入口
- 越界意见（触发了 `ignore` 降权）在 UI 上**标记出来**，让用户知道这条被打了折

**给模型看的东西（进入 Agent 循环）**：
```json
{
  "expertReport": {
    "chapterId": "37",
    "verdicts": [
      { "dimension": "pacing", "decision": "defer", "suggestion": "...", "conflict": true }
    ],
    "summary": { "critical": 1, "major": 2, "minor": 3 }
  }
}
```
**只喂裁决结果，不喂原始分歧**——避免模型被「有争议」的信号带偏去做和稀泥的事。

---

## 四、与现有写作流程的衔接

### 4.1 三个接入点（对应大纲 / 章节生成 / 润色）

| 流程节点 | 专家团角色 | 调用时机 | 产出 |
|---|---|---|---|
| **大纲评审** | `structure` + `genre` | 大纲生成后、正式写正文**之前** | 大纲漏洞清单（结构 + 类型惯例） |
| **章节评审** | 全部 6 个（可配置） | 章节写完、润色**之前** | 完整评审报告 |
| **润色后复检** | `prose` + `reader` | 润色执行**之后** | 判断润色是否真的改善（对照润色前） |

### 4.2 衔接方式：独立工具，不进主循环

专家团**不是一个必须跑的主循环步骤**，而是暴露给 Agent 的可选工具：

```
用户：「按这个大纲写第 38 章」
  ↓
Agent 循环（原有 16 个工具 + 1 个新工具 consult_expert_team）
  ↓
Agent 自主决定何时调用：
  · 写完草稿后 → consult_expert_team('review', chapterIds) → 拿到评审 → 决定是否修
  · 或者用户手动在 UI 面板触发
  · 或者完全不用（配置关闭时 Agent 看不到这个工具）
```

**为什么这样设计**：
- **不侵入**——Agent 循环、工具注册、checkpoint 体系都不用改逻辑，只多一个工具条目
- **可开关**——关闭时工具不注册，Agent 根本看不到，**原流程性能零影响**
- **Agent 有自主权**——它可以基于评审结果自己决定要不要修（这正是 Agent 与固定流程的差别）

### 4.3 「润色后复检」的对照设计

润色是最容易「越改越差」的场景（经典规则引擎会全量应用所有规则）。所以：

```
润色前评审（prose + reader） → 记录 baseline
  ↓
执行润色（现有 fix 工具链，带 checkpoint）
  ↓
润色后复检（同角色，同维度）→ 对照 baseline
  ↓
输出：哪些改善了 / 哪些反而变差了 → 触发局部回滚建议
```

这个对照能力**天然契合现有的副作用检测机制**（`side-effect.ts`），专家团复检结果可以作为副作用判定的输入之一。

---

## 五、数据与状态持久化

### 5.1 落库设计（新增 migration v5）

```sql
-- 专家团调用记录（每次评审一条）
CREATE TABLE expert_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  stage TEXT NOT NULL,            -- 'outline' | 'chapter' | 'post-polish'
  target_ids TEXT NOT NULL,       -- JSON 数组：章节 id
  roles TEXT NOT NULL,            -- JSON 数组：激活的角色
  verdicts TEXT NOT NULL,         -- JSON：裁决结果
  summary TEXT NOT NULL,          -- JSON：汇总统计
  provider_id TEXT,               -- 用哪个模型调的
  model TEXT,
  tokens_in INTEGER, tokens_out INTEGER,
  cost_cny REAL,                  -- 本地模型为 0
  duration_ms INTEGER,
  status TEXT NOT NULL,           -- 'ok' | 'partial' | 'failed' | 'aborted'
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_expert_reviews_project ON expert_reviews(project_id, created_at DESC);

-- 单条专家意见（便于后续统计「哪个专家最常提出哪类问题」）
CREATE TABLE expert_opinions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES expert_reviews(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  dimension TEXT NOT NULL,
  severity TEXT NOT NULL,
  verdict TEXT NOT NULL,          -- 该专家对该维度的判断
  weight REAL NOT NULL,           -- 当时的角色权重（历史留痕）
  cross_boundary INTEGER NOT NULL,-- 1 = 越界（触发了 ignore 降权）
  evidence TEXT,
  suggestion TEXT,
  raw TEXT                        -- 模型原始返回，便于回溯
);
CREATE INDEX idx_expert_opinions_review ON expert_opinions(review_id);
CREATE INDEX idx_expert_opinions_dim ON expert_opinions(dimension, severity);
```

**为什么拆两张表**：意见单独存表后，可以回答「结构师提出的 critical 里有多少最终被采纳」这类问题，为后续权重自动调优提供数据基础。

### 5.2 配置持久化

专家团配置存在项目级配置里（不硬编码）：

```ts
interface ExpertTeamConfig {
  enabled: boolean;                // 总开关，默认 false
  defaultRoles: ExpertRoleKey[];   // 章节评审默认激活的角色
  roleWeights: Record<ExpertRoleKey, number>;
  deactivateThreshold: number;     // 去重相似度阈值
  maxRounds: number;               // 预留：多轮辩论（当前不做）
  budget: {                        // 独立预算，不与 Agent 循环共享
    maxTokens: number;
    maxCostCny: number;
    timeoutMs: number;
  };
  providerId?: string;             // 可为专家团单独指定模型
}
```

### 5.3 「按需加载」的实现

```ts
// 只有这个函数知道全部 6 个角色的定义
const ALL_ROLES: Record<ExpertRoleKey, RoleDefinition> = { ... };

// 注册进工具时，只暴露一个工具
registry.register('consult_expert_team', consultExpertTeam);

// 运行时才按需取用
function activateRoles(keys) {
  return keys.map(k => ALL_ROLES[k]).filter(Boolean);  // 未激活的角色不构造 prompt、不发 LLM 请求
}
```

角色定义是纯静态数据，**不占运行时开销**；只有 `LLM 调用`这一环随激活角色数线性增长。

---

## 六、分阶段实施

| 阶段 | 内容 | 可交付物 | 状态 |
|---|---|---|---|
| **一** | 类型定义 + 角色注册表 + 汇总裁决纯逻辑 + 单元测试 | 裁决引擎可测、无需 LLM 即可验证冲突处理 | ✅ 本次实现 |
| 二 | LLM 评审执行 + 并发控制 + 降级 | 能真实跑出评审 | 待做 |
| 三 | 工具接入 + IPC 通道 + 落库 | Agent 可自主调用 | 待做 |
| 四 | 渲染层专家团面板 + 冲突裁决 UI | 用户可见 | 待做 |
| 五 | 润色后对照复检 + 副作用判定联动 | 闭环 | 待做 |

**阶段一为什么先做裁决引擎**：冲突裁决是整个功能的**核心价值**，也是唯一可以不依赖 LLM 就验证正确性的部分。先把它测扎实，后面接 LLM 时才知道问题出在模型还是裁决逻辑。

---

## 七、不做什么（范围边界）

- **不做多轮辩论**：`maxRounds` 字段预留了，但不做专家互相讨论——成本高且会导致意见趋同
- **不做其他领域专家**：不扩展到技术、财经、法律等
- **不做专家自动改稿**：专家只出意见，改不改由 Agent 或作者决定（保持与现有 `writePolicy` 机制一致）
- **不做跨项目专家库**：角色定义随项目配置，不做全局注册中心
