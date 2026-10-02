import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

test('RULE-GROUP-API-01: package nodes save, compile, publish, and follow package rename', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);

    const flow = (await env.request('/api/projects/default/flows', 'POST')).body;
    assert.ok(flow.availablePackages.some(entry => entry.name === 'common' && entry.publishedRuleCount === 1));
    const draft = {
      ...flow.draft,
      name: '规则包执行流程',
      steps: [{
        nodeId: 'package-step',
        type: 'rule-group',
        selector: { packageName: 'common', includeChildren: false },
      }],
      editor: { positions: { 'package-step': { x: 260, y: 180 } } },
    };
    const saved = await env.request(`/api/projects/default/flows/${flow.id}`, 'PUT', { revision: flow.revision, draft });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.draft.steps[0].selector.packageName, 'common');

    const compiled = await env.request(`/api/projects/default/flows/${flow.id}/compile`, 'POST', {
      revision: saved.body.revision,
      draft: saved.body.draft,
    });
    assert.equal(compiled.status, 200);
    assert.equal(compiled.body.stepCount, 1);
    assert.match(env.engineCalls.at(-1).body.drl, /未命名规则/);

    const published = await env.request(`/api/projects/default/flows/${flow.id}/publish`, 'POST', { revision: saved.body.revision });
    assert.equal(published.status, 200);
    assert.equal(published.body.steps[0].type, 'rule-group');
    assert.equal(published.body.steps[0].name, '规则组：common');

    const executed = await env.request(`/api/flows/${flow.id}/test`, 'POST', {
      published: true,
      facts: { customerAge: 30 },
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.trace[0].nodeId, 'package-step');
    assert.equal(executed.body.trace[0].legacyNodeId, 'common:0');

    const release = await env.request('/api/projects/default/releases', 'POST', {
      decisionService: 'default/package-flow', name: '规则组发布包', target: { type: 'flow', id: flow.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.steps[0].type, 'rule-group');
    assert.equal(release.body.steps[0].memberFingerprint, published.body.steps[0].memberFingerprint);

    const renamed = await env.request('/api/projects/default/packages/common', 'PUT', {
      name: 'shared_rules', label: '共享规则', parentId: null,
    });
    assert.equal(renamed.status, 200);
    const afterRename = await env.request(`/api/projects/default/flows/${flow.id}`);
    assert.equal(afterRename.body.draft.steps[0].selector.packageName, 'shared_rules');
    assert.equal(afterRename.body.needsRepublish, true);

    const blockedDelete = await env.request('/api/projects/default/packages/shared_rules', 'DELETE', { deleteAssets: true });
    assert.equal(blockedDelete.status, 409);
    assert.match(blockedDelete.body.error, /规则流引用/);
  } finally {
    await env.stop();
  }
});
