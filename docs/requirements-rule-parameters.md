# 规则集内部变量（Ruleset Variables）需求设计

> 版本：2.1 ｜ 状态：已落地 V1 ｜ 日期：2026-10-02
> 关联：`docs/technical-design.md`、`docs/ruleflow-editor-design.md`、`docs/requirements-bom.md`

## 1. 需求背景

规则编写过程中经常需要保存一次执行内的中间判定结果，例如：

```text
氮气浓度达到上限
    -> pctAtLeastMax = true

pctAtLeastMax == true
    -> nextPhase = CIRCULATION
```

如果把 `pctAtLeastMax`、`phaseCandidate` 等技术字段加入 BOM，会污染业务事实模型，也会让调用方误以为这些字段需要传入。因此平台需要提供 **Ruleset Variable**：由规则集内部声明、由规则执行期间维护的临时变量。

Ruleset Variable 对应 JRules 等规则平台中的规则集上下文变量，不是运行期任务参数，也不是 BOM 字段。

## 2. 目标与边界

### 2.1 目标

- Rule Project 属性提供统一的 Ruleset Variable 定义入口。
- 规则集是最小发布与执行单元；规则集内的所有规则编辑器共享所属 Rule Project 变量。
- 单条规则发布仍保留规则级兼容声明，仅用于旧数据和兼容场景。
- 条件可以读取变量，动作可以修改变量。
- 同一次 `/execute` 的多个步骤和 `settle` 多轮共享变量状态。
- 调用方只提交业务事实 `facts`，不需要提交变量。
- 变量声明进入发布包并参与 checksum，保证执行契约可追溯。
- 变量当前值只存在于一次执行请求，不跨请求、任务或 Release 持久化。
- 变量可在规则编辑器中与 BOM 字段明确区分。

### 2.2 不在本需求范围内

以下内容不属于 Ruleset Variable：

- 任务运行期参数、任务实例状态、暂停/恢复、调参接口。
- BOM 字段、外部调用方传入的输入事实。
- 长时任务的环流累计时长、设备指令流水或跨请求状态。
- Team Server 任务调度器、多仓任务编排。
- `maxPct`、`minPct`、`safetyMaxPct` 等项目业务参数的语义确认和运行期调整。

如果后续需要外部传入的参数，应另行设计 `Ruleset Parameter`；如果需要跨请求保存状态，应另行设计 `Decision Plan Instance`。

## 3. 术语与生命周期

| 对象 | 来源 | 生命周期 | 是否进入 BOM/facts | 是否进入 Release |
|---|---|---|---|---|
| BOM 字段 | 项目字段模型 | 版本化长期存在 | 是 | 是 |
| Ruleset Variable 定义 | Rule Project 属性 | 随项目配置和 Release | 否 | 是 |
| Ruleset Variable 当前值 | RES 执行上下文 | 单次 `/execute` | 否 | 否 |
| Task State | 外部调用方 | 任务级、跨请求 | 否 | 否 |

一次执行的变量生命周期：

```text
收到 /execute
  -> 按 Release 中的 defaultValue 创建 RuleContext
  -> 执行步骤/规则，动作修改 RuleContext
  -> 下一步骤和下一 settle round 继续使用当前值
  -> 返回 variables/trace
  -> 请求结束，RuleContext 销毁
```

## 4. 功能要求

| 编号 | 要求 | 优先级 | V1 状态 |
|---|---|---:|---|
| V1 | Rule Project 属性可声明 Ruleset Variable | P0 | 已完成 |
| V2 | 支持类型、默认值、String 枚举、显示名和说明 | P0 | 已完成 |
| V3 | 规则条件可以读取变量 | P0 | 已完成 |
| V4 | 规则动作可以修改变量 | P0 | 已完成 |
| V5 | 变量不进入 BOM，也不允许由外部 facts 传入 | P0 | 已完成 |
| V6 | 同一次执行的多步骤共享变量 | P0 | 已完成 |
| V7 | settle 多轮共享变量，独立请求之间隔离 | P0 | 已完成 |
| V8 | 变量定义进入 Release 和 checksum | P1 | 已完成 |
| V9 | 未声明、重复、类型错误的变量在保存/编译/发布时拒绝 | P0 | 已完成 |
| V10 | 执行响应和 trace 提供变量快照 | P1 | 已完成 |
| V11 | 单条 BAL 规则独立发布的变量兼容声明 | P1 | 已完成 |
| V12 | 决策表条件列和动作列可以读取/修改变量 | P1 | 已完成 |
| V13 | 变量作为规则集网关条件 | P2 | 暂不支持，后置实现 |

V13 当前仍不支持通过网关直接判断变量。现有实现只允许网关条件读取冻结 BOM 字段；V12 已支持决策表条件列和动作列选择 Rule Project 变量。V13 后置实现时需要同时更新编辑器字段选择、`flowSnapshot` 冻结模型和 Release 路由校验。

## 5. 数据模型

Rule Project 记录的 `variables` 数组是正式定义入口：

```json
{
  "variables": [
    {
      "name": "pctAtLeastMax",
      "label": "浓度达到最大值",
      "type": "Boolean",
      "defaultValue": false,
      "enum": null,
      "description": "规则集内部的中间判定结果"
    },
    {
      "name": "phaseCandidate",
      "label": "候选阶段",
      "type": "String",
      "defaultValue": "FILLING",
      "enum": ["FILLING", "CIRCULATION", "HOLDING"],
      "description": "规则间传递的候选阶段"
    }
  ]
}
```

入口位于项目页右上角“项目设置”中的“Rule Project 变量”区域。规则集是最小发布与执行单元；一次规则集执行内，公共步骤、分支步骤以及同一规则组中的规则共享所属 Rule Project 的变量。BAL 和决策表编辑器只提供变量选择，不提供正式定义入口。BAL 规则草稿中的 `variables` 仅作为单条规则独立发布的兼容声明；旧规则集的顶层 `variables` 也只作兼容读取。

旧项目如果没有项目级 `variables`，平台会兼容地从旧规则/规则集声明中读取变量。新项目应只在 Rule Project 属性中定义变量，避免让每条规则重复维护。

### 5.1 约束

- `name`：2-32 位小驼峰标识符，正则为 `[a-z][a-zA-Z0-9_]{1,31}`。
- 同一规则集内变量名不能重复。
- 变量名不能与 BOM 字段名重复。
- 最多 50 个变量。
- `label` 必填，最多 40 个字符。
- `description` 最多 200 个字符。
- 支持 `Integer`、`Double`、`Boolean`、`String`。
- `String` 可以配置 1-50 个枚举值。
- 默认值必须匹配变量类型；String 默认值必须在枚举范围内。
- 变量定义冲突时保存/编译/发布失败。Rule Project 变量是正式作用域；成员规则的兼容声明不覆盖项目定义。旧项目没有项目变量时，平台可以从旧规则/规则集声明兼容读取。

### 5.2 与 BOM 的隔离

外部请求只传业务事实：

```json
{
  "releaseId": "release-1",
  "facts": {
    "nitrogenPct": 94,
    "maxPct": 95
  }
}
```

请求不能传：

```json
{
  "facts": {
    "pctAtLeastMax": true
  }
}
```

RES 对未知事实字段返回 `400`。变量由 RES 从 Release 定义按默认值初始化，不能通过 `facts` 注入。

## 6. 规则表达模型

条件引用变量：

```json
{
  "fieldSource": "variable",
  "field": "pctAtLeastMax",
  "operator": "==",
  "value": "true"
}
```

动作写入变量：

```json
{
  "fieldSource": "variable",
  "field": "pctAtLeastMax",
  "value": "true"
}
```

平台生成的 DRL 使用独立 `RuleContext`，不把变量追加到 `RuleInput`：

```java
declare RuleContext
    pctAtLeastMax : java.lang.Boolean
    phaseCandidate : String
end

rule "标记浓度达标"
when
    $input : RuleInput( nitrogenPct >= maxPct )
    $ctx : RuleContext()
then
    modify($ctx) {
        setPctAtLeastMax(true)
    }
end

rule "达标后进入环流"
when
    $input : RuleInput()
    $ctx : RuleContext( pctAtLeastMax == true )
then
    modify($input) {
        setNextPhase("CIRCULATION")
    }
end
```

## 7. Release 与 checksum

Drools Release 增加顶层 `variables`：

```json
{
  "variables": [
    {
      "name": "pctAtLeastMax",
      "label": "浓度达到最大值",
      "type": "Boolean",
      "defaultValue": false,
      "enum": null,
      "description": "..."
    }
  ]
}
```

- 变量定义改变，必须重新编译/发布。
- 变量定义参与 `releaseChecksum` 和 RES checksum。
- 变量当前运行值不写回 Release，不改变 checksum。
- Rule Project 变量优先用于规则、决策表和规则集的保存、编译、发布。
- 规则引用了未在 Rule Project 属性中定义的变量时，保存/编译/发布直接拒绝。
- 旧规则级 `variables` 和旧规则集顶层 `variables` 仅在项目变量为空时兼容读取。
- Release 中的变量定义和冻结 DRL 一起构成执行契约。

## 8. RES 执行语义

每个 `/execute` 请求：

1. 校验 Release checksum 和变量定义。
2. 按 `defaultValue` 创建本次请求的变量 map。
3. 每个步骤创建该步骤 DRL 对应的 `RuleContext`，将当前 map 写入。
4. 执行规则后读取 `RuleContext`，回写 map。
5. 下一个步骤和下一轮 settle 继续使用同一个 map。
6. 请求结束后销毁 map 和 `RuleContext`。

成功响应增加：

```json
{
  "variables": {
    "pctAtLeastMax": true,
    "phaseCandidate": "CIRCULATION"
  }
}
```

每轮 trace 也包含 `variables` 快照。变量不会混入 `facts`，也不会作为默认业务输出字段。

## 9. 验收标准

| 编号 | 验收项 | 通过标准 |
|---|---|---|
| A1 | 声明变量 | 合法变量可以保存、编译并发布 |
| A2 | 条件读变量 | 变量值满足条件时规则命中 |
| A3 | 动作写变量 | 动作修改后的值能被后续规则读取 |
| A4 | 多步骤共享 | 第一步写入的变量能被下一步骤读取 |
| A5 | settle 共享 | 第一轮写入的变量在后续 round 保持 |
| A6 | 请求隔离 | 两次独立执行都从默认值开始，互不污染 |
| A7 | facts 隔离 | facts 传入变量名被拒绝，变量不进入事实响应 |
| A8 | 定义校验 | 未声明、重复、非法类型、错误默认值被拒绝 |
| A9 | BOM 冲突 | 变量名与 BOM 字段同名时保存/发布失败 |
| A10 | Release 完整性 | 变量定义改变会导致 checksum 改变 |
| A11 | 规则组冲突 | 同名变量定义一致可合并，不一致拒绝发布 |
| A12 | 可追踪性 | 响应和每轮 trace 都可查看变量快照 |

## 10. 后续扩展建议

1. 允许规则集网关读取变量，但需要明确网关判定发生在步骤前还是步骤后。
2. 增加变量的只读/可写标记，限制特定规则修改变量。
3. 变量删除或重命名时，提供影响分析并列出引用它的规则/决策表。
4. 如果需要外部调用方传入阈值，新增独立 `Ruleset Parameter` 模型，不复用本需求的 `RuleContext`。
