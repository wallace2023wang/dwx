import crypto from 'node:crypto';
import { eventSchemasFromBom, normalizeEventStreamDraft, validateEventStreamDraft } from '../../shared/event-streams.js';
import { bodyOf, operationError, reply, revisionConflict } from '../http-utils.js';

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
  return async function handleProjectEventStreams(req, res, segments, projectId, data) {
    if (segments.length === 4 && segments[3] === 'event-streams' && req.method === 'GET') {
      return reply(res, 200, data.eventStreams.map(projectEventStreamSummary));
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
      const result = await mutateAssets('eventStreams', assets => {
        const now = new Date().toISOString();
        const item = initializeAssetRevision({ id: crypto.randomUUID(), draft, published: null, versions: [], archived: false, updatedAt: now });
        assets.unshift(item);
        return { item };
      }, projectId);
      await appendAuditEvent('asset.created', 'event-stream', result.item.id, `创建事件流：${result.item.draft.name}`, { revision: 1 }, req);
      return reply(res, 201, projectEventStreamDetail(result.item, data));
    }
    if (segments.length === 5 && segments[3] === 'event-streams' && req.method === 'GET') {
      const item = data.eventStreams.find(stream => stream.id === segments[4]);
      return item ? reply(res, 200, projectEventStreamDetail(item, data)) : reply(res, 404, { error: '事件流不存在' });
    }
    if (segments.length === 5 && segments[3] === 'event-streams' && req.method === 'PUT') {
      const id = segments[4];
      const payload = await bodyOf(req);
      if (!Number.isInteger(payload?.revision) || payload.revision < 1) return reply(res, 400, { error: '修订号无效' });
      const draft = normalizeEventStreamDraft(payload?.draft);
      const validation = validateEventStreamDraft(draft, data.bom);
      if (validation) return reply(res, 400, { error: validation });
      const result = await mutateAssets('eventStreams', assets => {
        const item = assets.find(stream => stream.id === id && !stream.archived);
        if (!item) return { status: 404, error: '事件流不存在' };
        const conflict = revisionConflict(item, payload.revision);
        if (conflict) return conflict;
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
      const item = data.eventStreams.find(stream => stream.id === id);
      if (!item) return reply(res, 404, { error: '事件流不存在' });
      const payload = await bodyOf(req);
      if (action === 'compile') {
        const result = await compileProjectEventStream(item, payload, data);
        return result.error ? reply(res, result.status, operationError(result)) : reply(res, 200, result.result);
      }
      if (action === 'publish') {
        const result = await publishProjectEventStream(id, payload?.revision, projectId, data, actorOf(req));
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
