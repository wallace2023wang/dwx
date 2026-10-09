import crypto from 'node:crypto';
import { eventSchemasFromBom, eventStreamDependencyImpact, normalizeEventStreamDraft, validateEventStreamDraft } from '../../shared/event-streams.js';
import { bodyOf, operationError, reply, revisionConflict } from '../http-utils.js';
import { assignAssetOwner, claimAssetDraft, draftOwnershipError } from '../asset-ownership.js';

export function createProjectEventStreamHandler({
  projectBomModel,
  mutateAssets,
  initializeAssetRevision,
  appendAuditEvent,
  projectEventStreamSummary,
  projectEventStreamDetail,
  authorizeAsset,
  reviewLock,
  advanceAssetRevision,
  compileProjectEventStream,
  publishProjectEventStream,
  actorOf,
}) {
  const canEditAdvancedEpl = principal => principal?.permissions?.includes('*') || principal?.permissions?.includes('advanced-epl');
  const isAdvancedEpl = statement => statement?.mode !== 'guided' || !statement?.template || !statement?.params;
  const advancedEplChanged = (previous, next) => {
    const runtime = draft => (draft?.statements || [])
      .filter(isAdvancedEpl)
      .map(statement => ({ name: statement.name, epl: statement.epl, enabled: statement.enabled !== false }));
    return JSON.stringify(runtime(previous)) !== JSON.stringify(runtime(next));
  };
  return async function handleProjectEventStreams(req, res, segments, projectId, data) {
    if (segments.length === 4 && segments[3] === 'event-streams' && req.method === 'GET') {
      const includeArchived = new URL(req.url, 'http://localhost').searchParams.get('archived') === 'true';
      const items = includeArchived ? (data.allEventStreams || []).filter(item => item.archived) : data.eventStreams;
      return reply(res, 200, items.map(projectEventStreamSummary));
    }
    if (segments.length === 4 && segments[3] === 'event-streams' && req.method === 'POST') {
      const payload = await bodyOf(req);
      const draft = normalizeEventStreamDraft(payload?.draft || payload || {});
      if (typeof payload?.name === 'string' && payload.name.trim()) draft.name = payload.name.trim();
      if (!draft.statements.length) {
        const schema = eventSchemasFromBom(data.bom).at(0)?.name || projectBomModel(data, data.bom).factTypes?.[0]?.name || 'DefaultEvent';
        draft.statements = [{ name: 'DetectEvent', enabled: true, epl: `select * from ${schema}` }];
      }
      const validation = validateEventStreamDraft(draft, data.bom);
      if (validation) return reply(res, 400, { error: validation });
      if (!canEditAdvancedEpl(req.principal) && draft.statements.some(isAdvancedEpl)) {
        return reply(res, 403, { error: '当前角色缺少 advanced-epl 权限，不能创建高级 EPL 语句' });
      }
      const result = await mutateAssets('eventStreams', assets => {
        const now = new Date().toISOString();
        const item = initializeAssetRevision({ id: crypto.randomUUID(), draft, published: null, versions: [], archived: false, updatedAt: now });
        claimAssetDraft(item, req.principal);
        assets.unshift(item);
        return { item };
      }, projectId);
      await appendAuditEvent('asset.created', 'event-stream', result.item.id, `创建事件流：${result.item.draft.name}`, { revision: 1 }, req);
      return reply(res, 201, projectEventStreamDetail(result.item, data));
    }
    if (segments.length === 5 && segments[3] === 'event-streams' && req.method === 'GET') {
      const item = (data.allEventStreams || data.eventStreams).find(stream => stream.id === segments[4]);
      return item ? reply(res, 200, projectEventStreamDetail(item, data)) : reply(res, 404, { error: '事件流不存在' });
    }
    if (segments.length === 5 && segments[3] === 'event-streams' && req.method === 'PUT') {
      const id = segments[4];
      const payload = await bodyOf(req);
      if (!Number.isInteger(payload?.revision) || payload.revision < 1) return reply(res, 400, { error: '修订号无效' });
      const draft = normalizeEventStreamDraft(payload?.draft);
      const existing = data.eventStreams.find(stream => stream.id === id && !stream.archived);
      if (!existing) return reply(res, 404, { error: '事件流不存在' });
      const dependencyImpact = eventStreamDependencyImpact(existing.draft, draft);
      if (dependencyImpact.length) return reply(res, 409, operationError({
        status: 409,
        code: 'EVENT_STREAM_DEPENDENCY_CONFLICT',
        error: dependencyImpact.map(impact => `派生事件 ${impact.eventType} 仍被语句 ${impact.consumers.join('、')} 引用`).join('；'),
        details: { dependencies: dependencyImpact },
      }));
      if (!canEditAdvancedEpl(req.principal) && advancedEplChanged(existing.draft, draft)) {
        return reply(res, 403, { error: '当前角色缺少 advanced-epl 权限，不能新增、切换或修改高级 EPL' });
      }
      const validation = validateEventStreamDraft(draft, data.bom);
      if (validation) return reply(res, 400, { error: validation });
      const result = await mutateAssets('eventStreams', assets => {
        const item = assets.find(stream => stream.id === id && !stream.archived);
        if (!item) return { status: 404, error: '事件流不存在' };
        const ownership = draftOwnershipError(req.principal, item);
        if (ownership) return ownership;
        const conflict = revisionConflict(item, payload.revision);
        if (conflict) return conflict;
        claimAssetDraft(item, req.principal);
        item.draft = structuredClone(draft);
        advanceAssetRevision(item, 'saved', true);
        return { item };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('asset.saved', 'event-stream', id, `保存事件流：${result.item.draft.name}`, { revision: result.item.revision }, req);
      return reply(res, 200, projectEventStreamDetail(result.item, { ...data, eventStreams: [result.item] }));
    }
    if (segments.length === 5 && segments[3] === 'event-streams' && req.method === 'DELETE') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const locked = reviewLock(data.changeSets, id);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const payload = await bodyOf(req);
      if (!Number.isInteger(payload?.revision) || payload.revision < 1) return reply(res, 400, { error: '修订号无效' });
      const result = await mutateAssets('eventStreams', assets => {
        const item = assets.find(stream => stream.id === id && !stream.archived);
        if (!item) return { status: 404, error: '事件流不存在' };
        const ownership = draftOwnershipError(req.principal, item);
        if (ownership) return ownership;
        const conflict = revisionConflict(item, payload.revision);
        if (conflict) return conflict;
        item.archived = true;
        advanceAssetRevision(item, 'archived', true);
        return { item };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('asset.archive', 'event-stream', id, `删除事件流：${result.item.draft.name}`, {
        revision: result.item.revision, publishedVersion: result.item.versions.at(-1)?.number || null,
      }, req);
      return reply(res, 204, '');
    }
    if (segments.length === 6 && segments[3] === 'event-streams' && req.method === 'POST') {
      const id = segments[4];
      const action = segments[5];
      const item = (data.allEventStreams || data.eventStreams).find(stream => stream.id === id);
      if (!item) return reply(res, 404, { error: '事件流不存在' });
      const payload = await bodyOf(req);
      if (action === 'transfer-owner') {
        const ownerId = typeof payload?.ownerId === 'string' ? payload.ownerId.trim() : '';
        const ownerName = typeof payload?.ownerName === 'string' ? payload.ownerName.trim() : ownerId;
        if (!ownerId || ownerId.length > 120 || ownerName.length > 120) return reply(res, 400, { error: '负责人无效' });
        const result = await mutateAssets('eventStreams', assets => {
          const target = assets.find(stream => stream.id === id && !stream.archived);
          if (!target) return { status: 404, error: '事件流不存在' };
          const ownership = draftOwnershipError(req.principal, target);
          if (ownership) return ownership;
          const conflict = revisionConflict(target, payload?.revision);
          if (conflict) return conflict;
          const previousOwnerId = target.ownerId || null;
          assignAssetOwner(target, ownerId, ownerName);
          advanceAssetRevision(target, 'owner-transferred');
          return { item: target, previousOwnerId };
        }, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.owner-transferred', 'event-stream', id, `转交负责人：${result.item.draft.name}`, {
          revision: result.item.revision, previousOwnerId: result.previousOwnerId, ownerId,
        }, req);
        return reply(res, 200, projectEventStreamDetail(result.item, { ...data, eventStreams: [result.item] }));
      }
      if (action === 'restore') {
        authorizeAsset(req.principal, id);
        const ownership = draftOwnershipError(req.principal, item);
        if (ownership) return reply(res, ownership.status, { error: ownership.error });
        if (!item.archived) return reply(res, 409, { error: '只有已归档事件流可以恢复' });
        if (!Number.isInteger(payload?.revision) || payload.revision < 1) return reply(res, 400, { error: '修订号无效' });
        const validation = validateEventStreamDraft(item.draft, data.bom);
        if (validation) return reply(res, 409, { error: `当前 BOM 已不兼容该事件流：${validation}` });
        if (data.eventStreams.some(stream => stream.id !== id && stream.draft.name === item.draft.name)) {
          return reply(res, 409, { error: `已有同名活动事件流：${item.draft.name}` });
        }
        const result = await mutateAssets('eventStreams', assets => {
          const target = assets.find(stream => stream.id === id && stream.archived);
          if (!target) return { status: 404, error: '已归档事件流不存在' };
          const currentOwnership = draftOwnershipError(req.principal, target);
          if (currentOwnership) return currentOwnership;
          const conflict = revisionConflict(target, payload.revision);
          if (conflict) return conflict;
          target.archived = false;
          target.lifecycleStatus = 'active';
          target.published = null;
          advanceAssetRevision(target, 'restored', true);
          return { item: target };
        }, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.restored', 'event-stream', id, `恢复事件流：${result.item.draft.name}`, {
          revision: result.item.revision, preservedVersions: result.item.versions.length,
        }, req);
        return reply(res, 200, projectEventStreamDetail(result.item, { ...data, eventStreams: [result.item] }));
      }
      if (action === 'compile') {
        const result = await compileProjectEventStream(item, payload, data);
        return result.error ? reply(res, result.status, operationError(result)) : reply(res, 200, result.result);
      }
      if (action === 'publish') {
        const ownership = draftOwnershipError(req.principal, item);
        if (ownership) return reply(res, ownership.status, { error: ownership.error });
        const result = await publishProjectEventStream(id, payload?.revision, projectId, data, actorOf(req), req.principal);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.publish', 'event-stream', id, `发布事件流：${result.item.draft.name}`, {
          revision: result.item.revision, version: result.item.versions.at(-1)?.number || null,
        }, req);
        return reply(res, 200, projectEventStreamDetail(result.item, { ...data, eventStreams: [result.item] }));
      }
      return reply(res, 404, { error: '未找到操作' });
    }
    return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
  };
}
