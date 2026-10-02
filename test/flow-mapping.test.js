import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

test('FLOW-MAP-01: 节点输入映射在下一步执行前复制字段并冻结到 Release', async () => {
  const env = await startTestEnv({ engineBehavior: { testFacts: { approvedLimit: 1000 } } });
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);

    const flow = (await env.request('/api/flows', 'POST')).body;
    const draft = {
      ...flow.draft,
      name: '字段映射流程',
      steps: [
        { type: 'rule', id: rule.id, outputMappings: [{ source: 'approvedLimit', target: 'annualIncome' }] },
        { type: 'rule', id: rule.id, inputMappings: [{ source: 'approvedLimit', target: 'annualIncome' }] },
      ],
    };
    assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', draft)).status, 200);
    assert.equal((await env.request(`/api/flows/${flow.id}/publish`, 'POST')).status, 200);

    const executed = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      published: true,
      facts: { customerAge: 30, annualIncome: 0 },
    });
    assert.equal(executed.status, 200);
    const testCalls = env.engineCalls.filter(call => call.path === '/test');
    assert.equal(testCalls.length, 2);
    assert.equal(testCalls[1].body.facts.annualIncome, 1000);
    assert.deepEqual(executed.body.trace[0].mappings.outputs, [
      { source: 'approvedLimit', target: 'annualIncome', value: 1000, applied: true },
    ]);
    assert.deepEqual(executed.body.trace[1].mappings.inputs, [
      { source: 'approvedLimit', target: 'annualIncome', value: 1000, applied: true },
    ]);

    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/mapped-flow', name: '映射流程发布', target: { type: 'flow', id: flow.id },
    });
    assert.equal(release.status, 201);
    assert.deepEqual(release.body.steps[0].outputMappings, [{ source: 'approvedLimit', target: 'annualIncome' }]);
    assert.deepEqual(release.body.steps[1].inputMappings, [{ source: 'approvedLimit', target: 'annualIncome' }]);

    const bom = (await env.request('/api/bom')).body;
    const removeMappedField = await env.request('/api/bom', 'PUT', bom.fields.filter(field => field.key !== 'annualIncome'));
    assert.equal(removeMappedField.status, 400);
    assert.match(removeMappedField.body.error, /规则资产引用/);
  } finally { await env.stop(); }
});
