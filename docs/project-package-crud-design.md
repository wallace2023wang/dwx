# Project 与 Package CRUD 需求与设计

| 项目 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-09-29 |
| 状态 | P1，BOM 编辑器之后 |

---

## 1. Project CRUD

### 1.1 新建项目

**入口**：库页右上角"+ 新建决策服务"按钮。

**对话框**：
- 项目名称（必填，如"小微企业贷款审批"）
- 项目描述（选填，多行文本）
- 图标（选 loan/warehouse/shield 之一）
- 基线 BOM：
  - 空白起步（空 BOM，自己加字段）
  - 从模板选：贷款审批模板 / 风控模板 / 仓储温控模板
  - 从现有项目复制（下拉选已有项目，复制 BOM 和包结构）

**后端**：`POST /api/projects` 创建空项目，version=1.0.0，branch=main。

### 1.2 编辑项目

**入口**：项目头右上角 ⚙ 设置图标。

可改：
- 名称
- 描述
- 图标
- 默认环境（下拉）

不可改：
- 项目 ID（URL 用）
- 创建时间/创建者

### 1.3 归档/删除项目

- 归档：项目卡片变灰，从库页默认列表隐藏（"显示已归档"开关）
- 删除：硬删除，弹两次确认，列出项目里所有规则数/Release 数
- 已发布到 production 的项目**不能删除**，只能归档

---

## 2. Package CRUD

### 2.1 Package 是什么

Package 是规则的逻辑分组，对应 DRL 里的 `package` 语句。一个项目下多个包，包之间可以有层级（嵌套）。

```
个人贷款审批（项目）
├── validation 校验
├── eligibility 准入
│   ├── income 收入核查
│   └── credit 信用核查
└── underwriting 承保
```

### 2.2 新建包

**入口**：左栏 Package 树顶部"+ 新建包"按钮，或某个包节点右键"新建子包"。

**对话框**：
- 包名（英文标识符，如 `eligibility.income`）
- 中文显示名（如"收入核查"）
- 父包（默认根，可选已有包作为父级）

**约束**：
- 同项目下包名唯一
- 不能用中文做英文标识符
- 最多嵌套 3 层

### 2.3 编辑包

- 重命名：双击包节点，或右键"重命名"
- 改中文显示名
- **注意**：改包名会移动该包下所有规则，规则的 category 字段跟着变

### 2.4 删除包

- 右键"删除"
- 如果包里有规则，弹警告："包 eligibility.income 下有 5 条规则，删除包会同时删除规则吗？"
  - 选项：移到其他包 / 一起删除 / 取消
- 空包直接删

### 2.5 包排序

- MVP 不做拖拽，按创建顺序排
- 后续可上下箭头调顺序

---

## 3. Rule (BAL) CRUD

### 3.1 新建规则

**入口**：
- 中栏资产列表顶部"+ 新建规则"按钮
- 选中包后右键"新建规则"

**对话框**：
- 规则名称（必填，如"客户年龄不足拒绝"）
- 所属包（默认当前选中包，下拉可改）
- 规则类型：BAL 规则（默认）/ 决策表
- 从模板创建（可选：空规则 / 复制现有规则）

**创建后**：自动打开右栏 BAL 编辑器，状态=草稿。

### 3.2 编辑规则

- 中栏点规则行 → 右栏打开编辑器
- 改完点"保存草稿"（draft 版本 +1）
- "编译"→ 后端生成 DRL 并跑 Drools 校验
- "提交发布"→ 进审批流（作者不能自审自发）

### 3.3 复制规则

- 中栏右键"复制"→ 弹对话框填新名称
- 复制 BAL JSON、属性、描述，状态=草稿
- 用于"基于现有规则改一个变体"

### 3.4 重命名规则

- 右栏编辑器顶部规则名直接编辑
- 中栏列表同步更新

### 3.5 删除规则

- 中栏右键"删除"
- 如果规则已发布，弹警告："该规则已在 v2.1 发布，删除后需要构建新 Release 才能生效"
- 确认后软删除（归档），可恢复

### 3.6 移动到其他包

- 右键"移动到..."→ 选目标包
- 规则的 category 字段跟着变

### 3.7 状态流转

```
草稿（作者编辑）→ 提交审核 → 审核中 → 已发布
                ↘ 拒绝 → 回到草稿
已发布 → 废弃（归档）
```

中栏列表按状态显示彩色标签：
- 草稿：橙底
- 审核中：蓝底
- 已发布：绿底
- 已废弃：灰底

---

## 4. Decision Table CRUD

### 4.1 新建决策表

**入口**：中栏"+ 新建规则"下拉选"决策表"。

**对话框**：
- 决策表名称（如"风险等级评估表"）
- 所属包
- 初始列：从 BOM 选字段（多选），自动分条件列/动作列
- 命中策略：COLLECT（默认）/ FIRST / PRIORITY

**创建后**：打开决策表网格编辑器，默认 1 行空行。

### 4.2 编辑决策表

- 中栏点决策表 → 右栏打开网格编辑器（见 decision-table-design.md）
- 加列：顶部"+ 添加条件列/+ 添加动作列"
- 加行：底部"+ 添加行"
- 单元格直接编辑

### 4.3 复制/重命名/删除/移动

- 同 Rule（见 §3.3-3.6）
- 复制时把列定义和行数据一起复制

### 4.4 决策表 vs BAL 规则的区别

| | BAL 规则 | 决策表 |
|---|---|---|
| 适合场景 | 单条逻辑、if-then | 多条件枚举矩阵 |
| 编辑器 | 卡片式条件/动作行 | Excel 网格 |
| 列从 BOM | 动态选字段 | 建表时选列，固定 |
| 复制 | 整个 JSON 复制 | 列+行一起复制 |

---

## 5. 资产类型图标与视觉区分

中栏列表、左栏树、面包屑、搜索结果里，4 种资产类型用不同图标和颜色区分，不能只靠文字。

| 类型 | lucide 图标 | 图标颜色 | 背景色 | 用途 |
|---|---|---|---|---|
| **BAL 规则** | `GitBranch` 或 `FileText` | `#0f62ff` 蓝 | `#dbeaff` | if-then 卡片式规则 |
| **Decision Table** | `Table` 或 `Grid2x2` | `#7c3aed` 紫 | `#ede9fe` | Excel 网格决策表 |
| **Decision Tree** | `Network` 或 `GitFork` | `#059669` 绿 | `#d1fae5` | 树形判断（菱形节点） |
| **DRL 脚本** | `Code2` 或 `FileCode` | `#b45309` 棕 | `#fef3c7` | 手写 DRL 高级规则（M2） |
| **RuleFlow** | `Workflow` 或 `Share2` | `#dc2626` 红 | `#fee2e2` | 规则集程图 |

### 使用规则

- 中栏列表每行：图标在名称左侧，16px
- 左栏 Package 树：不显示资产图标，只显示包图标
- 新建对话框：4 个类型卡片可选，每个卡片带图标+名称+一句话说明
- 面包屑：`项目 / 包 / [图标] 规则名`
- 类型过滤下拉：每个选项前带对应图标

### 新建对话框（4 卡片选择）

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  [蓝图标]     │  [紫图标]     │  [绿图标]     │  [棕图标]     │
│  BAL 规则     │  决策表       │  决策树       │  DRL 脚本     │
│  if-then 规则│  Excel 网格   │  树形判断     │  手写 DRL     │
│  适合单条逻辑 │  适合枚举矩阵 │  适合分支流程 │  高级开发者   │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

> Decision Tree 和 DRL 脚本本期不实现，图标先留好，M2 再做。

---

## 6. 中栏资产列表通用操作

### 5.1 搜索与过滤

- 顶部搜索框：按规则名/描述搜
- "所有类型"下拉：规则 / 决策表 / 规则集
- 状态过滤：全部 / 草稿 / 审核中 / 已发布

### 5.2 批量操作

- 多选规则后：批量移动到包 / 批量删除 / 批量提交审核
- MVP 不做，先单选

### 5.3 资产行信息

每行显示：
- 名称（蓝色链接）
- 类型图标（规则 / 决策表 / 规则集）
- 修改者
- 状态标签
- 版本号

---

## 7. 包与资产的关系

- 规则/决策表创建时必须选一个包（默认"未分类"）
- 资产可以在包之间移动（右键"移动到..."）
- 包在 Ruleset 配置里勾选——决定这个 Ruleset 跑哪些包
- 删包时包里的资产要么移走要么一起删

---

## 8. 后端 API

```
# Project
POST   /api/projects                 {name, description, icon, bomTemplate} -> Project
PUT    /api/projects/:id             {name, description, icon}
POST   /api/projects/:id/archive
DELETE /api/projects/:id             (软删除/归档)

# Package
GET    /api/projects/:id/packages
POST   /api/projects/:id/packages   {name, label, parentId}
PUT    /api/projects/:id/packages/:pkgId   {name, label}
DELETE /api/projects/:id/packages/:pkgId   {moveRulesTo?: pkgId}

# Rule (BAL)
GET    /api/projects/:id/rules?package=xxx&type=rule
POST   /api/projects/:id/rules      {name, category, type:'rule'} -> Asset
GET    /api/projects/:id/rules/:ruleId
PUT    /api/projects/:id/rules/:ruleId  {name, category, draft}
POST   /api/projects/:id/rules/:ruleId/duplicate  {newName}
POST   /api/projects/:id/rules/:ruleId/move  {targetPackage}
POST   /api/projects/:id/rules/:ruleId/submit  (提交审核)
DELETE /api/projects/:id/rules/:ruleId

# Decision Table
POST   /api/projects/:id/decision-tables  {name, category, columns, hitPolicy}
PUT    /api/projects/:id/decision-tables/:dtId
POST   /api/projects/:id/decision-tables/:dtId/duplicate
DELETE /api/projects/:id/decision-tables/:dtId
```

---

## 9. 验收清单

- [ ] 库页右上角有"+ 新建决策服务"按钮
- [ ] 新建项目对话框能填名称/描述/选 BOM 模板
- [ ] 创建后自动进入新项目，BOM 是空的或从模板来
- [ ] 左栏 Package 树有"+ 新建包"按钮
- [ ] 新建包对话框填英文名+中文名
- [ ] 包节点右键菜单：重命名/删除/新建子包
- [ ] 删除有规则的包弹警告，能选移到其他包
- [ ] 中栏顶部"+ 新建规则"能建 BAL 规则，创建后自动打开编辑器
- [ ] "+ 新建规则"下拉能选"决策表"，弹对话框选 BOM 字段建列
- [ ] 规则行右键：编辑/复制/重命名/移动到包/删除
- [ ] 删除已发布规则弹警告
- [ ] 顶部搜索框能按名字搜规则
- [ ] "所有类型"下拉能过滤规则/决策表
- [ ] 状态标签：草稿橙/审核中蓝/已发布绿/已废弃灰
- [ ] 项目头有 ⚙ 设置图标，能改名称/描述
- [ ] 归档项目后从库页消失，"显示已归档"能看到
- [ ] 已发布到 production 的项目不能硬删除
