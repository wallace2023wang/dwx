import { canonicalPackageName, PACKAGE_NAME_RE } from '../../shared/packages.js';
import { bodyOf, reply } from '../http-utils.js';

function normalizePackagePayload(payload, packages, currentName = null) {
  let name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  const label = typeof payload?.label === 'string' ? payload.label.trim() : '';
  const parentId = typeof payload?.parentId === 'string' && payload.parentId ? payload.parentId : null;
  if (parentId && !name.includes('.')) name = `${parentId}.${name}`;
  if (!PACKAGE_NAME_RE.test(name)) return { error: '包名必须是最多 3 层的英文小写标识符，例如 eligibility.income' };
  if (!label || label.length > 40) return { error: '中文显示名需为 1-40 个字符' };
  if (packages.some(pkg => pkg.name === name && pkg.name !== currentName)) return { error: '同项目下包名必须唯一' };
  if (parentId && (!packages.some(pkg => pkg.name === parentId) || parentId === currentName)) return { error: '父包不存在或无效' };
  if (parentId && name.split('.').length !== parentId.split('.').length + 1) return { error: '子包必须比父包多一层' };
  return { name, label, parentId };
}

export function createProjectPackageHandler({
  visibleProjectPackages,
  mutatePackageRecords,
  readPackageRecords,
  projectData,
  flowReferencesPackage,
  flowPackageSelectors,
  reviewLock,
  mutate,
  mutateAssets,
  advanceAssetRevision,
}) {
  return async function handleProjectPackages(req, res, segments, projectId, data, packageRecords) {
    if (segments.length === 4 && segments[3] === 'packages' && req.method === 'GET') {
      return reply(res, 200, visibleProjectPackages(req.principal, data.rules, data.tables, packageRecords, data.bom, data.changeSets));
    }
    if (segments.length === 4 && segments[3] === 'packages' && req.method === 'POST') {
      const payload = await bodyOf(req);
      const result = await mutatePackageRecords(projectId, data, records => {
        const normalized = normalizePackagePayload(payload, records);
        if (normalized.error) return { status: 400, error: normalized.error };
        const item = { ...normalized, createdAt: new Date().toISOString() };
        records.push(item);
        return { item, changed: true };
      });
      return result.error ? reply(res, result.status, { error: result.error }) : reply(res, 201, { id: result.item.name, ...result.item, assets: [] });
    }
    if (segments.length === 5 && segments[3] === 'packages' && req.method === 'PUT') {
      const currentName = decodeURIComponent(segments[4]);
      const payload = await bodyOf(req);
      const affected = [...data.rules, ...data.tables].filter(asset => asset.draft.category === currentName || asset.draft.category.startsWith(`${currentName}.`));
      const affectedFlows = data.flows.filter(flow => flowReferencesPackage(flow.draft, currentName));
      const locked = [...affected, ...affectedFlows].map(asset => reviewLock(data.changeSets, asset.id)).find(Boolean);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const result = await mutatePackageRecords(projectId, data, async records => {
        const current = records.find(pkg => pkg.name === currentName);
        if (!current) return { status: 404, error: '规则包不存在' };
        const normalized = normalizePackagePayload(payload, records, currentName);
        if (normalized.error) return { status: 400, error: normalized.error };
        const renameMap = new Map(records.filter(pkg => pkg.name === currentName || pkg.name.startsWith(`${currentName}.`)).map(pkg => [pkg.name, pkg.name === currentName ? normalized.name : `${normalized.name}${pkg.name.slice(currentName.length)}`]));
        const renamed = records.map(pkg => renameMap.has(pkg.name) ? { ...pkg, name: renameMap.get(pkg.name), label: pkg.name === currentName ? normalized.label : pkg.label, parentId: pkg.name === currentName ? normalized.parentId : renameMap.get(pkg.parentId) || pkg.parentId } : pkg);
        records.splice(0, records.length, ...renamed);
        const moveCategories = assets => { for (const asset of assets) if (renameMap.has(asset.draft.category)) { asset.draft.category = renameMap.get(asset.draft.category); advanceAssetRevision(asset, 'saved', true); } return { changed: true }; };
        await mutate(moveCategories, projectId);
        await mutateAssets('tables', moveCategories, projectId);
        await mutateAssets('flows', flows => {
          let changed = false;
          for (const flow of flows) {
            let flowChanged = false;
            for (const selector of flowPackageSelectors(flow.draft)) {
              if (!renameMap.has(selector.packageName)) continue;
              selector.packageName = renameMap.get(selector.packageName);
              flowChanged = true;
            }
            if (flowChanged) { advanceAssetRevision(flow, 'saved', true); changed = true; }
          }
          return { changed };
        }, projectId);
        return { itemName: normalized.name, changed: true };
      });
      if (result.error) return reply(res, result.status, { error: result.error });
      const refreshedPackages = await readPackageRecords(projectId);
      const updatedData = await projectData(projectId);
      return reply(res, 200, visibleProjectPackages(req.principal, updatedData.rules, updatedData.tables, refreshedPackages, updatedData.bom, updatedData.changeSets).find(pkg => pkg.id === result.itemName));
    }
    if (segments.length === 5 && segments[3] === 'packages' && req.method === 'DELETE') {
      const name = decodeURIComponent(segments[4]);
      const payload = await bodyOf(req);
      const referencedBy = data.flows.filter(flow => flowReferencesPackage(flow.draft, name));
      if (referencedBy.length) return reply(res, 409, { error: `规则包被 ${referencedBy.length} 个规则流引用，请先移除或替换 Rule Group 节点` });
      const affected = [...data.rules, ...data.tables].filter(asset => asset.draft.category === name || asset.draft.category.startsWith(`${name}.`));
      const locked = affected.map(asset => reviewLock(data.changeSets, asset.id)).find(Boolean);
      if (locked) return reply(res, locked.status, { error: locked.error, changeSetId: locked.changeSetId });
      const result = await mutatePackageRecords(projectId, data, async records => {
        if (!records.some(pkg => pkg.name === name)) return { status: 404, error: '规则包不存在' };
        const names = new Set(records.filter(pkg => pkg.name === name || pkg.name.startsWith(`${name}.`)).map(pkg => pkg.name));
        const currentData = await projectData(projectId);
        const assets = [...currentData.rules, ...currentData.tables].filter(asset => names.has(asset.draft.category));
        const moveRulesTo = canonicalPackageName(payload?.moveRulesTo);
        if (assets.length && !moveRulesTo && payload?.deleteAssets !== true) return { status: 409, error: `包 ${name} 下有 ${assets.length} 条规则`, assetCount: assets.length };
        if (moveRulesTo && (!records.some(pkg => pkg.name === moveRulesTo) || names.has(moveRulesTo))) return { status: 400, error: '目标包无效' };
        const updateAssets = collection => { for (const asset of collection) if (names.has(asset.draft.category)) { if (payload.deleteAssets) asset.archived = true; else asset.draft.category = moveRulesTo; advanceAssetRevision(asset, 'saved', true); } return { changed: true }; };
        await mutate(updateAssets, projectId);
        await mutateAssets('tables', updateAssets, projectId);
        const retained = records.filter(pkg => !names.has(pkg.name));
        records.splice(0, records.length, ...retained);
        return { changed: true };
      });
      return result.error ? reply(res, result.status, { error: result.error, ...(result.assetCount != null ? { assetCount: result.assetCount } : {}) }) : reply(res, 204, '');
    }
    return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
  };
}
