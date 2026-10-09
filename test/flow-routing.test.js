import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

test('FLOW-ROUTE-01: 条件网关选择首个匹配分支并回退默认分支', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const flow = (await env.request('/api/flows', 'POST')).body;
    const draft = {
      ...flow.draft,
      name: '年龄路由流程',
      steps: [{ type: 'rule', id: rule.id }],
      branches: [
        {
          id: 'senior', name: '年长客户', default: false,
          condition: { field: 'customerAge', operator: '>=', value: '50' },
          steps: [{ type: 'rule', id: rule.id }],
        },
        {
          id: 'fallback', name: '默认客户', default: true, condition: null,
          steps: [{ type: 'rule', id: rule.id }],
        },
      ],
    };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);
    const published = await env.request(`/api/flows/${flow.id}/publish`, 'POST');
    assert.equal(published.status, 200);
    assert.equal(published.body.published.branches[0].condition.value, 50);

    const matched = await env.request(`/api/flows/${flow.id}/test`, 'POST', { published: true, facts: { customerAge: 60 } });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.path.branchId, 'senior');
    assert.deepEqual(matched.body.trace.map(entry => entry.type), ['rule', 'gateway', 'rule']);
    assert.equal(matched.body.trace[1].branchName, '年长客户');

    const fallback = await env.request(`/api/flows/${flow.id}/test`, 'POST', { published: true, facts: { customerAge: 20 } });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.path.branchId, 'fallback');
    assert.equal(fallback.body.path.default, true);

    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/routed-flow', name: '路由流程发布', target: { type: 'flow', id: flow.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.routing.type, 'exclusive');
    assert.equal(release.body.routing.afterStep, 1);
    assert.deepEqual(release.body.routing.branches.map(branch => branch.stepIndexes), [[1], [2]]);
  } finally { await env.stop(); }
});

test('FLOW-ROUTE-02: 多级排他网关按阶段选路并在分支后继续公共主线', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const flow = (await env.request('/api/flows', 'POST')).body;
    const step = suffix => ({ nodeId: `node-${suffix}`, type: 'rule', id: rule.id });
    const draft = {
      ...flow.draft,
      name: '多级路由流程',
      steps: [step('common-1'), step('common-2')],
      gateways: [
        {
          id: 'age-gateway', name: '年龄判断', afterStep: 1,
          branches: [
            { id: 'adult', name: '成年人', condition: { field: 'customerAge', operator: '>=', value: '18' }, steps: [step('adult')] },
            { id: 'minor', name: '未成年人', default: true, steps: [step('minor')] },
          ],
        },
        {
          id: 'income-gateway', name: '收入判断', afterStep: 2,
          branches: [
            { id: 'high-income', name: '高收入', condition: { field: 'annualIncome', operator: '>=', value: '100000' }, steps: [step('high-income')] },
            { id: 'normal-income', name: '普通收入', default: true, steps: [step('normal-income')] },
          ],
        },
      ],
      branches: undefined,
    };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);
    const published = await env.request(`/api/flows/${flow.id}/publish`, 'POST');
    assert.equal(published.status, 200);
    assert.equal(published.body.published.gateways.length, 2);

    const executed = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      published: true, facts: { customerAge: 20, annualIncome: 120000 },
    });
    assert.equal(executed.status, 200);
    assert.deepEqual(executed.body.paths.map(path => [path.gatewayId, path.branchId]), [
      ['age-gateway', 'adult'], ['income-gateway', 'high-income'],
    ]);
    assert.deepEqual(executed.body.trace.map(entry => entry.nodeId), [
      'node-common-1', 'age-gateway', 'node-adult', 'node-common-2', 'income-gateway', 'node-high-income',
    ]);
    assert.equal(executed.body.path, null);

    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/multi-routed-flow', name: '多级路由发布', target: { type: 'flow', id: flow.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.routing.type, 'exclusive-chain');
    assert.equal(release.body.routing.commonStepCount, 2);
    assert.deepEqual(release.body.routing.gateways.map(gateway => gateway.afterStep), [1, 2]);
    assert.deepEqual(release.body.routing.gateways.flatMap(gateway => gateway.branches.map(branch => branch.stepIndexes)), [[2], [3], [4], [5]]);
  } finally { await env.stop(); }
});

test('FLOW-ROUTE-03: DAG 嵌套网关选路后汇合到公共节点', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const flow = (await env.request('/api/flows', 'POST')).body;
    const step = nodeId => ({ nodeId, type: 'rule', id: rule.id });
    const draft = {
      ...flow.draft,
      name: '嵌套路由流程',
      steps: [], gateways: [],
      graph: {
        entry: 'entry-step',
        nodes: [
          { id: 'entry-step', type: 'step', step: step('entry-step'), next: 'age-gateway' },
          { id: 'age-gateway', type: 'gateway', name: '年龄判断', branches: [
            { id: 'adult', name: '成年人', condition: { field: 'customerAge', operator: '>=', value: '18' }, next: 'adult-step' },
            { id: 'minor', name: '未成年人', default: true, next: 'merge-step' },
          ] },
          { id: 'adult-step', type: 'step', step: step('adult-step'), next: 'income-gateway' },
          { id: 'income-gateway', type: 'gateway', name: '收入判断', branches: [
            { id: 'high-income', name: '高收入', condition: { field: 'annualIncome', operator: '>=', value: '100000' }, next: 'high-step' },
            { id: 'normal-income', name: '普通收入', default: true, next: 'merge-step' },
          ] },
          { id: 'high-step', type: 'step', step: step('high-step'), next: 'merge-step' },
          { id: 'merge-step', type: 'step', step: step('merge-step'), next: 'end' },
        ],
      },
    };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);
    const published = await env.request(`/api/flows/${flow.id}/publish`, 'POST');
    assert.equal(published.status, 200);

    const references = await env.request('/api/projects/default/bom/references?field=annualIncome');
    assert.equal(references.status, 200);
    assert.ok(references.body.some(reference => reference.id === flow.id && reference.type === 'flow'));

    const executed = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      published: true, facts: { customerAge: 20, annualIncome: 120000 },
    });
    assert.equal(executed.status, 200);
    assert.deepEqual(executed.body.paths.map(path => path.branchId), ['adult', 'high-income']);
    assert.deepEqual(executed.body.trace.map(entry => entry.nodeId), [
      'entry-step', 'age-gateway', 'adult-step', 'income-gateway', 'high-step', 'merge-step',
    ]);

    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/nested-routed-flow', name: '嵌套路由发布', target: { type: 'flow', id: flow.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.routing.type, 'exclusive-dag');
    assert.equal(release.body.routing.entry, 'entry-step');
    assert.equal(release.body.steps.length, 4);
  } finally { await env.stop(); }
});

test('FLOW-ROUTE-04: DAG 拒绝循环和不可达节点', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const flow = (await env.request('/api/flows', 'POST')).body;
    const step = nodeId => ({ nodeId, type: 'rule', id: rule.id });
    const cyclic = {
      ...flow.draft, name: '循环流程', steps: [], gateways: [],
      graph: { entry: 'a', nodes: [
        { id: 'a', type: 'step', step: step('a'), next: 'b' },
        { id: 'b', type: 'step', step: step('b'), next: 'a' },
      ] },
    };
    const cycleResponse = await env.request(`/api/flows/${flow.id}`, 'PUT', cyclic);
    assert.equal(cycleResponse.status, 400);
    assert.match(cycleResponse.body.error, /循环/);

    const isolated = structuredClone(cyclic);
    isolated.name = '孤立节点流程';
    isolated.graph.nodes[0].next = 'end';
    isolated.graph.nodes[1].next = 'end';
    const isolatedResponse = await env.request(`/api/flows/${flow.id}`, 'PUT', isolated);
    assert.equal(isolatedResponse.status, 400);
    assert.match(isolatedResponse.body.error, /不可达|孤立/);
  } finally { await env.stop(); }
});

test('FLOW-ROUTE-05: 并行分支隔离执行后在聚合节点合并非冲突输出', async () => {
  const env = await startTestEnv({ engineBehavior: { testHandler: async (payload, index) => ({
    body: { ok: true, fired: [`branch-${index + 1}`], count: 1, facts: index === 0 ? { riskLevel: '高' } : { reviewRequired: true } },
  }) } });
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const flow = (await env.request('/api/flows', 'POST')).body;
    const step = nodeId => ({ nodeId, type: 'rule', id: rule.id });
    const draft = {
      ...flow.draft, name: '并行聚合流程', steps: [], gateways: [],
      graph: { entry: 'parallel', nodes: [
        { id: 'parallel', type: 'parallel', name: '并行检查', join: 'join', branches: [
          { id: 'risk', name: '风险检查', next: 'risk-step' },
          { id: 'review', name: '复核检查', next: 'review-step' },
        ] },
        { id: 'risk-step', type: 'step', step: step('risk-step'), next: 'join' },
        { id: 'review-step', type: 'step', step: step('review-step'), next: 'join' },
        { id: 'join', type: 'join', name: '结果聚合', next: 'end' },
      ] },
    };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);
    const published = await env.request(`/api/flows/${flow.id}/publish`, 'POST');
    assert.equal(published.status, 200);
    const executed = await env.request(`/api/flows/${flow.id}/test`, 'POST', { published: true, facts: { customerAge: 30 } });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.facts.riskLevel, '高');
    assert.equal(executed.body.facts.reviewRequired, true);
    assert.deepEqual(executed.body.trace.map(entry => entry.type), ['parallel', 'rule', 'rule', 'join']);
    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/parallel-flow', name: '并行聚合发布', target: { type: 'flow', id: flow.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.routing.type, 'decision-dag');
  } finally { await env.stop(); }
});

test('FLOW-ROUTE-06: 聚合节点拒绝并行分支对同一字段写入不同值', async () => {
  const env = await startTestEnv({ engineBehavior: { testHandler: async (_payload, index) => ({
    body: { ok: true, fired: [`branch-${index + 1}`], count: 1, facts: { riskLevel: index === 0 ? '高' : '低' } },
  }) } });
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const flow = (await env.request('/api/flows', 'POST')).body;
    const step = nodeId => ({ nodeId, type: 'rule', id: rule.id });
    const draft = { ...flow.draft, name: '冲突聚合流程', steps: [], gateways: [], graph: { entry: 'parallel', nodes: [
      { id: 'parallel', type: 'parallel', name: '并行检查', join: 'join', branches: [{ id: 'a', name: 'A', next: 'a-step' }, { id: 'b', name: 'B', next: 'b-step' }] },
      { id: 'a-step', type: 'step', step: step('a-step'), next: 'join' },
      { id: 'b-step', type: 'step', step: step('b-step'), next: 'join' },
      { id: 'join', type: 'join', name: '结果聚合', next: 'end' },
    ] } };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);
    assert.equal((await env.request(`/api/flows/${flow.id}/publish`, 'POST')).status, 200);
    const executed = await env.request(`/api/flows/${flow.id}/test`, 'POST', { published: true, facts: { customerAge: 30 } });
    assert.equal(executed.status, 409);
    assert.match(executed.body.error, /riskLevel/);
    assert.equal(executed.body.failedStep.type, 'join');
  } finally { await env.stop(); }
});

test('FLOW-ROUTE-07: 子流程发布时内联冻结，升版后父流程提示重新发布', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const child = (await env.request('/api/projects/default/flows', 'POST')).body;
    const childSaved = await env.request(`/api/projects/default/flows/${child.id}`, 'PUT', {
      revision: child.revision,
      draft: { ...child.draft, name: '已发布子流程', steps: [{ nodeId: 'child-rule', type: 'rule', id: rule.id }] },
    });
    assert.equal(childSaved.status, 200);
    assert.equal((await env.request(`/api/projects/default/flows/${child.id}/publish`, 'POST', { revision: childSaved.body.revision })).status, 200);

    const parent = (await env.request('/api/projects/default/flows', 'POST')).body;
    assert.ok(parent.availableFlows.some(flow => flow.id === child.id && flow.version === 1));
    const parentSaved = await env.request(`/api/projects/default/flows/${parent.id}`, 'PUT', {
      revision: parent.revision,
      draft: { ...parent.draft, name: '父流程', steps: [{ nodeId: 'call-child', type: 'subflow', id: child.id }] },
    });
    assert.equal(parentSaved.status, 200);
    const parentPublished = await env.request(`/api/projects/default/flows/${parent.id}/publish`, 'POST', { revision: parentSaved.body.revision });
    assert.equal(parentPublished.status, 200);
    assert.equal(parentPublished.body.stepCount, 1);
    const frozenParent = (await env.request('/api/flows')).body.find(flow => flow.id === parent.id).published;
    assert.deepEqual(frozenParent.subflows.map(flow => [flow.id, flow.version]), [[child.id, 1]]);
    assert.equal(frozenParent.graph.nodes[0].id, 'call-child/child-rule');

    const executed = await env.request(`/api/flows/${parent.id}/test`, 'POST', { published: true, facts: { customerAge: 30 } });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.trace[0].nodeId, 'call-child/child-rule');
    const release = await env.request('/api/projects/default/releases', 'POST', {
      decisionService: 'default/subflow-parent', name: '子流程父 Release', target: { type: 'flow', id: parent.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.routing.type, 'exclusive-dag');
    assert.deepEqual(release.body.steps.map(step => step.type), ['rule']);
    assert.equal(release.body.routing.nodes[0].id, 'call-child/child-rule');
    assert.equal(release.body.steps[0].subflowPath[0].id, child.id);

    const childDetail = await env.request(`/api/projects/default/flows/${child.id}`);
    const childUpdated = await env.request(`/api/projects/default/flows/${child.id}`, 'PUT', {
      revision: childDetail.body.revision,
      draft: { ...childDetail.body.draft, description: '子流程第二版' },
    });
    assert.equal(childUpdated.status, 200);
    assert.equal((await env.request(`/api/projects/default/flows/${child.id}/publish`, 'POST', { revision: childUpdated.body.revision })).status, 200);
    const parentSummary = (await env.request('/api/projects/default/rulesets')).body.find(flow => flow.id === parent.id);
    assert.equal(parentSummary.needsRepublish, true);
    assert.deepEqual(parentSummary.outdatedDependencies, [{
      kind: 'subflow', id: child.id, name: '已发布子流程', publishedVersion: 1, latestVersion: 2,
    }]);
    const stillFrozen = await env.request(`/api/flows/${parent.id}/test`, 'POST', { published: true, facts: { customerAge: 30 } });
    assert.equal(stillFrozen.status, 200);
    assert.equal(frozenParent.subflows[0].version, 1);
  } finally { await env.stop(); }
});
