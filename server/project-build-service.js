import { generateDrl, validateRule } from '../shared/rules.js';
import { flowBranches, flowGateways, flowSnapshot, flowSteps, tableDrl, validateTable } from '../shared/assets.js';
import { decisionTreeDrl, isDecisionTree, validateDecisionTree } from '../shared/decision-trees.js';
import { isScorecard, scorecardDrl, validateScorecard } from '../shared/scorecards.js';
import { compileEventStreamDraft } from '../shared/event-streams.js';
import { canonicalRuleSetVariables, normalizeRuleSetVariables, validateRuleSetVariables } from '../shared/ruleset-variables.js';
import { advanceAssetRevision, isActiveAsset, normalizePackageReferences } from './domain-utils.js';
import { revisionConflict } from './http-utils.js';
import { eventStreamAuthoring } from './project-presenters.js';
import { domainErrorResult } from '../shared/errors.js';
import { rulesetNameConflict } from '../shared/ruleset-names.js';
import { claimAssetDraft, draftOwnershipError } from './asset-ownership.js';

export function createProjectBuildService({
  engine,
  mutate,
  mutateAssets,
  getCurrentBom,
}) {
  function validateStructuredAsset(draft, bom, variables) {
    if (isDecisionTree(draft)) return validateDecisionTree(draft, bom, variables);
    if (isScorecard(draft)) return validateScorecard(draft, bom, variables);
    return validateTable(draft, bom, variables).error;
  }

  function structuredAssetDrl(draft, bom, executionKey, variables) {
    if (isDecisionTree(draft)) return decisionTreeDrl(draft, bom, executionKey, variables);
    if (isScorecard(draft)) return scorecardDrl(draft, bom, executionKey, variables);
    return tableDrl(draft, bom, executionKey, variables);
  }

  function ruleSetVariablesFor(rule, projectOrEngine = null) {
    const projectVariables = Array.isArray(projectOrEngine?.variables) ? projectOrEngine.variables : [];
    const ruleVariables = normalizeRuleSetVariables(rule?.variables);
    const projectError = validateRuleSetVariables(projectVariables);
    if (projectError) throw new Error(`Rule Project 变量无效：${projectError}`);
    if (projectVariables.length) return canonicalRuleSetVariables(projectVariables);
    const merged = new Map(canonicalRuleSetVariables(projectVariables).map(variable => [variable.name, variable]));
    const ruleError = validateRuleSetVariables(ruleVariables);
    if (ruleError) throw new Error(ruleError);
    for (const variable of canonicalRuleSetVariables(ruleVariables)) {
      const previous = merged.get(variable.name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(variable)) throw new Error(`规则集变量 "${variable.name}" 定义冲突`);
      merged.set(variable.name, variable);
    }
    return [...merged.values()];
  }

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

  async function publishProjectEventStream(id, expected, projectId, data, createdBy = 'Team Server', principal = null) {
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    return mutateAssets('eventStreams', async assets => {
      const item = assets.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '事件流不存在' };
      if (principal) {
        const ownership = draftOwnershipError(principal, item);
        if (ownership) return ownership;
      }
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
    try { snapshot = flowSnapshot(payload?.draft || item.draft, data.rules, data.tables, data.bom || getCurrentBom(), data.packageRecords || [], data.project?.variables, { flows: data.flows, currentFlowId: item.id }); }
    catch (error) { return domainErrorResult(error); }
    const steps = flowSteps(snapshot);
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
        branchCount: flowBranches(snapshot).length,
        gatewayCount: flowGateways(snapshot).length,
        parallelCount: snapshot.graph?.nodes.filter(node => node.type === 'parallel').length || 0,
        joinCount: snapshot.graph?.nodes.filter(node => node.type === 'join').length || 0,
        bomVersion: snapshot.bomVersion,
      },
    };
  }

  async function publishProjectFlow(id, expected, data, projectId = 'default', principal = null) {
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    return mutateAssets('flows', async flows => {
      const item = flows.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '规则集不存在' };
      if (principal) {
        const ownership = draftOwnershipError(principal, item);
        if (ownership) return ownership;
      }
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      const nameConflict = rulesetNameConflict(flows, item, item.draft.name, { publishedOnly: true });
      if (nameConflict) return nameConflict;
      let snapshot;
      try { snapshot = flowSnapshot(item.draft, data.rules, data.tables, data.bom || getCurrentBom(), data.packageRecords || [], data.project?.variables, { flows, currentFlowId: item.id }); }
      catch (error) { return domainErrorResult(error); }
      const steps = flowSteps(snapshot);
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

  async function saveProjectAsset(id, type, payload, projectId = 'default', bom = getCurrentBom(), projectOrEngine = 'rules', principal = null) {
    const expected = payload?.revision;
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    const draft = normalizePackageReferences(structuredClone(payload?.draft));
    let variables = [];
    try { variables = type === 'rule' ? ruleSetVariablesFor(draft, projectOrEngine) : []; }
    catch (error) { return { status: 400, error: error.message }; }
    const tableVariables = Array.isArray(projectOrEngine?.variables) ? canonicalRuleSetVariables(projectOrEngine.variables) : [];
    const validation = type === 'rule' ? validateRule(draft, bom, variables) : validateStructuredAsset(draft, bom, tableVariables);
    if (validation) return { status: 400, error: validation };
    const operation = assets => {
      const item = assets.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '资产不存在' };
      const ownership = draftOwnershipError(principal, item);
      if (ownership) return ownership;
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      claimAssetDraft(item, principal);
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
    let variables = [];
    try { variables = type === 'rule' ? ruleSetVariablesFor(draft, projectOrEngine) : []; }
    catch (error) { return { status: 400, error: error.message }; }
    const tableVariables = Array.isArray(projectOrEngine?.variables) ? canonicalRuleSetVariables(projectOrEngine.variables) : [];
    const validation = type === 'rule' ? validateRule(draft, bom, variables) : validateStructuredAsset(draft, bom, tableVariables);
    if (validation) return { status: 400, error: validation };
    const drl = type === 'rule' ? generateDrl([draft], bom, variables) : structuredAssetDrl(draft, bom, item.id, tableVariables);
    const checked = await engine('/compile', { drl }, projectOrEngine);
    if (checked.error) return { status: checked.status, error: checked.error };
    return { status: 200, result: { ok: true, engineVersion: checked.result.version, drl } };
  }

  async function publishProjectAsset(id, type, expected, projectId = 'default', bom = getCurrentBom(), projectOrEngine = 'rules', principal = null) {
    if (!Number.isInteger(expected) || expected < 1) return { status: 400, error: '修订号无效' };
    const operation = async assets => {
      const item = assets.find(asset => asset.id === id && isActiveAsset(asset));
      if (!item) return { status: 404, error: '资产不存在' };
      if (principal) {
        const ownership = draftOwnershipError(principal, item);
        if (ownership) return ownership;
      }
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      let variables = [];
      try { variables = type === 'rule' ? ruleSetVariablesFor(item.draft, projectOrEngine) : []; }
      catch (error) { return { status: 400, error: error.message }; }
      const tableVariables = Array.isArray(projectOrEngine?.variables) ? canonicalRuleSetVariables(projectOrEngine.variables) : [];
      const validation = type === 'rule' ? validateRule(item.draft, bom, variables) : validateStructuredAsset(item.draft, bom, tableVariables);
      if (validation) return { status: 400, error: validation };
      const publishedDraft = type === 'rule' ? { ...structuredClone(item.draft), variables } : structuredClone(item.draft);
      const drl = type === 'rule' ? generateDrl([publishedDraft], bom, variables) : structuredAssetDrl(item.draft, bom, item.id, tableVariables);
      const checked = await engine('/compile', { drl }, projectOrEngine);
      if (checked.error) return { status: checked.status, error: checked.error };
      const version = {
        number: (item.versions.at(-1)?.number || 0) + 1,
        assetRevision: (item.revision || 1) + 1,
        createdAt: new Date().toISOString(),
        ...(type === 'rule' ? { rule: publishedDraft } : { draft: structuredClone(item.draft) }),
        bomVersion: bom.version,
        bom: structuredClone(bom),
        drl,
        engineVersion: checked.result.version,
      };
      item.versions.push(version);
      item.published = type === 'rule' ? publishedDraft : structuredClone(item.draft);
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
