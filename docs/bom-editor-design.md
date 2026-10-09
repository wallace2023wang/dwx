# BOM 编辑器需求与设计（DWX）



| 项目 | 内容                                                  |
| -- | --------------------------------------------------- |
| 版本 | v1.0                                                |
| 日期 | 2026-09-29                                          |
| 产品能力 | DWX BOM / Business Model Editor |
| 状态 | P0，先于 BAL 和决策表开发                                    |



***

## 1. 为什么 BOM 是 P0

BOM 是整个规则平台的元数据源头：



* BAL 编辑器的事实类型 / 字段 / 枚举值，全部从 BOM 拉

* 决策表的列，全部从 BOM 生成

* DRL `declare` 块，根据 BOM 自动生成

* BOM 改字段 → 所有引用它的规则要标红 / 告警

**BOM 不能编辑，后面所有编辑器都是死的。** 现在 BOM 是只读，业务人员想加个 "手机号" 字段得改后端 JSON。



***

## 2. BOM 数据模型

当前实现包含两个稳定视图，不能混为一次后端模型迁移：

* 持久化、规则生成和 Release 冻结使用 flat `fields[]`，字段通过 `factType` / `factTypeLabel` 归属事实类型。
* `GET /api/projects/{projectId}/bom` 与前端编辑器使用 `factTypes[].fields[]` 视图；保存前由 `flattenFromFactTypes()` 转回 flat 字段，读取后由 `flattenToFactTypes()` 分组。
* 字段 `key` 当前是项目内全局唯一的技术标识（例如 `customerAge`），不是示例中的 `borrower.age` 路径。RES 和 DRL 生成本期保持该契约。

以下 JSON 用于说明前端分组视图，不表示持久化层已经迁移为嵌套模型。



```
{

&#x20; "version": 4,

&#x20; "factTypes": \[

&#x20;   {

&#x20;     "name": "Borrower",

&#x20;     "label": "借款申请人",

&#x20;     "direction": "input",

&#x20;     "fields": \[

&#x20;       {"key": "borrower.age", "name": "age", "label": "年龄", "type": "number", "unit": "岁", "min": 0, "max": 120},

&#x20;       {"key": "borrower.creditScore", "name": "creditScore", "label": "信用分", "type": "number", "min": 300, "max": 850},

&#x20;       {"key": "borrower.yearlyIncome", "name": "yearlyIncome", "label": "年收入", "type": "bigdecimal", "unit": "元"},

&#x20;       {"key": "borrower.delinquencies", "name": "delinquencies", "label": "逾期次数", "type": "number", "min": 0},

&#x20;       {"key": "borrower.residency", "name": "residency", "label": "居住城市", "type": "string"}

&#x20;     ]

&#x20;   },

&#x20;   {

&#x20;     "name": "Loan",

&#x20;     "label": "贷款申请",

&#x20;     "direction": "input",

&#x20;     "fields": \[

&#x20;       {"key": "loan.amount", "name": "amount", "label": "申请金额", "type": "bigdecimal", "unit": "元"},

&#x20;       {"key": "loan.durationMonths", "name": "durationMonths", "label": "期限", "type": "number", "unit": "月"},

&#x20;       {"key": "loan.productType", "name": "productType", "label": "产品类型", "type": "enum", "enum": \["消费贷", "经营贷", "房贷"]}

&#x20;     ]

&#x20;   },

&#x20;   {

&#x20;     "name": "LoanDecision",

&#x20;     "label": "审批结果",

&#x20;     "direction": "output",

&#x20;     "fields": \[

&#x20;       {"key": "decision.approved", "name": "approved", "label": "批准", "type": "boolean"},

&#x20;       {"key": "decision.riskLevel", "name": "riskLevel", "label": "风险等级", "type": "enum", "enum": \["低", "中", "高", "拒绝"]},

&#x20;       {"key": "decision.maxAmount", "name": "maxAmount", "label": "最大额度", "type": "bigdecimal", "unit": "元"},

&#x20;       {"key": "decision.needsManualReview", "name": "needsManualReview", "label": "需要人工复核", "type": "boolean"},

&#x20;       {"key": "decision.reasons", "name": "reasons", "label": "理由", "type": "list\<string>"}

&#x20;     ]

&#x20;   }

&#x20; ],

&#x20; "relationships": \[

&#x20;   {"from": "Request", "to": "Borrower", "cardinality": "1"},

&#x20;   {"from": "Request", "to": "Loan", "cardinality": "1"},

&#x20;   {"from": "Request", "to": "LoanDecision", "cardinality": "1"}

&#x20; ]

}
```



***

## 2.5 数据类型系统（类型决定操作符和控件）

BOM 字段的 `type` 决定三件事：DRL declare 用什么类型、BAL 编辑器给哪些操作符、值输入用什么控件。三者联动，不允许手写。

### 支持的数据类型

| 类型 | DRL 映射 | 用途 | 可配约束 |
|---|---|---|---|
| `Integer` | Integer | 计数、年龄、期数 | min/max |
| `Decimal` | BigDecimal | 金额、利率、温湿度（精度敏感） | min/max/unit |
| `Boolean` | boolean | 是否、开关 | 无 |
| `String` | String | 文本、姓名、城市 | maxLength/regex |
| `Enum` | String + 约束 | 枚举值（低/中/高） | enum[] 必填 |
| `Date` | LocalDate | 日期（生日、到期日） | min/max（日期） |
| `List<String>` | java.util.List | 多值（理由列表、标签） | 元素是否可重复 |

> 不再使用 `Double`（金额精度问题），统一用 `Decimal`。

> 当前兼容实现将业务类型与运行时类型分离：BOM `semanticType=Decimal` 暂映射到 `type=Double`，`Date` 和 `List<String>` 暂映射到 `String`。前端只展示业务类型；迁移到 BigDecimal、LocalDate 和原生 List 涉及 DRL、历史资产与 RES 制品兼容，不在本轮修复中。

input 字段可配置 `required=true`。测试和 Release 执行不会为缺失字段补 `0`、`false` 或空字符串；可选字段保持未赋值，必填字段缺失时返回 `400`。`required` 不允许用于 output 字段。

### 类型 → 可用操作符矩阵

| 类型 | 可用操作符 | 中文显示 |
|---|---|---|
| Integer / Decimal | `==` `!=` `>` `<` `>=` `<=` `between` | 等于/不等于/大于/小于/大于等于/小于等于/介于 |
| Date | `==` `!=` `before` `after` `between` | 等于/不等于/早于/晚于/介于 |
| Boolean | `==` `!=` | 等于/不等于 |
| Enum | `==` `!=` `in` `not in` | 是/不是/属于/不属于 |
| String | `==` `!=` `contains` `not contains` `starts with` `ends with` `matches` | 等于/不等于/包含/不包含/开头是/结尾是/匹配正则 |
| List<String> | `contains` `not contains` `size >` `size <` | 包含/不包含/长度大于/长度小于 |

### 类型 → 值控件矩阵

| 类型 | 值输入控件 | 说明 |
|---|---|---|
| Integer | number input（step=1） | 按 min/max 限制 |
| Decimal | number input（step=0.01） | 金额默认 2 位小数 |
| Boolean | true/false 下拉 | |
| Enum | 单选下拉（==/!=）或多选（in/not in） | 选项从 BOM enum[] 拉 |
| String | 文本输入框 | contains 时不需要完整匹配 |
| Date | date picker | |
| List<String> 条件值 | 文本或长度输入 | 兼容期按运行时序列化文本判断包含和长度 |

当前实现细则：

* `between` 为闭区间，结构化保存 `value` 下界和 `valueEnd` 上界；编辑器提供两个数字框或日期选择器。
* `Date` 使用严格的 `YYYY-MM-DD` ISO 日期，早于/晚于/介于按该格式比较。
* `Enum` 的 `in/not in` 使用 `values[]` 保存，多选项必须来自 BOM 的 `enum[]`。
* `matches` 保存正则表达式，前后端都会做语法检查，运行时使用 Java `String.matches` 完整匹配。
* `List<String>` 在当前兼容模型中仍映射为序列化文本，因此“包含/不包含/长度”针对运行时文本执行；迁移为原生 Java List 后再升级为严格的元素级语义。
* 业务字段作为右值时，只开放语义明确的单值操作。`between`、`in/not in` 和列表操作固定使用结构化固定值。

### 类型变更影响

| 从 → 到 | 影响 |
|---|---|
| Integer → Decimal | 兼容，已有值不变 |
| Decimal → Integer | 小数丢失，警告 |
| String → Enum | 已有值不在枚举里的标红 |
| Enum → String | 兼容，下拉变文本框 |
| 任意 → Date | 已有字符串值可能不是日期格式，标红 |
| String → List | 已有单值变单元素列表，兼容 |

### 新增字段时的类型选择流程

1. 用户选类型
2. 如果选 Enum，立即多出"枚举值"输入框（逗号分隔）
3. 如果选 Integer/Decimal，多出 min/max/unit 可选字段
4. 如果选 String，多出 maxLength/regex 可选字段
5. 操作符和值控件根据类型自动切换，不需要用户配

---

## 3. UI 布局

### 3.1 整体结构（保持现有三栏）



```
┌────────────────────────────────────────────────────────┐

│ BOM 业务对象模型   v4 · 3 事实类型 · 12 字段  \[编辑模型] │

├──────────────────────┬─────────────────────────────────┤

│ 左: 事实类型列表      │ 右:                            │

│                      │  ┌ 业务词汇表（可编辑）──────┐  │

│ ▸ Borrower 借款申请人 │  │ BOM属性 │ 业务说法 │ 类型 │  │

│   • age 年龄         │  │ Borrower.age │ \[年龄]│ number│  │

│   • creditScore 信用分│  │ Borrower.creditScore│\[信用分]│  │

│   • \[+ 新增字段]     │  │ ...                       │  │

│                      │  └───────────────────────────┘  │

│ ▸ Loan 贷款申请      │  ┌ DRL declare 预览 ────────┐  │

│   • amount 申请金额  │  │ declare Borrower ...      │  │

│   • \[+ 新增字段]     │  └───────────────────────────┘  │

│                      │                                 │

│ ▸ LoanDecision 审批  │                                 │

│   • approved 批准   │                                 │

│   • \[+ 新增字段]     │                                 │

│                      │                                 │

│ \[+ 新增事实类型]     │                                 │

│                      │                                 │

│ 对象关系             │                                 │

│ Request → Borrower 1 │                                 │

│ Request → Loan 1     │                                 │

└──────────────────────┴─────────────────────────────────┘
```

### 3.2 编辑模式切换



* 默认是只读视图（和现在一样）

* 右上角 "编辑模型" 按钮 → 进入编辑模式，所有可编辑字段出现 hover 高亮

* 编辑模式下顶部出现黄色警告条："正在编辑 BOM，保存后影响所有规则"

* 保存 / 取消按钮出现在警告条上



***

## 4. 编辑操作

### 4.1 新增事实类型



* 左栏底部 "+ 新增事实类型" 按钮

* 弹小对话框：


  * 类名（英文标识符，如 `Borrower`）：自动校验唯一

  * 业务名称（中文，如 "借款申请人"）

  * 方向：输入事实 / 输出事实（单选）

* 确认后加到列表底部，自动展开

### 4.2 新增字段



* 每个事实类型卡片底部 "+ 新增字段" 按钮

* 弹对话框：


  * 字段名（英文，如 `age`）：自动转驼峰

  * 业务说法（中文，如 "年龄"）

  * 类型：number /bigdecimal/string /boolean/date /enum/list\<string>

  * 如果是 enum：多出一行 "枚举值" 输入框，逗号分隔（如 "低，中，高，拒绝"）

  * 如果是 number/bigdecimal：可选填单位、最小值、最大值

* 确认后加到字段列表末尾

### 4.3 编辑字段



* 字段行 hover → 出 ✏️ 和 🗑 图标

* 点 ✏️ → 弹同样的对话框，预填当前值

* **中文 label 可随便改**（BAL 显示名自动跟着变，因为存的是 field.key）

* **类型变更要警告**：


  * number → string：已有规则里的数字值要重填

  * string → number：已有字符串值可能不合法

  * enum 删值：引用被删值的规则标红

* 改完点 "保存" 才生效

### 4.4 删除字段



* 点 🗑 → 弹确认对话框：



```
确定删除字段 "Borrower.creditScore"（信用分）？

该字段被以下 2 个规则引用：

&#x20; \- 信用分达到准入线

&#x20; \- 风险等级评估

删除后这些规则将标红，直到你修改或删除它们。

\[取消]  \[确认删除]
```



* 不能直接删，必须确认

### 4.5 删除事实类型



* 事实类型卡片标题旁 🗑 图标

* 同样要列出引用它的所有规则，警告后确认

### 4.6 业务词汇表编辑



* 右栏业务词汇表的 "业务说法" 列直接可编辑（点击单元格变输入框）

* 其他列（BOM 属性 / 类型）只读



***

## 5. BOM 变更影响分析

保存 BOM 时，前端（或后端）自动跑一遍影响分析：



| 变更类型                | 影响          | 处理         |
| ------------------- | ----------- | ---------- |
| 新增事实类型              | 无           | 直接保存       |
| 新增字段                | 无           | 直接保存       |
| 改中文 label           | BAL 显示名自动更新 | 直接保存       |
| 删字段                 | 引用该字段的规则    | 弹警告列表，要求确认 |
| 改字段类型 number→string | 引用该字段的规则值   | 弹警告，值可能不合法 |
| enum 删值             | 用了该枚举值的规则   | 弹警告        |
| 删事实类型               | 所有引用它的规则    | 弹警告        |

警告列表在保存对话框里列出，每条前面带勾选框，用户可以勾 "我已知晓" 才能保存。



***

## 6. 和 DRL 的联动

BOM 保存后，后端自动重新生成 DRL `declare` 块：



```
declare Borrower

&#x20; age : Integer

&#x20; creditScore : Integer

&#x20; yearlyIncome : BigDecimal

&#x20; delinquencies : Integer

&#x20; residency : String

end
```



* 右下方 DRL 预览实时更新

* 新增字段 → declare 里多出一行

* 改类型 → DRL 类型跟着变（Integer → String）

* 枚举 → DRL 里用 String（传统商业平台 风格，枚举值在规则里做校验）



***

## 7. 存储与版本



* BOM 保存后版本号 +1（v4 → v5）

* 历史版本可回滚（右栏 "版本历史"，MVP 不做，先存 DB）

* 已发布的 Release 里 BOM 是冻结快照，改 BOM 不影响线上



***

## 8. 验收清单



* [ ] 去掉 "只读模型" 标签，出现 "编辑模型" 按钮

* [ ] 点 "编辑模型" 进入编辑模式，顶部黄色警告条

* [ ] "+ 新增事实类型" 能弹对话框，保存后列表出现新类型

* [ ] "+ 新增字段" 能弹对话框，类型选 enum 时多出枚举值输入

* [ ] 字段行 hover 出编辑 / 删除图标

* [ ] 改中文 label 后，业务词汇表和 BAL 里的显示名都更新

* [ ] 删字段时弹确认，列出引用该字段的规则

* [ ] 删 enum 值时，用了该值的规则标红

* [ ] 保存后 DRL declare 预览自动更新

* [ ] 取消编辑模式不保存任何修改

* [ ] 保存成功 toast "BOM v5 已保存"



***

## 9. 不在本期做



* 拖拽调整事实类型 / 字段顺序

* 字段分组（一个事实类型下分 "基本信息 / 财务信息"）

* 跨事实类型引用（Loan.borrower.age）

* BOM 导入导出 JSON

* BOM 版本 diff

* 对象关系编辑器（现在硬编码 Request→1 Borrower 等）

* 字段校验注解（@Size @Pattern）
