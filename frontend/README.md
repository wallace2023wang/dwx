# DWX Frontend

Rule Team Server 新版 React 前端。当前完成 Sprint 1-3：登录、全局顶栏、决策服务库、项目资产三栏工作区、Monaco 只读 DRL 编辑器、决策表网格，以及 BOM/业务词汇和自动生成 DRL 预览。数据由 `src/api/` 的 TanStack Query mock 提供。

## 开发

```bash
npm install
npm run dev
```

默认访问 `http://127.0.0.1:5173`，`/api` 代理到 `http://localhost:8787`。

## 检查

```bash
npm run lint
npm run build
```

技术栈固定为 React 18、Vite 5、TypeScript strict、React Router 6、Tailwind CSS 3、Zustand、TanStack Query、axios、lucide-react 和 Monaco Editor。Monaco 使用本地 worker 并按需加载，不依赖 CDN。
