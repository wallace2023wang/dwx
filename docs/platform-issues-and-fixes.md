# 规则平台落地问题清单与改进需求

> 产品：Decision Workbench（复刻 IBM ILOG JRules / ODM）
> 来源：粮库温控告警规则集全流程真实落地（BOM → 包 → BAL/决策表 → 规则流 → 测试套件 → Release → RES）过程中实测发现
> 状态：2026-09-30 已完成本轮修复与回归；当前待办以 0.2 节为准，后续章节为历史追溯与回归基准
> 关联：`bom-editor-design.md`、`decision-table-design.md`、`project-package-crud-design.md`、`report-design.md`

---

## 0. 问题分类总览（历史追溯）

| 模块 | 问题数 | P0 | P1 | P2 |
|---|---|---|---|---|
| API 契约一致性 | 5 | 1 | 3 | 1 |
| 决策表编辑器/引擎 | 5 | 1 | 3 | 1 |
| BOM 模型 | 3 | 0 | 2 | 1 |
| 规则流 | 3 | 0 | 2 | 1 |
| 测试套件 | 3 | 0 | 2 | 1 |
| Release / 质量门禁 | 2 | 0 | 2 | 0 |
| 前端遗留 | 4 | 0 | 2 | 2 |
| 引擎语义 | 2 | 0 | 2 | 0 |

### 0.1 已完成 / 保留处理状态（2026-09-30）

| 问题 | 状态 | 本轮结果 |
|---|---|---|
| 1.1 / 1.5 测试套件路由与单套件运行 | 已完成 | canonical 路由为 `/api/projects/:id/test-suites`，旧 `/tests` 兼容；单套件运行支持 `targetVersion` |
| 1.2 Change Set 类型命名 | 已完成 | 接受 `type`/`kind`，`decision-table` 归一为 `table` |
| 1.3 revision 冲突 | 已完成 | 支持 `If-Match`，冲突响应包含客户端修订、`currentRevision` 和当前快照 |
| 1.4 decisionService 前缀 | 已完成 | 真实项目自动补项目 ID；错误前缀返回正确格式示例 |
| 2.1 空条件通配 | 已完成 | 编辑器常驻提示、行完整条件 tooltip、全空条件保存确认和服务端 warning |
| 2.2 / 2.3 区间与内联比较符 | 已完成 | 支持 `<0.8`、`[20,25)` 等写法，保留 `20..25` 兼容语法并补齐边界测试 |
| 2.4 诊断分级 | 已完成 | 编辑器按错误、警告、提示分级展示重叠、冲突、不可达和缺口 |
| 2.5 / 4.3 多步骤写同一输出 | 部分完成 | 规则流编辑器已预警“后执行覆盖前值”；可配置最大值/聚合归并策略仍需独立领域设计 |
| 3.1 BOM 模型叙事 | 已纠正 | 持久化与领域层仍使用 flat `fields[]`；项目 API 和前端提供 `factTypes[]` 编辑视图 |
| 3.2 / 3.3 BOM 联动 | 已完成 | 条件/动作按方向过滤，操作符和值控件按七种业务类型联动，Enum 使用 BOM 枚举值 |
| 4.1 草稿资产编排 | 暂不调整 | 当前仍要求引用已发布资产；不自动发布依赖，避免绕过审批与发布治理 |
| 4.2 依赖资产升版 | 已完成 | 规则流返回 `needsRepublish/outdatedDependencies`，前端显示重新发布提示 |
| 5.1 / 8.1 / 8.2 缺失输入 | 已完成 | 报告展示 `inputFacts/omittedFields`，BOM input 可标记 `required`，缺失时 Team Server 与 RES 均拒绝执行；新发布产物用包装类型保留可选数字/Boolean 的 `null` 语义 |
| 5.2 / 5.3 测试报告 | 已完成 | 报告按 `targetVersion` 展示并以 `assertions[]` 为准，未提供字段有明确说明 |
| 6.1 门禁失败摘要 | 已完成 | `409` 增加最小 `failedCases` 摘要，包含版本、用例及失败断言 actual/expected |
| 6.2 Release 最新版 | 已完成 | 创建、列表和部署响应均返回 `latestForDecisionService`，前端标记“最新” |
| 7 前端遗留 | 已完成 | 产品名、BOM 编辑、真实项目 API 和决策表编辑入口均已落地；演示项目仍使用 mock |

本轮不改变 Drools 的确定性“后写覆盖”行为，也不自动发布规则流依赖。两项都涉及审批、版本和运行语义，必须通过独立需求设计后实施。

### 0.2 当前开放待办（后续开发只看本节）

| 待办 | 优先级 | 当前结论 | 下一步 |
|---|---|---|---|
| 大规模规则项目容量专项 | P1（规模化） | 当前全量接口、非虚拟化列表、同步组合编译适合中小规模；目标见 `docs/product-requirements.md`“容量与规模化基线” | 先完成 1k/5k/10k 基准，再按瓶颈实施服务端分页、虚拟列表、异步编译、制品外置和 RES 缓存 |
| 同字段多步骤输出归并策略 | P1 | 仅完成覆盖预警；最大值/优先级/聚合归并仍未设计 | 独立领域设计，明确审批、版本与运行语义后开发 |
| 双引擎项目路由（rules / cep） | 已完成真实 Esper 集成 | 项目 `engine`、四路端点、EventStream、CEP TestSuite、Release v2、报告与 UI 分支已落地；`cep-build:8791` 与 `cep-res:8792` 已接入 Esper 8.8.0；CEP 容器 backlog（`/events/{releaseId}`、webhook fired/cleared、`CEP_API_KEY`、`/openapi.json`、`/metrics`）已落地；pattern/timer 时间驱动语句 P0 已落地 | 保持 rules 全链路回归；未来对外分发再补商业授权或替换引擎评估 |
| 自动充氮控制 | P1 | 属于规则侧状态机 + 定时器 + 暂停/继续，不是 CEP v1 范围 | 已落地：见 `docs/nitrogen-auto-fill-asset-design.md`（BAL 规则版，阈值判定在规则内、阈值作为参数）。落地过程暴露的平台缺口已转为独立需求 `docs/requirements-platform-gaps-nitrogen.md`（R1–R10） |
| Rule Group 部署支持 | **P0（已完成）** | `res/ResServer.java` 允许 `rule`/`table`/`rule-group`，OpenAPI 已同步 | JUnit 覆盖部署、执行和非法 mapping；见 `requirements-platform-gaps-nitrogen.md` R1 |
| 废弃资产语义 | **P0（已完成）** | 生命周期独立为 active/deprecated/archived；废弃资产保留包归属与历史但不再参与执行 | 已含废弃、恢复、归档、审计、包解析和 PostgreSQL 持久化测试；见 R2 / R8 |
| 决策表条件字段引用 | P1（已完成） | 条件单元格支持同类型 input 字段比较，覆盖 UI、DRL、静态分析、BOM 引用统计和 XLSX/CSV 往返 | 见 `requirements-platform-gaps-nitrogen.md` R3 |
| 规则间中间结果传递 | P1（已完成） | RES 支持受限 `settle` 多轮执行和显式 `output -> input` 反馈映射，返回逐轮轨迹并有 20 轮硬上限 | 见 `requirements-platform-gaps-nitrogen.md` R4 |
| 未赋值 Boolean 的 null 语义 | P1（已完成） | 新发布产物将 Integer/Double/Boolean 生成为 Java 包装类型，未传保持 `null`；必填字段仍在 Team Server 与 RES 拒绝 | JUnit 覆盖可选 Boolean 的 null 守卫；见 `requirements-platform-gaps-nitrogen.md` R5 |
| 规则参数化与运行期调参 | **P0（待开发）** | 规则侧参数化已完成（`valueSource:field`，实测改参数即改行为、无需重新发布）；缺口在**运行期调参**（现状只能创建任务时传，改动需重启任务并丢失环流累计/暂停点/指令流水）与**安全联锁可达性**（maxPct=95 使 safetyMaxPct=99 不可达，安全功能失效） | 见 `docs/requirements-rule-parameters.md`（P1–P3、S1）；P2 需客户先确认阈值语义 |
| Esper 合规评估 | 已确认当前可接受 | 已按需求引入 Esper 8.8.0；项目方确认当前不做商用应用 | 若未来涉及对外分发，再补商业授权或替换引擎评估 |
| BOM Event Profile | 已完成 | 采用统一 BOM Core + `eventTypes[]` 事件视图；规则侧仍用 `factType/factTypes`，CEP 侧优先用 Event Profile 生成 Esper schema | 后续可补前端 Event Profile 专用编辑 UI |

### 0.3 阅读约定

* 第 1-8 节保留真实落地时的原始现象，作为回归基准和事故追溯，不代表当前仍待开发。
* 判断是否需要开发，以 0.2 节和每条“当前处理状态”为准。
* 新需求评审不得直接按第 10 节旧顺序执行；第 10 节已改为当前待办顺序。

---

## 1. API 契约一致性（历史追溯，已完成）

### 1.1 【P1】测试套件路由不一致：`/tests` vs `/test-suites`
- **现象**：后端项目级测试套件路由是 `GET/POST /api/projects/:id/tests`（`handleProjects` 内 `segments[3] === 'tests'`），而顶层路由存在 `/api/test-suites`（`handleTestSuites`）。调用 `/api/projects/:id/test-suites` 返回 405。
- **影响**：前端 `TestsTab` 与后端路径语义分裂；集成方按直觉调 `/test-suites` 直接失败。
- **建议**：统一为 `/api/projects/:id/test-suites`（与其它资源命名一致），`/tests` 保留兼容重定向或弃用；前端同步。

### 1.2 【P1】变更集 item 用 `type` 而非 `kind`，且决策表类型是 `table` 不是 `decision-table`
- **现象**：`shared/changes.js` 校验 `item.type ∈ {rule, table, flow}`。首次按直觉传 `{kind:'rule'}` 报"变更集包含无效资产引用"；创建决策表时资产类型是 `decision-table`，但变更集里必须写 `table`。
- **影响**：外部集成方两套命名（资产创建 API vs 变更集 API），易错。
- **建议**：变更集接受 `kind` 与 `type` 双别名；类型枚举统一（`decision-table` 与 `table` 归一，或明确文档化）。

### 1.3 【P0】资产发布后 revision 自增，PUT 需最新 revision，无提示
- **现象**：决策表 PUT revision=2 报"资产已被其他用户修改，请刷新后重试"。发布/变更集提交后 revision 从 N 跳到 N+2（甚至更高，如 1→3、6→8）。
- **影响**：脚本化落地频繁踩坑；前端若缓存旧 revision 会静默失败。
- **建议**：PUT 支持 `If-Match` 头语义或返回 `expectedRevision`；错误信息中带当前最新 revision（前端可自动刷新重试）。

### 1.4 【P1】非 default 项目 Release 的 decisionService 必须以 `projectId/` 开头
- **现象**：`decisionService: "grain-alarm"` 在 default 项目可用，但在真实项目 `project-cb74fc72` 报错，需写 `project-cb74fc72/grain-alarm`。
- **影响**：命名规则未文档化，首次失败无明确指引。
- **建议**：创建 Release 时若 decisionService 缺前缀自动补全，或校验错误信息中给出正确格式示例。

### 1.5 【P2】测试套件运行接口路径模糊
- **现象**：`POST /api/projects/:id/tests/run` 跑**全部**套件；单套件运行无 `POST /tests/:id/run`（只有 PUT 整体更新）。
- **影响**：无法针对单个套件快速回归（调 `POST /tests/:id/run` 返回 405 或落到错误分支）。
- **建议**：补充单套件运行端点，返回 `targetVersion` 可指定版本。

---

## 2. 决策表（历史追溯，已完成）—— 与 `decision-table-design.md` 直接相关

### 2.1 【P0】空单元格语义 = "不限制"，极易误用
- **现象**：第 4 行条件写 `["0.8", ""]` 期望表达"均温不参与"，实际空单元格=不限制，导致**任何 coverageRate≥0.8 的输入都命中该行**，覆盖前 3 行结果，整表失效。
- **影响**：这是决策表设计最隐蔽的陷阱，业务人员 100% 会踩。
- **建议**：
  - 编辑器空单元格给出明确 tooltip："空 = 该条件不参与匹配（通配）"，并在表头列名旁常驻提示
  - 行 hover 时显示该行编译后的完整条件（如 `coverageRate>=0.8 AND (无条件)` → 高亮"无条件"）
  - 保存前校验：若存在"条件全空"的行，弹确认（可能是误配）

### 2.2 【P1】区间语法 `a..b` 是闭区间，`..b` 是 `<=b` 不是 `<b`
- **现象**：`..0.8` 编译为 `coverageRate <= 0.8`，与 `>=0.8` 行在 0.8 处重叠。实测用内联比较符 `<0.8` 才表达严格小于。
- **影响**：边界重叠导致双命中、结果被覆盖；数值分档类决策表（温度/覆盖率阈值）几乎必踩。
- **建议**：编辑器支持半开区间表达（如 `(a,b)`、`[a,b)`），或将区间换算为多个比较符片段实时预览；重叠 warning 文案给出具体边界值。

### 2.3 【P1】单元格内联比较符能力存在但 UI 不可见
- **现象**：`parseConditionCell` 支持 `<0.8`、`>=25` 等内联运算符覆盖列运算符，但 `decision-table-design.md` 与前端编辑器是否暴露该能力未确认。
- **影响**：能力有但不可发现，业务人员只能用列运算符+区间，表达力受限。
- **建议**：编辑器条件单元格支持直接输入比较符前缀，输入时联想可用运算符；文档明确"单元格语法：比较符+值 / 区间 / 枚举"。

### 2.4 【P1】重叠/缺口 warning 无法区分"必须修复"与"业务合理"
- **现象**：v2 决策表产生 warning："第 1 行与第 2 行条件重叠且动作冲突（严重档覆盖告警档，COLLECT 下语义正确）"、"命中缺口（21-25℃ 正常区间不告警，业务合理）"。
- **影响**：warning 全量展示会让业务人员误以为表有错；或缺省压制又漏掉真问题。
- **建议**：warning 分级——`error`（条件全空/列数不匹配等硬错误）、`warn`（重叠但结果兼容、缺口有默认行）、`info`（业务性缺口提示）。编辑器按级着色。

### 2.5 【P1】多规则/多行写同一 output 字段：COLLECT 下后执行覆盖
- **现象**：决策表第 1 行写 `maxCandidateLevel=告警`、第 2 行写 `严重`，32℃ 双命中后**后行覆盖前行**→ 严重（本次语义正确）；但跨资产（BAL 最高温规则写 `maxCandidateLevel`，决策表恢复候选行写同一字段）出现**覆盖性错误**——最高温 34℃ 场景被决策表恢复候选行覆盖为"无"。
- **影响**：这是平台级语义问题，不只决策表。规则流步骤顺序决定输出覆盖方向，业务上"严重>告警>恢复"的优先级必须靠**步骤顺序**或**引擎外归并**保证。
- **建议**：
  - 平台文档明确"同字段多写 = 顺序覆盖"语义
  - 提供**归并策略配置**（取最大/最后/聚合），对应 JRules 多命中归并（粮库设计 §4.5）
  - 规则流设计器在连接线上提示"此步骤将覆盖输出字段 X"

---

## 3. BOM 模型（历史追溯，已完成）

### 3.1 【P1】BOM 实际已是 factTypes[] 嵌套，与 bom-editor-design.md 的"flat fields[] 迁移"叙事不一致
- **现象**：`GET /api/projects/:id/bom` 返回 `{factTypes:[{name,label,direction,fields:[...]}]}`（粮库 8 事实类型/40 字段），**非** flat `fields[]`。但 bom-editor-design.md 描述后端存 flat fields[]、前端已是 factTypes[]，需兼容迁移。
- **影响**：设计文档与实现现状不符，codex 若按文档做迁移可能破坏现有数据。
- **建议**：以现状（factTypes[] 为主模型）重写 bom-editor-design.md 的模型章节；确认 `shared/bom.js` 的 `findField/inputFields/outputFields` 已适配嵌套结构。

### 3.2 【P1】决策表条件列只接受 input、动作列只接受 output，编辑器需联动过滤
- **现象**：`validateTable` 硬校验条件列 `field.kind==='input'`、动作列 `kind==='output'`；Boolean 条件仅 `==/!=`。
- **影响**：编辑器若不做 BOM 联动过滤，用户选择 output 字段作条件直接保存失败。
- **建议**：条件列下拉只列出 input 字段并按类型过滤运算符；动作列只列出 output 字段；Boolean 特殊处理（仅 ==/!=，UI 给开关）。

### 3.3 【P2】枚举字段值校验依赖 BOM enum 定义
- **现象**：`parseConditionCell` 对多值枚举校验值必须在 `field.enum` 内；BOM 未定义 enum 时放行任意值。
- **影响**：规则与 BOM 枚举漂移无法提前发现（运行时才失败）。
- **建议**：编辑器在枚举字段输入时下拉联想 enum 值；BOM 未定义 enum 时提示"该字段无枚举约束"。

---

## 4. 规则流（开放待办 + 历史追溯）

### 4.0 【已完成】规则流画布直编 + Rule Group
- **原现象**：画布只读，节点只能逐条绑定规则或决策表，几千条规则时无法有效编排。
- **完成情况**：已改为 React Flow 主编辑器；规则包可作为 Rule Group 节点拖入，发布时冻结成员、版本、BOM、组合 DRL 和 fingerprint；继续保留最多 8 分支的受限拓扑。
- **设计与容量边界**：见 `docs/ruleflow-editor-design.md`。成员预览分页、千级规则编译基准及成员级命中轨迹仍归入“大规模规则项目容量专项”，不回退 Rule Group 的快照语义。

### 4.0.1 【P1】项目级引擎路由：规则项目（rules/Drools）与 CEP 事件项目（cep/Esper）双引擎并行
- **背景**：客户新增自动充氮（状态机+定时）与传感器流监控（跨事件时间关联）需求；IBM ODM 产品线本身为 Decision Server（规则）+ Decision Server Events（事件）双引擎并行架构，本平台应还原该形态。
- **现状**：`server/index.js:19` 为全局单引擎 URL（`ENGINE_URL || 8788`）；项目模型（约 450-460 行）无 engine 字段；资产类型枚举（changes.js）仅 rule/table/flow。
- **设计**：见 `docs/dual-engine-architecture-design.md`（引擎路由模型、EventStream 资产、BOM→Esper schema、编译/测试/发布/报告分支、4 步开发拆分、验收清单）。
- **状态**：设计已完成评审；需按 `docs/dual-engine-architecture-design.md` 中的端点拆分、Release schema、BOM mapping、CEP 测试套件 envelope 修订后再开发。

### 4.1 【P1】流程步骤只接受已发布资产
- **现象**：首次 PUT 流程引用草稿决策表，报"引用的资产不存在或未发布"；发布 9 条规则后才成功。
- **影响**：开发流程被强制"先发布资产再编排流程"，与 JRules"草稿可编排、发布时校验"不符，阻断迭代。
- **建议**：草稿步骤允许引用草稿资产（仅 compile/publish 时校验已发布），或提供"发布前自动发布依赖资产"选项。

### 4.2 【P1】发布规则流后 revision 联动自增，需重新 compile/publish
- **现象**：发布决策表 v3 后，规则流 revision 自动从 4→5；需 PUT 相同 draft + compile + publish 才生成含新资产的规则流 v3。
- **影响**：资产升级到新版本时，依赖它的流程不感知（静态快照），需人工重发。
- **建议**：资产发布时自动标记依赖流程"过期"（`needsRepublish: true`），Release 创建时提示；或流程步骤支持版本范围（引用 >= v3）。

### 4.3 【P1】COLLECT 命中策略下步骤顺序决定字段覆盖
- **现象**：规则流第 10 步（决策表）写 `maxCandidateLevel`，覆盖第 5/6 步（最高温规则）的同字段值——最高温 34℃ 一度被决策表"恢复候选"覆盖为"无"。
- **影响**：步骤排序是隐藏的业务逻辑，乱序=错误结果。
- **建议**：同 2.5 归并策略；规则流设计器对"写同一输出字段的相邻步骤"给出可视化警告。

---

## 5. 测试套件（历史追溯，已完成）

### 5.1 【P1】测试用例 facts 缺字段时按默认值（0）参与引擎计算
- **现象**：最高温用例未传 `averageTemp`（默认 0），决策表恢复候选行 `<=21` 命中（0≤21），覆盖最高温告警。套件断言 `assessmentCategory=最高温` 失败。
- **影响**：用例编写者以为"只测最高温不用管均温"，引擎却用默认值参与所有规则判定——断言失败难以归因。
- **建议**：运行报告展示"用例实际生效的完整 facts（含默认值补全）"；编辑器提示未提供的 input 字段将取默认值。

### 5.2 【P1】套件 targetVersions 自动推进但断言不感知版本差异
- **现象**：`targetVersions:[1,2]` 自动记录流程版本；流程 v2→v3（加决策表）后，同一套件在 v3 上 1/5 通过（决策表误命中），在 v1 上全过。
- **影响**：套件"历史通过"与"当前失败"并存，质量门禁只看最新版本，但 UI 需清晰区分。
- **建议**：套件列表按 targetVersion 分组显示最近运行；门禁失败时明确"哪一版本、哪一用例、实际 vs 期望"。

### 5.3 【P1】run 报告 case 结构对前端不友好
- **现象**：case 含 `assertions[]`（type/field/label/expected/actual/passed），但顶层 `expected/actual` 为 null，前端若只读顶层字段会误判"无断言"。
- **影响**：前端实现测试详情时容易出错。
- **建议**：顶层同步提供 `expected/actual` 聚合（或文档明确以 assertions[] 为准）。

---

## 6. Release / 质量门禁（历史追溯，已完成）

### 6.1 【P1】门禁失败返回体只给 gate+reports，无"最小失败集"
- **现象**：Release v2 首建失败（决策表误命中），返回 `gate.passed=false` + 两个套件报告，需人工遍历 9 个 case 找 4 个失败。
- **影响**：CI/CD 集成方无法快速定位。
- **建议**：门禁失败响应增加 `failedCases:[{suiteId, caseId, name, expected, actual}]` 摘要。

### 6.2 【P1】Release 版本号自动递增但无"覆盖 v1 语义"提示
- **现象**：同一 decisionService 建第二个 Release 自动 version=2；demo 若仍指向 v1 会静默执行旧规则。
- **影响**：运行时与治理态脱节。
- **建议**：Release 详情返回 `latestForDecisionService: true/false`；部署到 local 时提示"有新版本可用"。

---

## 7. 前端遗留（历史追溯，已完成）

| 项 | 级别 | 说明 |
|---|---|---|
| 3 处 "Decision Center" 残留（TopBar.tsx:42 / Login.tsx:41 / index.html title） | P1 | 产品名应为 Decision Workbench |
| BOM tab 只读 | P1 | 需按 bom-editor-design.md 落地可编辑 |
| `useBom()` 对非 default 项目硬编码 mock | P1 | 真实项目应走 API（粮库项目已验证 API 可返回 factTypes[]） |
| 决策表编辑器入口 | P2 | 资产页已有决策表类型展示，但编辑器是否可打开/编辑未验证 |

---

## 8. 引擎语义（历史追溯，已完成）

### 8.1 【P1】缺失数值字段默认 0 参与规则
- **现象**：同 5.1。引擎层 `parseFacts` 对未提供的 input 字段补默认值 0。
- **建议**：BOM 字段支持 `required` 标记；required 缺失时拒绝执行（400）而非默认 0。

### 8.2 【P1】Boolean 字段缺失默认 false 导致"取反类"规则误判
- **现象**：`hasActiveAlarm` 缺失→false；恢复候选规则（要求 true）不命中，行为正确但不可见。
- **建议**：执行报告 `facts` 中标注 `_defaulted:['hasActiveAlarm']`，供调用方识别隐式默认。

---

## 9. 落地修复记录（已完成，供 codex 回归参考）

| 时间 | 问题 | 修复 |
|---|---|---|
| 本轮 | 决策表空单元格误配导致全命中 | 第 4 行改 `<0.8`（内联比较符） |
| 本轮 | 恢复候选行 `<=21` 无活动告警前置，覆盖最高温判定 | 第 3 行加 `hasActiveAlarm=true` 条件，发布 v3 |
| 本轮 | 区间 `..0.8` 是 `<=` 不是 `<` | 文档 + 编辑器改进见 2.2 |
| 本轮 | 决策表加入流程后套件 1/5 失败 | 修复 2.1+2.2 后 9/9 通过，Release v2 gate PASS |

---

## 10. 当前建议实施顺序

1. **P0 风险项**：已按需求引入 Esper 8.8.0；当前项目不做商用应用，授权风险可接受；若未来对外分发需重新评估。
2. **P1 契约冻结**：修订并冻结 `docs/dual-engine-architecture-design.md` 中的 Build/Runtime 端点拆分、Release schema v2、BOM→Esper schema、CEP TestSuite envelope。
3. **P1 容量基准**：建立 1k/5k/10k 资产及决策表展开规则基准，先量化 API、浏览器、Build Service 和 RES 瓶颈。
4. **P1 规模化改造**：按基准结果实施服务端分页、虚拟列表、Rule Group 成员分页、异步编译、制品外置和 RES KieBase 缓存。
5. **P1 语义设计**：同字段多步骤输出归并策略（最大值/优先级/聚合）单独评审，明确审批、版本和运行语义。
6. **P1 业务场景**：自动充氮控制按规则侧状态机 + 定时器 + 暂停/继续单独补需求，不归入 CEP v1。
7. **回归基准**：第 1-8 节已完成问题继续作为 rules 全链路回归清单，防止双引擎改造破坏历史能力。

---

## 附录：验证用资产清单（回归基准）

> 注意：旧基准 `project-cb74fc72` 已在 codex report 开发期间重建为 `project-c429a9a0`（旧项目已 404 消失）。**当前权威回归基准为 `project-c429a9a0`**（粮库温控告警：8 factType/40 fields BOM、9 规则 + 决策表 + 规则流 10 步 + 2 套件 + Release v1，详见 `grain-alarm-rule-design.md` 与数据文件 `data/bom-project-c429a9a0.json`）。旧基准仅保留作历史追溯。

- 旧基准（历史）：项目 `project-cb74fc72`；决策表 `a4833e88-6fa3-47dd-a1f6-d0a64a0d21b7`（整仓均温判定决策表 v3）；规则流 `c4576dc6-0008-42d6-a514-eefa9b2c5187`（10 步 v3）；Release `e058c6f2-36c0-46b6-8c3c-738a4531439b`（v2，已部署 local，门禁 9/9）
- 当前权威：项目 `project-c429a9a0`；Release v1 `52cec7f8-fccb-4567-b8df-94563fbc19e5`（decisionService `project-c429a9a0/grain-alarm`，gate 9/9，deploy local，sha256:d88a445a0）
- 验收命令：`POST http://127.0.0.1:8790/execute {releaseId: 52cec7f8-fccb-4567-b8df-94563fbc19e5, facts:{averageTemp:32,coverageRate:0.95,...}}` → 期望 `state=BREACH, level=严重, fired 含"整仓均温判定决策表"`
