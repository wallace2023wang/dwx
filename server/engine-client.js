function normalizeEngine(value) {
  return value === 'cep' ? 'cep' : 'rules';
}

function resolveEngineTargets(projectOrEngine, config) {
  const engine = typeof projectOrEngine === 'string'
    ? normalizeEngine(projectOrEngine)
    : normalizeEngine(projectOrEngine?.engine);
  return engine === 'cep'
    ? { engine, buildUrl: config.cepBuildUrl, runtimeUrl: config.cepResUrl, managementUrl: config.cepResUrl, label: 'CEP' }
    : { engine: 'rules', buildUrl: config.rulesBuildUrl, runtimeUrl: config.rulesResUrl, managementUrl: config.rulesResManagementUrl, label: 'Drools' };
}

const MANAGEMENT_ENDPOINTS = new Set(['/deploy', '/prepare', '/activate', '/undeploy', '/deployments', '/status']);

function engineHeaders(target, config, plane = 'build') {
  const apiKey = target.engine === 'cep'
    ? config.cepApiKey
    : plane === 'management' ? config.rulesResManagementApiKey : plane === 'execution' ? config.rulesResExecutionApiKey : '';
  return {
    'content-type': 'application/json',
    ...(target.engine === 'cep' && apiKey ? { 'x-api-key': apiKey } : {}),
    ...(target.engine === 'rules' && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

export function createEngineClients(config) {
  async function engine(endpoint, payload, projectOrEngine = 'rules') {
    const target = resolveEngineTargets(projectOrEngine, config);
    const timeoutMs = Math.min(310000, Math.max(20000, (Number.isInteger(payload?.waitMs) ? payload.waitMs : 0) + 5000));
    let response;
    try {
      response = await fetch(`${target.buildUrl}${endpoint}`, {
        method: 'POST', headers: engineHeaders(target, config),
        body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { status: 503, error: `${target.label} 服务不可用，无法验证规则` }; }
    let result;
    try { result = await response.json(); }
    catch { return { status: 502, error: `${target.label} 服务返回了无效响应` }; }
    if (!response.ok) return { status: response.status === 422 ? 422 : 502, error: result.errors?.join('\n') || result.error || `${target.label} 验证失败`, details: result.diagnostics || (result.errors ? { errors: result.errors } : undefined) };
    return { result };
  }

  async function executionServer(endpoint, payload, projectOrEngine = 'rules', method = 'POST') {
    const target = resolveEngineTargets(projectOrEngine, config);
    const plane = MANAGEMENT_ENDPOINTS.has(endpoint.split('?')[0]) ? 'management' : 'execution';
    const baseUrl = plane === 'management' ? target.managementUrl : target.runtimeUrl;
    const timeoutMs = Math.min(310000, Math.max(20000, (Number.isInteger(payload?.waitMs) ? payload.waitMs : 0) + 5000));
    let response;
    try {
      response = await fetch(`${baseUrl}${endpoint}`, {
        method, headers: engineHeaders(target, config, plane),
        ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { status: 503, error: `${target.label} 执行服务不可用` }; }
    let result;
    try { result = await response.json(); }
    catch { return { status: 502, error: `${target.label} 执行服务返回了无效响应` }; }
    if (!response.ok) return { status: [400, 404, 409, 422].includes(response.status) ? response.status : 502, error: result.errors?.join('\n') || result.error || `${target.label} 执行服务处理失败`, details: result.diagnostics || (result.errors ? { errors: result.errors } : undefined) };
    return { result };
  }

  return { engine, executionServer };
}
