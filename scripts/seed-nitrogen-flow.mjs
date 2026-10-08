#!/usr/bin/env node
/**
 * 粮库自动充氮控制 —— 规则集种子脚本
 * ------------------------------------------------------------
 * 前置：三张决策表必须已发布（规则集的步骤只接受已发布资产）。
 *       若未发布，先运行 seed-nitrogen-control.mjs。
 *
 * 规则集拓扑（依据 docs/nitrogen-auto-fill-asset-design.md §4）：
 *
 *   [公共步骤] 充氮状态迁移表  ──► [排他网关 endReached] ──true──► [充氮结束处理表]
 *                                                    └──false─► [充氮设备态表]（默认分支）
 *
 * 本脚本只创建草稿并调用 compile 校验；**发布**留给页面（治理动作）。
 *
 * 用法：
 *   node seed-nitrogen-flow.mjs
 *   node seed-nitrogen-flow.mjs --project project-63dbe140
 */

const RTS_URL = (process.env.RTS_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const DEFAULT_PROJECT = 'project-63dbe140';
const argProject = (() => {
  const i = process.argv.indexOf('--project');
  return i >= 0 ? process.argv[i + 1] : DEFAULT_PROJECT;
})();

const PACKAGE = 'nitrogen';
const FLOW_NAME = '自动充氮控制规则集';

async function call(method, path, body) {
  const response = await fetch(`${RTS_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${parsed?.error || parsed?.raw || text}`);
  return parsed;
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);

const log = (...a) => console.log(...a);

async function main() {
  log(`Team Server: ${RTS_URL}`);
  log(`项目: ${argProject}\n`);

  const assets = await get(`/api/projects/${argProject}/rules`);
  const findTable = name => {
    const asset = assets.find(a => a.name === name);
    if (!asset) throw new Error(`找不到决策表「${name}」`);
    if (asset.status !== 'published') throw new Error(`决策表「${name}」尚未发布（当前 ${asset.status}），请先运行 seed-nitrogen-control.mjs`);
    return asset;
  };
  const tableA = findTable('充氮状态迁移表');
  const tableB = findTable('充氮结束处理表');
  log(`主状态迁移表 ${tableA.id}`);
  log(`结束处理表   ${tableB.id}\n`);

  // ---- 找到或创建规则集 ----
  const flows = await get(`/api/projects/${argProject}/flows`);
  let flow = flows.find(f => f.name === FLOW_NAME || f.flowName === FLOW_NAME);
  if (flow) {
    log(`规则集已存在：${flow.id ?? flow.flowId}`);
  } else {
    flow = await post(`/api/projects/${argProject}/flows`);
    log(`创建规则集：${flow.id ?? flow.flowId}`);
  }
  const flowId = flow.id ?? flow.flowId;

  const draft = {
    name: FLOW_NAME,
    description: '充氮控制主链路（两个公共步骤，无网关）。①「充氮状态迁移表」完成迁移判定并输出 4 路设备指令；②「充氮结束处理表」仅在 endReached=true 时命中，覆盖为 COMPLETED + 全关设备；未到结束时间时该步骤不命中，第①步输出原样生效。'
      + ' 说明：设备指令必须由迁移表同行给出——平台不允许输出字段回填输入，后续步骤若按 phase 选行会读到迁移前的阶段。',
    steps: [
      { id: tableA.id, type: 'table', nodeId: 'step-migrate' },
      { id: tableB.id, type: 'table', nodeId: 'step-end' },
    ],
    branches: [],
    editor: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  };

  const detail = await get(`/api/projects/${argProject}/flows/${flowId}`);
  const revision = detail.revision ?? 1;
  const saved = await put(`/api/projects/${argProject}/flows/${flowId}`, { revision, draft });
  const savedRevision = saved.revision ?? revision + 1;
  log(`草稿已保存（revision ${revision} → ${savedRevision}）`);

  // ---- 编译校验（走真实 Drools Build Service）----
  const compiled = await post(`/api/projects/${argProject}/flows/${flowId}/compile`, { revision: savedRevision });
  log(`编译：${compiled?.ok === false ? '失败' : '通过'}${compiled?.version ? `（Drools ${compiled.version}）` : ''}`);
  if (compiled?.steps) {
    for (const step of compiled.steps) log(`  · ${step.name ?? step.nodeId}`);
  }

  log(`
▸ 下一步（必须人工在页面完成）：
    ① 打开 http://127.0.0.1:5173/projects/${argProject}/assets
    ② 选中规则集「${FLOW_NAME}」→ 提交审核 → 审核页「批准并发布」
    ③ 到「发布」页创建 Release（会触发真实编译门禁），再部署到 local/RES
`);
  log(`FLOW_RESULT=${JSON.stringify({ projectId: argProject, flowId, revision: savedRevision, assets: { a: tableA.id, b: tableB.id } })}`);
}

main().catch(error => {
  console.error(`\n✗ 规则集种子失败：${error.message}`);
  process.exit(1);
});
