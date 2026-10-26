import crypto from 'node:crypto';
import {
  appendApplicationManifest,
  createApplicationPackage,
  presentApplicationPackages,
  verifyApplicationManifest,
} from '../../shared/application-packages.js';
import { activeDeploymentFor, deploymentFor, isLiveDeployment } from '../../shared/deployments.js';
import { bodyOf, operationError, reply } from '../http-utils.js';

const DEFAULT_ENVIRONMENT = 'local';

export function createApplicationPackageHandler({
  readApplicationPackages,
  mutateApplicationPackages,
  readReleases,
  readDeployments,
  readEnvironments,
  deploymentOperations,
  activationGenerationService,
  actorOf,
  appendAuditEvent,
}) {
  async function presented(projectId) {
    return presentApplicationPackages(
      await readApplicationPackages(projectId),
      await readDeployments(projectId),
    );
  }

  return async function handleApplicationPackages(req, res, segments, projectId, project) {
    if (segments.length === 4) {
      if (req.method === 'GET') return reply(res, 200, await presented(projectId));
      if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
      const payload = await bodyOf(req);
      const release = (await readReleases(projectId)).find(item => item.id === payload?.releaseId);
      if (!release) return reply(res, 404, { error: 'Release 不存在' });
      const result = await mutateApplicationPackages(async applicationPackages => {
        if (applicationPackages.some(item => item.decisionService === release.decisionService)) {
          return { status: 409, error: '该决策服务已有应用包，请向现有应用包追加 manifest' };
        }
        try {
          const applicationPackage = createApplicationPackage({
            id: crypto.randomUUID(),
            manifestId: crypto.randomUUID(),
            projectId,
            name: payload?.name || `${release.name} 应用包`.slice(0, 80),
            release,
            createdBy: actorOf(req),
          });
          applicationPackages.unshift(applicationPackage);
          return { item: applicationPackage, changed: true };
        } catch (error) { return { status: 400, error: error.message }; }
      }, projectId);
      if (result.error) return reply(res, result.status, { error: result.error });
      await appendAuditEvent('application-package.created', 'application-package', result.item.id, `创建应用包：${result.item.name}`, {
        decisionService: result.item.decisionService,
        releaseId: result.item.manifests[0].releaseId,
      }, req);
      return reply(res, 201, (await presented(projectId)).find(item => item.id === result.item.id));
    }

    if (segments.length !== 6 || req.method !== 'POST') return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
    const packageId = segments[4];
    const action = segments[5];
    const payload = await bodyOf(req);
    const applicationPackage = (await readApplicationPackages(projectId)).find(item => item.id === packageId);
    if (!applicationPackage) return reply(res, 404, { error: '应用包不存在' });

    if (action === 'manifests') {
      const release = (await readReleases(projectId)).find(item => item.id === payload?.releaseId);
      if (!release) return reply(res, 404, { error: 'Release 不存在' });
      const result = await mutateApplicationPackages(async applicationPackages => {
        const current = applicationPackages.find(item => item.id === packageId);
        try {
          const appended = appendApplicationManifest(current, release, {
            id: crypto.randomUUID(), createdBy: actorOf(req),
          });
          return { item: current, manifest: appended.manifest, changed: appended.changed };
        } catch (error) { return { status: 400, error: error.message }; }
      }, projectId);
      if (result.error) return reply(res, result.status, { error: result.error });
      if (result.changed) await appendAuditEvent('application-package.manifest-created', 'application-package', packageId, `追加应用包 manifest：v${result.manifest.version}`, {
        manifestId: result.manifest.id, releaseId: result.manifest.releaseId, checksum: result.manifest.checksum,
      }, req);
      return reply(res, result.changed ? 201 : 200, (await presented(projectId)).find(item => item.id === packageId));
    }

    const environment = payload?.environment || DEFAULT_ENVIRONMENT;
    if (!(await readEnvironments(projectId)).some(item => item.id === environment)) {
      return reply(res, 400, { error: '部署环境不存在' });
    }
    const releases = await readReleases(projectId);
    const manifests = [...(applicationPackage.manifests || [])].sort((left, right) => Number(right.version) - Number(left.version));

    if (action === 'deploy') {
      const manifest = payload?.manifestId
        ? manifests.find(item => item.id === payload.manifestId)
        : manifests[0];
      if (!manifest) return reply(res, 404, { error: '应用包 manifest 不存在' });
      const release = releases.find(item => item.id === manifest.releaseId);
      const validation = verifyApplicationManifest(applicationPackage, manifest, release);
      if (validation) return reply(res, 409, { error: validation });
      release.projectId = projectId;
      const existingDeployments = await readDeployments(projectId);
      const existingActive = activeDeploymentFor(existingDeployments, applicationPackage.decisionService, environment);
      if (existingActive?.releaseId === release.id && applicationPackage.engine !== 'drools') {
        return reply(res, 200, (await presented(projectId)).find(item => item.id === packageId));
      }
      if (applicationPackage.engine === 'drools') {
        const activated = await activationGenerationService.activateManifest({
          projectId, project, applicationPackage, manifest, release, environment, req,
          details: { applicationPackageId: packageId, manifestId: manifest.id },
        });
        if (activated.error) return reply(res, activated.status === 409 ? 409 : 502, { error: activated.error, generationId: activated.generationId });
        await appendAuditEvent('application-package.deployed', 'application-package', packageId, `部署应用包：${applicationPackage.name} manifest v${manifest.version}`, {
          environment, manifestId: manifest.id, releaseId: release.id,
          generationId: activated.item.id, generation: activated.item.generation,
        }, req);
        return reply(res, 200, (await presented(projectId)).find(item => item.id === packageId));
      }
      let deployed = await deploymentOperations.deployRelease(release, project, req, environment);
      if (deployed.error) return reply(res, deployed.status || 502, operationError(deployed));
      if (deployed.item.status !== 'active') {
        deployed = await deploymentOperations.activateRelease(release, project, req, environment, {
          applicationPackageId: packageId, manifestId: manifest.id,
        });
        if (deployed.error) return reply(res, deployed.status || 502, operationError(deployed));
      }
      await appendAuditEvent('application-package.deployed', 'application-package', packageId, `部署应用包：${applicationPackage.name} manifest v${manifest.version}`, {
        environment, manifestId: manifest.id, releaseId: release.id,
      }, req);
      return reply(res, 200, (await presented(projectId)).find(item => item.id === packageId));
    }

    if (action === 'rollback') {
      const deployments = await readDeployments(projectId);
      const active = activeDeploymentFor(deployments, applicationPackage.decisionService, environment);
      const activeManifest = active && manifests.find(item => item.releaseId === active.releaseId);
      if (!activeManifest) return reply(res, 409, { error: '当前生效版本不属于该应用包，不能执行应用包回退' });
      const targetManifest = manifests.find(item => Number(item.version) < Number(activeManifest.version)
        && isLiveDeployment(deploymentFor(deployments, item.releaseId, environment))
        && deploymentFor(deployments, item.releaseId, environment)?.status === 'ready');
      if (!targetManifest) return reply(res, 409, { error: '没有可回退的已部署应用包 manifest' });
      const target = releases.find(item => item.id === targetManifest.releaseId);
      const validation = verifyApplicationManifest(applicationPackage, targetManifest, target);
      if (validation) return reply(res, 409, { error: validation });
      target.projectId = projectId;
      if (applicationPackage.engine === 'drools') {
        const activated = await activationGenerationService.activateManifest({
          projectId, project, applicationPackage, manifest: targetManifest, release: target,
          environment, req, details: {
            applicationPackageId: packageId,
            manifestId: targetManifest.id,
            rollbackFromManifestId: activeManifest.id,
          },
        });
        if (activated.error) return reply(res, activated.status === 409 ? 409 : 502, { error: activated.error, generationId: activated.generationId });
        await appendAuditEvent('application-package.rolled-back', 'application-package', packageId, `回退应用包：${applicationPackage.name} 至 manifest v${targetManifest.version}`, {
          environment, manifestId: targetManifest.id, releaseId: target.id, fromManifestId: activeManifest.id,
          generationId: activated.item.id, generation: activated.item.generation,
        }, req);
        return reply(res, 200, (await presented(projectId)).find(item => item.id === packageId));
      }
      const activated = await deploymentOperations.activateRelease(target, project, req, environment, {
        applicationPackageId: packageId,
        manifestId: targetManifest.id,
        rollbackFromManifestId: activeManifest.id,
      });
      if (activated.error) return reply(res, activated.status || 502, operationError(activated));
      await appendAuditEvent('application-package.rolled-back', 'application-package', packageId, `回退应用包：${applicationPackage.name} 至 manifest v${targetManifest.version}`, {
        environment, manifestId: targetManifest.id, releaseId: target.id, fromManifestId: activeManifest.id,
      }, req);
      return reply(res, 200, (await presented(projectId)).find(item => item.id === packageId));
    }

    return reply(res, 404, { error: '未找到资源' });
  };
}
