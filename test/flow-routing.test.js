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
