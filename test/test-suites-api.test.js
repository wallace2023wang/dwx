import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

async function publishedAsset(env, kind) {
  const created = (await env.request(`/api/${kind}`, 'POST')).body;
  const published = await env.request(`/api/${kind}/${created.id}/publish`, 'POST');
  assert.equal(published.status, 200);
  return published.body;
}

function suiteFor(target, changes = {}) {
  return {
    name: '客户风险回归',
    description: '验证核心输出和规则命中',
    target,
    required: true,
    cases: [{
      id: 'case-risk', name: '风险结果', enabled: true,
      facts: { customerAge: 30 },
      expected: { outputs: { riskLevel: '中' }, fired: ['mock 规则 [1]'] },
    }],
    ...changes,
  };
}

test('TEST-SUITE-01: 创建、更新、运行和归档测试套件', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedAsset(env, 'rules');
    const created = await env.request('/api/test-suites', 'POST', suiteFor({ type: 'rule', id: rule.id }));
    assert.equal(created.status, 201);
    assert.equal(created.body.lastRun, null);

    const updated = await env.request(`/api/test-suites/${created.body.id}`, 'PUT', {
      ...suiteFor({ type: 'rule', id: rule.id }), name: '客户风险每日回归', required: false,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.required, false);

    const run = await env.request(`/api/test-suites/${created.body.id}/run`, 'POST');
    assert.equal(run.status, 200);
    assert.equal(run.body.report.passed, true);
    assert.equal(run.body.report.targetVersion, 1);
    assert.deepEqual(run.body.report.coverage, {
      kind: 'rule', hit: 1, total: 1, percentage: 100,
      items: [{ id: rule.id, label: rule.draft.name, hit: true }],
    });
    assert.equal(run.body.report.cases[0].assertions.length, 2);
    assert.ok(run.body.report.cases[0].assertions.every(assertion => assertion.passed));
    assert.deepEqual(run.body.report.cases[0].inputFacts, { customerAge: 30 });
    assert.ok(run.body.report.cases[0].omittedFields.includes('annualIncome'));

    assert.equal((await env.request('/api/test-suites')).body[0].lastRun.id, run.body.report.id);
    assert.equal((await env.request(`/api/test-suites/${created.body.id}/archive`, 'POST')).status, 200);
    assert.equal((await env.request('/api/test-suites')).body.length, 0);
  } finally { await env.stop(); }
});

test('TEST-SUITE-02: 决策表运行使用已发布版本并返回断言详情', async () => {
  const env = await startTestEnv();
  try {
    const table = await publishedAsset(env, 'tables');
    const created = await env.request('/api/test-suites', 'POST', suiteFor(
      { type: 'table', id: table.id },
      { name: '决策表回归', cases: [{
        id: 'table-case', name: '命中风险行', enabled: true,
        facts: { creditScore: 500, overdue: true },
        expected: { outputs: { riskLevel: '中' }, fired: ['mock 规则 [1]'] },
      }] },
    ));
    assert.equal(created.status, 201);
    const run = await env.request(`/api/test-suites/${created.body.id}/run`, 'POST');
    assert.equal(run.body.report.passed, true);
    assert.equal(run.body.report.cases[0].outputs.riskLevel, '中');
  } finally { await env.stop(); }
});

test('TEST-SUITE-03: 规则流回归支持路径和跨节点命中断言', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedAsset(env, 'rules');
    const flow = (await env.request('/api/flows', 'POST')).body;
    const draft = {
      ...flow.draft, name: '客户年龄路由', steps: [{ type: 'rule', id: rule.id }],
      branches: [
        { id: 'senior', name: '年长客户', default: false, condition: { field: 'customerAge', operator: '>=', value: '50' }, steps: [{ type: 'rule', id: rule.id }] },
        { id: 'fallback', name: '默认客户', default: true, condition: null, steps: [{ type: 'rule', id: rule.id }] },
      ],
    };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);
    assert.equal((await env.request(`/api/flows/${flow.id}/publish`, 'POST')).status, 200);
    const created = await env.request('/api/test-suites', 'POST', suiteFor(
      { type: 'flow', id: flow.id },
      { name: '路径回归', cases: [{
        id: 'senior-case', name: '进入年长客户路径', enabled: true,
        facts: { customerAge: 60 },
        expected: { outputs: { riskLevel: '中' }, fired: ['mock 规则 [1]'], path: 'senior' },
      }] },
    ));
    assert.equal(created.status, 201);
    const run = await env.request(`/api/test-suites/${created.body.id}/run`, 'POST');
    assert.equal(run.body.report.passed, true);
    assert.equal(run.body.report.cases[0].path, 'senior');
    assert.equal(run.body.report.cases[0].fired.length, 2);
    assert.equal(run.body.report.coverage.kind, 'flow-path');
    assert.equal(run.body.report.coverage.hit, 1);
    assert.equal(run.body.report.coverage.total, 2);
    assert.equal(run.body.report.coverage.items.find(item => item.id === 'senior').hit, true);
  } finally { await env.stop(); }
});

test('TEST-SUITE-04: 必需套件失败会阻止 Release 并保存失败报告', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedAsset(env, 'rules');
    const suite = suiteFor({ type: 'rule', id: rule.id });
    suite.cases[0].expected.outputs.riskLevel = '高';
    assert.equal((await env.request('/api/test-suites', 'POST', suite)).status, 201);

    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/gated', name: '应被阻止', target: { type: 'rule', id: rule.id },
    });
    assert.equal(release.status, 409);
    assert.equal(release.body.gate.passed, false);
    assert.equal(release.body.reports[0].cases[0].assertions[0].passed, false);
    assert.equal((await env.request('/api/releases')).body.length, 0);
    assert.equal((await env.request('/api/test-suites')).body[0].lastRun.passed, false);
  } finally { await env.stop(); }
});

test('TEST-SUITE-05: 非必需套件失败不阻止 Release', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedAsset(env, 'rules');
    const suite = suiteFor({ type: 'rule', id: rule.id }, { required: false });
    suite.cases[0].expected.outputs.riskLevel = '高';
    assert.equal((await env.request('/api/test-suites', 'POST', suite)).status, 201);
    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/advisory', name: '允许发布', target: { type: 'rule', id: rule.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.qualityGate.passed, true);
    assert.deepEqual(release.body.qualityGate.suites, []);
  } finally { await env.stop(); }
});

test('TEST-SUITE-06: 资产升版后 Release 门禁实时重跑并记录新版本', async () => {
  const env = await startTestEnv();
  try {
    let rule = await publishedAsset(env, 'rules');
    const created = await env.request('/api/test-suites', 'POST', suiteFor({ type: 'rule', id: rule.id }));
    const firstRun = await env.request(`/api/test-suites/${created.body.id}/run`, 'POST');
    assert.equal(firstRun.body.report.targetVersion, 1);
    const previousTests = env.engineCalls.filter(call => call.path === '/test').length;

    rule = (await env.request(`/api/rules/${rule.id}`, 'PUT', { ...rule.draft, description: '第二版' })).body;
    assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);
    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/versioned-gate', name: '第二版发布', target: { type: 'rule', id: rule.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.target.assetVersion, 2);
    assert.equal(release.body.qualityGate.suites[0].targetVersion, 2);
    assert.equal(env.engineCalls.filter(call => call.path === '/test').length, previousTests + 1);
    assert.equal((await env.request('/api/test-suites')).body[0].lastRun.targetVersion, 2);
  } finally { await env.stop(); }
});

test('TEST-SUITE-07: 全量回归运行所有活动套件', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedAsset(env, 'rules');
    const table = await publishedAsset(env, 'tables');
    assert.equal((await env.request('/api/test-suites', 'POST', suiteFor({ type: 'rule', id: rule.id }, { name: '规则回归' }))).status, 201);
    assert.equal((await env.request('/api/test-suites', 'POST', suiteFor({ type: 'table', id: table.id }, { name: '表格回归' }))).status, 201);
    const run = await env.request('/api/test-suites/run', 'POST');
    assert.equal(run.status, 200);
    assert.equal(run.body.total, 2);
    assert.equal(run.body.passedCount, 2);
    assert.equal(run.body.passed, true);
  } finally { await env.stop(); }
});

test('TEST-SUITE-08: 参数化案例合并基础事实并生成独立报告行', async () => {
  const env = await startTestEnv({
    engineBehavior: {
      testHandler: payload => ({ body: {
        ok: true, fired: ['mock 规则 [1]'], count: 1,
        facts: { ...payload.facts, riskLevel: '中' },
      } }),
    },
  });
  try {
    const rule = await publishedAsset(env, 'rules');
    const definition = suiteFor({ type: 'rule', id: rule.id });
    definition.cases[0].facts = { creditScore: 700 };
    definition.cases[0].parameters = [
      { id: 'minor', name: '17 岁', facts: { customerAge: 17 } },
      { id: 'adult', name: '18 岁', facts: { customerAge: 18 } },
    ];
    const created = await env.request('/api/test-suites', 'POST', definition);
    assert.equal(created.status, 201);
    assert.equal(created.body.cases[0].parameters.length, 2);

    const run = await env.request(`/api/test-suites/${created.body.id}/run`, 'POST');
    assert.equal(run.status, 200);
    assert.deepEqual(run.body.report.cases.map(entry => entry.id), ['case-risk::minor', 'case-risk::adult']);
    assert.deepEqual(run.body.report.cases.map(entry => entry.parentCaseId), ['case-risk', 'case-risk']);
    const facts = env.engineCalls.filter(call => call.path === '/test').map(call => call.body.facts);
    assert.deepEqual(facts, [
      { creditScore: 700, customerAge: 17 },
      { creditScore: 700, customerAge: 18 },
    ]);
  } finally { await env.stop(); }
});

test('TEST-SUITE-09: 参数行和展开总量限制返回明确错误', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedAsset(env, 'rules');
    const definition = suiteFor({ type: 'rule', id: rule.id });
    definition.cases[0].parameters = Array.from({ length: 101 }, (_, index) => ({
      id: `p-${index}`, name: `参数 ${index}`, facts: { customerAge: index },
    }));
    const created = await env.request('/api/test-suites', 'POST', definition);
    assert.equal(created.status, 400);
    assert.match(created.body.error, /参数行数量不能超过 100/);
  } finally { await env.stop(); }
});

test('TEST-SUITE-10: 决策表报告按原始行号统计覆盖率', async () => {
  let firedRule = '';
  const env = await startTestEnv({
    engineBehavior: {
      testHandler: payload => {
        firedRule = payload.drl.match(/rule "([^"]+)"/)?.[1] || '';
        return { body: { ok: true, fired: [firedRule], count: 1, facts: { riskLevel: '中' } } };
      },
    },
  });
  try {
    const table = await publishedAsset(env, 'tables');
    const definition = suiteFor({ type: 'table', id: table.id });
    definition.cases[0].expected.fired = [];
    const created = await env.request('/api/test-suites', 'POST', definition);
    const run = await env.request(`/api/test-suites/${created.body.id}/run`, 'POST');
    assert.equal(run.status, 200);
    assert.ok(firedRule);
    assert.equal(run.body.report.coverage.kind, 'table-row');
    assert.equal(run.body.report.coverage.hit, 1);
    assert.equal(run.body.report.coverage.items[0].id, 'row:0');
    assert.equal(run.body.report.coverage.items[0].hit, true);
  } finally { await env.stop(); }
});

test('TEST-SUITE-11: 版本对比识别回归并且不替换 lastRun', async () => {
  const env = await startTestEnv({
    engineBehavior: {
      testHandler: payload => {
        const riskLevel = payload.drl.includes('setRiskLevel("高")') ? '高' : '中';
        return { body: { ok: true, fired: ['mock 规则 [1]'], count: 1, facts: { riskLevel } } };
      },
    },
  });
  try {
    let rule = await publishedAsset(env, 'rules');
    const created = await env.request('/api/test-suites', 'POST', suiteFor({ type: 'rule', id: rule.id }));
    const firstRun = await env.request(`/api/test-suites/${created.body.id}/run`, 'POST');
    assert.equal(firstRun.body.report.passed, true);

    rule = (await env.request(`/api/rules/${rule.id}`, 'PUT', {
      ...rule.draft,
      actions: rule.draft.actions.map(action => action.field === 'riskLevel' ? { ...action, value: '高' } : action),
    })).body;
    assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);

    const compared = await env.request(`/api/test-suites/${created.body.id}/compare`, 'POST', {
      baseVersion: 1, candidateVersion: 2,
    });
    assert.equal(compared.status, 200);
    assert.equal(compared.body.report.summary.regressed, 1);
    assert.equal(compared.body.report.summary.reviewRequired, 1);
    assert.equal(compared.body.report.cases[0].classification, 'regressed');
    assert.equal(compared.body.report.coverage.base.percentage, 100);
    assert.equal(compared.body.report.coverage.candidate.percentage, 100);
    assert.equal(compared.body.suite.lastRun.id, firstRun.body.report.id);
    assert.equal(compared.body.suite.runs[0].kind, 'comparison');
  } finally { await env.stop(); }
});

test('TEST-SUITE-12: 项目 API 返回目标版本并隔离跨项目对比', async () => {
  const env = await startTestEnv();
  try {
    let rule = await publishedAsset(env, 'rules');
    rule = (await env.request(`/api/rules/${rule.id}`, 'PUT', { ...rule.draft, description: '第二个发布版本' })).body;
    assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);
    const suite = await env.request('/api/test-suites', 'POST', suiteFor({ type: 'rule', id: rule.id }));
    const projected = await env.request('/api/projects/default/tests');
    assert.equal(projected.status, 200);
    assert.deepEqual(projected.body.find(item => item.id === suite.body.id).targetVersions, [1, 2]);

    const other = await env.request('/api/projects', 'POST', {
      name: '隔离验证项目', description: '', icon: 'shield', bomTemplate: 'risk',
    });
    assert.equal(other.status, 201);
    const crossed = await env.request(`/api/projects/${other.body.id}/tests/${suite.body.id}/compare`, 'POST', {
      baseVersion: 1, candidateVersion: 2,
    });
    assert.equal(crossed.status, 404);
    assert.equal(crossed.body.error, '测试套件不存在');
  } finally { await env.stop(); }
});
