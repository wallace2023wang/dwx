import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { startTestEnv } from './helpers.js';

async function startTargetNode() {
  const calls = [];
  const routes = {};
  let failPrepare = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    calls.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/prepare') {
      if (failPrepare) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: 'mock node prewarm failed' }));
        return;
      }
      res.end(JSON.stringify({
        deploymentId: `node-two:${body.id}`,
        releaseId: body.id,
        checksum: body.checksum,
        deployedAt: '2026-10-09T10:00:00.000Z',
        engine: 'drools',
        engineVersion: '10.2.0',
        modelVersion: body.model?.version ?? null,
        state: 'ready',
      }));
      return;
    }
    if (req.url === '/activate') {
      const current = routes[body.decisionService];
      if (Number(current?.generation || 0) !== Number(body.expectedGeneration) && !(body.bootstrap && !current)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'generation CAS conflict', actualGeneration: current?.generation || 0 }));
        return;
      }
      routes[body.decisionService] = { releaseId: body.releaseId, generation: body.generation };
      res.end(JSON.stringify({
        ok: true,
        decisionService: body.decisionService,
        releaseId: body.releaseId,
        generation: body.generation,
        activatedAt: '2026-10-09T10:01:00.000Z',
      }));
      return;
    }
    if (req.url === '/status') {
      res.end(JSON.stringify({
        nodeId: 'node-two', status: 'ready', engine: 'Drools', engineVersion: '10.2.0',
        activeRoutes: routes, deployments: [], draining: [], observedAt: new Date().toISOString(),
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    calls,
    setFailPrepare(value) { failPrepare = value; },
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

async function releaseFixture(env, name) {
  const rule = (await env.request('/api/rules', 'POST')).body;
  assert.equal((await env.request(`/api/rules/${rule.id}/publish`, 'POST')).status, 200);
  const flow = (await env.request('/api/flows', 'POST')).body;
  assert.equal((await env.request(`/api/flows/${flow.id}`, 'PUT', {
    ...flow.draft, name: '多节点规则集', steps: [{ type: 'rule', id: rule.id }],
  })).status, 200);
  assert.equal((await env.request(`/api/flows/${flow.id}/publish`, 'POST')).status, 200);
  const release = await env.request('/api/projects/default/releases', 'POST', {
    decisionService: 'default/multi-target-service',
    name,
    target: { type: 'flow', id: flow.id },
  });
  assert.equal(release.status, 201);
  return release.body;
}

test('P2-TARGET-01: 全部 Target READY 后提交 generation，失败时保留旧代次', async () => {
  const node = await startTargetNode();
  const env = await startTestEnv();
  try {
    const projectMutation = await env.request('/api/projects/default/targets', 'POST', {
      name: '项目内节点', environmentId: 'local', engine: 'drools', endpoint: node.endpoint,
    });
    assert.equal(projectMutation.status, 403);
    assert.match(projectMutation.body.error, /系统管理/);
    const createdTarget = await env.request('/api/admin/targets', 'POST', {
      name: '规则 RES 节点 2', environmentId: 'local', engine: 'drools', endpoint: node.endpoint,
    });
    assert.equal(createdTarget.status, 201);
    const targets = await env.request('/api/projects/default/targets');
    assert.equal(targets.status, 200);
    assert.equal(targets.body.length, 2);

    const first = await releaseFixture(env, '多节点 v1');
    const createdPackage = await env.request('/api/projects/default/application-packages', 'POST', {
      name: '多节点应用包', releaseId: first.id,
    });
    assert.equal(createdPackage.status, 201);
    const firstManifest = createdPackage.body.manifests[0];
    const deployed = await env.request(`/api/projects/default/application-packages/${createdPackage.body.id}/deploy`, 'POST', {
      manifestId: firstManifest.id,
    });
    assert.equal(deployed.status, 200, JSON.stringify(deployed.body));
    assert.equal(deployed.body.activeManifestId, firstManifest.id);
    assert.ok(node.calls.some(call => call.path === '/prepare' && call.body.id === first.id));
    assert.ok(node.calls.some(call => call.path === '/activate' && call.body.generation === 1));

    const generations = await env.request('/api/projects/default/activation-generations');
    assert.equal(generations.status, 200);
    assert.equal(generations.body[0].status, 'active');
    assert.equal(generations.body[0].generation, 1);
    assert.equal(generations.body[0].targets.length, 2);
    assert.ok(generations.body[0].targets.every(state => state.status === 'active'));

    const reconciled = await env.request('/api/admin/targets/reconcile', 'POST');
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.length, 2);
    assert.ok(reconciled.body.every(target => target.status === 'ready'), JSON.stringify(reconciled.body));

    const second = await env.request('/api/projects/default/releases', 'POST', {
      decisionService: first.decisionService,
      name: '多节点 v2',
      target: first.target,
    });
    assert.equal(second.status, 201);
    const appended = await env.request(`/api/projects/default/application-packages/${createdPackage.body.id}/manifests`, 'POST', {
      releaseId: second.body.id,
    });
    assert.equal(appended.status, 201);
    const secondManifest = appended.body.manifests.find(item => item.releaseId === second.body.id);
    node.setFailPrepare(true);
    const failed = await env.request(`/api/projects/default/application-packages/${createdPackage.body.id}/deploy`, 'POST', {
      manifestId: secondManifest.id,
    });
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /未 READY/);

    const afterFailure = await env.request('/api/projects/default/activation-generations');
    assert.equal(afterFailure.body[0].status, 'failed');
    assert.equal(afterFailure.body[0].expectedGeneration, 1);
    assert.equal(afterFailure.body[1].status, 'active');
    assert.equal(afterFailure.body[1].releaseId, first.id);
    const currentPackage = (await env.request('/api/projects/default/application-packages')).body[0];
    assert.equal(currentPackage.activeManifestId, firstManifest.id);
  } finally {
    await env.stop();
    await node.stop();
  }
});

test('P2-TARGET-02: test 与 production 使用独立 Target、generation 和部署账本', async () => {
  const testNode = await startTargetNode();
  const productionNode = await startTargetNode();
  const env = await startTestEnv();
  try {
    for (const target of [
      { name: '测试 RES', environmentId: 'test', endpoint: testNode.endpoint },
      { name: '生产 RES', environmentId: 'production', endpoint: productionNode.endpoint },
    ]) {
      const created = await env.request('/api/admin/targets', 'POST', {
        ...target, engine: 'drools',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
    const otherProject = await env.request('/api/projects', 'POST', {
      name: '共享平台注册表项目', engine: 'rules', bomTemplate: 'risk',
    });
    assert.equal(otherProject.status, 201);
    const sharedTargets = await env.request(`/api/projects/${otherProject.body.id}/targets`);
    assert.equal(sharedTargets.status, 200);
    assert.deepEqual(
      new Set(sharedTargets.body.filter(target => ['test', 'production'].includes(target.environmentId)).map(target => target.endpoint)),
      new Set([testNode.endpoint, productionNode.endpoint]),
    );

    const release = await releaseFixture(env, '多环境 v1');
    const applicationPackage = await env.request('/api/projects/default/application-packages', 'POST', {
      name: '多环境应用包', releaseId: release.id,
    });
    assert.equal(applicationPackage.status, 201);
    const manifest = applicationPackage.body.manifests[0];

    for (const environment of ['test', 'production']) {
      const deployed = await env.request(`/api/projects/default/application-packages/${applicationPackage.body.id}/deploy`, 'POST', {
        manifestId: manifest.id, environment,
      });
      assert.equal(deployed.status, 200, JSON.stringify(deployed.body));
      assert.equal(deployed.body.activeManifestIds[environment], manifest.id);
    }

    assert.equal(testNode.calls.filter(call => call.path === '/prepare').length, 1);
    assert.equal(productionNode.calls.filter(call => call.path === '/prepare').length, 1);
    const generations = (await env.request('/api/projects/default/activation-generations')).body;
    assert.deepEqual(new Set(generations.map(item => item.environmentId)), new Set(['test', 'production']));
    assert.ok(generations.every(item => item.status === 'active' && item.generation === 1));
    const deployments = (await env.request('/api/projects/default/deployments')).body;
    assert.deepEqual(new Set(deployments.map(item => item.id)), new Set([`test:${release.id}`, `production:${release.id}`]));
    assert.ok(deployments.every(item => item.status === 'active'));

    const rejected = await env.request(`/api/projects/default/application-packages/${applicationPackage.body.id}/deploy`, 'POST', {
      manifestId: manifest.id, environment: 'missing',
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /环境不存在/);
  } finally {
    await env.stop();
    await testNode.stop();
    await productionNode.stop();
  }
});

test('P2-TARGET-03: Esper Target 使用 CEP health 与 deployments 接口完成对账', async () => {
  const env = await startTestEnv();
  try {
    const created = await env.request('/api/admin/targets', 'POST', {
      name: '本地 Esper RES', environmentId: 'local', engine: 'esper', endpoint: env.cepUrl,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const reconciled = await env.request('/api/admin/targets/reconcile', 'POST');
    assert.equal(reconciled.status, 200);
    const esper = reconciled.body.find(target => target.id === created.body.id);
    assert.equal(esper.status, 'ready', JSON.stringify(esper));
    assert.equal(esper.engineVersion, '8.8.0');
    assert.ok(env.cepCalls.some(call => call.path === '/health'));
    assert.ok(env.cepCalls.some(call => call.path === '/deployments'));
    assert.ok(!env.cepCalls.some(call => call.path === '/status'));
  } finally {
    await env.stop();
  }
});
