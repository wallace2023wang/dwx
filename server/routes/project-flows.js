import crypto from 'node:crypto';
import { newFlow, validateFlow } from '../../shared/assets.js';
import { nextRulesetName, rulesetNameConflict } from '../../shared/ruleset-names.js';
import { bodyOf, operationError, reply, revisionConflict } from '../http-utils.js';

export function createProjectFlowHandler({
  canAccessAsset,
  authorizeAsset,
  mutateAssets,
  initializeAssetRevision,
  appendAuditEvent,
  projectRuleset,
  projectFlowDetail,
  reviewLock,
  advanceAssetRevision,
  compileProjectFlow,
  publishProjectFlow,
}) {
  return async function handleProjectFlows(req, res, segments, projectId, data, packageRecords) {
    if (segments.length === 4 && segments[3] === 'rulesets' && req.method === 'GET') {
      return reply(res, 200, data.flows.filter(item => canAccessAsset(req.principal, item.id)).map(item => projectRuleset(item, data)));
    }
    if (segments.length === 4 && segments[3] === 'flows' && req.method === 'GET') {
      return reply(res, 200, data.flows.filter(item => canAccessAsset(req.principal, item.id)).map(item => projectRuleset(item, data)));
    }
    if (segments.length === 4 && segments[3] === 'flows' && req.method === 'POST') {
      const result = await mutateAssets('flows', flows => {
        const now = new Date().toISOString();
        const draft = newFlow();
        draft.name = nextRulesetName(flows, draft.name);
        const item = initializeAssetRevision({
          id: crypto.randomUUID(), draft, published: null, versions: [], archived: false, updatedAt: now,
        });
        flows.unshift(item);
        return { item };
      }, projectId);
      await appendAuditEvent('asset.created', 'flow', result.item.id, `创建规则集：${result.item.draft.name}`, { revision: 1 }, req);
      return reply(res, 201, projectFlowDetail(result.item, data));
    }
    if (segments.length === 5 && segments[3] === 'flows' && req.method === 'GET') {
      const item = data.flows.find(flow => flow.id === segments[4]);
      if (item) authorizeAsset(req.principal, item.id);
      return item ? reply(res, 200, projectFlowDetail(item, data)) : reply(res, 404, { error: '规则集不存在' });
    }
    if (segments.length === 5 && segments[3] === 'flows' && req.method === 'PUT') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const locked = reviewLock(data.changeSets, id);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const payload = await bodyOf(req);
      if (!Number.isInteger(payload?.revision) || payload.revision < 1) return reply(res, 400, { error: '修订号无效' });
      const validation = validateFlow(payload?.draft, data.rules, data.tables, data.bom, packageRecords, { allowEmptyRuleGroups: true });
      if (validation) return reply(res, 400, { error: validation });
      const result = await mutateAssets('flows', flows => {
        const item = flows.find(flow => flow.id === id && !flow.archived);
        if (!item) return { status: 404, error: '规则集不存在' };
        const conflict = revisionConflict(item, payload.revision);
        if (conflict) return conflict;
        const nameConflict = rulesetNameConflict(flows, item, payload.draft.name, { allowUnchanged: true });
        if (nameConflict) return nameConflict;
        item.draft = structuredClone(payload.draft);
        advanceAssetRevision(item, 'saved', true);
        return { item };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('asset.saved', 'flow', id, `保存规则集：${result.item.draft.name}`, { revision: result.item.revision }, req);
      return reply(res, 200, projectFlowDetail(result.item, data));
    }
    if (segments.length === 6 && segments[3] === 'flows' && req.method === 'POST') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const item = data.flows.find(flow => flow.id === id);
      if (!item) return reply(res, 404, { error: '规则集不存在' });
      const payload = await bodyOf(req);
      if (segments[5] === 'compile') {
        const result = await compileProjectFlow(item, payload, data);
        return result.error ? reply(res, result.status, operationError(result)) : reply(res, 200, result.result);
      }
      if (segments[5] === 'publish') {
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const result = await publishProjectFlow(id, payload?.revision, data, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.publish', 'flow', id, `发布规则集：${result.item.draft.name}`, {
          revision: result.item.revision, version: result.item.versions.at(-1)?.number || null,
        }, req);
        return reply(res, 200, projectFlowDetail(result.item, data));
      }
      return reply(res, 404, { error: '未找到操作' });
    }
    return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
  };
}
