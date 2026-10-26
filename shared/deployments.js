import crypto from 'node:crypto';

export const DEFAULT_ENVIRONMENT = 'local';

export function defaultEnvironment(projectId = 'default') {
  return {
    id: DEFAULT_ENVIRONMENT,
    projectId,
    name: '本地环境',
    kind: 'dev',
    isDefault: true,
  };
}

export function defaultEnvironments(projectId = 'default') {
  return [
    defaultEnvironment(projectId),
    { id: 'test', projectId, name: '测试环境', kind: 'test', isDefault: false },
    { id: 'production', projectId, name: '生产环境', kind: 'prod', isDefault: false },
  ];
}

export function isLiveDeployment(deployment) {
  return Boolean(deployment && !['stopped', 'failed'].includes(deployment.status));
}

export function deploymentFor(deployments, releaseId, environmentId = DEFAULT_ENVIRONMENT) {
  return [...deployments]
    .reverse()
    .find(item => item.releaseId === releaseId && item.environmentId === environmentId) || null;
}

export function activeDeploymentFor(deployments, decisionService, environmentId = DEFAULT_ENVIRONMENT) {
  return deployments.find(item => item.decisionService === decisionService
    && item.environmentId === environmentId
    && item.status === 'active') || null;
}

export function normalizeActiveDeployments(deployments) {
  const active = new Map();
  const ordered = [...deployments].sort((left, right) => String(right.activatedAt || right.updatedAt || right.createdAt || '')
    .localeCompare(String(left.activatedAt || left.updatedAt || left.createdAt || '')));
  for (const deployment of ordered) {
    if (deployment.status !== 'active') continue;
    const key = `${deployment.projectId || 'default'}\u0000${deployment.decisionService}\u0000${deployment.environmentId}`;
    if (active.has(key)) deployment.status = 'ready';
    else active.set(key, deployment.id);
  }
  return deployments;
}

export function deploymentReceipt(deployment) {
  return {
    id: deployment.id,
    environment: deployment.environmentId,
    deployedAt: deployment.createdAt,
    checksum: deployment.checksum,
    modelVersion: deployment.modelVersion ?? null,
    engine: deployment.engine || null,
    engineVersion: deployment.engineVersion || null,
    status: deployment.status === 'ready' ? 'deployed' : deployment.status,
    ...(deployment.activatedAt ? { activatedAt: deployment.activatedAt } : {}),
    ...(deployment.activatedBy ? { activatedBy: deployment.activatedBy } : {}),
    ...(deployment.stoppedAt ? { stoppedAt: deployment.stoppedAt } : {}),
    ...(deployment.stoppedBy ? { stoppedBy: deployment.stoppedBy } : {}),
  };
}

export function projectDeploymentsOntoReleases(releases, deployments) {
  return releases.map(release => ({
    ...release,
    deployments: deployments
      .filter(deployment => deployment.releaseId === release.id)
      .map(deploymentReceipt),
  }));
}

export function appendDeploymentEvent(deployment, type, actor, details = {}, occurredAt = new Date().toISOString()) {
  deployment.events ||= [];
  deployment.events.push({
    id: crypto.randomUUID(),
    deploymentId: deployment.id,
    type,
    actor,
    details,
    occurredAt,
  });
  deployment.updatedAt = occurredAt;
  return deployment.events.at(-1);
}

export function migrateLegacyDeployments(releases, projectId = 'default') {
  const deployments = [];
  const activeKeys = new Set();
  const candidates = [];
  for (const release of releases) {
    for (const receipt of release.deployments || []) {
      const environmentId = receipt.environment || DEFAULT_ENVIRONMENT;
      const status = receipt.status === 'stopped' ? 'stopped' : receipt.status === 'active' ? 'active' : 'ready';
      candidates.push({ release, receipt, environmentId, status });
      if (status === 'active') activeKeys.add(`${release.decisionService}\u0000${environmentId}`);
    }
  }
  candidates.sort((left, right) => (Number(right.release.version) || 0) - (Number(left.release.version) || 0)
    || String(right.receipt.deployedAt || right.release.createdAt || '')
      .localeCompare(String(left.receipt.deployedAt || left.release.createdAt || '')));
  for (const candidate of candidates) {
    const { release, receipt, environmentId } = candidate;
    const key = `${release.decisionService}\u0000${environmentId}`;
    let status = candidate.status;
    if (status === 'ready' && !activeKeys.has(key)) {
      status = 'active';
      activeKeys.add(key);
    } else if (status === 'active' && deployments.some(item => item.decisionService === release.decisionService
      && item.environmentId === environmentId && item.status === 'active')) status = 'ready';
    const createdAt = receipt.deployedAt || release.createdAt || new Date(0).toISOString();
    const deployment = {
      id: receipt.id,
      projectId,
      releaseId: release.id,
      decisionService: release.decisionService,
      environmentId,
      engine: receipt.engine || release.engine?.type || null,
      checksum: receipt.checksum || release.checksum,
      status,
      modelVersion: receipt.modelVersion ?? release.model?.version ?? null,
      engineVersion: receipt.engineVersion || release.engine?.esper || release.engine?.drools || null,
      createdAt,
      updatedAt: receipt.stoppedAt || receipt.activatedAt || createdAt,
      ...(receipt.activatedAt ? { activatedAt: receipt.activatedAt } : {}),
      ...(receipt.activatedBy ? { activatedBy: receipt.activatedBy } : {}),
      ...(receipt.stoppedAt ? { stoppedAt: receipt.stoppedAt } : {}),
      ...(receipt.stoppedBy ? { stoppedBy: receipt.stoppedBy } : {}),
      events: [],
    };
    deployment.events.push({
      id: `legacy:${deployment.id}:created`, deploymentId: deployment.id, type: 'created', actor: 'migration',
      details: { source: 'release.deployments' }, occurredAt: createdAt,
    });
    if (status === 'active') deployment.events.push({
      id: `legacy:${deployment.id}:activated`, deploymentId: deployment.id, type: 'activated',
      actor: receipt.activatedBy || 'migration', details: { source: 'release.deployments' },
      occurredAt: receipt.activatedAt || createdAt,
    });
    if (status === 'stopped') deployment.events.push({
      id: `legacy:${deployment.id}:stopped`, deploymentId: deployment.id, type: 'stopped',
      actor: receipt.stoppedBy || 'migration', details: { source: 'release.deployments' },
      occurredAt: receipt.stoppedAt || deployment.updatedAt,
    });
    deployments.push(deployment);
  }
  return deployments;
}
