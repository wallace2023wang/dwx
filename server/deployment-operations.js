import { activeDeploymentFor, appendDeploymentEvent, deploymentFor, isLiveDeployment } from '../shared/deployments.js';

const DEFAULT_ENVIRONMENT = 'local';

export function createDeploymentOperations({ readDeployments, mutateDeployments, actorOf, executionServer }) {
  async function activateRuntime(release, project) {
    if (project?.engine === 'cep') return { result: { ok: true } };
    return executionServer('/activate', { releaseId: release.id, decisionService: release.decisionService }, project);
  }

  async function recordPreparedRelease(release, req, deployedResult, environment = DEFAULT_ENVIRONMENT, options = {}) {
    return mutateDeployments(async deployments => {
      const receipt = {
        id: `${environment}:${release.id}`,
        releaseId: release.id,
        decisionService: release.decisionService,
        environmentId: environment,
        createdAt: deployedResult.deployedAt || new Date().toISOString(),
        updatedAt: deployedResult.deployedAt || new Date().toISOString(),
        checksum: deployedResult.checksum || release.checksum,
        modelVersion: deployedResult.modelVersion ?? release.model?.version ?? null,
        engine: deployedResult.engine || release.engine?.type,
        engineVersion: deployedResult.engineVersion || release.engine?.esper || release.engine?.drools,
        events: [],
      };
      const existing = deployments.find(item => item.id === receipt.id);
      const currentActive = activeDeploymentFor(deployments, release.decisionService, environment);
      receipt.status = options.forceReady ? 'ready' : currentActive && currentActive.releaseId !== release.id ? 'ready' : 'active';
      if (existing?.status === 'active' && existing.releaseId === release.id) receipt.status = 'active';
      if (receipt.status === 'active') {
        receipt.activatedAt = receipt.createdAt;
        receipt.activatedBy = actorOf(req);
      }
      if (existing) {
        const events = existing.events || [];
        Object.assign(existing, receipt, { events });
        delete existing.stoppedAt;
        delete existing.stoppedBy;
        appendDeploymentEvent(existing, 'ready', actorOf(req), { redeployed: true }, receipt.createdAt);
      } else {
        deployments.push(receipt);
        appendDeploymentEvent(receipt, 'created', actorOf(req), {}, receipt.createdAt);
        appendDeploymentEvent(receipt, 'ready', actorOf(req), {}, receipt.createdAt);
      }
      if (receipt.status === 'active') appendDeploymentEvent(existing || receipt, 'activated', actorOf(req), { automatic: true }, receipt.createdAt);
      return { item: existing || receipt, changed: true };
    }, release.projectId || 'default');
  }

  async function deployRelease(release, project, req, environment = DEFAULT_ENVIRONMENT) {
    if (environment !== DEFAULT_ENVIRONMENT) return { status: 400, error: '当前版本只支持 local 环境' };
    const deployed = await executionServer('/deploy', release, project);
    if (deployed.error) return deployed;
    return recordPreparedRelease(release, req, deployed.result, environment);
  }

  async function activateRelease(release, project, req, environment = DEFAULT_ENVIRONMENT, details = {}) {
    if (environment !== DEFAULT_ENVIRONMENT) return { status: 400, error: '当前版本只支持 local 环境' };
    return mutateDeployments(async deployments => {
      const deployment = deploymentFor(deployments, release.id, environment);
      if (!deployment || !isLiveDeployment(deployment)) return { status: 409, error: '发布包尚未部署或已停用' };
      if (deployment.status === 'active') return { item: deployment, changed: false };
      const activated = await activateRuntime(release, project);
      if (activated.error) return activated;
      const now = activated.result?.activatedAt || new Date().toISOString();
      for (const candidate of deployments) {
        if (candidate.decisionService !== release.decisionService || candidate.environmentId !== environment || candidate.status !== 'active') continue;
        candidate.status = 'ready';
        appendDeploymentEvent(candidate, 'deactivated', actorOf(req), { activatedDeploymentId: deployment.id, ...details }, now);
      }
      deployment.status = 'active';
      deployment.activatedAt = now;
      deployment.activatedBy = actorOf(req);
      appendDeploymentEvent(deployment, 'activated', actorOf(req), details, now);
      return { item: deployment, changed: true };
    }, release.projectId || 'default');
  }

  async function recordActivatedRelease(release, req, environment = DEFAULT_ENVIRONMENT, details = {}, activatedResult = {}) {
    return mutateDeployments(async deployments => {
      const deployment = deploymentFor(deployments, release.id, environment);
      if (!deployment || !isLiveDeployment(deployment)) return { status: 409, error: '发布包尚未部署或已停用' };
      const now = activatedResult.activatedAt || new Date().toISOString();
      for (const candidate of deployments) {
        if (candidate.decisionService !== release.decisionService || candidate.environmentId !== environment || candidate.status !== 'active') continue;
        candidate.status = 'ready';
        appendDeploymentEvent(candidate, 'deactivated', actorOf(req), { activatedDeploymentId: deployment.id, ...details }, now);
      }
      deployment.status = 'active';
      deployment.activatedAt = now;
      deployment.activatedBy = actorOf(req);
      appendDeploymentEvent(deployment, 'activated', actorOf(req), details, now);
      return { item: deployment, changed: true };
    }, release.projectId || 'default');
  }

  async function deployedRelease(releaseId, projectId = 'default', environment = DEFAULT_ENVIRONMENT) {
    return deploymentFor(await readDeployments(projectId), releaseId, environment);
  }

  return { deployRelease, activateRelease, recordPreparedRelease, recordActivatedRelease, deployedRelease };
}
