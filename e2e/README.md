# 规则工作台 E2E 页面验收测试

对 http://127.0.0.1:5180 的「规则工作台」做页面级全面测试与验收的程序。共 **32 个用例**，覆盖全部 13 个路由、全部 7 个项目的代表页面，以及一条跨页完整业务链路（建规则 → 审核 → 发布 → RES 部署）。

## 运行前提

- 前端 dev server 运行在 `http://127.0.0.1:5180`（Vite）
- 后端 API 运行在 `http://127.0.0.1:8789`（Team Server，JSON 存储）
- Build Service `8788`、RES `8790` 健康（发布链路需要）
- 本机装有 Chrome（测试复用系统 Chrome，无需下载浏览器内核）

## 安装与运行

```bash
cd /Users/wallace/project/rules/e2e
npm install        # 已装则跳过
npx playwright test                       # 跑全部 32 个用例
npx playwright test --grep "smoke"        # 只跑冒烟层
npx playwright test tests/flow-e2e.spec.js  # 只跑完整链路
```

## 数据安全机制

- **测试前**：`globalSetup` 自动备份 `data/` 目录到 `e2e/.data-backup/`
- **测试后**：`globalTeardown` 自动恢复 `data/` 原状（已校验与备份逐文件一致）
- 测试创建的临时规则、审核、Release 均会在结束时清除

## 测试分层

| 层 | 用例数 | 内容 |
|---|---|---|
| 冒烟 Smoke | 16 | 全部 13 个路由 + CEP/Drools 代表页：渲染不白屏、无 JS 未捕获异常 |
| 功能 Feature | 12 | 库/浏览/管理/资产/规则集/BOM/测试套件/审核/发布向导/报告下载/CEP 事件流，逐个点击按钮、Tab、对话框、编辑器 |
| 链路 E2E | 4 | 新建规则 → 保存 → 提交审核 → 批准 → 构建 Release → 编译 → 部署 RES → 验证发布结果 |

## 产物

| 产物 | 位置 |
|---|---|
| 验收报告（自包含 HTML，内嵌截图） | `e2e/output/acceptance-report.html` |
| 每步截图 | `e2e/output/screenshots/<用例ID>/` |
| 页面功能清单（探索脚本生成） | `e2e/output/explore-pages.json`、`e2e/output/explore/*.png` |
| 原始结果 | `e2e/output/results.ndjson` |

## 测试发现的问题（2026-10-02 运行，32/32 通过）

以下问题不影响用例通过，但值得修复：

1. **浏览页（/explore）**：对 CEP 项目（`project-6f50ddcf`、`project-7c12c971`）请求 `GET /api/projects/{id}/flows` 返回 **404**——CEP 项目没有规则集资源，前端不应请求该接口。
2. **规则集校验**：对 `default` 项目规则集 `899825a4...` 执行校验时 `POST .../compile` 返回 **400**——需人工确认该规则集草稿当前的编译错误原因。

## 文件结构

```
e2e/
├── playwright.config.js     # Playwright 配置（复用本机 Chrome）
├── helpers/
│   ├── global-setup.js      # 备份 data + 登录保存 session
│   ├── global-teardown.js   # 恢复 data + 生成验收报告
│   ├── collect.js           # console/HTTP/异常收集器
│   ├── auth-init.js         # 登录态注入（sessionStorage）
│   └── report.js            # 验收报告 HTML 生成器
├── scripts/explore.js       # 页面功能清单探索脚本
└── tests/
    ├── common.js            # 公共工具
    ├── smoke.spec.js        # 冒烟层 16 用例
    ├── features-global.spec.js  # 库/浏览/管理/主页 4 用例
    ├── features-project.spec.js # 项目页 7 用例
    ├── features-cep.spec.js     # CEP 事件流 1 用例
    └── flow-e2e.spec.js     # 完整链路 4 用例
```
