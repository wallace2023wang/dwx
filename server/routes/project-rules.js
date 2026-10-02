import crypto from 'node:crypto';
import { newRule } from '../../shared/rules.js';
import { newTable, tableDrl, validateTable } from '../../shared/assets.js';
import { inputFields, outputFields } from '../../shared/bom.js';
import { snapshotChangeItem } from '../../shared/changes.js';
import { canonicalPackageName, packageLabel, PACKAGE_NAME_RE } from '../../shared/packages.js';
import { normalizePackageReferences } from '../domain-utils.js';
import { bodyOf, operationError, reply, revisionConflict } from '../http-utils.js';

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
      const type = payload?.type === 'decision-table' || payload?.type === 'table' ? 'table' : 'rule';
      const now = new Date().toISOString();
      const draft = type === 'table' ? newTable() : newRule();
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
      const result = type === 'table'
        ? await mutateAssets('tables', assets => { assets.unshift(initial); return { item: initial }; }, projectId)
        : await mutate(rules => { rules.unshift(initial); return { item: initial }; }, projectId);
      await appendAuditEvent('asset.created', type, result.item.id, `创建${type === 'table' ? '决策表' : '规则'}：${draft.name}`, { revision: 1 }, req);
      return reply(res, 201, projectAssetDetail(result.item, type, data.bom, data.changeSets));
    }
    if (segments.length === 5 && segments[3] === 'rules' && req.method === 'GET') {
      const rule = data.rules.find(item => item.id === segments[4]);
      if (rule) { authorizeAsset(req.principal, rule.id); return reply(res, 200, projectAssetDetail(rule, 'rule', data.bom, data.changeSets)); }
      const table = data.tables.find(item => item.id === segments[4]);
      if (table) { authorizeAsset(req.principal, table.id); return reply(res, 200, projectAssetDetail(table, 'table', data.bom, data.changeSets)); }
      return reply(res, 404, { error: '资产不存在' });
    }
    if (segments.length === 5 && segments[3] === 'rules' && req.method === 'PUT') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const type = data.rules.some(item => item.id === id) ? 'rule' : data.tables.some(item => item.id === id) ? 'table' : null;
      if (!type) return reply(res, 404, { error: '资产不存在' });
      const locked = reviewLock(data.changeSets, id);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const result = await saveProjectAsset(id, type, await bodyOf(req), projectId, data.bom);
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('asset.saved', type, id, `保存${type === 'rule' ? '规则' : '决策表'}：${result.item.draft.name}`, { revision: result.item.revision }, req);
      return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets));
    }
    if (segments.length === 5 && segments[3] === 'rules' && req.method === 'DELETE') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const type = data.rules.some(item => item.id === id) ? 'rule' : data.tables.some(item => item.id === id) ? 'table' : null;
      if (!type) return reply(res, 404, { error: '资产不存在' });
      const locked = reviewLock(data.changeSets, id);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const archive = assets => {
        const item = assets.find(asset => asset.id === id);
        if (!item) return { status: 404, error: '资产不存在' };
        item.archived = true;
        advanceAssetRevision(item, 'saved');
        return { item };
      };
      const result = type === 'rule' ? await mutate(archive, projectId) : await mutateAssets('tables', archive, projectId);
      return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets));
    }
    if (segments.length === 6 && segments[3] === 'rules' && req.method === 'POST') {
      const id = segments[4];
      authorizeAsset(req.principal, id);
      const action = segments[5];
      const item = data.rules.find(asset => asset.id === id) || data.tables.find(asset => asset.id === id);
      const type = data.rules.some(asset => asset.id === id) ? 'rule' : item ? 'table' : null;
      if (!item || !type) return reply(res, 404, { error: '资产不存在' });
      const payload = await bodyOf(req);
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
          };
          changeSets.unshift(changeSet);
          return { item: changeSet, asset: current, changed: true };
        }, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('change-set.submit', 'change-set', result.item.id, `提交审核：${result.item.name}`, {
          revision: result.item.revision, itemCount: 1, assetId: id,
        }, req);
        const changeSets = await readChangeSets(projectId);
        return reply(res, 201, { ...projectAssetDetail(result.asset, type, data.bom, changeSets), changeSetId: result.item.id });
      }
      if (action === 'analyze' && type === 'table') {
        const draft = normalizePackageReferences(structuredClone(payload?.draft || item.draft));
        const validation = validateTable(draft, data.bom);
        let drl = null;
        if (!validation.error) drl = tableDrl(draft, data.bom, item.id);
        return reply(res, 200, { error: validation.error, warnings: validation.warnings, drl });
      }
      if (action === 'duplicate') {
        const newName = typeof payload?.newName === 'string' ? payload.newName.trim() : '';
        if (!newName || newName.length > 80) return reply(res, 400, { error: '新资产名称需为 1-80 个字符' });
        const now = new Date().toISOString();
        const duplicate = initializeAssetRevision({ id: crypto.randomUUID(), draft: { ...structuredClone(item.draft), name: newName }, published: null, versions: [], archived: false, updatedAt: now });
        const result = type === 'rule'
          ? await mutate(assets => { assets.unshift(duplicate); return { item: duplicate }; }, projectId)
          : await mutateAssets('tables', assets => { assets.unshift(duplicate); return { item: duplicate }; }, projectId);
        return reply(res, 201, projectAssetDetail(result.item, type, data.bom, data.changeSets));
      }
      if (action === 'rename') {
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const newName = typeof payload?.newName === 'string' ? payload.newName.trim() : '';
        if (!newName || newName.length > 80) return reply(res, 400, { error: '资产名称需为 1-80 个字符' });
        const rename = assets => {
          const target = assets.find(asset => asset.id === id && !asset.archived);
          if (!target) return { status: 404, error: '资产不存在' };
          const conflict = revisionConflict(target, payload?.revision);
          if (conflict) return conflict;
          target.draft.name = newName;
          advanceAssetRevision(target, 'saved', true);
          return { item: target };
        };
        const result = type === 'rule' ? await mutate(rename, projectId) : await mutateAssets('tables', rename, projectId);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.renamed', type, id, `重命名${type === 'rule' ? '规则' : '决策表'}：${newName}`, { revision: result.item.revision }, req);
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets));
      }
      if (action === 'move') {
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const targetPackage = canonicalPackageName(payload?.targetPackage);
        if (!packageRecords.some(pkg => pkg.name === targetPackage)) return reply(res, 400, { error: '目标规则包不存在' });
        const move = assets => {
          const target = assets.find(asset => asset.id === id);
          target.draft.category = targetPackage;
          advanceAssetRevision(target, 'saved', true);
          return { item: target };
        };
        const result = type === 'rule' ? await mutate(move, projectId) : await mutateAssets('tables', move, projectId);
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets));
      }
      if (action === 'compile') {
        const result = await compileProjectAsset(item, type, payload, data.bom, data.project);
        return result.error ? reply(res, result.status, operationError(result)) : reply(res, 200, result.result);
      }
      if (action === 'publish') {
        const locked = reviewLock(data.changeSets, id);
        if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
        const result = await publishProjectAsset(id, type, payload?.revision, projectId, data.bom, data.project);
        if (result.error) return reply(res, result.status, operationError(result));
        await appendAuditEvent('asset.publish', type, id, `发布${type === 'rule' ? '规则' : '决策表'}：${result.item.draft.name}`, {
          revision: result.item.revision, version: result.item.versions.at(-1)?.number || null,
        }, req);
        return reply(res, 200, projectAssetDetail(result.item, type, data.bom, data.changeSets));
      }
      return reply(res, 404, { error: '未找到操作' });
    }
    return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
  };
}
