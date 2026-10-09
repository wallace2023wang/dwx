import crypto from 'node:crypto';
import { newRule } from '../../shared/rules.js';
import { newTable, tableDrl, validateTable } from '../../shared/assets.js';
import { decisionTreeDrl, isDecisionTree, newDecisionTree, validateDecisionTree } from '../../shared/decision-trees.js';
import { isScorecard, newScorecard, scorecardDrl, validateScorecard } from '../../shared/scorecards.js';
import { isRuleTemplate, newRuleTemplate, ruleTemplateDrl, validateRuleTemplate } from '../../shared/rule-templates.js';
import { inputFields, outputFields } from '../../shared/bom.js';
import { snapshotChangeItem } from '../../shared/changes.js';
import { canonicalPackageName, packageLabel, PACKAGE_NAME_RE } from '../../shared/packages.js';
import { normalizePackageReferences } from '../domain-utils.js';
import { bodyOf, operationError, reply, revisionConflict } from '../http-utils.js';
import { assignAssetOwner, claimAssetDraft, draftOwnershipError } from '../asset-ownership.js';

export function createProjectRuleHandler({
  canAccessAsset,
  authorizeAsset,
  projectPackages,
  projectAssetDetail,
  writePackageRecords,
  initializeAssetRevision,
  mutate,
  mutateAssets,
  appendAuditEvent,
  reviewLock,
  saveProjectAsset,
  advanceAssetRevision,
  compileProjectAsset,
  publishProjectAsset,
  mutateChangeSets,
  submittedChangeSetForAsset,
  readRules,
  readAssets,
  actorOf,
  readChangeSets,
}) {
  return async function handleProjectRules(req, res, segments, url, projectId, data, packageRecords) {
    if (segments.length === 4 && segments[3] === 'rules' && req.method === 'GET') {
      const packageName = url.searchParams.get('package');
      const assets = projectPackages(data.rules, data.tables, packageRecords, data.bom, data.changeSets)
        .filter(entry => !packageName || entry.id === packageName)
        .flatMap(entry => entry.assets)
        .filter(asset => canAccessAsset(req.principal, asset.id));
      return reply(res, 200, assets);
    }
    if (segments.length === 4 && segments[3] === 'rules' && req.method === 'POST') {
      const payload = await bodyOf(req);
      const type = ['decision-table', 'table', 'decision-tree', 'tree', 'scorecard', 'rule-template'].includes(payload?.type) ? 'table' : 'rule';
      const now = new Date().toISOString();
      const draft = payload?.type === 'rule-template'
        ? newRuleTemplate(data.bom)
        : payload?.type === 'scorecard'
        ? newScorecard(data.bom)
        : payload?.type === 'decision-tree' || payload?.type === 'tree'
        ? newDecisionTree(data.bom)
        : type === 'table' ? newTable() : newRule();
      if (typeof payload?.name === 'string' && payload.name.trim()) draft.name = payload.name.trim();
      const category = canonicalPackageName(payload?.category);
      if (!category) return reply(res, 400, { error: '创建资产前必须选择有效规则包' });
      if (!PACKAGE_NAME_RE.test(category)) return reply(res, 400, { error: '规则包需为有效英文包名' });
      if (!packageRecords.some(pkg => pkg.name === category)) {
        packageRecords.push({ name: category, label: packageLabel(category), parentId: null, createdAt: now });
        await writePackageRecords(projectId, packageRecords);
      }
      draft.category = category;
      if (type === 'rule') {
        const firstInput = inputFields(data.bom)[0];
        const firstOutput = outputFields(data.bom)[0];
        draft.conditions = firstInput ? [{ field: firstInput.key, operator: '==', value: '' }] : [];
        draft.actions = firstOutput ? [{ field: firstOutput.key, value: '' }] : [];
      }
      if (type === 'table' && Array.isArray(payload?.conditionFields) && Array.isArray(payload?.actionFields)) {
        draft.hitPolicy = ['FIRST', 'PRIORITY', 'COLLECT'].includes(payload.hitPolicy) ? payload.hitPolicy : 'COLLECT';
        draft.conditions = payload.conditionFields.map(field => ({ field, operator: '==' }));
        draft.actions = payload.actionFields.map(field => ({ field }));
        draft.rows = [{ enabled: true, priority: 0, conditions: draft.conditions.map(() => ''), actions: draft.actions.map(() => '') }];
      }
      const initial = initializeAssetRevision({ id: crypto.randomUUID(), draft, published: null, versions: [], archived: false, updatedAt: now });
      claimAssetDraft(initial, req.principal);
      const result = type === 'table'
        ? await mutateAssets('tables', assets => { assets.unshift(initial); return { item: initial }; }, projectId)
        : await mutate(rules => { rules.unshift(initial); return { item: initial }; }, projectId);
      const assetLabel = isRuleTemplate(draft) ? '规则模板' : isScorecard(draft) ? '计分卡' : isDecisionTree(draft) ? '决策树' : type === 'table' ? '决策表' : '规则';
      await appendAuditEvent('asset.created', type, result.item.id, `创建${assetLabel}：${draft.name}`, { revision: 1 }, req);
      return reply(res, 201, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
    }
    if (segments.length === 5 && segments[3] === 'rules' && req.method === 'GET') {
      const rule = (data.allRules || data.rules).find(item => item.id === segments[4]);
      if (rule) { authorizeAsset(req.principal, rule.id); return reply(res, 200, projectAssetDetail(rule, 'rule', data.bom, data.changeSets, data.project?.variables)); }
      const table = (data.allTables || data.tables).find(item => item.id === segments[4]);
      if (table) { authorizeAsset(req.principal, table.id); return reply(res, 200, projectAssetDetail(table, 'table', data.bom, data.changeSets, data.project?.variables)); }
      return reply(res, 404, { error: '资产不存在' });
    }
    if (segments.length === 5 && segments[3] === 'rules' && req.method === 'PUT') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const type = data.rules.some(item => item.id === id) ? 'rule' : data.tables.some(item => item.id === id) ? 'table' : null;
      if (!type) return reply(res, 404, { error: '资产不存在' });
      const current = (type === 'rule' ? data.rules : data.tables).find(item => item.id === id);
      const ownership = draftOwnershipError(req.principal, current);
      if (ownership) return reply(res, ownership.status, { error: ownership.error });
      if (current?.lifecycleStatus === 'deprecated') return reply(res, 409, { error: '已废弃资产不可编辑，请先恢复为草稿' });
      const locked = reviewLock(data.changeSets, id);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const result = await saveProjectAsset(id, type, await bodyOf(req), projectId, data.bom, data.project, req.principal);
      if (result.error) return reply(res, result.status, operationError(result));
      const assetLabel = isRuleTemplate(result.item.draft) ? '规则模板' : isScorecard(result.item.draft) ? '计分卡' : isDecisionTree(result.item.draft) ? '决策树' : type === 'rule' ? '规则' : '决策表';
      await appendAuditEvent('asset.saved', type, id, `保存${assetLabel}：${result.item.draft.name}`, { revision: result.item.revision }, req);
      return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
    }
    if (segments.length === 5 && segments[3] === 'rules' && req.method === 'DELETE') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const type = data.rules.some(item => item.id === id) ? 'rule' : data.tables.some(item => item.id === id) ? 'table' : null;
      if (!type) return reply(res, 404, { error: '资产不存在' });
      const ownership = draftOwnershipError(req.principal, (type === 'rule' ? data.rules : data.tables).find(item => item.id === id));
      if (ownership) return reply(res, ownership.status, { error: ownership.error });
      const locked = reviewLock(data.changeSets, id);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const archive = assets => {
        const item = assets.find(asset => asset.id === id);
        if (!item) return { status: 404, error: '资产不存在' };
        const currentOwnership = draftOwnershipError(req.principal, item);
        if (currentOwnership) return currentOwnership;
        item.archived = true;
        item.lifecycleStatus = 'archived';
        advanceAssetRevision(item, 'archived', true);
        return { item };
      };
      const result = type === 'rule' ? await mutate(archive, projectId) : await mutateAssets('tables', archive, projectId);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('asset.archived', type, id, `归档${type === 'rule' ? '规则' : '决策表'}：${result.item.draft.name}`, {
        revision: result.item.revision, category: result.item.draft.category,
      }, req);
      return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
    }
    if (segments.length === 6 && segments[3] === 'rules' && req.method === 'POST') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const action = segments[5];
      const item = data.rules.find(asset => asset.id === id) || data.tables.find(asset => asset.id === id);
      const type = data.rules.some(asset => asset.id === id) ? 'rule' : item ? 'table' : null;
      if (!item || !type) return reply(res, 404, { error: '资产不存在' });
      const payload = await bodyOf(req);
      if (action === 'transfer-owner') {
        const ownership = draftOwnershipError(req.principal, item);
        if (ownership) return reply(res, ownership.status, { error: ownership.error });
        const ownerId = typeof payload?.ownerId === 'string' ? payload.ownerId.trim() : '';
        const ownerName = typeof payload?.ownerName === 'string' ? payload.ownerName.trim() : ownerId;
        if (!ownerId || ownerId.length > 120 || ownerName.length > 120) return reply(res, 400, { error: '负责人无效' });
        const transfer = assets => {
          const target = assets.find(asset => asset.id === id && !asset.archived);
          if (!target) return { status: 404, error: '资产不存在' };
          const currentOwnership = draftOwnershipError(req.principal, target);
          if (currentOwnership) return currentOwnership;
          const conflict = revisionConflict(target, payload?.revision);
          if (conflict) return conflict;
          const previousOwnerId = target.ownerId || null;
          assignAssetOwner(target, ownerId, ownerName);
          advanceAssetRevision(target, 'owner-transferred');
          return { item: target, previousOwnerId };
        };
        const result = type === 'rule' ? await mutate(transfer, projectId) : await mutateAssets('tables', transfer, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.owner-transferred', type, id, `转交负责人：${result.item.draft.name}`, {
          revision: result.item.revision, previousOwnerId: result.previousOwnerId, ownerId,
        }, req);
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
      }
      const ownership = draftOwnershipError(req.principal, item);
      if (ownership && !['compile', 'duplicate'].includes(action)) return reply(res, ownership.status, { error: ownership.error });
      if (action === 'deprecate' || action === 'reactivate') {
        const expected = payload?.revision;
        if (!Number.isInteger(expected) || expected < 1) return reply(res, 400, { error: '修订号无效' });
        const conflict = revisionConflict(item, expected);
        if (conflict) return reply(res, conflict.status, operationError(conflict));
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        if (action === 'deprecate') {
          if ((item.lifecycleStatus || 'active') !== 'active') return reply(res, 409, { error: '只有活动资产可以标记为废弃' });
          const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
          if (!reason || reason.length > 500) return reply(res, 400, { error: '废弃原因需为 1-500 个字符' });
          const replacementId = typeof payload.replacedByAssetId === 'string' && payload.replacedByAssetId ? payload.replacedByAssetId : null;
          const replacement = replacementId ? [...data.rules, ...data.tables].find(asset => asset.id === replacementId && asset.id !== id && (asset.lifecycleStatus || 'active') === 'active') : null;
          if (replacementId && !replacement) return reply(res, 400, { error: '替代资产不存在、已停用或与当前资产相同' });
          const apply = assets => {
            const target = assets.find(asset => asset.id === id);
            const currentOwnership = draftOwnershipError(req.principal, target);
            if (currentOwnership) return currentOwnership;
            target.lifecycleStatus = 'deprecated';
            target.deprecatedAt = new Date().toISOString();
            target.deprecatedBy = actorOf(req);
            target.deprecationReason = reason;
            target.replacedByAssetId = replacementId;
            advanceAssetRevision(target, 'deprecated', true);
            return { item: target };
          };
          const result = type === 'rule' ? await mutate(apply, projectId) : await mutateAssets('tables', apply, projectId);
          if (result.error) return reply(res, result.status, operationError(result));
          await appendAuditEvent('asset.deprecated', type, id, `标记废弃：${result.item.draft.name}`, {
            revision: result.item.revision, reason, replacedByAssetId: replacementId,
          }, req);
          return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
        }
        if (item.lifecycleStatus !== 'deprecated') return reply(res, 409, { error: '只有已废弃资产可以恢复' });
        const apply = assets => {
          const target = assets.find(asset => asset.id === id);
          const currentOwnership = draftOwnershipError(req.principal, target);
          if (currentOwnership) return currentOwnership;
          target.lifecycleStatus = 'active';
          target.deprecatedAt = null;
          target.deprecatedBy = null;
          target.deprecationReason = null;
          target.replacedByAssetId = null;
          advanceAssetRevision(target, 'reactivated', true);
          return { item: target };
        };
        const result = type === 'rule' ? await mutate(apply, projectId) : await mutateAssets('tables', apply, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.reactivated', type, id, `恢复废弃资产：${result.item.draft.name}`, {
          revision: result.item.revision,
        }, req);
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
      }
      if (item.lifecycleStatus === 'deprecated' && action !== 'duplicate') return reply(res, 409, { error: '已废弃资产不可编辑、提交或发布，请先恢复为草稿' });
      if (action === 'submit') {
        const expected = payload?.revision;
        if (!Number.isInteger(expected) || expected < 1) return reply(res, 400, { error: '修订号无效' });
        const conflict = revisionConflict(item, expected);
        if (conflict) return reply(res, conflict.status, operationError(conflict));
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const checked = await compileProjectAsset(item, type, { revision: expected, draft: item.draft }, data.bom, data.project);
        if (checked.error) return reply(res, checked.status, operationError(checked));
        const result = await mutateChangeSets(async changeSets => {
          const duplicate = submittedChangeSetForAsset(changeSets, id);
          if (duplicate) return { status: 409, error: `资产正在变更集“${duplicate.name}”中审核`, changeSetId: duplicate.id };
          const collection = type === 'rule' ? await readRules(projectId) : await readAssets('tables', projectId);
          const current = collection.find(asset => asset.id === id && !asset.archived);
          if (!current) return { status: 404, error: '资产不存在' };
          const currentOwnership = draftOwnershipError(req.principal, current);
          if (currentOwnership) return currentOwnership;
          const stale = revisionConflict(current, expected);
          if (stale) return stale;
          const pinned = snapshotChangeItem(type, current);
          if (!pinned.changes.length) return { status: 400, error: '资产与已发布版本没有差异，无需提交审核' };
          const now = new Date().toISOString();
          const changeSet = {
            id: crypto.randomUUID(), revision: 1, status: 'SUBMITTED',
            name: `审核：${current.draft.name}`, description: '', items: [pinned],
            bomVersion: data.bom.version, bom: structuredClone(data.bom),
            createdBy: actorOf(req), createdAt: now, updatedAt: now,
            submittedAt: now, decidedAt: null, decisionComment: '',
            approvals: [], reviewPolicySnapshot: structuredClone(data.project.approvalPolicy),
          };
          changeSets.unshift(changeSet);
          return { item: changeSet, asset: current, changed: true };
        }, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('change-set.submit', 'change-set', result.item.id, `提交审核：${result.item.name}`, {
          revision: result.item.revision, itemCount: 1, assetId: id,
        }, req);
        const changeSets = await readChangeSets(projectId);
        return reply(res, 201, { ...projectAssetDetail(result.asset, type, data.bom, changeSets, data.project?.variables), changeSetId: result.item.id });
      }
      if (action === 'analyze' && type === 'table') {
        const draft = normalizePackageReferences(structuredClone(payload?.draft || item.draft));
        const validation = isRuleTemplate(draft)
          ? { error: validateRuleTemplate(draft, data.bom), warnings: [] }
          : isScorecard(draft)
          ? { error: validateScorecard(draft, data.bom, data.project?.variables || []), warnings: [] }
          : isDecisionTree(draft)
          ? { error: validateDecisionTree(draft, data.bom, data.project?.variables || []), warnings: [] }
          : validateTable(draft, data.bom, data.project?.variables || []);
        let drl = null;
        if (!validation.error) drl = isRuleTemplate(draft)
          ? ruleTemplateDrl(draft, data.bom)
          : isScorecard(draft)
          ? scorecardDrl(draft, data.bom, item.id, data.project?.variables || [])
          : isDecisionTree(draft)
          ? decisionTreeDrl(draft, data.bom, item.id, data.project?.variables || [])
          : tableDrl(draft, data.bom, item.id, data.project?.variables || []);
        return reply(res, 200, { error: validation.error, warnings: validation.warnings, drl });
      }
      if (action === 'duplicate') {
        const newName = typeof payload?.newName === 'string' ? payload.newName.trim() : '';
        if (!newName || newName.length > 80) return reply(res, 400, { error: '新资产名称需为 1-80 个字符' });
        const now = new Date().toISOString();
        const duplicate = initializeAssetRevision({ id: crypto.randomUUID(), draft: { ...structuredClone(item.draft), name: newName }, published: null, versions: [], archived: false, updatedAt: now });
        claimAssetDraft(duplicate, req.principal);
        const result = type === 'rule'
          ? await mutate(assets => { assets.unshift(duplicate); return { item: duplicate }; }, projectId)
          : await mutateAssets('tables', assets => { assets.unshift(duplicate); return { item: duplicate }; }, projectId);
        return reply(res, 201, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
      }
      if (action === 'rename') {
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const newName = typeof payload?.newName === 'string' ? payload.newName.trim() : '';
        if (!newName || newName.length > 80) return reply(res, 400, { error: '资产名称需为 1-80 个字符' });
        const rename = assets => {
          const target = assets.find(asset => asset.id === id && !asset.archived);
          if (!target) return { status: 404, error: '资产不存在' };
          const currentOwnership = draftOwnershipError(req.principal, target);
          if (currentOwnership) return currentOwnership;
          const conflict = revisionConflict(target, payload?.revision);
          if (conflict) return conflict;
          target.draft.name = newName;
          advanceAssetRevision(target, 'saved', true);
          return { item: target };
        };
        const result = type === 'rule' ? await mutate(rename, projectId) : await mutateAssets('tables', rename, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.renamed', type, id, `重命名${type === 'rule' ? '规则' : '决策表'}：${newName}`, { revision: result.item.revision }, req);
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
      }
      if (action === 'move') {
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const targetPackage = canonicalPackageName(payload?.targetPackage);
        if (!packageRecords.some(pkg => pkg.name === targetPackage)) return reply(res, 400, { error: '目标规则包不存在' });
        const move = assets => {
          const target = assets.find(asset => asset.id === id);
          const currentOwnership = draftOwnershipError(req.principal, target);
          if (currentOwnership) return currentOwnership;
          target.draft.category = targetPackage;
          advanceAssetRevision(target, 'saved', true);
          return { item: target };
        };
        const result = type === 'rule' ? await mutate(move, projectId) : await mutateAssets('tables', move, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
      }
      if (action === 'compile') {
        const result = await compileProjectAsset(item, type, payload, data.bom, data.project);
        return result.error ? reply(res, result.status, operationError(result)) : reply(res, 200, result.result);
      }
      if (action === 'publish') {
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const result = await publishProjectAsset(id, type, payload?.revision, projectId, data.bom, data.project, req.principal);
        if (result.error) return reply(res, result.status, operationError(result));
        const assetLabel = isRuleTemplate(result.item.draft) ? '规则模板' : isScorecard(result.item.draft) ? '计分卡' : isDecisionTree(result.item.draft) ? '决策树' : type === 'rule' ? '规则' : '决策表';
        await appendAuditEvent('asset.publish', type, id, `发布${assetLabel}：${result.item.draft.name}`, {
          revision: result.item.revision, version: result.item.versions.at(-1)?.number || null,
        }, req);
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets, data.project?.variables));
      }
      return reply(res, 404, { error: '未找到操作' });
    }
    return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
  };
}
