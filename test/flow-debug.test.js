import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

async function publishedRule(env) {
  const rule = (await env.request('/api/rules', 'POST')).body;
  assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);
  return rule;
}

test('FLOW-DEBUG-01: 可暂停到网关并执行流程路径断言', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedRule(env);
    const flow = (await env.request('/api/flows', 'POST')).body;
    const draft = {
      ...flow.draft,
      name: '可调试分支流程',
      steps: [{ type: 'rule', id: rule.id }],
      branches: [
        { id: 'senior', name: '年长客户', default: false, condition: { field: 'customerAge', operator: '>=', value: '50' }, steps: [{ type: 'rule', id: rule.id }] },
        { id: 'fallback', name: '默认客户', default: true, condition: null, steps: [{ type: 'rule', id: rule.id }] },
      ],
    };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);

    const stopped = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      draft, facts: { customerAge: 60 }, stopAfter: 'gateway', expectedPath: 'senior',
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.debug.stoppedAt, 'gateway');
    assert.deepEqual(stopped.body.trace.map(step => step.nodeId), ['common:0', 'gateway']);
    assert.equal(stopped.body.assertions[0].passed, true);
    assert.equal(stopped.body.passed, true);

    const mismatch = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      draft, facts: { customerAge: 60 }, expectedPath: 'fallback',
    });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.body.path.branchId, 'senior');
    assert.equal(mismatch.body.assertions[0].passed, false);
    assert.equal(mismatch.body.passed, false);

    const invalid = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      draft, facts: { customerAge: 60 }, stopAfter: 'branch:missing:0',
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /停止节点无效/);
  } finally { await env.stop(); }
});

test('FLOW-DEBUG-02: 节点失败返回部分轨迹、现场事实和失败节点', async () => {
  const env = await startTestEnv({ engineBehavior: { testStatuses: [200, 422] } });
  try {
    const rule = await publishedRule(env);
    const flow = (await env.request('/api/flows', 'POST')).body;
    const draft = {
      ...flow.draft,
      name: '失败定位流程',
      steps: [{ type: 'rule', id: rule.id }, { type: 'rule', id: rule.id }],
    };
    const result = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      draft, facts: { customerAge: 30 },
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.failedStep.nodeId, 'common:1');
    assert.equal(result.body.failedStep.name, '未命名规则');
    assert.deepEqual(result.body.trace.map(step => step.nodeId), ['common:0']);
    assert.equal(result.body.facts.riskLevel, '中');
  } finally { await env.stop(); }
});
