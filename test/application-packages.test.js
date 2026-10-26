import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startTestEnv } from './helpers.js';

async function publishedFlow(env, name = '应用包规则集') {
  const rule = (await env.request('/api/rules', 'POST')).body;
  assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);
  const flow = (await env.request('/api/flows', 'POST')).body;
  assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', {
    ...flow.draft, name, steps: [{ type: 'rule', id: rule.id }],
  })).status, 200);
  assert.equal((await env.request(`/api/flows/${flow.id}/publish`, 'POST')).status, 200);
  return flow;
}

async function releaseFor(env, flowId, name) {
  const result = await env.request('/api/projects/default/releases', 'POST', {
    decisionService: 'default/application-service',
    name,
    target: { type: 'flow', id: flowId },
  });
  assert.equal(result.status, 201);
  return result.body;
}

test('APP-PKG-01: manifest 固定服务、规则集、引擎和 Release checksum', async () => {
  const env = await startTestEnv();
  try {
    const flow = await publishedFlow(env);
    const first = await releaseFor(env, flow.id, '应用包 v1');
    const second = await releaseFor(env, flow.id, '应用包 v2');

    const created = await env.request('/api/projects/default/application-packages', 'POST', {
      name: '授信决策应用', releaseId: first.id,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.decisionService, first.decisionService);
    assert.equal(created.body.rulesetPath, flow.id);
    assert.equal(created.body.engine, 'drools');
    assert.equal(created.body.manifests.length, 1);
    assert.equal(created.body.manifests[0].releaseChecksum, first.checksum);
    assert.match(created.body.manifests[0].checksum, /^sha256:[a-f0-9]{64}$/);

    const duplicate = await env.request('/api/projects/default/application-packages', 'POST', {
      name: '重复应用', releaseId: second.id,
    });
    assert.equal(duplicate.status, 409);

    const appended = await env.request(`/api/projects/default/application-packages/${created.body.id}/manifests`, 'POST', {
      releaseId: second.id,
    });
    assert.equal(appended.status, 201);
    assert.deepEqual(appended.body.manifests.map(item => item.version), [2, 1]);
    assert.deepEqual(appended.body.manifests.map(item => item.releaseId), [second.id, first.id]);

    const repeated = await env.request(`/api/projects/default/application-packages/${created.body.id}/manifests`, 'POST', {
      releaseId: second.id,
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.manifests.length, 2);

    const otherFlow = await publishedFlow(env, '另一个规则集');
    const incompatible = await env.request('/api/projects/default/releases', 'POST', {
      decisionService: first.decisionService,
      name: '错误路径 Release',
      target: { type: 'flow', id: otherFlow.id },
    });
    assert.equal(incompatible.status, 201);
    const rejected = await env.request(`/api/projects/default/application-packages/${created.body.id}/manifests`, 'POST', {
      releaseId: incompatible.body.id,
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /固定的决策服务、目标路径或执行引擎不一致/);

    const packageFile = path.join(env.dir, 'application-packages.json');
    const corrupted = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    corrupted[0].manifests[0].releaseChecksum = `sha256:${'0'.repeat(64)}`;
    await fs.writeFile(packageFile, JSON.stringify(corrupted, null, 2));
    const resCallsBefore = env.resCalls.length;
    const tampered = await env.request(`/api/projects/default/application-packages/${created.body.id}/deploy`, 'POST', {
      manifestId: created.body.manifests[0].id,
    });
    assert.equal(tampered.status, 409);
    assert.match(tampered.body.error, /manifest 校验和不匹配/);
    assert.equal(env.resCalls.length, resCallsBefore);
  } finally { await env.stop(); }
});

test('APP-PKG-02: 应用包部署和回退原子切换 manifest 且不修改 Release', async () => {
  const env = await startTestEnv();
  try {
    const flow = await publishedFlow(env);
    const first = await releaseFor(env, flow.id, '应用包 v1');
    const second = await releaseFor(env, flow.id, '应用包 v2');
    const releaseFile = path.join(env.dir, 'releases.json');
    const immutableReleases = await fs.readFile(releaseFile, 'utf8');
    const created = await env.request('/api/projects/default/application-packages', 'POST', {
      name: '授信决策应用', releaseId: first.id,
    });
    const appended = await env.request(`/api/projects/default/application-packages/${created.body.id}/manifests`, 'POST', {
      releaseId: second.id,
    });
    const firstManifest = appended.body.manifests.find(item => item.releaseId === first.id);
    const secondManifest = appended.body.manifests.find(item => item.releaseId === second.id);

    const deployedFirst = await env.request(`/api/projects/default/application-packages/${created.body.id}/deploy`, 'POST', {
      manifestId: firstManifest.id, environment: 'local',
    });
    assert.equal(deployedFirst.status, 200);
    assert.equal(deployedFirst.body.activeManifestId, firstManifest.id);

    const deployedSecond = await env.request(`/api/projects/default/application-packages/${created.body.id}/deploy`, 'POST', {
      manifestId: secondManifest.id, environment: 'local',
    });
    assert.equal(deployedSecond.status, 200);
    assert.equal(deployedSecond.body.activeManifestId, secondManifest.id);
    assert.ok(env.resCalls.some(call => call.path === '/activate' && call.body.releaseId === second.id));

    const rolledBack = await env.request(`/api/projects/default/application-packages/${created.body.id}/rollback`, 'POST', {
      environment: 'local',
    });
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.body.activeManifestId, firstManifest.id);
    assert.ok(env.resCalls.some(call => call.path === '/activate' && call.body.releaseId === first.id));
    assert.equal(await fs.readFile(releaseFile, 'utf8'), immutableReleases);

    const deployments = (await env.request('/api/projects/default/deployments')).body;
    assert.equal(deployments.filter(item => item.status === 'active').length, 1);
    assert.equal(deployments.find(item => item.status === 'active').releaseId, first.id);
  } finally { await env.stop(); }
});

test('APP-PKG-03: 激活失败时保留旧 active manifest', async () => {
  const env = await startTestEnv({ resBehavior: { activateStatuses: [200, 503] } });
  try {
    const flow = await publishedFlow(env);
    const first = await releaseFor(env, flow.id, '应用包 v1');
    const second = await releaseFor(env, flow.id, '应用包 v2');
    const created = await env.request('/api/projects/default/application-packages', 'POST', {
      name: '授信决策应用', releaseId: first.id,
    });
    const appended = await env.request(`/api/projects/default/application-packages/${created.body.id}/manifests`, 'POST', {
      releaseId: second.id,
    });
    const firstManifest = appended.body.manifests.find(item => item.releaseId === first.id);
    const secondManifest = appended.body.manifests.find(item => item.releaseId === second.id);
    assert.equal((await env.request(`/api/projects/default/application-packages/${created.body.id}/deploy`, 'POST', {
      manifestId: firstManifest.id,
    })).status, 200);

    const failed = await env.request(`/api/projects/default/application-packages/${created.body.id}/deploy`, 'POST', {
      manifestId: secondManifest.id,
    });
    assert.equal(failed.status, 502);
    const current = (await env.request('/api/projects/default/application-packages')).body[0];
    assert.equal(current.activeManifestId, firstManifest.id);
    const secondState = current.manifests.find(item => item.id === secondManifest.id).deployment.status;
    assert.equal(secondState, 'ready');
  } finally { await env.stop(); }
});
