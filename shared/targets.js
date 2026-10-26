const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function requiredText(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label}无效`);
  return value.trim();
}

export function normalizeTargetEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(requiredText(value, 'Target endpoint', 500)); }
  catch { throw new Error('Target endpoint 必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Target endpoint 必须是无凭据的 HTTP(S) 地址');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString().replace(/\/$/, '');
}

export function createTarget(input, { id, projectId, actor, now = new Date().toISOString() }) {
  if (!TARGET_ID.test(id || '')) throw new Error('Target ID 无效');
  const environmentId = input?.environmentId || 'local';
  if (!ENVIRONMENT_ID.test(environmentId)) throw new Error('Target 环境无效');
  const engine = input?.engine || 'drools';
  if (!['drools', 'esper'].includes(engine)) throw new Error('Target 执行引擎无效');
  return {
    id,
    projectId,
    name: requiredText(input?.name, 'Target 名称', 80),
    environmentId,
    engine,
    endpoint: normalizeTargetEndpoint(input?.endpoint),
    enabled: input?.enabled !== false,
    status: 'unknown',
    nodeId: null,
    engineVersion: null,
    lastSeenAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
  };
}

export function updateTarget(target, input, now = new Date().toISOString()) {
  if (input?.name !== undefined) target.name = requiredText(input.name, 'Target 名称', 80);
  if (input?.endpoint !== undefined) target.endpoint = normalizeTargetEndpoint(input.endpoint);
  if (input?.enabled !== undefined) target.enabled = Boolean(input.enabled);
  target.updatedAt = now;
  return target;
}

export function createActivationGeneration({
  id, projectId, applicationPackage, manifest, environmentId, generation,
  expectedGeneration, targetIds, actor, now = new Date().toISOString(),
}) {
  return {
    id,
    projectId,
    applicationPackageId: applicationPackage.id,
    manifestId: manifest.id,
    releaseId: manifest.releaseId,
    decisionService: applicationPackage.decisionService,
    environmentId,
    generation,
    expectedGeneration,
    status: 'preparing',
    targets: targetIds.map(targetId => ({ targetId, status: 'pending', updatedAt: now })),
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    activatedAt: null,
    failedAt: null,
    error: null,
  };
}

export function activeGenerationFor(generations, decisionService, environmentId = 'local') {
  return generations
    .filter(item => item.decisionService === decisionService && item.environmentId === environmentId && item.status === 'active')
    .sort((left, right) => Number(right.generation) - Number(left.generation))[0] || null;
}

export function nextGenerationFor(generations, decisionService, environmentId = 'local') {
  return generations
    .filter(item => item.decisionService === decisionService && item.environmentId === environmentId)
    .reduce((maximum, item) => Math.max(maximum, Number(item.generation) || 0), 0) + 1;
}
