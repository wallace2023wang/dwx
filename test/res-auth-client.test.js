import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createServerConfig } from '../server/config.js';
import { createEngineClients } from '../server/engine-client.js';
import { callTarget } from '../server/target-runtime.js';

async function startRecorder() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'], body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

test('Drools RES management and execution clients use isolated URLs and credentials', async () => {
  const management = await startRecorder();
  const execution = await startRecorder();
  try {
    const clients = createEngineClients({
      rulesBuildUrl: execution.url,
      rulesResUrl: execution.url,
      rulesResManagementUrl: management.url,
      rulesResManagementApiKey: 'management-secret',
      rulesResExecutionApiKey: 'execution-secret',
      cepBuildUrl: execution.url,
      cepResUrl: execution.url,
      cepApiKey: '',
    });

    assert.deepEqual(await clients.executionServer('/status', undefined, 'rules', 'GET'), { result: { ok: true } });
    assert.deepEqual(await clients.executionServer('/execute', { facts: {} }, 'rules'), { result: { ok: true } });
    assert.equal(management.calls[0].path, '/status');
    assert.equal(management.calls[0].authorization, 'Bearer management-secret');
    assert.equal(execution.calls[0].path, '/execute');
    assert.equal(execution.calls[0].authorization, 'Bearer execution-secret');

    await callTarget({ endpoint: management.url }, '/status', null, 5_000, { bearer: 'management-secret' });
    assert.equal(management.calls[1].authorization, 'Bearer management-secret');
    await callTarget({ endpoint: management.url }, '/status', null, 5_000, { apiKey: 'cep-secret' });
    assert.equal(management.calls[2].apiKey, 'cep-secret');
    assert.equal(management.calls[2].authorization, undefined);
  } finally {
    await management.stop();
    await execution.stop();
  }
});

test('RES management URL keeps legacy single-port configuration compatible', () => {
  const legacy = createServerConfig({ RES_URL: 'http://legacy-res:8790' });
  assert.equal(legacy.rulesResUrl, 'http://legacy-res:8790');
  assert.equal(legacy.rulesResManagementUrl, 'http://legacy-res:8790');

  const isolated = createServerConfig({
    RULES_RES_URL: 'http://res:8790',
    RULES_RES_MANAGEMENT_URL: 'http://res:8793',
    RES_MANAGEMENT_API_KEY: 'management-secret',
    RES_EXECUTION_API_KEY: 'execution-secret',
  });
  assert.equal(isolated.rulesResManagementUrl, 'http://res:8793');
  assert.equal(isolated.rulesResManagementApiKey, 'management-secret');
  assert.equal(isolated.rulesResExecutionApiKey, 'execution-secret');
});
