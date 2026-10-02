# DWX 决策工作台

DWX（Decision Workbench X）是一个面向规则、决策流和复杂事件处理的双引擎决策工作台原型。项目统一管理 BOM、规则、决策表、RuleFlow、CEP EventStream、测试套件、Change Set、Release、部署和审计，并按项目将规则请求路由到 Drools、将 CEP 事件流请求路由到 Esper。

规则侧使用 Drools 10.2.0，CEP 侧使用 Esper 8.8.0。当前项目用于本地研发、产品验证和客户 Demo，不是面向公网的商用部署方案。

规则、决策表和规则流支持草稿、修订历史、结构化差异、变更集评审、审计日志、版本发布、历史恢复、归档、试运行、参数化测试套件、版本行为对比、覆盖率、回归发布门禁、项目知识资产报告和已发布规则 DRL 导出。CEP 侧支持 BOM Event Profile、EventStream、窗口聚合、pattern/timer 时间驱动语句、真实 Esper 编译与执行、webhook 告警、OpenAPI 和 Prometheus metrics。Team Server 支持 JSON 文件和 PostgreSQL 两种存储模式。

决策表支持内联比较符、闭区间及半开区间、空条件通配确认和分级诊断。规则流冻结依赖资产版本，依赖升版后会标记需要重新发布，并对多个步骤写同一输出字段给出覆盖警告。测试报告保留规范化输入与未提供字段；BOM input 可配置执行时必填，缺失时 Team Server 和 RES 返回 `400`，不会隐式补 `0/false`。

“浏览”页提供跨项目资产目录，可按名称、规则包、项目和 BOM 业务术语搜索，并组合项目、资产类型、状态筛选；结果可直接定位到规则、决策表、规则流或 BOM 字段。

产品按规则设计中心、规则治理中心和独立规则执行中心（RES）三个边界演进。详细规划见 [产品需求说明](docs/product-requirements.md)、[技术设计](docs/technical-design.md) 和 [交付任务拆分](docs/delivery-plan.md)。

## 项目结构

```text
frontend/                 # 维护中的 React + Vite 前端应用
server/                   # Team Server API、认证、路由拆分、存储适配与数据库迁移
shared/                   # 前后端共享的规则、BOM、发布、测试和报表领域逻辑
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

`server/index.js` 仍是 Team Server 的组合入口；通用 HTTP 工具已拆到 `server/http-utils.js`，资产修订/包名规范化工具已拆到 `server/domain-utils.js`，JSON/PostgreSQL 读写与审计追加已拆到 `server/storage-service.js`，写入队列与变更序列化已拆到 `server/mutation-service.js`，项目创建模板已拆到 `server/project-factory.js`，项目视图组装已拆到 `server/project-presenters.js`，项目编译/发布编排已拆到 `server/project-build-service.js`，Drools/CEP 调用客户端已拆到 `server/engine-client.js`，项目管理、后台用户目录、项目规则资产、项目规则包、项目规则流、项目事件流、BOM、Change Set、Release 与测试套件路由已拆到 `server/routes/`。后续新增 API 时优先放入 `server/routes/`，避免继续扩大入口文件。

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

如需重置本地演示数据，可执行 `npm run seed:force`，它会用 `fixtures/demo-data/` 覆盖 `data/*.json`。

浏览器打开 `http://127.0.0.1:5173`。未设置 `DATABASE_URL` 时继续使用 `data/*.json`。设计时 Build Service 健康检查地址是 `http://127.0.0.1:8788/health`，独立 RES 健康检查地址是 `http://127.0.0.1:8790/health`；RES 的 Drools 会话池大小在 `res/config/res.properties` 配置，默认每个 Release 步骤 `2` 个会话。

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
- 规则、决策表、规则流和测试套件使用 `revision`，BOM 使用 `version` 做乐观锁。冲突返回 `409`、当前修订号和服务器快照；前端保留本地编辑，由用户决定是否载入服务器版本。草稿所有权、字段级合并和实时协同尚未实现。
- 项目“审核”页支持把最多 50 个资产的当前修订固定到 Change Set，对比最近发布版本与草稿的结构化字段差异，并执行草稿、待评审、已批准、已驳回状态流。单资产可从 BAL/决策表编辑器直接提交审核；审核中资产及其包结构被锁定，批准前重新编译固定修订，批准后才生成发布版本。OIDC 模式禁止提交人审批自己的变更；`local` 模式保留管理员自审能力用于本机开发。
- 字段字典（BOM）存放在 `data/bom.json`，通过左侧"字段模型"页或 `GET/PUT /api/bom` 管理；当前默认包含客户年龄、年收入、信用评分、客户类型、是否逾期 5 个输入，风险等级、人工审核、批准额度 3 个输出。DRL 的 `declare RuleInput` 块由 BOM 动态生成并随 Release 冻结；Build Service 和 RES 都从编译后 FactType 反射字段类型，不保存 BOM 副本。
- 每个项目都可独立创建、编辑、运行和归档测试套件；JSON 模式统一存放在 `data/test-suites.json` 并按 `projectId` 隔离，PostgreSQL 模式按 `project_id` 隔离。套件只运行本项目的已发布资产，支持 BOM 驱动的参数数据集、输出/命中规则/规则流路径断言、已发布版本并行对比，以及规则/决策表行/规则流路径覆盖率。标记为发布必需的套件会在本项目每次创建 Release 时实时重跑，失败时拒绝发布。
- 条件只支持 AND 和基础比较，动作只支持给输出字段赋常量。DRL 输出采用声明型 `RuleInput` 事实；接入业务数据时需要做字段映射。
- 决策表是中文结构化表格编辑器：每个启用行转换为一条生成的 DRL 规则，并参与全局发布编译和导出。编辑器支持 XLSX/CSV 导入导出、列匹配校验和应用前行级差异预览。
- 规则流支持公共线性步骤、单个排他条件网关、默认分支和节点输入输出映射；每次发布都会冻结引用资产版本、DRL、路由和映射，试运行返回逐节点轨迹。它不是 BPMN/jBPM 流程，不包含多级/并行网关、人工任务、审批或定时器。
- `engine/` 是允许编译临时 DRL 的设计时服务；`res/` 是独立执行项目，只接受 Team Server 生成且校验和有效的 Release。两者均仅供本机原型调用，尚未实现鉴权、签名、隔离与执行配额，不应暴露到公网。
- 早期单文件原型已移动到 `archive/legacy-prototype/`，不再作为默认入口，仅保留 `npm run dev:legacy` 可访问；维护中的前端位于 `frontend/`，根 `dev`/`build`/`lint` 均指向它。
- `fixtures/demo-data/` 是可提交的演示种子数据，`data/` 是本地运行时 JSON 存储目录并被忽略；测试中的默认演示数据兼容性校验读取 `fixtures/demo-data/`，避免干净克隆后依赖本机状态。

## 项目报告

`GET /api/projects/{projectId}/report` 按项目权限生成自包含 HTML 项目知识资产报告，包含项目概览、BOM 资产总览、规则资产清单、规则流拓扑、测试矩阵和发布部署历史六个章节。规则流优先读取已发布快照，未发布时读取草稿；没有资产、测试或发布记录时展示对应空态。项目报告页支持下载 HTML，也可使用浏览器打印保存为 PDF。
