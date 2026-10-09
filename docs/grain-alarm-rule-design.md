# 粮库温控监控告警规则设计（DWX）

| 项目 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-09-29 |
| 依据 | dograin《Dounion 粮库温控监控与告警系统需求设计文档》《传统规则平台 接入与规则设计方案》 |
| 状态 | 待业务审批阈值后实施 |

---

## 0. 设计原则（粮库行业口径）

1. **判定、事件、处置、投递四态分离**：规则引擎只做"本次判定"，不做状态机。连续超限次数、事件生命周期、人工确认、通知发送全在引擎外（告警管理模块）。
2. **质量先于温度**：缺测/陈旧/无效的数据不做温度判定，输出 `NOT_EVALUABLE` + 原因，不能拿坏数据报高温、也不能用正常点掩盖缺测。
3. **阈值必须业务审批**：本设计不预设任何具体温度值。所有阈值（告警/严重/恢复）以 `AlarmPolicy` 配置进入规则，配置有审批、生效期、不可变快照。
4. **作用域分组评估**：同一仓不同粮批/品类用各自策略，不混算一个均温。
5. **动作最小化**：规则动作只允许"记录判定/记录恢复候选/记录不可判定原因"，不暴露发短信、改设备、写库。
6. **区域特殊策略独立**：NF 上报（均温 >25 + 稻谷 + 封仓）是独立区域策略，不做成全系统通用阈值。

---

## 1. BOM 设计（JSON-as-fact，无 XOM）

> 我们平台 JSON 直接作为事实，不搞 Java POJO。以下 factType 在 BOM 编辑器里逐字段配置，DRL `declare` 自动生成。

### 1.1 事实类型总览

| factType | 中文名 | 方向 | 职责 |
|---|---|---|---|
| `GranaryContext` | 当前仓房 | input | 仓号、粮批、品类、储存状态、策略快照版本 |
| `MeasurementBatch` | 本次采集 | input | 批次、时间、应采点数、完整性 |
| `TemperatureStatistics` | 温度统计 | input | 均温、最高/最低温、覆盖率、不可用率、层统计 |
| `TemperaturePoint` | 测温点 | input | 单点温度、层、有效性、来源、新鲜度 |
| `HistoryFeature` | 历史特征 | input | 与历史基准的温差、可比性 |
| `AlarmPolicy` | 适用策略 | input | 告警阈值、严重阈值、恢复阈值、持续条件、等级 |
| `AlarmContext` | 已有告警 | input | 当前告警等级、确认状态、连续超限次数 |
| `RuleAssessment` | 单项判定 | output | 规则标识、判定状态、命中等级、观测值、阈值、原因 |
| `GrainAlarmResult` | 本次判定结果 | output | 判定集合、最高候选等级、原因码 |

### 1.2 字段明细（BOM 编辑器配置项）

#### GranaryContext 当前仓房（input）

| key | label | type | 约束 |
|---|---|---|---|
| `granaryId` | 仓号 | String | 必填 |
| `batchId` | 粮批 | String | |
| `grainType` | 粮食品类 | Enum | 稻谷/小麦/玉米/大豆/其他 |
| `storageState` | 储存状态 | Enum | 散存/包装/封仓/其他 |
| `policyVersion` | 策略版本 | String | 评估绑定配置快照 |

#### MeasurementBatch 本次采集（input）

| key | label | type | 约束 |
|---|---|---|---|
| `batchId` | 批次号 | String | |
| `measuredAt` | 测量时间 | Date | 判定用测量时间，非接收时间 |
| `expectedPoints` | 应采测点数 | Integer | 来自与采样时刻匹配的拓扑 |
| `actualPoints` | 实采测点数 | Integer | |
| `isComplete` | 是否完整 | Boolean | |

#### TemperatureStatistics 温度统计（input）

| key | label | type | 约束 |
|---|---|---|---|
| `averageTemp` | 平均粮温 | Decimal(℃) | 参与点集合=有效点 |
| `maxTemp` | 最高粮温 | Decimal(℃) | 对应测点随判定带回 |
| `minTemp` | 最低粮温 | Decimal(℃) | |
| `coverageRate` | 有效覆盖率 | Decimal(0-1) | 有效点数/应采点数 |
| `unavailableRate` | 不可用率 | Decimal(0-1) | |
| `layerStats` | 分层统计 | List<String> | 序列化层号+均温，M2 再拆对象 |

#### TemperaturePoint 测温点（input）

| key | label | type | 约束 |
|---|---|---|---|
| `pointId` | 测点号 | String | |
| `layerNo` | 所在层 | Integer | |
| `temp` | 测点粮温 | Decimal(℃) | 判定值，无效时空 |
| `validity` | 有效性 | Enum | 有效/无效/未知 |
| `sourceKind` | 来源 | Enum | 硬件实测/人工修改/系统补录 |
| `freshness` | 新鲜度 | Enum | 新鲜/陈旧/未知 |
| `sampledAt` | 采样时间 | Date | |

#### HistoryFeature 历史特征（input）

| key | label | type | 约束 |
|---|---|---|---|
| `deltaTemp` | 相对基准升温值 | Decimal(℃) | 本次均温 - 可比基准均温 |
| `comparable` | 历史是否可比 | Boolean | 粮批/拓扑版本一致才 true |
| `baselineTime` | 基准时刻 | Date | |

#### AlarmPolicy 适用策略（input）

| key | label | type | 约束 |
|---|---|---|---|
| `ruleCategory` | 规则类别 | Enum | 均温/最高温/分层/升温/质量 |
| `scopeType` | 作用域 | Enum | 仓/粮批/层/测点 |
| `warnThreshold` | 告警阈值 Tw | Decimal(℃) | 必须 Tw < Tc |
| `criticalThreshold` | 严重阈值 Tc | Decimal(℃) | |
| `recoverThreshold` | 恢复阈值 R | Decimal(℃) | 必须 R < Tw |
| `minCoverage` | 最低覆盖率 | Decimal(0-1) | 低于则不判定 |
| `enabled` | 启用 | Boolean | 停用→NOT_APPLICABLE |
| `effectiveFrom/To` | 生效期 | Date | 重叠校验 |

#### AlarmContext 已有告警（input）

| key | label | type | 约束 |
|---|---|---|---|
| `hasActiveAlarm` | 有活动告警 | Boolean | |
| `activeLevel` | 当前等级 | Enum | 无/告警/严重 |
| `confirmState` | 确认状态 | Enum | 未确认/已确认 |
| `consecutiveBreaches` | 连续超限次数 | Integer | 引擎外维护，传入只读 |

#### RuleAssessment 单项判定（output）

| key | label | type | 约束 |
|---|---|---|---|
| `ruleCategory` | 规则类别 | Enum | |
| `scopeKey` | 作用域键 | String | 组织+仓/粮批+类别+层/点 |
| `assessmentState` | 判定状态 | Enum | BREACH/HOLD/CLEAR_CANDIDATE/NORMAL/NOT_EVALUABLE/NOT_APPLICABLE |
| `matchedBands` | 命中等级 | List<Enum> | 保留全部：告警+严重都命中要都留 |
| `maxCandidateLevel` | 最高候选等级 | Enum | 无/告警/严重 |
| `observedValue` | 观测值 | Decimal | |
| `threshold` | 阈值 | Decimal | |
| `reasons` | 原因 | List<String> | 质量原因/证据 |

#### GrainAlarmResult 本次判定结果（output）

| key | label | type | 约束 |
|---|---|---|---|
| `assessments` | 判定集合 | List<RuleAssessment> | 可多类同时成立 |
| `executionState` | 执行状态 | Enum | OK/PARTIAL_FAILED |
| `resultCode` | 结果码 | String | |

### 1.3 业务词汇表（BAL 用中文说法）

| BOM 属性 | 业务说法 |
|---|---|
| `GranaryContext.averageTemp` | 当前仓房的平均粮温 |
| `TemperatureStatistics.coverageRate` | 本次采集的有效测点覆盖率 |
| `HistoryFeature.deltaTemp` | 该仓相对历史基准的升温值 |
| `AlarmPolicy.warnThreshold` | 适用策略的告警阈值 |
| `AlarmPolicy.recoverThreshold` | 适用策略的恢复阈值 |
| `TemperaturePoint.validity` | 该测点是否有效 |
| `AlarmContext.hasActiveAlarm` | 当前仓房是否存在活动告警 |

---

## 2. BAL 规则设计

### 2.1 均温超限（告警+严重分级）

```
规则 "整仓均温告警"
当
  一个 当前仓房 的 平均粮温 可用于判断
  并且 一个 温度统计 的 有效测点覆盖率 大于等于 适用策略 的 最低覆盖率
  并且 当前仓房的平均粮温 大于等于 适用策略 的 告警阈值
  并且 当前仓房的平均粮温 小于 适用策略 的 严重阈值
那么
  记录一条 均温超限判定，等级为"告警"
  附带 平均粮温、适用阈值、采集时间、规则标识
```

```
规则 "整仓均温严重超限"
当
  一个 当前仓房 的 平均粮温 可用于判断
  并且 有效测点覆盖率 大于等于 最低覆盖率
  并且 平均粮温 大于等于 严重阈值
那么
  记录一条 均温超限判定，等级为"严重"
  （同时保留"告警"等级到命中集合，不丢弃）
```

### 2.2 恢复判定

```
规则 "均温恢复候选"
当
  当前仓房 存在 活动的均温告警
  并且 本次均温及覆盖率 满足恢复判断要求
  并且 平均粮温 小于等于 恢复阈值
那么
  记录一条 恢复候选判定
  （恢复是否生效由引擎外核对连续有效批次，规则不直接清除告警）
```

### 2.3 质量不可判定

```
规则 "均温数据不足不可判定"
当
  一个 温度统计 的 有效覆盖率 小于 最低覆盖率
那么
  记录一条 不可判定原因："有效测点覆盖率不足"
  输出 NOT_EVALUABLE
```

### 2.4 历史升温

```
规则 "历史均温异常升高"
当
  历史特征 的 历史是否可比 为 true
  并且 历史升温值 大于等于 适用策略 的 升温告警阈值
那么
  记录一条 升温超限判定，等级为"告警"
  附带 当前均温、基准均温、升温值
```

### 2.5 区域特殊策略（NF 上报，独立规则包）

```
规则 "NF稻谷封仓高温上报登记"
当
  粮食品类 包含 "稻谷"
  并且 储存状态 为 "封仓"
  并且 平均粮温 严格大于 25
那么
  记录一条 高温上报登记判定（区域策略专用）
```

> 此规则属于独立包 `nf-report`，不参与通用告警，不改动通用阈值。

---

## 3. 决策表设计

### 3.1 均温报警主决策表（T：平均粮温）

**列**（条件→动作）：
`可判定 | 平均粮温T | 有活动告警 | → 判定状态 | 命中等级 | 原因`

**行**（阈值用符号，业务审批后替换为数值）：

| 可判定 | T | 有活动告警 | 判定状态 | 命中等级 | 原因 |
|---|---|---|---|---|---|
| 否 | — | — | NOT_EVALUABLE | 无 | 覆盖率不足/质量原因 |
| 是 | ≥ Tc | — | BREACH | 告警+严重 | 严重超限 |
| 是 | [Tw, Tc) | — | BREACH | 告警 | 均温超限 |
| 是 | (R, Tw) | 是 | HOLD | — | 未满足恢复 |
| 是 | ≤ R | 是 | CLEAR_CANDIDATE | — | 满足恢复 |
| 是 | < Tw | 否 | NORMAL | — | 正常 |

**命中策略**：PRIORITY（从上到下，第一命中即停——行序即互斥区间，不允许重叠）。

**决策表覆盖性校验**（构建时自动检查）：
- 六行覆盖 T 的 (-∞, +∞) 全区间，无空档
- 行 1 可判定=否 与其他行互斥
- 行 3/4/5 与行 6 依赖"有活动告警"列，逻辑无矛盾
- `R < Tw < Tc` 配置校验（AlarmPolicy 编辑时阻止倒置）

### 3.2 最高粮温决策表

**列**：`可判定 | 最高温 H | 持续条件 | → 判定状态 | 命中等级`

| 可判定 | H | 持续条件 | 判定状态 | 命中等级 |
|---|---|---|---|---|
| 否 | — | — | NOT_EVALUABLE | 无 |
| 是 | ≥ 严重阈值 | — | BREACH | 严重 |
| 是 | ≥ 告警阈值 | 连续 N 批/持续 T 分钟（引擎外累计） | BREACH | 告警 |
| 是 | < 告警阈值 | — | NORMAL | 无 |

> 单点瞬时值抑制（是否允许瞬时触发）由持续条件参数决定，业务审批。

### 3.3 分层超限决策表

**列**：`层号 | 该层均温 | → 判定状态 | 命中等级`

| 层号 | 该层均温 | 判定状态 | 命中等级 |
|---|---|---|---|
| 任意 | ≥ 该层严重阈值 | BREACH | 严重 |
| 任意 | ≥ 该层告警阈值 | BREACH | 告警 |
| 任意 | < 该层阈值 | NORMAL | 无 |

> 层阈值来自 `t_bas_temp_set` 按品类+温层配置，BOM 的 AlarmPolicy 按 scopeType=层 挂载。

---

## 4. 与引擎外状态机的衔接契约

| 引擎输出判定 | 引擎外动作 |
|---|---|
| BREACH（含等级） | 连续超限计数+1，达持续条件→开事件/升级 |
| CLEAR_CANDIDATE | 连续恢复计数+1，达持续条件→事件转"已恢复" |
| NORMAL | 无活动告警时无动作 |
| HOLD | 保持现有事件 |
| NOT_EVALUABLE | 中断连续计数，不清除已有告警 |
| NOT_APPLICABLE | 不产生事件，不清除旧事件 |

**跨批次状态（连续次数/事件/确认/通知）一律不进规则引擎**，由告警管理模块按此契约推进。

---

## 5. 落地顺序（配合平台开发）

| 阶段 | 内容 |
|---|---|
| P0 | 平台 BOM 编辑器上线 → 录入本 BOM（3 个 input factType 先做） |
| P0 | BAL 编辑器支持 Enum/Decimal/List → 编写 §2 规则 |
| P1 | 决策表编辑器上线 → 录入 §3 主决策表 |
| P1 | Project/Package CRUD → 建 `grain-alarm` 项目 + `quality/avg-temp/max-temp/layer/history/nf-report` 包 |
| P2 | 阈值配置界面（AlarmPolicy 编辑：Tw/Tc/R、生效期、审批） |
| P2 | 引擎外状态机（连续次数/事件/确认/通知） |

---

## 6. 验收场景（dograin AT 用例映射）

| 验收 | 输入 | 期望 |
|---|---|---|
| 均温正常 | 覆盖率 95%，T=18℃，无告警 | NORMAL |
| 均温告警 | 覆盖率 95%，T=27℃（Tw=25），无告警 | BREACH/告警 |
| 均温严重 | 覆盖率 95%，T=31℃（Tc=30） | BREACH/严重，命中集合含告警+严重 |
| 恢复候选 | 有活动告警，T=20℃（R=21） | CLEAR_CANDIDATE |
| 数据不足 | 覆盖率 60%（min=80%） | NOT_EVALUABLE + 原因 |
| 历史可比性 | 粮批变更，delta 不可比 | 不判定升温，输出原因 |
| 停用策略 | policy.enabled=false | NOT_APPLICABLE |
| 配置倒置 | Tw=30, Tc=25 | 构建时被校验阻止 |
