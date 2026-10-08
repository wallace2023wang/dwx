#!/usr/bin/env node
/**
 * 充氮控制 —— 切到「规则内做阈值判定」形态并重建发布链路
 * ============================================================
 * 背景：客户要求最大/最小氮气浓度等判断参数要能**随时调整**，因此比较必须写在规则里，
 *       且阈值必须是**参数（facts）**而不是字面量——写死字面量会随 Release 冻结，
 *       改一次就要重新发布+部署，不满足"随时调整"。
 *
 * 本脚本把链路从「决策表 + 驱动算阈值」换成「BAL 规则包（含跨字段阈值比较）」：
 *   1. 发布 scripts/seed-nitrogen-bal.mjs 建好的 11 条规则
 *   2. 把规则集改为 Rule Group 步骤（整包执行）
 *   3. 更新测试套件（19 条，含动态阈值用例）
 *   4. 创建新 Release（触发编译 + 门禁）并部署到 RES
 *
 * 前置：先运行 seed-nitrogen-bal.mjs 建规则；RES :8790 可用。
 *
 * 用法：
 *   node rebuild-nitrogen-rules.mjs            # 干跑到部署
 *   node rebuild-nitrogen-rules.mjs --no-deploy
 */

const RTS_URL = (process.env.RTS_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const PROJECT = process.env.PROJECT_ID || 'project-63dbe140';
const PACKAGE = 'nitrogen';
const FLOW_NAME = '自动充氮控制规则集';
const DECISION_SERVICE = 'nitrogen-control';
const NO_DEPLOY = process.argv.includes('--no-deploy');

const log = (...a) => console.log(...a);

async function call(method, path, body) {
  const response = await fetch(`${RTS_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(240000),
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

/** 走一次空变更集推进修订号（内容不变时只推进，不发布） */
async function resetRevision(assetId, revision, type, label) {
  let changeSet;
  try {
    changeSet = await post(`/api/projects/${PROJECT}/change-sets`, {
      name: `修订号复位：${label}`,
      description: '重建脚本内部使用',
      items: [{ type, id: assetId, revision }],
    });
  } catch { return; }
  const changeCount = (changeSet.items || []).reduce((sum, item) => sum + (item.changes || []).length, 0);
  if (!changeCount) return;
  await post(`/api/projects/${PROJECT}/change-sets/${changeSet.id}/submit`, { revision: changeSet.revision });
  await post(`/api/projects/${PROJECT}/change-sets/${changeSet.id}/reject`, {
    revision: changeSet.revision + 1, comment: '重建脚本：修订号复位',
  });
}

/**
 * 发布规则，并保证**产物冻结的 BOM 版本与当前 BOM 一致**。
 * 平台有意要求：BOM 升版后，依赖它的已发布资产必须重新发布，否则规则集拒绝编译
 * （flowSnapshot：'使用 BOM vN，当前为 vM，请先重新发布该资产'）。
 */
async function publishRule(assetId, label, currentBomVersion) {
  let detail = await get(`/api/projects/${PROJECT}/rules/${assetId}`);
  const pinned = detail.publishedBomVersion ?? null;
  const bomOutdated = detail.status === 'published' && pinned != null && pinned !== currentBomVersion;
  // 草稿与已发布版本是否有实质差异（salience/conditions/actions 决定运行时行为）
  const draftKey = draft => JSON.stringify({
    salience: draft?.salience ?? draft?.priority,
    conditions: draft?.conditions, actions: draft?.actions,
  });
  const contentChanged = detail.status === 'published' && detail.published
    && draftKey(detail.draft) !== draftKey(detail.published);

  if (detail.status === 'published' && !bomOutdated && !contentChanged) {
    log(`  「${label}」已发布 v${detail.version} 且内容与 BOM 均最新（BOM v${pinned}），跳过`);
    return;
  }
  if (bomOutdated || contentChanged) {
    if (contentChanged) log(`  「${label}」草稿有变更（如 salience），重新发布`);
    else log(`  「${label}」产物冻结 BOM v${pinned}，重新发布以对齐 v${currentBomVersion}`);
    await resetRevision(assetId, detail.revision, 'rule', label);
    detail = await get(`/api/projects/${PROJECT}/rules/${assetId}`);
  }
  const published = await post(`/api/projects/${PROJECT}/rules/${assetId}/publish`, { revision: detail.revision });
  log(`  「${label}」→ published v${published.version}（BOM v${currentBomVersion}）`);
}

async function main() {
  log(`Team Server: ${RTS_URL}\n项目: ${PROJECT}\n`);

  // ---- 1. 发布规则包内的全部规则 ----
  log('1. 发布规则');
  const currentBomVersion = (await get(`/api/projects/${PROJECT}/bom`))?.version;
  log(`  当前 BOM v${currentBomVersion}`);
  const assets = await get(`/api/projects/${PROJECT}/rules`);
  const targets = assets.filter(a => a.type === 'rule' || !a.type);
  for (const asset of targets) await publishRule(asset.id, asset.name, currentBomVersion);

  // ---- 2. 规则集改为 Rule Group ----
  log('\n2. 规则集改为规则包步骤');
  const flows = await get(`/api/projects/${PROJECT}/flows`);
  let flow = flows.find(f => (f.flowName || f.name) === FLOW_NAME);
  if (!flow) {
    flow = await post(`/api/projects/${PROJECT}/flows`);
    log(`  创建规则集 ${flow.id ?? flow.flowId}`);
  }
  const flowId = flow.id ?? flow.flowId;
  const detail = await get(`/api/projects/${PROJECT}/flows/${flowId}`);
  const draft = {
    name: FLOW_NAME,
    description:
      '充氮控制主链路：以 Rule Group 步骤整包执行规则包「nitrogen」的 11 条规则。'
      + ' 阈值判定（nitrogenPct >= maxPct / nitrogenPct < minPct）**在规则条件内完成**，'
      + ' maxPct/minPct 由调用方按仓传入 facts —— 因此调整阈值只需改参数，'
      + ' 不需要修改或重新发布规则。'
      + ' 优先级由 salience 决定：结束(60) > 暂停(55) > 各阶段迁移(2–10)。',
    steps: [{ type: 'rule-group', nodeId: 'step-nitrogen-rules', selector: { packageName: PACKAGE, includeChildren: false } }],
    branches: [],
    editor: { positions: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  };
  const saved = await put(`/api/projects/${PROJECT}/flows/${flowId}`, { revision: detail.revision, draft });
  log(`  草稿已保存（revision → ${saved.revision}）`);
  const compiled = await post(`/api/projects/${PROJECT}/flows/${flowId}/compile`, { revision: saved.revision });
  log(`  编译：${compiled?.ok === false ? '失败' : '通过'}（${compiled?.stepCount ?? '?'} 步 / ${compiled?.branchCount ?? 0} 分支）`);

  // ---- 3. 发布规则集 ----
  log('\n3. 发布规则集');
  const flowNow = await get(`/api/projects/${PROJECT}/flows/${flowId}`);
  if (flowNow.status !== 'published') {
    const published = await post(`/api/projects/${PROJECT}/flows/${flowId}/publish`, { revision: flowNow.revision });
    log(`  规则集 → published v${published.version}`);
  } else {
    log(`  已是 published v${flowNow.version}（如需带最新规则需重新发布：页面操作或本脚本重跑前先 bump）`);
  }

  // ---- 4. 测试套件由 seed-nitrogen-suite.mjs 维护，这里只报告 ----
  log('\n4. 测试套件（由 seed-nitrogen-suite.mjs 维护）');
  const suites = await get(`/api/projects/${PROJECT}/test-suites`);
  for (const item of suites) log(`  「${item.name}」：${(item.cases || []).length} 条用例，required=${item.required}`);

  // ---- 5. 创建 Release ----
  log('\n5. 创建 Release（触发真实编译 + 门禁）');
  const releases = await get(`/api/projects/${PROJECT}/releases`);
  const created = await post(`/api/projects/${PROJECT}/releases`, {
    decisionService: DECISION_SERVICE,
    name: `自动充氮控制 v${releases.length + 1}（规则内阈值判定）`,
    description: '阈值比较在规则条件内完成（nitrogenPct >= maxPct）；maxPct/minPct 作为参数传入，可随时调整而无需重新发布规则。',
    target: { type: 'flow', id: flowId },
  });
  if (created.error) throw new Error(created.error);
  const gate = created.qualityGate || {};
  log(`  Release ${created.id}（v${created.version}）`);
  log(`  门禁 passed=${gate.passed}`);
  for (const report of gate.suites || []) {
    log(`    · ${report.name}：${report.passedCount}/${report.total} 通过`);
    for (const testCase of report.cases || []) {
      if (testCase.passed) continue;
      const bad = (testCase.assertions || []).filter(a => !a.passed)
        .map(a => `${a.field}: 期望 ${JSON.stringify(a.expected)} 实际 ${JSON.stringify(a.actual)}`);
      log(`      ✗ ${testCase.name}：${testCase.error || bad.join('; ')}`);
    }
  }
  if (!gate.passed) throw new Error('质量门禁未通过，已终止部署');

  // ---- 6. 部署 ----
  if (NO_DEPLOY) {
    log('\n6. 跳过部署（--no-deploy）');
  } else {
    log('\n6. 部署到 RES');
    const deployed = await post(`/api/projects/${PROJECT}/releases/${created.id}/deploy`, { environment: 'local' });
    const dep = (deployed.deployments || []).at(-1);
    log(`  已部署：env=${dep?.environment} at=${dep?.deployedAt}`);
  }

  log(`\nREBUILD_RESULT=${JSON.stringify({ projectId: PROJECT, flowId, releaseId: created.id, gatePassed: gate.passed, deployed: !NO_DEPLOY })}`);
}

main().catch(error => {
  console.error(`\n✗ 重建失败：${error.message}`);
  process.exit(1);
});
