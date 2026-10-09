import crypto from 'node:crypto';
import { analyzeDwxAssetPackage, buildDwxAssetPackage, dwxAssetStorage } from '../../shared/dwx-asset-package.js';
import { bodyOf, reply } from '../http-utils.js';
import { claimAssetDraft } from '../asset-ownership.js';

function migrationMetadata(preview, sourceId, kind) {
  return {
    provider: 'dwx',
    sourceId,
    sourceKind: kind,
    project: preview.manifest.project.name,
    projectVersion: preview.manifest.project.version,
    manifestChecksum: preview.checksum,
    importedAt: new Date().toISOString(),
  };
}

export function createProjectImportHandler({
  mutateRuleProjectImport,
  initializeAssetRevision,
  appendAuditEvent,
  canAccessAsset,
}) {
  return async function handleProjectImports(req, res, segments, projectId, data, packageRecords) {
    if (segments.length === 5 && segments[3] === 'exports' && segments[4] === 'dwx' && req.method === 'GET') {
      const assetPackage = buildDwxAssetPackage({
        project: data.project,
        packages: packageRecords,
        rules: data.rules.filter(item => canAccessAsset(req.principal, item.id)),
        tables: data.tables.filter(item => canAccessAsset(req.principal, item.id)),
        flows: data.flows.filter(item => canAccessAsset(req.principal, item.id)),
      });
      res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${data.project.name}-DWX资产包.json`)}`);
      return reply(res, 200, assetPackage);
    }
    if (segments.length !== 5 || segments[3] !== 'imports' || segments[4] !== 'dwx' || req.method !== 'POST') {
      return reply(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? '未找到资源' : 'Method not allowed' });
    }
    const payload = await bodyOf(req);
    const mode = payload?.mode === 'import' ? 'import' : payload?.mode === 'preview' ? 'preview' : null;
    if (!mode) return reply(res, 400, { error: 'mode 必须是 preview 或 import' });
    const context = {
      bom: data.bom,
      variables: data.project?.variables || [],
      packages: packageRecords,
      rules: data.allRules,
      tables: data.allTables,
      flows: data.allFlows,
    };
    const preview = analyzeDwxAssetPackage(payload.manifest, context);
    if (mode === 'preview') return reply(res, 200, preview);
    if (!preview.valid) return reply(res, 400, preview);
    if (typeof payload.checksum !== 'string' || payload.checksum !== preview.checksum) {
      return reply(res, 409, { error: '迁移清单在预览后发生变化，请重新预览', code: 'IMPORT_PREVIEW_STALE', preview });
    }
    const result = await mutateRuleProjectImport(collections => {
      const current = analyzeDwxAssetPackage(payload.manifest, {
        bom: data.bom,
        variables: data.project?.variables || [],
        packages: collections.packages,
        rules: collections.rules,
        tables: collections.tables,
        flows: collections.flows,
      });
      if (!current.valid) return { status: 409, error: '项目资产在预览后发生变化，请重新预览', preview: current };
      if (current.checksum !== payload.checksum) return { status: 409, error: '迁移清单在预览后发生变化，请重新预览', preview: current };
      const now = new Date().toISOString();
      const existingPackages = new Set(collections.packages.map(pkg => pkg.name));
      for (const pkg of current.packages.filter(pkg => pkg.action === 'create')) {
        if (existingPackages.has(pkg.name)) continue;
        collections.packages.push({ name: pkg.name, label: pkg.label, parentId: pkg.parentId, createdAt: now });
        existingPackages.add(pkg.name);
      }
      const created = [];
      for (const asset of current.assets.filter(asset => asset.action === 'create')) {
        const item = initializeAssetRevision({
          id: crypto.randomUUID(),
          draft: structuredClone(asset.draft),
          published: null,
          versions: [],
          archived: false,
          updatedAt: now,
          migration: migrationMetadata(current, asset.sourceId, asset.type),
        }, 'dwx-imported');
        claimAssetDraft(item, req.principal);
        collections[dwxAssetStorage(asset.type) === 'rule' ? 'rules' : 'tables'].unshift(item);
        created.push({ id: item.id, sourceId: asset.sourceId, type: asset.type, name: asset.name });
      }
      for (const ruleset of current.rulesets.filter(item => item.action === 'create')) {
        const draft = {
          name: ruleset.name,
          description: ruleset.description,
          variables: [],
          steps: ruleset.packages.map((packageName, index) => ({
            nodeId: `dwx-group-${index + 1}`,
            type: 'rule-group',
            selector: { packageName, includeChildren: true },
          })),
          gateways: [],
          editor: { positions: {} },
        };
        const item = initializeAssetRevision({
          id: crypto.randomUUID(),
          draft,
          published: null,
          versions: [],
          archived: false,
          updatedAt: now,
          migration: migrationMetadata(current, ruleset.sourceId, 'ruleset'),
        }, 'dwx-imported');
        claimAssetDraft(item, req.principal);
        collections.flows.unshift(item);
        created.push({ id: item.id, sourceId: ruleset.sourceId, type: 'ruleset', name: ruleset.name });
      }
      return {
        changed: current.packages.some(pkg => pkg.action === 'create') || created.length > 0,
        preview: current,
        created,
      };
    }, projectId);
    if (result.error) return reply(res, result.status || 409, { error: result.error, code: 'IMPORT_PREVIEW_STALE', preview: result.preview });
    await appendAuditEvent('project.dwx-imported', 'project', projectId, `导入 DWX 资产包：${result.preview.manifest.project.name}`, {
      checksum: result.preview.checksum,
      projectVersion: result.preview.manifest.project.version,
      createdCount: result.created.length,
      skippedCount: result.preview.summary.assets.skip + result.preview.summary.rulesets.skip,
      packageCount: result.preview.summary.packages.create,
    }, req);
    return reply(res, 201, {
      ok: true,
      checksum: result.preview.checksum,
      summary: result.preview.summary,
      created: result.created,
      warnings: result.preview.warnings,
    });
  };
}
