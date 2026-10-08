# 三产品技术设计

版本：0.10  
更新日期：2026-09-29

## 1. 系统边界

```text
┌─────────────────────────────────────────────────────────────┐
│ Rule Designer（React）                                      │
│ 规则 / 决策表 / 规则集 / 测试 / 中文业务词汇               │
└───────────────────────┬─────────────────────────────────────┘
                        │ 管理 API
┌───────────────────────▼─────────────────────────────────────┐
│ Rule Team Server（当前 Node，后续可独立服务化）             │
│ 资产版本 / 变更集 / 审批 / Release / Deployment / Audit     │
└───────────────┬───────────────────────────┬─────────────────┘
                │ 设计时编译                │ 部署不可变 Release
┌───────────────▼──────────────┐  ┌─────────▼─────────────────┐
│ Drools Build Service          │  │ Rule Execution Server     │
│ /compile /test，接受临时 DRL │  │ /deploy /execute          │
│ 不承载生产流量                │  │ 不读取草稿，不接受临时 DRL│
└──────────────────────────────┘  └───────────────────────────┘
```

现有 `engine/` 保持为设计时 Drools Build Service。新增 `res/` 是独立 Maven 项目、独立镜像和独立端口。两个服务暂时共用 Drools 版本，未来通过 Release 的 `engine.drools` 约束兼容性。

## 2. Release 数据契约

Release 使用规范化 JSON 表示。创建后除部署状态外不得修改内容。

```json
{
  "schemaVersion": 1,
  "id": "UUID",
  "decisionService": "default/customer-risk",
  "version": 3,
  "name": "客户风险决策 v3",
  "description": "国庆策略调整",
  "target": {
    "type": "flow",
    "id": "asset-uuid",
    "assetVersion": 5
  },
  "engine": {
    "type": "drools",
    "drools": "10.2.0"
  },
  "model": {
    "version": 4,
    "updatedAt": "2026-09-28T12:00:00.000Z",
    "fields": ["发布时完整 BOM 字段定义"]
  },
  "steps": [
    {
      "name": "准入规则",
      "type": "rule",
      "assetId": "rule-uuid",
      "assetVersion": 7,
      "drl": "package workbench ...",
      "inputMappings": [
        { "source": "approvedLimit", "target": "annualIncome" }
      ]
    }
  ],
  "variables": [
    {
      "name": "pctAtLeastMax",
      "label": "浓度达到最大值",
      "type": "Boolean",
      "defaultValue": false
    }
  ],
  "routing": {
    "type": "exclusive",
    "afterStep": 1,
    "branches": [
      {
        "id": "senior",
        "name": "年长客户",
        "default": false,
        "condition": {
          "field": "customerAge",
          "operator": ">=",
          "value": 50
        },
        "stepIndexes": [1]
      },
      {
        "id": "fallback",
        "name": "默认客户",
        "default": true,
        "condition": null,
        "stepIndexes": [2]
      }
    ]
  },
  "createdAt": "2026-09-29T00:00:00.000Z",
  "checksum": "sha256:..."
}
```

校验和覆盖以下规范化内容：

- `schemaVersion`
- `decisionService`
- `version`
- `name`
- `description`
- `target`
- `engine`
- `model`（新 Release 必填；旧 Release 缺失时按 legacy 契约验签）
- `steps`
- `routing`（分支规则集存在时必填；线性和 legacy Release 不包含）
- `variables`（Rule Project 变量的冻结定义，变量定义改变会改变 checksum）

不覆盖 Team Server 本地部署状态。JSON 属性按名称排序后进行 UTF-8 SHA-256，保证不同进程得到相同结果。

### 2.1 Release 构建规则

- 规则和决策表每次发布同时冻结结构化内容、完整 BOM、`bomVersion` 和已经通过编译的 DRL。
- 单规则：一个执行步骤，直接复用规则版本冻结的 DRL 和 BOM，不按当前模型重新生成。
- 决策表：一个执行步骤，直接复用决策表版本冻结的 DRL 和 BOM，不按当前模型重新生成。
- 线性规则集：每个已冻结流程步骤对应一个执行步骤，直接复用流程发布快照中的 DRL 和资产版本。
- 分支规则集：公共步骤位于 `steps[0..afterStep)`，各分支步骤继续扁平化写入 `steps`，`routing.branches[].stepIndexes` 冻结每个分支拥有的步骤。
- 流程步骤可包含 `inputMappings` 和 `outputMappings`。输入映射在节点执行前复制“流程上下文源字段 -> 节点输入字段”；输出映射在同名输出回写后复制“节点输出字段 -> 流程上下文目标字段”。
- 映射源和目标必须存在于冻结 BOM 且类型相同。输入映射目标必须是 `input`，输出映射源必须是 `output`；同组内目标不能重复，源和目标不能相同，每个方向最多 20 项。
- 未配置映射时继续使用同名字段传递。源值为 `null` 或不存在时不覆盖目标，并在轨迹中记录 `applied: false`。
- `routing.type` 当前仅支持 `exclusive`。公共步骤执行后按分支显示顺序判断，选择第一条满足条件的分支；全部条件不满足时选择唯一默认分支。没有默认分支时允许不执行任何分支步骤。
- 条件字段必须存在于冻结 BOM，当前支持 `==`、`!=`、`>`、`>=`、`<`、`<=`；发布快照把编辑器中的值转换为 BOM 对应的字符串、数字或布尔类型。
- 一个流程当前最多 8 个分支、全部公共和分支步骤合计最多 20 个；每个分支至少一个步骤，且最多一个默认分支。
- 规则集内全部步骤必须使用当前同一 BOM 版本；模型升级后需重新发布被引用资产，禁止混合不同 `RuleInput` 结构。
- Release 只引用已发布版本，不读取未保存或未发布草稿。
- 规则集是最小发布与执行单元。Ruleset Variable 正式定义位于 Rule Project 属性，规则、决策表和规则集编辑器只引用项目变量；规则级变量仅作为兼容 fallback。
- 同一个决策服务的版本号单调递增。
- Release、部署回执和版本序列按项目隔离；非默认项目的 `decisionService` 必须以 `{projectId}/` 开头，避免服务标识跨项目混用。
- Team Server 执行代理按 Release 的 `model` 校验输入；RES 仍以 DRL 中的 `declare RuleInput` 反射字段，两侧契约互相校验。
- 改造前创建的 legacy 资产版本没有 BOM/DRL 快照，只能尝试用当前 BOM 生成；若字段或枚举已不兼容则拒绝创建 Release，需显式迁移并重新发布，系统不得猜测历史模型。

### 2.2 决策表命中策略

- 条件单元格既可保存字面量，也可保存 `{ valueSource: "field", valueField }`。字段比较只允许同一冻结 BOM 中不同的 input 字段且语义类型一致；DRL 右值直接生成字段名，不加引号。冲突与覆盖分析无法静态确定运行时字段值时返回 `unknown`，不得误报确定重叠。
- CSV/XLSX 以 `${fieldKey}` 表示业务字段引用，导入预览和导出必须无损往返；旧版字符串单元格继续兼容。
- `ALL`：所有匹配行按显示顺序执行。生成的 `salience` 保证顺序稳定，后执行行可覆盖前一行写入的同一结果字段。
- `FIRST`：显示顺序靠前的匹配行拥有更高 `salience`，并通过 Drools `activation-group` 保证只执行一行。
- `PRIORITY`：先比较行级业务优先级，再按显示顺序打破同优先级并列；同样通过 `activation-group` 保证只执行一行。
- 规则集快照、单表 Release 和全量 DRL 导出都使用决策表资产 ID 构造互斥组，多个决策表不会互相取消激活。
- 旧版本决策表未包含 `hitPolicy` 时按 `ALL` 解释，不修改已发布快照。
- `COLLECT`：所有匹配行按显示顺序执行，同时在 DRL 中声明并插入 `DecisionHit` 事实，RES/Engine 返回独立 `decisionHits` 命中结果集合；旧 `ALL` 仅保留覆盖式兼容语义。

决策表设计时试运行除 Drools 原始 `fired` 外还返回 `decisionTrace` 和 `decisionHits`。每个轨迹项包含实际命中顺序、原始规则名、决策表行号、是否默认行以及动作赋值；`ALL` 同一输出字段被后续命中再次写入时记录 `previousValue` 和 `previousOrder`，`COLLECT` 则把每行输出记录为独立集合项。前端以该结构高亮命中行并解释覆盖链，不通过规则名正则推断行号。

## 3. Team Server API

### `GET /api/releases`

返回 Release 列表，按创建时间倒序。

### `POST /api/releases`

请求：

```json
{
  "decisionService": "default/customer-risk",
  "name": "客户风险决策",
  "description": "首次发布",
  "target": { "type": "flow", "id": "asset-uuid" }
}
```

处理流程：读取已发布快照、生成步骤、调用 Build Service 编译每一步、实时运行该目标的全部必需测试套件、生成版本号和校验和、原子写入 Release 仓库。任一必需套件失败返回 `409` 和结构化 `gate/reports/failedCases`，不写入 Release；成功时在 Release 本地元数据中记录 `qualityGate` 摘要，该摘要不参与制品校验和。创建和列表响应携带 `latestForDecisionService`，供治理端识别同一决策服务的旧版本。

### `POST /api/releases/{id}/deploy`

请求：

```json
{ "environment": "local" }
```

Team Server 把完整 Release 发送给 RES `/deploy`，成功后记录部署回执。MVP 只支持 `local` 环境。首次部署的决策服务自动成为当前生效版本；已有生效版本时，新部署只进入“已部署”状态，不自动切流。

### Release 激活、回退和卸载

- `POST /api/projects/{projectId}/releases/{id}/activate`：将该 Release 原子设为同一 `decisionService + environment` 的唯一生效版本，其他已部署版本保留为回退目标。
- `POST /api/projects/{projectId}/releases/{id}/rollback`：仅允许对当前生效版本调用，激活版本号更低且最新的已部署版本。
- `POST /api/projects/{projectId}/releases/{id}/undeploy`：卸载非生效版本，调用 Runtime `/undeploy` 释放会话池并删除持久化制品；当前生效版本必须先切换或回退。
- 部署回执使用 `status: deployed | active | stopped`。旧回执没有 `status` 时，同一服务和环境中版本号最高的已部署 Release 被兼容推导为生效版本。
- 激活、回退和卸载均写入审计事件，且需要 `release` 权限。

### `POST /api/projects/{projectId}/services/{serviceKey}/execute`

稳定业务入口按 `decisionService + local` 解析当前生效 Release，再携带其不可变 `releaseId` 调用 Runtime。激活和回退不要求调用方修改 URL；没有生效版本时返回 `409`。显式 Release 执行端点继续保留，用于历史重放和运维验证。

### `POST /api/releases/{id}/execute`

这是管理端试运行代理，只用于演示和运维验证。生产业务系统应直接调用 RES。

```json
{ "facts": { "creditScore": 580, "overdue": true } }
```

项目工作区接口只读取对应项目的已发布资产、BOM 和 Release；跨项目 Release ID 返回 `404`。项目删除时同步清理其 Release 和部署回执。

### 3.1 规则集设计期调试

`POST /api/flows/{id}/test` 除 `draft`、`published` 和 `facts` 外支持：

```json
{
  "stopAfter": "branch:senior:0",
  "expectedPath": "senior"
}
```

- 节点地址固定为公共步骤 `common:{index}`、条件网关 `gateway`、分支步骤 `branch:{branchId}:{index}`。
- `stopAfter` 在指定节点完成后暂停，不执行后续节点；响应 `debug.stoppedAt` 返回实际停止位置。
- `expectedPath` 对网关选择结果做断言，`null` 表示期望无匹配分支。断言不改变 HTTP 成功状态，通过 `assertions[].passed` 和顶层 `passed` 表达业务结果。
- 节点执行失败保留已完成 `trace`、当前 `facts` 和结构化 `failedStep`，其中包含节点地址、名称、类型、版本及分支信息。
- 设计期调试参数不会写入草稿或 Release，也不会发送给生产 RES。RES 的正常执行轨迹仍返回同一套稳定节点地址，运行时异常同样返回 `failedStep`。

### 3.2 测试套件与回归门禁

- `GET /api/test-suites`：返回未归档套件。
- `POST /api/test-suites`、`PUT /api/test-suites/{id}`：创建或更新套件，目标必须是已发布规则、决策表或规则集。
- `POST /api/test-suites/{id}/run`：运行单个套件并保存最近 20 次报告。
- `POST /api/test-suites/{id}/compare`：在同一目标的两个已发布版本上运行相同数据集，保存对比报告但不替换 `lastRun`。
- `POST /api/test-suites/run`：顺序运行全部活动套件，返回批量汇总。
- `POST /api/test-suites/{id}/archive`：归档套件。
- `/api/projects/{projectId}/test-suites`：上述接口的项目隔离 canonical 路由，覆盖列表、创建、更新、单套件运行、全量运行和归档；`/api/projects/{projectId}/tests` 保留兼容，顶层 `/api/test-suites` 是 `default` 项目的兼容入口。单套件运行可用 `{ "targetVersion": 1 }` 指定已发布版本。

每个案例包含基础输入事实，以及至少一个输出、命中规则或规则集路径断言。案例可选 `parameters[]`；每个参数行与基础输入浅合并并形成独立执行，参数只能覆盖 BOM 输入字段。单案例最多 100 个参数行，单套件展开后最多 1000 次执行。常规执行始终解析目标的最新已发布版本及其冻结 BOM/DRL/流程快照，不读取草稿。报告记录 `targetVersion`、`parentCaseId`、`parameterId`、`inputFacts`、`omittedFields`、逐案例实际输出、命中规则、路径、断言详情和耗时。未提供的可选输入保持未赋值；冻结 BOM 中 `required=true` 的 input 缺失时拒绝执行。

常规报告同时生成覆盖率：规则目标以 Drools 命中结果统计；决策表以 `decisionTrace[].rowIndex` 对所有启用行（含默认行）统计；规则集以分支 `path.branchId` 统计，无分支流程使用主路径。对比接口可显式指定 `baseVersion` 和 `candidateVersion`，默认使用最近两个版本；比较输出、命中规则、路径和断言状态，并分类为 `unchanged`、`changed`、`improved` 或 `regressed`。非 `unchanged` 项计入 `reviewRequired`。

Release 门禁不信任 `lastRun`：创建时重新运行当前项目内所有 `required=true` 且绑定同一目标资产的套件。非必需套件仅用于日常回归，不阻止 Release。测试目标解析、报告保存和门禁摘要始终携带同一个 `projectId`，跨项目套件 ID 返回 `404`。测试执行复用设计期的已发布资产执行函数，规则集节点映射、分支选择和轨迹语义只有一份实现。

### 3.3 Change Set 与审计

- `GET/POST /api/change-sets`：查询或创建变更集。
- `GET/PUT /api/change-sets/{id}`：查询或更新草稿变更集，更新使用 `revision` 乐观锁。
- `POST /api/change-sets/{id}/submit|approve|reject|reopen`：执行固定评审状态流。
- `GET /api/audit-events?limit=100`：按时间倒序查询追加写审计事件，最大返回 500 条。
- `/api/projects/{projectId}/change-sets`：对应的项目隔离接口；批准时重新编译并发布变更集固定的资产修订。
- `POST /api/projects/{projectId}/rules/{assetId}/submit`：将当前规则或决策表修订编译后直接创建待审核变更集。
- `GET /api/projects/{projectId}/audit-events?limit=100`：查询项目隔离的审计事件。

Change Set 保存时把资产类型、ID、资产修订号、最近发布版本、发布内容、当前草稿和差异列表全部固定到自身定义中。差异递归比较对象字段；带稳定 `id` 的数组按 ID 匹配，其余数组按位置比较，输出 `added/removed/changed`、字段路径和前后值。单资产最多保留 500 项差异。

状态机为 `DRAFT -> SUBMITTED -> APPROVED` 或 `DRAFT -> SUBMITTED -> REJECTED -> DRAFT`。提交要求至少一个资产且至少一项实际差异，驳回必须填写意见。项目资产提交后禁止保存、重命名、移动、删除和通过包操作间接修改；驳回后恢复编辑，批准时校验固定修订、BOM 和 Drools 编译结果后生成发布版本。审核动作串行执行，避免批准与驳回并发造成状态和发布版本分离。OIDC 模式使用验签 principal 作为 actor，并禁止提交人批准自己的变更；`local` 模式的 `x-actor` 仅用于本机原型，不可信，允许管理员自审以便开发测试。

资产可用性使用独立 `lifecycleStatus: active | deprecated | archived`，不复用评审/发布状态。废弃资产保留包归属、版本和既有 Release 追溯，但只读且不参与 Rule Group、直接规则集步骤或新 Release；废弃时记录操作者、原因和可选替代资产，恢复后回到活动草稿。归档资产默认不返回、不参与包成员解析和计数，通过 `includeArchived=true` 才用于历史查询。

### 3.4 项目报告

`GET /api/projects/{projectId}/report` 在项目级鉴权后生成自包含 HTML，不依赖外部 CDN 或前端运行时。聚合内容固定为六个章节：项目概览、BOM 事实类型与字段类型统计、规则/决策表资产清单、规则集步骤与分支拓扑、测试矩阵及覆盖率、Release 与部署历史。规则集报告优先使用 `published` 快照，草稿仅用于尚未发布的规则集；资产、测试套件和发布列表过滤归档对象并按项目隔离。

报告使用统一 HTML 转义处理项目名称、资产名称、业务描述和其他用户可控展示值。响应使用 `text/html; charset=utf-8` 和 UTF-8 文件名；前端项目报告页提供 HTML 下载和浏览器打印 PDF，打印时隐藏全局导航与报告工具栏并重复表头。空 BOM、空资产、空测试和空 Release 均展示明确空态，不阻断报告生成。

### 3.5 身份认证与 RBAC

`AUTH_MODE=local` 是默认开发模式，主体拥有 `admin` 权限；只有该模式读取 `x-actor`。`AUTH_MODE=oidc` 要求每个 `/api/*` 请求携带 Bearer JWT，并执行以下校验：

- 通过 issuer 的 `/.well-known/openid-configuration` 读取 `jwks_uri`，或使用 `OIDC_JWKS_URI` 覆盖。
- 校验 RS256/PS256/ES256 签名、`iss`、`aud`、有效期和非空 `sub`。
- 从 `roles`、Keycloak `realm_access.roles` 和指定 client 的 `resource_access` 提取允许角色。
- `viewer` 只读；`author` 修改资产、模型、测试和 Change Set；`reviewer` 查询审计并批准/驳回；`release-manager` 创建和部署 Release；`admin` 拥有全部权限。

`GET /api/session` 返回已验证主体、角色和权限。浏览器端已实现 OAuth 回调、PKCE、HttpOnly BFF 会话与退出，API 支持策略式项目/资产授权；自定义角色配置和服务账号尚未实现。服务仍绑定 `127.0.0.1`，生产部署不能使用 `local` 模式。

## 4. RES API

### `GET /health`

返回服务名称、Drools 版本和已部署 Release 数量。

### `GET /deployments`

返回当前节点已加载的 Release 摘要，不返回 DRL。

### `POST /deploy`

接收完整 Release。RES 执行：

1. 校验必需字段、大小、Drools 兼容版本和 SHA-256。
2. 编译每个步骤并构建内存中的 `KieContainer`。
3. 基于每个 `KieContainer` 创建 Drools `KieContainerSessionsPool`。
4. 将 Release 原子写入本地持久化目录。
5. 将会话池加入内存注册表。
6. 返回部署时间、步骤数和校验和。

相同 ID、相同校验和是幂等成功；相同 ID、不同校验和返回 `409`。

### `POST /undeploy`

请求 `{ "releaseId": "UUID" }`。卸载操作幂等：从内存注册表移除 Release、关闭其会话池并删除持久化 JSON；不存在时仍返回成功且 `removed=false`。流量是否允许卸载由 Team Server 的唯一激活约束控制，Runtime 本身不保存流量指针。

### `POST /execute`

请求：

```json
{
  "releaseId": "UUID",
  "requestId": "可选关联 ID",
  "facts": { "creditScore": 580, "overdue": true }
}
```

RES 使用部署时已经编译的容器和会话池依次执行步骤。每一步从对应 `KieContainerSessionsPool` 借出一个 `KieSession`，依次执行输入映射、Drools 节点、同名输出回写和输出映射；`dispose()` 将会话重置并归还池，`null` 不覆盖已有上下文值。响应包含最终事实、命中规则、逐步骤轨迹及实际应用的映射值。

请求可选 `settle=true`、`maxRounds`（2-20）和 `feedbackMappings[]`。反馈映射只能把同类型 output 显式复制到 input；RES 每轮重新执行冻结 Release，在无命中或反馈值不再变化时停止，返回 `rounds[]`，达到上限时返回 `limitReached=true`。默认不传 `settle` 时仍只执行一轮。

新发布 DRL 将 Integer、Double、Boolean 声明为 Java 包装类型。RES 创建事实后对调用方未提供的非 primitive 字段显式置 `null`，再写入已提供值，因此可选字段能区分未传与显式 `0`/`false`；冻结 BOM 中 `required=true` 的 input 缺失仍返回 400。既有 Release 继续使用原冻结 DRL。

`GET /openapi.json` 是 RES 的机器可读契约。`steps[].type` 完整枚举 `rule | table | rule-group`；规则组步骤的 `drl` 已合并全部成员，`members` 与 `memberFingerprint` 仅用于审计追溯，执行期不参与解析。

RES 会话池大小由 `res/config/res.properties` 的 `kie.session.pool.size` 配置，默认值为 `2`；也可用 `RES_CONFIG_FILE` 指向其他配置文件。

存在 `routing` 时，RES 先执行 `afterStep` 之前的公共步骤，再用此时的事实选择分支，仅执行该分支的 `stepIndexes`。轨迹在公共步骤与分支步骤之间增加 `type: "gateway"` 项，响应顶层 `path` 返回分支 ID、名称和是否默认分支。没有 `routing` 的历史 Release 仍按原有线性语义执行。

## 5. 存储与一致性

Team Server 支持两种存储适配器。未设置 `DATABASE_URL` 时使用 JSON 文件，便于本机演示和离线开发：

- `data/releases.json`：Team Server 的不可变 Release 与部署回执。
- `data/test-suites.json`：按项目隔离的测试套件、最近运行结果和最多 20 次历史报告；可用 `RULES_TEST_SUITES_FILE` 覆盖路径。
- RES 使用独立挂载目录，每个 Release 一个 JSON 文件。
- 写入临时文件后原子重命名。
- Team Server 与 RES 不共享文件系统，通过 HTTP 契约交互。

设置 `DATABASE_URL` 时，服务启动会自动执行 `server/migrations/*.sql`，并使用 PostgreSQL：

- `assets` 保存规则、决策表和规则集当前草稿、发布快照及 `revision`。
- `asset_revisions` 追加保存创建、保存、恢复产生的草稿快照；`asset_versions` 保存不可变发布版本。
- `bom_versions` 保存模型历史并保证每个项目只有一个活动版本。
- `test_suites`、`test_runs` 保存套件、版本感知报告和最近运行记录。
- `releases`、`deployments` 保存不可变 Release 内容和 RES 回执。
- `change_sets` 保存乐观锁修订、状态和冻结的评审定义；`audit_events` 仅追加核心操作事件。
- 工作空间当前固定为 `default`；项目、资产、BOM、测试套件、测试报告、Release、部署回执、Change Set 和审计事件已按 `project_id` 隔离。

`npm run db:import-json` 在一个数据库事务内导入现有 `data/*.json`。任一对象失败则全部回滚；目标库已有任意业务数据时拒绝执行，防止覆盖或重复导入。

资产和测试套件 API 使用期望 `revision`，BOM 使用期望 `version`。应用层先返回结构化冲突，PostgreSQL 写入事务再通过行锁比较数据库当前修订，防止多个 Team Server 进程绕过检查。冲突响应为 `409`，包含 `currentRevision` 和可用时的 `current` 快照。前端保留本地编辑并要求用户显式载入服务器版本。

项目记录持久化审核策略，Change Set 在提交时保存策略快照和逐人批准记录；1/2 人审核使用串行评审锁与乐观修订，只有最后一票触发发布。后续存储工作包括 Change Set 与 Release 强制关联；大型测试数据、构建日志和制品可迁移到对象存储，并补充备份恢复流程。

## 6. 安全演进

MVP 的本机端口仅绑定 `127.0.0.1`。生产前必须完成：

- Team Server 到 RES 的双向 TLS 或工作负载身份认证。
- Release 签名，不仅校验未损坏，还校验发布者身份。
- RES 管理端口和执行端口隔离。
- 禁用生产环境的原始 `/compile` 和 `/test`。
- 请求体、规则数、执行次数、超时和内存上限。
- DRL 高级模式进入受限审核流程；结构化生成器使用允许列表。

## 7. 关键架构决策

### ADR-001：Build Service 与 RES 分离

设计期需要快速编译任意草稿，生产执行只能运行已治理制品。两者威胁模型、可用性和容量模型不同，因此独立部署。

### ADR-002：Release 冻结 DRL

仅保存资产 ID 无法保证历史可重放。Release 同时保存结构化来源元数据和实际执行 DRL，RES 不回查 Team Server。

### ADR-003：规则集先采用短事务顺序执行

当前业务目标是决策编排。第一阶段只支持“公共步骤 + 单个排他网关 + 分支步骤”，不支持多级网关、并行、聚合、子流程或循环。人工任务和长事务交给 BPMN 引擎，避免 RES 演变为不完整的工作流系统。

### ADR-004：当前仓库采用单仓多项目

原型期把 Designer、Team Server、Build Service 和 RES 放在同一仓库便于同步契约与端到端测试；边界通过独立目录、进程、端口和镜像保证。稳定后可按团队和发布节奏拆仓，不以拆仓代替服务边界。

### ADR-005：JSON 与 PostgreSQL 共用领域 API

JSON 模式保留低门槛演示能力，PostgreSQL 模式承担多人协作所需的事务和数据库级乐观锁。业务路由不感知具体存储；一次性导入命令显式迁移数据，不在服务启动时隐式复制或覆盖。
