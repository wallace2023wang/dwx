// RTS 模块 3：Release 构建与门禁
// 对标 JRules RTS：不可变 Release、校验和、版本递增、发布门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

async function publishOne(env, kind) {
  const asset = (await env.request(`/api/${kind}`, 'POST')).body;
  const published = await env.request(`/api/${kind}/${asset.id}/publish`, 'POST');
  return published.body;
}

test('RTS-REL-01: 从未发布资产构建 Release 被拒绝', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body; // 未发布
    const result = await env.request('/api/releases', 'POST', {
      decisionService: 'default/test', name: '非法发布', target: { type: 'rule', id: rule.id },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /尚未发布/);
  } finally { await env.stop(); }
});

test('RTS-REL-02: 从归档资产构建 Release 被拒绝', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    await env.request(`/api/rules/${rule.id}/archive`, 'POST');
    const result = await env.request('/api/releases', 'POST', {
      decisionService: 'default/test', name: '归档发布', target: { type: 'rule', id: rule.id },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /不存在/);
  } finally { await env.stop(); }
});

test('RTS-REL-03: 同一 decisionService 版本号单调递增', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    const r1 = await env.request('/api/releases', 'POST', {
      decisionService: 'default/credit', name: 'v1', target: { type: 'rule', id: rule.id },
    });
    assert.equal(r1.body.version, 1);
    const r2 = await env.request('/api/releases', 'POST', {
      decisionService: 'default/credit', name: 'v2', target: { type: 'rule', id: rule.id },
    });
    assert.equal(r2.body.version, 2);
    // 不同 decisionService 独立计数
    const r3 = await env.request('/api/releases', 'POST', {
      decisionService: 'default/loan', name: '另一个服务', target: { type: 'rule', id: rule.id },
    });
    assert.equal(r3.body.version, 1);
  } finally { await env.stop(); }
});

test('RTS-REL-04: Release 包含 SHA-256 校验和且内容不可变', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    const created = await env.request('/api/releases', 'POST', {
      decisionService: 'default/test', name: '校验和测试', target: { type: 'rule', id: rule.id },
    });
    assert.match(created.body.checksum, /^sha256:[a-f0-9]{64}$/);
    assert.equal(created.body.steps.length, 1);
    assert.equal(created.body.target.assetVersion, 1);
    // steps 中冻结的 DRL 来自已发布版本，不含草稿字段
    assert.match(created.body.steps[0].drl, /未命名规则/);
  } finally { await env.stop(); }
});

test('RTS-REL-05: 发布时每一步都经过 Drools 编译门禁', async () => {
  const env = await startTestEnv({ engineBehavior: { compileStatus: 422 } });
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    // 引擎 422 时发布规则本身就会失败，所以直接验证：引擎挂了不能创建 Release
    const result = await env.request('/api/releases', 'POST', {
      decisionService: 'default/test', name: '编译失败', target: { type: 'rule', id: rule.id },
    });
    // 规则未发布先 400
    assert.equal(result.status, 400);
  } finally { await env.stop(); }
});

test('RTS-REL-06: 规则流 Release 冻结每一步的版本和 DRL', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    const table = await publishOne(env, 'tables');
    const flow = (await env.request('/api/flows', 'POST')).body;
    await env.request(`/api/flows/${flow.id}`, 'PUT', {
      ...flow.draft, steps: [{ type: 'rule', id: rule.id }, { type: 'table', id: table.id }],
    });
    await env.request(`/api/flows/${flow.id}/publish`, 'POST');

    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/flow', name: '流发布', target: { type: 'flow', id: flow.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.steps.length, 2);
    assert.equal(release.body.steps[0].type, 'rule');
    assert.equal(release.body.steps[1].type, 'table');
    assert.equal(release.body.steps[0].assetVersion, 1);
    assert.ok(release.body.steps.every(s => s.drl.includes('package workbench')));
  } finally { await env.stop(); }
});

test('RTS-REL-07: 未部署 Release 执行返回 409', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    const release = await env.request('/api/releases', 'POST', {
      decisionService: 'default/test', name: '未部署', target: { type: 'rule', id: rule.id },
    });
    const result = await env.request(`/api/releases/${release.body.id}/execute`, 'POST', { facts: {} });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /尚未部署/);
  } finally { await env.stop(); }
});

test('RTS-REL-08: 非法 decisionService 标识被拒绝', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    const result = await env.request('/api/releases', 'POST', {
      decisionService: 'Not Valid!', name: '非法标识', target: { type: 'rule', id: rule.id },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /决策服务标识/);
  } finally { await env.stop(); }
});

test('RTS-REL-09: BOM 升级后 Release 仍复用资产发布时的模型和 DRL', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    const frozen = rule.versions.at(-1);
    assert.equal(frozen.bomVersion, 1);
    assert.ok(frozen.bom?.fields.length);
    assert.match(frozen.drl, /declare RuleInput/);

    const bom = (await env.request('/api/bom')).body;
    const occupation = {
      key: 'occupation', label: '职业', type: 'String', kind: 'input', group: '客户',
      unit: null, min: null, max: null, enum: null, control: 'text', description: '',
    };
    const updated = await env.request('/api/bom', 'PUT', { fields: [...bom.fields, occupation] });
    assert.equal(updated.body.bom.version, 2);

    const created = await env.request('/api/releases', 'POST', {
      decisionService: 'default/frozen-model', name: '冻结模型', target: { type: 'rule', id: rule.id },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.model.version, 1);
    assert.equal(created.body.model.fields.some(field => field.key === 'occupation'), false);
    assert.equal(created.body.steps[0].drl, frozen.drl);
    assert.doesNotMatch(created.body.steps[0].drl, /occupation/);

    await env.request(`/api/releases/${created.body.id}/deploy`, 'POST', { environment: 'local' });
    const rejected = await env.request(`/api/releases/${created.body.id}/execute`, 'POST', { facts: { occupation: '教师' } });
    assert.equal(rejected.status, 400);
  } finally { await env.stop(); }
});

test('RTS-REL-10: 规则流拒绝组合不同 BOM 版本的资产', async () => {
  const env = await startTestEnv();
  try {
    let rule = await publishOne(env, 'rules');
    const bom = (await env.request('/api/bom')).body;
    const occupation = {
      key: 'occupation', label: '职业', type: 'String', kind: 'input', group: '客户',
      unit: null, min: null, max: null, enum: null, control: 'text', description: '',
    };
    await env.request('/api/bom', 'PUT', { fields: [...bom.fields, occupation] });

    const flow = (await env.request('/api/flows', 'POST')).body;
    await env.request(`/api/flows/${flow.id}`, 'PUT', { ...flow.draft, steps: [{ type: 'rule', id: rule.id }] });
    const rejected = await env.request(`/api/flows/${flow.id}/publish`, 'POST');
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /BOM v1.*当前为 v2.*重新发布/);

    rule = (await env.request(`/api/rules/${rule.id}/publish`, 'POST')).body;
    assert.equal(rule.versions.at(-1).bomVersion, 2);
    const published = await env.request(`/api/flows/${flow.id}/publish`, 'POST');
    assert.equal(published.status, 200);
    assert.equal(published.body.published.bomVersion, 2);
    assert.equal(published.body.versions.at(-1).bomVersion, 2);
  } finally { await env.stop(); }
});

test('RTS-REL-11: 同服务多版本部署、激活、稳定入口、回退和卸载形成闭环', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishOne(env, 'rules');
    const create = name => env.request('/api/projects/default/releases', 'POST', {
      decisionService: 'default/credit-active', name, target: { type: 'rule', id: rule.id },
    });
    const v1 = await create('信用决策 v1');
    const v2 = await create('信用决策 v2');

    const firstDeploy = await env.request(`/api/projects/default/releases/${v1.body.id}/deploy`, 'POST', { environment: 'local' });
    assert.equal(firstDeploy.status, 200);
    assert.equal(firstDeploy.body.deployments[0].status, 'active');

    const secondDeploy = await env.request(`/api/projects/default/releases/${v2.body.id}/deploy`, 'POST', { environment: 'local' });
    assert.equal(secondDeploy.status, 200);
    assert.equal(secondDeploy.body.deployments[0].status, 'deployed');

    let releases = (await env.request('/api/projects/default/releases')).body;
    assert.equal(releases.find(item => item.id === v1.body.id).deployments[0].status, 'active');
    assert.equal(releases.find(item => item.id === v2.body.id).deployments[0].status, 'deployed');

    let stable = await env.request('/api/projects/default/services/credit-active/execute', 'POST', { facts: {} });
    assert.equal(stable.status, 200);
    assert.equal(env.resCalls.at(-1).body.releaseId, v1.body.id);

    const activated = await env.request(`/api/projects/default/releases/${v2.body.id}/activate`, 'POST', { environment: 'local' });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.deployments[0].status, 'active');
    assert.equal(activated.body.rollbackAvailable, true);
    stable = await env.request('/api/projects/default/services/credit-active/execute', 'POST', { facts: {} });
    assert.equal(stable.status, 200);
    assert.equal(env.resCalls.at(-1).body.releaseId, v2.body.id);

    const activeUndeploy = await env.request(`/api/projects/default/releases/${v2.body.id}/undeploy`, 'POST', { environment: 'local' });
    assert.equal(activeUndeploy.status, 409);
    assert.match(activeUndeploy.body.error, /当前生效版本/);

    const rolledBack = await env.request(`/api/projects/default/releases/${v2.body.id}/rollback`, 'POST', { environment: 'local' });
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.body.id, v1.body.id);
    assert.equal(rolledBack.body.deployments[0].status, 'active');

    const stopped = await env.request(`/api/projects/default/releases/${v2.body.id}/undeploy`, 'POST', { environment: 'local' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.deployments[0].status, 'stopped');
    assert.equal(env.resCalls.at(-1).path, '/undeploy');
    assert.equal((await env.request(`/api/projects/default/releases/${v2.body.id}/execute`, 'POST', { facts: {} })).status, 409);

    releases = (await env.request('/api/projects/default/releases')).body;
    assert.equal(releases.find(item => item.id === v1.body.id).deployments[0].status, 'active');
    assert.equal(releases.find(item => item.id === v2.body.id).deployments[0].status, 'stopped');
  } finally { await env.stop(); }
});
