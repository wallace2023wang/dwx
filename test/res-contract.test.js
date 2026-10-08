// RES 模块 1：Team Server ↔ RES 部署/执行契约测试
// 对标 JRules RES：部署幂等、校验和校验、版本路由、执行轨迹、错误隔离。
// 这些用例通过 mock RES 验证 Team Server 侧的协议正确；RES 自身行为见 res-test-cases.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

async function publishAndRelease(env) {
  const rule = (await env.request('/api/rules', 'POST')).body;
  await env.request(`/api/rules/${rule.id}/publish`, 'POST');
  const release = await env.request('/api/releases', 'POST', {
    decisionService: 'default/res-contract', name: '契约测试', target: { type: 'rule', id: rule.id },
  });
  return release.body;
}

test('RES-CONTRACT-01: 部署请求包含完整 Release、校验和和环境标识', async () => {
  const env = await startTestEnv();
  try {
    const release = await publishAndRelease(env);
    await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    const deployCall = env.resCalls.find(c => c.path === '/deploy');
    assert.ok(deployCall);
    assert.equal(deployCall.body.id, release.id);
    assert.equal(deployCall.body.checksum, release.checksum);
    assert.equal(deployCall.body.engine.drools, '10.2.0');
    assert.equal(deployCall.body.model.version, 1);
    assert.ok(Array.isArray(deployCall.body.steps));
    assert.ok(deployCall.body.steps[0].drl.includes('declare RuleInput'));
  } finally { await env.stop(); }
});

test('RES-CONTRACT-02: 部署成功后 Team Server 记录回执，重复部署幂等', async () => {
  const env = await startTestEnv();
  try {
    const release = await publishAndRelease(env);
    const d1 = await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    assert.equal(d1.status, 200);
    assert.equal(d1.body.deployments.length, 1);
    assert.equal(d1.body.deployments[0].modelVersion, 1);
    // 再部署一次 → 幂等，不重复记回执
    const d2 = await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    assert.equal(d2.status, 200);
    assert.equal(d2.body.deployments.length, 1);
  } finally { await env.stop(); }
});

test('RES-CONTRACT-03: RES 返回 409（同 ID 不同内容）时 Team Server 透传错误', async () => {
  const env = await startTestEnv({ resBehavior: { deployStatus: 409 } });
  try {
    const release = await publishAndRelease(env);
    const result = await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /不同内容/);
  } finally { await env.stop(); }
});

test('RES-CONTRACT-04: 执行请求指定 releaseId 和 facts，返回 RES 执行结果', async () => {
  const env = await startTestEnv();
  try {
    const release = await publishAndRelease(env);
    await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    const exec = await env.request(`/api/releases/${release.id}/execute`, 'POST', {
      requestId: 'req-contract-1', facts: { creditScore: 580, overdue: true },
    });
    assert.equal(exec.status, 200);
    const execCall = env.resCalls.at(-1);
    assert.equal(execCall.path, '/execute');
    assert.equal(execCall.body.releaseId, release.id);
    assert.equal(execCall.body.requestId, 'req-contract-1');
    // facts 已按 BOM 过滤（数字转 number，字符串不丢）
    assert.equal(execCall.body.facts.creditScore, 580);
  } finally { await env.stop(); }
});

test('RES-CONTRACT-05: 不支持的环境被拒绝', async () => {
  const env = await startTestEnv();
  try {
    const release = await publishAndRelease(env);
    const result = await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'prod' });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /只支持 local/);
  } finally { await env.stop(); }
});

test('RES-CONTRACT-06: facts 含未知字段被拒绝（BOM 校验在 Team Server 侧拦截）', async () => {
  const env = await startTestEnv();
  try {
    const release = await publishAndRelease(env);
    await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    const result = await env.request(`/api/releases/${release.id}/execute`, 'POST', {
      facts: { notExistField: 'x' },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /测试输入字段或类型无效/);
  } finally { await env.stop(); }
});

test('RES-CONTRACT-07: facts 类型错误被拒绝（Integer 字段传字符串）', async () => {
  const env = await startTestEnv();
  try {
    const release = await publishAndRelease(env);
    await env.request(`/api/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    const result = await env.request(`/api/releases/${release.id}/execute`, 'POST', {
      facts: { creditScore: '不是数字' },
    });
    assert.equal(result.status, 400);
  } finally { await env.stop(); }
});

test('RES-CONTRACT-08: 非生效版本卸载转发 releaseId 并保留停用历史', async () => {
  const env = await startTestEnv();
  try {
    const first = await publishAndRelease(env);
    const second = (await env.request('/api/releases', 'POST', {
      decisionService: 'default/res-contract', name: '契约测试 v2', target: { type: 'rule', id: first.target.id },
    })).body;
    await env.request(`/api/releases/${first.id}/deploy`, 'POST', { environment: 'local' });
    await env.request(`/api/releases/${second.id}/deploy`, 'POST', { environment: 'local' });

    const stopped = await env.request(`/api/releases/${second.id}/undeploy`, 'POST', { environment: 'local' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.deployments[0].status, 'stopped');
    assert.deepEqual(env.resCalls.at(-1), { path: '/undeploy', body: { releaseId: second.id } });
  } finally { await env.stop(); }
});

test('RES-CONTRACT-09: 激活和回退同步 RES 的 decisionService 路由', async () => {
  const env = await startTestEnv();
  try {
    const first = await publishAndRelease(env);
    const second = (await env.request('/api/releases', 'POST', {
      decisionService: 'default/res-contract', name: '契约测试 v2', target: { type: 'rule', id: first.target.id },
    })).body;
    await env.request(`/api/releases/${first.id}/deploy`, 'POST', { environment: 'local' });
    await env.request(`/api/releases/${second.id}/deploy`, 'POST', { environment: 'local' });

    assert.equal((await env.request(`/api/releases/${second.id}/activate`, 'POST', { environment: 'local' })).status, 200);
    assert.deepEqual(env.resCalls.at(-1), {
      path: '/activate', body: { releaseId: second.id, decisionService: 'default/res-contract' },
    });
    assert.equal((await env.request(`/api/releases/${second.id}/rollback`, 'POST', { environment: 'local' })).status, 200);
    assert.deepEqual(env.resCalls.at(-1), {
      path: '/activate', body: { releaseId: first.id, decisionService: 'default/res-contract' },
    });
  } finally { await env.stop(); }
});
