# 自动充氮 CEP Demo —— 验收体验报告与产品优化建议

版本：v1.1  
日期：2026-10-01  
角色：测试验收（端到端实际操作者）  
关联：`dual-engine-architecture-design.md`、`cep-visual-editor-design.md`、`cep-time-driven-statement-support.md`、`platform-issues-and-fixes.md`

---

## 1. 项目背景

DWX 是复刻 传统规则治理与执行平台 的规则与决策管理平台，采用**双引擎**架构：rules 项目（Drools RES）与 CEP 项目（Esper 容器）隔离。

本次验收对象为**自动充氮控制**客户 Demo（路径 B：CEP 项目 → BOM → EventStream → 测试 → Release → 部署 → 业务 demo 对接），并按客户新要求完成三项改造：

1. **阶段命名结构**：规则资产按「充氮 / 环流 / 保氮 / 补氮」四阶段组织（当前通过 EventStream 语句命名与 `label` 表达阶段，资产级 `category = n2-phase-migration`；语句级目录仍是平台优化项）。
2. **向导式创作**：阈值类迁移语句采用「单点阈值」向导模板生成（`mode=guided + template + params`），时间驱动语句暂以高级 EPL 承载。
3. **分钟→秒换算**：采样判定生产每 1 分钟 → 演示每 2 秒；环流时长生产 4 小时 → 演示 20 秒（timer 驱动）。

交付资产：
- 项目 `project-7c12c971`（engine=cep），BOM v2（`NitrogenReading` 事件）
- EventStream `63461191-…` 已发布 **v4**（3 条阶段迁移语句）
- Release `ff06f66f-…` v1（决策服务 `project-7c12c971/nitrogen-phase`）已部署 CEP Runtime 8792
- Demo：`dograin/n2-demo/`（demo.html + demo-server.js，端口 5191），含**自控 + 告警**双通道

---

## 2. 验收结论摘要

| # | 环节 | 结果 | 体验评分 | 一句话体验 |
|---|------|------|---------|-----------|
| 1 | 创建 CEP 项目 | ✅ 通过 | 4/5 | 创建顺畅，engine 可选 rules/cep |
| 2 | BOM 配置 | ✅ 通过 | 2/5 | 乐观锁字段与两套数据模型是主要卡点 |
| 3 | EventStream 创作 | ✅ 通过 | 3/5 | 服务端校验先拒绝时间驱动语句（已修复），pattern 别名需经验 |
| 4 | 向导式创作 | ✅ 通过 | 3/5 | 5 类模板可用，但派生输出字段与状态迁移模板缺失 |
| 5 | 编译 | ✅ 通过 | 4/5 | 真实 Esper 8.8.0 编译，需带 revision 的约定不直观 |
| 6 | 发布 | ✅ 通过 | 3/5 | 发布后 revision 自动递增，易与提交 revision 混淆 |
| 7 | Release 与部署 | ✅ 通过 | 4/5 | 不可变制品 + checksum + 质量门禁框架完整（本次无必选套件） |
| 8 | 业务对接（execute/events/webhook） | ✅ 通过 | 4/5 | 同步 detections 简洁；timer 长周期输出可由部署级 listener + webhook 异步接收 |
| 9 | Demo 演示（自控+告警） | ✅ 通过 | 4/5 | 闭环完整；发现并修复 2 处缺陷（代理超时、断流误报） |

**总体结论：验收通过**，可向客户演示。平台在本轮改造中表现出：CEP 资产生命周期（草稿/版本/发布/不可变 Release）完整、真实引擎编译门禁可靠、向导元数据已进入数据模型（不进 checksum）。

---

## 3. 分环节体验记录（从开发到部署上线）

### 3.1 创建项目

**操作**：POST `/api/projects`，`engine=cep`。

**体验**：顺畅。项目信息（名称/描述/引擎）一次成型，无阻力。

**建议**：无。

### 3.2 BOM 配置（本流程最大卡点）

**操作**：PUT `/api/projects/:id/bom` 写入 `NitrogenReading` 事件（keyField/timeField/sourceField/retention/duplicateKey + 8 字段 + output 字段）。

**踩坑记录**：
1. **乐观锁字段歧义**：BOM PUT 校验的是 `body.version`（必须等于当前 version），传 `body.revision` 无效 → 409。API 层同时存在 `version`（版本号）与 `revision`（修订号）两套概念，文档未明确 BOM 用哪个。
2. **顶层 `fields[]` 硬校验**：要求 ≥2 且同时含 `input` 与 `output` kind；输出字段（如 `phase` 枚举）必须显式建模，否则无法写入。
3. **两套数据模型并存**：氨气项目（`project-6f50ddcf`）BOM 为 `factTypes[]+eventTypes[]` 结构；氮气项目实际存储为**扁平 `fields[]+eventTypes[]`**。核心领域层仍校验 `bom.fields[]`，与 `bom-editor-design.md` 的 `factTypes[]` 可编辑目标存在 gap（文档已记录，仍建议统一）。

**建议**：见 §4 P1-4。

### 3.3 EventStream 创作（含时间驱动语句）

**操作**：POST/PUT `/event-streams/:id`（`{revision, draft:{name, description, category, statements[]}}`），语句含 `name/label/description/enabled/mode/template/params/epl`。

**踩坑记录**：
1. **服务端校验曾拒绝时间驱动语句**：`from pattern[every (p=… -> timer:interval(…))]` 曾被 `validateEventStreamDraft` 拒绝（"必须通过 from 引用 BOM 事件类型"）。已作为通用缺口 A 归档并在 `cep-time-driven-statement-support.md` v1.1 落地：支持 pattern 内事件类型识别、同模块衍生流引用与纯 timer pattern。
2. **pattern 内取字段需别名**：`NitrogenPhaseEvent(phase='CIRCULATION')` 直接取字段失败，必须写成 `p=NitrogenPhaseEvent(...)`，select 侧再 `p.warehouseId as warehouseId`。
3. **语句名强制英文标识符**：中文检测名只能进 `label`，首次使用易被 400 打断。

**体验**：语句结构（label/description/mode/template/params）已被 `normalizeEventStreamDraft` 完整保留，且 `compileEventStreamDraft` 的 runtime module 只含 `name/epl/enabled/eventTypes/outputEventType`——**向导元数据不进 Release checksum**，符合设计。时间驱动语句从"被拒"到"编译通过"需要真实 Esper 验证，非纯字符串生成。

### 3.4 向导式创作（本轮新增）

**操作**：阈值迁移语句带 `mode='guided', template='single-threshold', params={statementName,eventType,field,operator,value,outputFields}`；环流→保氮为 `mode='advanced'`。

**平台能力确认**：
- ✅ 5 类模板已实现（单点阈值/窗口均值/窗口波动/事件计数/窗口求和），参数校验（标识符/操作符/数值/单位）完整，操作符支持中文符号映射（≥/≤/≠）。
- ✅ 服务端保存/编译接受 `template+params`，前端可据此恢复向导。
- ✅ **模板已支持通用派生输出**：`single-threshold.outputFields` 可配置固定值和源字段重命名，生成 `select 'X' as phase, warehouseId as warehouseId`；服务端共享生成器会校验 `template + params + epl` 一致性。
- ❌ **状态迁移/时间驱动模板为 P2 未落地**：`Hold_FromCirc`（timer 20 秒）只能以高级 EPL 承载。`cep-visual-editor-design.md` §5.2 已列 P1/P2 优先级，本轮不改。

**体验**：阈值判断和派生输出都可由向导完成；跨语句时间模式与状态迁移模板尚未覆盖时仍需高级 EPL。

### 3.5 编译

**操作**：POST `/event-streams/:id/compile` `{revision}`。

**踩坑**：未带 `revision` → 400"修订号无效"（一次无效调用）。带上当前 revision 后真实 Esper 8.8.0 编译，返回 module 各语句的 `eventTypes/outputEventType`。

**体验**：编译是硬门禁（服务端校验 + 真实引擎编译两层），可靠。

### 3.6 发布

**操作**：POST `/event-streams/:id/publish` `{revision}`。

**体验**：发布生成不可变版本快照（version 4，含 draft 快照）；**注意发布成功后 revision 自动递增**（revision 7 → 8），后续操作需用新 revision，易错。

### 3.7 Release 与部署

**操作**：
- 创建：POST `/releases` `{decisionService, name, description, target:{type:'event-stream', id}}`
- 部署：POST `/releases/:id/deploy` `{environment:'local'}`

**体验**：
- ✅ Release 创建即触发真实引擎编译门禁 + 质量门禁框架；本次 Release 无 required 测试套件，因此 `qualityGate.suites=[]` 且通过。
- ✅ 不可变制品：部署含 checksum（`sha256:c3825d23…`）、modelVersion、engine（Esper 8.8.0），可审计。
- ✅ 部署落 CEP Runtime 8792，业务不依赖 Team Server（治理面与运行面解耦）。

### 3.8 业务对接（execute/events/webhook）

**操作**：
- 同步执行：POST `{CEP}/execute` `{releaseId, requestId, events[], waitMs}` → 返回本次等待窗口内的 `detections[]`
- 持续上报：POST `{CEP}/events/{releaseId}` `{events[], waitMs?}` → 返回 202；适合业务系统持续注入事件
- 异步告警：配置 webhook 后，部署级 listener 会持续捕获请求结束后的 timer / pattern 输出并推送 `alert.fired`

**踩坑记录**（引擎侧已知机制）：
1. **同步响应与异步输出需区分**：`waitMs` 只决定本次 HTTP 响应是否带回短窗口 / 短 timer 输出；部署运行时的长周期 timer 不再依赖请求保持挂起，已由部署级 listener 持续捕获并通过 webhook 推送。demo 前端保留 25s 保持请求，仅是为了在同一同步响应里展示 `HOLDING`。
2. **代理超时**：demo-server 曾设 `AbortSignal.timeout(20000)` < waitMs 25000 → 长窗口同步请求被 abort、表现为"无输出"。已修复为 310s。**建议平台文档显式声明最大 waitMs 与代理超时关系**。
3. **重复 detections**：引擎按事件评估，历史事件累积时一次 execute 可返回多条同语句命中；消费侧需按 `lastPhase != phase` 去重（demo 已实现）。

### 3.9 Demo 演示（自控 + 告警）

**实现**：
- 自控：4 阶段迁移徽标、设备联动（制氮机/充氮阀/环流阀/风机，充氮阀与通风**互斥铁律**）、暂停/继续/结束、一键场景 ①–⑥。
- 告警：告警中心（超限 CRITICAL / 下限 WARNING / 断流 WARNING / 补氮 INFO），越限触发**安全联锁**（强制关充氮设备），浓度回落自动 CLEARED；一键场景 ⑦⑧。
- 时间换算：采样生产 1 分钟/演示 2 秒；环流生产 4 小时/演示 20 秒；断流 4 秒阈值。

**发现并修复的缺陷**：
1. 环流保持期（25s 静默等待）误报"传感器断流"——修复为保持期间不判定断流。
2. 代理 fetch 超时 < waitMs（见 3.8）。

**演示说明边界**：设备指令下发与告警判定为前端模拟（真实业务由中控适配器执行）；页面与 API 文档均注明，不误导客户。

---

## 4. 产品优化建议（通用化，不入侵客户个性化需求）

> 原则：只提平台通用能力；客户自动充氮的具体逻辑属 demo 资产，不进入产品。

### P0（本轮验收直接触发的缺口）

| 编号 | 建议 | 现状 | 影响 |
|------|------|------|------|
| P0-1 | **EventStream 语句级分组/目录**：`statements[]` 增加 `group` 字段，前端按组展示并支持排序 | 已完成；分组属于作者元数据，数组顺序仍是运行顺序 | 已关闭 |
| P0-2 | **向导模板支持派生输出字段**：模板参数增加通用 `outputFields`，支持固定值与源字段重命名 | 已完成；当前先对 `single-threshold` 开放，空映射继续生成 `select *` | 已关闭 |
| P0-3 | **服务端 `template+params+epl` 一致性校验落地** | 已完成；共享模板生成器会在创建、保存与编译时重算并拒绝不一致 EPL | 已关闭绕过前端造成向导与运行语义漂移的入口 |

### P1（建议排期）

| 编号 | 建议 | 说明 |
|------|------|------|
| P1-1 | **状态迁移/时间驱动模板**（`cep-visual-editor-design.md` §5.2 P1/P2 项提前） | `Hold_FromCirc` 类"事件 A 后 timer N 输出"场景当前只能高级 EPL；缺口 A 已提供运行时支持，模板层补齐后业务人员可配置 |
| P1-2 | **语句排序/拖动重排**（文档后续范围） | 已完成；同时提供上下按钮，支持无鼠标操作 |
| P1-3 | **重复 detections 消费约定文档化** | 明确"引擎按事件评估、同语句可多次命中"，输出消费侧幂等/去重规范 |
| P1-4 | **BOM 模型统一**：`fields[]` 与 `factTypes[]` 收敛为单一 canonical 模型 | 两套叙事并存已造成 409 与迁移成本（§3.2） |

### P2（后续）

- 语义型 `alert.cleared`（webhook fired/cleared 已支持，恢复判断需 clearCondition/hysteresis）
- Event Profile 前端专用编辑 UI（后端契约已支持统一 BOM Core + eventTypes[]）
- 缺席检测（断流告警下沉平台，替代前端判定）

客户项目中的具体阈值、设备联锁和工艺状态迁移属于应用资产，不进入平台产品待办；平台只提供通用字段比较、输出映射、CEP 模板与治理能力。

---

## 5. 验证记录（回归矩阵）

### 5.1 引擎链路（Release v4 `ff06f66f-…` 已部署 8792，经 demo 代理 5191）

| 用例 | 输入 | 期望 | 实测 | 结果 |
|------|------|------|------|------|
| 充氮/补氮→环流 | nitrogenPct=96 | `Circ_FromFillRepl` → CIRCULATION | ✅ 同左 | 通过 |
| 保氮→补氮 | nitrogenPct=88 | `Repl_FromHold` → REPLENISHING | ✅ 同左 | 通过 |
| 环流→保氮 | 96 + waitMs 25000（覆盖 timer 20s） | `Hold_FromCirc` → HOLDING | ✅ 同左 | 通过 |
| 环流→保氮（异步） | 96 + `/events` 短请求 + webhook | 请求结束后 timer 仍输出 `Hold_FromCirc` | ✅ 部署级 listener 捕获并推送 | 通过 |
| 区间内 | nitrogenPct=90 | 无迁移 | ✅ 无 detections | 通过 |

### 5.2 前端自控 + 告警（浏览器实测）

| 用例 | 操作 | 实测 | 结果 |
|------|------|------|------|
| 超限告警 + 联锁 | 一键场景 ⑦ 注入 99.5% | CRITICAL 亮起；制氮机/充氮阀强制关闭 | 通过 |
| 告警自动解除 | 浓度回落 93% | CLEARED（日志留痕"回落至 93% · 解除"） | 通过 |
| 断流告警 | 场景 ⑧ 暂停注入 4 秒 | WARNING 亮起 → 采样恢复 1 秒后自动解除 | 通过 |
| 环流保持期误报 | 进入环流后 25s 保持窗口 | 修复后无断流误报 | 通过 |
| 设备互斥 | 各阶段设备状态 | 充氮/补氮密闭、环流通风，互斥不冲突 | 通过 |

### 5.3 质量自检

- demo.html 内联 JS `node --check` 通过；shot.py 桌面自检：无 console 错误、无横向溢出、13 个按钮全部有 handler。

---

## 6. 交付物清单

| 资产 | 位置/标识 | 说明 |
|------|-----------|------|
| CEP 项目 | `project-7c12c971` | 粮库自动充氮控制（engine=cep） |
| BOM | v2 | `NitrogenReading` 事件（8 字段 + phase 输出） |
| EventStream | `63461191-…` v4 | 3 条阶段迁移语句（2 条向导 + 1 条时间驱动），category=n2-phase-migration |
| Release | `ff06f66f-…` v1 | 已部署 CEP Runtime 8792 |
| Demo 页面 | `dograin/n2-demo/demo.html` | 自控 + 告警单文件 |
| Demo 服务 | `dograin/n2-demo/demo-server.js`（5191） | 代理 execute + 静态托管 |
| 需求文档 | `docs/cep-time-driven-statement-support.md` v1.1 | 缺口 A（时间驱动语句支持） |
