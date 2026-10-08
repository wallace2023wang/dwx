import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startTestEnv } from './helpers.js';

test('new rulesets receive unique default names in project and legacy APIs', async () => {
  const env = await startTestEnv();
  try {
    const first = await env.request('/api/projects/default/flows', 'POST');
    const second = await env.request('/api/projects/default/flows', 'POST');
    const third = await env.request('/api/flows', 'POST');
    assert.equal(first.body.draft.name, '未命名规则集');
    assert.equal(second.body.draft.name, '未命名规则集 2');
    assert.equal(third.body.draft.name, '未命名规则集 3');
  } finally { await env.stop(); }
});

test('ruleset rename rejects another active name but allows an archived name', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const first = (await env.request('/api/projects/default/flows', 'POST')).body;
    const second = (await env.request('/api/projects/default/flows', 'POST')).body;
    const draft = { ...first.draft, name: '同名规则集', steps: [{ type: 'rule', id: rule.id }] };
    const saved = await env.request(`/api/projects/default/flows/${first.id}`, 'PUT', { revision: first.revision, draft });
    assert.equal(saved.status, 200);

    const rejected = await env.request(`/api/projects/default/flows/${second.id}`, 'PUT', {
      revision: second.revision,
      draft: { ...second.draft, name: '  同名规则集  ', steps: [{ type: 'rule', id: rule.id }] },
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'RULESET_NAME_CONFLICT');

    const legacyRejected = await env.request(`/api/flows/${second.id}`, 'PUT', {
      ...second.draft, name: '同名规则集', steps: [{ type: 'rule', id: rule.id }],
    });
    assert.equal(legacyRejected.status, 409);
    assert.equal(legacyRejected.body.code, 'RULESET_NAME_CONFLICT');

    const archived = await env.request(`/api/flows/${first.id}/archive`, 'POST', { revision: saved.body.revision });
    assert.equal(archived.status, 200);
    const renamed = await env.request(`/api/projects/default/flows/${second.id}`, 'PUT', {
      revision: second.revision,
      draft: { ...second.draft, name: '同名规则集', steps: [{ type: 'rule', id: rule.id }] },
    });
    assert.equal(renamed.status, 200);
  } finally { await env.stop(); }
});

test('existing duplicate rulesets remain editable but only one can become published', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    const first = (await env.request('/api/projects/default/flows', 'POST')).body;
    const second = (await env.request('/api/projects/default/flows', 'POST')).body;
    const flowsFile = path.join(env.dir, 'flows.json');
    const flows = JSON.parse(await fs.readFile(flowsFile, 'utf8'));
    for (const flow of flows) {
      flow.draft.name = '存量重复规则集';
      flow.draft.steps = [{ type: 'rule', id: rule.id }];
    }
    await fs.writeFile(flowsFile, JSON.stringify(flows, null, 2));

    const saved = await env.request(`/api/projects/default/flows/${second.id}`, 'PUT', {
      revision: second.revision,
      draft: { ...second.draft, name: '存量重复规则集', description: '仍可保存', steps: [{ type: 'rule', id: rule.id }] },
    });
    assert.equal(saved.status, 200);
    const published = await env.request(`/api/projects/default/flows/${first.id}/publish`, 'POST', { revision: first.revision });
    assert.equal(published.status, 200);
    const rejected = await env.request(`/api/flows/${second.id}/publish`, 'POST', { revision: saved.body.revision });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'RULESET_NAME_CONFLICT');
  } finally { await env.stop(); }
});
