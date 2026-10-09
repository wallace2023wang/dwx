# BOM / 业务词汇 可配置化需求设计

版本：0.1
更新日期：2026-09-29
对应里程碑：M2.3

## 1. 背景与问题

当前字段字典写死在 `shared/rules.js` 的 `fields` 数组中：

```js
export const fields = [
  { key: 'customerAge', label: '客户年龄', type: 'Integer', kind: 'input' },
  { key: 'annualIncome', label: '年收入', type: 'Double', kind: 'input' },
  ...
];
```

这带来四个问题：

1. **业务人员无法自定义字段**：新增一个输入字段（如"客户职业""授信期限"）必须改代码、重新部署。
2. **RES 端硬编码重复**：`ResServer.java` 里用 `List.of("customerAge", ...)` 和 `switch(key)` 硬编码了同一份字段表和类型映射，与 Node 端两份真相，容易漂移。
3. **缺乏枚举、单位、分组等业务语义**：传统规则平台 BOM 允许为字段配置中文别名、枚举值域、单位、输入控件、字段分组，当前全部缺失。
4. **模型变更无影响分析**：删除或改类型一个字段，哪些规则/决策表/规则集引用了它，系统不知道。

## 2. 设计目标

- BOM 成为 Team Server 的可持久化配置资产，存 `data/bom.json`，通过 `GET/PUT /api/bom` 管理。
- DRL 生成器、规则校验、决策表校验、试运行 facts 校验全部从 BOM 读取字段定义，不再 import 写死数组。
- RES 端**不保存 BOM 副本**：它从编译后 Drools KieBase 反射 `workbench.RuleInput` 的 FactType，动态获得字段名与类型。DRL 的 `declare RuleInput { ... }` 语句本身就是 BOM 在 Release 中的冻结快照，符合 ADR-002。
- 字段定义扩展：分组、枚举、单位、数值范围、输入控件、说明。
- BOM 修改时做影响分析：列出引用了被删字段或类型变更字段的草稿/已发布资产。

## 3. BOM 数据模型

```json
{
  "version": 1,
  "updatedAt": "2026-09-29T00:00:00.000Z",
  "fields": [
    {
      "key": "customerAge",
      "label": "客户年龄",
      "type": "Integer",
      "kind": "input",
      "group": "客户基本信息",
      "unit": "岁",
      "min": 0,
      "max": 150,
      "enum": null,
      "control": "number",
      "description": "申请客户周岁年龄"
    },
    {
      "key": "customerType",
      "label": "客户类型",
      "type": "String",
      "kind": "input",
      "group": "客户基本信息",
      "unit": null,
      "min": null,
      "max": null,
      "enum": ["个人", "企业", "同业"],
      "control": "select",
      "description": ""
    },
    {
      "key": "riskLevel",
      "label": "风险等级",
      "type": "String",
      "kind": "output",
      "group": "结果输出",
      "enum": ["低", "中", "高"],
      "control": "select",
      "description": ""
    }
  ]
}
```

### 3.1 字段属性

| 属性 | 类型 | 必填 | 说明 |
|---|---|---|---|
| key | string | 是 | 英文标识符，`^[a-z][a-zA-Z0-9_]{1,31}$`，作为 DRL 属性名和 facts JSON key，全局唯一 |
| label | string | 是 | 中文显示名，1–40 字 |
| type | enum | 是 | `Integer` / `Double` / `String` / `Boolean` |
| kind | enum | 是 | `input`（条件可用）/ `output`（动作可写） |
| group | string | 否 | 字段分组名，默认"未分组" |
| unit | string | 否 | 单位显示（岁/元/分），不参与校验 |
| min | number | 否 | 数值型下界（含） |
| max | number | 否 | 数值型上界（含） |
| enum | string[] | 否 | 枚举值域；String 类型可选配，配后输入必须在列表内 |
| control | enum | 否 | `text` / `number` / `select` / `boolean`；默认按 type 推断 |
| description | string | 否 | 字段说明，≤200 字 |

### 3.2 校验规则

- key 全局唯一且符合标识符正则；新增 key 不得与已有 key 冲突。
- `Integer` 不接受小数；`Double` 接受任意有限数。
- `Boolean` 的条件只允许 `==` / `!=`，值为 `true` / `false`。
- `enum` 非空时：String 类型的条件/动作值必须在枚举列表内（空单元格/空值仍表示不限制）。
- `min`/`max` 仅对 Integer/Double 生效；min ≤ max。
- 至少 1 个 input 字段和 1 个 output 字段，否则无法形成有效决策。
- key 一旦被任何已发布资产引用，不允许删除；只允许新增、修改 label/description/group/unit/min/max/enum。type 和 kind 变更视为破坏性变更，必须做影响分析并由 API 返回警告列表。

## 4. DRL 生成契约

`declare RuleInput` 语句从 BOM 动态生成：

```drl
declare RuleInput
    customerAge : Integer
    annualIncome : Double
    creditScore : Integer
    customerType : String
    overdue : Boolean
    riskLevel : String
    reviewRequired : Boolean
    approvedLimit : Double
end
```

字段顺序按 BOM 中 fields 数组顺序。这个 declare 块随 Release 的 DRL 一起冻结，RES 编译时通过 FactType 反射即可获得完整字段表。

## 5. RES 端改造

### 5.1 去除硬编码字段表

`ResServer.java` 删除：
- `List<String> FIELDS` 常量
- `parseFacts` 中的 `switch(key)` 硬编码类型分支

改为在执行时从 `KieBase` 获取 `workbench.RuleInput` 的 `FactType`：

```java
FactType type = session.getKieBase().getFactType("workbench", "RuleInput");
Map<String, Class<?>> fieldTypes = new HashMap<>();
for (FactField field : type.getFactFields()) {
    fieldTypes.put(field.getName(), field.getType());
}
```

- `parseFacts(input, fieldTypes)`：按 FactType 声明的类型做 coerce（Integral→Integer, Fractional→Double, Boolean→Boolean, String→String），未知 key 拒绝。
- 执行后收集输出：遍历 `fieldTypes.keySet()`（而不是硬编码 FIELDS），从 fact 读取非 null 值。

这样 Release 里 DRL 的 declare 块就是唯一的字段真相，Team Server 和 RES 之间不需要同步 BOM。

### 5.2 兼容性

- 已部署的旧 Release DRL 里本来就有 declare RuleInput，反射逻辑对它们同样生效，无需数据迁移。
- RES 不重启更新代码后，重启时 `loadDeployments()` 会重新编译已持久化的 Release，反射逻辑自动生效。

## 6. Team Server API

### `GET /api/bom`

返回当前 BOM 完整 JSON。

### `PUT /api/bom`

请求体为完整 BOM（不含 version/updatedAt，由服务端维护）。处理流程：

1. 校验 BOM 结构（见 §3.2）。
2. 做影响分析：对比旧 BOM，找出
   - 被删除的 key（若被已发布资产引用，返回 400 拒绝）；
   - type/kind 变更的 key（返回 200 但在响应 `warnings` 中列出引用资产）；
   - enum 收缩导致已有规则值越界的（同样警告）。
3. 原子写入 `data/bom.json`，version+1，更新 updatedAt。

响应：

```json
{
  "bom": { "...": "..." },
  "warnings": [
    "字段 creditScore 的枚举收缩将影响已发布规则「高风险客户人工复核」"
  ]
}
```

### 影响分析范围

- 扫描所有 rules.json / tables.json 中草稿与已发布资产的 conditions/actions/rows，收集引用的 field key。
- MVP 阶段不做跨资产全局重编译；警告即可，不阻塞保存。

## 7. 文件改动清单

| 文件 | 改动 |
|---|---|
| `shared/bom.js`（新建） | 默认 BOM、`validateBom`、`findField`、`defaultBom()` |
| `data/bom.json`（新建） | 从现有 8 个字段迁移，带分组和枚举 |
| `shared/rules.js` | `validateRule`/`generateDrl`/`parseValue` 接受可选 `bom` 参数；删除模块级 `fields` 常量，改为从 bom.js 导入默认值 |
| `shared/assets.js` | `validateTable`/`tableRules`/`parseConditionCell` 接受可选 `bom` 参数 |
| `shared/releases.js` | `buildRelease` 接受 `bom` 并传入下游 |
| `server/index.js` | 启动加载 `data/bom.json`；新增 `GET/PUT /api/bom`；`parseFacts` 用动态 BOM；流程轨迹收集输出用动态 BOM |
| `res/ResServer.java` | 删除 FIELDS 常量和 switch；从 FactType 反射字段类型 |
| `src/main.jsx` | 新增"BOM 字段管理"面板；`inputFields`/`outputFields` 改为从 `/api/bom` 获取 |
| `test/bom.test.js`（新建） | BOM 校验、影响分析、动态 generateDrl |
| `test/api.test.js` | 增加 `/api/bom` 用例 |

## 8. 不在本期范围

- 多决策服务各自维护独立 BOM（当前全局单 BOM）。
- BOM 版本审批流（当前直接覆盖，version 单调递增）。
- BOM 变更后自动重编译受影响的已发布资产（仅警告，不自动发布）。
- Date/DateRange 类型（本期只支持 Integer/Double/String/Boolean）。
- 字段级脱敏、单位换算。
