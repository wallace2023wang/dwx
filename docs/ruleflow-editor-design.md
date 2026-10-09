# 规则集编辑器（RuleFlow Editor v2）需求与设计

> 产品：DWX（复刻 传统商业规则平台 Rule Team Server）
> 版本：v2.1
> 日期：2026-09-30
> 状态：开发基线
> 交互参考：
>
> `docs/design-rts/ruleflow-editor-prototype.html`
>
> （仅作为画布体验和视觉参考）
> 关联文档：
>
> `platform-issues-and-fixes.md`
>
> 、
>
> `technical-design.md`
>
> 、
>
> `product-requirements.md`

***

## 1. 目标与边界

### 1.1 本次调整解决什么问题

当前规则集画布只能查看，实际编辑依赖下方 “公共步骤 / 排他分支” 表单。规则较多时还必须逐条选择资产，无法满足真实 Rule Team Server 项目的编排效率。

本次改造有两个核心目标：

1. 参考 Dify Workflow，把画布升级为规则集的主要编辑界面，支持拖拽、连接、选中和右侧属性抽屉。

2. 增加 Rule Group（规则组）步骤。用户可直接把现有 Rule Package 拖入画布，以一个节点执行包内的一组已发布规则资产。

### 1.2 核心领域定义

* **Rule Package**：项目现有的规则包，负责组织规则和决策表，继续沿用既有包 CRUD、审批和资产生命周期。

* **Rule Group**：规则集内部的一种步骤节点，不是一等资产，没有独立 CRUD、版本、Change Set 或发布流程。

* **Rule Group selector**：节点对 Rule Package 的引用，可选择是否包含子包。

* **Rule Group snapshot**：规则集发布时解析 selector，冻结具体成员资产版本、BOM 和生成后的 DRL。

Rule Group 的作用是批量选择规则，不取代 Rule Package，也不引入新的 `/rulesets` 资源。

### 1.3 本期明确不做

* 任意 DAG、多级网关、并行网关、聚合节点、循环和子流程。

* RuleSet/Rule Group 独立资产管理。

* 运行时动态读取包内最新规则。

* 通用输出归并策略。仍保持确定性的 “后写覆盖” 语义，并提供可见警告。

* BPMN 人工任务、定时器、补偿和长事务。

***

## 2. 现状与兼容要求

### 2.1 当前实现

| 项目 | 当前实现                           |
| -- | ------------------------------ |
| 画布 | React Flow 只读，节点不可拖拽、不可选择、不可连接 |
| 编辑 | 通过公共步骤和排他分支表单编辑                |
| 步骤 | `type` 当前支持 `rule`、`table`，每步绑定单个已发布资产 |
| 拓扑 | 公共步骤 + 单个排他网关 + 最多 8 个分支       |
| 映射 | 每个步骤支持 input/output mappings   |
| 发布 | 规则集版本冻结步骤资产版本、DRL、BOM、分支条件和映射  |
| 调试 | 支持运行到指定节点、路径断言、失败节点和轨迹         |

### 2.2 不得破坏的行为

* 现有 `rule` 和 `table` 步骤必须可以无损打开、编辑、保存、编译和发布。

* 保留最多 20 个步骤、8 个分支、最多一个默认分支的约束。

* 保留条件分支按显示顺序判断、首条匹配生效的语义。

* 保留 Release 不可变、历史版本可重放和 RES 不读取设计态存储的边界。

* 保留 revision 乐观锁、审核锁、Change Set、测试套件和 Release 质量门禁。

* 旧规则集没有 `nodeId` 和布局信息时必须自动兼容，不能要求人工迁移。

***

## 3. Rule Group 规则组步骤

### 3.1 草稿模型

```ts
type FlowStepType = 'rule' | 'table' | 'rule-group'

interface FlowStepDraft {
  // 画布节点稳定标识。同一资产被引用多次时仍必须不同。
  nodeId: string
  type: FlowStepType
  // rule/table 使用
  id?: string
  // rule-group 使用
  selector?: {
    packageName: string
    includeChildren: boolean
  }
  inputMappings?: FlowMapping[]
  outputMappings?: FlowMapping[]
}

interface FlowEditorMetadata {
  positions: Record<string, { x: number; y: number }>
  viewport?: { x: number; y: number; zoom: number }
}

interface FlowDraft {
  name: string
  description: string
  category?: string
  priority?: number
  steps: FlowStepDraft[]
  branches?: FlowBranchDraft[]
  editor?: FlowEditorMetadata
}
```

约束：

* `rule/table` 必须设置 `id`，不能设置 `selector`。

* `rule-group` 必须设置 `selector`，不能设置资产 `id`。

* `nodeId` 在节点移动、改资产、改包和步骤排序时保持不变。

* `editor` 只用于恢复画布位置，不参与规则执行。

### 3.2 包选择范围

Rule Group 默认只选择 `packageName` 对应包中的资产，创建节点时必须写入 `includeChildren=false`。用户显式开启后，`includeChildren=true`，同时选择所有 `packageName.*` 子包。

第一版解析以下资产：

* 已发布 BAL 规则。

* 已发布决策表。

* 不包含草稿、已归档资产和规则集。

节点抽屉必须同时显示：

* 已发布规则数量。

* 已发布决策表数量。

* 因未发布而排除的资产数量。

* 实际成员名称、类型和最新已发布版本。

包内没有任何已发布可执行资产时允许保存草稿，但编译和发布必须失败，并返回明确错误。

### 3.3 编辑期动态预览与发布冻结

编辑器可以实时解析当前包成员，用于成员预览、输出字段分析和 Drools 校验；生产执行绝不能动态读取包内容。

规则集发布时，每个 Rule Group 冻结为：

```ts
interface FrozenRuleGroupStep {
  nodeId: string
  type: 'rule-group'
  packageName: string
  includeChildren: boolean
  members: Array<{
    type: 'rule' | 'table'
    id: string
    name: string
    version: number
    bomVersion: number
  }>
  memberFingerprint: string
  drl: string
  inputMappings?: FlowMapping[]
  outputMappings?: FlowMapping[]
}
```

`memberFingerprint` 对按稳定顺序排列的 `type/id/version` 计算 SHA-256。以下变化会让已发布规则集返回 `needsRepublish=true`：

* 包内新增或移除已发布资产。

* 资产发布新版本、归档或移动到其他包。

* selector 覆盖范围内的子包发生上述变化。

* Rule Group 使用的 BOM 版本与当前项目 BOM 不一致。

已经发布的规则集版本和 Release 继续使用原冻结成员，不受这些变化影响。

### 3.4 DRL 生成与执行语义

Rule Group 在一个步骤内形成一个组合 DRL，并由一个 KieSession 执行：

1. 读取成员资产的最新已发布结构化版本。

2. BAL 规则直接加入待生成规则列表。

3. 决策表通过 `tableRules()` 展开，保留各自的 hit policy、salience 和表级互斥标识。

4. 对执行规则名增加稳定资产标识，避免不同资产重名。

5. 使用一次 `generateDrl(executableRules, frozenBom)` 生成 declare 和全部规则。

Rule Group 本身不得添加 `activation-group`。`activation-group` 会取消同组其他 activation，不符合包内所有匹配规则可执行的语义。只有决策表的 FIRST 等既有命中策略可以继续生成自己的互斥组。

成员生成顺序必须稳定；相同输入、成员版本和 BOM 必须生成相同 DRL 与 fingerprint。执行先后仍由规则 salience/priority 和决策表命中策略决定。

### 3.5 重复执行和输出覆盖

编译前按每条可执行路径分析实际成员：

* 同一资产被两个 Rule Group 同时包含。

* 资产既被 Rule Group 包含，又作为独立 rule/table 节点出现。

* 两个节点可能写同一 BOM output 字段。

同一路径重复执行同一资产属于 `error`，阻止编译和发布。不同排他分支上的重复资产不冲突，因为单次请求只执行一条分支。

多个不同资产写同一输出字段属于 `warning`，保持后写覆盖语义；编辑器以折叠横幅和节点抽屉显示写者链。

### 3.6 包重命名和删除

当前包名同时承担包标识，因此包操作必须维护 Rule Group 引用：

* 重命名包时，同事务更新引用该包或其子包的规则集草稿 selector，并推进规则集 revision。

* 已发布规则集快照保持不变，并标记依赖已变化。

* 审核中的规则集引用该包时，包重命名必须被审核锁阻止。

* 删除包时，如果规则集草稿仍引用该包，必须拒绝删除，或要求调用方显式提供替代包。

***

## 4. 画布编辑模型

### 4.1 布局

```
┌────────────────────────────────────────────────────────────┐

│ 编辑器头：名称 · 修订 · 已发布版本 · 依赖/校验状态 · 操作 │

├───────────────┬──────────────────────────┬─────────────────┤

│ 节点面板       │ 规则集画布               │ 节点配置抽屉    │

│ 规则包/决策表  │ 拖拽、连接、缩放、小地图 │ 映射/条件/预览  │

└───────────────┴──────────────────────────┴─────────────────┘
```

项目左侧导航继续由现有 AppShell 提供，不在规则集编辑器内部重复创建。

响应式要求：

* 宽屏同时显示节点面板、画布和配置抽屉。

* 中等宽度允许折叠节点面板；配置抽屉覆盖在画布右侧。

* 窄屏只保证查看和基础属性编辑，不承诺触摸端复杂连线操作。

### 4.2 节点面板

节点面板包含：

1. **规则包**：显示包中文名、技术名、规则数和决策表数；可搜索并拖入画布。

2. **决策表**：允许把单个已发布决策表作为独立节点拖入。

3. **高级兼容**：允许搜索并添加单条已发布规则，用于维护现有流程和少量特殊步骤。

4. **流程控制**：只提供排他网关。开始和结束是系统节点，不从面板重复拖入。

拖入规则包时创建 `rule-group`；拖入单个规则或决策表时创建现有步骤类型。

### 4.3 节点类型

| 节点         | 视觉               | 可编辑内容              |
| ---------- | ---------------- | ------------------ |
| 开始         | 绿色圆形             | 系统节点，不可删除，只能拖动位置   |
| 结束         | 红色圆形             | 系统节点，不可删除，只能拖动位置   |
| Rule Group | 品牌蓝矩形、Layers 图标  | 包选择、包含子包、成员预览、映射   |
| 决策表        | 紫色矩形、Table 图标    | 资产选择、只读摘要、映射、打开编辑器 |
| 单条规则       | 蓝灰矩形、FileText 图标 | 资产选择、只读摘要、映射、打开编辑器 |
| 排他网关       | 琥珀色菱形            | 名称、条件分支和默认分支       |

实现使用现有 Lucide 图标，不使用 emoji 或手绘 SVG。

### 4.4 直接编辑交互

| 能力      | 规格                                                              |
| ------- | --------------------------------------------------------------- |
| 节点拖拽    | 开启 `nodesDraggable`，结束时写入 `draft.editor.positions`              |
| 节点选中    | 开启 `elementsSelectable`，选中态使用 `brand.primary` 2px outline       |
| 连线      | 开启 `nodesConnectable`，通过 `isValidConnection` 和自定义 Handle 拒绝非法连接 |
| 线型      | 90 度正交折线、灰色 `#525252` 1.4px、灰色箭头                                |
| 分支标签    | 条件分支显示条件摘要，默认分支显示 “默认”；颜色只用于标签，不改变连线颜色                          |
| 属性编辑    | 点击节点打开右侧抽屉；修改直接进入本地 draft，不单独保存共享资产                             |
| 删除      | Delete/Backspace 或抽屉删除；开始 / 结束不可删除                              |
| 缩放      | 0.5-1.5；初次打开 `fitView`，之后优先恢复保存的 viewport                       |
| 小地图     | 150x96，按节点类型着色，必须加载 React Flow 默认样式                             |
| 自动布局    | 基于受限拓扑按执行顺序布局，不改变步骤或分支业务顺序                                      |
| 撤销 / 重做 | 本地 draft + editor 快照，最多 30 步；支持 Cmd/Ctrl+Z 和 Cmd/Ctrl+Shift+Z   |

正交边使用 React Flow 的自定义 edge 或 `getSmoothStepPath` 且圆角为 0，不新增布局依赖。

### 4.5 拓扑边界

画布是现有执行模型的可视化直编层，不允许任意 DAG。

合法结构：

```
开始 -> 公共步骤 0..N -> 可选排他网关 -> 分支步骤 1..N -> 结束
```

规则：

* 开始节点无入边且只有一条出边。

* 结束节点无出边，可接收各分支最终节点。

* 普通任务节点最多一条入边和一条出边。

* 整个流程最多一个排他网关。

* 网关允许最多 8 条出边，其中最多一条默认分支。

* 条件分支至少一条；每个分支至少一个步骤。

* 禁止回边、跨分支连接、网关到网关、分支重新汇入公共步骤。

* 连接和删除操作必须立即转换为 `steps[] + branches[]`，失败时不修改 draft。

### 4.6 多分支显示

不能把现有多分支规则集降级为固定 “是 / 否” 二分结构。网关出边显示：

* 条件分支：`温度 > 30`、`风险等级 = 高` 等条件摘要。

* 默认分支：`默认`。

分支纵向顺序就是判断优先级。拖动节点只改变位置；调整分支优先级必须通过抽屉中的排序控件完成，避免视觉位置意外改变业务语义。

### 4.7 旧数据迁移

旧步骤首次加载时使用以下地址生成临时 nodeId：

* 公共步骤：`common:{index}`。

* 分支步骤：`branch:{branchId}:{index}`。

首次保存时为没有持久化 nodeId 的步骤生成 UUID。已存在 nodeId 后，排序和移动不得重建。

运行轨迹优先返回稳定 nodeId，同时在过渡期保留旧地址作为 `legacyNodeId`，避免已有调试和测试接口立即失效。

***

## 5. 节点配置抽屉

### 5.1 Rule Group

* 规则包选择。

* “包含子包” 复选框，默认关闭。

* 成员统计和可搜索成员预览。

* 被排除的草稿 / 归档资产提示。

* 输入和输出字段映射。

* 输出字段覆盖与重复成员诊断。

* “打开规则包” 命令。

抽屉不能编辑包名、成员规则内容、规则优先级或决策表命中策略。

### 5.2 单条规则和决策表

* 显示名称、类型、已发布版本、包和输出字段。

* 配置输入 / 输出映射。

* 提供 “打开规则” 或 “打开决策表” 命令。

* 内容修改必须跳转到对应资产编辑器，遵循资产 revision 和审批流程。

### 5.3 排他网关

* 网关名称。

* 条件分支列表及顺序。

* 每个分支使用 BOM 类型驱动的字段、运算符和值控件。

* 默认分支开关；整个网关最多一个默认分支。

* 添加、删除和排序分支。

### 5.4 字段映射

* 源字段和目标字段必须属于同一冻结 BOM。

* 下拉只显示兼容业务类型的字段。

* input mapping 的目标必须是 input；output mapping 的源必须是 output。

* 源和目标不能相同，目标不能重复。

* Rule Group 的可写字段取全部冻结成员 output 字段的并集。

抽屉中的 “应用” 只更新当前本地规则集草稿；整个规则集仍由编辑器头的 “保存” 统一提交，避免用户误以为节点已经单独持久化。

***

## 6. 编辑器头与反馈

### 6.1 信息层级

编辑器头显示：

```
规则集名称 · 草稿修订 r3 · 已发布 v1 · 最近修改时间

依赖状态：当前 / 需要重新发布

校验状态：未校验 / 当前草稿校验通过 / 草稿已变更
```

本期不显示不存在的 “main 分支” 或语义化 “基线 v1.0.0”。

Drools 校验状态必须绑定当前 `revision + draftHash`。任意本地编辑后立即变为 “草稿已变更”，不能继续显示旧的校验通过状态。

操作区：撤销、重做、自动布局、保存、校验、发布。发布前必须先保存；服务端发布仍会重新执行完整校验，不能信任前端徽标。

### 6.2 可折叠诊断横幅

默认显示一行摘要，例如：

```
多个步骤会写入同一输出字段（3 个字段） · 查看详情
```

展开后按严重性显示：

* `error`：空 Rule Group、同一路径重复执行资产、引用不存在、BOM 不一致、非法拓扑。

* `warning`：输出字段覆盖、包成员或版本变化导致需要重新发布、草稿资产被排除。

* `info`：成员数量、包含子包范围、当前最大 firing 限制。

诊断区默认折叠，错误存在时禁止校验通过和发布。

### 6.3 并发冲突

保存继续携带 revision/If-Match。发生 `409` 时：

* 保留本地画布、节点和撤销栈。

* 显示服务器最新修订号。

* 允许查看服务器版本或显式载入。

* 不自动覆盖用户本地草稿。

***

## 7. API 与服务端调整

### 7.1 不新增 RuleSet CRUD

Rule Group 是 FlowStep，不新增以下内容：

* `/api/projects/:id/rulesets` RuleSet CRUD。

* `ruleset` Change Set 类型。

* RuleSet 独立 PostgreSQL/JSON 存储。

* RuleSet 独立发布入口。

现有 `/api/projects/:id/rulesets` 实际返回规则集摘要。前端应逐步把 `Ruleset` 类型和 `useRulesets()` 重命名为 `FlowSummary` 和 `useFlows()`，canonical 列表使用 `/api/projects/:id/flows`。旧 `/rulesets` 只作为兼容别名保留。

### 7.2 Flow 接口

继续使用现有接口：

```http
GET    /api/projects/:id/flows

POST   /api/projects/:id/flows

GET    /api/projects/:id/flows/:flowId

PUT    /api/projects/:id/flows/:flowId

POST   /api/projects/:id/flows/:flowId/compile

POST   /api/projects/:id/flows/:flowId/publish
```

Flow 详情增加：

```ts
interface FlowDetail {
  // 现有字段保持不变
  availableAssets: FlowAssetOption[]
  availablePackages: Array<{
    name: string
    label: string
    parentId: string | null
    publishedRuleCount: number
    publishedTableCount: number
    excludedDraftCount: number
    outputFields: string[]
  }>
}
```

服务端是成员解析、重复检测和 DRL 生成的唯一权威；前端统计只用于即时反馈。

### 7.3 校验与快照

`validateFlow` 扩展接收 packages，并校验：

* `rule-group` selector 格式和包存在性。

* 包成员至少包含一个已发布资产。

* 所有成员使用当前同一 BOM 版本。

* 同一路径没有重复执行资产。

* Rule Group 字段映射合法。

* 总步骤数仍按画布任务节点计算，Rule Group 算一个步骤。

`flowSnapshot` 扩展冻结 Rule Group manifest、fingerprint 和组合 DRL。Release 继续直接使用规则集发布快照，不在 Release 创建或 RES 部署阶段重新解析包。

### 7.4 依赖过期

规则集摘要的 `outdatedDependencies` 扩展支持：

```ts
type OutdatedDependency =
  | { kind: 'asset'; id: string; name: string; publishedVersion: number; latestVersion: number }
  | { kind: 'rule-group'; nodeId: string; packageName: string; reason: 'members-changed' | 'bom-changed' }
```

通过重新解析 selector 并比较 fingerprint 判断 Rule Group 是否过期，结果按 nodeId 去重。

***

## 8. 运行时和容量约束

* Rule Group 的成员数量和实际 firing 次数是两个概念；大量规则可以只有少量命中。

* RES 当前每步骤最多 `100` 次 firing。Rule Group 达到上限时必须返回 `limitReached=true`，测试套件将其视为失败，Release 门禁不能放行。

* 编译必须沿用 Team Server 对 Build Service 的超时和错误处理，不允许浏览器生成 DRL。

* 开发验收至少覆盖 1000 条简单规则的 Rule Group 编译基准，记录耗时和制品大小；性能不达标时再确定成员硬上限，不能静默截断。

* 节点成员预览应虚拟化或分页，不能一次渲染几千行导致编辑器不可用。

***

## 9. 视觉规范

### 9.1 品牌与字体

* 使用现有 Tailwind token：`brand.primary`、`brand.primary-d`、`brand.primary-l`。

* 不新增 `ibm.blue` 或 `--ibm-blue` 命名。

* sans：`PingFang SC, Microsoft YaHei, Source Han Sans SC, system-ui`。

* mono：`JetBrains Mono, Source Han Mono, Courier New`。

* Logo 使用 `DW`。

### 9.2 密度与颜色

* 正文 12-13px，节点标题 12px，徽标 10-11px。

* 按钮圆角 2px，节点和抽屉不超过 4px。

* 规则组使用品牌蓝；开始 / 结束使用绿 / 红；网关使用琥珀色；决策表可使用受控紫色作为类型识别色。

* 连线保持中性灰，条件颜色只用于小面积标签和状态。

* 不使用装饰性渐变、光球、大圆角卡片或嵌套卡片。

***

## 10. 开发拆分

### Sprint 1：稳定画布编辑基础

* 为旧步骤补充稳定 nodeId 兼容逻辑。

* 增加 `draft.editor.positions/viewport`。

* 开启节点拖拽、选中和受限连接。

* 实现开始 / 结束、规则、决策表和多分支网关节点。

* 画布操作与 `steps[] + branches[]` 双向转换。

* 保留现有表单作为临时降级入口。

验收：不引入 Rule Group 时，现有规则集可以完全通过画布编辑且无数据损失。

### Sprint 2：Rule Package 拖入与 Rule Group

* 节点面板读取真实 Rule Package 和成员统计。

* 拖入包创建 `rule-group` 步骤。

* 实现 selector 解析、成员预览、组合 DRL、BOM 校验和重复资产检测。

* 发布快照冻结 members、fingerprint 和 DRL。

* Release、RES 和设计期调试执行 Rule Group。

验收：一个包含多条规则和决策表的包可以作为一个节点编译、发布、测试和部署。

### Sprint 3：依赖与治理联动

* 包成员变化和资产升版触发 `needsRepublish`。

* 包重命名、删除、移动资产时维护流程依赖。

* 扩展报告、搜索、审计和影响分析。

* 测试套件展示 Rule Group 节点轨迹和成员命中。

### Sprint 4：体验收尾

* 节点配置抽屉、可折叠诊断横幅。

* 撤销 / 重做、自动布局、小地图和键盘操作。

* 中等宽度布局和抽屉覆盖模式。

* 移除表单编辑主入口，保留只读结构摘要。

***

## 11. 测试要求

### 11.1 领域和 API

* 精确包与包含子包两种 selector 解析。

* 草稿 / 归档资产不进入成员。

* 成员排序、fingerprint 和 DRL 生成确定性。

* 发布后包成员变化不改变旧快照，只标记需要重新发布。

* 包重命名和删除维护或阻止规则集引用。

* 同一路径直接节点与 Rule Group 重复资产被拒绝。

* 不同排他分支重复资产允许存在。

* Rule Group 所有成员 BOM 一致性校验。

* revision 冲突保留结构化 `currentRevision/current`。

### 11.2 执行和 Release

* BAL 规则成员全部匹配时按优先级执行。

* 决策表成员保持 FIRST/PRIORITY/COLLECT 语义。

* Rule Group 输入输出映射与单资产步骤一致。

* Release 冻结成员版本、fingerprint 和组合 DRL。

* RES 重启后可恢复并执行包含 Rule Group 的 Release。

* 达到 firing 上限时测试失败且 Release 门禁拒绝。

### 11.3 前端

* 拖包生成节点、连接合法拓扑、非法连接有明确提示。

* 节点拖动后刷新页面仍恢复位置。

* 多条件分支和默认分支不会被降级为二分结构。

* 撤销 / 重做覆盖节点添加、删除、连接、移动和属性修改。

* 409 冲突不清空本地画布。

* 警告横幅默认折叠，展开后写者链完整。

* 桌面和中等宽度视口无控件重叠；小地图正常渲染。

### 11.4 回归

* 旧 `rule/table` 规则集完整回归。

* 节点调试、路径断言和失败节点定位保持可用。

* 测试套件、Change Set、审批、Release 和项目报告不回归。

* JSON 与 PostgreSQL 两种存储模式均通过。

***

## 12. 验收清单

* [ ] 规则集以画布作为主要编辑器，可拖拽、选中和连接节点。

* [ ] 左侧显示真实规则包，可将整个包拖为 Rule Group 节点。

* [ ] Rule Group 默认只选当前包，可显式包含子包。

* [ ] Rule Group 显示规则数、决策表数、排除草稿数和成员版本。

* [ ] 规则集发布时冻结 Rule Group 成员和 DRL，后续包变化不影响旧版本。

* [ ] 包成员或版本变化后，已发布规则集显示需要重新发布。

* [ ] 同一路径重复执行同一资产会阻止发布。

* [ ] 多步骤写同一输出字段显示折叠覆盖警告。

* [ ] 现有最多 8 条分支完整保留，不降级为固定是 / 否。

* [ ] 节点位置、撤销 / 重做、自动布局、缩放和小地图正常。

* [ ] 旧规则集无需人工迁移即可打开和保存。

* [ ] 规则集测试、Release 门禁和 RES 执行支持 Rule Group。

* [ ] 全量 Node 测试、前端类型检查、构建和 Docker RES 验证通过。
