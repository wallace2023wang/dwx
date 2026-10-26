import crypto from 'node:crypto';
import { createTarget, updateTarget } from '../../shared/targets.js';
import { bodyOf, reply } from '../http-utils.js';
import { callTarget, effectiveTargets } from '../target-runtime.js';

export function createTargetHandler({
  readTargets, mutateTargets, readActivationGenerations, readEnvironments,
  actorOf, appendAuditEvent, rulesResManagementUrl, cepResUrl, rulesResManagementApiKey, cepApiKey,
}) {
  async function reconcileTarget(target, generations) {
    const credential = target.engine === 'drools' ? { bearer: rulesResManagementApiKey } : { apiKey: cepApiKey };
    const now = new Date().toISOString();
    const expected = generations.filter(item => item.status === 'active'
      && item.environmentId === target.environmentId
      && item.targets?.some(state => state.targetId === target.id));
    let status;
    let mismatch;
    if (target.engine === 'esper') {
      // CEP Runtime exposes its management information through /health and
      // /deployments. It intentionally has no Drools-style /status route.
      const [healthResponse, deploymentsResponse] = await Promise.all([
        callTarget(target, '/health', null, 5_000, credential),
        callTarget(target, '/deployments', null, 5_000, credential),
      ]);
      if (healthResponse.error) return { ...target, status: 'unreachable', lastSeenAt: now, lastError: healthResponse.error };
      if (deploymentsResponse.error) return { ...target, status: 'unreachable', lastSeenAt: now, lastError: deploymentsResponse.error };
      const deployments = Array.isArray(deploymentsResponse.result) ? deploymentsResponse.result : [];
      status = { ...healthResponse.result, deployments, observedAt: now };
      mismatch = expected.some(item => !deployments.some(deployment => deployment.releaseId === item.releaseId));
    } else {
      const response = await callTarget(target, '/status', null, 5_000, credential);
      if (response.error) return { ...target, status: 'unreachable', lastSeenAt: now, lastError: response.error };
      status = response.result;
      mismatch = expected.some(item => {
        const route = status.activeRoutes?.[item.decisionService];
        return !route || route.releaseId !== item.releaseId || Number(route.generation) !== Number(item.generation);
      });
    }
    return {
      ...target,
      status: mismatch ? 'mismatch' : 'ready',
      nodeId: status.nodeId || target.nodeId || null,
      engineVersion: status.engineVersion || status.version || target.engineVersion || null,
      lastSeenAt: now,
      lastError: mismatch ? '节点生效路由与控制面 generation 不一致' : null,
      observed: status,
    };
  }

  return async function handleTargets(req, res, segments, projectId, project) {
    if (segments.length === 4) {
      if (req.method === 'GET') {
        return reply(res, 200, effectiveTargets(await readTargets(projectId), project, rulesResManagementUrl, cepResUrl));
      }
      if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
      const payload = await bodyOf(req);
      if (!(await readEnvironments(projectId)).some(environment => environment.id === (payload?.environmentId || 'local'))) {
        return reply(res, 400, { error: 'Target 环境不存在' });
      }
      let target;
      try {
        target = createTarget(payload, { id: crypto.randomUUID(), projectId, actor: actorOf(req) });
      } catch (error) { return reply(res, 400, { error: error.message }); }
      const result = await mutateTargets(async targets => {
        if (targets.some(item => item.environmentId === target.environmentId && item.endpoint === target.endpoint)) {
          return { status: 409, error: '该环境已存在相同 Target endpoint' };
        }
        targets.push(target);
        return { item: target, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, { error: result.error });
      await appendAuditEvent('target.created', 'target', target.id, `创建部署目标：${target.name}`, { endpoint: target.endpoint }, req);
      return reply(res, 201, target);
    }

    if (segments.length !== 5) return reply(res, 404, { error: '未找到资源' });
    if (segments[4] === 'reconcile') {
      if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
      const stored = await readTargets(projectId);
      const generations = await readActivationGenerations(projectId);
      const effective = effectiveTargets(stored, project, rulesResManagementUrl, cepResUrl);
      const reconciled = await Promise.all(effective.filter(target => target.enabled).map(target => reconcileTarget(target, generations)));
      await mutateTargets(async targets => {
        for (const observed of reconciled) {
          const target = targets.find(item => item.id === observed.id);
          if (!target) continue;
          Object.assign(target, {
            status: observed.status, nodeId: observed.nodeId, engineVersion: observed.engineVersion,
            lastSeenAt: observed.lastSeenAt, lastError: observed.lastError, updatedAt: observed.lastSeenAt,
          });
        }
        return { changed: targets.length > 0 };
      }, projectId);
      return reply(res, 200, reconciled);
    }

    const targetId = segments[4];
    if (req.method === 'PATCH') {
      const payload = await bodyOf(req);
      const result = await mutateTargets(async targets => {
        const target = targets.find(item => item.id === targetId);
        if (!target) return { status: 404, error: 'Target 不存在' };
        try { updateTarget(target, payload); }
        catch (error) { return { status: 400, error: error.message }; }
        if (targets.some(item => item !== target && item.environmentId === target.environmentId && item.endpoint === target.endpoint)) {
          return { status: 409, error: '该环境已存在相同 Target endpoint' };
        }
        return { item: target, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, { error: result.error });
      return reply(res, 200, result.item);
    }
    if (req.method === 'DELETE') {
      const generations = await readActivationGenerations(projectId);
      if (generations.some(item => ['preparing', 'activating', 'active', 'draining'].includes(item.status)
          && item.targets?.some(state => state.targetId === targetId))) {
        return reply(res, 409, { error: 'Target 正被 generation 使用，请先禁用并完成排空' });
      }
      const result = await mutateTargets(async targets => {
        const index = targets.findIndex(item => item.id === targetId);
        if (index < 0) return { status: 404, error: 'Target 不存在' };
        return { item: targets.splice(index, 1)[0], changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, { error: result.error });
      return reply(res, 200, { deleted: true, id: targetId });
    }
    return reply(res, 405, { error: 'Method not allowed' });
  };
}

export function createActivationGenerationHandler({ readActivationGenerations }) {
  return async function handleActivationGenerations(req, res, projectId) {
    if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
    return reply(res, 200, await readActivationGenerations(projectId));
  };
}
