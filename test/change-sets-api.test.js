import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestEnv } from './helpers.js';

test('GOV-01: 变更集固定资产差异并执行完整评审状态流转', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/rules', 'POST')).body;
    const published = (await env.request(`/api/rules/${created.id}/publish`, 'POST', { revision: created.revision })).body;
    const saved = (await env.request(`/api/rules/${created.id}`, 'PUT', {
      revision: published.revision,
      draft: { ...published.draft, name: '评审中的规则', description: '固定到变更集' },
    })).body;

    const response = await env.request('/api/change-sets', 'POST', {
      name: '国庆策略变更', description: '风险策略调整', items: [{ type: 'rule', id: created.id }],
    });
    assert.equal(response.status, 201);
    const changeSet = response.body;
    assert.equal(changeSet.status, 'DRAFT');
    assert.equal(changeSet.revision, 1);
    assert.equal(changeSet.items[0].assetRevision, saved.revision);
    assert.equal(changeSet.items[0].baseVersion, 1);
    assert.equal(changeSet.items[0].after.name, '评审中的规则');
    assert.ok(changeSet.items[0].changes.some(change => change.path === 'name'));

    await env.request(`/api/rules/${created.id}`, 'PUT', {
      revision: saved.revision,
      draft: { ...saved.draft, name: '变更集之后的修改' },
    });
    const unchanged = (await env.request(`/api/change-sets/${changeSet.id}`)).body;
    assert.equal(unchanged.items[0].after.name, '评审中的规则');

    const updated = await env.request(`/api/change-sets/${changeSet.id}`, 'PUT', {
      revision: 1, name: changeSet.name, description: '重新固定最新修订', items: [{ type: 'rule', id: created.id }],
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.revision, 2);
    assert.equal(updated.body.items[0].after.name, '变更集之后的修改');

    const stale = await env.request(`/api/change-sets/${changeSet.id}`, 'PUT', {
      revision: 1, name: '过期写入', description: '', items: [],
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.currentRevision, 2);

    const submitted = await env.request(`/api/change-sets/${changeSet.id}/submit`, 'POST', { revision: 2 });
    assert.equal(submitted.body.status, 'SUBMITTED');
    assert.equal(submitted.body.revision, 3);
    const editSubmitted = await env.request(`/api/change-sets/${changeSet.id}`, 'PUT', {
      revision: 3, name: changeSet.name, description: '', items: [],
    });
    assert.equal(editSubmitted.status, 409);

    const invalidReject = await env.request(`/api/change-sets/${changeSet.id}/reject`, 'POST', { revision: 3 });
    assert.equal(invalidReject.status, 400);
    const rejected = await env.request(`/api/change-sets/${changeSet.id}/reject`, 'POST', { revision: 3, comment: '请补充阈值依据' });
    assert.equal(rejected.body.status, 'REJECTED');
    const reopened = await env.request(`/api/change-sets/${changeSet.id}/reopen`, 'POST', { revision: 4 });
    assert.equal(reopened.body.status, 'DRAFT');
    const resubmitted = await env.request(`/api/change-sets/${changeSet.id}/submit`, 'POST', { revision: 5 });
    const approved = await env.request(`/api/change-sets/${changeSet.id}/approve`, 'POST', { revision: resubmitted.body.revision, comment: '验证通过' });
    assert.equal(approved.body.status, 'APPROVED');
    assert.equal(approved.body.decisionComment, '验证通过');

    const audit = await env.request('/api/audit-events?limit=20');
    assert.equal(audit.status, 200);
    assert.deepEqual(audit.body.filter(event => event.resourceType === 'change-set').map(event => event.action), [
      'change-set.approve', 'change-set.submit', 'change-set.reopen',
      'change-set.reject', 'change-set.submit', 'change-set.updated', 'change-set.created',
    ]);
    assert.ok(audit.body.some(event => event.action === 'asset.created' && event.resourceId === created.id));
    assert.ok(audit.body.some(event => event.action === 'asset.publish' && event.resourceId === created.id));
  } finally { await env.stop(); }
});

test('GOV-02: 空变更集不能提交且非法资产不能加入', async () => {
  const env = await startTestEnv();
  try {
    const missing = await env.request('/api/change-sets', 'POST', {
      name: '非法引用', items: [{ type: 'rule', id: 'missing' }],
    });
    assert.equal(missing.status, 400);
    const empty = (await env.request('/api/change-sets', 'POST', { name: '空变更集', items: [] })).body;
    const submitted = await env.request(`/api/change-sets/${empty.id}/submit`, 'POST', { revision: empty.revision });
    assert.equal(submitted.status, 400);

    const rule = (await env.request('/api/rules', 'POST')).body;
    const published = (await env.request(`/api/rules/${rule.id}/publish`, 'POST', { revision: rule.revision })).body;
    const unchanged = (await env.request('/api/change-sets', 'POST', {
      name: '无实际差异', items: [{ type: 'rule', id: published.id }],
    })).body;
    const noDiff = await env.request(`/api/change-sets/${unchanged.id}/submit`, 'POST', { revision: unchanged.revision });
    assert.equal(noDiff.status, 400);
    assert.match(noDiff.body.error, /没有实际差异/);
  } finally { await env.stop(); }
});

test('GOV-04: 变更集接受 kind 和 decision-table 类型别名', async () => {
  const env = await startTestEnv();
  try {
    const table = (await env.request('/api/tables', 'POST')).body;
    const response = await env.request('/api/change-sets', 'POST', {
      name: '决策表别名', items: [{ kind: 'decision-table', id: table.id }],
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.items[0].assetType, 'table');
  } finally { await env.stop(); }
});

test('GOV-03: JSON 审计并发追加不丢失且记录真实请求 actor', async () => {
  const env = await startTestEnv();
  try {
    const count = 20;
    const created = await Promise.all(Array.from({ length: count }, (_, index) =>
      env.request('/api/rules', 'POST', undefined, { 'x-actor': `author-${index}` })));
    assert.ok(created.every(response => response.status === 201));

    const changeSet = await env.request('/api/change-sets', 'POST', {
      name: '并发审计验证', items: [{ type: 'rule', id: created[0].body.id }],
    }, { 'x-actor': 'change-owner' });
    assert.equal(changeSet.status, 201);
    assert.equal(changeSet.body.createdBy, 'change-owner');

    const audit = await env.request('/api/audit-events?limit=100');
    const createdEvents = audit.body.filter(event => event.action === 'asset.created');
    assert.equal(createdEvents.length, count);
    assert.deepEqual(new Set(createdEvents.map(event => event.actor)),
      new Set(Array.from({ length: count }, (_, index) => `author-${index}`)));
    assert.ok(audit.body.some(event => event.action === 'change-set.created'
      && event.resourceId === changeSet.body.id && event.actor === 'change-owner'));
  } finally { await env.stop(); }
});
