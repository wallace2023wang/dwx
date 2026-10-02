# 自动充氮控制 —— 资产级落地方案（路线 A′ + C）

> 版本：v2.0 ｜ 状态：**已定稿**（决策记录见 §8）｜ 日期：2026-10-02
> 前置：`nitrogen-auto-fill-solution-options.md`（选型结论：A′ 决策表状态机 + C 安全告警）
> 关联：`decision-table-design.md`、`ruleflow-editor-design.md`、`bom-editor-design.md`、`cep-time-driven-statement-support.md`、`platform-issues-and-fixes.md`

---

## 0. 关键核实结论（先说结论，因为它改变了 A′ 的落地形态）

选定 A′ 后，我逐行核对了平台代码，确认 3 条硬事实：

| # | 结论 | 证据 | 对方案的影响 |
|---|---|---|---|
| **F1** | **决策表条件单元格不能引用字段值，只能是字面量** | `shared/assets.js:64 parseConditionCell` → `:134 formatDrlValue(field, operand)` → `shared/rules.js:44` 对 Double 要求 `Number.isFinite(Number(trimmed))`；`maxPct` 不在范围内 → 返回 `null` → 抛"条件值无效"。区间语法同样要求 `-?\d+(\.\d+)?`（`:83`） | **"`nitrogenPct >= maxPct`" 不能写成决策表单元格。** A′ 必须改为"比较结果预处理成布尔入参"或换 BAL |
| **F2** | **输出字段不能回灌为输入** | `server/index.js:104 parseFacts`：`Object.keys(raw).some(key => !inputs.some(...))` → 任意 output 字段出现在 facts 里直接 400 | 上一轮的 `nextPhase`/设备指令无法作为下一轮输入送给 RES。**状态必须由调用方（仓端中控）持有**——与路线 A 的定位一致，但这是平台强制的，不是可选设计 |
| **F3** | **决策表命中 = "首个条件匹配的行"，与物理行序无关** | 实测（真实 Drools `/test`）：`PENDING + endReached=true` 命中第 6 行而非第 1 行；`PENDING + paused=true` 命中第 7 行；`FILLING + endReached=true` 命中第 6 行。生成 DRL 的 salience 随行号递减，但**优先级裁决方向与直觉相反**，实际效果是"逐行向下匹配、先匹配上的胜出"，与源码里 `documents` 常见的"末行覆盖"假设相反 | **不得依赖行序推断优先级**；需要"兜底"的行必须写成**显式条件**（本设计的暂停行条件为 `paused == true`，不靠行号兜底） |
| **F5** | **发布产物会冻结当时的 BOM 版本；BOM 升版后旧产物不可用于规则流** | 实测：表在 BOM v4 时发布，BOM 升到 v6 后编辑规则流报 `充氮结束处理表 使用 BOM v4，当前为 v6，请先重新发布该资产`（`flowSnapshot` 的检查，`shared/assets.js:871`）。同时 `projectAssetDetail` 原先不返回产物 BOM 版本，调用方无法判断是否需要重发 | 表 A/B **在任何 BOM 修改后必须重新发布**；为此在 `projectAssetDetail` 增加了 `versions[]` 与 `publishedBomVersion`（`server/index.js`） |

另外确认了一条**可用能力**：规则流支持按 Boolean 字段做排他分支（`shared/assets.js:657 flowConditionValue` 明确处理 `Boolean → text === 'true'`；`:665 flowConditionMatches`）。这条能力让 A′ 可以做到"全程只用决策表"。

> F1 让 A′ 从"一张表"变成"**一张主表 + 一层预处理**"。已按决策 D1① 定稿：阈值比较放在仓端中控，以 4 个布尔入参进入规则。

### 0.1 定稿决议（2026-10-02）

| # | 决议 | 后果 |
|---|---|---|
| D1 | **① 阈值比较在仓端中控预处理成布尔量**，决策表保持"一张业务表" | 规则只做逻辑、可回放；§2.3 预处理算法纳入集成验收 |
| D2 | **① "结束"由规则流承载** | 结束语义成为可治理、可审计的资产行为 |
| D3 | **① `paused` 保留为决策表行 + 中控侧也短路** | 双保险，暂停成为可测试的规则行为 |
| D4 | **① 停用现网 `project-7c12c971` 的 3 条迁移语句** | 阶段事件只有一个来源 |
| D5 | **API 种子 + 页面发 Release** | 见 §7.0 |
| D6 | **控制循环直连 RES :8790** | 见 §7.0，代价由 C1–C3 补偿 |

### 0.2 执行阶段修正（基于真实落地，覆盖早期设计）

早期设计在真实落地时被推翻/修正了四处，**以实现为准**：

| # | 早期设计 | 实际落地 | 原因 |
|---|---|---|---|
| **A1** | 表 A 只写 `nextPhase`/`reason`，设备态由独立的"设备态表"按 `phase` 给出 | **设备指令与迁移写在表 A 同一行** | 已实测（V1）：平台不允许 output 回填 input，步骤间传递的是 `nextPhase`；若后续步骤按 `phase` 选行，会读到**迁移前**的阶段 → `FILLING→CIRCULATION` 时给出"充氮阀 OPEN"（开错阀门） |
| **A2** | 规则流用 `endReached` 排他网关分出两条分支 | **两个公共步骤（A → B），无网关** | 平台要求每个分支至少一步，空默认分支非法；而"未到结束时间"分支本就不需要额外步骤 |
| **A3** | "设备态表"是第三个资产 | **取消该资产**（已归档） | 设备态并入表 A 后不再需要 |
| **A4** | 决策表承载状态迁移、阈值由中控预处理成布尔信号 | **改用 BAL 规则（11 条），阈值比较写在规则内、阈值作为 facts 参数传入** | 客户要求阈值"随时调整"。决策表单元格只接受字面量，写死会随 Release 冻结、改一次要重新发布部署；BAL 的 `raw` 条件可写 `nitrogenPct >= maxPct`，阈值来自参数 → **改参数立即生效，无需重新发布**。两处旧决策表已移到 `deprecated.nitrogen` 包（仍在 `nitrogen` 包里会被 Rule Group 一并编译而报 BOM 版本过期） |

---

## 1. 三层资产结构（最终形态）

```
Layer C 安全告警（CEP / Esper）—— 与控制解耦，独立通道
  ├─ 越上限告警 + 强制关充氮设备（联锁）   → webhook alert.fired
  └─ 断流告警（浓度数据超时未更新）        → webhook alert.fired / cleared

Layer A 控制主链路（rules / Drools）
  ┌ 决策表 A：主状态迁移（7 行，一张表读完全部迁移）
  └ 规则流：公共步骤[A] → 排他网关(endReached) → { 结束决策表 B | 常规决策表 B' }
                                        ↑ 复用 Boolean 分支能力（F3 已核实）

Layer B 契约（不是资产，是要写进接口文档的规范；两套 BOM 各自独立）
  ├─ Drools 侧 facts 契约：仓端中控每轮传给 RES 的 9 个 key（多传即 400）
  ├─ CEP 侧事件契约：中控按 CEP BOM 上报的 NitrogenReading 字段
  ├─ 预处理算法：pctAtLeastMax / pctBelowMin / circElapsed / endReached 怎么算
  └─ 输出契约：nextPhase + 4 路设备指令 + reason，怎么下发与回执
```

**为什么把"结束处理"拆成第二张表**：因为 F1 让 `now >= endAt` 无法进决策表条件，而"结束优先级最高"又必须保证。用**规则流网关**在同一发布物内完成，比让中控额外判一次更内聚，也让"任何阶段到点即结束"成为一个可测试的资产行为。

---

## 1.1 双引擎与 BOM 隔离（重要前提）

本方案**同时用到 Drools 和 Esper，但它们是两条互不依赖的链路，各自一套 BOM，平台不共享字段定义**。

### 1.1.1 落地形态：两个项目，两个 BOM

| | 控制主链路（Layer A） | 安全告警链路（Layer C） |
|---|---|---|
| 引擎 | Drools 10.2.0 | Esper 8.8.0 |
| 项目 | **新建** `engine=rules`（如"粮库自动充氮控制（Drools）"） | 复用/新建 `engine=cep`（现网 `project-7c12c971`） |
| BOM 文件 | `bom-<rulesProjectId>.json` | `bom-<cepProjectId>.json` |
| BOM 内容 | `NitrogenControl`（9 入参）+ `NitrogenCommand`（6 出参） | `NitrogenReading`（事件类型）+ `NitrogenPhase`（输出枚举） |
| 资产 | 决策表 A/B/B′ + 规则流 + 测试套件 | EventStream（越限联锁 + 断流检测） |
| 编译 | Drools `/compile`（8788） | Esper `/compile`（8791） |
| 运行 | RES `/execute`（8790） | CEP Runtime `/events/{releaseId}`（8792） |
| Release | `engine:{type:'drools'}` schemaVersion 1 | `engine:{type:'esper'}` schemaVersion 2 |

**核实结论**：BOM 按项目隔离（`bomFile(projectId)` → `bom-<projectId>.json`，`server/index.js:40,131`），事件上报校验走 `validateEventPayloads(events, cepBom)`，控制执行校验走 `parseFacts(facts, rulesRelease.model || rulesBom)`——**两个引擎之间没有共享字段定义，也没有交叉校验**。所以：

- 字段名、枚举值、类型**在两套 BOM 中各自定义，互不影响**；
- 改变 CEP BOM（如加一个温度字段）不需要重发 Drools Release，反之亦然；
- 两套 BOM 里即使出现同名 key（如 `phase`），也**不会互相干扰**（分属不同项目、不同校验入口）。

### 1.1.2 两套 BOM 之间唯一的耦合：一个"预处理契约"

平台不帮你连接两者，**连接点在仓端中控**：

```
CEP BOM 定义（传感器世界）                Drools BOM 定义（控制世界）
  NitrogenReading                           NitrogenControl
    nitrogenPct : double        ──┐           phase          : String(enum)
    readingTime : string          │           pctAtLeastMax  : Boolean
    warehouseId : string          │           pctBelowMin    : Boolean
    eventId / sensorId …          │           circElapsed    : Boolean
                                  │           endReached     : Boolean
                          仓端中控预处理       warehouseId    : String
                       （阈值比较 / 计时 /     nitrogenPct/maxPct/minPct : Double
                         断流判定 / 暂停标志）  NitrogenCommand
                                  │             nextPhase / genCmd / fillValveCmd
                                  │             / circValveCmd / fanCmd / reason
                                  └──────────►
```

**契约义务（必须写进集成文档并验收）**：

| # | 义务 | 违反后果 |
|---|---|---|
| O1 | 中控按 §2.3 把"浓度 + 阈值"折算成 4 个布尔信号 | 规则退化为读原值，F1 限制下无法表达 |
| O2 | 中控只把 Drools BOM 里声明的 9 个 key 传给 RES（**多传一个 key 就 400**，`server/index.js:104`） | 调用直接失败 |
| O3 | CEP 侧只按 CEP BOM 的 `NitrogenReading` 字段上报（多传字段被 `validateEventPayloads` 拒绝） | 事件被拒 |
| O4 | 两套 BOM 的 `warehouseId` 取值口径一致（同一套仓号编码） | 告警与控制对不上仓 |
| O5 | 安全联锁走 CEP → 中控 → 强制关设备，**不经过 Drools**；中控收到联锁后不得再按 Drools 输出开阀 | 越限时仍充氮 |

### 1.1.3 为什么不把两件事合成一个引擎

| 尝试 | 为什么不成立 |
|---|---|
| 全用 Esper（含控制） | 暂停 = 重置计时、重启丢状态、结束时间无法表达、设备指令无幂等（`nitrogen-auto-fill-solution-options.md` §3.2） |
| 全用 Drools（含断流检测） | Drools 是请求驱动，没有持续事件流与定时器；断流检测要么靠中控自报（不可靠），要么引入外部轮询 |
| 两个引擎共享一套 BOM | 平台架构上不支持：BOM 按项目隔离，且 `engine` 资产隔离（`dual-engine-architecture-design.md` §4.3）。强行共享意味着改 BOM 要同时重发两条链路的 Release，耦合度反而更高 |

**结论**：双引擎是"分工"而不是"耦合"。控制逻辑（有状态、要暂停、要审计）在 Drools；安全检测（流式、要抢时间）在 Esper；两者只在仓端汇合。

---

## 2. Layer B：facts 契约（两套 BOM 各自的字段定义）

### 2.1 入参（BOM `NitrogenControl`，全部 `kind=input`）

> 这份 BOM **只属于 Drools 项目**，与 CEP 项目的 BOM 无任何共享（§1.1）。

| key | 类型 | 来源 | 说明 |
|---|---|---|---|
| `warehouseId` | String | 中控 | 仓号。**不参与任何规则条件**，只为执行报告与审计留痕；O2 要求它在 BOM 内声明，否则中控传了会被 400 |
| `phase` | String(enum) | **中控持有** | `PENDING`/`FILLING`/`CIRCULATION`/`HOLDING`/`REPLENISHING`/`PAUSED`（`PAUSED` 供表 A 第 7 行写出） |
| `pctAtLeastMax` | Boolean | **中控预处理** | `nitrogenPct >= maxPct`（闭区间，F1 的替代方案） |
| `pctBelowMin` | Boolean | **中控预处理** | `nitrogenPct < minPct`（严格小于） |
| `circElapsed` | Boolean | **中控预处理** | `circAccumMs >= circDurationMs` |
| `endReached` | Boolean | **中控预处理** | `now >= endAt` |
| `nitrogenPct` | Double | 中控 | 浓度原值（**只用于审计/展示，不参与条件**，避免误用） |
| `maxPct` / `minPct` | Double | 中控 | 阈值原值（同上，只做审计留痕） |

> 设计原则：**规则只做逻辑，算术留给调用方**。这样规则可回放、可断言，阈值变化不需要改规则（也不需要因 F1 而改表）。
>
> 为何保留原值字段：`startAt`/`endAt`/`circDurationMs`/`now` **不进 BOM**（时间比较已在 `endReached`/`circElapsed` 里完成）；但 `nitrogenPct`/`maxPct`/`minPct` 保留，是为了让每次执行的事实快照能自证"当时判定依据是什么"，便于事后复盘。若评审认为审计留痕应交给中控，可再精简为 6 个 key。

### 2.2 出参（BOM `NitrogenCommand`，全部 `kind=output`）

| key | 类型 | 取值 |
|---|---|---|
| `nextPhase` | String(enum) | 与 `phase` 同枚举 |
| `genCmd` | String(enum) | `ON` / `OFF` |
| `fillValveCmd` | String(enum) | `OPEN` / `CLOSED` |
| `circValveCmd` | String(enum) | `OPEN` / `CLOSED` |
| `fanCmd` | String(enum) | `ON` / `OFF` |
| `reason` | String | 中文迁移原因（审计与展示） |

> 命名不用现网 PoC 的 `n2vCmd`：虽然实测 Drools 可编译，但不符合 JavaBean 大小写惯例，换引擎/换绑定层会踩坑。

### 2.3 预处理算法（仓端中控的伪码，必须写进接口文档）

```
# 每分钟 tick 一次
if paused:
    输出全关指令（不调用平台）；return                 # 暂停天然成立：不调用即暂停
prev = phase
if endReached:
    输出全关 + COMPLETED；return                       # 结束在平台侧也会判，双保险

facts = { warehouseId, phase,
          pctAtLeastMax: nitrogenPct >= maxPct,
          pctBelowMin:   nitrogenPct < minPct,
          circElapsed:   circAccumMs >= circDurationMs,
          endReached:    now >= endAt,
          nitrogenPct, maxPct, minPct }

output = RES 直连 execute(facts)      # POST :8790/execute { releaseId, facts }
nextPhase = output.nextPhase

# C1：发送前断言必传 key 一个不少；C2：返回值过枚举白名单；C3：全量快照留痕
assertKeysComplete(facts)             # 漏传会让引擎静默补 0/false，必须本地拦截
assertEnums(output)                   # nextPhase ∈ BOM enum；指令 ∈ ON/OFF、OPEN/CLOSED
recordSnapshot(facts, output)

# 环流累计：只累加运行中的环流时长，暂停冻结
if nextPhase == 'CIRCULATION':
    circAccumMs += (now - circStartRef)          # circStartRef 在进入环流时置为 now
else:
    circStartRef = null
if prev == 'CIRCULATION' and nextPhase != 'CIRCULATION':
    circAccumMs = 0                              # 离开环流即清零，下次重新计 4 小时

# 回灌状态（F2：只能由中控持有）
phase = nextPhase
if phase or 设备指令 相对上一轮有变化: 下发指令（幂等键 {taskId, tickSeq, phase}）
tickSeq += 1
```

### 2.4 安全兜底（必须实现，写进验收）

| 场景 | 动作 |
|---|---|
| RES 不可达 | **关制氮机、关充氮阀**（默认安全态）；连续 3 次失败 → 告警 |
| 必传 key 缺失 | 按上一条处理（拒绝调用 + 全关 + 告警），**绝不带缺 key 调用**（C1） |
| 浓度数据超时未更新 | `pctAtLeastMax=false`、`pctBelowMin=false` 且标记断流 → 保护性全关 + Layer C 断流告警 |
| 输出出现 `fillValveCmd=OPEN && circValveCmd=OPEN` | 拒绝下发，进入故障态并告警（互斥铁律） |

---

## 3. Layer A 之一：BAL 规则（阈值判定 + 状态迁移，11 条）

> **本节已按客户要求重做**：最大/最小氮气浓度等判断参数需要随时调整，因此阈值比较**必须在规则内完成**。
> 决策表条件单元格只接受字面量（F1），写字面量会让阈值随 Release 冻结、改一次要重新发布部署 ——
> 与"随时调整"冲突。故改用 BAL 规则，阈值作为 **facts 参数**传入。

### 3.1 为什么是 BAL 而不是决策表

| 方案 | 阈值位置 | 改阈值要做什么 | 判定 |
|---|---|---|---|
| 驱动代码里比较 | 代码常量 | 改代码 + 重启 | ✗ 现状，不满足 |
| 决策表字面量（`>=95`） | 表单元格 | 改表 + 重新发布 + 重新部署 | ✗ 随 Release 冻结 |
| **BAL 声明式字段引用（`valueSource:"field"` + `valueField:"maxPct"`）** | **facts 参数** | **改参数，立即生效** | ✓ 采用 |

实现形态（平台升级后新增能力，`shared/rules.js:257`）：

```jsonc
{ "field": "nitrogenPct", "operator": ">=", "valueSource": "field", "valueField": "maxPct", "value": "" }
// → 生成 RuleInput( nitrogenPct >= maxPct )
```

比 `raw: "nitrogenPct >= maxPct"` 更好：编辑器可正常显示/编辑、后端会校验类型（须同为 Double）、
拒绝自比较与非法运算符、语义明确可评审。**早期曾用 `raw` 写法，已全部替换。**

### 3.2 规则清单（salience 由高到低）

| # | 规则 | 条件（节选） | 动作 |
|---|---|---|---|
| 1 | 暂停全关 | `paused == true` | PAUSED + 全关 |
| 2 | 到达结束时间完成 | `endReached == true` | COMPLETED + 全关 |
| 3 | 启动充氮 | `phase == "PENDING"` + 守卫 | FILLING + 充氮设备 |
| 4 | 充氮未达标保持 | `phase=="FILLING"` + **`nitrogenPct < maxPct`** | FILLING + 充氮设备 |
| 5 | 充氮达标转环流 | `phase=="FILLING"` + **`nitrogenPct >= maxPct`** | CIRCULATION + 环流设备 |
| 6 | 环流未满保持 | `phase=="CIRCULATION"` + `circElapsed == false` | CIRCULATION + 环流设备 |
| 7 | 环流期满转保氮 | `phase=="CIRCULATION"` + `circElapsed == true` | HOLDING + 全关 |
| 8 | 保氮正常保持 | `phase=="HOLDING"` + **`nitrogenPct >= minPct`** | HOLDING + 全关 |
| 9 | 保氮过低转补氮 | `phase=="HOLDING"` + **`nitrogenPct < minPct`** | REPLENISHING + 充氮设备 |
| 10 | 补氮未达标保持 | `phase=="REPLENISHING"` + **`nitrogenPct < maxPct`** | REPLENISHING + 充氮设备 |
| 11 | 补氮达标转环流 | `phase=="REPLENISHING"` + **`nitrogenPct >= maxPct`** | CIRCULATION + 环流设备 |

守卫 = `paused == false` + `endReached == false`（仅状态迁移规则需要；暂停/结束规则本身就是兜底）。

**规则里没有任何阈值数字**；`maxPct`/`minPct` 全部来自 facts。

### 3.3 平台机制（三条实测结论，直接影响怎么写规则）

| 机制 | 实测结论 | 影响 |
|---|---|---|
| **m1 动作只能写 output** | 给 input 字段赋值报"动作字段无效或重复" | 阈值**不能**算成中间字段（如 `pctAtLeastMax`），必须把比较内联进每条迁移规则 |
| **m4 字段引用仅 BAL 支持，决策表不支持** | `shared/assets.js` 全无 `valueSource` 处理 | 必须用 BAL；决策表仍只能写字面量，因此决策表方案无法满足"阈值随时调整" |
| **m2 salience 高的先执行、低的后执行，后写覆盖** | 两条规则同写 `nextPhase` 时，**salience 低的那条胜出** | 要"压过"别的规则，salience 必须**更低**。故"暂停全关"=60（先）、"到达结束时间完成"=55（后，覆盖暂停） |
| **m3 同一轮内规则无法串接** | `启动充氮` 只写 `nextPhase`、不改 `phase`，所以同轮里 `phase == "FILLING"` 的规则不可能成立 | 需要**驱动器执行到不动点**（见 §3.4） |

> m2 与直觉相反，是本方案唯一容易写反的地方。`platform-issues-and-fixes.md` §2.5 说的"后写覆盖"指的是这个。

### 3.4 驱动器必须执行到不动点

因为 m1 + m3，一次 `/execute` 只能推进一个阶段。要让"启动→达标转环流"在一次决策周期内完成
（否则会先下发一次充氮设备指令、下一 tick 才改成环流指令），驱动器需要循环喂回 `nextPhase`：

```
facts = { warehouseId, phase, circElapsed, endReached, paused,
          nitrogenPct, maxPct, minPct }        # 注意：不含任何阈值结论字段
for round in 1..4:
    out = RES /execute(facts)
    if out.nextPhase == facts.phase: break          # 到不动点
    facts.phase = out.nextPhase
```

实测轨迹：`r1: PENDING→FILLING → r2: FILLING→CIRCULATION → r3: CIRCULATION→CIRCULATION`（停在不动点）。

---

## 4. Layer A 之二：规则流（Rule Group 整包执行）

```
[唯一步骤] 规则组：nitrogen（Rule Group，含 11 条规则）
```

- 步骤类型 `rule-group`，`selector = { packageName: "nitrogen", includeChildren: false }`。
- 快照会把成员规则合成为**完整 DRL**（实测 4986 字符），执行方式与单条规则一致。
- **不要把已废弃的决策表留在 `nitrogen` 包里**：决策表也按 `category` 归包，会被 Rule Group 拉进来一并编译，
  而其产物冻结的 BOM 版本可能已过期 → 规则流编译报"使用 BOM vN，当前为 vM"。本方案已把两个废弃决策表
  移到 `deprecated.nitrogen` 包。

### 4.1 平台缺口修复：RES 原先不接受 `rule-group` 步骤

规则组能编译、能过门禁，但**部署到 RES 被拒**：`发布包步骤类型无效`
（`res/src/main/java/workbench/res/ResServer.java` 只允许 `rule`/`table`）。
已修复：把 `rule-group` 加入允许列表并重建 RES 镜像。规则组步骤本就带完整 DRL，执行逻辑无需改动。

---

## 5. 历史方案留档（已被 §3 的 BAL 方案取代）

早期按决策 D1 采用了"阈值在中控预处理成布尔信号 + 决策表承载迁移"的写法。**该写法已废弃**，
原因是它无法满足"阈值随时调整"：

| 阶段 | 阈值位置 | 改阈值要做什么 |
|---|---|---|
| 最初的驱动代码版 | `control-loop.js` 常量 | 改代码 + 重启服务 |
| 决策表 + 预处理布尔量 | 阈值判断在代码、表只看布尔 | 同样是改代码 + 重启 |
| **现在的 BAL 规则版** | **规则条件内的跨字段比较，阈值来自 facts** | **改参数，立即生效** |

决策表被弃用的直接原因：条件单元格只接受字面量（`shared/assets.js:64 parseConditionCell`
→ `formatDrlValue` → `parseValue` 要求 `Number.isFinite`），写 `>=95` 会把阈值冻进 Release。

两处旧决策表（「充氮状态迁移表」「充氮结束处理表」）asset 仍在，用于历史 Release 可追溯，
但已移到 `deprecated.nitrogen` 包、不参与规则组。

## 6. Layer C：安全告警（CEP / Esper）

与控制链路解耦，**只做"看得见、拦得住"，不做迁移判定**。现有 `project-7c12c971` 的 3 条阶段迁移语句建议**整体停用**（迁移已由 Drools 表 A 负责，两处都写 `NitrogenPhaseEvent` 会导致阶段事件来源分裂）。

| 语句 | 语义 | EPL 要点 |
|---|---|---|
| `N2SafetyInterlock` | 浓度越上限 → 强制关充氮设备 | `select * from NitrogenReading where nitrogenPct >= safetyMaxPct`（阈值走 BOM 字段或字面量），命中即 webhook `alert.fired`，中控收到后强制关 |
| `N2SensorSilence` | 断流检测 | `pattern[every (t=timer:interval(2 minutes) and not NitrogenReading(...))]`，或部署级 listener 的 `clearedAfterMs` 超时型判定 |
| `N2SafetyCleared` | 越限回落解除 | 依赖容器 `alert.cleared` 的超时判定；语义型回落判定（基于窗口聚合值）列为 P2，`dual-engine-architecture-design.md` §10.3 已标注 |

> 断流为什么放 CEP 而不放中控：中控侧的"没收到数据"很容易被误判成"数据没变"。这正是现网 demo 踩过的坑（`demo-acceptance-report.md` §3.9 缺陷 1：环流保持期误报断流）。用部署级 listener 的**最后事件时间 + 超时**判定更可靠。

### 6.1 CEP 侧 BOM（`bom-project-7c12c971.json`，与 Drools BOM 无关）

现网 BOM 已够用，**只需按联锁阈值补一个字段**：

| 事实类型 | kind | 字段 | 说明 |
|---|---|---|---|
| `NitrogenReading` | input（事件类型） | `eventId` / `warehouseId` / `sensorId` / `readingTime` / `nitrogenPct` / `oxygenPct` / `temperature` | 现网已有；`nitrogenPct: Double` 是联锁判定依据 |
| `NitrogenPhase` | output | `phase`(enum) | 现网已有。停用 3 条迁移语句后**不再有新事件写入**，但建议**保留枚举定义**：① 已发布 Release v1–v4 的快照引用了它，删字段会让历史制品语义不完整；② 若后续要接"由平台广播阶段事件"再启用 |
| *(新增可选)* `N2SafetyThreshold` | input | `safetyMaxPct: Double` | 若希望联锁阈值可配而不写死在 EPL 里，需在 CEP BOM 加该字段并由中控随事件上报；**不加**则阈值以 EPL 字面量写死（简单但改阈值要重发 CEP Release） |

**与 Drools BOM 的关系**：无。两边都有 `warehouseId`，取值口径必须一致（O4），但类型定义各写各的、各自校验。

**独立发布验证点（V4）**：改 `bom-project-7c12c971.json`（新增 `safetyMaxPct`）后，**Drools 项目的 Release 与测试不应受任何影响**——用来证明两套 BOM 确实独立。

---

## 7. 回归与验收（复用现有套件框架）

### 7.0 运行时路径与实测契约（决定 demo 怎么写）

**已定：控制循环直连 RES，不经过 Team Server**（沿用 `dograin/demo/README.md` 已确立的"治理面与运行面解耦"原则）。

**已实测的调用契约**：

```
POST http://127.0.0.1:8790/execute
  { releaseId: "<Release ID>", facts: { phase, pctAtLeastMax, pctBelowMin,
                                        circElapsed, endReached, … } }
→ 200 { ok, releaseId, decisionService, version,
        facts: { …输出字段… }, trace: [ { name, type, nodeId, fired, count, facts } ] }
```

实测记录（对现网 PoC Release `5d104ce6-c32f-44e1-8553-79ea255af43b`）：

| 观察 | 结论 |
|---|---|
| 只传 `{phase:"DRAFT"}` 即成功返回 | ✅ RES 直连可用，不需要 Team Server |
| 返回 `facts` 里出现 `nitrogenPct:0.0, maxPct:0.0, minPct:0.0, circulationElapsed:false` | ⚠️ **未传的 key 被引擎按类型补默认值**，不报错 |
| 返回 `nextPhase/genCmd/n2vCmd/cvCmd/fanCmd/reason` + `trace[].fired` | 出参与逐步骤轨迹可直接用于 demo 展示 |
| 未知 key 会报错（`Unknown fact field`，`engine/EngineServer.java:111`） | 拼错 key 不会静默，这点安全 |
| Team Server 路径才校验 `required` / min-max / 枚举（`server/index.js:101`） | **直连 RES 绕过了这层** |

**由此产生 3 条强制补偿（直连方案的代价，必须实现）**：

| # | 补偿 | 不做的后果 |
|---|---|---|
| **C1** | `control-loop.js` 维护"必须传的 key 清单"，每轮发送前断言一个不少（缺则拒绝调用并告警） | `endReached` 漏传 → 默认 `false` → **该结束不结束**；`pctAtLeastMax` 漏传 → **该转环流不转** |
| **C2** | 对返回值做**枚举白名单**断言（`nextPhase` ∈ BOM enum、指令 ∈ `ON/OFF`、`OPEN/CLOSED`） | 引擎类型是 String，写错值不会报错，下游中控可能认不出指令 |
| **C3** | 每次调用记录**发送的 facts 与返回的 facts 全量快照**（含 `trace`） | 出问题时无法复盘"当时到底传了什么"，直连路径又没有 Team Server 审计兜底 |

> C1 是硬要求而非优化项。现网 PoC 返回里 `circulationElapsed` 被默认为 `false`，就是这条缺陷的现场证据——它恰好是"环流期满"信号，默认 false 等于永不进入保氮期。

### 7.1 表 A / 表 B 用例（**已全部实测通过**，2026-10-02）

断言 `nextPhase` 与 4 路设备指令。已在真实 Drools 10.2.0 上执行，命中行与输出全部符合预期。

| # | 输入 facts | 命中行 | 期望（nextPhase / 制氮机 / 充氮阀 / 环流阀 / 风机） | 实测 |
|---|---|---|---|---|
| T1 | `PENDING, paused=f` | 第 1 行 | FILLING / ON / OPEN / CLOSED / ON | ✅ |
| T2 | `FILLING, pctAtLeastMax=t` | 第 3 行 | CIRCULATION / OFF / CLOSED / OPEN / ON | ✅ |
| T3 | `FILLING, pctAtLeastMax=f` | 第 2 行 | FILLING / ON / OPEN / CLOSED / ON | ✅ |
| T4 | `CIRCULATION, circElapsed=t` | 第 5 行 | HOLDING / OFF / CLOSED / CLOSED / OFF | ✅ |
| T5 | `CIRCULATION, circElapsed=f` | 第 4 行 | CIRCULATION / OFF / CLOSED / OPEN / ON | ✅ |
| T6 | `HOLDING, pctBelowMin=t` | 第 7 行 | REPLENISHING / ON / OPEN / CLOSED / OFF | ✅ |
| T7 | `HOLDING, pctBelowMin=f` | 第 6 行 | HOLDING / OFF / CLOSED / CLOSED / OFF | ✅ |
| T8 | `REPLENISHING, pctAtLeastMax=t` | 第 9 行 | CIRCULATION / OFF / CLOSED / OPEN / ON | ✅ |
| T10 | `REPLENISHING, pctAtLeastMax=t, paused=t` | 第 10 行 | PAUSED / OFF / CLOSED / CLOSED / OFF | ✅ |
| T9/T16 | 任意 phase + `endReached=t` | 表 B | COMPLETED / OFF / CLOSED / CLOSED / OFF | ✅ |

> **T2 是本方案的关键回归项**：早期设计在这一点上会给出 `FILLING` 的设备态（充氮阀 OPEN），
> 即"已转环流却仍在充氮"。现在设备态与迁移同行给出，从结构上排除了该缺陷。

### 7.1.2 验证项（V1–V4，已全部实测）

| # | 验证项 | 状态 | 证据 |
|---|---|---|---|
| **V1** | 规则流步骤间 facts 传递：后续步骤读到的是表 A 执行后的值 | ✅ **已验证，并据此改了设计** | 实测确认 `phase` **不会**被更新（只能传 `nextPhase`），故按 §0.2 A1 把设备指令并入表 A |
| **V2** | 表 A / 表 B 的输出字段重叠是受控的 | ✅ 通过 | 两表都写 `nextPhase` 与设备指令；覆盖方向单一（仅 `endReached=true` 时表 B 覆盖），已在流程 `description` 写明 |
| **V3** | `endReached == true` 条件能正确选中表 B | ✅ 通过 | 实测命中「充氮结束处理表 第1行」，`nextPhase=COMPLETED`、全关 |
| **V4** | **两套 BOM 确实独立** | ✅ 通过 | 给 CEP BOM 加 `safetyMaxPct`（v2→v3）后，Drools 侧：门禁仍 **16/16**、BOM 仍 v6、决策表 `analyze` 正常（DRL 4906 字符）、规则流 `compile` 通过、控制 demo 正常执行 |

### 7.1.3 端到端落地实测（2026-10-02）

| 环节 | 结果 |
|---|---|
| 项目 / BOM | `project-63dbe140`（engine=rules），BOM v6，10 入参 / 6 出参 |
| 决策表 | 「充氮状态迁移表」10 行 + 「充氮结束处理表」1 行，均 v3 已发布，真实 Drools 编译通过 |
| 规则流 | 「自动充氮控制规则流」两个公共步骤，v1 已发布，编译通过 |
| 测试套件 | 「自动充氮状态机回归（发布门禁）」16 条用例，`required=true` |
| Release | `f105f634-ea24-4262-a0d1-52604821ac68`（`project-63dbe140/nitrogen-control` v1），**门禁 16/16 通过**，已部署 RES :8790 |
| 控制闭环 | 经 demo 真实驱动：`FILLING → CIRCULATION → HOLDING → REPLENISHING → CIRCULATION → HOLDING → … → COMPLETED`，12 条设备指令，**阀门互斥全程无违规**，结束时间正确收口 |
| 暂停语义 | 暂停 8 秒（虚拟 8 分钟）期间 `circAccumMs` 冻结在 4680000ms 不变、设备全关；继续后从累计值续算 |
| Layer C 联锁 | 事件流「充氮安全告警（联锁 + 断流）」v1，Esper 8.8.0 编译通过，Release `1f232f3e-…`（`project-7c12c971/n2-safety-alarm`）部署 CEP Runtime :8792；实测注入 99.5% 命中 `N2SafetyInterlock`、注入 92% 不命中 |

### 7.2 规则流端到端回放（一次 `sequence` 里的多轮 facts）

按 §2.3 的预处理算法在测试侧手算 `circAccumMs`/`endReached`，构造一条完整环路：

```
PENDING → FILLING → CIRCULATION → HOLDING → REPLENISHING → CIRCULATION → HOLDING → COMPLETED
```

断言每一轮的 `nextPhase` 与设备指令，并插入一轮 `paused=true` 验证全关 + 不迁移。

### 7.3 回归红线（不得破坏）

| 项 | 说明 |
|---|---|
| 现有 rules 项目全链路 | BAL/决策表/规则流/套件/Release 全部不受影响（本次不新增平台能力，只需回归） |
| 现网 CEP 项目 | `project-7c12c971` 停用迁移语句后，安全告警语句仍需可编译 + 可发布 |
| 决策表既有告警 | 表 A 的"重叠"提示需在资产 `description` 说明，不得为了让提示消失而改坏优先级 |

### 7.4 交付物清单（已落地）

| 资产 | 说明 |
|---|---|
| **Drools 项目** `project-63dbe140`（新建，`engine=rules`） | 控制主链路，独立 BOM |
| ├ BOM v6 | `NitrogenControl`（**10 入参**，含 5 个布尔信号）+ `NitrogenCommand`（6 出参） |
| ├ 决策表「充氮状态迁移表」v3 | **10 行**，每行 = 迁移目标 + 原因 + 4 路设备指令 |
| ├ 决策表「充氮结束处理表」v3 | 1 行，`endReached=true` 收口为 `COMPLETED` + 全关 |
| ├ 规则流「自动充氮控制规则流」v1 | **两个公共步骤**（迁移表 → 结束表），无网关 |
| ├ 测试套件「自动充氮状态机回归（发布门禁）」 | **16 条用例**，`required=true`，Release 门禁实测 16/16 |
| └ Release `f105f634-…` | `project-63dbe140/nitrogen-control` v1，已部署 RES :8790 |
| **CEP 项目** `project-7c12c971`（复用，`engine=cep`） | 安全告警链路，独立 BOM |
| ├ BOM v3 | 新增 `safetyMaxPct`（V4 验证用，可后续用于参数化联锁阈值） |
| ├ EventStream「充氮安全告警（联锁 + 断流）」v1 | 越限联锁 + 时间驱动断流检测，Esper 8.8.0 编译通过 |
| └ Release `1f232f3e-…` | `project-7c12c971/n2-safety-alarm` v1，已部署 CEP Runtime :8792 |
| 接口文档 | §2 + §6.1 的两套契约、预处理算法、安全兜底、O1–O5 义务（**给中控/集成商**） |
| **种子脚本**（`rules/scripts/`） | `seed-nitrogen-control.mjs`（项目/BOM/决策表，幂等）<br>`seed-nitrogen-flow.mjs`（规则流草稿）<br>`seed-nitrogen-suite.mjs`（16 条门禁用例）<br>`seed-nitrogen-alarm.mjs`（CEP 安全告警，`--publish` 可发布） |
| **演示应用** | `dograin/n2-control/`，见 §7.5 |
| 平台改动 | `projectAssetDetail` 增加 `versions[]` / `publishedBomVersion`（`server/index.js`）——发布产物冻结的 BOM 版本原先不可见，导致"资产内容没变却需要重发"无法判断 |

### 7.5 演示应用（dograin 侧）

沿用 dograin 既有模式（独立目录 + 单文件 html + 轻代理 server），**不塞进已有目录**：

```
/Users/wallace/project/
├── rules/                          ← 平台本体（不改）
└── dograin/
    ├── demo/         :5188   温控告警（Drools，既有）
    ├── n2-demo/      :5191   充氮 CEP 状态迁移（既有，保留作历史对照）
    └── n2-control/   :5192   充氮 Drools 控制闭环（新增）
        ├── seed-nitrogen-control.mjs   ← API 种子（一次性）
        ├── control-loop.js             ← 状态持有 + 虚拟时钟 + C1/C2/C3 补偿
        ├── demo-server.js              ← 静态托管 + /api/control 代理 RES :8790
        ├── demo.html                   ← 可视化：阶段 / 设备 / 浓度时序 / 迁移日志 / 指令流水
        └── README.md
```

| 设计点 | 决定 | 理由 |
|---|---|---|
| 状态放哪 | **`control-loop.js`（服务端）**，不放浏览器 | 状态放浏览器则刷新即丢；"关阀"这类安全动作不能依赖可能被关掉的标签页 |
| 调用路径 | `demo-server` → **RES :8790 直连** | 与 `dograin/demo` 一致：治理面不承载运行 |
| 时钟 | 可注入**虚拟时钟** | 生产 1 分钟/跳、环流 4 小时；演示需 20 秒内跑完闭环 |
| 与 `n2-demo` 的关系 | **不复用、不改造** | `n2-demo` 演示的是"CEP 做状态迁移"，与本方案要证明的"Drools 做状态迁移"是竞争叙事，都保留便于对照 |
| 演示要证明什么 | ① 一条完整环路；② 暂停/继续且环流计时被冻结；③ 断流/越限走 CEP 联锁强制关阀 | 这三点正是客户需求里最容易做错的地方 |

---

## 8. 决策记录（已定稿）

| # | 决策 | 决议 | 理由 |
|---|---|---|---|
| **D1** | 阈值比较放哪（F1 的直接后果） | **① 仓端中控预处理成布尔量**；否决 ② BAL `raw`、否决 ③ 纳入平台 | 规则只做逻辑、算术留给调用方 → 可回放、可断言、发布物与环境解耦、能用决策表行覆盖率；否决 ② 因阈值进 Release 会绑定参数，否决 ③ 因等于回到路线 B（5–8 周） |
| **D2** | "结束"用规则流网关承载，还是中控侧判掉 | **① 规则流双表**（表 B/B′，内聚可测） | 结束语义属于业务规则，应可治理、可审计；由中控判等于把一条关键规则搬到平台外 |
| **D3** | `paused` 是否进决策表 | **① 进表 A（第 7 行）+ 中控侧同时短路** | 双保险；让"暂停"成为可测试的规则行为 |
| **D4** | 现网 `project-7c12c971` 的 3 条迁移语句 | **① 停用**（不删除，保留历史 Release 可追溯） | 保留会让 `NitrogenPhaseEvent` 有两个来源，运行期必然冲突 |
| **D7** | 阈值判断放哪 | **① 放规则内（BAL `raw` 跨字段比较），阈值作为 facts 参数** | 客户要求阈值"随时调整"：放代码要改代码重启；放决策表字面量会随 Release 冻结。放规则内 + 参数化 = 改参数立即生效，且判定语义归规则治理 |
| **D5** | 项目创建与发布走 API 还是页面 | **API 只做一次性种子；正式 Release 可 API 亦可页面** | 种子保证结构（尤其表 A 的行序）写准且可复现；Release 是治理动作，要走编译门禁 + 套件重跑 + 审计，也正是客户要看的演示动作。种子之后所有变更必须走页面 |
| **D6** | 控制循环运行时调 RES 还是调 Team Server | **① 直连 RES :8790** | 与 `dograin/demo/README.md` 已确立的"治理面与运行面解耦"一致；代价是绕过 `required`/枚举校验，由 §7.0 的 C1–C3 补偿 |

**定稿附带约束**：D1① + D2① 共同决定了"表 A 只判迁移、B/B′ 只定设备态"，该边界不得在实现阶段被合并（理由见 §0.1、§4.3）。D6① 决定了 C1（必传 key 断言）是硬要求——实测已证明漏传 key 会被静默补 `0/false`。

### 8.1 环境前提（执行前需确认）

| 项 | 当前状态 | 需要 |
|---|---|---|
| Team Server | ✅ 已在 **8789** 运行 | 用 API 种子时必须带 `API_PORT=8789`（README 写 8787，与实际不符） |
| 前端 dev server | ❌ 未运行 | 页面发布前需 `npm run dev`（5173） |
| RES :8790 | ✅ 在运行，含 PoC Release `5d104ce6…` | 本次需新建并部署新 Release（现网 PoC 的 `circulationElapsed`、`n2vCmd` 命名按本方案替换） |
| CEP :8792 | ✅ 在运行，已部署 `ff06f66f…` | 新增联锁/断流语句后需重新发布部署 |

## 9. 客户待确认（不阻塞设计，阻塞上线）

| # | 问题 | 默认取值 |
|---|---|---|
| Q1 | 暂停时设备全关还是保持密闭 | 全关 |
| Q2 | 环流 4 小时固定还是按仓可配 | 可配，默认 4h |
| Q3 | 判定周期是否可配；采样频率与断流阈值 | 60s；断流 = 2×采样周期 |
| Q4 | "达到最大"是否含等号 | 含（`>=`） |
| Q5 | 结束时间是绝对时刻还是启动后 N 小时 | 绝对时刻（UTC 存储） |
| Q6 | 到点但浓度未达标是否需要告警/记录 | 需要，`COMPLETED` 带 `finalPct` 与达标标记 |
| Q7 | 安全上限 `safetyMaxPct` 取值 | 待定（如 99%） |
