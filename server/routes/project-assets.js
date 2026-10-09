import { assignAssetOwner, draftOwnershipError } from '../asset-ownership.js';
import { advanceAssetRevision, normalizeAssetGovernance } from '../domain-utils.js';
import { bodyOf, operationError, reply, revisionConflict } from '../http-utils.js';

const TYPES = new Set(['rule', 'table', 'flow', 'event-stream']);

export function createProjectAssetHandler({
  authorizeAsset,
  mutateProjectAssets,
  appendAuditEvent,
  reviewLock,
  actorOf,
}) {
  return async function handleProjectAssets(req, res, projectId, data, packageRecords) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
    const payload = await bodyOf(req);
    const action = payload?.action;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!['metadata', 'move', 'archive', 'owner'].includes(action)) return reply(res, 400, { error: '不支持的批量操作' });
    if (!items.length || items.length > 100) return reply(res, 400, { error: '每次需选择 1-100 个资产' });
    const keys = new Set();
    for (const target of items) {
      if (!TYPES.has(target?.type) || typeof target?.id !== 'string' || !target.id || !Number.isInteger(target?.revision) || target.revision < 1) {
        return reply(res, 400, { error: '批量资产参数无效' });
      }
      const key = `${target.type}:${target.id}`;
      if (keys.has(key)) return reply(res, 400, { error: '批量资产不能重复' });
      keys.add(key);
      authorizeAsset(req.principal, target.id);
    }
    let governance;
    let targetPackage;
    let ownerId;
    let ownerName;
    try {
      if (action === 'metadata') governance = normalizeAssetGovernance(payload);
      if (action === 'move') {
        targetPackage = typeof payload.targetPackage === 'string' ? payload.targetPackage.trim() : '';
        if (!targetPackage || !packageRecords.some(pkg => pkg.name === targetPackage)) throw new Error('目标规则包不存在');
        if (items.some(item => !['rule', 'table'].includes(item.type))) throw new Error('批量移动仅支持规则和决策表');
      }
      if (action === 'archive' && items.some(item => !['rule', 'table', 'event-stream'].includes(item.type))) {
        throw new Error('批量归档暂不支持规则集');
      }
      if (action === 'owner') {
        ownerId = typeof payload.ownerId === 'string' ? payload.ownerId.trim() : '';
        ownerName = typeof payload.ownerName === 'string' ? payload.ownerName.trim() : ownerId;
        if (!ownerId || ownerId.length > 120 || ownerName.length > 120) throw new Error('负责人无效');
      }
    } catch (error) { return reply(res, 400, { error: error.message }); }

    const result = await mutateProjectAssets(collections => {
      const targets = [];
      for (const input of items) {
        const item = collections[input.type].find(candidate => candidate.id === input.id);
        if (!item) return { status: 404, error: `资产不存在：${input.id}` };
        const ownership = draftOwnershipError(req.principal, item);
        if (ownership) return ownership;
        const conflict = revisionConflict(item, input.revision);
        if (conflict) return conflict;
        const locked = reviewLock(data.changeSets, input.id);
        if (locked) return locked;
        if (item.archived || item.lifecycleStatus === 'archived') return { status: 409, error: `已归档资产不能批量修改：${item.draft.name}` };
        targets.push({ input, item });
      }
      for (const { item } of targets) {
        if (action === 'metadata') Object.assign(item, governance);
        if (action === 'move') item.draft.category = targetPackage;
        if (action === 'owner') assignAssetOwner(item, ownerId, ownerName);
        if (action === 'archive') {
          item.archived = true;
          item.lifecycleStatus = 'archived';
        }
        advanceAssetRevision(item, action === 'archive' ? 'archived' : action === 'owner' ? 'owner-transferred' : 'metadata-updated', action === 'move');
      }
      return { changed: true, items: targets.map(({ input, item }) => ({ id: item.id, type: input.type, revision: item.revision })) };
    }, projectId);
    if (result.error) return reply(res, result.status, operationError(result));
    await appendAuditEvent(`asset.batch-${action}`, 'project', projectId, `批量${action === 'metadata' ? '更新治理信息' : action === 'move' ? '移动资产' : action === 'owner' ? '转交负责人' : '归档资产'}：${items.length} 项`, {
      action, count: items.length, assetIds: items.map(item => item.id), actor: actorOf(req),
    }, req);
    return reply(res, 200, { ok: true, action, count: result.items.length, items: result.items });
  };
}
