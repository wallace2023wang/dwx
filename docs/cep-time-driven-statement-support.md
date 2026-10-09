# CEP 时间驱动语句支持需求（Time-Driven Statements）

> 版本：v1.1 ｜ 状态：P0 已实现（2026-10-01） ｜ 关联：
>
> `cep-visual-editor-design.md`
>
>  v1.2、
>
> `dual-engine-architecture-design.md`
>
>  v1.3

## 一、项目背景

DWX 复刻 传统商业规则平台 的产品线中，CEP（复杂事件处理）作为第二引擎（Esper 8.8.0）与 Drools 规则引擎并行。CEP 项目资产链路为：**BOM（eventTypes）→ EventStream（EPL 语句）→ 编译验证 → 测试套件 → Release → 部署（CEP Runtime）→ execute**。

本文档源自 "粮库自动充氮控制" 客户 demo 的路径 B 落地验证：在现有产品内用 **BOM + Esper 规则**组织 "充氮 / 环流 / 保氮 / 补氮" 状态迁移逻辑。验证过程中发现：**现有 EventStream 编译链路不支持时间驱动类语句（**`timer:interval`**&#x20;/&#x20;**`pattern`**）**，导致 "环流满 4 小时 → 保氮" 这类**纯时间条件**无法在引擎内表达。该缺口非自动充氮个性化需求，而是**所有周期巡检、时序检测、定时采样类 CEP 规则的通用前置能力**。

## 二、验证结论（已实证）

以下链路已在现有产品内真实跑通（Esper 8.8.0 真实编译 + 真实执行）：



| 环节          | 资产                                                                                                                                                                                         | 结果                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| CEP 项目      | `project-7c12c971` 粮库自动充氮控制（engine=cep）                                                                                                                                                    | ✓ 创建成功              |
| BOM v2      | `NitrogenReading` 事件（eventId/warehouseId/sensorId/readingTime/nitrogenPct/oxygenPct/temperature）+ `NitrogenPhase` 输出类型（phase 枚举 FILLING/CIRCULATION/HOLDING/REPLENISHING/PAUSED/COMPLETED） | ✓ 写入成功              |
| EventStream | `63461191-b9c2-4c8c-a5af-6477a94f59ff` 自动充氮状态迁移规则（draft→published v1）                                                                                                                      | ✓ 发布成功              |
| Release     | `a767dd77-d3cc-4a93-a387-ff0e2fdc8e04` v1.0.0（engine=esper 8.8.0）                                                                                                                          | ✓ 创建并部署 CEP Runtime |
| 真实执行        | 注入浓度 96 → `NitrogenPhaseEvent {phase: CIRCULATION}`；注入浓度 88 → `NitrogenPhaseEvent {phase: REPLENISHING}`                                                                                   | ✓ 两条迁移语句命中          |

**结论：路径 B 主体可行**—— 充氮→环流（≥95%）、保氮→补氮（<90%）的阈值迁移逻辑已完全由平台治理并可执行输出。

## 三、能力缺口与需求

### 缺口 A（P0）：时间驱动语句不被 EventStream 编译链路支持

**v1.1 状态**：已实现。`validateEventStreamDraft` 已支持 `from pattern[...]` 内事件类型识别、同一 EventStream 内 `insert into <DerivedStream>` 衍生流引用、纯 `timer:*` pattern；CEP Runtime 已改为部署级 listener，timer 异步输出可通过 webhook 派发，不依赖 HTTP 请求仍在等待。

**原现状**：`validateEventStreamDraft` 要求每条 EPL 必须 "通过 from 引用 BOM 事件类型"；以下语句会被拒绝（错误：`第 N 条 EPL 必须通过 from 引用 BOM 事件类型`）：



```
insert into NitrogenPhaseEvent
select 'HOLDING' as phase, a.warehouseId as warehouseId

from pattern\[every (a=NitrogenPhaseEvent(phase='CIRCULATION') -> timer:interval(4 hours))]
```

**影响范围（通用，非个性化）**：



1. 自动充氮 "环流满 4 小时 → 保氮"（纯时间条件）

2. CEP 周期巡检 / 定时采样（`every timer:interval(1 minute)` 关联最新事件做周期判定）

3. `cep-visual-editor-design.md` P1 模板中的**缺席检测**、**双事件时序**（均依赖 pattern + timer）

4. 任何 "事件 A 发生后 N 时间内未发生 B" 类业务规则（超时告警、巡检未到、设备应答超时）

**需求设计**：



* **服务端编译链路**支持时间驱动语句族（至少覆盖）：


  * `from pattern[every timer:interval(<n> <unit>)]`（周期触发）

  * `from pattern[every (<StreamEvent>(<condition>) -> timer:interval(<n> <unit>))]`（进入状态后计时）

  * `from pattern[every (<StreamEvent> -> (timer:interval(<n> <unit>) and not <FollowEvent>(...)))]`（超时 / 缺席检测）

  * `from pattern[every (a=<StreamEvent> -> b=<FollowEvent>(...)) where timer:within(<n> <unit>)]`（双事件时序；`timer:within` 是 Esper guard，不是 observer）

* 校验规则从 "必须 from 引用 BOM 事件类型" 放宽为 "from 引用 BOM 事件类型 **或** pattern 表达式内引用 BOM 事件类型 / 同模块衍生流 / 纯 timer pattern"，pattern 内引用的流类型需在 BOM eventTypes / 已注册衍生流中。

* **时间语义统一声明**：所有 `timer:*` 均按处理时间（系统时钟）推进，不按 eventTime 回放（当前无外部时钟，与 `dual-engine-architecture-design.md` §10.4 一致）。

* **验收标准**：

1. 上述 pattern 语句可通过服务端校验并在 CEP Runtime 真实编译（Esper 8.8.0）

2. 周期触发语句在测试套件中可断言（`events: [] + waitMs` 等待处理时间推进后检测周期输出）

3. 现有 rules / 已有 CEP 语句（窗口聚合类）回归不受影响

4. 部署运行时的 timer 输出可由部署级 listener 捕获并通过 webhook 推送；不要求调用方在 `/events` 请求中等待完整计时周期

**范围界定**：v1 仅支持单语句内 pattern；多语句状态协作、外部时钟、事件时间回放明确排除在 v1 外。

### 缺口 B（P1）：状态迁移事件去重

**现状**：`#lastevent()` 阈值语句对窗口内每事件输出（浓度持续 ≥95% 时，每分钟注入都重复输出 `CIRCULATION`），引擎无 "仅在状态变化时触发" 语义。

**需求设计（通用）**：



* 语句支持 "去重输出" 声明，例如 `output first per warehouseId within 24h` 或语句级 `dedupe: true + keyFields`，仅当分组键下结果状态变化（如 phase 值变化）时输出。

* 未实现前，消费侧（测试套件断言 /demo 前端）按 `lastPhase != phase` 去重，文档标注该约定。

### 缺口 C（P2，历史 Demo 范围）：暂停 / 恢复

Esper 无原生 "暂停实例" 语义。决策计划实例（plan）绑定 Release、pause/resume 与状态持久化只保留为历史 demo 方案，不进入产品路线；demo 阶段用“停止注入事件 + 前端阶段标志”模拟。

## 四、建议落地顺序



1. 缺口 A 已作为 **CEP 引擎通用能力**落地（与 Visual EPL Builder 模板验证合并：先让 pattern/timer 模板在真实 Esper 过编译，再开放 UI）

2. 自动充氮 demo：先用现有能力闭环（阈值迁移由引擎输出，环流→保氮由 demo 前端定时模拟，文档标注 "待缺口 A 落地后迁移到引擎"）

3. 缺口 B 随 EventStream 输出协议演进；缺口 C 归 v2

## 五、验证方式与缺口说明



* 已实证：BOM/EventStream/Release/ 部署 / 执行全链路，真实输出见上文表格

* 已实证：pattern/timer 语句的 Esper 真实编译与执行语义；`a=NitrogenPhaseEvent -> timer:interval(1 seconds)` 在真实 `/test` 中可输出 `HOLDING`；部署级 listener 可在 `/events` 请求结束后继续捕获 timer 输出并通过 webhook 推送

* 已归档（可启用）：`N2CirculationToHolding` 语句草案（见下）



```
\-- 环流满 4 小时 → 保氮（待缺口 A 支持后启用）

insert into NitrogenPhaseEvent
select a.warehouseId as warehouseId, 'HOLDING' as phase

from pattern\[
  every (
    a=NitrogenPhaseEvent(phase='CIRCULATION')
    -> (
      timer:interval(4 hours)
      and not NitrogenPhaseEvent(warehouseId = a.warehouseId, phase != 'CIRCULATION')
    )
  )
]
```
