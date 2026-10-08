# Decision Workbench 双引擎架构需求设计（规则引擎 + CEP 事件引擎）

> 文档版本：v1.4（2026-10-01）
> 状态：
> **实现状态：已接入真实 Esper 8.8.0 容器；当前项目不做商用应用，若未来对外分发再补授权或替换引擎评估**
> 关联设计稿 / 文档：
> `docs/ruleflow-editor-design.md`
> 、
> `docs/bom-editor-design.md`
> 、
> `docs/bal-editor-design.md`
> 、
> `docs/decision-table-design.md`
> 、
> `docs/report-design.md`
> 、
> `docs/platform-issues-and-fixes.md`
> 、
> `docs/cep-visual-editor-design.md`



***

## 1. 项目背景

### 1.1 产品定位

**Decision Workbench** 是复刻 IBM ILOG JRules / ODM（Operational Decision Manager）的规则与决策管理平台。当前产品形态：



* **Team Server**（Node.js，PostgreSQL 存储）：统一管理项目、BOM、规则（BAL / 决策表）、规则集、规则集、测试套件、变更集、Release

* **RES / 规则执行服务器**：Docker 容器（`rules-engine-1`，Drools 10.2.0），编译与执行规则

* 前端：React + @xyflow/react（规则集编辑器正在按 Dify 式画布直编改造，见 `ruleflow-editor-design.md`）

### 1.2 为什么要引入 CEP 事件引擎

客户新增真实业务场景：



1. **自动充氮控制**（粮食仓储）：开始 / 结束时间 + 最大 / 最小氮气浓度；周期性采样判断、状态机流转（充氮→环流→保氮→补氮→循环）、可暂停 / 继续

2. **传感器流监控**：粮仓温度 / 湿度高频采样，需要 "最近 10 分钟均温超限"" 连续 3 次采样超阈值 ""升温速率异常" 等**跨事件时间关联**的检测

经技术论证（详见 §1.3），第一类场景以 "状态机 + 定时器 + 规则判定" 实现（规则引擎职责），第二类场景是真正的**复杂事件处理（CEP）**，需要独立事件引擎。

### 1.3 产品线先例（架构依据）

IBM ODM（JRules 后继产品）本身就是**双引擎并行**架构：



* **Decision Server**（规则引擎）：决策 / 规则执行

* **Decision Server Events**（业务事件处理层 BEP，源自 ILOG Business Events）：独立的事件引擎，做跨时间和序列的事件模式检测、关联、聚合事件，自有 Designer/Tester/Replay 工具链

因此，**"Team Server 统一管理 + 规则项目路由到 Drools/RES、CEP 项目路由到 Esper"** 是复刻 JRules 产品线的正确产品形态，并非过度设计。

### 1.4 引擎选型：Esper



* Esper 8.8.0（Java，活跃维护），开源 **GPL v2 双许可**（EsperTech 提供商业再分发授权）

* 语言：**EPL**（Event Processing Language，SQL-92 扩展），编译器将 EPL 编译为 JVM 字节码

* 能力：滑动窗口、时间聚合、模式检测（every/not/and/followed-by）、上下文分区、命名窗口

* 定位：嵌入式组件（非服务端），适合独立容器化部署

* 已知软肋：**无内置持久化 / 故障恢复**（状态全内存，宕机丢失，HA 需 EsperHA/Enterprise）；GPL 传染性需公司合规评估

### 1.5 需求来源与决策记录



| 日期         | 决策                                              |
| ---------- | ----------------------------------------------- |
| 2026-09-30 | 确认双引擎架构：`project.engine` 项目级引擎路由                |
| 2026-09-30 | 确认规则项目（engine=rules）→ RES Docker（Drools 10.2.0） |
| 2026-09-30 | 确认 CEP 项目（engine=cep）→ Esper Docker             |
| 2026-09-30 | 确认两类资产不混合，资产按引擎隔离                               |
| 2026-09-30 | 确认 CEP 项目 v1 仅支持最小资产集：EventStream（EPL 语句集）      |



***

## 2. 目标与非目标

### 2.1 目标



1. 项目创建时选择引擎类型（`engine: 'rules' | 'cep'`），项目级路由到对应引擎容器

2. CEP 项目支持 **EventStream 资产**（EPL 语句集）的创建、编辑、变更集、发布、Release

3. BOM 复用：事件 schema 由 BOM factType 自动生成 Esper `create schema`

4. 测试套件按引擎分支：CEP 项目支持 "事件流输入 + 期望检测事件" 的套件

5. 编译校验按引擎分支：rules → Drools compile；cep → Esper EPL compile

6. 报告按引擎分支：两类项目的资产清单 / 统计结构不同

7. 现有 rules 项目全部功能与数据**零破坏**兼容

### 2.2 非目标（v1 不做）



* CEP 项目的 Event Flow（事件流编排，对应 ODM Event Flow）→ v2

* Esper 高可用（EsperHA/Enterprise）→ 按需

* CEP 项目与规则项目资产混用 / 跨引擎调用 → 明确不做

* 事件回放 / 历史分析工作台 → v2



***

## 3. 总体架构（项目级引擎路由）



```
┌─ Team Server（统一维护管理）─────────────────────────────────────┐

│  项目创建时选定 engine                                            │

│                                                                 │

│  ┌─ 规则项目（engine=rules）────────────────────────────────┐   │

│  │  资产：BAL / 决策表 / 规则集 / 规则集                     │   │

│  │  编译校验 → Drools compile                                │   │

│  │  测试套件 → facts + expected.outputs / fired              │   │

│  │  发布 → RES Docker（rules-engine-1 · Drools 10.2.0）      │   │

│  └──────────────────────────────────────────────────────────┘   │

│  ┌─ CEP 复杂事件项目（engine=cep）───────────────────────────┐  │

│  │  资产：EventStream（EPL 语句集）                          │  │

│  │  编译校验 → Esper EPL compile                             │  │

│  │  测试套件 → 事件流输入 + 期望检测事件序列                  │  │

│  │  发布 → Esper Docker（新增 rules-esper-1 · Esper 8.8.0）  │  │

│  └──────────────────────────────────────────────────────────┘  │

└─────────────────────────────────────────────────────────────────┘
```

关键设计：**Team Server 是唯一管理平面，两类引擎是纯执行层**。引擎 URL 按项目解析（当前 `server/index.js:19` 为全局单引擎 `ENGINE_URL || http://127.0.0.1:8788`，需改为按 `project.engine` 路由）。



***

## 4. 引擎路由模型

### 4.1 项目数据结构扩展

`server/index.js` `createProjectRecord`（约 450-460 行）当前结构：



```
const project = { id, name, description, icon, version: 'v1.0.0', branch: 'main',

\&#x20; defaultEnvironment: 'local', archived: false, createdAt: now, updatedAt: now, updatedBy: actor }
```

扩展为：



```
const VALID\\\_ENGINES = \\\['rules', 'cep'];

const project = { id, name, description, icon,

\&#x20; engine: VALID\\\_ENGINES.includes(payload?.engine) ? payload.engine : 'rules',  // 默认 rules，向后兼容

\&#x20; version: 'v1.0.0', branch: 'main', defaultEnvironment: 'local',

\&#x20; archived: false, createdAt: now, updatedAt: now, updatedBy: actor }
```

约束：



* **创建时必选**（前端默认 'rules'）

* **创建后不可修改**（或仅管理员 + 项目无已发布资产时允许）；修改需审计事件

* `POST /api/projects` 校验 `engine ∈ {rules, cep}`

### 4.2 引擎端点解析（核心改造点）

当前代码有两类边界，不能只用一个 `ENGINE_URL` 替换：



* Build / 设计期校验：`server/index.js` 的 `engine('/compile'|'/test')`，当前默认 `ENGINE_URL || http://127.0.0.1:8788`

* Runtime / 执行服务器：`executionServer('/deploy'|'/execute')`，当前默认 `RES_URL || http://127.0.0.1:8790`

改为按项目引擎解析 **Build 服务** 和 **Runtime 服务** 两个目标：



```
const RULES\_BUILD\_URL = process.env.RULES\_BUILD\_URL || process.env.ENGINE\_URL || 'http://127.0.0.1:8788';

const RULES\_RES\_URL   = process.env.RULES\_RES\_URL   || process.env.RES\_URL    || 'http://127.0.0.1:8790';

const CEP\_BUILD\_URL   = process.env.CEP\_BUILD\_URL   || 'http://127.0.0.1:8791';

const CEP\_RES\_URL     = process.env.CEP\_RES\_URL     || 'http://127.0.0.1:8792';

function resolveEngineTargets(project) {

&#x20; const engine = project?.engine || 'rules';

&#x20; if (engine === 'cep') return { buildUrl: CEP\_BUILD\_URL, runtimeUrl: CEP\_RES\_URL, engine };

&#x20; return { buildUrl: RULES\_BUILD\_URL, runtimeUrl: RULES\_RES\_URL, engine: 'rules' };

}
```

迁移要求：



* 所有 `engine('/compile'|'/test', ...)` 调用点改为 `buildEngine(project, endpoint, payload)`，按 `buildUrl` 转发。

* 所有 Release `deploy/execute` 调用点改为 `runtimeEngine(project, endpoint, payload)`，按 `runtimeUrl` 转发。

* 旧环境变量 `ENGINE_URL`、`RES_URL` 保留为 rules 默认值，确保历史 rules 项目零配置可运行。

* CEP 默认使用独立端口，禁止默认挂在现有 Drools `8788` 的 `/cep` 路径下；如果后续决定共用网关，需在运维文档中单独说明。

### 4.3 资产隔离



| 维度     | 规则项目（rules）                            | CEP 项目（cep）                   |
| ------ | -------------------------------------- | ----------------------------- |
| 允许资产类型 | rule / decision-table / ruleset / flow | event-stream                  |
| BOM    | 完整 BOM（factType + 字段 + 操作符）            | 复用 BOM，事件类型映射 schema          |
| 规则集    | 支持（步骤绑规则集 / 决策表）                       | v1 不支持                        |
| 测试套件   | facts + expected.outputs/fired         | 事件流输入 + 期望检测事件序列              |
| 编译     | Drools compile                         | Esper EPL compile             |
| 发布目标   | RULES\_RES\_URL / RES Docker           | CEP\_RES\_URL / Esper Runtime |



* 服务端校验：按项目引擎逐路由过滤资产类型（`/rules`、`/flows`、`/test-suites`、`/releases`、新增 `/event-streams` 均需明确允许 / 禁止语义）

* **API 行为矩阵**（评审 P1-8：前端隐藏不等于后端可创建，每个 API 在 rules/cep 项目的行为必须显式定义）：



| API                                        | rules 项目          | cep 项目                    |
| ------------------------------------------ | ----------------- | ------------------------- |
| `GET/POST /api/projects/:id/rules`         | 正常                | 404 / 403（资源不存在，拒绝创建非法资产） |
| `GET/POST /api/projects/:id/tables`        | 正常                | 404 / 403                 |
| `GET/POST /api/projects/:id/flows`         | 正常                | 404 / 403                 |
| `GET/POST /api/projects/:id/rulesets`      | 正常                | 404 / 403                 |
| `GET/POST /api/projects/:id/event-streams` | 404 / 403         | 正常（新增）                    |
| `GET/POST /api/projects/:id/bom`           | 正常                | 正常（事件类型定义）                |
| `GET/POST /api/projects/:id/test-suites`   | 正常（rules 套件）      | 正常（cep 套件，cases 分支）       |
| `GET/POST /api/projects/:id/releases`      | 正常（engine=drools） | 正常（engine=esper）          |
| `GET /api/projects/:id/report`             | 正常（rules 结构）      | 正常（cep 结构）                |



* 前端：按 `project.engine` 控制导航菜单与新建入口

### 4.4 变更集与发布



* `shared/changes.js` 资产类型枚举：`['rule','table','flow']` → 增加 `['event-stream']`（CEP 项目专用）

* 变更集 item：`{ type: 'event-stream', id, revision }`

* 发布路由：`POST /api/projects/:id/releases` 时按 `project.engine` 选择 Release builder、质量门禁和 Runtime 部署目标

* Release `engine` 使用可校验对象：rules 保持 `{ type: 'drools', drools: '10.2.0' }`；cep 使用 `{ type: 'esper', esper: '8.8.0' }`，详见 §7.3

* 质量门禁：compile /test 按引擎分支（见 §7.1、§7.2）



***

## 5. CEP 项目资产模型

### 5.1 EventStream 资产



```
interface EventStreamDraft {

\&#x20; name: string                    // 1-80 字符

\&#x20; description?: string            // ≤500

\&#x20; statements: EplStatement\\\[]      // EPL 语句集

}

interface EplStatement {

\&#x20; name: string                    // 语句名（模块内唯一）

\&#x20; epl: string                     // EPL 文本（如 select ... from ... #time(10 min)）

\&#x20; output?: string\\\[]               // 输出事件字段（供测试期望断言）

}

interface EventStreamVersion {

\&#x20; number: number

\&#x20; name: string

\&#x20; statements: EplStatement\[]

\&#x20; bom: BomSnapshot              // 发布时冻结的 BOM / schema 来源

\&#x20; schemas: EsperSchema\[]         // 由 BOM 生成，随版本快照保存

\&#x20; checksum: string               // sha256(statements+schemas+bom)，供校验与可重放

\&#x20; compiledAt?: string

\&#x20; createdAt: string

\&#x20; createdBy: string              // 发布人（审批发布后写入，审计用）

}

interface EventStreamAsset {      // 资产外壳（必须贴合现有资产生命周期）

\&#x20; id: string

\&#x20; projectId: string

\&#x20; type: 'event-stream'

\&#x20; status: 'draft' | 'published'  // 与规则/决策表外壳一致

\&#x20; package?: string              // 包归属（可选，默认根包；PACKAGE\_NAME\_RE 校验英文包名）

\&#x20; version: number               // 发布次数（每次发布 +1）

\&#x20; revision: number

\&#x20; bomVersion?: number           // 引用 BOM 版本

\&#x20; archived?: boolean

\&#x20; draft: EventStreamDraft

\&#x20; published: EventStreamVersion | null

\&#x20; versions: EventStreamVersion\[]

\&#x20; createdAt: string

\&#x20; updatedAt: string

\&#x20; updatedBy: string

}
```

### 5.2 EPL 编写约束（v1）



* 仅支持**单输入流 + 派生事件**的语句；禁止跨模块副作用

* 允许：`select`、`#time/#length` 窗口、`every/not/and/followed-by` 模式、`insert into`（派生事件）

* 允许引用 BOM 事件类型（见 §6）；禁止引用未发布类型

* 禁止：外部数据库接入、自定义函数注册（v1 不支持扩展）

### 5.3 资产编辑器（UI）



* 新建入口：CEP 项目 → 资产目录 → "新建事件流"

* 默认编辑器：左侧检测语句列表，中间 BOM 驱动的业务向导，右侧只读 EPL 预览；新建 EventStream 默认创建一条单点阈值向导语句

* 高级 EPL：作为次级入口保留给引擎开发人员；历史纯 EPL 不强制反向转换为向导

* 删除：支持语句草稿删除和 EventStream 资产软删除；资产删除必须校验 revision、审核锁并保留既有 Release

* 语句编译反馈：调用 Esper 编译端点，错误行内提示

* 元信息：BOM 版本、最后编译时间、输出事件字段预览

* 完整交互、模板、数据一致性和验收要求见 `docs/cep-visual-editor-design.md`



***

## 6. BOM 映射

### 6.1 统一 BOM Core + 事件视图

CEP 项目复用当前 BOM，但 canonical 来源必须以现有后端领域模型为准：



* 持久化 / 领域层当前仍是 `bom.fields[]`，每个字段带 `factType`、`factTypeLabel`、`kind`、`type`、`semanticType`。

* 项目 API / 前端可以继续提供 `factTypes[].fields[]` 编辑视图，但 CEP schema 生成不得依赖前端视图作为唯一来源。

* 新增 `bom.eventTypes[]` 作为 CEP/Event Profile：只描述事件类型、事件字段引用、key/time/source、保留期、乱序容忍和去重键；不复制字段定义。

* 规则侧继续使用 `fields[].factType` / `factTypes[]` 规则视图；CEP 侧优先使用 `eventTypes[]` 生成 Esper schema，缺失时才回退到 `fields[].factType` 分组，保证旧 BOM 兼容。

* 该方案避免另建 Event BOM 导致字段类型 / 枚举 / 审计双写，同时避免把事件信封语义硬塞进 rules BOM factType。



```
interface BomEventType {

&#x20; name: string

&#x20; label?: string

&#x20; version?: number

&#x20; keyField?: string

&#x20; timeField?: string

&#x20; sourceField?: string

&#x20; retention?: string

&#x20; allowedLateness?: string

&#x20; duplicateKey?: string\[]

&#x20; fields: Array<{ field: string; required?: boolean }>

}
```

### 6.2 事件类型生成

生成 Esper schema 时，优先按 `bom.eventTypes[]` 中的字段引用从 flat `fields[]` 取字段类型；若项目还没有 Event Profile，再按 `field.factType || 'DefaultEvent'` 分组兜底：



```
// bom.fields\[] group by field.factType -> Esper create schema

create schema \<FactTypeName> (

&#x20; field1 string,

&#x20; field2 double,

&#x20; field3 int,

&#x20; ...

)
```



* 字段类型映射：String→string、Double→double、Integer→int、Boolean→boolean、Enum→string、Date→string、List→string\[]。

* 每个输入事件 schema 自动补充信封字段：`eventId`、`eventTime`、`ingestTime`、`source`、`eventKey`、`schemaVersion`、`traceId`；外部事件可从顶层 envelope 或 `data` 提供，Esper 服务会合并后送入运行时。

* `kind=input` 字段作为事件输入字段；`kind=output` 字段默认不进入原始输入事件，除非 EventStream 明确声明派生事件 schema。

* 生成的 schema 随 EventStream version 和 Release 一并冻结、部署到 Esper 容器。

* 事件输入：外部系统推送 JSON 事件 → Esper 容器按 schema 类型转换后送入运行时。

### 6.3 校验



* `eventTypes[]` 中的字段引用必须存在于 BOM Core `fields[]`，`duplicateKey` 可引用 BOM 字段或标准信封字段。

* 事件测试 / Release 执行会按 Event Profile 校验事件类型、必填字段和基础类型，拒绝未定义事件类型或缺失必填字段。

* EventStream 语句引用的类型名必须能从当前 BOM `eventTypes[]` 或兼容分组中解析出来。

* 前端编辑时按 BOM 版本提示可用事件类型（仿规则编辑器的字段提示）



***

## 7. 编译 / 测试 / 发布 / 报告分支

### 7.1 编译校验



| 分支    | 端点                         | 入参                 | 出参                     |
| ----- | -------------------------- | ------------------ | ---------------------- |
| rules | `POST /compile`（Drools 容器） | `{ drl }`          | `{ version, errors? }` |
| cep   | `POST /compile`（Esper 容器）  | `{ schemas, epl }` | `{ version, errors? }` |



* `POST /api/projects/:id/flows/.../compile`、`POST /api/projects/:id/assets/:aid/compile` 等编译入口按项目引擎转发

* 规则集编译在 CEP 项目不可用（前端隐藏）

### 7.2 测试套件

现有套件 schema（rules）：`sequence: id → name → enabled → facts → parameters → expected.outputs → expected.fired（数组）→ 至少一个断言`

CEP 套件 schema 只扩展 case payload，不重写测试套件外壳：



```
interface CepTestSuite {

&#x20; id: string

&#x20; projectId: string

&#x20; name: string

&#x20; enabled: boolean

&#x20; required?: boolean

&#x20; target: { type: 'event-stream', id: string }

&#x20; targetVersion?: number

&#x20; cases: CepTestCase\[]

&#x20; revision: number

&#x20; lastRun?: TestRunReport

&#x20; runs?: TestRunReport\[]

}

interface CepTestCase {

&#x20; id: string

&#x20; name: string

&#x20; enabled?: boolean

&#x20; events: Array<{              // 事件流输入（按 timestamp 顺序）

&#x20;   type: string               // BOM 事件类型名

&#x20;   timestamp: number          // 相对时间 ms；测试 runner 可虚拟时钟推进

&#x20;   data: Record\<string, unknown>

&#x20; }>

&#x20; expectedEvents: Array<{      // 期望检测到的事件序列

&#x20;   statement: string          // EPL 语句名

&#x20;   eventType: string          // 派生事件类型

&#x20;   count?: number             // 期望次数，默认 1

&#x20;   timeout?: number           // 等待超时 ms

&#x20;   fields?: Record\<string, unknown>

&#x20; }>

&#x20; assertions?: Array<{ type: 'event-count' | 'event-field', expected: unknown }>

}
```



* 路由：沿用 canonical `POST /api/projects/:id/test-suites/:sid/run`，旧 `/tests` 仅兼容 rules 历史路径。

* 门禁：Release 只读取 `required=true` 且 target 匹配当前 EventStream 的 CEP 套件。

* CEP 套件运行：将事件流按时间序推入 Esper 运行时，断言期望事件在 timeout 内到达，报告仍输出 `assertions[]`，保持前端和门禁消费方式一致。

### 7.3 Release

Release 必须保持不可变、可校验、可重放。新增 CEP 时不得破坏现有 rules schema：



* rules Release 继续使用现有 schema v1：`engine: { type: 'drools', drools: '10.2.0' }`，`steps[].drl`，checksum 规则不变。

* CEP Release 使用 schema v2 或在 `verifyRelease` 中新增兼容分支：`engine: { type: 'esper', esper: '8.8.0' }`。

* `target.type` 新增 `event-stream`；**CEP v1 的 Release target 固定为单个 EventStream 资产**（`target: { type: 'event-stream', id, assetVersion }`，不含多 bundle / 项目级集合，避免影响质量门禁、版本号与部署内容粒度）；Release 内容冻结该 EventStream 的 version、EPL statements、由 BOM 生成的 schemas、测试门禁结果。

* `releaseChecksum()` 必须把 CEP 的 `engine/schemas/statements/target` 纳入 canonical content；历史 Release checksum 不能重算失败。

* 质量门禁：rules → Drools compile + rules 套件通过；cep → Esper EPL compile + CEP 套件通过。

* 部署目标：rules → `RULES_RES_URL`；cep → `CEP_RES_URL`。

* Release 详情 / 列表展示 `engine` 徽标（规则 / 事件）。

### 7.4 报告（report）

`shared/report.js` 增加引擎分支：



* 概览：新增 `engine` 展示；CEP 项目统计 EventStream 资产数、EPL 语句数

* 资产清单：CEP 项目列出 event-stream 资产（名称、版本、语句数、输出事件）

* 规则 / 规则集 / 测试统计：CEP 项目显示 N/A 或省略

* 现有 rules 项目报告结构保持不变



***

## 8. 前端 UI 变化

### 8.1 项目创建



* 创建项目对话框新增 "引擎类型" 选择：**规则引擎（Drools）** / **事件引擎（Esper）**，默认规则引擎

* 创建后项目列表显示引擎徽标

### 8.2 项目工作区（按 engine 分支）



| 导航项    | rules        | cep               |
| ------ | ------------ | ----------------- |
| BOM・词汇 | 完整           | 完整（事件类型定义）        |
| 规则     | 是            | 隐藏                |
| 决策表    | 是            | 隐藏                |
| 规则集    | 是            | 隐藏                |
| 规则集    | 是            | 隐藏                |
| 事件流    | 隐藏           | 是（新增入口）           |
| 测试套件   | rules schema | cep schema（事件流输入） |
| 发布     | RES          | Esper             |

### 8.3 EventStream 编辑器



* 新增页面：`/projects/:projectId/event-streams/:eventStreamId`

* 三栏布局：左侧语句列表 + 中间业务向导 + 右侧只读 EPL 预览

* 新建资产和语句默认使用 BOM 驱动向导；高级 EPL 是显式次级入口

* 支持 EventStream 资产软删除、语句启停和语句删除；发布历史与既有 Release 不受删除影响

* EPL 实时校验使用后端编译端点；高级模式后续补语法高亮与行列错误定位

* 详细设计见 `docs/cep-visual-editor-design.md`



***

## 9. codex 开发拆分（建议 5 步）

### Step 0：契约冻结与合规门禁（P0）



* 冻结四类契约：端点拆分（Build/Runtime）、Release schema v2、BOM→Esper schema、CEP TestSuite envelope。

* 项目已确认不做商用应用，本轮按需求引入真实 Esper 8.8.0；若未来涉及对外分发，再补授权或替换引擎评估。

* 自动充氮控制（状态机 + 定时器 + 暂停 / 继续）不并入 CEP v1，单独开规则侧编排需求。

### Step 1：引擎路由基建（P0）

> 2026-09-30 状态：已落地。项目 
>
> `engine`
>
>  默认 rules 并锁定；端点拆分为 
>
> `RULES_BUILD_URL / RULES_RES_URL / CEP_BUILD_URL / CEP_RES_URL`
>
> ；旧 
>
> `ENGINE_URL / RES_URL`
>
>  仅作为 rules 默认兼容。



* `server/index.js`：项目模型加 `engine` 字段（创建 / 更新 / 校验）；新增 `resolveEngineTargets()`，分别替换 Build 调用和 Runtime 调用

* `shared/changes.js`：资产类型枚举加 `'event-stream'`

* 兼容：旧项目无 engine → 默认 `rules`；所有现有 rules 功能回归

* 验收：创建 rules/cep 项目成功；rules 项目编译 / 测试 / 发布全部正常（回归）

### Step 2：Esper 引擎容器与编译端点（P0，合规通过后）

> 2026-09-30 状态：已引入真实 Esper 8.8.0 Docker 服务；
>
> `cep-build`
>
>  暴露 
>
> `8791`
>
>  编译 / 测试，
>
> `cep-res`
>
>  暴露 
>
> `8792`
>
>  部署 / 执行。GPL / 商业授权风险仍需项目方确认。



* 新增 Docker 镜像 / 容器 `rules-cep-build-1`、`rules-cep-res-1`（Esper 8.8.0 服务，仿 rules-engine-1 /rules-res-1 封装）

* 容器端点：`POST /compile`（schemas+epl → 编译结果）、`POST /test`（事件流 → 检测结果）、`POST /deploy`（Release 部署）

* 验收：EPL 语句（窗口聚合 / 模式检测）编译通过；事件流测试返回期望事件

### Step 3：EventStream 资产全链路（P1）

> 2026-09-30 状态：已落地 EventStream CRUD /compile/publish / 变更集 / 项目导航；compile/publish 调用真实 Esper Build 服务。



* 后端：event-stream 资产 CRUD + 变更集 + 发布 + BOM schema 生成

* 前端：EventStream 编辑器页面 + 项目引擎分支导航

* 验收：CEP 项目内创建 / 编辑 / 发布 EventStream；Release 部署到 Esper 容器

### Step 4：CEP 测试套件与报告分支（P1）

> 2026-09-30 状态：已落地 CEP TestSuite、Release schema v2、真实 Esper Runtime local deploy/execute 与报告统计。



* 测试套件 cep schema + 运行端点；报告引擎分支

* 验收：CEP 套件运行通过；CEP 项目报告输出正确；rules 项目报告不变

## 10. Esper 容器 HTTP 封装（实现现状与增强建议）

> 2026-10-01 状态：已落地真实封装。本平台 CEP 容器不是裸 Esper 进程，而是 
>
> `cep/`
>
>  目录下基于 JDK 内置 
>
> `HttpServer`
>
>  的 HTTP 服务（
>
> `CepServer.java`
>
> ），把 Esper 8.8.0 编译 + 运行时封装为可被 Team Server / 业务应用直接调用的 REST 端点。本节记录封装现状（供后续开发复用）与面向业务接入的增强 backlog（不进 CEP v1 核心，按需排期）。

### 10.1 封装现状

**实现**：`cep/src/main/java/workbench/cep/CepServer.java`（约 420 行），无第三方 Web 框架，直接 `com.sun.net.httpserver.HttpServer` 暴露端点；Maven 构建（`cep/pom.xml`），`cep/Dockerfile` 产出单 jar，`compose.yaml` 起两个实例：



| 容器                  | 端口   | 角色           | 数据                              |
| ------------------- | ---- | ------------ | ------------------------------- |
| `rules-cep-build-1` | 8791 | 编译 / 测试（无状态） | 不持久化                            |
| `rules-cep-res-1`   | 8792 | 部署 / 执行（有状态） | `/data/cep/*.json` 持久卷，重启自动重建部署 |

> 两个容器使用同一套镜像和 `CepServer.java` 代码，端点能力相同；build / res 是 Team Server 路由层面的角色约定，不是 Java 服务自身限制。

**端点**：



| 端点             | 方法   | 入参                                    | 说明                                                                                                  |
| -------------- | ---- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/health`      | GET  | —                                     | 服务状态、Esper 版本、部署数                                                                                   |
| `/compile`     | POST | `{ module: { schemas, statements } }` | 生成 `create schema` + 注入 `@name('...')` 的 EPL，Esper 编译；语法错误返回 422 + `errors[]`                       |
| `/test`        | POST | `{ module, events, waitMs? }`         | 临时 runtime 执行事件序列，可等待处理时间窗口 / timer 输出，返回 `detections`（测试用，执行后销毁）                                           |
| `/deployments` | GET  | —                                     | 已部署 Release 清单                                                                                      |
| `/deploy`      | POST | Release 完整对象                          | 校验 schemaVersion=2、engine=esper、target=event-stream、checksum 存在 → 部署 → 持久化；同 ID 不同 checksum 拒绝（409） |
| `/execute`     | POST | `{ releaseId, requestId, events, waitMs? }` | 按 releaseId 注入事件流，收集当前请求窗口内检测结果；长周期 timer 输出由部署级 listener 继续捕获并推送                                      |
| `/events/{releaseId}` | POST | `{ events, waitMs? }`              | 持续上报事件；返回 202；支持短等待收集 timer 输出，部署级 listener 负责请求外异步输出                         |
| `/webhook`     | POST | `{ releaseId, webhook }`             | 配置 `alert.fired` / `alert.cleared` 回调、HMAC、重试与去抖                                                  |
| `/openapi.json` | GET | —                                    | 当前 CEP Runtime HTTP 契约                                                                                 |
| `/metrics`     | GET | —                                     | Prometheus 指标（请求、事件、检测、webhook）                                                                |

**关键实现点**（后续开发 / 运维必须知晓）：



* **schema 自动声明**：从 BOM 生成的 `schemas[]` 拼接 `@public @buseventtype create schema <Name>(<field> <type>, ...)`，字段类型映射 int/double/boolean/string/string \[]。

* **语句名注入**：EPL 无 `@name(...)` 时自动补 `@name('语句名')`，`detections[].statement` 即语句名，测试断言与 demo 展示依赖此契约。

* **事件类型强制**：`coerceValue` 按 schema 类型做基础转换（Number→double/int、String→string），信封字段（eventId/eventTime/ingestTime/source/eventKey/schemaVersion/traceId）从顶层或 `data` 合并；更友好的必填 / 类型错误由 Team Server 前置校验。

* **有状态窗口与时间驱动语义**：`cep-res` 是持续运行的 EPRuntime，**时间窗口状态跨请求保留**（如 `#time(3 minutes)` 聚合会累积历史事件）；`pattern` / `timer:interval` 由部署级 listener 持续捕获，超出 HTTP 请求生命周期后仍可通过 webhook 派发。当前未接入 Esper external clock，`#time(...)` 与 `timer:*` 使用处理时间 / 系统时间，不会自动按事件里的 `eventTime` 或 `timestamp` 推进。

* **多 Release 共存**：`ConcurrentHashMap<releaseId, Deployment>` + deploy 锁；`/execute` 按 releaseId 路由。

* **重启恢复**：`loadDeployments()` 从持久卷 JSON 重建部署，重启不丢已部署 Release。

* **限制**：单请求体 ≤ 2MB；鉴权为可选单 API Key（`CEP_API_KEY`），尚未做 JWT / 多租户策略；告警推送采用 webhook 短连接，不做 SSE / WebSocket 长连；`eventType` 输出为 Esper 输出事件类型，显式 `insert into` 时为目标流名（如 `HighTemperatureEvent`），否则可能为 Esper 生成名；断言 / 展示以 `statement` 为准。

### 10.2 增强建议（backlog，按真实客户接入排期）

> 2026-10-01 状态：本节 P1/P2 容器增强已落地到 `CepServer.java` 并完成真实容器验证：事件上报端点、webhook fired/cleared、可选 API Key、OpenAPI、Prometheus metrics。

当前封装是 "引擎层 HTTP 化"，业务系统（如粮库中控）直接对接还需补齐：



| 增强项                                 | 优先级 | 说明                                    | 落点建议                         |
| ----------------------------------- | --- | ------------------------------------- | ---------------------------- |
| 事件上报专用端点 `POST /events/{releaseId}` | P1  | 语义为 "持续上报" 而非 "查询一次"，可批量注入            | 已落地：容器端点 + Team Server `/releases/:id/events` 代理       |
| **Webhook 告警推送（fired / cleared）**    | **P1** | 监控场景是推不是拉；**不做 SSE / WebSocket 长连**；告警产生 → 回调；**告警消退（如浓度回落）→ 回调触发关窗等反向指令** | 已落地：容器层 `alert.fired` + 超时型 `alert.cleared`，细化见 §10.3 |
| 鉴权与租户隔离（X-Api-Key / JWT）            | P1  | 多粮库 / 多租户按 release 隔离，避免任意客户端 execute | 已落地：`CEP_API_KEY` 可选启用，Team Server 自动透传 `X-Api-Key`     |
| OpenAPI 契约                          | P2  | 封装暴露为业务 API 时提供 swagger 文档            | 已落地：容器 `GET /openapi.json`                     |
| `/metrics`（吞吐 / 窗口积压 / 命中率）         | P2  | 对接 Prometheus 观测                      | 已落地：容器 `GET /metrics`                         |

**落地说明（v1.3 实现）**：增强项已全部落地。默认仍保持无鉴权的本地开发模式；设置 `CEP_API_KEY` 后容器要求 `X-Api-Key`/`Authorization: Bearer`，Team Server 使用同名环境变量自动透传。Webhook 推送在 CEP 容器（CepServer）层实现——`alert.cleared`（消退）判定依赖引擎窗口状态，demo-server / Team Server 网关层只负责配置和代理。

### 10.3 Webhook 告警推送（v1.3 细化需求）

**需求来源（客户真实场景）**：监控场景是"推不是拉"；尤其关键：**事件突然消失 / 警告消失 → 业务系统据此触发关窗等反向指令**（如氨气浓度从超标回落到阈值下 → 中控关闭强制通风阀门）。这要求引擎不仅推送"告警产生"，还要推送"告警消退"。

**形态决策**：采用 **webhook 短连接推送，明确不做 SSE / WebSocket 长连接**——客户回调系统多为普通 HTTP 服务，长连运维成本高、NAT/防火墙穿透困难。

**两类推送事件**：

| 事件 | 语义 | 触发条件 |
|---|---|---|
| `alert.fired` | 告警产生 | 语句检测命中（即现有 `/execute` 的 detections 语义，异步推送） |
| `alert.cleared` | 告警消退 | 触发过某语句后，**距上次触发超过消退判定时长（clearedAfterMs）且期间未再次触发**，或窗口聚合值回落至阈值下（P2） |

* 已落地范围：`alert.fired` 推送 + 基于"距上次触发超时"的 `alert.cleared`（实现简单、不依赖解析 EPL 语义）；基于"窗口聚合值回落"的 cleared（需解析语句聚合语义）仍放 P2
* 消退判定状态：容器层维护 `per-release × per-statement × per-key（分组维度）` 的 `lastMatchedAt`，使用处理时间推进；超时后判定 cleared 并推送

**实现要点（CepServer 增量）**：

* **Webhook 配置**：`POST /webhook` 下发 `{ releaseId, webhook: { callbackUrl, secret, enabled, clearedAfterMs, maxRetries, minIntervalMs } }`；配置随 Release 持久化（`/data/cep/*.json`）；Team Server 提供 `/api/projects/:id/releases/:releaseId/webhook` 代理
* **推送契约**：`POST <callbackUrl>`，body `{ releaseId, type: 'alert.fired' | 'alert.cleared', ... }`；Header `X-DW-Signature: sha256=<base64-hmac>` 供回调方验签
* **可靠性**：失败指数退避重试（最多 5 次、超时 5s）；幂等键 `{releaseId, statement, eventType, key}`；容器重启后 lastMatchedAt 暂为内存态，重启丢失可接受
* **触发频率控制**：fired 去抖（同一 statement×key 在 minIntervalMs 内只推一次，避免滑动窗口每事件一次把回调方打爆）——与 §10.4 滑动窗口语义联动

**配置管理（Team Server 侧）**：Release 详情新增"告警回调"配置区（项目级默认 + Release 级覆盖），`/deploy` 时随 Release 下发容器；测试套件运行不触发 webhook（仅运行时 execute 触发）。

### 10.4 窗口语义：滑动（sliding） vs 跳跃（tumbling）

**现状（v1.1 全部为滑动窗口）**：当前所有语句使用 `#time(n)`（如 `NH3Reading#time(3 minutes)`），这是 **Esper 滑动窗口（sliding）**——每个事件进入时窗口向前滑动并立即评估一次。实测氨气 demo：3 个事件注入窗口聚合语句 → 3 次输出（每事件一次），属正常流式语义，不是重复告警。

| 维度 | 滑动 `#time(n)`（当前） | 跳跃 `#time_batch(n)`（tumbling/batch） |
|---|---|---|
| 评估时机 | 每个事件进入时 | 窗口周期结束时统一输出一次 |
| 输出次数 | 窗口内每个事件各输出一次（需去抖） | 每周期至多一次，输出稳定 |
| 实时性 | 高（事件到达即判定） | 延迟一个窗口周期 |
| 适合场景 | 超标即告警（氨气/温度超限） | 周期性巡检判定（每 5 分钟汇总一次），告警次数可预期 |

* **业务影响**：滑动窗口下窗口聚合告警可能连续触发，webhook fired 需要去抖（§10.3）；跳跃窗口输出稳定但响应有延迟，两者取舍由业务决定
* **建议**：Visual EPL Builder 模板（`cep-visual-editor-design.md` §5.1）增加**"窗口类型"参数**——滑动（默认，`#time(n)`）/ 跳跃（`#time_batch(n)`）；Step 0 模板编译验证覆盖两种窗口；高级模式可自由使用任意窗口写法
* **与 cleared 联动**：滑动窗口聚合值回落判定（§10.3 P2）在跳跃窗口下天然对应"周期结束条件不满足"，实现更简单——可作为 cleared v1.1 的替代方案（若业务能接受周期语义）



***

## 11. 验收清单

### 引擎路由



* [x] 项目创建可选 engine（默认 rules），创建后锁定

* [x] 编译 / 测试按项目引擎路由到对应 Build 服务；发布 / 执行按项目引擎路由到对应 Runtime 服务（CEP 为真实 Esper 8.8.0 服务）

* [x] 旧项目（无 engine）默认 rules，全部现有功能零回归

### CEP 资产



* [x] CEP 项目内可创建 / 编辑 / 发布 EventStream（EPL 语句集）

* [x] EPL 编译校验与错误提示（真实 Esper EPL 编译）

* [x] BOM Core `fields[]` + CEP `eventTypes[]` 事件视图自动生成 schema，随 EventStream version 和 Release 冻结；旧 BOM 可回退到 `fields[].factType` 分组

* [x] 变更集支持 event-stream 类型，批准后 published

* [x] EventStream 默认使用 BOM 驱动向导，高级 EPL 作为次级入口；资产和语句具备删除闭环

### 测试与发布



* [x] CEP 套件：事件流输入 + 期望事件断言可运行、结果可展示

* [x] CEP Release：schema v2 校验、质量门禁（EPL compile + 套件）通过，真实 Esper Runtime local deploy/execute 可用

* [x] Release 展示 engine 徽标

### 报告与 UI



* [x] CEP 项目报告：事件流资产统计正确；rules 项目报告结构不变

* [x] CEP 项目导航隐藏规则 / 规则集，显示事件流入口

### 回归（不得破坏）



* [x] rules 项目：BAL / 决策表 / 规则集 / 规则集 / 测试 / Release 全链路正常

* [x] 现有测试套件 schema 与运行不受影响

* [x] report 接口对 rules 项目输出不变



***

## 12. 风险与依赖



| 风险                         | 等级 | 缓解                                         |
| -------------------------- | -- | ------------------------------------------ |
| Esper GPL v2 许可（对外分发需商业授权） | 高  | 已按需求接入真实 Esper；对外分发前需完成公司合规评估 / 商业授权       |
| Esper 无内置持久化（宕机丢状态）        | 中  | v1 接受；需要时评估 EsperHA/Enterprise 或外部状态回放     |
| 双引擎运维 / 编译面翻倍              | 中  | v1 CEP 仅支持最小资产集（EventStream），Event Flow v2 |
| EPL 学习曲线（业务规则人员）           | 中  | 编辑器语法高亮 + 编译反馈 + 测试套件引导                    |
| 与现有 8788 单引擎调用的兼容改造        | 低  | Step 1 先行并全量回归                             |

依赖：



* Esper 8.8.0 依赖（Maven/Gradle 引入或容器镜像构建）

* Docker 环境新增容器（与 rules-engine-1 并行）



***

## 13. 与现有文档关系



* `docs/ruleflow-editor-design.md`：规则集编辑器（rules 项目侧）设计，不受影响

* `docs/bom-editor-design.md`：BOM 复用，新增 "事件类型→Esper schema" 映射

* `docs/decision-table-design.md` / `docs/bal-editor-design.md`：rules 侧资产，CEP 项目隐藏

* `docs/report-design.md`：报告引擎分支扩展

* `docs/platform-issues-and-fixes.md`：记录 P1「项目级引擎路由（rules/cep）」已完成真实 Esper 集成；合规授权仍需项目方确认



***

## 14. 术语表



| 术语               | 说明                                         |
| ---------------- | ------------------------------------------ |
| Team Server（RTS） | 规则 / 事件资产统一管理服务（本平台 Team Server）           |
| RES              | 规则执行服务器（Drools 容器）                         |
| CEP              | Complex Event Processing，复杂事件处理            |
| EPL              | Esper Event Processing Language（SQL-92 扩展） |
| EventStream      | CEP 项目资产：EPL 语句集                           |
| engine           | 项目引擎类型：rules（Drools）/cep（Esper）            |
