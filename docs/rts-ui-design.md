# Rule Team Server UI / UED 设计说明

| 项目 | 内容 |
|---|---|
| 版本 | v0.2 |
| 日期 | 2026-09-29 |
| 对标 | IBM ODM Decision Workbench Business Console |
| 原型 | `docs/design-rts/rts-prototype.html`（浏览器直接打开） |
| 状态 | 高保真原型，可点击走通主流程 |

---

## 1. 设计原则

1. **三栏工作区**：左资产树 + 中资产列表 + 右编辑器，复刻 ODM Business Console。
2. **BAL 自然语言规则**：规则作者写"如果 申请人年龄 < 18 那么 拒绝"，业务术语蓝色虚线下划线，值灰底等宽。
3. **JSON-as-fact**：无 Java POJO / 无 XOM 映射层，HTTP JSON 直接作为事实插入 KieSession，BOM 变更自动生成 DRL `declare` 块。
4. **不可变 Release**：每次发布冻结 DRL + BOM + 校验和，部署到环境后不可修改。
5. **职责分离**：规则作者不能自审自发，部署员不能改规则。

---

## 2. 全局导航

```
┌──────────────────────────────────────────────────────────┐
│ 深蓝顶栏: [R] Decision Workbench   主页|库|浏览|管理   🔔 👤 │
├──────────────────────────────────────────────────────────┤
│ 子导航: 主页 / 库 / 浏览 / 管理                            │
├──────────────────────────────────────────────────────────┤
│ 项目头: 项目名 + 分支 main + 5 个子 Tab                    │
│         [资产] [规则流] [BOM/词汇] [测试套件] [发布]        │
├──────────────┬───────────────────────────────────────────┤
│ 左: 资产树    │  中: 资产列表      │  右: 编辑器            │
│ (Package 树)  │  (名称/修改者/状态) │  (BAL/决策表/DRL)     │
├──────────────┴───────────────────────────────────────────┤
│ 状态栏: 版本 v2.1.0 · 作者 · 状态 · 编译 · Drools 10.2.0   │
└──────────────────────────────────────────────────────────┘
```

### 2.1 顶部子导航

| Tab | 用途 |
|---|---|
| **主页** | 最近活动、我关注的规则、快捷入口 |
| **库** | 决策服务卡片列表，点入进入项目 |
| **浏览** | 规则依赖图、冲突检查、影响分析 |
| **管理** | 用户 / 角色权限矩阵 / 环境与 RES |

### 2.2 项目内子 Tab

| Tab | 内容 |
|---|---|
| **资产** | 三栏工作区：Package 树 → 资产列表 → BAL 编辑器 / 决策表 |
| **规则流** | Ruleset 配置卡片 + RuleFlow 画布 |
| **BOM/词汇** | 对象模型（左）+ 业务词汇表（右）+ DRL declare 预览 |
| **测试套件** | 场景表：输入列 → 期望/实际 → 通过状态 |
| **发布** | Release 历史 + 构建向导 |

---

## 3. 核心交互流程

### 3.1 创建规则

1. 库 → 点项目 → 资产 Tab
2. 左树选 Package（如 eligibility）
3. 中点"+ 新建规则"
4. 右编辑器写 BAL：
   - 业务术语（蓝色虚线下划线）点击编辑
   - 值（灰底等宽）点击修改
   - 底部属性面板：优先级、命中策略、有效日期
5. "保存草稿" → 状态变草稿
6. "提交发布" → 进入审批流

### 3.2 决策表编辑

- 类 Excel 网格，空单元格 = 通配
- 区间语法 `600..700`，枚举语法 `a,b,c`
- 默认行在最下方
- 命中策略：FIRST / PRIORITY / COLLECT

### 3.3 构建 Release（5 步向导）

点"发布"Tab → "构建新 Release"：

| 步骤 | 内容 |
|---|---|
| 1. 选择资产 | 勾选要包含的规则/决策表（归档默认不勾） |
| 2. 版本信息 | 版本号（自动递增）、发布说明、Release 类型 |
| 3. 编译验证 | DRL 编译 / BOM 校验 / 测试套件 / 冲突检测，失败项红色标注 |
| 4. 部署目标 | 勾选 dev/test/staging/prod，标注部署策略 |
| 5. 确认构建 | 摘要表 + 校验和 + 已知问题警告，点"构建" |

### 3.4 部署环境（默认最佳实践，可增删）

| 环境 | 用途 | 部署策略 |
|---|---|---|
| **dev**（紫） | 规则作者本地调试 | 草稿保存自动部署 |
| **test**（蓝） | CI 跑测试套件 | Release 构建自动部署 |
| **staging**（橙） | 预发，与生产同配置 | 手动，带 Shadow 对比 |
| **production**（绿） | 真实流量 | 双人审批，Shadow 并行 |

- Shadow 不是独立环境，是 production/staging 的一个运行模式（同版本双跑，不产生副作用）
- 点"+ 新增环境"可加自定义环境名（监管沙箱/灾备等）

---

## 4. 关键概念映射

| ODM 概念 | 本平台对应 | UI 位置 |
|---|---|---|
| Rule Project | 决策服务（Miniloan 贷款审批） | 库 → 项目卡片 |
| Rule Package | 资产树节点（validation/eligibility/underwriting） | 左栏树 |
| Rule / Decision Table | 规则 / 决策表 | 三栏工作区 |
| **Ruleset** | 可执行单元配置 | 规则流 Tab 顶部卡片 |
| RuleFlow | 流程图（Start→Gateway→RuleTask→End） | 规则流 Tab 画布 |
| BOM | 对象模型 + 业务词汇 | BOM/词汇 Tab |
| Release | 不可变发布包 | 发布 Tab |
| RuleApp | RES 部署归档（预留 M4） | 暂未实现 |
| Environment | dev/test/staging/prod | 管理 → 环境 |

---

## 5. RuleFlow 画布规范

- **开始节点**：绿色圆形，标注输入 fact（如 LoanRequest）
- **网关**：橙色菱形，标注分支条件（"是/否"标签）
- **RuleTask**：蓝色边框矩形，标题 + 规则包名
- **结束节点**：红色圆形，标注输出 fact（如 LoanDecision）
- **连线**：折线带箭头，"是/否"分支用绿/红色标签
- **未激活分支**：灰色虚线矩形
- **右上角工具栏**：缩放 / 适应窗口 / 自动布局

> 注：RuleFlow 不是 BPMN，是 Drools Flow——只有 Start/Gateway/RuleTask/End 四种节点，无泳道/消息/定时器。

---

## 6. BOM 设计决策

- **无 Java XOM**：HTTP JSON 直接作为事实插入 KieSession
- **BOM 变更自动生成 DRL declare**：BOM/词汇 Tab 右下有 DRL 预览
- **多事实类型**：一个 Ruleset 可声明多个 fact（Borrower + Loan），集合类型用 `List<>`
- **BigDecimal 精度**：金额/温度字段显式用 BigDecimal，不用 Double
- **输出事实**：规则动作是 `insert(new LoanDecision(...))`，不是 `setX(常量)`

---

## 7. 权限模型

| 权限 | 管理员 | 规则作者 | 发布审核 | 部署员 | 只读 |
|---|:-:|:-:|:-:|:-:|:-:|
| 浏览规则 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 编辑草稿/BOM | ✓ | ✓ | — | — | — |
| 提交审批 | ✓ | ✓ | — | — | — |
| 审核并发布 | ✓ | — | ✓ | — | — |
| 部署到 RES | ✓ | — | — | ✓ | — |
| 管理用户/环境 | ✓ | — | — | — | — |

原则：作者不能自审自发，审核与部署必须双人分离。

---

## 8. 实现状态（MVP 之后）

### 已完成

- [x] Rule Package 树状分组。证据：`shared/packages.js`、`GET /api/projects/:id/packages`（`server/index.js`）、前端 `frontend/src/components/assets/PackageTree.tsx`。
- [x] 项目级 BOM 隔离（原「Project 多租户隔离」，当前粒度为项目）。证据：每项目独立的 `data/bom-project-*.json`、`GET/PUT /api/projects/:id/bom`、`GET /api/projects/:id/bom/references`。工作空间级多租户隔离仍未实现（见 `README.md` 边界章节）。
- [x] 多 Ruleset 切换。证据：后端 `GET /api/projects/:id/rulesets`（`server/index.js`），前端 `frontend/src/api/flows.ts` 与 `frontend/src/components/flow/RulesetConfig.tsx`。
- [x] DRL 预览与 DRL diff。证据：`frontend/src/components/bom/DrlPreview.tsx`（预览）、`shared/changes.js`（结构化差异）。
- [x] 影响分析（改 BOM 后哪些规则受影响）。证据：`GET /api/projects/:id/bom/references`、`shared/bom.js`，测试 RTS-BOM-09/10（`test/rts-bom-api.test.js`）。
- [x] Shadow 运行差异报告。由测试套件的已发布版本并行对比覆盖：`POST /api/projects/:id/test-suites/:suiteId/compare`（`server/index.js`），设计见 `docs/test-analysis-design.md`。

### 仍未实现

- [ ] RuleApp 多 Ruleset 打包部署。当前 Release 以决策服务 / 规则流为单位，没有 RuleApp 级打包与部署概念。证据：`shared/releases.js`、`server/index.js` 的 Release 构建路径中不存在 RuleApp。
