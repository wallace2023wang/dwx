import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('draft, publish, restore and export are isolated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-api-'));
  process.env.RULES_DATA_FILE = path.join(dir, 'rules.json');
  process.env.RULES_TABLES_FILE = path.join(dir, 'tables.json');
  process.env.RULES_FLOWS_FILE = path.join(dir, 'flows.json');
  process.env.RULES_RELEASES_FILE = path.join(dir, 'releases.json');
  let engineStatus = 200;
  const calls = [];
  const engine = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: JSON.parse(body) });
    res.writeHead(engineStatus, { 'content-type': 'application/json' });
    const testNumber = calls.filter(call => call.path === '/test').length;
    res.end(JSON.stringify(engineStatus === 200
      ? req.url === '/compile'
        ? { ok: true, version: '10.2.0' }
        : { ok: true, fired: ['新规则 [1]'], count: 1, facts: testNumber === 4 ? {} : { riskLevel: '中' } }
      : { ok: false, errors: ['Drools 编译失败'] }));
  });
  await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
  process.env.ENGINE_URL = `http://127.0.0.1:${engine.address().port}`;
  const resCalls = [];
  const executionServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    resCalls.push({ path: req.url, body: payload });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/deploy') {
      res.end(JSON.stringify({ deploymentId: `local:${payload.id}`, releaseId: payload.id, deployedAt: '2026-09-29T01:00:00.000Z', checksum: payload.checksum, steps: payload.steps.length }));
    } else {
      res.end(JSON.stringify({ ok: true, releaseId: payload.releaseId, requestId: payload.requestId || 'generated', count: 2, facts: { ...payload.facts, riskLevel: '高' }, trace: [] }));
    }
  });
  await new Promise(resolve => executionServer.listen(0, '127.0.0.1', resolve));
  process.env.RES_URL = `http://127.0.0.1:${executionServer.address().port}`;
  const { handler } = await import('../server/index.js');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: response.status, body: response.headers.get('content-type').includes('json') ? await response.json() : await response.text() };
  };
  try {
    const created = (await request('/api/rules', 'POST')).body;
    const id = created.id;
    const edited = { ...created.draft, name: '新规则', actions: [{ field: 'riskLevel', value: '中' }] };
    assert.equal((await request(`/api/rules/${id}`, 'PUT', edited)).status, 200);
    assert.equal((await request('/api/export')).body.includes('新规则'), false);
    assert.equal((await request(`/api/rules/${id}/test`, 'POST', { facts: { creditScore: '600' } })).status, 400);
    const trial = await request(`/api/rules/${id}/test`, 'POST', { facts: { creditScore: 600 } });
    assert.equal(trial.status, 200);
    assert.equal(trial.body.count, 1);
    assert.equal(calls.at(-1).path, '/test');
    assert.match(calls.at(-1).body.drl, /新规则/);
    engineStatus = 422;
    assert.equal((await request(`/api/rules/${id}/publish`, 'POST')).status, 422);
    assert.equal((await request('/api/export')).body.includes('新规则'), false);
    engineStatus = 200;
    const published = (await request(`/api/rules/${id}/publish`, 'POST')).body;
    assert.equal(published.versions.length, 1);
    assert.equal(published.versions[0].engineVersion, '10.2.0');
    assert.equal(published.versions[0].bomVersion, 1);
    assert.equal(published.versions[0].bom.version, 1);
    assert.match(published.versions[0].drl, /declare RuleInput/);
    assert.match((await request('/api/export')).body, /新规则/);
    const table = (await request('/api/tables', 'POST')).body;
    const tablePublished = await request(`/api/tables/${table.id}/publish`, 'POST');
    assert.equal(tablePublished.status, 200);
    assert.equal(tablePublished.body.versions[0].engineVersion, '10.2.0');
    assert.equal(tablePublished.body.versions[0].bomVersion, 1);
    assert.match(tablePublished.body.versions[0].drl, /未命名决策表 第1行/);
    const tableTrial = await request(`/api/tables/${table.id}/test`, 'POST', { facts: { creditScore: 500, overdue: true } });
    assert.equal(tableTrial.status, 200);
    assert.equal(tableTrial.body.count, 1);
    assert.equal(tableTrial.body.hitPolicy, 'COLLECT');
    assert.ok(Array.isArray(tableTrial.body.decisionHits));
    assert.equal(tableTrial.body.decisionTrace.length, 1);
    const flow = (await request('/api/flows', 'POST')).body;
    const flowDraft = { ...flow.draft, name: '客户风控流', steps: [{ type: 'rule', id }, { type: 'table', id: table.id }] };
    assert.equal((await request(`/api/flows/${flow.id}`, 'PUT', flowDraft)).status, 200);
    const flowPublished = await request(`/api/flows/${flow.id}/publish`, 'POST');
    assert.equal(flowPublished.status, 200);
    assert.equal(flowPublished.body.published.steps.length, 2);
    const flowTrial = await request(`/api/flows/${flow.id}/test`, 'POST', { published: true, facts: { customerAge: 20, creditScore: 500, overdue: true } });
    assert.equal(flowTrial.status, 200);
    assert.equal(flowTrial.body.trace.length, 2);
    assert.equal(flowTrial.body.trace[0].fired.length, 1);
    assert.equal(flowTrial.body.facts.riskLevel, '中');
    const releaseCreated = await request('/api/releases', 'POST', {
      decisionService: 'default/customer-risk', name: '客户风控发布', description: 'API 测试',
      target: { type: 'flow', id: flow.id },
    });
    assert.equal(releaseCreated.status, 201);
    assert.equal(releaseCreated.body.version, 1);
    assert.equal(releaseCreated.body.steps.length, 2);
    assert.match(releaseCreated.body.checksum, /^sha256:[a-f0-9]{64}$/);
    const releaseId = releaseCreated.body.id;
    assert.equal((await request(`/api/releases/${releaseId}/execute`, 'POST', { facts: { creditScore: 500 } })).status, 409);
    const deployed = await request(`/api/releases/${releaseId}/deploy`, 'POST', { environment: 'local' });
    assert.equal(deployed.status, 200);
    assert.equal(deployed.body.deployments.length, 1);
    assert.equal(resCalls.at(-1).path, '/deploy');
    const releaseTrial = await request(`/api/releases/${releaseId}/execute`, 'POST', { requestId: 'req-1', facts: { creditScore: 500 } });
    assert.equal(releaseTrial.status, 200);
    assert.equal(releaseTrial.body.facts.riskLevel, '高');
    assert.equal(resCalls.at(-1).body.releaseId, releaseId);
    assert.match((await request('/api/export')).body, /未命名决策表 第1行/);
    await request(`/api/rules/${id}`, 'PUT', { ...edited, name: '变更草稿' });
    assert.equal((await request('/api/export')).body.includes('变更草稿'), false);
    const restored = (await request(`/api/rules/${id}/restore`, 'POST', { version: 1 })).body;
    assert.equal(restored.draft.name, '新规则');
    await new Promise(resolve => engine.close(resolve));
    assert.equal((await request(`/api/rules/${id}/publish`, 'POST')).status, 503);
    assert.equal((await request('/api/export')).body.includes('新规则'), true);
    assert.equal((await request(`/api/rules/${id}/archive`, 'POST')).status, 200);
    assert.equal((await request('/api/export')).body.includes('新规则'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (engine.listening) await new Promise(resolve => engine.close(resolve));
    if (executionServer.listening) await new Promise(resolve => executionServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
    delete process.env.RULES_DATA_FILE;
    delete process.env.RULES_TABLES_FILE;
    delete process.env.RULES_FLOWS_FILE;
    delete process.env.RULES_RELEASES_FILE;
    delete process.env.ENGINE_URL;
    delete process.env.RES_URL;
  }
});
