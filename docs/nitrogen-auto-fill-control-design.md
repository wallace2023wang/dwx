# 自动充氮控制落地方案（历史 Demo 设计，已移出产品范围）

> 2026-10-08 范围决策：运行期决策计划实例、暂停/继续和热调参仅用于演示验证，不作为当前产品需求。本文保留用于历史追溯，不代表待开发承诺。

> 版本：v1.0 ｜ 状态：设计方案，待评审 ｜ 日期：2026-10-02
> 关联：`dual-engine-architecture-design.md`、`platform-issues-and-fixes.md`、`demo-acceptance-report.md`、`cep-time-driven-statement-support.md`、`ruleflow-editor-design.md`、`requirements-bom.md`
> 客户原始需求：开始/结束时间 + 最大/最小氮气浓度；充氮→环流→保氮→补氮 循环，直到结束时间；过程中可随时暂停/继续。

---

## 1. 需求结构化（原文 → 可判定条款）

把客户描述拆成 6 条可验证的行为，后面所有设计都对着这张表走：

| # | 客户原文 | 可判定条款 | 触发的输出 |
|---|---|---|---|
| R1 | 开启自动充氮，系统打开制氮机、对应的阀门以及风机，进入充氮期 | 启动即置 `FILLING`，制氮机 ON、充氮阀 OPEN、环流阀 CLOSED、环流风机 ON | 阶段 + 4 路设备指令 |
| R2 | 每隔 1 分钟判断当前氮气浓度是否大于最大氮气浓度；大于最大时关制氮机、关充氮阀、开环流阀环流，进入环流期 | **周期驱动（1 min）** 的阈值判定：`pct >= maxPct` → `CIRCULATION` | 阶段 + 4 路设备指令 |
| R3 | 环流 4 小时后停止环流，进入保氮期 | **持续时长驱动**（非事件驱动）：环流累计 ≥ 4h → `HOLDING` | 阶段 + 全关 |
| R4 | 持续判断浓度，小于最小氮气浓度时开制氮机、充氮阀补氮，进入补氮期 | 保氮期 `pct < minPct` → `REPLENISHING` | 阶段 + 4 路设备指令 |
| R5 | 浓度到达最大时停止充氮，进行环流，持续循环直到结束时间 | 补氮期 `pct >= maxPct` → `CIRCULATION`；回到 R3，形成环路；`now >= endAt` → `COMPLETED` | 阶段 + 全关 |
| R6 | 充氮过程中可随时暂停/结束充氮，暂停后可继续充氮 | 运行期任意时刻 `pause` → `PAUSED`（设备全关、记忆暂停前阶段）；`resume` → 回到暂停前阶段；`stop` → `COMPLETED` | 阶段 + 全关 |

### 1.1 需求本身带出的 5 个隐含约束（客户没明说，但必须定）

| 编号 | 隐含约束 | 处理方式 |
|---|---|---|
| H1 | **环路无终止条件**：R3→R4→R5 会无限循环 | 靠 `endAt` 终止；每个周期决策都必须先判结束时间（优先级最高） |
| H2 | **暂停必须记忆阶段**：R6 说"暂停后可继续"，但没说要回到哪 | 实例上保存 `pausedFromPhase` + 暂停时刻，恢复时回到该阶段（见 §3.3） |
| H3 | **环流是"累计时长"而非"进入即计时"**：若在环流中暂停 2 小时，4 小时不应含暂停时间 | 实例维护 `circAccumMs`，只累加运行中的环流时长（见 §3.3） |
| H4 | **"大于最大"与"到达最大"口径不一致**：R2 说"大于"，R5 说"到达" | 统一为闭区间 `pct >= maxPct`（与现网规则 `NitrogenControl` 已有实现一致），避免 `pct == maxPct` 时卡在充氮期 |
| H5 | **设备互斥铁律**：充氮阀与环流阀不能同时 OPEN（制氮/环流是两种互斥工况） | 规则包内做联锁校验；运行时下发指令前再做一次互斥断言（见 §3.5） |

---

## 2. 方案判据：这是"决策计划"问题，不是"事件模式"问题

客户提出过"能不能用 CEP（Esper）做"，本项目也已有 CEP 引擎和一份充氮 PoC。这里必须先把边界判清楚，否则会选错引擎、写错资产。

| 判据 | 自动充氮（本需求） | 真正的 CEP（如氨气/温控告警、断流检测） |
|---|---|---|
| 主要驱动 | **时钟**（每 1 分钟 / 满 4 小时）+ 当前状态 | 事件流之间的时间关联（窗口聚合、A→B 时序、缺席） |
| 是否有外界业务实例 | **有**：一个仓一次充氮任务 = 一个需持久化的实例（阶段、起止时间、阈值、暂停点、累计环流时长） | 无：检测是无状态的流式判定 |
| 输出是什么 | **设备控制指令**（制氮机/阀门/风机），要求幂等、互斥、可回执 | 告警事件，要求 fired/cleared 推送 |
| 暂停/继续 | **一等语义**：引擎侧必须能冻结实例并保留状态 | 通常不需要 |
| 失败恢复 | 实例必须能从进程重启中恢复（否则阀门状态失控） | 可接受丢窗口状态 |

**结论：状态迁移判定用规则引擎（Drools/RES），不能用 Esper 表达。** 理由：

1. Esper 无"暂停实例"语义（`cep-time-driven-statement-support.md` §三 缺口 C 已确认：Esper 无原生暂停，需 plan 层承载）；用前端停发事件模拟在真实中控里不成立——传感器一直在采样。
2. `timer:interval` 只能表达"相对某事件后 N 时间"，无法表达"到 `endAt` 结束""暂停期间冻结计时"这类**实例生命周期**语义。
3. 设备指令需要幂等与互斥保证，跑在无状态/易丢态的流式引擎上无法审计。
4. 环流累计时长是**实例状态**，不是事件模式。

CEP 在本需求中仍有明确位置，但**职责是告警，不是控制**（见 §6.3）：浓度越上限（安全联锁）、传感器断流、补氮超时。

> 与既有结论一致：`dual-engine-architecture-design.md` §9 Step 0 与 `platform-issues-and-fixes.md` §0.2 均已判定"自动充氮控制属于规则侧状态机 + 定时器 + 暂停/继续，不并入 CEP v1"。本方案把该结论落地为可开发的契约。

---

## 3. 总体方案：规则项目 + 决策计划实例（Decision Plan Instance）+ 驱动器

### 3.1 三条落线（职责分离）

```
┌─ 控制面：Team Server（治理）──────────────────────────────────────┐
│  BOM（NitrogenControl / NitrogenCommand）                          │
│  规则包 nitrogen-control（7 条状态迁移规则，参数化阈值）              │
│  测试套件（阶段迁移断言 + 实例驱动端到端用例）                        │
│  Release（Drools 10.2.0，不可变 + checksum + 门禁）                 │
│  ──────────────────────────────────────────────────────────────  │
│  【新增】决策计划实例（Decision Plan Instance）                     │
│    实例 = Release 绑定 + 业务参数 + 运行状态 + 指令流水             │
└──────────────────────────────────────────────────────────────────┘
              │ 按 project.engine 路由（已有能力）
              ▼
┌─ 执行面：RES / Drools（纯判定，无状态）────────────────────────────┐
│  输入：RuleInput{ phase, nitrogenPct, maxPct, minPct,             │
│                   startAt, endAt, now, circElapsed }              │
│  输出：RuleInput{ nextPhase, genCmd, fillValveCmd,               │
│                   circValveCmd, fanCmd, reason }                  │
│  一次执行 = 一个仓的一次周期决策（不保存任何跨周期状态）             │
└──────────────────────────────────────────────────────────────────┘
              ▲ 每 1 分钟喂一次（读浓度）
              │
┌─ 驱动面：实例驱动器（Instance Driver，Team Server 内调度）──────────┐
│  1) 扫描到期的 RUNNING 实例 → 2) 读该仓最新浓度 → 3) 算 now/circElapsed│
│  4) 调 RES /execute → 5) 落库实例状态 + 指令流水 → 6) 推送设备指令    │
└──────────────────────────────────────────────────────────────────┘
              │ 设备指令（webhook）/ 浓度上报（HTTP）
              ▼
┌─ 接入面：粮库中控适配器 ────────────────────────────────────────────┐
│  收指令 → 设备动作（含互斥/失败处理）→ 回执 → 上报浓度采样           │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 实例模型（新增能力，纯通用）

```ts
interface DecisionPlanInstance {
  id: string
  projectId: string
  releaseId: string            // 绑定不可变 Release，规则与 BOM 版本随 Release 冻结
  planKey: string              // 如 'nitrogen-auto-fill'，一个项目可有多种计划
  scope: Record<string, unknown> // 业务键，如 { warehouseId: 'W-01', granaryId: 'G-3' }
  params: Record<string, unknown> // 本次任务参数：maxPct / minPct / startAt / endAt / circDurationMs / tickMs
  status: 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'TERMINATED' | 'FAILED'
  phase: string                // 计划自身的业务阶段（如 FILLING / CIRCULATION / HOLDING / REPLENISHING）
  pausedFromPhase?: string     // 暂停前阶段（H2）
  deviceState: { genCmd: string; fillValveCmd: string; circValveCmd: string; fanCmd: string }
  readings: { latest: number | null; latestAt: string | null }  // 最新浓度（由上报或拉取写入）
  phaseStartedAt: string       // 当前阶段进入时刻
  circAccumMs: number          // 环流累计运行时长（H3）
  lastTickAt?: string
  nextTickAt?: string
  tickSeq: number              // 周期序号，用于指令幂等（见 §3.5）
  commandLog: Array<{ seq: number; at: string; phase: string; commands: Record<string, string>; reason: string; deliveredAt?: string; ackedAt?: string }>
  revision: number             // 乐观锁
  createdAt: string; updatedAt: string; updatedBy: string
}
```

实例是**通用平台能力**，不是充氮专属：任何"长时任务 + 周期判定 + 状态迁移 + 可暂停"的场景（熏蒸、通风降温、气调储粮、烘干）都复用同一模型，只是 `planKey` 与绑定的 Release 不同。

### 3.3 状态机与时间语义（把隐含约束固化成契约）

```
                 start (now>=startAt)                pct >= maxPct
   PENDING ────────────────────────► FILLING ──────────────────────► CIRCULATION
                                          ▲                                │
                                          │ pct >= maxPct                  │ circAccumMs >= circDurationMs
                                          │                                ▼
                                   REPLENISHING ◄───────────────────── HOLDING
                                          │ pct < minPct
   ┌──────────────────────────────────────┴───────────────────────────────────┐
   │ 任意运行期：pause → PAUSED（设备全关，记 pausedFromPhase）                  │
   │            PAUSED --resume--> pausedFromPhase（环流计时从累计值续算）        │
   │ 任意状态：stop → TERMINATED（设备全关）                                     │
   │ 任意运行期：now >= endAt → COMPLETED（设备全关，优先级最高）                  │
   └──────────────────────────────────────────────────────────────────────────┘
```

时间语义（**必须在契约里写死，否则实现会各写一套**）：

| 项 | 定义 |
|---|---|
| `now` | 驱动器生成 UTC ISO-8601 字符串（毫秒 + `Z`），与 `startAt/endAt` 同格式，字典序即时间序 |
| 周期 | `tickMs` 默认 60000（客户要求 1 分钟）；驱动器只按需触发，不用 Cron 语义 |
| 环流计时 | `circAccumMs += now - max(phaseStartedAt, lastTickAt)`，仅当 `phase == CIRCULATION && status == RUNNING`；暂停期间不累加（H3） |
| 结束判定 | `now >= endAt` 在每条规则中优先级最高（salience 最大），任何阶段都直接 `COMPLETED` |
| 暂停期间 | **不执行任何周期决策**（实例从扫描队列摘除），避免暂停时浓度变化触发迁移 |
| 时区 | 实例内一律 UTC 存储，展示层按仓所在时区渲染；禁止混存本地时间字符串 |
| 恢复 | 重启后从 `lastTickAt` 起补一次决策（不补历史每一次），并按 `tickSeq` 保证指令不重放 |

### 3.4 资产清单（可直接建到现有项目里）

**BOM（复用现有 `project-93d1309c` 的 `NitrogenControl` / `NitrogenCommand`，按本方案微调）**

输入事实 `NitrogenControl`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `phase` | String(enum) | `PENDING`/`FILLING`/`CIRCULATION`/`HOLDING`/`REPLENISHING`/`COMPLETED` |
| `nitrogenPct` | Double | 最新氮气浓度 |
| `maxPct` | Double | 最大浓度（参数） |
| `minPct` | Double | 最小浓度（参数） |
| `startAt` / `endAt` | String | 任务起止时间（UTC ISO-8601） |
| `now` | String | 本次决策时刻 |
| `circElapsed` | Boolean | 环流累计是否已满（由驱动器算好，规则不做时长运算） |
| `pctValid` | Boolean | 浓度是否有效（传感器故障保护，见 §8 Q7） |

输出事实 `NitrogenCommand`：`nextPhase`、`genCmd`、`fillValveCmd`、`circValveCmd`、`fanCmd`、`reason`。

> 命名说明：现网 PoC 用的 `n2vCmd` 经实测在 Drools 可编译（Drools 属性访问器与平台生成的 `setN2vCmd` 一致），但不符合 JavaBean 大小写惯例，建议改为 `fillValveCmd` / `circValveCmd` 以免后续换引擎（如 KIE/Spring 绑定）踩坑。

**规则包 `nitrogen-control`（7 条，salience 从高到低）**

| # | 规则 | 条件 | 动作（nextPhase / 设备） | salience |
|---|---|---|---|---|
| 1 | 到达结束时间完成 | `now >= endAt` | `COMPLETED`；全关 | 70 |
| 2 | 暂停/传感器故障保护 | `status == PAUSED 或 pctValid == false` | 保持当前阶段；全关 | 60 |
| 3 | 启动充氮 | `phase == PENDING && now >= startAt` | `FILLING`；制氮机 ON、充氮阀 OPEN、环流阀 CLOSED、风机 ON | 50 |
| 4 | 充氮达标转环流 | `phase == FILLING && nitrogenPct >= maxPct` | `CIRCULATION`；制氮机 OFF、充氮阀 CLOSED、环流阀 OPEN、风机 ON | 40 |
| 5 | 环流期满转保氮 | `phase == CIRCULATION && circElapsed == true` | `HOLDING`；全关 | 30 |
| 6 | 保氮过低转补氮 | `phase == HOLDING && nitrogenPct < minPct` | `REPLENISHING`；制氮机 ON、充氮阀 OPEN、环流阀 CLOSED、风机 OFF | 20 |
| 7 | 补氮达标转环流 | `phase == REPLENISHING && nitrogenPct >= maxPct` | `CIRCULATION`；制氮机 OFF、充氮阀 CLOSED、环流阀 OPEN、风机 ON | 10 |

实现要点：

- 跨字段比较（`nitrogenPct >= maxPct`、`now >= endAt`）用 BAL 的 `raw` 条件表达，平台 `validateRule` 已放行 raw 并由 `generateDrl` 原样拼进 `RuleInput( ... )`——**本轮已用真实 Build Service（`POST 127.0.0.1:8788/compile`）实测含 `setFillValveCmd` 新命名与 `now >= endAt` 的完整 DRL，返回 `{"ok":true,"version":"10.2.0"}`**，无需改引擎。
- 规则包必须**自排除**：同一输入只能命中一条迁移（阶段条件互斥 + 结束/暂停规则高优先级）。现网 7 条规则已符合这一点，但需在规则包 `description` 里写明"任意两条不可同时命中"，作为评审检查项。
- 不把时长比较写进规则（Drools 里做时间运算既难测也不可审计），`circElapsed` 由驱动器算好输入。

**测试套件（复用现有参数化套件）**

| 用例 | 输入 | 期望 |
|---|---|---|
| 启动 | `PENDING, now>startAt` | `nextPhase=FILLING`，4 路指令正确 |
| 充氮达标 | `FILLING, pct=maxPct` | `CIRCULATION`，充氮阀 CLOSED、环流阀 OPEN |
| 未达标不迁移 | `FILLING, pct=maxPct-0.1` | 无迁移 |
| 环流期满 | `CIRCULATION, circElapsed=true` | `HOLDING`，全关 |
| 保氮过低 | `HOLDING, pct<minPct` | `REPLENISHING` |
| 补氮达标 | `REPLENISHING, pct=maxPct` | `CIRCULATION` |
| 结束时间优先 | `FILLING, now>endAt` | `COMPLETED`（验证优先级，不被规则 4 抢） |
| 暂停保持 | `PAUSED, pct>maxPct` | 全关且不迁移 |
| 边界等值 | `pct == maxPct` | 迁移（H4 口径固化） |

**新增实例侧用例（驱动器端到端，不进 RES 套件）**：以可注入时钟跑"1 分钟 × N 个 tick"的时序回放，断言阶段序列为 `PENDING→FILLING→CIRCULATION→HOLDING→REPLENISHING→CIRCULATION→…→COMPLETED`，并在中途插入 pause/resume 断言环流累计时长被扣除。

### 3.5 指令契约（幂等、互斥、可回执）

设备指令是**有副作用的物理动作**，必须有比普通规则输出更严的契约：

| 要求 | 做法 |
|---|---|
| 幂等 | 指令键 `{instanceId, tickSeq, phase}`；接收方按该键去重，重复投递只执行一次 |
| 单次决策只下发一次 | 仅当 `phase != nextPhase` **或** 4 路指令相对 `deviceState` 发生变化时才推送（浓度每分钟都在变，但设备指令不该每分钟重发） |
| 互斥断言 | 下发前校验 `!(fillValveCmd == OPEN && circValveCmd == OPEN)`，违反则**不下发**、把实例置 `FAILED` 并告警（H5） |
| 回执 | 接收方回执 `{instanceId, tickSeq, applied: true/false, error?}`；失败按指数退避重试（最多 5 次），仍失败则实例 `FAILED` 并保留 `deviceState` 供人工处置 |
| 审计 | 每次下发与回执都进 `commandLog` + 平台审计事件（谁、何时、为什么迁移） |
| 安全联锁 | 浓度越上限（如 ≥ 安全值）时由 CEP 告警通道触发**强制关充氮设备**，优先级高于本方案任何规则（见 §6.3） |

### 3.6 浓度数据来源（必须二选一，写进契约）

| 方案 | 说明 | 适用 |
|---|---|---|
| A. 业务上报（推荐） | 中控按 `POST /api/plan-instances/:id/readings` 上报 `{ at, nitrogenPct, valid }`；驱动器只读实例最新值 | 已有采集系统，实时性由采集侧保证 |
| B. 驱动器拉取 | 登记 `readingSource: { url, field, timeoutMs }`，驱动器每分钟拉一次 | 采集系统只提供查询接口 |

无论哪种，**"没有新浓度"与"浓度为 0"必须区分**：超时未更新 → `pctValid=false` → 规则 2 保护性全关 + 断流告警，绝不按旧值继续充氮（这是真实中控最危险的一类缺陷，现有 CEP demo 已踩过"断流误报"，此处从设计上规避）。

---

## 4. 缺口清单（按"今天能不能做"盘点真实代码）

| 编号 | 缺口 | 现状（已核实） | 优先级 |
|---|---|---|---|
| G1 | 决策计划实例模型（实例/阶段/参数/设备态/指令流水） | 完全缺；平台只有资产级 revision，无"运行中的业务实例"概念 | **P0** |
| G2 | 周期驱动器（每 1 分钟触发判定、算 `circElapsed`、算 `now`） | 完全缺；`server/index.js` 无任何 schedule/timer，规则执行是请求驱动 | **P0** |
| G3 | 暂停/继续/终止的实例级语义与 API | 完全缺；`grep pause\|resume` 在 `shared/`、`server/` 零命中 | **P0** |
| G4 | 迁移后重新判定（改完 `phase` 需再跑一轮拿到新阶段指令） | 缺；RES `/execute` 单次求解，平台未做"重复执行到不动点" | **P0** |
| G5 | 设备指令下发契约（webhook + 幂等键 + 回执 + 互斥断言） | CEP 侧有 webhook fired/cleared 可借鉴，RES/实例侧没有 | P1 |
| G6 | 实例并行/多仓隔离 | 缺；现网 BOM 有 `warehouseId`，但实例层还没按仓隔离 | P1 |
| G7 | 实例可观测（阶段时间线、指令流水、异常重放） | 缺 | P1 |
| G8 | 跨字段比较（`pct >= maxPct`、`now >= endAt`） | **已有**：`raw` 条件直通 DRL，已实测编译通过 | 无（回归项） |
| G9 | 时间驱动 CEP 语句（`timer:interval`） | **已有**（`cep-time-driven-statement-support.md` 缺口 A 已落地） | 无（用于告警通道） |
| G10 | 参数化测试套件 + 门禁 | **已有** | 无 |

> G4 容易被漏掉：当前 RES 一次 `/execute` 只求解一轮，`phase=FILLING → CIRCULATION` 后不会自动再跑。若驱动器只调一次就取指令，会把"充氮期的开阀指令"当成"环流期的指令"下发——这是一个会真实开关错阀门的缺陷，必须在驱动器里做成**执行到不动点（最多 N 轮，检测 phase 不再变化）**。

---

## 5. 与规则集（Rule Flow）的关系

| 维度 | 规则集（现有） | 决策计划实例（本方案） |
|---|---|---|
| 生命周期 | 单次请求内跑完（毫秒级） | 跨天/跨周持续运行 |
| 状态 | 无（步骤间只传 facts） | 实例持久化状态（阶段、暂停点、累计时长） |
| 时间 | 无定时器 | 周期驱动器 |
| 中断 | 无 | pause/resume/stop 一等语义 |

**不建议把控制逻辑做成规则集**：规则集的设计目标是"资产编排 + 冻结依赖版本"，`ruleflow-editor-design.md` 明确不是 BPMN/jBPM，无定时器、无人工任务、无实例状态。把实例语义塞进规则集会让发布冻结、门禁和报告全部变形。现有 `project-93d1309c` 里的"自动充氮控制规则集"是 PoC 编排演示，可作为**规则包的打包方式**保留，但运行期状态必须由实例承载。

---

## 6. 分阶段实施

### 阶段 1（P0，通用能力）：决策计划实例 + 驱动器

不碰客户业务逻辑，先把"能跑起来且不怕重启"的底座做出来。

- `shared/plan-instances.js`：实例模型、状态迁移、互斥校验、乐观锁 revision。
- `data/plan-instances.json` + `server/migrations/007_plan_instances.sql`（`plan_instances` 表 + `plan_instance_commands` 指令流水表），沿用现有 JSON/PG 双存储模式。
- `server/plan-driver.js`：单进程调度循环（`setInterval` 或 `nextTickAt` 最小堆），支持配置 `PLAN_DRIVER_ENABLED`、`PLAN_DRIVER_TICK_MS`；先用单实例保护（多副本需 advisory lock，列为 P1）。
- API：

| 端点 | 说明 |
|---|---|
| `POST /api/projects/:id/plan-instances` | 创建实例（绑定 releaseId + params + scope），`status=PENDING` |
| `GET /api/projects/:id/plan-instances?status=` | 列表（按项目隔离） |
| `GET /api/plan-instances/:id` | 详情（阶段、设备态、剩余时间、指令流水） |
| `POST /api/plan-instances/:id/start` \| `/pause` \| `/resume` \| `/terminate` | 生命周期操作；`pause` 记 `pausedFromPhase`，`resume` 回到该阶段 |
| `POST /api/plan-instances/:id/readings` | 上报浓度（数据来源 A） |
| `POST /api/plan-instances/:id/commands/:seq/ack` | 设备指令回执 |
| `GET /api/plan-instances/:id/timeline` | 阶段/指令时间线（可选，或并入详情） |

- 驱动器单周期算法（**含 G4 防护**）：

```
for each instance where status==RUNNING and nextTickAt <= now:
    input = { ...params, ...scope, phase, nitrogenPct: latestOrValid(),
              now: iso(now), circElapsed: circAccumMs >= circDurationMs }
    for round in 1..3:                       # 执行到不动点
        out = RES /execute(releaseId, input)
        if out.nextPhase == input.phase: break
        append (input.phase -> out.nextPhase) to lineage
        input.phase = out.nextPhase
    persist phase/deviceState/commandLog/circAccumMs/tickSeq
    if commands changed: push(webhook, {instanceId, tickSeq, phase, commands, idempotencyKey})
    if phase == COMPLETED: status = COMPLETED
```

- 验收：单测覆盖 §3.3 全部时间语义；杀进程重启后实例从 `lastTickAt` 正确续跑。

### 阶段 2（P0，业务资产）：氮气规则包与套件

- BOM：`NitrogenControl` / `NitrogenCommand`（§3.4）。
- 7 条 BAL 规则，打包 `nitrogen-control`，发布并跑 §3.4 的 9 个套件用例，门禁 9/9。
- 参数化：`maxPct` / `minPct` / `circDurationMs` / `startAt` / `endAt` 全部走实例 `params`，规则内零硬编码——同一规则包服务所有仓。
- 实例侧端到端回放用例：注入虚拟时钟，断言完整阶段序列与暂停扣除。
- 验收：`POST /plan-instances` 起一个仓 → 观察 `PENDING→FILLING→CIRCULATION→HOLDING→REPLENISHING→CIRCULATION→…→COMPLETED`，中断点用 `pause/resume` 验证 `circAccumMs` 未把暂停时长算进 4 小时。

### 阶段 3（P1，对接与安全）

- 中控适配器对接：设备指令 webhook + 回执 + 重试；浓度上报/拉取二选一。
- 安全联锁：浓度越上限（可配 `safetyMaxPct`）→ CEP 事件流检测 → 强制关充氮设备 + `alert.fired`；回落 → `alert.cleared`。复用现有 Esper 能力与 webhook，不新增引擎。
- 实例时间线页面（阶段甘特 + 指令流水 + 异常标注），以及报告分支：项目报告增加"运行实例/指令审计"章节。
- 多仓并发：`scope.warehouseId` 隔离 + 驱动器分片（多副本时用 PG advisory lock 保证一个实例只被一个驱动进程推进）。

---

## 7. 验收标准

| # | 验收项 | 判定 |
|---|---|---|
| A1 | 状态机完整性 | 7 条规则两两不可同时命中；任意 `(phase, pct, now, circElapsed)` 组合最多一条迁移 |
| A2 | 优先级正确 | `now >= endAt` 在 FILLING/CIRCULATION/HOLDING/REPLENISHING 四个阶段都被验证为最高优先级 |
| A3 | 边界口径 | `pct == maxPct` 迁移、`pct == minPct` 不补氮（严格小于），与客户确认后固化 |
| A4 | 环路可持续 | 连续 ≥ 3 轮 `HOLDING→REPLENISHING→CIRCULATION→HOLDING` 迁移正确，无阶段错乱 |
| A5 | 暂停语义 | 暂停期间无任何迁移、设备全关；恢复回到 `pausedFromPhase`；环流累计不含暂停时长 |
| A6 | 结束语义 | 到 `endAt` 后实例 `COMPLETED`，设备全关，驱动器不再调度 |
| A7 | 重启恢复 | 驱动器进程重启后实例阶段与设备态一致，指令不重放（`tickSeq` 幂等） |
| A8 | 互斥与故障 | 构造 `fillValveCmd=OPEN && circValveCmd=OPEN` 场景 → 拒绝下发 + `FAILED` + 告警 |
| A9 | 数据缺失 | 浓度超时未更新 → `pctValid=false` → 保护性全关 + 断流告警，不按旧值继续充氮 |
| A10 | 治理 | Release 不可变 + checksum + 套件门禁；指令流水与阶段迁移全部可审计、可回放 |

---

## 8. 待客户确认（阻塞设计冻结）

| # | 问题 | 影响的契约 | 我的建议默认值 |
|---|---|---|---|
| Q1 | 暂停时设备是否全关？还是保持当前密闭状态？ | `pause` 动作与 H2 | 全关（最安全），恢复时按目标阶段重开 |
| Q2 | 环流 4 小时是固定值还是按仓/粮情可配？ | `circDurationMs` 是否参数化 | 参数化，默认 4h |
| Q3 | 1 分钟判定周期是否可配？传感器采样频率是多少？ | `tickMs`、断流阈值 | `tickMs=60s`，断流阈值 = 2×采样周期 |
| Q4 | "大于最大"是否包含等于？"到达最大"是否包含等于？ | H4、A3 | 统一 `>=` |
| Q5 | 结束时间是绝对时刻还是"启动后 N 小时"？跨零点如何处理？ | `endAt` 语义、时区 | 绝对时刻（UTC 存储），跨零点自然支持 |
| Q6 | 是否需要"到结束时间但浓度未达标"的告警/记录？ | 报告与告警通道 | 需要，`COMPLETED` 时带 `finalPct` 与达标标记 |
| Q7 | 浓度传感器故障/断流时的处置？ | `pctValid`、A9 | 保护性全关 + 告警，等人工确认后继续 |
| Q8 | 多仓并发规模（几十/几百仓）？ | 驱动器分片方式 | 先单进程单分片，按仓键哈希分片预留 |
| Q9 | 设备指令接收方与协议（webhook 地址、是否需要 MODBUS/OPC 网关）？ | §3.5 指令契约 | 先 webhook + 回执，网关由中控侧实现 |
| Q10 | 暂停是否有最长时长/是否需要超时自动结束？ | 实例状态迁移 | 默认无限期暂停，仅告警提示 |

---

## 9. 方案取舍说明（为什么不是另外两条路）

| 备选 | 不采用的原因 |
|---|---|
| 纯 CEP（Esper EventStream 表达全部逻辑） | 无法表达实例生命周期、暂停、跨天累计时长；设备指令缺少幂等与审计；`dual-engine-architecture-design.md` §9 已判定不并入 CEP |
| 纯前端/外部 demo 模拟（现有 `n2-demo` 做法） | 适合演示，不适合真实中控：停发事件≠暂停（传感器仍在采样），进程重启丢失状态，无审计 |
| 规则集承载实例 | 规则集无定时器/无实例状态，塞进去会破坏发布冻结与门禁语义（§5） |
| 直接上 BPMN/jBPM | 与"双引擎 + 资产治理"产品形态不符，且本需求的状态机只有 7 个迁移，引入流程引擎是过度设计 |

## 10. 工作量与排期建议

| 阶段 | 内容 | 估时（1 人） |
|---|---|---|
| 1 | 实例模型 + API + 驱动器 + 单测（通用能力） | 4–6 天 |
| 2 | BOM + 7 规则 + 套件 + 端到端回放用例 | 2–3 天 |
| 3 | 指令 webhook/回执 + 安全联锁 + 时间线页面 + 报告分支 | 4–5 天 |

阶段 1 与 2 可并行（2 之前先冻结 Q1–Q5 的契约）。阶段 3 依赖中控适配器就绪。
