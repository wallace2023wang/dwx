import crypto from 'node:crypto';
import { normalizeChangeSetReferences, snapshotChangeItem, validateChangeSet } from '../../shared/changes.js';
import { bodyOf, expectedRevision, operationError, reply } from '../http-utils.js';

export function createChangeSetHandler({
  readChangeSets,
  mutateChangeSets,
  readRules,
  readAssets,
  readBom,
  projectData,
  readProjectRecord,
  compileProjectEventStream,
  compileProjectFlow,
  compileProjectAsset,
  publishProjectEventStream,
  publishProjectFlow,
  publishProjectAsset,
  actorOf,
  appendAuditEvent,
  serializeReview,
}) {
  async function pinChangeSetItems(items, projectId = 'default') {
    const [rules, tables, flows, eventStreams] = await Promise.all([readRules(projectId), readAssets('tables', projectId), readAssets('flows', projectId), readAssets('eventStreams', projectId)]);
    const collections = { rule: rules, table: tables, flow: flows, 'event-stream': eventStreams };
    const pinned = [];
    for (const reference of items) {
      const asset = collections[reference.type].find(item => item.id === reference.id && !item.archived);
      if (!asset) return { error: `${reference.type}:${reference.id} 不存在或已归档` };
      pinned.push(snapshotChangeItem(reference.type, asset));
    }
    return { items: pinned };
  }

  function changeSetConflict(item, expected) {
    return expected != null && expected !== item.revision ? {
      status: 409, error: `变更集修订冲突：客户端 r${expected}，服务器最新 r${item.revision}，请刷新后重试`,
      expectedRevision: expected,
      currentRevision: item.revision, current: item,
    } : null;
  }

  async function publishReviewedChangeSet(changeSet, projectId) {
    const data = await projectData(projectId);
    data.project = await readProjectRecord(projectId);
    const bom = changeSet.bom || data.bom;
    const collections = { rule: data.rules, table: data.tables, flow: data.flows, 'event-stream': data.eventStreams };
    const targets = [];
    for (const pinned of changeSet.items) {
      const asset = collections[pinned.assetType]?.find(item => item.id === pinned.assetId && !item.archived);
      if (!asset) return { status: 409, error: `${pinned.name} 已不存在或已归档` };
      if ((asset.revision || 1) !== pinned.assetRevision) return { status: 409, error: `${pinned.name} 已在提交后发生变化，请驳回并重新提交` };
      const checked = pinned.assetType === 'event-stream'
        ? await compileProjectEventStream(asset, { revision: pinned.assetRevision, draft: asset.draft }, { ...data, bom })
        : pinned.assetType === 'flow'
        ? await compileProjectFlow(asset, { revision: pinned.assetRevision, draft: asset.draft }, { ...data, bom })
        : await compileProjectAsset(asset, pinned.assetType, { revision: pinned.assetRevision, draft: asset.draft }, bom, data.project);
      if (checked.error) return { status: checked.status, error: `${pinned.name}：${checked.error}` };
      targets.push({ pinned, asset });
    }
    for (const { pinned } of targets) {
      const published = pinned.assetType === 'event-stream'
        ? await publishProjectEventStream(pinned.assetId, pinned.assetRevision, projectId, { ...data, bom })
        : pinned.assetType === 'flow'
        ? await publishProjectFlow(pinned.assetId, pinned.assetRevision, { ...data, bom }, projectId)
        : await publishProjectAsset(pinned.assetId, pinned.assetType, pinned.assetRevision, projectId, bom, data.project);
      if (published.error) return published;
    }
    return { status: 200 };
  }

  async function validateProjectChangeSetSubmission(changeSet, projectId) {
    const [data, allChangeSets] = await Promise.all([projectData(projectId), readChangeSets(projectId)]);
    data.project = await readProjectRecord(projectId);
    const bom = changeSet.bom || data.bom;
    const collections = { rule: data.rules, table: data.tables, flow: data.flows, 'event-stream': data.eventStreams };
    for (const pinned of changeSet.items) {
      const duplicate = allChangeSets.find(candidate => candidate.id !== changeSet.id && candidate.status === 'SUBMITTED'
        && candidate.items?.some(entry => entry.assetId === pinned.assetId));
      if (duplicate) return { status: 409, error: `${pinned.name} 已在变更集“${duplicate.name}”中审核` };
      const asset = collections[pinned.assetType]?.find(item => item.id === pinned.assetId && !item.archived);
      if (!asset) return { status: 409, error: `${pinned.name} 已不存在或已归档` };
      if ((asset.revision || 1) !== pinned.assetRevision) return { status: 409, error: `${pinned.name} 已发生变化，请更新变更集后重新提交` };
      const checked = pinned.assetType === 'event-stream'
        ? await compileProjectEventStream(asset, { revision: pinned.assetRevision, draft: asset.draft }, { ...data, bom })
        : pinned.assetType === 'flow'
        ? await compileProjectFlow(asset, { revision: pinned.assetRevision, draft: asset.draft }, { ...data, bom })
        : await compileProjectAsset(asset, pinned.assetType, { revision: pinned.assetRevision, draft: asset.draft }, bom, data.project);
      if (checked.error) return { status: checked.status, error: `${pinned.name}：${checked.error}` };
    }
    return { status: 200 };
  }

  return async function handleChangeSets(req, res, segments, projectId = 'default', publishOnApprove = false) {
    if (segments.length === 2) {
      if (req.method === 'GET') return reply(res, 200, await readChangeSets(projectId));
      if (req.method === 'POST') {
        const rawInput = await bodyOf(req);
        const input = rawInput && typeof rawInput === 'object'
          ? { ...rawInput, items: normalizeChangeSetReferences(rawInput.items) }
          : rawInput;
        const validation = validateChangeSet(input);
        if (validation) return reply(res, 400, { error: validation });
        const pinned = await pinChangeSetItems(input.items, projectId);
        if (pinned.error) return reply(res, 400, { error: pinned.error });
        const bom = await readBom(projectId);
        const result = await mutateChangeSets(changeSets => {
          const now = new Date().toISOString();
          const item = {
            id: crypto.randomUUID(), revision: 1, status: 'DRAFT',
            name: input.name.trim(), description: input.description?.trim() || '', items: pinned.items,
            bomVersion: bom.version, bom: structuredClone(bom),
            createdBy: actorOf(req), createdAt: now, updatedAt: now,
            submittedAt: null, decidedAt: null, decisionComment: '',
          };
          changeSets.unshift(item);
          return { item, changed: true };
        }, projectId);
        await appendAuditEvent('change-set.created', 'change-set', result.item.id, `创建变更集：${result.item.name}`, { revision: 1, itemCount: result.item.items.length }, req);
        return reply(res, 201, result.item);
      }
    }
    if (segments.length < 3 || segments.length > 4) return reply(res, 404, { error: '未找到资源' });
    const id = segments[2];
    if (segments.length === 3 && req.method === 'GET') {
      const item = (await readChangeSets(projectId)).find(changeSet => changeSet.id === id);
      return item ? reply(res, 200, item) : reply(res, 404, { error: '变更集不存在' });
    }
    if (segments.length === 3 && req.method === 'PUT') {
      const rawInput = await bodyOf(req);
      const input = rawInput && typeof rawInput === 'object'
        ? { ...rawInput, items: normalizeChangeSetReferences(rawInput.items) }
        : rawInput;
      const expected = expectedRevision(req, input);
      if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
      const validation = validateChangeSet(input);
      if (validation) return reply(res, 400, { error: validation });
      const pinned = await pinChangeSetItems(input.items, projectId);
      if (pinned.error) return reply(res, 400, { error: pinned.error });
      const result = await mutateChangeSets(changeSets => {
        const item = changeSets.find(changeSet => changeSet.id === id);
        if (!item) return { status: 404, error: '变更集不存在' };
        const conflict = changeSetConflict(item, expected);
        if (conflict) return conflict;
        if (item.status !== 'DRAFT') return { status: 409, error: '只有草稿状态的变更集可以编辑' };
        item.name = input.name.trim();
        item.description = input.description?.trim() || '';
        item.items = pinned.items;
        item.revision += 1;
        item.updatedAt = new Date().toISOString();
        return { item, changed: true };
      }, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('change-set.updated', 'change-set', id, `更新变更集：${result.item.name}`, { revision: result.item.revision, itemCount: result.item.items.length }, req);
      return reply(res, 200, result.item);
    }
    if (segments.length === 4 && req.method === 'POST') {
      return serializeReview(async () => {
        const action = segments[3];
        if (!['submit', 'approve', 'reject', 'reopen'].includes(action)) return reply(res, 404, { error: '未找到操作' });
        const input = await bodyOf(req);
        const expected = expectedRevision(req, input);
        if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
        const current = (await readChangeSets(projectId)).find(changeSet => changeSet.id === id);
        if (!current) return reply(res, 404, { error: '变更集不存在' });
        const currentConflict = changeSetConflict(current, expected);
        if (currentConflict) return reply(res, currentConflict.status, operationError(currentConflict));
        if (action === 'approve' && current.status !== 'SUBMITTED') return reply(res, 409, { error: '当前状态不能执行approve操作' });
        if (action === 'submit' && current.status !== 'DRAFT') return reply(res, 409, { error: '当前状态不能执行submit操作' });
        if (action === 'approve' && req.principal.mode === 'oidc' && current.createdBy === actorOf(req)) {
          return reply(res, 403, { error: '提交人不能审批自己的变更' });
        }
        if (action === 'submit' && publishOnApprove) {
          const checked = await validateProjectChangeSetSubmission(current, projectId);
          if (checked.error) return reply(res, checked.status, { error: checked.error });
        }
        if (action === 'approve' && publishOnApprove) {
          const published = await publishReviewedChangeSet(current, projectId);
          if (published.error) return reply(res, published.status, { error: published.error });
        }
        const result = await mutateChangeSets(changeSets => {
          const item = changeSets.find(changeSet => changeSet.id === id);
          if (!item) return { status: 404, error: '变更集不存在' };
          const conflict = changeSetConflict(item, expected);
          if (conflict) return conflict;
          const transitions = {
            submit: ['DRAFT', 'SUBMITTED'], approve: ['SUBMITTED', 'APPROVED'],
            reject: ['SUBMITTED', 'REJECTED'], reopen: ['REJECTED', 'DRAFT'],
          };
          const [from, to] = transitions[action];
          if (item.status !== from) return { status: 409, error: `当前状态不能执行${action}操作` };
          if (action === 'submit' && !item.items.length) return { status: 400, error: '空变更集不能提交评审' };
          if (action === 'submit' && !item.items.some(entry => entry.changes.length)) return { status: 400, error: '变更集没有实际差异，不能提交评审' };
          if (action === 'reject' && (typeof input.comment !== 'string' || !input.comment.trim())) return { status: 400, error: '驳回时必须填写意见' };
          const now = new Date().toISOString();
          item.status = to;
          item.revision += 1;
          item.updatedAt = now;
          if (action === 'submit') item.submittedAt = now;
          if (['approve', 'reject'].includes(action)) {
            item.decidedAt = now;
            item.decisionComment = input.comment?.trim() || '';
          }
          if (action === 'reopen') {
            item.submittedAt = null;
            item.decidedAt = null;
            item.decisionComment = '';
          }
          return { item, changed: true };
        }, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        const labels = { submit: '提交评审', approve: '批准', reject: '驳回', reopen: '重新打开' };
        await appendAuditEvent(`change-set.${action}`, 'change-set', id, `${labels[action]}：${result.item.name}`, { revision: result.item.revision, comment: input.comment?.trim() || '' }, req);
        return reply(res, 200, result.item);
      });
    }
    return reply(res, 404, { error: '未找到资源' });
  };
}
