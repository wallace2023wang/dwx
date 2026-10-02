# 测试分析设计：参数化、版本对比与覆盖率

## 1. 目标

在现有项目级测试套件上补齐三类分析能力：

1. 一个业务场景可配置多组参数，复用相同断言批量执行。
2. 同一套参数可并行执行两个已发布版本，识别行为变化、改善和回归。
3. 常规运行和版本对比均返回规则、决策表行或规则流路径覆盖率。

功能只执行 Team Server 已保存的不可变发布版本，不接受浏览器上传 DRL，也不改变 RES 的生产执行契约。

## 2. 数据模型

测试案例保留现有 `facts` 作为基础输入，新增可选参数行：

```json
{
  "id": "age-boundary",
  "name": "年龄边界",
  "enabled": true,
  "facts": { "creditScore": 700 },
  "parameters": [
    { "id": "minor", "name": "17 岁", "facts": { "customerAge": 17 } },
    { "id": "adult", "name": "18 岁", "facts": { "customerAge": 18 } }
  ],
  "expected": { "outputs": { "riskLevel": "中" }, "fired": [] }
}
```

- 实际输入为 `{...case.facts, ...parameter.facts}`。
- 没有 `parameters` 时保持原有单案例语义。
- 参数 ID 在案例内唯一；参数覆盖只能使用 BOM 输入字段。
- 每个案例最多 100 个参数行，每套展开后最多执行 1000 次。
- 报告保留 `parentCaseId`、`parameterId` 和 `parameterName`，便于前端回溯业务场景。

## 3. 覆盖率

覆盖率属于一次报告，不写回规则资产：

| 目标 | 覆盖项 | 命中依据 |
|---|---|---|
| 规则 | 当前发布版本规则 | Drools `fired` 非空 |
| 决策表 | 所有启用行，包括默认行 | `decisionTrace[].rowIndex` |
| 规则流 | 所有分支；无线性分支时为主路径 | 执行结果 `path.branchId` 或完整线性执行 |

报告结构包含 `kind`、`hit`、`total`、`percentage` 和稳定的 `items[]`。覆盖率只表示测试执行触达，不代替断言通过率。

## 4. 版本对比

接口：

```text
POST /api/projects/{projectId}/tests/{suiteId}/compare
POST /api/test-suites/{suiteId}/compare
```

请求体：

```json
{ "baseVersion": 1, "candidateVersion": 2 }
```

两个版本必须属于套件绑定的同一项目和同一资产。未指定时，候选版本取最新版本，基线取候选版本的前一版本。少于两个版本时返回 `400`。

每个展开后的参数行分类为：

- `unchanged`：输出、命中规则、路径和断言状态一致。
- `changed`：行为不同，但两个版本断言状态相同。
- `improved`：基线未通过、候选通过。
- `regressed`：基线通过、候选未通过。

所有非 `unchanged` 行计入 `reviewRequired`。比较报告写入现有 `test_runs` 历史，但不替换 `lastRun`，Release 门禁仍会实时执行候选最新版本。

## 5. 前端

- 套件编辑器支持添加参数行，每行使用 BOM 类型控件编辑覆盖值。
- 常规运行结果上方显示覆盖率和未覆盖项。
- 有两个及以上发布版本时显示“版本对比”，默认比较最近两个版本。
- 对比结果显示四类数量、逐参数行为变化和两个版本各自覆盖率。
- 业务用户不填写 JSON、DRL 或内部节点地址。

## 6. 验收

1. 参数行正确合并基础输入并形成独立报告行。
2. 参数和展开总量限制返回明确的 `400`。
3. 三类目标覆盖项计算稳定，未命中项可定位。
4. 比较能识别改善、回归和待确认变化，且不覆盖常规 `lastRun`。
5. 项目隔离、乐观锁、审计和 PostgreSQL 持久化继续成立。
6. 桌面与 390px 移动视口无页面级横向溢出。
