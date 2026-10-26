import crypto from 'node:crypto';
import {
  activeGenerationFor,
  createActivationGeneration,
} from '../shared/targets.js';
import { callTarget, effectiveTargets } from './target-runtime.js';

export function createActivationGenerationService({
  readTargets,
  readActivationGenerations,
  mutateActivationGenerations,
  deploymentOperations,
  actorOf,
  rulesResManagementUrl,
  rulesResManagementApiKey,
  cepResUrl,
  cepApiKey,
}) {
  const targetCredential = target => target.engine === 'drools'
    ? { bearer: rulesResManagementApiKey }
    : { apiKey: cepApiKey };

  async function updateGeneration(projectId, generationId, operation) {
    return mutateActivationGenerations(async generations => {
      const generation = generations.find(item => item.id === generationId);
      if (!generation) return { status: 404, error: 'Activation generation 不存在' };
      operation(generation, generations);
      generation.updatedAt = new Date().toISOString();
      return { item: generation, changed: true };
    }, projectId);
  }

  async function activateManifest({ projectId, project, applicationPackage, manifest, release, environment, req, details = {} }) {
    const targets = effectiveTargets(await readTargets(projectId), project, rulesResManagementUrl, cepResUrl)
      .filter(target => target.enabled && target.environmentId === environment && target.engine === applicationPackage.engine);
    if (!targets.length) return { status: 409, error: '目标环境没有启用的执行 Target' };

    const reserved = await mutateActivationGenerations(async generations => {
      if (generations.some(item => item.decisionService === applicationPackage.decisionService
          && item.environmentId === environment && ['preparing', 'activating'].includes(item.status))) {
        return { status: 409, error: '该决策服务已有 generation 正在发布' };
      }
      const active = activeGenerationFor(generations, applicationPackage.decisionService, environment);
      const expectedGeneration = active?.generation || 0;
      const generation = createActivationGeneration({
        id: crypto.randomUUID(), projectId, applicationPackage, manifest, environmentId: environment,
        generation: expectedGeneration + 1, expectedGeneration, targetIds: targets.map(target => target.id),
        actor: actorOf(req),
      });
      generations.unshift(generation);
      return { item: generation, changed: true };
    }, projectId);
    if (reserved.error) return reserved;
    const generation = reserved.item;

    const prepared = await Promise.all(targets.map(async target => ({
      target,
      response: await callTarget(target, '/prepare', release, 10_000, targetCredential(target)),
    })));
    await updateGeneration(projectId, generation.id, item => {
      for (const state of item.targets) {
        const result = prepared.find(entry => entry.target.id === state.targetId)?.response;
        Object.assign(state, {
          status: result?.error ? 'failed' : 'ready',
          receipt: result?.result || null,
          error: result?.error || null,
          updatedAt: new Date().toISOString(),
        });
      }
    });
    const preparationFailure = prepared.find(entry => entry.response.error);
    if (preparationFailure) {
      await updateGeneration(projectId, generation.id, item => {
        item.status = 'failed';
        item.failedAt = new Date().toISOString();
        item.error = `${preparationFailure.target.name} 未 READY：${preparationFailure.response.error}`;
      });
      return { status: preparationFailure.response.status || 502, error: `${preparationFailure.target.name} 未 READY：${preparationFailure.response.error}`, generationId: generation.id };
    }

    release.projectId = projectId;
    const receipt = prepared[0].response.result;
    const recorded = await deploymentOperations.recordPreparedRelease(release, req, receipt, environment, { forceReady: true });
    if (recorded.error) return recorded;
    await updateGeneration(projectId, generation.id, item => { item.status = 'activating'; });

    const activated = await Promise.all(targets.map(async target => ({
      target,
      response: await callTarget(target, '/activate', {
        releaseId: release.id,
        decisionService: release.decisionService,
        expectedGeneration: generation.expectedGeneration,
        generation: generation.generation,
        bootstrap: true,
      }, 10_000, targetCredential(target)),
    })));
    await updateGeneration(projectId, generation.id, item => {
      for (const state of item.targets) {
        const result = activated.find(entry => entry.target.id === state.targetId)?.response;
        Object.assign(state, {
          status: result?.error ? 'failed' : 'active',
          activation: result?.result || null,
          error: result?.error || null,
          updatedAt: new Date().toISOString(),
        });
      }
    });
    const activationFailure = activated.find(entry => entry.response.error);
    if (activationFailure) {
      await updateGeneration(projectId, generation.id, item => {
        item.status = 'failed';
        item.failedAt = new Date().toISOString();
        item.error = `${activationFailure.target.name} generation CAS 失败：${activationFailure.response.error}`;
      });
      return { status: activationFailure.response.status || 502, error: `${activationFailure.target.name} generation CAS 失败：${activationFailure.response.error}`, generationId: generation.id };
    }

    const now = activated[0].response.result?.activatedAt || new Date().toISOString();
    const committed = await mutateActivationGenerations(async generations => {
      const item = generations.find(candidate => candidate.id === generation.id);
      const active = activeGenerationFor(generations, applicationPackage.decisionService, environment);
      if (active && Number(active.generation) !== Number(generation.expectedGeneration)) {
        item.status = 'failed';
        item.failedAt = new Date().toISOString();
        item.error = '控制面 generation CAS 冲突';
        return { status: 409, error: item.error, changed: true };
      }
      if (active) active.status = 'draining';
      item.status = 'active';
      item.activatedAt = now;
      item.updatedAt = now;
      return { item, changed: true };
    }, projectId);
    if (committed.error) return committed;
    const deployment = await deploymentOperations.recordActivatedRelease(release, req, environment, {
      ...details,
      generationId: generation.id,
      generation: generation.generation,
      targetIds: targets.map(target => target.id),
    }, { activatedAt: now });
    if (deployment.error) return deployment;
    return { item: committed.item, deployment: deployment.item };
  }

  return { activateManifest };
}
