# 规则项目报告（Report）功能需求设计

> 产品：Decision Workbench（复刻 IBM ILOG JRules / ODM）
> 模块：规则项目知识资产报告 —— HTML / PDF 双格式导出
> 状态：已实现（`shared/report.js` 生成 HTML、`GET /api/projects/{projectId}/report` 提供项目级权限接口、前端项目报告页 `frontend/src/routes/project/Report.tsx` 与 `frontend/src/api/report.ts` 负责下载与打印，测试见 `test/report.test.js`）
> 关联文档：
>
> `rts-ui-design.md`
>
> （UI 规范）、
>
> `technical-design.md`
>
> （架构）、
>
> `project-package-crud-design.md`
>
> （资产模型）



***

## 1. 背景与目标

JRules/ODM 提供「规则项目报告」能力：把规则库的知识资产（BOM、规则、决策表、规则集、测试、发布）聚合为一份结构化报告，导出后供客户 / 业务方直观了解规则资产全貌，也作为治理沟通的载体。

**目标**：为 Decision Workbench 增加「规则项目报告」功能，支持 **HTML 与 PDF 双格式**导出：



| 目标   | 说明                                    |
| ---- | ------------------------------------- |
| 资产盘点 | 一页看清项目的 BOM 事实类型、规则 / 决策表数量、包结构、规则集拓扑 |
| 质量透明 | 测试套件通过率、覆盖率、发布质量门禁结果                  |
| 发布溯源 | 版本历史、部署环境、checksum、决策服务标识             |
| 交流载体 | 可下载 / 可分享 / 可打印，客户会议与治理评审直接使用         |

**不做什么（v1 范围外）**：



* 不做治理审计报告（变更历史 / 作者活跃度 / 审批流分析）—— 设计预留扩展点

* 不做规则明细的 DRL 导出（属资产导出，另议）

* 不做多项目合并报告



***

## 2. 用户场景



| 场景   | 角色         | 行为                                       |
| ---- | ---------- | ---------------------------------------- |
| 客户演示 | 售前 / 业务负责人 | 打开项目 → 生成报告 → 导出 PDF 发给客户 → 会议中讲解资产规模与质量 |
| 治理汇报 | 规则治理负责人    | 定期导出 HTML 存档，纳入治理评审材料                    |
| 项目交接 | 开发 / 运维    | 快速获取项目结构全貌（BOM 字段、包、发布版本），无需逐 tab 翻阅     |



***

## 3. 功能入口与交互

### 3.1 入口位置

**入口：项目页顶部操作区**（RTS 风格，与「规则集」「测试」等 Tab 同级，但作为操作按钮而非 Tab）。



* 不新增第 7 个 Tab —— 报告是「生成动作 + 查看结果」的复合操作，不是资产视图

* 在 `ProjectTabs` 右侧（或 `ProjectShell` 顶栏右上）放置 **「报告」按钮**（图标：文档 + 箭头）

* 点击后进入报告视图页：`/projects/:projectId/report`



```
项目页

┌──────────────────────────────────────────────┐

│  粮库温控告警                        \[报告]   │  ← 顶栏右侧操作区

├──────────────────────────────────────────────┤

│  资产 | 规则集 | BOM/词汇 | 测试套件 | 审核 | 发布 │

└──────────────────────────────────────────────┘
```

### 3.2 报告视图页交互



```
/projects/:projectId/report

┌──────────────────────────────────────────────┐

│  ← 返回项目     项目知识资产报告     \[下载HTML] \[下载PDF] │  ← 工具栏（打印时隐藏）

├──────────────────────────────────────────────┤

│  ① 项目概览                                    │

│  ② BOM 资产总览                                │

│  ③ 规则资产清单（按包分组）                       │

│  ④ 规则集拓扑                                  │

│  ⑤ 测试矩阵                                    │

│  ⑥ 发布与部署历史                              │

└──────────────────────────────────────────────┘
```



* **生成时机**：进入报告页即调用后端聚合接口（`GET /api/projects/:id/report`），展示最新数据快照

* **下载 HTML**：将后端返回的自包含 HTML 保存为 `<项目名>-资产报告-<日期>.html`（`<a download>` 触发）

* **下载 PDF**：浏览器打印（`window.print()`），`@media print` 样式保证分页与纸张友好；用户「另存为 PDF」

* 报告页头部显示：**生成时间、生成人、决策服务标识、数据版本**（BOM 版本 + 最新 Release 版本），确保可追溯



***

## 4. 报告内容定义（v1 六章节）

### ① 项目概览（KPI 卡 + 元信息）



| 字段                    | 来源                                            |
| --------------------- | --------------------------------------------- |
| 项目名称 / 描述 / 图标        | `GET /api/projects` 记录                        |
| 资产总数（规则 + 决策表）        | `projectSummary.assetCount`                   |
| 规则数 / 决策表数（分开）        | packages → assets 按 type 统计                   |
| 规则包数                  | `projectSummary.packageCount`                 |
| BOM 版本 / 事实类型数 / 字段总数 | `GET /api/projects/:id/bom`                   |
| 最新发布版本 / 部署环境数        | `projectSummary.version` / `environmentCount` |
| 最近更新人 / 最近更新时间        | `projectSummary.updatedAt`（+ updatedBy）       |
| 生成时间 / 生成人            | 报告生成上下文                                       |

**布局**：顶部品牌头（深蓝渐变 + Decision Workbench Logo，`brand.primary`），下方 6 张 KPI 卡（资产总数、规则数、决策表数、测试通过率、发布版本、部署环境），再下元信息行。

### ② BOM 资产总览



* **事实类型表**：逐类型列出（名称 /label/ 方向 input|output / 字段数）

* **字段分布**：按数据类型统计（Integer/Decimal/Boolean/String/Enum/Date/List 各多少），小型条形图或数字

* **方向汇总**：input 事实 vs output 事实计数

**来源**：`GET /api/projects/:id/bom` → `factTypes[]`（含 `fields[]`），BOM 已是 factTypes 嵌套结构（8 事实类型 / 40 字段）。

### ③ 规则资产清单（按包分组）



| 列        | 来源                                                           |
| -------- | ------------------------------------------------------------ |
| 包名（分组表头） | packages → `name` / `label`                                  |
| 资产名称     | `draft.name`                                                 |
| 类型       | rule /decision-table（图标区分：BAL / DTable / DTree / DRL 各用独立图标） |
| 状态       | 草稿 / 已提交 / 已批准 / 已发布（`assetWorkflowStatus`）                  |
| 版本       | `versions.at(-1).number`                                     |
| 优先级      | `draft.priority`                                             |
| BOM 失效标记 | `bomInvalid`（红色警示）                                           |

**来源**：`GET /api/projects/:id/packages`（含 assets 摘要）+ `GET /api/projects/:id/rules/:id`（明细，含 draft 结构与 attributes，**注意 v1 报告不做逐条条件 / 动作展开**，只出清单行；若需展示可后续扩展）。

### ④ 规则集拓扑



* 每个规则集列出：名称 / 状态 / 版本 / 步骤数 / 分支数 / 命中策略（FIRST|ALL|COLLECT）

* 步骤清单：按顺序列出步骤名 + 引用的资产 id / 名称（已发布版本号）

**来源**：`GET /api/projects/:id/flows`（含 draft.steps/branches /hitPolicy）。

### ⑤ 测试矩阵



| 列               | 来源                                |
| --------------- | --------------------------------- |
| 套件名             | tests → `name`                    |
| 目标（规则集 / 规则名）   | tests → `targetName`              |
| 必选（发布门禁）        | tests → `required`                |
| 用例数 / 通过数 / 失败数 | tests → `lastRun` / `runs`（取最近一次） |
| 通过率             | 计算                                |
| 路径覆盖率           | tests → `lastRun.coverage`        |
| 最近运行时间          | `lastRun.runAt`                   |

**来源**：`GET /api/projects/:id/tests`。无运行记录时显示「未运行」。

### ⑥ 发布与部署历史



| 列                   | 来源                            |
| ------------------- | ----------------------------- |
| 版本号                 | releases → `version`          |
| 名称 / 描述             | `name` / `description`        |
| 决策服务标识              | `decisionService`             |
| 质量门禁                | `qualityGate.passed` + 各套件通过率 |
| 创建人 / 创建时间          | `createdBy` / `createdAt`     |
| 部署环境 / 时间 /checksum | `deployments[]`               |

**来源**：`GET /api/projects/:id/releases`。



***

## 5. 数据源与后端 API 设计

### 5.1 现有 API 复用（零新增模型）



| 数据         | 接口                                                              |
| ---------- | --------------------------------------------------------------- |
| 项目摘要       | `GET /api/projects` / `GET /api/projects/:id`                   |
| BOM        | `GET /api/projects/:id/bom`                                     |
| 包 + 资产摘要   | `GET /api/projects/:id/packages`                                |
| 规则 / 决策表明细 | `GET /api/projects/:id/rules`、`GET /api/projects/:id/rules/:id` |
| 规则集        | `GET /api/projects/:id/flows`（`handleAsset` kind=flows）         |
| 测试套件       | `GET /api/projects/:id/tests`                                   |
| 发布         | `GET /api/projects/:id/releases`                                |

### 5.2 新增接口

#### `GET /api/projects/:id/report`



* **用途**：服务端聚合 + 渲染为**自包含 HTML 报告**（快照式：包含数据、生成时间、生成人、数据版本）

* **响应**：`Content-Type: text/html; charset=utf-8`，返回完整 HTML 文档（内联 CSS，无外部依赖，可直接保存为 `.html` 文件、可离线打开）

* **权限**：复用 `canAccessProject` / `authorizeProject`（与其它项目 API 一致）

* **实现**：新增 `shared/report.js`，导出 `renderProjectReport(project, data)` —— 聚合 5.1 数据 + HTML 模板渲染。`server/index.js` 在 `handleProjects` 增加分支：



```
// server/index.js 伪代码

if (segments.length === 4 && segments\[3] === 'report' && req.method === 'GET') {

&#x20; const data = await projectData(projectId);

&#x20; const packages = await readPackageRecords(projectId, data);

&#x20; const html = renderProjectReport(project, data, packages, actorOf(req));

&#x20; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });

&#x20; return res.end(html);

}
```

#### 聚合函数（`shared/report.js` 内）



```
// 统一数据口径，报告字段与 4 章一一对应

export function aggregateReportData(project, data, packages) {

&#x20; const { rules, tables, flows, releases, bom, changeSets } = data;

&#x20; return {

&#x20;   meta: { generatedAt, generatedBy, bomVersion, releaseVersion, decisionService },

&#x20;   overview: { assetCount, ruleCount, tableCount, packageCount, factTypeCount, fieldCount, environments, latestRelease },

&#x20;   bom: { factTypes, fieldTypeStats, directionStats },

&#x20;   assets: packages.map(pkg => ({ ...pkg, assets: pkg.assets.map(assetSummary) })),

&#x20;   flows: flows.map(flow => ({ name, status, version, stepCount, branchCount, hitPolicy, steps })),

&#x20;   tests: suites.map(suite => ({ name, targetName, required, lastRun })),

&#x20;   releases: releases.map(release => ({ version, name, description, decisionService, qualityGate, deployments })),

&#x20; };

}
```

### 5.3 PDF 实现方案（明确选型）



| 方案              | 描述                                                                 | 取舍                                                              |
| --------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| **A. 前端打印（推荐）** | 报告页 React 视图 + `@media print` 样式 → `window.print()` → 浏览器「另存为 PDF」 | 零新增依赖；打印样式单独维护；用户需点一次保存                                         |
| B. 后端无头浏览器      | puppeteer 渲染 HTML → PDF 流                                          | 生成 PDF 直接下载，体验好；但新增重型依赖（puppeteer/Chromium），与本项目零依赖 Node 后端风格冲突 |

**选型结论：方案 A**。理由：



1. 后端保持零依赖（与现有 `server/index.js` 纯 Node http 一致）

2. 同一 React 渲染源产出 HTML 视图与打印 PDF，**版式保真一致**

3. codex 前端已有 Tailwind，`@media print` 适配成本低

**@media print 要求**：



* 工具栏（返回 / 下载按钮）隐藏

* A4 纸面：`@page { size: A4; margin: 16mm }`

* 每章节 `break-inside: avoid`，表格 `break-inside: auto` + 表头重复（`thead { display: table-header-group }`）

* 品牌色 `brand.primary` 打印时降饱和度（`print-color-adjust: exact` 保留背景，或转浅色）



***

## 6. UI / UED 设计

### 6.1 设计原则



* 对齐 `rts-ui-design.md` 既有视觉语汇：深蓝顶栏 `brand.primary`、系统字体、浅色卡片 + 细边框、RTS 密度

* 报告是「文档」不是「页面」：以 A4 纵向为基准，信息密度高、表格为主，不堆装饰

* 所有表格显式列宽（`table-layout: fixed` + `<colgroup>`，列宽合计 100%）

### 6.2 版式规格



| 元素     | 规格                                                                         |
| ------ | -------------------------------------------------------------------------- |
| 品牌头    | 深蓝渐变（`brand.primary` 系），高 56px，左侧 DW Logo（24px 方块）+ 产品名，右侧「项目知识资产报告」+ 生成时间 |
| 章节标题   | 14px 600，左侧 3px `brand.primary` 竖条 + 编号（01–06）                             |
| KPI 卡  | 6 张，等宽 grid，大数字 24px 700 + 标签 12px muted                                   |
| 表格     | 12px，行高 32px，表头 `#f8fafc` 底 + 600 字重，斑马纹 `#fafbfc`                         |
| 状态徽章   | 草稿 = 灰 / 已提交 = 蓝 / 已批准 = 绿 / 已发布 = 深蓝实心；BOM 失效 = 红（`#dc2626` 描边 + 背景）      |
| 资产类型图标 | BAL = 文书 / DTable = 表格 / DTree = 树 / DRL = 代码，统一 16px 线性 SVG 图标集           |

### 6.3 空态与降级



* 无测试运行记录：测试矩阵显示「未运行」，通过率显示 `—`

* 无发布记录：发布章节显示「暂无发布」，KPI 版本显示 `v1.0.0`

* 空包：规则清单按包分组，空包显示「（空）」；不输出空章节



***

## 7. 权限与安全



| 项       | 规则                                                      |
| ------- | ------------------------------------------------------- |
| 访问控制    | 复用项目级 `canAccessProject`；无权限 → 404（与现有项目 API 一致，不泄露存在性） |
| 数据范围    | 仅项目内已归档过滤后的资产（与 `projectData()` 一致，不含 archived）         |
| 敏感信息    | v1 报告不含凭据 / 密钥类字段；审计事件不在 v1（预留 v2）                      |
| HTML 安全 | 所有用户可控文本（项目名 / 规则名 / 描述）经 HTML 转义后再渲染，防 XSS             |



***

## 8. 验收标准（codex 完成检查清单）

**功能**



* [ ] 项目页顶栏出现「报告」按钮，点击进入 `/projects/:id/report`

* [ ] 报告六章节齐全，字段与第 4 章一致

* [ ] 「下载 HTML」产出自包含 `.html`（离线可打开，无外部 CDN 依赖）

* [ ] 「下载 PDF」触发打印，`@media print` 下工具栏隐藏、A4 分页正常、表格不断行错乱

* [ ] 无测试 / 无发布项目正常降级（空态文案）

**数据**



* [ ] 用 `project-cb74fc72`（粮库温控告警）验证：8 事实类型 / 40 字段 / 6 包 / 9 规则 / 1 规则集（9 步）/ 2 套件（9 场景）/ Release v1 全部正确呈现

* [ ] BOM 失效规则显示红色警示（可临时构造一条失效规则验证）

* [ ] 生成时间 / 生成人 / 决策服务标识 / 数据版本 在报告头展示

**工程**



* [ ] 新增接口 `GET /api/projects/:id/report` 走现有鉴权

* [ ] 报告聚合逻辑在 `shared/report.js`，不污染现有 handler

* [ ] 无新增 npm 依赖（PDF 走打印方案）

* [ ] 前端 3 处历史遗留「Decision Center」文本不新增（沿用 Decision Workbench）



***

## 9. 开发拆分建议（供 codex）



| 步骤 | 内容                                                               | 产出                    |
| -- | ---------------------------------------------------------------- | --------------------- |
| 1  | `shared/report.js`：聚合函数 + HTML 模板（六章节骨架）                         | 纯数据层 + 模板，可先用 curl 验证 |
| 2  | `server/index.js`：`/api/projects/:id/report` 路由 + 鉴权             | 接口可用                  |
| 3  | 前端路由 `/projects/:id/report` + 报告视图（React 渲染 + Tailwind）          | 页面可用                  |
| 4  | 顶栏「报告」按钮 + 跳转                                                    | 入口闭环                  |
| 5  | 下载 HTML（`<a download>`）+ 下载 PDF（`window.print` + `@media print`） | 双格式导出                 |
| 6  | 空态 / 降级 / 打印分页打磨                                                 | 交付                    |



***

## 10. 扩展预留（v2，本期不做）



* **治理审计报告**：变更历史（`GET /api/projects/:id/audit-events` 已有）、规则状态流转统计、作者活跃度、未批准资产风险清单

* **报告模板选择**：资产摘要 / 治理审计 / 自定义章节

* **多项目合并报告**：跨项目资产总览

* **后端 PDF 直出**：如部署环境允许，可加 puppeteer 方案提供「点击即下载 PDF」体验（与方案 A 并存）

* **定时报告**：cron 触发生成，归档到发布记录