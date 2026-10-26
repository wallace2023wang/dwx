# 前端 React 化开工指令（给 Codex）

> 配套原型：`docs/design-rts/rts-prototype.html`（浏览器直接打开对照）
> 配套设计文档：`docs/rts-ui-design.md`

## 0. 硬约束

- **不要自由发挥 UI**：每个组件对照原型截图，颜色/间距/布局偏差不超过 2px
- **不要引入未在下面列出的库**：状态管理、路由、UI 库一律用指定的
- **RuleFlow 画布必须用 React Flow**，禁止手写 SVG
- **BAL 编辑器第一版用 Monaco 纯文本**，不做术语高亮联动
- TypeScript strict 模式，props 全标类型

## 1. 技术栈

| 用途 | 选型 |
|---|---|
| 构建 | Vite 5 + React 18 + TypeScript |
| 路由 | React Router v6 |
| 样式 | Tailwind CSS 3（设计 token 见 §4） |
| 状态 | Zustand（全局：当前项目/当前 Ruleset/用户会话） |
| 数据请求 | TanStack Query v5 |
| RuleFlow 画布 | @xyflow/react (React Flow 12) |
| 代码编辑器 | Monaco Editor（先当 DRL 编辑器） |
| HTTP | axios，baseURL `/api`，走 vite proxy |
| 图标 | lucide-react（不要 emoji） |

## 2. 目录结构

```
frontend/
├── index.html
├── vite.config.ts          # proxy /api -> localhost:8787
├── tailwind.config.ts       # 设计 token
├── src/
│   ├── main.tsx
│   ├── App.tsx              # 路由根
│   ├── routes/
│   │   ├── Login.tsx
│   │   ├── Home.tsx         # 主页
│   │   ├── Library.tsx      # 库（项目列表）
│   │   ├── Explore.tsx      # 浏览/治理
│   │   ├── Admin.tsx        # 管理
│   │   └── project/
│   │       ├── ProjectShell.tsx   # 项目头 + 5 Tab
│   │       ├── AssetsTab.tsx     # 三栏工作区
│   │       ├── FlowTab.tsx       # Ruleset 配置 + RuleFlow 画布
│   │       ├── BomTab.tsx        # BOM/词汇
│   │       ├── TestsTab.tsx      # 测试套件
│   │       └── ReleasesTab.tsx   # 发布历史 + 构建向导
│   ├── components/
│   │   ├── layout/TopBar.tsx
│   │   ├── layout/ProjectTabs.tsx
│   │   ├── assets/PackageTree.tsx
│   │   ├── assets/AssetList.tsx
│   │   ├── assets/BalEditor.tsx
│   │   ├── flow/RulesetConfig.tsx
│   │   ├── flow/FlowCanvas.tsx   # React Flow
│   │   └── releases/ReleaseWizard.tsx
│   ├── store/               # zustand
│   │   ├── session.ts
│   │   └── project.ts
│   ├── api/                 # tanstack query hooks
│   │   ├── projects.ts
│   │   ├── rules.ts
│   │   ├── bom.ts
│   │   └── releases.ts
│   └── types/               # TS 类型，和后端共享
└── package.json
```

## 3. API 契约（先按这个 mock，后端对齐）

```
POST   /api/auth/login              {username,password} -> {token,user}
GET    /api/auth/me                 -> {user,roles}

GET    /api/projects                -> Project[]
GET    /api/projects/:id            -> Project
GET    /api/projects/:id/packages   -> PackageTree[]
GET    /api/projects/:id/rules?package=xxx -> Asset[]
GET    /api/projects/:id/rules/:ruleId     -> AssetDetail
PUT    /api/projects/:id/rules/:ruleId     {content,attributes}

GET    /api/projects/:id/bom
PUT    /api/projects/:id/bom

GET    /api/projects/:id/rulesets   -> Ruleset[]
PUT    /api/projects/:id/rulesets/:name

GET    /api/projects/:id/tests      -> TestCase[]
POST   /api/projects/:id/tests/run

GET    /api/projects/:id/releases   -> Release[]
POST   /api/projects/:id/releases   -> {steps:1..5 提交}
POST   /api/projects/:id/releases/:ver/deploy  {env}
```

后端没 ready 前，在 `src/api/` 里写 mock 函数返回类型正确的假数据，接口字段对齐上面。

## 4. 设计 Token（从原型 CSS 抽）

```ts
// tailwind.config.ts
{
  colors: {
    brand: {  // 主色（产品品牌蓝，不绑定任何厂商）
      primary:   '#0f62ff',
      primary-d: '#0043ce',
      primary-l: '#dbeaff',
    },
    ink: {
      1: '#1a1a1a',   // 主文字
      2: '#525252',   // 次文字
      3: '#8c8c8c',   // 弱文字
      border: '#e0e0e0',
      bg: '#f4f4f4',
    },
    env: {
      dev:        '#6a1b9a',  // 紫
      test:       '#1565c0',  // 蓝
      staging:    '#e65100',  // 橙
      production: '#2e7d32',  // 绿
    },
  },
  fontFamily: {
    sans: ['"PingFang SC"', '"Microsoft YaHei"', '"Source Han Sans SC"', 'system-ui'],
    mono: ['"JetBrains Mono"', '"Source Han Mono"', 'Courier New'],
  },
}
```

## 5. Sprint 1 任务（先做这些，跑起来）

**目标**：登录页 + 顶栏 + 库列表 + 点项目进三栏壳，全用 mock 数据。

1. `npm create vite@latest frontend -- --template react-ts`
2. 装依赖：`tailwindcss postcss autoprefixer react-router-dom @tanstack/react-query zustand axios lucide-react`
3. 配 `tailwind.config.ts`（§4 token）
4. 实现：
   - `Login.tsx`：蓝色渐变背景 + 居中白卡片（对照原型登录页）
   - `TopBar.tsx`：深蓝顶栏（#1a1a2e 左右），左 Logo "DW DWX"，中 4 个 tab，右通知+头像
   - `Library.tsx`：项目卡片网格（"个人贷款审批"、"风险评分决策" 两张卡）
   - `ProjectShell.tsx`：项目头 + 5 个 Tab（先只把 Assets 点亮）
   - `AssetsTab.tsx`：三栏布局（Package 树 / 资产列表 / 空编辑器占位），用 mock PKGS 数据
5. vite proxy：`/api -> http://localhost:8787`
6. 跑 `npm run dev`，对照 `rts-prototype.html` 截图核对

**Sprint 1 验收标准**：
- 登录页 → 点登录 → 库页 → 点项目 → 看到三栏布局
- 颜色和原型一致
- 没有控制台报错
- 不引入 §1 以外的库

## 6. 后续 Sprint 预告

| Sprint | 内容 |
|---|---|
| 2 | BAL 编辑器（Monaco 只读）+ 决策表网格 |
| 3 | BOM/词汇 tab + DRL declare 预览 |
| 4 | RuleFlow 画布（React Flow，4 种节点）+ Ruleset 配置卡 |
| 5 | 测试套件表 + Release 5 步向导 |
| 6 | 管理页（用户/角色/环境）+ 接真实 API |

## 7. 禁止事项

- 不要用 Ant Design / Material UI / Element UI（自己写 Tailwind，参考企业级规则平台交互范式）
- 不要 Redux / MobX（Zustand 够）
- 不要 class component
- 不要写死中文文案以外的硬编码（后面要 i18n）
- 不要在组件里 fetch，统一走 `src/api/` hooks
