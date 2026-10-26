// 测试辅助：启动临时 Team Server + mock Drools Build Service + mock RES。
// 每个测试用例用独立临时目录，互不污染。
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runEventStream } from '../shared/event-streams.js';

/**
 * 启动一个隔离的测试环境。
 * @param {object} options
 * @param {object} options.engineBehavior - { compileStatus, testFacts } 控制 mock engine 行为
 * @param {object} options.resBehavior - { deployStatus, executeFacts } 控制 mock RES 行为
 * @returns {Promise<{base, request, stop, dir, engineCalls, resCalls}>}
 */
export async function startTestEnv(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-test-'));
  delete process.env.DATABASE_URL;
  if (options.auth) {
    process.env.AUTH_MODE = options.auth.mode;
    process.env.OIDC_ISSUER = options.auth.issuer;
    process.env.OIDC_AUDIENCE = options.auth.audience;
    if (options.auth.jwksUri) process.env.OIDC_JWKS_URI = options.auth.jwksUri;
    else delete process.env.OIDC_JWKS_URI;
    if (options.auth.clientId) process.env.OIDC_CLIENT_ID = options.auth.clientId;
    else delete process.env.OIDC_CLIENT_ID;
    if (options.auth.clientSecret) process.env.OIDC_CLIENT_SECRET = options.auth.clientSecret;
    else delete process.env.OIDC_CLIENT_SECRET;
    if (options.auth.policy) process.env.AUTHZ_POLICY = typeof options.auth.policy === 'string' ? options.auth.policy : JSON.stringify(options.auth.policy);
    else delete process.env.AUTHZ_POLICY;
  } else {
    delete process.env.AUTH_MODE;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_AUDIENCE;
    delete process.env.OIDC_JWKS_URI;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.AUTHZ_POLICY;
  }
  if (options.cepApiKey) process.env.CEP_API_KEY = options.cepApiKey;
  else delete process.env.CEP_API_KEY;
  process.env.RULES_DATA_FILE = path.join(dir, 'rules.json');
  process.env.RULES_TABLES_FILE = path.join(dir, 'tables.json');
  process.env.RULES_FLOWS_FILE = path.join(dir, 'flows.json');
  process.env.RULES_RELEASES_FILE = path.join(dir, 'releases.json');
  process.env.RULES_APPLICATION_PACKAGES_FILE = path.join(dir, 'application-packages.json');
  process.env.RULES_TARGETS_FILE = path.join(dir, 'targets.json');
  process.env.RULES_ACTIVATION_GENERATIONS_FILE = path.join(dir, 'activation-generations.json');
  process.env.RULES_DEPLOYMENTS_FILE = path.join(dir, 'deployments.json');
  process.env.RULES_ENVIRONMENTS_FILE = path.join(dir, 'environments.json');
  process.env.RULES_TEST_SUITES_FILE = path.join(dir, 'test-suites.json');
  process.env.RULES_BOM_FILE = path.join(dir, 'bom.json');
  process.env.RULES_ADMIN_USERS_FILE = path.join(dir, 'admin-users.json');

  const engineCalls = [];
  const engine = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    engineCalls.push({ path: req.url, body: payload });
    const testIndex = req.url === '/test' ? engineCalls.filter(call => call.path === '/test').length - 1 : -1;
    const handledTest = req.url === '/test' && options.engineBehavior?.testHandler
      ? await options.engineBehavior.testHandler(payload, testIndex)
      : null;
    const status = handledTest?.status ?? (req.url === '/test'
      ? options.engineBehavior?.testStatuses?.[testIndex] ?? options.engineBehavior?.testStatus ?? options.engineBehavior?.compileStatus ?? 200
      : options.engineBehavior?.compileStatus ?? 200);
    res.writeHead(status, { 'content-type': 'application/json' });
    if (status !== 200) {
      res.end(JSON.stringify({ ok: false, errors: ['mock: Drools 编译失败'] }));
      return;
    }
    if (req.url === '/compile') {
      res.end(JSON.stringify({ ok: true, version: '10.2.0' }));
    } else {
      // /test：返回可配置的 facts
      if (handledTest?.body) {
        res.end(JSON.stringify(handledTest.body));
        return;
      }
      const facts = options.engineBehavior?.testFacts ? { ...options.engineBehavior.testFacts } : { riskLevel: '中' };
      res.end(JSON.stringify({ ok: true, fired: ['mock 规则 [1]'], count: 1, facts }));
    }
  });
  await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
  process.env.ENGINE_URL = `http://127.0.0.1:${engine.address().port}`;

  const resCalls = [];
  const resActiveRoutes = {};
  const resServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    resCalls.push({ path: req.url, body: payload });
    let status = ['/deploy', '/prepare'].includes(req.url)
      ? options.resBehavior?.deployStatus ?? 200
      : req.url === '/activate'
        ? options.resBehavior?.activateStatuses?.[resCalls.filter(call => call.path === '/activate').length - 1]
          ?? options.resBehavior?.activateStatus ?? 200
        : 200;
    const activeRoute = resActiveRoutes[payload.decisionService];
    if (req.url === '/activate' && status === 200 && payload.expectedGeneration !== undefined
        && Number(activeRoute?.generation || 0) !== Number(payload.expectedGeneration)
        && !(payload.bootstrap && !activeRoute)) status = 409;
    res.writeHead(status, { 'content-type': 'application/json' });
    if (['/deploy', '/prepare'].includes(req.url)) {
      if (status === 409) {
        res.end(JSON.stringify({ error: '相同 Release ID 已存在不同内容' }));
        return;
      }
      res.end(JSON.stringify({
        deploymentId: `local:${payload.id}`, releaseId: payload.id,
        deployedAt: '2026-09-29T01:00:00.000Z', checksum: payload.checksum,
        steps: payload.steps?.length ?? 0, modelVersion: payload.model?.version ?? null,
      }));
    } else if (req.url === '/activate') {
      if (status !== 200) {
        res.end(JSON.stringify({ error: 'mock: RES 激活失败' }));
        return;
      }
      const current = activeRoute;
      if (status === 409) {
        res.end(JSON.stringify({ error: 'generation CAS 冲突', actualGeneration: current?.generation || 0 }));
        return;
      }
      const generation = payload.generation ?? Number(current?.generation || 0) + 1;
      resActiveRoutes[payload.decisionService] = { releaseId: payload.releaseId, generation };
      res.end(JSON.stringify({
        ok: true, releaseId: payload.releaseId, decisionService: payload.decisionService,
        generation, activatedAt: '2026-09-29T01:30:00.000Z',
      }));
    } else if (req.url === '/execute') {
      const facts = options.resBehavior?.executeFacts ? { ...options.resBehavior.executeFacts, ...payload.facts } : { ...payload.facts, riskLevel: '高' };
      res.end(JSON.stringify({
        ok: true, releaseId: payload.releaseId, requestId: payload.requestId || 'req-gen',
        count: 2, facts, trace: [],
      }));
    } else if (req.url === '/undeploy') {
      res.end(JSON.stringify({ ok: true, releaseId: payload.releaseId, removed: true, stoppedAt: '2026-09-29T02:00:00.000Z' }));
    } else if (req.url === '/health') {
      res.end(JSON.stringify({ service: 'RES', version: '10.2.0', deployments: resCalls.filter(c => c.path === '/deploy').length }));
    } else if (req.url === '/status') {
      res.end(JSON.stringify({
        nodeId: 'mock-rules-res', status: 'ready', engine: 'Drools', engineVersion: '10.2.0',
        activeRoutes: resActiveRoutes, deployments: [], draining: [], observedAt: new Date().toISOString(),
      }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => resServer.listen(0, '127.0.0.1', resolve));
  process.env.RES_URL = `http://127.0.0.1:${resServer.address().port}`;

  const cepDeployments = new Map();
  const cepAlerts = new Map();
  const cepCalls = [];
  const cepServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    cepCalls.push({ path: req.url, headers: req.headers, body: payload });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/compile') {
      res.end(JSON.stringify({ ok: true, engine: 'Esper', version: '8.8.0', epl: 'mock-epl' }));
    } else if (req.url === '/test') {
      res.end(JSON.stringify({ ok: true, ...runEventStream(payload.module || payload, payload.events || payload.facts?.events || []) }));
    } else if (req.url === '/deploy') {
      cepDeployments.set(payload.id, payload);
      res.end(JSON.stringify({
        deploymentId: `local:${payload.id}`, releaseId: payload.id, engine: 'Esper', engineVersion: '8.8.0',
        deployedAt: '2026-09-29T01:00:00.000Z', checksum: payload.checksum,
        statements: payload.statements?.length ?? 0, modelVersion: payload.model?.version ?? null,
      }));
    } else if (req.url === '/execute') {
      const release = cepDeployments.get(payload.releaseId);
      res.end(JSON.stringify({ ok: true, releaseId: payload.releaseId, ...runEventStream(release?.module || release || {}, payload.events || payload.facts?.events || []) }));
    } else if (req.url.startsWith('/events/')) {
      const releaseId = decodeURIComponent(req.url.slice('/events/'.length));
      const release = cepDeployments.get(releaseId);
      res.end(JSON.stringify({ ok: true, releaseId, accepted: payload.events?.length || 0, ...runEventStream(release?.module || release || {}, payload.events || payload.facts?.events || []) }));
    } else if (req.url === '/webhook') {
      const release = cepDeployments.get(payload.releaseId);
      if (release) release.webhook = payload.webhook;
      res.end(JSON.stringify({ ok: true, releaseId: payload.releaseId }));
    } else if (req.url.startsWith('/alerts?')) {
      const releaseId = new URL(req.url, 'http://localhost').searchParams.get('releaseId');
      res.end(JSON.stringify([...cepAlerts.values()].filter(alert => alert.releaseId === releaseId)));
    } else if (req.url.startsWith('/alerts/')) {
      const alertId = decodeURIComponent(req.url.slice('/alerts/'.length));
      const alert = cepAlerts.get(alertId);
      if (!alert || alert.releaseId !== payload.releaseId) { res.writeHead(404); res.end(JSON.stringify({ error: '告警不存在' })); return; }
      if (payload.action === 'ack' && alert.status === 'ACTIVE') Object.assign(alert, { status: 'ACKED', ackedBy: payload.actor, ackedAt: '2026-10-09T08:00:00.000Z' });
      res.end(JSON.stringify(alert));
    } else if (req.url === '/undeploy') {
      const removed = cepDeployments.delete(payload.releaseId);
      res.end(JSON.stringify({ ok: true, releaseId: payload.releaseId, removed, stoppedAt: '2026-09-29T02:00:00.000Z' }));
    } else if (req.url === '/health') {
      res.end(JSON.stringify({ service: 'CEP', engine: 'Esper', version: '8.8.0', deployments: cepDeployments.size }));
    } else if (req.url === '/deployments') {
      res.end(JSON.stringify([...cepDeployments.values()].map(release => ({
        deploymentId: `local:${release.id}`, releaseId: release.id,
        engine: 'Esper', engineVersion: '8.8.0', checksum: release.checksum,
      }))));
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => cepServer.listen(0, '127.0.0.1', resolve));
  process.env.CEP_BUILD_URL = `http://127.0.0.1:${cepServer.address().port}`;
  process.env.CEP_RES_URL = `http://127.0.0.1:${cepServer.address().port}`;

  // 动态 import（带 query 强制重新加载，使 env 生效）
  const { handler } = await import('../server/index.js?cb=' + Date.now());
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed };
  };

  return {
    base, request, dir, engineCalls, resCalls, cepCalls, cepAlerts,
    cepUrl: `http://127.0.0.1:${cepServer.address().port}`,
    async stop() {
      await new Promise(r => server.close(r));
      await new Promise(r => engine.close(r));
      await new Promise(r => resServer.close(r));
      await new Promise(r => cepServer.close(r));
      await fs.rm(dir, { recursive: true, force: true });
      for (const key of ['RULES_DATA_FILE', 'RULES_TABLES_FILE', 'RULES_FLOWS_FILE', 'RULES_RELEASES_FILE', 'RULES_DEPLOYMENTS_FILE', 'RULES_ENVIRONMENTS_FILE', 'RULES_TEST_SUITES_FILE', 'RULES_BOM_FILE', 'RULES_ADMIN_USERS_FILE', 'RULES_CHANGE_SETS_FILE', 'RULES_AUDIT_FILE', 'ENGINE_URL', 'RES_URL', 'CEP_BUILD_URL', 'CEP_RES_URL', 'CEP_API_KEY', 'AUTH_MODE', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ROLES_CLAIM', 'AUTHZ_POLICY']) {
        delete process.env[key];
      }
    },
  };
}
