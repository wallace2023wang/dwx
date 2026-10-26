import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { migrateJsonDeploymentDomain } from '../server/json-deployment-migration.js';
import { migrateLegacyDeployments } from '../shared/deployments.js';
import { startTestEnv } from './helpers.js';

async function publishRule(env) {
  const asset = (await env.request('/api/rules', 'POST')).body;
  return (await env.request(`/api/rules/${asset.id}/publish`, 'POST')).body;
}

test('DEPLOY-01: 部署写入独立账本且不修改 Release 文件', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishRule(env);
    const created = await env.request('/api/releases', 'POST', {
      decisionService: 'default/immutable', name: '不可变部署', target: { type: 'rule', id: rule.id },
    });
    const releaseFile = path.join(env.dir, 'releases.json');
    const before = await fs.readFile(releaseFile, 'utf8');
    const deployed = await env.request(`/api/projects/default/releases/${created.body.id}/deploy`, 'POST', { environment: 'local' });
    assert.equal(deployed.status, 200);
    assert.equal(await fs.readFile(releaseFile, 'utf8'), before);
    const ledger = (await env.request('/api/projects/default/deployments')).body;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].releaseId, created.body.id);
    assert.equal(ledger[0].status, 'active');
    assert.deepEqual(ledger[0].events.map(event => event.type), ['created', 'ready', 'activated']);
    assert.deepEqual((await env.request('/api/projects/default/environments')).body.map(item => item.id), ['local', 'test', 'production']);
    assert.equal((await env.request('/api/projects/default/deployments')).status, 200);
    assert.equal((await env.request('/api/projects/default/environments')).status, 200);
  } finally { await env.stop(); }
});

test('DEPLOY-04: 激活、回退和卸载保持 Release 不可变并记录完整事件', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishRule(env);
    const createRelease = name => env.request('/api/releases', 'POST', {
      decisionService: 'default/lifecycle', name, target: { type: 'rule', id: rule.id },
    });
    const first = await createRelease('生命周期 v1');
    const second = await createRelease('生命周期 v2');
    const releaseFile = path.join(env.dir, 'releases.json');
    const before = await fs.readFile(releaseFile, 'utf8');

    assert.equal((await env.request(`/api/projects/default/releases/${first.body.id}/deploy`, 'POST', { environment: 'local' })).status, 200);
    assert.equal((await env.request(`/api/projects/default/releases/${second.body.id}/deploy`, 'POST', { environment: 'local' })).status, 200);
    assert.equal((await env.request(`/api/projects/default/releases/${second.body.id}/activate`, 'POST', { environment: 'local' })).status, 200);
    assert.equal((await env.request(`/api/projects/default/releases/${second.body.id}/rollback`, 'POST', { environment: 'local' })).status, 200);
    assert.equal((await env.request(`/api/projects/default/releases/${second.body.id}/undeploy`, 'POST', { environment: 'local' })).status, 200);
    assert.equal(await fs.readFile(releaseFile, 'utf8'), before);

    const deployments = (await env.request('/api/projects/default/deployments')).body;
    assert.equal(deployments.filter(item => item.status === 'active').length, 1);
    assert.equal(deployments.find(item => item.status === 'active').releaseId, first.body.id);
    assert.equal(deployments.find(item => item.releaseId === second.body.id).status, 'stopped');
    assert.deepEqual(deployments.find(item => item.releaseId === first.body.id).events.map(event => event.type), [
      'created', 'ready', 'activated', 'deactivated', 'activated',
    ]);
    assert.deepEqual(deployments.find(item => item.releaseId === second.body.id).events.map(event => event.type), [
      'created', 'ready', 'activated', 'deactivated', 'stopped',
    ]);

    const releases = (await env.request('/api/projects/default/releases')).body;
    assert.equal(releases.find(item => item.id === first.body.id).deployments[0].status, 'active');
    assert.equal(releases.find(item => item.id === second.body.id).deployments[0].status, 'stopped');
  } finally { await env.stop(); }
});

test('DEPLOY-02: 历史双 active 迁移后只保留最新版本生效', () => {
  const releases = [1, 2].map(version => ({
    id: `release-${version}`,
    version,
    decisionService: 'default/unique-active',
    checksum: `sha256:${String(version).repeat(64)}`,
    createdAt: `2026-10-0${version}T00:00:00.000Z`,
    deployments: [{
      id: `local:release-${version}`, environment: 'local', status: 'active',
      deployedAt: `2026-10-0${version}T01:00:00.000Z`,
    }],
  }));
  const deployments = migrateLegacyDeployments(releases);
  assert.equal(deployments.filter(item => item.status === 'active').length, 1);
  assert.equal(deployments.find(item => item.status === 'active').releaseId, 'release-2');
  assert.equal(deployments.find(item => item.releaseId === 'release-1').status, 'ready');
});

test('DEPLOY-03: JSON 显式迁移幂等且清除 Release 内嵌部署', async () => {
  const env = await startTestEnv();
  try {
    const releasesFile = path.join(env.dir, 'legacy-releases.json');
    const deploymentsFile = path.join(env.dir, 'legacy-deployments.json');
    const environmentsFile = path.join(env.dir, 'legacy-environments.json');
    await fs.writeFile(releasesFile, JSON.stringify([{
      id: 'legacy-release', version: 1, decisionService: 'default/legacy', checksum: 'sha256:legacy',
      createdAt: '2026-10-01T00:00:00.000Z',
      deployments: [{ id: 'local:legacy-release', environment: 'local', status: 'active', deployedAt: '2026-10-01T01:00:00.000Z' }],
    }]));
    const input = { releasesFile, deploymentsFile, environmentsFile };
    await migrateJsonDeploymentDomain(input);
    const firstDeployments = await fs.readFile(deploymentsFile, 'utf8');
    await migrateJsonDeploymentDomain(input);
    assert.equal(await fs.readFile(deploymentsFile, 'utf8'), firstDeployments);
    assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(releasesFile, 'utf8'))[0], 'deployments'), false);
    assert.equal(JSON.parse(firstDeployments).length, 1);
  } finally { await env.stop(); }
});
