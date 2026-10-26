# 1k/5k/10k 容量基准

容量专项用于记录规则资产规模从 1,000、5,000 到 10,000 条时的设计时和运行时表现。它是独立的基准工具，不会读取或改写仓库中的 `data/`，每个档位都会在临时目录生成完整 JSON 数据集，并在报告中保留真实的成功、跳过、拒绝和失败状态。

## 覆盖范围

每个档位记录以下指标：

- Team Server 项目和规则包 API 的 P95 响应时间及响应体大小；
- 浏览器资产列表首次可交互时间、实际渲染行数和搜索交互时间；
- 决策表与规则组 DRL 生成时间和制品大小；
- Drools Build Service 启动、决策表编译和规则组编译时间，以及容器近似峰值内存；
- RES 启动、部署、激活时间，热执行 P50/P95/P99，以及容器近似峰值内存。

完整档位默认执行：

```bash
npm run benchmark:capacity
```

快速烟测只执行 1,000 档并减少 API、编译和热执行样本：

```bash
npm run benchmark:capacity:quick
```

常用选项：

```bash
# 只跑指定档位
node benchmarks/capacity/run.mjs --sizes=1000,5000

# 不启动浏览器或 Drools/RES 容器，用于验证 Node/Team Server 数据路径
node benchmarks/capacity/run.mjs --skip-browser --skip-runtime

# 保留临时数据集，便于复盘某个档位
node benchmarks/capacity/run.mjs --sizes=1000 --keep-temporary
```

需要 Node.js 20+、Docker，以及 `frontend/` 依赖和可用的 Chromium。runner 优先使用 Playwright 管理的 Chromium，不存在时回退到常见路径下的系统 Chrome/Chromium，也可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 显式指定。若浏览器或 Docker 不可用，runner 会在该档位报告 `skipped`/`failed`，不会把缺失指标当成通过。

报告写入 `benchmarks/capacity/results/`，包括带时间戳的 JSON/Markdown 和覆盖用的 `latest.json`、`latest.md`。报告中的验收判断只是当前机器上的工程基线，不等同于 PostgreSQL、生产硬件或正式容量承诺；目标未达到时结论会明确标记为失败。

## 容量边界

决策表最多 10,000 行。启用行不超过 500 行时，保存/编译前继续执行同步的精确重叠、不可达和缺口分析；超过 500 个启用行时仍执行全部逐行字段、单元格和动作校验，但跳过同步二次方分析并返回警告，完整分析应由后续离线任务承担。

为支持大制品，Build Service 使用以下环境变量（服务启动时读取并夹在安全范围内）：

- `ENGINE_MAX_BODY_BYTES`：请求体上限，默认 16 MiB，允许范围 256 KiB–64 MiB；
- `ENGINE_MAX_DRL_CHARS`：单次 DRL 字符上限，默认 12 MiB，允许范围 200,000–48 MiB；
- `RES_MAX_BODY_BYTES`：RES 请求体上限，默认 16 MiB，允许范围 2 MiB–64 MiB。
- `RES_MAX_DRL_CHARS`：RES 单步 DRL 字符上限，默认 12 MiB，允许范围 200,000–48 MiB；
- `RES_MAX_TOTAL_DRL_CHARS`：RES 一个 Release 的 DRL 总字符上限，默认 48 MiB，允许范围 1–96 MiB；

这些上限只解决基准档位所需的制品传输和解析空间，不代表已经完成并发、超时、熔断、资源配额或生产容量治理。上述 M4 运行治理任务继续后移。
