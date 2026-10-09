const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const formatDate = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const assetStatus = item => item.status || (item.published ? 'published' : 'draft');
const statusLabel = { draft: '草稿', SUBMITTED: '已提交', APPROVED: '已批准', REJECTED: '已驳回', published: '已发布', 'in-review': '审核中', deprecated: '已废弃', archived: '已归档' };
const typeLabel = { rule: '规则', 'decision-table': '决策表', table: '决策表', flow: '规则集', 'event-stream': '事件流' };
const cepTemplateLabel = {
  'single-threshold': '单点阈值',
  'window-average': '窗口均值',
  'window-fluctuation': '窗口波动',
  'event-count': '事件计数',
  'window-sum': '窗口求和',
  absence: '缺席检测',
  'event-sequence': '双事件时序',
  'consecutive-count': '连续次数',
  periodic: '周期触发',
};
const cepModeLabel = { guided: '引导', advanced: 'EPL' };
const hitPolicyLabel = { FIRST: '首个命中', PRIORITY: '按优先级', COLLECT: '收集全部命中', ALL: '全部命中' };
const decisionValuePrefix = /^(>=|<=|!=|==|>|<)/;
const decisionOpLabel = { '>=': '大于等于', '<=': '小于等于', '!=': '不等于', '==': '等于', '>': '大于', '<': '小于' };
const isFlowGraph = flow => Boolean(flow?.graph && Array.isArray(flow.graph.nodes));
const flowGateways = flow => isFlowGraph(flow)
  ? flow.graph.nodes.filter(node => node.type === 'gateway')
  : Array.isArray(flow.gateways)
    ? flow.gateways
    : (flow.branches || []).length
      ? [{ id: 'gateway', name: '排他网关', afterStep: (flow.steps || []).length, branches: flow.branches }]
      : [];

/**
 * 把决策表单元格值格式化成客户可读的中文：
 * 布尔 → 是/否；空 → 空串；">=0.8" → "大于等于 0.8"；"700.." → "700 及以上"；"501..699" → "501 至 699"。
 */
function formatDecisionValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  const text = String(value).trim();
  if (!text) return '';
  if (text === 'true') return '是';
  if (text === 'false') return '否';
  const op = text.match(decisionValuePrefix);
  if (op) return `${decisionOpLabel[op[1]]} ${text.slice(op[1].length).trim()}`;
  const closedRange = text.match(/^([\d.]+)\.\.([\d.]+)$/);
  if (closedRange) return `${closedRange[1]} 至 ${closedRange[2]}`;
  const openStart = text.match(/^([\d.]+)\.\.$/);
  if (openStart) return `${openStart[1]} 及以上`;
  const openEnd = text.match(/^\.\.([\d.]+)$/);
  if (openEnd) return `${openEnd[1]} 及以下`;
  return text;
}

/**
 * 组装决策表报告明细：条件列/动作列中文标签 + 每行条件→动作内容。
 * body 为决策表内容（draft 或 published）。
 */
function decisionTableReportDetail(body = {}, fieldMap) {
  const conditionColumns = (body.conditions || []).map(column => fieldMap.get(column.field)?.label || column.field);
  const actionColumns = (body.actions || []).map(column => fieldMap.get(column.field)?.label || column.field);
  const rows = (body.rows || [])
    .filter(row => row.enabled !== false)
    .map((row, index) => ({
      no: index + 1,
      conditions: (row.conditions || []).map(cell => formatDecisionValue(cell)),
      actions: (row.actions || []).map(cell => formatDecisionValue(cell)),
    }));
  return {
    hitPolicy: hitPolicyLabel[body.hitPolicy] || body.hitPolicy || 'COLLECT',
    conditionColumns,
    actionColumns,
    rows,
  };
}

function eventStreamStatementDetails(item = {}) {
  const statements = item.draft?.statements || item.published?.draft?.statements || [];
  return statements.map(statement => ({
    name: statement.name,
    label: statement.label || statement.name,
    description: statement.description || '',
    mode: statement.mode || (statement.template ? 'guided' : 'advanced'),
    modeLabel: cepModeLabel[statement.mode] || (statement.template ? '引导' : 'EPL'),
    template: statement.template || null,
    templateLabel: cepTemplateLabel[statement.template] || (statement.template ? statement.template : '自定义 EPL'),
  }));
}

function eventStreamModelSummary(item = {}) {
  const details = eventStreamStatementDetails(item);
  if (!details.length) return '无语句';
  return details.map(statement => {
    const title = statement.label === statement.name ? statement.name : `${statement.label}（${statement.name}）`;
    const meta = `${statement.modeLabel} · ${statement.templateLabel}`;
    return statement.description ? `${title} · ${meta}：${statement.description}` : `${title} · ${meta}`;
  }).join('；');
}

function normalizeBom(bom = {}) {
  if (Array.isArray(bom.factTypes)) return bom;
  const facts = new Map();
  for (const field of bom.fields || []) {
    const name = field.factType || 'RuleInput';
    const fact = facts.get(name) || {
      name, label: field.factTypeLabel || name,
      direction: field.kind || field.direction || 'input', fields: [],
    };
    const direction = field.kind || field.direction || 'input';
    fact.fields.push({ ...field, direction });
    if (fact.direction !== direction) fact.direction = 'mixed';
    facts.set(name, fact);
  }
  return { ...bom, factTypes: [...facts.values()] };
}

function latestVersion(item) {
  return item.versions?.at(-1)?.number || item.version || 0;
}

function latestRun(suite) {
  return suite.lastRun || suite.runs?.find(run => run.kind !== 'comparison') || null;
}

export function aggregateReportData(project, data, packages = [], generatedBy = 'Team Server') {
  const rules = data.rules || [];
  const tables = data.tables || [];
  const flows = data.flows || [];
  const eventStreams = data.eventStreams || [];
  const releases = data.releases || [];
  const suites = data.testSuites || [];
  const bom = normalizeBom(data.bom || { version: 0, factTypes: [], fields: [] });
  const assetSource = new Map([...rules, ...tables, ...eventStreams].map(item => [item.id, item]));
  const latestRelease = releases.reduce((latest, release) => Math.max(latest, Number(release.version) || 0), 0);
  const latest = releases.reduce((current, release) => Number(release.version) > Number(current?.version || 0) ? release : current, null);
  const fieldMap = new Map(bom.factTypes.flatMap(fact => fact.fields || []).map(field => [field.key, field]));
  const visiblePackages = packages.map(pkg => ({
    id: pkg.id || pkg.name,
    name: pkg.name,
      label: pkg.label || pkg.name,
      assets: (pkg.assets || []).filter(asset => asset.archived !== true).map(asset => {
        const source = assetSource.get(asset.id);
        const body = source ? (asset.status === 'published' ? source.published || source.draft : source.draft || source.published) : null;
        return {
          ...asset,
          priority: asset.priority ?? source?.draft?.priority ?? 0,
          typeLabel: typeLabel[asset.type] || asset.type,
          statusLabel: statusLabel[asset.status] || asset.status || '草稿',
          description: body?.description || '',
          ...(asset.type === 'event-stream' && source ? { statements: eventStreamStatementDetails(source), model: eventStreamModelSummary(source) } : {}),
          ...(asset.type === 'decision-table' && body ? { tableDetail: decisionTableReportDetail(body, fieldMap) } : {}),
        };
      }),
  }));
  if (eventStreams.length) {
    visiblePackages.push({
      id: 'event-streams',
      name: 'event-streams',
      label: '事件流',
      assets: eventStreams.filter(item => item.archived !== true).map(item => ({
        id: item.id,
        name: item.draft?.name || item.id,
        type: 'event-stream',
        typeLabel: '事件流',
        status: assetStatus(item),
        statusLabel: statusLabel[assetStatus(item)] || assetStatus(item),
        version: latestVersion(item),
        priority: '—',
        statements: eventStreamStatementDetails(item),
        model: eventStreamModelSummary(item),
      })),
    });
  }
  const fields = bom.factTypes.flatMap(fact => fact.fields || []);
  const fieldTypeStats = Object.fromEntries(fields.reduce((counts, field) => {
    const key = field.type || '未定义';
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map()));
  const directionStats = Object.fromEntries(fields.reduce((counts, field) => {
    const key = field.direction || 'mixed';
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map()));
  const assetNames = new Map([...rules, ...tables].map(item => [item.id, item.draft?.name || item.id]));
  const flowReports = flows.map(flow => {
    const source = flow.published && typeof flow.published === 'object' ? flow.published : (flow.draft || {});
    const gateways = flowGateways(source);
    const branches = gateways.flatMap(gateway => (gateway.branches || []).map(branch => ({ ...branch, gatewayName: gateway.name })));
    const parallelNodes = isFlowGraph(source) ? source.graph.nodes.filter(node => node.type === 'parallel') : [];
    const steps = isFlowGraph(source)
      ? source.graph.nodes.filter(node => node.type === 'step').map((node, index) => ({ ...node.step, branchName: '图节点', order: index + 1 }))
      : [
          ...(source.steps || []).map((step, index) => ({ ...step, branchName: null, order: index + 1 })),
          ...branches.flatMap(branch => (branch.steps || []).map((step, index) => ({ ...step, branchName: gateways.length > 1 ? `${branch.gatewayName} / ${branch.name}` : branch.name, order: index + 1 }))),
        ];
    return {
      id: flow.id,
      name: source.name || flow.draft?.name || flow.id,
      status: flow.published ? '已发布' : '草稿',
      version: latestVersion(flow),
      stepCount: steps.length,
      branchCount: branches.length + parallelNodes.reduce((total, node) => total + node.branches.length, 0),
      parallelCount: parallelNodes.length,
      joinCount: isFlowGraph(source) ? source.graph.nodes.filter(node => node.type === 'join').length : 0,
      hitPolicy: source.hitPolicy || '—',
      steps: steps.map(step => ({
        order: step.order,
        branchName: step.branchName,
        type: typeLabel[step.type] || step.type,
        id: step.id,
        name: step.name || assetNames.get(step.id) || step.id,
        version: step.version || '—',
      })),
    };
  });
  const testReports = suites.filter(suite => !suite.archived).map(suite => {
    const run = latestRun(suite);
    const total = run?.total ?? run?.cases?.length ?? 0;
    const passed = run?.passedCount ?? run?.cases?.filter(testCase => testCase.passed).length ?? 0;
    const failed = run?.failedCount ?? Math.max(0, total - passed);
    return {
      id: suite.id,
      name: suite.name,
      targetName: suite.targetName || suite.target?.id || '—',
      targetType: typeLabel[suite.target?.type] || suite.target?.type || '—',
      required: Boolean(suite.required),
      total, passed, failed,
      passRate: total ? Math.round((passed / total) * 1000) / 10 : null,
      coverage: run?.coverage || null,
      runAt: run?.runAt || null,
    };
  });
  const environmentNames = [...new Set(releases.flatMap(release => (release.deployments || [])
    .filter(deployment => deployment.status !== 'stopped')
    .map(deployment => deployment.environment)))];
  const overview = {
    assetCount: rules.length + tables.length + eventStreams.length,
    ruleCount: rules.length, tableCount: tables.length,
    packageCount: visiblePackages.length, factTypeCount: bom.factTypes.length,
    fieldCount: fields.length, testPassRate: testReports.length
      ? Math.round((testReports.filter(test => test.passRate === 100).length / testReports.length) * 1000) / 10 : null,
    releaseVersion: latestRelease || null, environmentCount: environmentNames.length,
    environments: environmentNames, updatedAt: project.updatedAt, updatedBy: project.updatedBy,
  };
  if (eventStreams.length) overview.eventStreamCount = eventStreams.length;
  return {
    meta: {
      generatedAt: new Date().toISOString(), generatedBy,
      bomVersion: bom.version || 0, releaseVersion: latestRelease || null,
      decisionService: latest?.decisionService || `${project.id}/未发布`,
      dataVersion: `BOM v${bom.version || 0} / Release ${latestRelease ? `v${latestRelease}` : '—'}`,
    },
    overview,
    bom: { factTypes: bom.factTypes.map(fact => ({ name: fact.name, label: fact.label, direction: fact.direction, fieldCount: fact.fields?.length || 0 })), fieldTypeStats, directionStats },
    assets: visiblePackages,
    flows: flowReports,
    tests: testReports,
    eventStreams: eventStreams.filter(item => !item.archived).map(item => ({
      id: item.id,
      name: item.draft?.name || item.id,
      version: latestVersion(item),
      statements: eventStreamStatementDetails(item),
    })),
    releases: releases.map(release => ({
      id: release.id, version: release.version, name: release.name, description: release.description,
      decisionService: release.decisionService, qualityGate: release.qualityGate || null,
      createdBy: release.createdBy || 'Team Server', createdAt: release.createdAt,
      checksum: release.checksum, deployments: release.deployments || [],
    })),
  };
}

function cell(value, className = '') {
  return `<td class="${className}">${escapeHtml(value ?? '—')}</td>`;
}

function section(number, title, content) {
  return `<section class="section"><h2><span>${number}</span>${escapeHtml(title)}</h2>${content}</section>`;
}

export function renderProjectReport(project, data, packages = [], generatedBy = 'Team Server') {
  const report = aggregateReportData(project, data, packages, generatedBy);
  const kpis = [
    ['资产总数', report.overview.assetCount], ['规则', report.overview.ruleCount], ['决策表', report.overview.tableCount],
    ['测试套件通过率', report.overview.testPassRate == null ? '—' : `${report.overview.testPassRate}%`],
    ['最新发布', report.overview.releaseVersion ? `v${report.overview.releaseVersion}` : '—'], ['部署环境', report.overview.environmentCount],
  ];
  const bomRows = report.bom.factTypes.map(fact => `<tr>${cell(fact.name)}${cell(fact.label)}${cell(fact.direction)}${cell(fact.fieldCount)}</tr>`).join('') || `<tr><td colspan="4" class="empty">暂无事实类型</td></tr>`;
  const typeStats = Object.entries(report.bom.fieldTypeStats).map(([type, count]) => `<span class="stat"><b>${escapeHtml(count)}</b>${escapeHtml(type)}</span>`).join('') || '<span class="muted">暂无字段</span>';
  const assetGroups = report.assets.map(pkg => {
    const assetRows = pkg.assets.flatMap(asset => {
      const summaryRow = `<tr>${cell(asset.name, 'col-name')}${cell(asset.typeLabel)}${cell(asset.statusLabel, `status ${asset.status}`)}${cell(asset.version)}${cell(asset.priority ?? '—')}${cell(asset.type === 'event-stream' ? asset.model || '—' : asset.description || '—', 'col-desc')}${asset.bomInvalid ? '<td><span class="warning">BOM 失效</span></td>' : cell('正常')}</tr>`;
      const detail = asset.tableDetail
        ? `<tr class="dt-row"><td colspan="7"><div class="dt-detail"><div class="dt-head"><b>决策表内容</b><span>命中策略：${escapeHtml(asset.tableDetail.hitPolicy)}</span></div><p class="dt-cols">条件列：${escapeHtml(asset.tableDetail.conditionColumns.join('、'))}　·　动作列：${escapeHtml(asset.tableDetail.actionColumns.join('、'))}</p>${
            asset.tableDetail.rows.length
              ? `<table><thead><tr><th style="width:34px">#</th><th>条件</th><th>动作</th></tr></thead><tbody>${asset.tableDetail.rows.map(row => `<tr>${cell(row.no)}<td class="dt-cond">${row.conditions.map((value, index) => value ? `${escapeHtml(asset.tableDetail.conditionColumns[index] || '')} ${escapeHtml(value)}` : '').filter(Boolean).join('；') || '—'}</td><td class="dt-action">${row.actions.map((value, index) => value ? `${escapeHtml(asset.tableDetail.actionColumns[index] || '')} = ${escapeHtml(value)}` : '').filter(Boolean).join('；') || '—'}</td></tr>`).join('')}</tbody></table>`
              : '<p class="empty">无启用行</p>'
          }</div></td></tr>`
        : '';
      return [summaryRow, detail];
    }).join('');
    return `<div class="asset-group"><h3>${escapeHtml(pkg.label)} <small>${escapeHtml(pkg.name)}</small></h3>${pkg.assets.length ? `<table><thead><tr><th>资产名称</th><th>类型</th><th>状态</th><th>版本</th><th>优先级</th><th>中文描述</th><th>BOM</th></tr></thead><tbody>${assetRows}</tbody></table>` : '<p class="empty">（空）</p>'}</div>`;
  }).join('') || '<p class="empty">暂无规则资产</p>';
  const eventStreamRows = report.eventStreams.flatMap(stream => stream.statements.map(statement => `<tr>${cell(stream.name)}${cell(statement.label)}${cell(statement.name)}${cell(statement.modeLabel)}${cell(statement.templateLabel)}${cell(statement.description || '—')}</tr>`)).join('') || '<tr><td colspan="6" class="empty">暂无事件流检测语句</td></tr>';
  const flowBlocks = report.flows.map(flow => `<div class="flow"><div class="flow-head"><b>${escapeHtml(flow.name)}</b><span>${escapeHtml(flow.status)} · v${escapeHtml(flow.version)} · ${flow.stepCount} 步骤 · ${flow.branchCount} 分支</span></div>${flow.steps.length ? `<ol>${flow.steps.map(step => `<li><b>${step.order}.</b> ${escapeHtml(step.name)} <span>${escapeHtml(step.type)} · ${escapeHtml(step.id)} · v${escapeHtml(step.version)}${step.branchName ? ` · 分支：${escapeHtml(step.branchName)}` : ''}</span></li>`).join('')}</ol>` : '<p class="empty">暂无步骤</p>'}</div>`).join('') || '<p class="empty">暂无规则集</p>';
  const testRows = report.tests.map(test => `<tr>${cell(test.name)}${cell(`${test.targetType} · ${test.targetName}`)}${cell(test.required ? '是' : '否')}${cell(test.total ? `${test.total} / ${test.passed} / ${test.failed}` : '未运行')}${cell(test.passRate == null ? '—' : `${test.passRate}%`)}${cell(test.coverage ? `${test.coverage.percentage}%` : '—')}${cell(formatDate(test.runAt))}</tr>`).join('') || '<tr><td colspan="7" class="empty">暂无测试套件</td></tr>';
  const releaseRows = report.releases.map(release => `<tr>${cell(`v${release.version}`)}${cell(release.name)}${cell(release.decisionService)}${cell(release.qualityGate ? (release.qualityGate.passed ? '通过' : '失败') : '—')}${cell(`${release.createdBy} · ${formatDate(release.createdAt)}`)}${cell(release.deployments.length ? release.deployments.map(deployment => `${deployment.environment} · ${deployment.status === 'active' ? '当前生效' : deployment.status === 'stopped' ? '已停用' : '已部署'} · ${formatDate(deployment.deployedAt)}`).join('；') : '未部署')}${cell(release.checksum)}</tr>`).join('') || '<tr><td colspan="7" class="empty">暂无发布</td></tr>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.name)} - 规则项目报告</title><style>
*{box-sizing:border-box}html,body{margin:0;background:#f4f4f4;color:#1a1a1a;font-family:PingFang SC,Microsoft YaHei,Source Han Sans SC,system-ui,sans-serif;font-size:12px;line-height:1.5}body{padding:24px}.report{max-width:1120px;margin:auto;background:#fff}.brand{height:56px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;background:#0f62ff;color:#fff}.logo{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;background:#fff;color:#0f62ff;font-weight:700;margin-right:9px}.brand-left{display:flex;align-items:center;font-weight:700}.brand-right{text-align:right;font-size:11px;font-weight:400}.brand-right strong{display:block;font-size:14px}.intro{padding:22px 24px 18px;border-bottom:1px solid #e0e0e0}.intro h1{margin:0 0 5px;font-size:24px}.intro p{margin:3px 0;color:#525252}.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:16px 24px}.kpi{border:1px solid #e0e0e0;padding:11px 12px}.kpi b{display:block;font-size:22px;color:#0f62ff}.kpi span{color:#525252}.section{padding:0 24px 18px;break-inside:avoid}.section h2{display:flex;align-items:center;gap:8px;margin:14px 0 10px;border-bottom:1px solid #e0e0e0;padding-bottom:7px;font-size:14px}.section h2 span{display:inline-flex;width:25px;height:22px;align-items:center;justify-content:center;background:#dbeaff;color:#0043ce;font-size:11px}.section h3{margin:12px 0 7px;font-size:12px}.section h3 small{font-weight:400;color:#8c8c8c;margin-left:7px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:7px 8px;border:1px solid #e0e0e0;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f8fafc;font-weight:600}tbody tr:nth-child(even){background:#fafbfc}.status{font-weight:600}.status.published{color:#0043ce}.status.APPROVED{color:#2e7d32}.warning{display:inline-block;border:1px solid #dc2626;background:#fff1f2;color:#dc2626;padding:1px 5px}.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.stat{border:1px solid #e0e0e0;padding:6px 9px;color:#525252}.stat b{margin-right:5px;color:#0f62ff;font-size:16px}.flow{border:1px solid #e0e0e0;margin:8px 0;padding:10px;break-inside:avoid}.flow-head{display:flex;justify-content:space-between;gap:10px}.flow-head span,.flow li span{color:#525252}.flow ol{margin:8px 0 0;padding-left:22px}.flow li{padding:4px 0}td.col-name{width:20%}td.col-desc{width:30%}.dt-row td{padding:10px 12px!important;background:#f7f9fc;border:none}.dt-detail{border:1px solid #d9e2f2;border-radius:6px;padding:12px 14px;background:#fff}.dt-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid #e0e0e0}.dt-head b{font-size:12px;color:#0043ce}.dt-head span{color:#525252;font-weight:400}.dt-cols{color:#525252;margin:0 0 10px}.dt-detail table thead th{background:#f0f6ff}.dt-detail td.dt-cond{background:#fff}.dt-detail td.dt-action{background:#f4faf4}.dt-detail table tbody tr:nth-child(even){background:#fafcfd}.empty{padding:12px!important;color:#8c8c8c;text-align:center}.muted{color:#8c8c8c}.footer{border-top:1px solid #e0e0e0;padding:14px 24px;color:#8c8c8c;font-size:10px}@page{size:A4;margin:16mm}@media print{html,body{background:#fff}body{padding:0}.report{max-width:none}.section{break-inside:avoid}.section table{break-inside:auto}thead{display:table-header-group}.brand{background:#e8f1ff;color:#1a1a1a}.logo{background:#0f62ff;color:#fff}.kpi,.flow{break-inside:avoid}}
</style></head><body><main class="report"><header class="brand"><div class="brand-left"><span class="logo">DW</span>Decision Workbench</div><div class="brand-right"><strong>项目知识资产报告</strong>生成于 ${escapeHtml(formatDate(report.meta.generatedAt))}</div></header><div class="intro"><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description || '暂无项目描述')}</p><p>决策服务：${escapeHtml(report.meta.decisionService)}　·　数据版本：${escapeHtml(report.meta.dataVersion)}　·　生成人：${escapeHtml(report.meta.generatedBy)}</p></div><div class="kpis">${kpis.map(([label,value]) => `<div class="kpi"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('')}</div>${section('01','项目概览',`<p>最近更新：${escapeHtml(formatDate(report.overview.updatedAt))} · ${escapeHtml(report.overview.updatedBy || '—')}　部署环境：${escapeHtml(report.overview.environments.join('、') || '暂无')}</p>`)}${section('02','BOM 资产总览',`<table><thead><tr><th>事实类型</th><th>业务名称</th><th>方向</th><th>字段数</th></tr></thead><tbody>${bomRows}</tbody></table><div class="stats">${typeStats}</div>`)}${section('03','规则资产清单',assetGroups)}${section('04','事件流检测明细',`<table><thead><tr><th>事件流</th><th>业务名称</th><th>语句 ID</th><th>模式</th><th>模板</th><th>说明</th></tr></thead><tbody>${eventStreamRows}</tbody></table>`)}${section('05','规则集拓扑',flowBlocks)}${section('06','测试矩阵',`<table><thead><tr><th>套件名</th><th>目标</th><th>门禁</th><th>用例 / 通过 / 失败</th><th>通过率</th><th>覆盖率</th><th>最近运行</th></tr></thead><tbody>${testRows}</tbody></table>`)}${section('07','发布与部署历史',`<table><thead><tr><th>版本</th><th>名称</th><th>决策服务</th><th>质量门禁</th><th>创建人 / 时间</th><th>部署</th><th>checksum</th></tr></thead><tbody>${releaseRows}</tbody></table>`)}<footer class="footer">Decision Workbench · 项目知识资产报告 · 生成时间 ${escapeHtml(formatDate(report.meta.generatedAt))}</footer></main></body></html>`;
}

export { escapeHtml };
