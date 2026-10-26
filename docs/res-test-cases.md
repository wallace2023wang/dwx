# RES 自动化测试用例规格

版本：0.1
更新日期：2026-09-29
对应服务：`res/`（Rule Execution Server，Java / Dropwizard 风格 HttpServer）
执行方式：JUnit 5 + 内嵌 RES，通过 HTTP 客户端调用 `/deploy`、`/execute`、`/health`、`/deployments`。

> 本文件是 RES 端必须自动化覆盖的用例清单。Node 侧的 `test/res-contract.test.js` 只验证 Team Server ↔ RES 的 HTTP 契约；RES 自身行为（编译、反射、持久化、错误隔离）由本文件约束。

---

## 1. 部署 `/deploy`

### RES-DEP-01：合法 Release 部署成功
- **前置**：构造一个 schemaVersion=1、Drools=10.2.0、包含冻结 `model`、单步骤、checksum 正确的 Release JSON；legacy 用例可省略 `model`。
- **请求**：`POST /deploy`
- **预期**：201；返回 `deploymentId=local:<id>`、`deployedAt`、`checksum`、`steps=1`；`GET /deployments` 包含该 Release 摘要。

### RES-DEP-02：幂等部署——同 ID 同 checksum 重复提交返回 200
- **前置**：RES 已部署 Release A。
- **请求**：再次 `POST /deploy` 完全相同的 A。
- **预期**：200（不是 201）；不重复编译；`/deployments` 仍只有一条。

### RES-DEP-03：同 ID 不同 checksum 返回 409
- **前置**：RES 已部署 Release A。
- **请求**：`POST /deploy` 相同 `id` 但修改 steps[0].drl（checksum 不匹配）。
- **预期**：409；错误信息包含"不同内容"；原有部署不受影响。

### RES-DEP-04：checksum 不匹配返回 400
- **前置**：构造 Release 但手动改错 checksum 字段。
- **预期**：400；错误信息包含"校验和不匹配"。

### RES-DEP-05：Drools 版本不兼容返回 400
- **前置**：Release 中 `engine.drools` 改成 `"9.x"`。
- **预期**：400；错误信息包含"Drools 版本不兼容"。

### RES-DEP-06：DRL 编译失败返回 422
- **前置**：Release 步骤中塞入语法错误的 DRL（如 `rule bogus` 缺 then/end）。
- **预期**：422；`errors` 数组包含 Drools 编译错误文本；Release 不进入注册表。

### RES-DEP-07：Release 过大拒绝
- **前置**：按当前环境变量构造总 DRL 超过 `RES_MAX_TOTAL_DRL_CHARS` 或单步超过 `RES_MAX_DRL_CHARS` 的 Release（默认分别为 48 MiB 和 12 MiB）。
- **预期**：400；错误信息包含"超限"。

### RES-DEP-08：必需字段缺失拒绝
- **前置**：Release 缺 `id` / `decisionService` / `steps`。
- **预期**：400；错误信息明确指出缺失字段。

### RES-DEP-09：卸载 Release 幂等并释放持久化制品
- **前置**：Release A 已部署并写入 `<releaseId>.json`。
- **请求**：`POST /undeploy` `{releaseId}`，然后重复调用一次。
- **预期**：两次均返回 200；第一次 `removed=true`，第二次 `removed=false`；`/deployments` 不再包含 A，持久化文件已删除，后续执行 A 返回 404。

### RES-DEP-10：规则组步骤部署和执行
- **前置**：Release 含 `type=rule-group` 的步骤，`drl` 为成员合并后的完整规则集，并携带 `members/memberFingerprint`。
- **预期**：部署成功且规则可命中；非法 input/output mapping 仍返回 400；执行期不依赖 `members` 解析。

### RES-DEP-11：OpenAPI 公布完整步骤类型
- **请求**：`GET /openapi.json`。
- **预期**：`ReleaseStep.type.enum` 包含 `rule`、`table`、`rule-group`，并说明规则组 `drl` 与成员追溯字段的语义。

---

## 2. 执行 `/execute`

### RES-EXE-01：按 releaseId 执行已部署 Release
- **前置**：部署一个规则：`creditScore < 600 → riskLevel = "高"`。
- **请求**：`POST /execute` `{releaseId, facts:{creditScore:500}}`
- **预期**：200；返回 `facts.riskLevel="高"`、`count=1`、`trace` 包含命中规则名。

### RES-EXE-02：未部署的 releaseId 返回 404
- **请求**：`POST /execute` `{releaseId:"non-exist", facts:{}}`
- **预期**：404；错误"Release 未部署"。

### RES-EXE-02A：按 decisionService 执行当前生效版本
- **前置**：同一 `decisionService` 已部署 v1、v2，v1 为当前生效版本。
- **请求**：`POST /services/{decisionService}/execute`，请求体仅包含 `facts`，不传 `releaseId`。
- **预期**：执行 v1；调用 `/activate` 切换至 v2 后，相同业务请求稳定执行 v2。

### RES-EXE-03：多步骤规则集按顺序执行，输出传递到下一步
- **前置**：Release 有 2 个步骤：步骤1 设置 `riskLevel="中"`；步骤2 的规则在 `riskLevel=="中"` 时设置 `reviewRequired=true`。
- **请求**：`POST /execute` 空 facts。
- **预期**：200；`trace.length==2`；最终 facts 同时包含 `riskLevel="中"` 和 `reviewRequired=true`。

### RES-EXE-04：null 输出不覆盖已有事实
- **前置**：步骤1 设置 `riskLevel="低"`；步骤2 的规则未命中，不设置任何输出。
- **预期**：最终 facts.riskLevel 仍为 `"低"`，不被 null 覆盖。

### RES-EXE-05：未知事实字段被拒绝
- **请求**：`POST /execute` facts 包含 BOM/DRL 中不存在的 key（如 `hackedField`）。
- **预期**：400；错误"未知事实字段"。

### RES-EXE-06：事实类型不匹配被拒绝
- **前置**：DRL 中 `creditScore : Integer`。
- **请求**：facts 传 `creditScore="abc"`（字符串）。
- **预期**：400；错误"事实字段类型无效"。

### RES-EXE-07：单步触发上限保护
- **前置**：规则无条件自触发（insert 新 fact 或 modify 触发自身）。
- **预期**：200；`limitReached=true`；`count<=100`（MAX_FIRES_PER_STEP）；不因无限循环挂死。

### RES-EXE-08：requestId 透传与自动生成
- **请求 A**：传 `requestId="req-123"`。
- **预期**：响应中 `requestId=="req-123"`。
- **请求 B**：不传 requestId。
- **预期**：响应中自动生成一个 UUID。

### RES-EXE-09：响应包含 Release 元数据
- **预期**：响应包含 `releaseId`、`decisionService`、`version`、`durationMs`。

### RES-EXE-10：必填字段缺失拒绝
- **前置**：冻结 model 将 `phase` 标记为 required input。
- **请求**：facts 不含 `phase` 或显式传 null。
- **预期**：400；错误包含缺失字段名。

### RES-EXE-11：可选 Boolean 区分未传与 false
- **前置**：新 DRL 声明 `flag : java.lang.Boolean`，规则分别判断 `flag == null` 与 `flag == false`。
- **预期**：未传时命中 null 规则；显式传 false 时命中 false 规则，二者不混淆。

### RES-EXE-12：受限多轮收敛
- **请求**：`settle=true`、合法 `output -> input` 的 `feedbackMappings` 和 `maxRounds`。
- **预期**：返回逐轮 `rounds[]`；无命中或反馈不变时停止；循环达到上限时 `limitReached=true`；异类型、反向或重复目标映射返回 400。

---

## 3. FactType 反射（BOM 解耦）

### RES-FACT-01：部署时从 DRL declare 反射字段，不依赖硬编码列表
- **前置**：构造一个 BOM 包含自定义字段 `occupation:String` 的 Release。
- **预期**：部署成功；`/execute` 传 `occupation="教师"` 不被拒绝（不在硬编码 FIELDS 列表里也能接收）。

### RES-FACT-02：String 字段长度 >200 拒绝
- **请求**：传一个 201 字符的字符串字段。
- **预期**：400。

### RES-FACT-03：Integer 类型字段传小数拒绝
- **请求**：`customerAge=25.5`。
- **预期**：400（因为 Integer 的 FactField type 是 int/Integer）。

---

## 4. 持久化与重启恢复

### RES-PERSIST-01：部署后写入 data/releases/<id>.json
- **预期**：部署后磁盘上出现 `<releaseId>.json`，内容包含 release 完整 JSON 和 deployedAt。

### RES-PERSIST-02：重启后自动恢复已部署 Release
- **前置**：部署 Release A → 关闭 RES → 重启。
- **预期**：启动日志打印 `loaded 1 release(s)`；`/deployments` 包含 A；`/execute` A 可正常执行。

### RES-PERSIST-03：损坏的 Release 文件被跳过而非崩溃
- **前置**：在 data/releases/ 放一个 JSON 损坏的文件。
- **预期**：RES 正常启动；stderr 打印忽略该文件；其他 Release 仍可用。

---

## 5. 健康检查与管理

### RES-HEALTH-01：`GET /health` 返回版本和部署数
- **预期**：200；包含 `service`、`version=10.2.0`、`deployments` 计数。

### RES-HEALTH-02：`GET /deployments` 不返回 DRL 内容
- **预期**：列表项只含摘要（id、name、checksum、steps、deployedAt），不含 drl 字段。

---

## 6. 安全与隔离

### RES-SEC-01：生产环境不接受任意 DRL 上传
- **说明**：`/deploy` 只接受完整 Release JSON（带 checksum），不接受裸 DRL。本用例验证：POST 一个不含 checksum 的对象返回 400。

### RES-SEC-02：请求体大小限制
- **请求**：POST 超过 2MB 的 body。
- **预期**：413/400。

### RES-SEC-03：单个 Release 执行不影响其他 Release
- **前置**：部署 A（规则正常）和 B（规则会抛异常）。
- **请求**：先执行 B（异常），再执行 A。
- **预期**：A 仍正常返回；B 的失败不污染 A 的 KieContainer。

---

## 用例覆盖统计

| 模块 | 用例数 |
|---|---|
| 部署 deploy | 11 |
| 执行 execute | 12 |
| FactType 反射 | 3 |
| 持久化 | 3 |
| 健康检查与管理契约 | 3 |
| 安全隔离 | 3 |
| **合计** | **35** |
