import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { startTestEnv } from './helpers.js';

test('AUTH-01: OIDC JWT 验签并按角色执行 API 权限门禁', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  const jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    } else {
      res.end(JSON.stringify({ keys: [publicJwk] }));
    }
  });
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${jwksServer.address().port}`;
  const audience = 'rules-team-server';
  const env = await startTestEnv({ auth: {
    mode: 'oidc', issuer, audience, clientId: 'rules-web',
  } });
  const token = (subject, roles, overrides = {}) => new SignJWT({
    preferred_username: `${subject}-display`, roles, ...(overrides.claims || {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(subject).setIssuer(overrides.issuer || issuer).setAudience(overrides.audience || audience).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
  try {
    assert.equal((await env.request('/api/rules')).status, 401);

    const viewer = await token('reader-cn', ['viewer']);
    const viewerHeaders = { authorization: `Bearer ${viewer}` };
    assert.equal((await env.request('/api/rules', 'GET', undefined, viewerHeaders)).status, 200);
    assert.equal((await env.request('/api/rules', 'POST', undefined, viewerHeaders)).status, 403);
    assert.equal((await env.request('/api/audit-events', 'GET', undefined, viewerHeaders)).status, 403);

    const author = await token('rule-author', ['author']);
    const authorHeaders = { authorization: `Bearer ${author}`, 'x-actor': 'spoofed-user' };
    const created = await env.request('/api/rules', 'POST', undefined, authorHeaders);
    assert.equal(created.status, 201);
    assert.equal((await env.request('/api/change-sets/missing/approve', 'POST', {}, authorHeaders)).status, 403);
    assert.equal((await env.request('/api/projects/default/releases', 'POST', {}, authorHeaders)).status, 403);

    const reviewer = await token('rule-reviewer', [], { claims: { realm_access: { roles: ['reviewer'] } } });
    const reviewerHeaders = { authorization: `Bearer ${reviewer}` };
    assert.equal((await env.request('/api/change-sets/missing/approve', 'POST', {}, reviewerHeaders)).status, 404);

    const authorReviewer = await token('author-reviewer', ['author', 'reviewer']);
    const authorReviewerHeaders = { authorization: `Bearer ${authorReviewer}` };
    const governed = (await env.request('/api/projects/default/rules', 'POST', {
      type: 'rule', name: '职责分离规则', category: 'governance',
    }, authorReviewerHeaders)).body;
    const governedDraft = structuredClone(governed.draft);
    governedDraft.conditions[0].value = '18';
    governedDraft.actions[0].value = '低';
    const governedSaved = (await env.request(`/api/projects/default/rules/${governed.id}`, 'PUT', {
      revision: governed.revision, draft: governedDraft,
    }, authorReviewerHeaders)).body;
    const governedSubmitted = (await env.request(`/api/projects/default/rules/${governed.id}/submit`, 'POST', {
      revision: governedSaved.revision,
    }, authorReviewerHeaders)).body;
    const ownApproval = await env.request(`/api/projects/default/change-sets/${governedSubmitted.changeSetId}/approve`, 'POST', {
      revision: 1, comment: '本人审批',
    }, authorReviewerHeaders);
    assert.equal(ownApproval.status, 403);
    const separatedApproval = await env.request(`/api/projects/default/change-sets/${governedSubmitted.changeSetId}/approve`, 'POST', {
      revision: 1, comment: '独立审核通过',
    }, reviewerHeaders);
    assert.equal(separatedApproval.status, 200);
    assert.equal(separatedApproval.body.status, 'APPROVED');

    const audit = await env.request('/api/audit-events', 'GET', undefined, reviewerHeaders);
    assert.equal(audit.status, 200);
    assert.ok(audit.body.some(event => event.action === 'asset.created' && event.actor === 'rule-author'));

    const releaseManager = await token('release-admin', [], {
      claims: { resource_access: { 'rules-web': { roles: ['release-manager'] } } },
    });
    const releaseHeaders = { authorization: `Bearer ${releaseManager}` };
    assert.equal((await env.request('/api/releases', 'POST', {}, releaseHeaders)).status, 400);
    assert.equal((await env.request('/api/projects/default/releases', 'POST', {}, releaseHeaders)).status, 400);
    assert.equal((await env.request('/api/projects/default/releases/missing/deploy', 'POST', {}, releaseHeaders)).status, 404);
    assert.equal((await env.request('/api/projects/default/releases/missing/deploy', 'POST', {}, viewerHeaders)).status, 403);
    assert.equal((await env.request('/api/projects/default/releases/missing/activate', 'POST', {}, releaseHeaders)).status, 404);
    assert.equal((await env.request('/api/projects/default/releases/missing/rollback', 'POST', {}, viewerHeaders)).status, 403);
    assert.equal((await env.request('/api/projects/default/releases/missing/undeploy', 'POST', {}, viewerHeaders)).status, 403);
    assert.equal((await env.request('/api/projects/default/releases/missing/execute', 'POST', {}, viewerHeaders)).status, 404);
    assert.equal((await env.request('/api/projects/default/services/missing/execute', 'POST', {}, viewerHeaders)).status, 409);

    const session = await env.request('/api/session', 'GET', undefined, authorHeaders);
    assert.deepEqual({
      id: session.body.id,
      name: session.body.name,
      roles: session.body.roles,
      permissions: session.body.permissions,
      mode: session.body.mode,
    }, {
      id: 'rule-author', name: 'rule-author-display', roles: ['author'],
      permissions: ['view', 'author'], mode: 'oidc',
    });

    const wrongAudience = await token('intruder', ['admin'], { audience: 'another-service' });
    assert.equal((await env.request('/api/rules', 'GET', undefined, { authorization: `Bearer ${wrongAudience}` })).status, 401);
  } finally {
    await env.stop();
    await new Promise(resolve => jwksServer.close(resolve));
  }
});

test('AUTH-02: 浏览器 OIDC PKCE 登录生成 HttpOnly BFF 会话并支持退出', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: 'browser-key', alg: 'RS256', use: 'sig' });
  let issuer;
  const codes = new Set();
  const jwksServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (url.pathname === '/authorize') {
      const code = `code-${codes.size + 1}`;
      codes.add(code);
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: redirect.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.ok(codes.has(params.get('code')));
      assert.ok(params.get('code_verifier'));
      const accessToken = await new SignJWT({ preferred_username: 'browser-user', roles: ['author'] })
        .setProtectedHeader({ alg: 'RS256', kid: 'browser-key' })
        .setSubject('browser-user').setIssuer(issuer).setAudience('rules-team-server').setIssuedAt().setExpirationTime('5m')
        .sign(privateKey);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 300 }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${jwksServer.address().port}`;
  const env = await startTestEnv({ auth: { mode: 'oidc', issuer, audience: 'rules-team-server', clientId: 'rules-web' } });
  try {
    const config = await env.request('/api/auth/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.mode, 'oidc');

    const login = await fetch(`${env.base}/api/auth/login?returnTo=%2Flibrary`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const authorize = await fetch(login.headers.get('location'), { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const callback = await fetch(authorize.headers.get('location'), { redirect: 'manual' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/library');
    const cookie = callback.headers.get('set-cookie');
    assert.match(cookie, /rts_sid=/);
    assert.match(cookie, /HttpOnly/);

    const session = await env.request('/api/session', 'GET', undefined, { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.id, 'browser-user');
    assert.deepEqual(session.body.roles, ['author']);

    const logout = await env.request('/api/auth/logout', 'POST', undefined, { cookie });
    assert.equal(logout.status, 204);
    assert.equal((await env.request('/api/session', 'GET', undefined, { cookie })).status, 401);
  } finally {
    await env.stop();
    await new Promise(resolve => jwksServer.close(resolve));
  }
});

test('AUTH-03: 项目和资产级策略过滤项目资产并拒绝越权访问', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: 'policy-key', alg: 'RS256', use: 'sig' });
  let issuer;
  const jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/.well-known/openid-configuration') res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    else res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${jwksServer.address().port}`;
  const env = await startTestEnv({ auth: {
    mode: 'oidc', issuer, audience: 'rules-team-server', clientId: 'rules-web',
    policy: { users: { scoped: { projects: ['default'], assets: [] }, blocked: { projects: [] } } },
  } });
  const token = subject => new SignJWT({ preferred_username: subject, roles: ['viewer'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'policy-key' })
    .setSubject(subject).setIssuer(issuer).setAudience('rules-team-server').setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
  try {
    const scopedHeaders = { authorization: `Bearer ${await token('scoped')}` };
    const projects = await env.request('/api/projects', 'GET', undefined, scopedHeaders);
    assert.equal(projects.status, 200);
    assert.ok(projects.body.some(project => project.id === 'default'));
    const packages = await env.request('/api/projects/default/packages', 'GET', undefined, scopedHeaders);
    assert.equal(packages.status, 200);
    assert.equal(packages.body.flatMap(pkg => pkg.assets).length, 0);

    const blockedHeaders = { authorization: `Bearer ${await token('blocked')}` };
    const hidden = await env.request('/api/projects', 'GET', undefined, blockedHeaders);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.some(project => project.id === 'default'), false);
    assert.equal((await env.request('/api/projects/default', 'GET', undefined, blockedHeaders)).status, 403);
  } finally {
    await env.stop();
    await new Promise(resolve => jwksServer.close(resolve));
  }
});

test('ADMIN-USER-01: 管理员可以创建、更新和删除用户目录', async () => {
  const env = await startTestEnv();
  try {
    const created = await env.request('/api/admin/users', 'POST', {
      username: 'new.author', displayName: '新作者', email: 'new.author@example.com', role: 'author', status: 'active',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.username, 'new.author');

    const listed = await env.request('/api/admin/users');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.some(user => user.id === 'new.author'));

    const updated = await env.request('/api/admin/users/new.author', 'PUT', { displayName: '新作者 A', email: 'new.author.a@example.com', role: 'reviewer', status: 'disabled' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.role, 'reviewer');
    assert.equal(updated.body.status, 'disabled');

    const deleted = await env.request('/api/admin/users/new.author', 'DELETE');
    assert.equal(deleted.status, 204);
    const after = await env.request('/api/admin/users');
    assert.equal(after.body.some(user => user.id === 'new.author'), false);
  } finally {
    await env.stop();
  }
});
