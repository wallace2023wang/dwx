# DWX 资产包格式

## 1. 首版边界

DWX 通过版本化 JSON 资产包在项目之间迁移结构化规则资产。导入采用“预览 -> 确认”两阶段：预览验证 BOM、规则结构、包层级、同名冲突和来源标识；确认后创建未发布草稿，不自动提交审核、发布、构建 Release 或部署。

首版支持：

- 来源项目名称与版本留痕。
- Package 层级创建或复用。
- BAL 规则、决策表、决策树、计分卡和规则模板的结构化草稿。
- 规则集按规则包映射为 DWX 规则集中的 Rule Group 步骤。
- `sourceId` + 清单 checksum 幂等判断；重复导入完全相同的来源对象时跳过，内容变化时拒绝自动覆盖并要求人工合并或使用新来源版本标识。

首版只读取本文定义的结构化 JSON，不直接读取外部平台专有压缩包、工程文件、自由 IRL/DRL、Java/XOM 字节码或二进制归档。其他输入必须先转换为本文资产包；无法安全映射的构件会在预览阶段报错，不静默降级。

## 2. 清单结构

```json
{
  "format": "dwx-asset-package",
  "schemaVersion": 1,
  "project": { "name": "贷款决策项目", "version": "1.0.0" },
  "packages": [
    { "name": "asset_import", "label": "导入资产" }
  ],
  "assets": [
    {
      "sourceId": "rule/adult-customer",
      "type": "bal",
      "name": "成年客户",
      "package": "asset_import",
      "draft": {
        "name": "成年客户",
        "description": "导入的 BAL 规则",
        "category": "asset_import",
        "priority": 0,
        "conditions": [{ "field": "customerAge", "operator": ">=", "value": "18" }],
        "actions": [{ "field": "riskLevel", "value": "低" }]
      }
    }
  ],
  "rulesets": [
    { "sourceId": "ruleset/eligibility", "name": "准入决策服务", "packages": ["asset_import"] }
  ]
}
```

资产 `type` 接受以下值及别名：

| 目标资产 | `type` |
|---|---|
| BAL 规则 | `rule`、`bal` |
| 决策表 | `decision-table`、`table` |
| 决策树 | `decision-tree`、`tree` |
| 计分卡 | `scorecard` |
| 规则模板 | `rule-template`、`template` |

`draft` 使用 DWX 对应资产的结构化草稿格式，并由现有领域校验器执行与人工创建相同的校验。顶层 `name` 与 `package` 是迁移映射的权威值，会覆盖 `draft.name` 和 `draft.category`。

## 3. API

- 导出：`GET /api/projects/:projectId/exports/dwx`，返回当前项目可移植资产包。
- 预览：`POST /api/projects/:projectId/imports/dwx`，请求 `{ "mode": "preview", "manifest": ... }`。
- 确认：同一路径，请求 `{ "mode": "import", "manifest": ..., "checksum": "sha256:..." }`。

确认阶段会在项目写锁内重新分析当前资产与清单；预览后发生同名冲突时返回 `409 IMPORT_PREVIEW_STALE`，调用方必须重新预览。

## 4. 导入后流程

导入对象全部处于草稿状态。业务人员需要逐项检查中文业务说明和 BOM 映射，完成编译，再按正常变更集流程提交审核、发布资产、发布规则集并构建 Release。Ruleset 只有在其 Rule Group 中的资产完成发布后才能编译和发布。
