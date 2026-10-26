export function implicitTarget(project, rulesResUrl, cepResUrl) {
  const cep = project?.engine === 'cep';
  return {
    id: cep ? 'local-cep-res' : 'local-rules-res',
    name: cep ? '本地 CEP RES' : '本地规则 RES',
    environmentId: 'local',
    engine: cep ? 'esper' : 'drools',
    endpoint: cep ? cepResUrl : rulesResUrl,
    enabled: true,
    status: 'unknown',
    managed: false,
  };
}

export function effectiveTargets(stored, project, rulesResUrl, cepResUrl) {
  const fallback = implicitTarget(project, rulesResUrl, cepResUrl);
  if (stored.some(target => target.endpoint === fallback.endpoint && target.engine === fallback.engine)) return stored;
  return [fallback, ...stored];
}

export async function callTarget(target, path, body = null, timeoutMs = 10_000, credential = {}) {
  const normalizedCredential = typeof credential === 'string' ? { bearer: credential } : credential;
  try {
    const response = await fetch(`${target.endpoint}${path}`, {
      method: body === null ? 'GET' : 'POST',
      headers: {
        ...(body === null ? {} : { 'content-type': 'application/json' }),
        ...(normalizedCredential.bearer ? { authorization: `Bearer ${normalizedCredential.bearer}` } : {}),
        ...(normalizedCredential.apiKey ? { 'x-api-key': normalizedCredential.apiKey } : {}),
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { error: result.error || `Target 返回 HTTP ${response.status}`, status: response.status, result };
    return { result, status: response.status };
  } catch (error) {
    return { error: error.name === 'TimeoutError' ? 'Target 请求超时' : `Target 不可达：${error.message}`, status: 502 };
  }
}
