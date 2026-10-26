# DWX 部署领域设计

版本：1.2  
更新日期：2026-10-09  
状态：已评审冻结

## 1. 目标与边界

DWX 将制品、部署控制面和生产执行面明确分离：

- Release 是不可变制品，内容与 checksum 在创建后不再改变；
- Deployment 是独立部署账本，记录 Release 在某环境中的当前状态；
- DeploymentEvent 是追加式状态事件，保留部署、激活、停用与失败历史；
- Environment 是项目内的环境配置，`local` 为内置开发环境；
- RES 是生产执行面，负责加载、激活和执行 Release；
- DWX 管理服务负责规则治理、审批、部署编排和验证，不进入生产请求链路。

生产应用固定直接调用：

```text
POST /services/{decisionService}/execute
```

DWX 管理服务保留的执行接口仅用于管理验证和历史兼容，不作为生产高可用入口。

## 2. 已确认的产品决策

1. 一个 `decisionService` 固定属于一个应用包和一个 `rulesetPath`，不同环境只选择不同版本。
2. 首版应用包只包含一种执行引擎；规则引擎与 CEP 引擎不能放在同一应用包中。
3. 部署属性首版不承载业务阈值，只允许超时、容量、端点等运维属性，并整体后置实现。
4. Target 表示一个 RES 或 CEP RES 进程实例。
5. 灰度首版只支持百分比和 sticky key，租户路由后置。
6. 历史数据采用一次性、显式、幂等迁移，不长期双写，也不在 GET 请求中懒迁移。
7. 排他网关已支持 Rule Project 变量，不再作为部署领域的前置依赖。

## 3. 现状问题

历史实现将运行状态写入 `release.deployments[]`，导致：

- Release 记录会在部署后被修改，破坏不可变制品边界；
- 部署、激活、回退和卸载都读改写整份 Release 集合；
- PostgreSQL 的 `deployments` 表只是 Release 子记录，JSON 存储甚至没有独立部署文件；
- 同一 `decisionService + environment` 的唯一 active 只靠应用逻辑，历史异常可能产生双 active；
- 回退通过扫描 Release 推断，缺少独立部署历史；
- 环境被硬编码为 `local`，无法自然扩展。

## 4. 领域模型

### 4.1 Release

Release 是单个可执行规则集或事件流的不可变制品：

```text
Release
  id / projectId / decisionService / version
  target / engine / model
  steps / schemas / statements
  routing / variables
  checksum / createdAt / createdBy
```

部署操作不得改写 Release。旧 API 响应中的 `deployments[]` 是从独立账本生成的兼容投影，不是 Release 持久化内容。

### 4.2 Environment

```text
Environment
  id / projectId / name
  kind: dev | test | staging | prod
  isDefault
```

`local` 是每个项目的内置开发环境。后续可增加测试、预发和生产环境。

### 4.3 Deployment

Deployment 保存当前状态投影：

```text
Deployment
  id / projectId / releaseId / decisionService / environmentId
  engine / checksum
  status: pending | parsing | ready | active | draining | stopped | failed
  modelVersion / engineVersion
  createdAt / updatedAt
  activatedAt / activatedBy / stoppedAt / stoppedBy
```

数据库必须保证同一 `(projectId, decisionService, environmentId)` 最多只有一个 `active` Deployment。

### 4.4 DeploymentEvent

```text
DeploymentEvent
  id / deploymentId
  type: created | ready | activated | deactivated | stopped | failed
  actor / details / occurredAt
```

Deployment 是查询投影，DeploymentEvent 是追加式可审计历史。状态切换不能覆盖或删除已有事件。

### 4.5 ApplicationPackage 与 manifest

应用包固定一个业务服务边界：

```text
ApplicationPackage
  id / projectId / name
  decisionService / rulesetPath / targetType / engine
  createdAt / updatedAt / createdBy

ApplicationPackageManifest
  id / applicationPackageId / version
  decisionService / rulesetPath / targetType / engine
  releaseId / releaseVersion / releaseDisplayVersion / releaseChecksum
  checksum / createdAt / createdBy
```

同一项目中一个 `decisionService` 只能属于一个应用包。首个 manifest 固定应用包的 `rulesetPath`、目标类型和执行引擎，后续 manifest 只能追加同边界的新 Release；manifest 内容参与独立 SHA-256 校验，创建后不可修改。首版应用包仍只引用单个 Release，但部署和回退已经从 Release 操作提升为应用包操作，为后续多组件 manifest 保留原子边界。

### 4.6 Target 与 ActivationGeneration

```text
Target
  id / projectId / name / environmentId
  engine / endpoint / enabled
  status: unknown | ready | unreachable | mismatch
  nodeId / engineVersion / lastSeenAt / lastError

ActivationGeneration
  id / projectId / applicationPackageId / manifestId / releaseId
  decisionService / environmentId
  generation / expectedGeneration
  status: preparing | activating | active | draining | failed
  targets[] / createdAt / updatedAt / activatedAt / failedAt / error
```

Target 是一个可独立探测的运行节点。ActivationGeneration 保存一次多节点发布尝试及逐节点 READY、active 或 failed 回执；失败尝试保留审计记录，但不占用 active generation。DeploymentProperty 与 TrafficPolicy 继续后置。

## 5. 状态与操作语义

### 5.1 部署

1. DWX 将不可变 Release 发送到对应 RES；
2. RES 校验 checksum、编译并返回部署回执；
3. DWX 创建或更新 Deployment 投影并追加 `created`、`ready` 事件；
4. 若该服务在目标环境还没有 active，则首个成功部署自动激活；否则保持 `ready`；
5. Release 本身不发生任何持久化修改。

### 5.2 激活

1. 目标 Deployment 必须是 live 状态；
2. RES 成功切换路由后，旧 active 转为 `ready` 并追加 `deactivated`；
3. 目标转为 `active` 并追加 `activated`；
4. 数据库唯一索引作为最终并发保护。

### 5.3 回退

回退只选择同一服务、同一环境中版本更低且仍为 `ready` 的 Deployment。成功后切换 active，不重建 Release，也不重新生成 checksum。

### 5.4 卸载

active Deployment 不能直接卸载。必须先激活其他版本或执行回退，再由 RES 卸载并将 Deployment 标记为 `stopped`。

## 6. API

### 6.1 P0 新增接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/deployments` | 查询独立部署账本及事件 |
| GET | `/api/projects/:id/environments` | 查询项目环境 |

### 6.2 兼容接口

以下接口继续保留，但内部改写独立 Deployment 账本：

- `POST /api/projects/:id/releases/:releaseId/deploy`
- `POST /api/projects/:id/releases/:releaseId/activate`
- `POST /api/projects/:id/releases/:releaseId/rollback`
- `POST /api/projects/:id/releases/:releaseId/undeploy`

`GET /api/projects/:id/releases` 继续返回 `deployments[]`，该字段由账本即时投影，保证现有前端与调用方兼容。

### 6.3 P1 应用包接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/application-packages` | 查询应用包、manifest 和当前部署投影 |
| POST | `/api/projects/:id/application-packages` | 从 Release 创建应用包及首个 manifest |
| POST | `/api/projects/:id/application-packages/:packageId/manifests` | 追加引用新 Release 的不可变 manifest |
| POST | `/api/projects/:id/application-packages/:packageId/deploy` | 部署指定或最新 manifest，并在 READY 后切换 active |
| POST | `/api/projects/:id/application-packages/:packageId/rollback` | 回退到上一已部署 manifest |

应用包部署先完成 RES 部署，再执行 active 切换。激活失败时新版本保持 `ready`，旧 active 不变；回退同样只在运行时激活成功后更新 Deployment 投影。

### 6.4 P2 Target 与 generation 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/projects/:id/targets` | 查询或创建 Target；未显式配置时包含当前本地 Runtime |
| PATCH/DELETE | `/api/projects/:id/targets/:targetId` | 启停、更新或删除 Target |
| POST | `/api/projects/:id/targets/reconcile` | 拉取节点状态并对比 active generation |
| GET | `/api/projects/:id/activation-generations` | 查询 generation 与逐节点回执 |
| POST | RES `/prepare` | 校验、编译并预热 Release，不切换路由 |
| POST | RES `/activate` | 使用 `expectedGeneration` 执行 CAS 激活 |
| GET | RES/CEP RES `/status` | 返回节点身份、引擎、部署、路由、在途请求和 draining 状态 |

Drools 应用包 deploy/rollback 使用完整 generation 协议。CEP Runtime 当前按显式 Release ID 接收事件，不提供稳定服务路由，因此本期只纳入 Target 清单与状态对账，继续沿用 P1 部署语义。

## 7. 存储与迁移

### 7.1 JSON 模式

新增 `deployments.json` 和 `environments.json`。服务启动时执行显式迁移函数：

1. 读取历史 `releases.json`；
2. 将内嵌 `deployments[]` 转换为独立 Deployment 和 DeploymentEvent；
3. 同一服务同一环境若存在多个 active，只保留最新 Release 的部署为 active，其余转为 ready；
4. 从 Release 记录删除内嵌部署字段；
5. 以 Deployment ID 去重，重复执行不产生重复数据。

读取接口不得触发迁移或写文件。

### 7.2 PostgreSQL 模式

`013_deployment_domain.sql`：

- 新建 `environments`；
- 将已有 `deployments` 表升级为独立领域表；
- 回填项目、服务、状态和引擎元数据；
- 新建 `deployment_events`；
- 清理历史双 active；
- 建立条件唯一索引，约束同服务同环境只有一个 active。

`014_application_packages.sql` 新建应用包与追加式 manifest 表，通过项目内 `decisionService` 唯一约束固定服务归属，并通过 Release 外键和 manifest checksum 固定制品引用。JSON 模式使用独立 `application-packages.json`，JSON 导入 PostgreSQL 时在 Release 之后导入 manifest。

`015_targets_and_generations.sql` 新建 `deployment_targets` 和 `activation_generations`，通过环境复合外键约束 Target 归属，并以条件唯一索引保证同一服务、环境最多一个 active generation。JSON 模式使用 `targets.json` 和 `activation-generations.json`，导入时在应用包和 Deployment 之后写入。

旧 JSON 导入 PostgreSQL 时先保存 Release，再将历史内嵌部署转换并写入独立账本。

## 8. 多节点激活设计

多节点能力在 P2 实现，语义固定如下：

1. 所有目标节点解析、编译、预热完成并进入 READY；
2. 控制面以 `expectedGeneration` 执行 CAS；
3. CAS 成功后提交新 generation，全部节点按同一代次路由；
4. 任一节点未 READY 或 CAS 失败时，不提交新 generation，旧 generation 继续服务；
5. 旧版本进入 draining，待在途请求归零后停止。

这不是跨节点数据库事务，而是“全部就绪 + 单点代次提交 + 失败保持旧代次”的原子切流协议。

## 9. 分阶段计划

### P0：Deployment 账本与 Environment

- [x] 独立 Deployment、DeploymentEvent、Environment 存储；
- [x] JSON 与 PostgreSQL 显式幂等迁移；
- [x] 旧 Release API 兼容投影；
- [x] 同服务同环境唯一 active；
- [x] Release 部署前后内容与 checksum 不变；
- [x] 发布中心部署状态与事件时间线。

### P1：DWX 应用包 manifest

- [x] 一个应用包固定一个 `decisionService + rulesetPath`；
- [x] 首版单执行引擎；
- [x] manifest 固化版本、Release 引用、Release checksum 和自身 checksum；
- [x] 原子部署与回退以应用包为单位；激活失败保持旧版本服务；
- [x] 发布中心支持创建应用包、追加 manifest、部署最新版本和回退。

### P2：generation、预热与 drain

- [x] Target 管理；
- [x] 全部 READY 门禁；
- [x] generation CAS；
- [x] 在途请求 drain；
- [x] 节点清单对账。

### P3：签名与密钥轮换

状态：暂缓，不进入当前排期。

- 对规范化应用包 manifest 签名；
- RES 验签；
- 新旧密钥并行验证窗口；
- 签名不改变历史 Release checksum。

### P4：百分比灰度

状态：暂缓，不进入当前排期。

- 两个 READY 版本并存；
- 百分比分流；
- sticky key 保持请求稳定落点；
- 租户维度路由后置。

## 10. 非目标

- P0 不实现应用包、Target、generation、多节点、签名和灰度；
- 不允许用部署属性覆盖业务规则阈值或绕过审批；
- 不把 Release 改造成多资产可变对象；
- 不让 DWX 管理服务承担生产执行代理或高可用职责；
- 不改变规则 Release 与 CEP Release 已有 checksum 语义。

## 11. P0 验收标准

1. 部署、激活、回退和卸载不修改 Release 持久化记录；
2. Release checksum 在部署前后完全一致；
3. 同一服务同一环境最多一个 active；
4. 每次状态变化都有 DeploymentEvent；
5. 历史 JSON 迁移重复执行结果不变；
6. PostgreSQL 迁移能清理历史双 active 并建立数据库约束；
7. 旧 Release API 仍返回兼容的 `deployments[]`；
8. 新 `/deployments` 与 `/environments` 接口可查询独立领域数据；
9. 生产执行入口保持为 RES 的 `/services/{decisionService}/execute`；
10. DWX 管理服务不被引入生产请求链路。

## 12. P1 验收标准

1. 同一项目中一个 `decisionService` 只能创建一个应用包；
2. 后续 manifest 只能引用同一 `rulesetPath`、目标类型和执行引擎的 Release；
3. manifest 固定 Release ID、版本与 checksum，重复追加同一 Release 保持幂等；
4. 应用包部署成功后只能有一个 active Deployment；
5. 激活失败时新 Deployment 保持 ready，旧 active 继续服务；
6. 应用包回退只选择自身历史中已部署的较低 manifest；
7. 应用包部署与回退不修改 Release 持久化内容；
8. JSON 与 PostgreSQL 均持久化应用包和 manifest，项目删除同步清理；
9. 旧 Release 部署、激活、回退和卸载接口继续兼容。

## 13. P2 验收标准

1. Target 可按项目和环境创建、启停、删除并持久化，未显式配置时保留当前本地 Runtime；
2. 应用包只在全部启用的匹配 Target 完成校验、编译和预热后进入激活阶段；
3. 任一 Target 未 READY 时 generation 标记失败，当前 active generation 与 Deployment 不变；
4. RES 激活必须校验 `expectedGeneration`，重复提交已生效代次保持幂等，过期 CAS 返回冲突；
5. 空节点只允许在没有 active route 时通过 bootstrap 直接加入控制面代次，已有路由仍执行严格 CAS；
6. 稳定服务请求在选定 Release 时固定 generation 并增加在途计数，切流不改变已进入执行的请求；
7. 旧 Release 在切流时有在途请求则进入 draining，在途归零后自动退出 draining；
8. RES 重启后从同一原子路由文件恢复 Release 与 generation，兼容旧字符串路由格式；
9. 节点对账能识别不可达和 active route/generation 偏移；
10. JSON、PostgreSQL 与 JSON 导入均保存 Target 和 ActivationGeneration，项目删除同步清理；
11. 发布中心可管理 Target、触发对账并查看 generation 与逐节点状态；
12. 旧 Release API 和 CEP 显式 Release 执行链路继续兼容。
