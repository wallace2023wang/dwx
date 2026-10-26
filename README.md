# DWX 决策工作台

DWX（Decision Workbench）是采用**双引擎、双脑架构**的决策工作台。

**双引擎**：**规则引擎**（Drools 10.2.0）负责规则、决策表与决策流的确定性推理；**复杂事件处理引擎**（Esper 8.8.0）负责 CEP 事件流的实时复杂事件处理。

**双脑**：**决策平台大脑**统一管理 BOM、规则、决策表、RuleFlow、CEP EventStream、测试套件、Change Set、Release、部署和审计，并按项目将规则请求路由到 Drools、将 CEP 事件流请求路由到 Esper；**大模型智能体大脑**（LLM Agent）面向智能化规则运营，基于规则命中情况自动分析与给出调整建议（见[未来规划](#未来规划)）。

规则侧使用 Drools 10.2.0，CEP 侧使用 Esper 8.8.0。当前项目用于本地研发、产品验证和客户 Demo，不是面向公网的商用部署方案。

规则、决策表和规则集支持草稿、修订历史、结构化差异、变更集评审、审计日志、版本发布、历史恢复、归档、试运行、参数化测试套件、版本行为对比、覆盖率、回归发布门禁、项目知识资产报告和已发布规则 DRL 导出。Rule Project 属性统一维护 Ruleset Variable；变量在规则集内由 `RuleContext` 在一次执行期间维护，不进入 BOM、不由 `facts` 传入，并在多步骤/settle 多轮之间保持；变量定义会冻结到 Release 并参与 checksum。CEP 侧支持 BOM Event Profile、EventStream、窗口聚合、pattern/timer 时间驱动语句、真实 Esper 编译与执行、webhook 告警、OpenAPI 和 Prometheus metrics。Team Server 支持 JSON 文件和 PostgreSQL 两种存储模式。

决策表支持内联比较符、闭区间及半开区间、空条件通配确认、同类型业务字段比较和分级诊断。规则集冻结依赖资产版本，依赖升版后会标记需要重新发布，并对多个步骤写同一输出字段给出覆盖警告。测试报告保留规范化输入与未提供字段；BOM input 可配置执行时必填，缺失时 Team Server 和 RES 返回 `400`。可选的数字和 Boolean 字段在新发布产物中使用 Java 包装类型，未传保持 `null`，不会与显式的 `0`/`false` 混淆。

“浏览”页提供跨项目资产目录，可按名称、规则包、项目和 BOM 业务术语搜索，并组合项目、资产类型、状态筛选；结果可直接定位到规则、决策表、规则集或 BOM 字段。

产品按规则设计中心、规则治理中心和独立规则执行中心（RES）三个边界演进。详细规划见 [产品需求说明](docs/product-requirements.md)、[技术设计](docs/technical-design.md) 和 [交付任务拆分](docs/delivery-plan.md)。

## 项目结构

```text
frontend/                 # 维护中的 React + Vite 前端应用
server/                   # Team Server API、认证、路由拆分、存储适配与数据库迁移
shared/                   # 前后端共享的规则、BOM、发布、测试和报表领域逻辑
  ruleset-variables.js    # Ruleset Variable 类型、默认值和声明校验
engine/                   # Drools 设计期 Build Service
res/                      # 独立规则执行中心（RES）
cep/                      # Esper CEP Build/Runtime Service
fixtures/demo-data/       # 可版本化的演示种子数据，供测试与本地初始化使用
data/                     # 本地运行时 JSON 存储目录，已被 .gitignore 忽略
e2e/                      # Playwright 端到端测试
test/                     # Node.js 单元与 API 测试
docs/                     # 产品、技术、设计与用户文档
archive/legacy-prototype/ # 早期单文件原型，仅保留为参考
```

`server/index.js` 仍是 Team Server 的组合入口；环境配置已拆到 `server/config.js`，事实输入规范化已拆到 `server/fact-parser.js`，通用 HTTP 工具已拆到 `server/http-utils.js`，资产修订/包名规范化工具已拆到 `server/domain-utils.js`，JSON/PostgreSQL 读写与审计追加已拆到 `server/storage-service.js`，写入队列与变更序列化已拆到 `server/mutation-service.js`，项目数据查询与摘要聚合已拆到 `server/project-query-service.js`，测试目标解析、试运行、覆盖率和套件执行已拆到 `server/test-execution-service.js`，审核锁与冲突资源查询已拆到 `server/governance-service.js`，首页动态聚合已拆到 `server/activity-service.js`，项目创建模板已拆到 `server/project-factory.js`，项目视图组装已拆到 `server/project-presenters.js`，项目编译/发布编排已拆到 `server/project-build-service.js`，Drools/CEP 调用客户端已拆到 `server/engine-client.js`，项目路由分发、项目管理、后台用户目录、项目规则资产、项目规则包、项目规则集、项目事件流、旧版兼容 API、BOM、Change Set、Release 与测试套件路由已拆到 `server/routes/`。后续新增 API 时优先放入 `server/routes/`，避免继续扩大入口文件。

用户操作手册位于 `docs/user-guides/DWX决策工作台-用户操作手册.docx`。

## 运行

需要 Node.js 20+ 和 Docker。根目录 `npm install` 安装后端依赖，`cd frontend && npm install` 安装维护中的前端依赖（根 `npm run dev`/`build`/`lint` 都通过 `--prefix frontend` 调用，不会自动安装 `frontend/` 的依赖）。`data/` 是本地运行时目录，不提交到代码库；首次克隆后可用 `fixtures/demo-data/` 初始化演示数据。启动规则引擎和 CEP 容器后：

```bash
npm install
cd frontend && npm install && cd ..
npm run seed  # 首次克隆后初始化 data/*.json；已有文件不会覆盖
docker compose up --build -d engine res cep-build cep-res
API_PORT=8789 npm run api   # Team Server，与 frontend/ 代理端口保持一致
npm run dev                 # frontend/ 前端开发服务器，默认 http://127.0.0.1:5173
```

容量专项基准可用以下命令运行，默认依次覆盖 1,000、5,000、10,000 条规则资产，并记录 Team Server、浏览器、DRL、Drools Build Service 和 RES 指标：

```bash
npm run benchmark:capacity       # 完整基准
npm run benchmark:capacity:quick # 仅 1,000 档快速烟测
```

结果写入 `benchmarks/capacity/results/latest.md` 和 `latest.json`。基准使用隔离临时数据，不改写 `data/`；详细选项和判定边界见 [容量基准说明](benchmarks/capacity/README.md)。

也可以使用一键启动脚本完成演示数据初始化、Docker 服务启动以及 API 和前端启动：

```bash
npm run start
```

脚本默认使用 `API_PORT=8789`；可通过环境变量覆盖，例如 `API_PORT=8799 npm run start`。脚本退出时会停止本次启动的 API 和前端进程，Docker 服务保持运行，可用 `docker compose stop engine res cep-build cep-res` 停止。

如需重置本地演示数据，可执行 `npm run seed:force`，它会用 `fixtures/demo-data/` 覆盖 `data/*.json`。

浏览器打开 `http://127.0.0.1:5173`。未设置 `DATABASE_URL` 时继续使用 `data/*.json`。设计时 Build Service 健康检查地址是 `http://127.0.0.1:8788/health`。独立 RES 将执行面监听在 `8790`，管理面监听在 `8793`；两边的 `/health` 均可用于匿名探针，其余接口分别使用 `RES_EXECUTION_API_KEY` 和 `RES_MANAGEMENT_API_KEY` 的 Bearer 凭据。Team Server 对应配置为 `RULES_RES_URL`、`RULES_RES_MANAGEMENT_URL`、`RULES_RES_EXECUTION_API_KEY` 和 `RULES_RES_MANAGEMENT_API_KEY`，旧 `RES_URL` 仍兼容单端口部署。密钥为空仅用于本地迁移兼容，生产环境必须配置两套不同密钥。RES 的 Drools 会话池大小在 `res/config/res.properties` 配置，默认每个 Release 步骤 `2` 个会话。

发布环境联调可额外启动两个相互隔离的 RES：`docker compose up --build -d res-test res-production`。测试环境执行面/管理面分别是 `http://127.0.0.1:8800`、`http://127.0.0.1:8803`，生产模拟环境分别是 `http://127.0.0.1:8810`、`http://127.0.0.1:8813`。两个实例使用独立数据卷；在发布中心分别为 `test` 和 `production` 创建 Target 时应填写管理面地址，业务执行验证使用对应的执行面地址。

CEP 容器健康检查地址是 `http://127.0.0.1:8791/health`（Build/Test）和 `http://127.0.0.1:8792/health`（Runtime）。CEP Runtime 支持 `/events/{releaseId}`、`/execute`、`/webhook`、`/openapi.json` 和 `/metrics`。`timer:*` 使用 Esper 处理时间，不按事件中的 `eventTime` 回放；部署后的 timer 输出可以通过 webhook 异步接收。

PostgreSQL 模式：

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://rules:rules-local@127.0.0.1:54329/rules
npm run db:migrate
npm run db:import-json  # 仅首次迁移；目标库非空时会拒绝
npm run api
```

`GET /api/system/storage` 可确认当前存储模式。`npm test` 运行默认模型与 API 测试；数据库可用时用 `POSTGRES_TEST_URL=$DATABASE_URL node --test test/postgres-storage.test.js` 运行隔离的 PostgreSQL 集成测试。`npm run build` 构建前端。

默认 `AUTH_MODE=local`，仅用于本机开发。管理 API 可切换到 `AUTH_MODE=oidc`，此时必须配置 `OIDC_ISSUER` 和 `OIDC_AUDIENCE`，服务会通过 OIDC discovery 获取 JWKS 并验证 Bearer JWT；也可用 `OIDC_JWKS_URI` 显式覆盖。内置角色为 `viewer`、`author`、`reviewer`、`release-manager`、`admin`，支持顶层 `roles`、Keycloak realm roles 和指定 `OIDC_CLIENT_ID` 的 client roles。浏览器使用 Authorization Code + PKCE 建立 HttpOnly BFF 会话，`GET /api/session` 返回当前已验证主体和权限。

后端默认端口是 `8787`（可用 `API_PORT` 覆盖），而 `frontend/vite.config.ts` 的 `/api` 代理固定指向 `http://127.0.0.1:8789`。本地联调需让两者一致：`API_PORT=8789 npm run api`。`API_TARGET` 只被旧原型入口 `npm run dev:legacy`（`archive/legacy-prototype/`，未设置时代理 `8787`）读取，对 `frontend/` 无效。前端默认端口 `5173`，如需改端口请用 `cd frontend && npm run dev -- --port 5175`。旧原型默认端口调整为 `5174`，避免和主前端冲突。

容器基础镜像默认从 `docker.1ms.run` 拉取，构建阶段通过 `engine/settings.xml` 使用阿里云 Maven 公共仓库，不修改 Docker daemon 或全局 Maven 配置。镜像站不可用时可用 Docker 构建参数 `BUILD_IMAGE` 和 `RUNTIME_IMAGE` 指定其他可访问的镜像地址。`registry.cn-hangzhou.aliyuncs.com` 是阿里云容器仓库，不能直接将 Docker Hub 的 `library/...` 路径替换到该域名下。

## 边界

- 当前为单工作空间、多项目原型。管理 API 已支持 OIDC JWT 验签、浏览器 BFF 会话、角色门禁和策略式项目/资产授权。PostgreSQL 已覆盖项目、包、资产、草稿修订、发布版本、BOM、测试报告、Release、部署回执、Change Set 和审计事件；尚未实现工作空间级多租户隔离和备份恢复。
- 规则、决策表、规则集和测试套件使用 `revision`，BOM 使用 `version` 做乐观锁。冲突返回 `409`、当前修订号和服务器快照；前端保留本地编辑，由用户决定是否载入服务器版本。草稿所有权、字段级合并和实时协同尚未实现。
- 项目“审核”页支持把最多 50 个资产的当前修订固定到 Change Set，对比最近发布版本与草稿的结构化字段差异，并执行草稿、待评审、已批准、已驳回状态流。单资产可从 BAL/决策表编辑器直接提交审核；审核中资产及其包结构被锁定，批准前重新编译固定修订，批准后才生成发布版本。OIDC 模式禁止提交人审批自己的变更；`local` 模式保留管理员自审能力用于本机开发。
- 字段字典（BOM）存放在 `data/bom.json`，通过左侧"字段模型"页或 `GET/PUT /api/bom` 管理；当前默认包含客户年龄、年收入、信用评分、客户类型、是否逾期 5 个输入，风险等级、人工审核、批准额度 3 个输出。DRL 的 `declare RuleInput` 块由 BOM 动态生成并随 Release 冻结；Build Service 和 RES 都从编译后 FactType 反射字段类型，不保存 BOM 副本。
- Rule Project 属性中的 `variables` 是规则集变量（Ruleset Variable）的正式定义入口，支持 `Integer`、`Double`、`Boolean`、`String` 和 String 枚举；规则集内的规则 A 可以赋值，规则 B 可以读取。BAL 和决策表编辑器的条件、动作都能选择项目变量；规则级 `variables` 仅作为单条规则独立发布的兼容声明。规则条件使用 `fieldSource: "variable"` 读取，规则动作使用同样的来源写入；变量生成独立的 `declare RuleContext`，RES 在一次 `/execute` 请求内按默认值初始化并在步骤、settle 多轮之间传递，响应通过 `variables` 和 trace 快照回显。
- Ruleset Variable 不是运行期任务参数：不能通过 `facts` 注入，不跨请求持久化，也不替代 BOM。规则集是最小发布与执行单元；项目变量优先用于规则、决策表和规则集发布，旧规则/规则集变量仅作兼容 fallback。完整需求见 [规则集内部变量需求](docs/requirements-rule-parameters.md)。
- 每个项目都可独立创建、编辑、运行和归档测试套件；JSON 模式统一存放在 `data/test-suites.json` 并按 `projectId` 隔离，PostgreSQL 模式按 `project_id` 隔离。套件只运行本项目的已发布资产，支持 BOM 驱动的参数数据集、输出/命中规则/规则集路径断言、已发布版本并行对比，以及规则/决策表行/规则集路径覆盖率。标记为发布必需的套件会在本项目每次创建 Release 时实时重跑，失败时拒绝发布。
- 条件和动作支持 BOM 业务字段和 Ruleset Variable；BOM 字段动作仍只写输出字段常量，Ruleset Variable 动作写入本次执行的 `RuleContext`。项目设置负责维护统一变量定义，BAL/决策表编辑器只负责选择变量。DRL 输出采用声明型 `RuleInput` 事实；接入业务数据时需要做字段映射。
- 决策表是中文结构化表格编辑器：每个启用行转换为一条生成的 DRL 规则，并参与全局发布编译和导出。编辑器支持 XLSX/CSV 导入导出、列匹配校验和应用前行级差异预览。
- 规则集支持公共线性步骤、单个排他条件网关、默认分支和节点输入输出映射；每次发布都会冻结引用资产版本、DRL、路由和映射，试运行返回逐节点轨迹。它不是 BPMN/jBPM 流程，不包含多级/并行网关、人工任务、审批或定时器。
- `engine/` 是允许编译临时 DRL 的设计时服务；`res/` 是独立执行项目，只接受 Team Server 生成且校验和有效的 Release。两者均仅供本机原型调用，尚未实现鉴权、签名、隔离与执行配额，不应暴露到公网。
- 早期单文件原型已移动到 `archive/legacy-prototype/`，不再作为默认入口，仅保留 `npm run dev:legacy` 可访问；维护中的前端位于 `frontend/`，根 `dev`/`build`/`lint` 均指向它。
- `fixtures/demo-data/` 是可提交的演示种子数据，`data/` 是本地运行时 JSON 存储目录并被忽略；测试中的默认演示数据兼容性校验读取 `fixtures/demo-data/`，避免干净克隆后依赖本机状态。
- 决策表最多 10,000 行；启用行超过 500 行时仍执行逐行校验，但同步跳过二次方重叠、不可达和缺口分析并返回警告。大容量编译可通过 `ENGINE_MAX_BODY_BYTES`、`ENGINE_MAX_DRL_CHARS`、`RES_MAX_BODY_BYTES`、`RES_MAX_DRL_CHARS` 和 `RES_MAX_TOTAL_DRL_CHARS` 调整请求/DRL 上限，默认分别为 16 MiB、12 MiB、16 MiB、12 MiB 和 48 MiB，服务会将配置夹在安全范围内。

## 项目报告

`GET /api/projects/{projectId}/report` 按项目权限生成自包含 HTML 项目知识资产报告，包含项目概览、BOM 资产总览、规则资产清单、规则集执行拓扑、测试矩阵和发布部署历史六个章节。规则集优先读取已发布快照，未发布时读取草稿；没有资产、测试或发布记录时展示对应空态。项目报告页支持下载 HTML，也可使用浏览器打印保存为 PDF。

## 未来规划

**大模型智能体驱动的规则运营闭环**：在双引擎持续产出决策结果的基础上，由大模型智能体大脑接管规则运营的分析环节——依据规则命中情况（命中率、未命中分布、异常告警、CEP 事件流输出）自动分析规则质量与执行效果，识别冗余、冲突、失效或过时的规则，并结合业务语义给出调整建议；建议经人工确认后回流到规则引擎，形成"决策 → 分析 → 建议 → 优化"的闭环。远期还将支持自然语言交互式规则洞察、异常事件归因与规则变更影响预估。

## 开源许可

本项目采用 [GNU General Public License v3.0](LICENSE)（GPL-3.0）开源。你可以自由使用、修改和分发，但任何基于本项目的衍生作品必须以相同许可证开源。
