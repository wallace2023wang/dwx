// RTS 模块 1：资产仓库与版本管理
// 对标 JRules RTS：草稿/已发布分离、版本快照、恢复历史、归档、发布门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

test('RTS-ASSET-01: 草稿保存不影响已发布版本，发布后版本号递增', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/rules', 'POST')).body;
    const id = created.id;
    // v1 发布
    const v1 = await env.request(`/api/rules/${id}/publish`, 'POST');
    assert.equal(v1.status, 200);
    assert.equal(v1.body.versions.length, 1);
    assert.equal(v1.body.published.name, '未命名规则');

    // 修改草稿并再次发布 → v2
    await env.request(`/api/rules/${id}`, 'PUT', { ...v1.body.draft, name: '修改后规则' });
    const v2 = await env.request(`/api/rules/${id}/publish`, 'POST');
    assert.equal(v2.status, 200);
    assert.equal(v2.body.versions.length, 2);
    assert.equal(v2.body.versions[1].number, 2);
    assert.equal(v2.body.published.name, '修改后规则');
  } finally { await env.stop(); }
});

test('RTS-ASSET-02: 发布门禁——Drools 编译失败时拒绝发布，草稿不被污染', async () => {
  const env = await startTestEnv({ engineBehavior: { compileStatus: 422 } });
  try {
    const created = (await env.request('/api/rules', 'POST')).body;
    const result = await env.request(`/api/rules/${created.id}/publish`, 'POST');
    assert.equal(result.status, 422);
    // 发布失败后 published 仍为 null，版本数为 0
    const after = (await env.request('/api/rules')).body.find(r => r.id === created.id);
    assert.equal(after.published, null);
    assert.equal(after.versions.length, 0);
  } finally { await env.stop(); }
});

test('RTS-ASSET-03: 恢复历史版本只改草稿，不影响已发布版本', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/rules', 'POST')).body;
    const id = created.id;
    // v1
    await env.request(`/api/rules/${id}/publish`, 'POST');
    // 改成 v2 并发布
    await env.request(`/api/rules/${id}`, 'PUT', { ...created.draft, name: 'v2 名称' });
    await env.request(`/api/rules/${id}/publish`, 'POST');

    // 恢复 v1 → 草稿变 v1，但 published 仍是 v2
    const restored = await env.request(`/api/rules/${id}/restore`, 'POST', { version: 1 });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.draft.name, '未命名规则');
    assert.equal(restored.body.published.name, 'v2 名称');
    assert.equal(restored.body.versions.length, 2);
  } finally { await env.stop(); }
});

test('RTS-ASSET-04: 归档后资产不出现在 DRL 导出中', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${created.id}/publish`, 'POST');
    // 导出应包含
    assert.match(await (await env.request('/api/export')).body, /未命名规则/);
    // 归档
    const archived = await env.request(`/api/rules/${created.id}/archive`, 'POST');
    assert.equal(archived.status, 200);
    // 导出不再包含
    const exported = await (await env.request('/api/export')).body;
    assert.doesNotMatch(exported, /未命名规则/);
  } finally { await env.stop(); }
});

test('RTS-ASSET-05: 规则集引用未发布资产被拒绝', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body; // 未发布
    const flow = (await env.request('/api/flows', 'POST')).body;
    const result = await env.request(`/api/flows/${flow.id}`, 'PUT', {
      ...flow.draft, steps: [{ type: 'rule', id: rule.id }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /引用的资产不存在或未发布/);
  } finally { await env.stop(); }
});

test('RTS-ASSET-06: 规则集引用归档资产被拒绝', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    await env.request(`/api/rules/${rule.id}/archive`, 'POST');

    const flow = (await env.request('/api/flows', 'POST')).body;
    const result = await env.request(`/api/flows/${flow.id}`, 'PUT', {
      ...flow.draft, steps: [{ type: 'rule', id: rule.id }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /引用的资产不存在或未发布/);
  } finally { await env.stop(); }
});

test('RTS-ASSET-07: 决策表独立编译发布，导出 DRL 包含规则与决策表', async () => {
  const env = await startTestEnv();
  try {
    // 先发布一条规则
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');

    // 发布决策表
    const table = (await env.request('/api/tables', 'POST')).body;
    const published = await env.request(`/api/tables/${table.id}/publish`, 'POST');
    assert.equal(published.status, 200);

    // 导出应同时包含规则和决策表行
    const exported = await (await env.request('/api/export')).body;
    assert.match(exported, /未命名规则/);
    assert.match(exported, /未命名决策表 第1行/);
  } finally { await env.stop(); }
});

test('RTS-ASSET-08: 修改未发布草稿不影响已发布快照和导出', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');
    // 草稿改名但不发布
    await env.request(`/api/rules/${rule.id}`, 'PUT', { ...rule.draft, name: '草稿改名不发布' });
    const exported = await (await env.request('/api/export')).body;
    assert.doesNotMatch(exported, /草稿改名不发布/);
    assert.match(exported, /未命名规则/);
  } finally { await env.stop(); }
});
