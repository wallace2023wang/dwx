import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

test('LOCK-01: 规则草稿使用 revision 阻止过期客户端覆盖', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/rules', 'POST')).body;
    assert.equal(created.revision, 1);
    assert.equal(created.revisions[0].reason, 'created');

    const first = await env.request(`/api/rules/${created.id}`, 'PUT', {
      revision: 1, draft: { ...created.draft, name: '客户端 A 修改' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 2);
    assert.equal(first.body.revisions.at(-1).reason, 'saved');

    const stale = await env.request(`/api/rules/${created.id}`, 'PUT', {
      revision: 1, draft: { ...created.draft, name: '客户端 B 过期修改' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.currentRevision, 2);
    assert.equal(stale.body.expectedRevision, 1);
    assert.match(stale.body.error, /客户端 r1.*服务器最新 r2/);
    assert.equal(stale.body.current.draft.name, '客户端 A 修改');
    assert.equal((await env.request('/api/rules')).body.find(item => item.id === created.id).draft.name, '客户端 A 修改');
  } finally { await env.stop(); }
});

test('LOCK-02: 发布和恢复同样校验资产 revision', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/tables', 'POST')).body;
    const published = await env.request(`/api/tables/${created.id}/publish`, 'POST', { revision: created.revision });
    assert.equal(published.status, 200);
    assert.equal(published.body.revision, 2);

    const stalePublish = await env.request(`/api/tables/${created.id}/publish`, 'POST', { revision: 1 });
    assert.equal(stalePublish.status, 409);
    assert.equal(stalePublish.body.currentRevision, 2);

    const restored = await env.request(`/api/tables/${created.id}/restore`, 'POST', { version: 1, revision: 2 });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.revision, 3);
    assert.equal(restored.body.revisions.at(-1).reason, 'restored');
  } finally { await env.stop(); }
});

test('LOCK-03: 测试套件和 BOM 返回结构化冲突', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST', { revision: rule.revision });
    const suite = (await env.request('/api/test-suites', 'POST', {
      name: '并发测试套件', description: '', target: { type: 'rule', id: rule.id }, required: false,
      cases: [{ id: 'one', name: '案例', enabled: true, facts: {}, expected: { outputs: { riskLevel: '中' }, fired: [] } }],
    })).body;
    assert.equal(suite.revision, 1);
    const updated = await env.request(`/api/test-suites/${suite.id}`, 'PUT', { ...suite, name: '客户端 A' });
    assert.equal(updated.body.revision, 2);
    const stale = await env.request(`/api/test-suites/${suite.id}`, 'PUT', { ...suite, name: '客户端 B' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.currentRevision, 2);

    const bom = (await env.request('/api/bom')).body;
    assert.equal((await env.request('/api/bom', 'PUT', { version: bom.version, fields: bom.fields })).status, 200);
    const staleBom = await env.request('/api/bom', 'PUT', { version: bom.version, fields: bom.fields });
    assert.equal(staleBom.status, 409);
    assert.equal(staleBom.body.currentRevision, bom.version + 1);
  } finally { await env.stop(); }
});
