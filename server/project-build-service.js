import { generateDrl, validateRule } from '../shared/rules.js';
import { flowSnapshot, tableDrl, validateTable } from '../shared/assets.js';
import { compileEventStreamDraft } from '../shared/event-streams.js';
import { advanceAssetRevision, isActiveAsset, normalizePackageReferences } from './domain-utils.js';
import { revisionConflict } from './http-utils.js';
import { eventStreamAuthoring } from './project-presenters.js';
import { domainErrorResult } from '../shared/errors.js';

export function createProjectBuildService({
  engine,
  mutate,
  mutateAssets,
  getCurrentBom,
}) {
  async function compileProjectEventStream(item, payload, data) {
    const expected = payload?.revision;
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    const compiled = compileEventStreamDraft(payload?.draft || item.draft, data.bom || getCurrentBom());
    if (compiled.error) return compiled;
    const checked = await engine('/compile', { module: compiled.result.module }, data.project || 'cep');
    if (checked.error) return checked;
    return { status: 200, result: { ...compiled.result, engine: checked.result.engine || 'Esper', version: checked.result.version || compiled.result.version, epl: checked.result.epl } };
  }

  async function publishProjectEventStream(id, expected, projectId, data, createdBy = 'Team Server') {
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    return mutateAssets('eventStreams', async assets => {
      const item = assets.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '事件流不存在' };
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      const compiled = compileEventStreamDraft(item.draft, data.bom || getCurrentBom());
      if (compiled.error) return compiled;
      const checked = await engine('/compile', { module: compiled.result.module }, data.project || 'cep');
      if (checked.error) return checked;
      const version = {
        number: (item.versions.at(-1)?.number || 0) + 1,
        assetRevision: (item.revision || 1) + 1,
        createdAt: new Date().toISOString(),
        draft: structuredClone(item.draft),
        statements: structuredClone(compiled.result.module.statements),
        authoring: eventStreamAuthoring(item.draft.statements || []),
        schemas: structuredClone(compiled.result.schemas),
        bomVersion: (data.bom || getCurrentBom()).version,
        bom: structuredClone(data.bom || getCurrentBom()),
        checksum: compiled.result.checksum,
        createdBy,
        engineVersion: checked.result.version || compiled.result.version,
        module: structuredClone(compiled.result.module),
      };
      item.versions.push(version);
      item.published = structuredClone(version);
      advanceAssetRevision(item, 'saved');
      return { item };
    }, projectId);
  }

  async function compileProjectFlow(item, payload, data) {
    const expected = payload?.revision;
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    let snapshot;
    try { snapshot = flowSnapshot(payload?.draft || item.draft, data.rules, data.tables, data.bom || getCurrentBom(), data.packageRecords || []); }
    catch (error) { return domainErrorResult(error); }
    const steps = [...snapshot.steps, ...snapshot.branches.flatMap(branch => branch.steps)];
    let engineVersion = null;
    for (const step of steps) {
      const checked = await engine('/compile', { drl: step.drl }, data.project);
      if (checked.error) return { status: checked.status, error: `${step.name}：${checked.error}` };
      engineVersion = checked.result.version;
    }
    return {
      status: 200,
      result: {
        ok: true,
        engineVersion,
        stepCount: steps.length,
        branchCount: snapshot.branches.length,
        bomVersion: snapshot.bomVersion,
      },
    };
  }

  async function publishProjectFlow(id, expected, data, projectId = 'default') {
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    return mutateAssets('flows', async flows => {
      const item = flows.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '规则流不存在' };
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      let snapshot;
      try { snapshot = flowSnapshot(item.draft, data.rules, data.tables, data.bom || getCurrentBom(), data.packageRecords || []); }
      catch (error) { return domainErrorResult(error); }
      const steps = [...snapshot.steps, ...snapshot.branches.flatMap(branch => branch.steps)];
      let engineVersion = null;
      for (const step of steps) {
        const checked = await engine('/compile', { drl: step.drl }, data.project);
        if (checked.error) return { status: checked.status, error: `${step.name}：${checked.error}` };
        engineVersion = checked.result.version;
      }
      item.versions.push({
        number: (item.versions.at(-1)?.number || 0) + 1,
        assetRevision: (item.revision || 1) + 1,
        createdAt: new Date().toISOString(),
        draft: structuredClone(item.draft),
        bomVersion: (data.bom || getCurrentBom()).version,
        bom: structuredClone(data.bom || getCurrentBom()),
        engineVersion,
        snapshot,
      });
      item.published = snapshot;
      advanceAssetRevision(item, 'saved');
      return { item };
    }, projectId);
  }

  async function saveProjectAsset(id, type, payload, projectId = 'default', bom = getCurrentBom()) {
    const expected = payload?.revision;
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    const draft = normalizePackageReferences(structuredClone(payload?.draft));
    const validation = type === 'rule' ? validateRule(draft, bom) : validateTable(draft, bom).error;
    if (validation) return { status: 400, error: validation };
    const operation = assets => {
      const item = assets.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '资产不存在' };
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      item.draft = structuredClone(draft);
      advanceAssetRevision(item, 'saved', true);
      return { item };
    };
    return type === 'rule' ? mutate(operation, projectId) : mutateAssets('tables', operation, projectId);
  }

  async function compileProjectAsset(item, type, payload, bom = getCurrentBom(), projectOrEngine = 'rules') {
    const expected = payload?.revision;
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    const conflict = revisionConflict(item, expected);
    if (conflict) return conflict;
    const draft = normalizePackageReferences(structuredClone(payload?.draft || item.draft));
    const validation = type === 'rule' ? validateRule(draft, bom) : validateTable(draft, bom).error;
    if (validation) return { status: 400, error: validation };
    const drl = type === 'rule' ? generateDrl([draft], bom) : tableDrl(draft, bom, item.id);
    const checked = await engine('/compile', { drl }, projectOrEngine);
    if (checked.error) return { status: checked.status, error: checked.error };
    return { status: 200, result: { ok: true, engineVersion: checked.result.version, drl } };
  }

  async function publishProjectAsset(id, type, expected, projectId = 'default', bom = getCurrentBom(), projectOrEngine = 'rules') {
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    const operation = async assets => {
      const item = assets.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '资产不存在' };
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      const validation = type === 'rule' ? validateRule(item.draft, bom) : validateTable(item.draft, bom).error;
      if (validation) return { status: 400, error: validation };
      const drl = type === 'rule' ? generateDrl([item.draft], bom) : tableDrl(item.draft, bom, item.id);
      const checked = await engine('/compile', { drl }, projectOrEngine);
      if (checked.error) return { status: checked.status, error: checked.error };
      const version = {
        number: (item.versions.at(-1)?.number || 0) + 1,
        assetRevision: (item.revision || 1) + 1,
        createdAt: new Date().toISOString(),
        ...(type === 'rule' ? { rule: structuredClone(item.draft) } : { draft: structuredClone(item.draft) }),
        bomVersion: bom.version,
        bom: structuredClone(bom),
        drl,
        engineVersion: checked.result.version,
      };
      item.versions.push(version);
      item.published = structuredClone(item.draft);
      advanceAssetRevision(item, 'saved');
      return { item };
    };
    return type === 'rule' ? mutate(operation, projectId) : mutateAssets('tables', operation, projectId);
  }

  return {
    compileProjectEventStream,
    publishProjectEventStream,
    compileProjectFlow,
    publishProjectFlow,
    saveProjectAsset,
    compileProjectAsset,
    publishProjectAsset,
  };
}
