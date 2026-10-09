import { createHash } from 'node:crypto';
import { generateDrl } from './rules.js';
import { flowBranches, flowGateways, flowSteps, isFlowGraph, resolveRuleGroupMembers, ruleGroupFingerprint, tableDrl, tableRules } from './assets.js';
import { defaultBom, findField, validateBom } from './bom.js';
import { CEP_ENGINE_VERSION } from './event-streams.js';
import { canonicalRuleSetVariables, normalizeRuleSetVariables, validateRuleSetVariables } from './ruleset-variables.js';
import { DomainError } from './errors.js';
import { decisionTreeDrl, decisionTreeRules, isDecisionTree } from './decision-trees.js';
import { isScorecard, scorecardDrl, scorecardRules } from './scorecards.js';
import { isRuleTemplate, ruleTemplateDrl, ruleTemplateRules } from './rule-templates.js';

export const RELEASE_SCHEMA_VERSION = 1;
export const DROOLS_VERSION = '10.2.0';
export const CEP_RELEASE_SCHEMA_VERSION = 2;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function releaseContent(release) {
  const content = {
    schemaVersion: release.schemaVersion,
    decisionService: release.decisionService,
    version: release.version,
    displayVersion: release.displayVersion,
    name: release.name,
    description: release.description,
    target: release.target,
    engine: release.engine,
    steps: release.steps,
  };
  if (release.schemas != null) content.schemas = release.schemas;
  if (release.statements != null) content.statements = release.statements;
  if (release.module != null) content.module = release.module;
  if (release.model != null) content.model = release.model;
  if (release.routing != null) content.routing = release.routing;
  if (release.variables != null) content.variables = release.variables;
  return content;
}

export function releaseChecksum(release) {
  const content = JSON.stringify(canonicalize(releaseContent(release)));
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export function validateReleaseRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return '发布请求无效';
  if (typeof request.decisionService !== 'string' || !/^[a-z0-9][a-z0-9._/-]{2,79}$/.test(request.decisionService)) {
    return '决策服务标识需为 3-80 位小写字母、数字、点、横线、下划线或斜线';
  }
  if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 80) return '发布名称需为 1-80 个字符';
  if (request.version != null && (typeof request.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(request.version))) return 'Release 版本号必须使用 SemVer 格式，例如 2.1.0';
  if (typeof (request.description ?? '') !== 'string' || (request.description ?? '').length > 500) return '发布说明不能超过 500 个字符';
  if (!request.target || !['rule', 'table', 'flow', 'event-stream'].includes(request.target.type) || typeof request.target.id !== 'string' || !request.target.id) {
    return '发布来源必须是有效的规则、决策表、规则集或事件流';
  }
  return null;
}

function publishedAsset(collection, id, label) {
  const asset = collection.find(item => item.id === id && !item.archived && item.lifecycleStatus !== 'deprecated');
  if (!asset) throw new Error(`${label}不存在`);
  if (!asset.published || !asset.versions?.length) throw new Error(`${label}尚未发布`);
  return asset;
}

function releaseStep(step, options = {}) {
  const result = {
    name: step.name,
    type: step.type,
    assetId: step.id,
    assetVersion: step.version,
    drl: step.drl,
  };
  if (options.includeVariables !== false && step.variables?.length) result.variables = structuredClone(step.variables);
  if (step.inputMappings?.length) result.inputMappings = structuredClone(step.inputMappings);
  if (step.outputMappings?.length) result.outputMappings = structuredClone(step.outputMappings);
  if (step.subflowPath?.length) result.subflowPath = structuredClone(step.subflowPath);
  return result;
}

function mergeRuleSetVariables(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const variable of normalizeRuleSetVariables(collection)) {
      const previous = merged.get(variable.name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(variable)) {
        throw new Error(`规则集变量 "${variable.name}" 定义冲突`);
      }
      merged.set(variable.name, variable);
    }
  }
  const definitions = [...merged.values()];
  const error = validateRuleSetVariables(definitions);
  if (error) throw new Error(error);
  return canonicalRuleSetVariables(definitions);
}

function assetVersion(asset, number) {
  return asset?.versions?.find(version => version.number === number) || asset?.versions?.at(-1);
}

function flowDependencyIssues(flow, rules, tables, flows, packages) {
  const assets = new Map([
    ...rules.map(asset => [`rule:${asset.id}`, asset]),
    ...tables.map(asset => [`table:${asset.id}`, asset]),
  ]);
  const steps = flowSteps(flow);
  const stepIssues = steps.flatMap(step => {
    if (step.type === 'rule-group') {
      const selector = step.selector || { packageName: step.packageName, includeChildren: step.includeChildren === true };
      try {
        const members = resolveRuleGroupMembers(selector, rules, tables, packages);
        return step.memberFingerprint && ruleGroupFingerprint(members) !== step.memberFingerprint
          ? [{ type: 'rule-group', name: step.name || `规则组：${selector.packageName}`, packageName: selector.packageName }]
          : [];
      } catch {
        return [{ type: 'rule-group', name: step.name || `规则组：${selector.packageName}`, packageName: selector.packageName }];
      }
    }
    const asset = assets.get(`${step.type}:${step.id}`);
    const latestVersion = asset?.versions?.at(-1)?.number;
    return latestVersion && step.version && latestVersion !== step.version
      ? [{ type: step.type, id: step.id, name: step.name || asset.published?.name || asset.draft?.name || step.id, frozenVersion: step.version, latestVersion }]
      : [];
  });
  return [...stepIssues, ...(flow.subflows || []).flatMap(subflow => {
    const current = flows.find(item => item.id === subflow.id && !item.archived && item.lifecycleStatus !== 'deprecated');
    const latestVersion = current?.versions?.at(-1)?.number;
    return !current || !latestVersion || latestVersion !== subflow.version
      ? [{ type: 'subflow', id: subflow.id, name: subflow.name || current?.published?.name || current?.draft?.name || subflow.id, frozenVersion: subflow.version, latestVersion: latestVersion || 0 }]
      : [];
  })];
}

function assertCurrentFlowDependencies(flow, rules, tables, flows, packages) {
  const issues = flowDependencyIssues(flow, rules, tables, flows, packages);
  if (!issues.length) return;
  const summary = issues.slice(0, 3).map(issue => issue.type === 'rule-group'
    ? `${issue.name}成员已变化`
    : `${issue.name} v${issue.frozenVersion} → v${issue.latestVersion}`).join('；');
  throw new DomainError('FLOW_DEPENDENCIES_OUTDATED', `规则集依赖已有新发布版本（${summary}），请先重新发布规则集，再构建 Release`, {
    dependencies: issues,
    suggestedAction: 'republish-flow',
  }, { status: 409 });
}

function regenerateFlowStep(step, rules, tables, model, variables) {
  if (!variables.length) return step;
  const asset = step.type === 'rule'
    ? rules.find(candidate => candidate.id === step.id)
    : step.type === 'table'
      ? tables.find(candidate => candidate.id === step.id)
      : null;
  if (asset) {
    const version = assetVersion(asset, step.version);
    const source = version?.rule || version?.draft || asset.published;
    if (source) {
      const drl = step.type === 'rule'
        ? generateDrl([source], version?.bom || model, variables)
        : isRuleTemplate(source)
          ? ruleTemplateDrl(source, version?.bom || model)
        : isScorecard(source)
          ? scorecardDrl(source, version?.bom || model, asset.id, variables)
          : isDecisionTree(source)
          ? decisionTreeDrl(source, version?.bom || model, asset.id, variables)
          : tableDrl(source, version?.bom || model, asset.id, variables);
      return { ...step, drl };
    }
  }
  if (step.type !== 'rule-group' || !Array.isArray(step.members)) return step;
  const executableRules = step.members.flatMap(member => {
    const memberAsset = member.type === 'rule'
      ? rules.find(candidate => candidate.id === member.id)
      : tables.find(candidate => candidate.id === member.id);
    const version = assetVersion(memberAsset, member.version);
    const source = version?.rule || version?.draft || memberAsset?.published;
    if (!source) return [];
    if (member.type === 'rule') return [{ ...source, name: `${source.name} [${member.id}]` }];
    const generated = isRuleTemplate(source)
      ? ruleTemplateRules(source, version?.bom || model)
      : isScorecard(source)
      ? scorecardRules(source, version?.bom || model, member.id, variables)
      : isDecisionTree(source)
      ? decisionTreeRules(source, version?.bom || model, member.id, variables)
      : tableRules(source, version?.bom || model, member.id, variables);
    return generated
      .map(rule => ({ ...rule, name: `${rule.name} [${member.id}]` }));
  });
  return executableRules.length ? { ...step, drl: generateDrl(executableRules, model, variables) } : step;
}

function verifyStepMappings(step, model) {
  for (const config of [
    { key: 'inputMappings', sourceKind: null, targetKind: 'input' },
    { key: 'outputMappings', sourceKind: 'output', targetKind: null },
  ]) {
    const mappings = step[config.key];
    if (mappings == null) continue;
    if (!model || !Array.isArray(mappings) || mappings.length < 1 || mappings.length > 20) return false;
    const targets = new Set();
    for (const mapping of mappings) {
      const source = findField(model, mapping?.source);
      const target = findField(model, mapping?.target);
      if (!source || !target || source.type !== target.type || source.key === target.key || targets.has(target.key)) return false;
      if ((config.sourceKind && source.kind !== config.sourceKind) || (config.targetKind && target.kind !== config.targetKind)) return false;
      targets.add(target.key);
    }
  }
  return true;
}

export function buildRelease({ id, request, rules, tables, flows, eventStreams = [], releases, bom = defaultBom(), projectVariables = [], packageRecords = [], enforceCurrentFlowDependencies = false, createdAt = new Date().toISOString(), createdBy = 'Team Server' }) {
  const error = validateReleaseRequest(request);
  if (error) throw new Error(error);

  const nextVersion = releases
    .filter(item => item.decisionService === request.decisionService)
    .reduce((maximum, item) => Math.max(maximum, item.version || 0), 0) + 1;
  const displayVersion = request.version || `${nextVersion}.0.0`;
  if (releases.some(item => item.decisionService === request.decisionService && (item.displayVersion || `${item.version}.0.0`) === displayVersion)) {
    throw new Error(`决策服务 ${request.decisionService} 已存在 Release v${displayVersion}`);
  }
  let targetAsset;
  let steps;
  let model;
  let routing;
  let variables = [];

  if (request.target.type === 'rule') {
    targetAsset = publishedAsset(rules, request.target.id, '规则');
    const version = targetAsset.versions.at(-1);
    model = structuredClone(version.bom || bom);
    variables = mergeRuleSetVariables(projectVariables.length ? projectVariables : targetAsset.published.variables);
    steps = [{
      name: targetAsset.published.name,
      type: 'rule',
      assetId: targetAsset.id,
      assetVersion: version.number,
      drl: projectVariables.length
        ? generateDrl([targetAsset.published], model, variables)
        : version.drl || generateDrl([targetAsset.published], model, variables),
    }];
  } else if (request.target.type === 'table') {
    targetAsset = publishedAsset(tables, request.target.id, '决策表');
    const version = targetAsset.versions.at(-1);
    model = structuredClone(version.bom || bom);
    steps = [{
      name: targetAsset.published.name,
      type: 'table',
      assetId: targetAsset.id,
      assetVersion: version.number,
      drl: projectVariables.length
        ? (isRuleTemplate(targetAsset.published)
            ? ruleTemplateDrl(targetAsset.published, model)
            : isScorecard(targetAsset.published)
            ? scorecardDrl(targetAsset.published, model, targetAsset.id, projectVariables)
            : isDecisionTree(targetAsset.published)
            ? decisionTreeDrl(targetAsset.published, model, targetAsset.id, projectVariables)
            : tableDrl(targetAsset.published, model, targetAsset.id, projectVariables))
        : version.drl || (isRuleTemplate(targetAsset.published)
            ? ruleTemplateDrl(targetAsset.published, model)
            : isScorecard(targetAsset.published)
            ? scorecardDrl(targetAsset.published, model, targetAsset.id, projectVariables)
            : isDecisionTree(targetAsset.published)
            ? decisionTreeDrl(targetAsset.published, model, targetAsset.id, projectVariables)
            : tableDrl(targetAsset.published, model, targetAsset.id, projectVariables)),
    }];
    variables = mergeRuleSetVariables(projectVariables);
  } else if (request.target.type === 'flow') {
    targetAsset = publishedAsset(flows, request.target.id, '规则集');
    if (enforceCurrentFlowDependencies) assertCurrentFlowDependencies(targetAsset.published, rules, tables, flows, packageRecords);
    model = structuredClone(targetAsset.published.bom || targetAsset.versions.at(-1).bom || bom);
    const flowVariables = targetAsset.published.variables || targetAsset.published.snapshot?.variables;
    if (projectVariables.length) variables = mergeRuleSetVariables(projectVariables);
    else if (flowVariables?.length) variables = mergeRuleSetVariables(flowVariables);
    else {
      variables = mergeRuleSetVariables(
        ...flowSteps(targetAsset.published).map(step => step.variables || []),
        ...flowBranches(targetAsset.published).flatMap(branch => branch.steps || []).map(step => step.variables || []),
      );
    }
    const releaseStepOptions = { includeVariables: !variables.length };
    const freezeFlowStep = step => releaseStep(regenerateFlowStep(step, rules, tables, model, variables), releaseStepOptions);
    if (isFlowGraph(targetAsset.published)) {
      const graphNodes = targetAsset.published.graph.nodes;
      const stepIndexes = new Map();
      steps = [];
      for (const node of graphNodes) {
        if (node.type !== 'step') continue;
        stepIndexes.set(node.id, steps.length);
        steps.push(freezeFlowStep(node.step));
      }
      routing = {
        type: graphNodes.some(node => node.type === 'parallel' || node.type === 'join') ? 'decision-dag' : 'exclusive-dag',
        entry: targetAsset.published.graph.entry,
        nodes: graphNodes.map(node => node.type === 'step'
          ? { id: node.id, type: 'step', stepIndex: stepIndexes.get(node.id), next: node.next }
          : node.type === 'join'
            ? { id: node.id, type: 'join', name: node.name, next: node.next }
          : node.type === 'parallel'
            ? { id: node.id, type: 'parallel', name: node.name, join: node.join, branches: structuredClone(node.branches) }
          : {
              id: node.id,
              type: 'gateway',
              name: node.name,
              branches: structuredClone(node.branches),
            }),
      };
    } else steps = targetAsset.published.steps.map(freezeFlowStep);
    const publishedGateways = flowGateways(targetAsset.published);
    if (!routing && publishedGateways.length) {
      const freezeBranches = gateway => gateway.branches.map(branch => {
          const stepIndexes = [];
          for (const step of branch.steps) {
            stepIndexes.push(steps.length);
            steps.push(freezeFlowStep(step));
          }
          return {
            id: branch.id,
            name: branch.name,
            default: branch.default === true,
            condition: branch.default ? null : branch.condition,
            stepIndexes,
          };
        });
      routing = Array.isArray(targetAsset.published.gateways)
        ? {
            type: 'exclusive-chain',
            commonStepCount: targetAsset.published.steps.length,
            gateways: publishedGateways.map(gateway => ({
              id: gateway.id,
              name: gateway.name || '排他网关',
              afterStep: gateway.afterStep,
              branches: freezeBranches(gateway),
            })),
          }
        : { type: 'exclusive', afterStep: steps.length, branches: freezeBranches(publishedGateways[0]) };
    }
  } else {
    targetAsset = publishedAsset(eventStreams, request.target.id, '事件流');
    const version = targetAsset.versions.at(-1);
    const release = {
      schemaVersion: CEP_RELEASE_SCHEMA_VERSION,
      id,
      decisionService: request.decisionService,
      version: nextVersion,
      displayVersion,
      name: request.name.trim(),
      description: (request.description ?? '').trim(),
      target: { type: 'event-stream', id: targetAsset.id, assetVersion: version.number },
      engine: { type: 'esper', esper: CEP_ENGINE_VERSION },
      schemas: structuredClone(version.schemas || []),
      statements: structuredClone(version.statements || []),
      module: structuredClone(version.module || { schemas: version.schemas || [], statements: version.statements || [] }),
      model: structuredClone(version.bom || bom),
      createdAt,
      createdBy,
    };
    release.checksum = releaseChecksum(release);
    return release;
  }

  const release = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    id,
    decisionService: request.decisionService,
    version: nextVersion,
    displayVersion,
    name: request.name.trim(),
    description: (request.description ?? '').trim(),
    target: {
      type: request.target.type,
      id: targetAsset.id,
      assetVersion: targetAsset.versions.at(-1).number,
    },
    engine: { type: 'drools', drools: DROOLS_VERSION },
    model,
    steps,
    createdAt,
    createdBy,
  };
  if (routing) release.routing = routing;
  if (variables.length) release.variables = variables;
  release.checksum = releaseChecksum(release);
  return release;
}

export function verifyRelease(release) {
  if (!release || ![RELEASE_SCHEMA_VERSION, CEP_RELEASE_SCHEMA_VERSION].includes(release.schemaVersion)) return '不支持的发布包格式';
  if (typeof release.id !== 'string' || !release.id) return '发布包 ID 无效';
  if (release.schemaVersion === CEP_RELEASE_SCHEMA_VERSION) {
    if (release.engine?.type !== 'esper') return 'CEP 引擎版本不兼容';
    if (release.target?.type !== 'event-stream') return 'CEP 发布包目标无效';
    if (!Array.isArray(release.schemas) || !Array.isArray(release.statements) || !release.statements.length) return 'CEP 发布包内容无效';
    if (release.checksum !== releaseChecksum(release)) return '发布包校验和不匹配';
    return null;
  }
  if (!Array.isArray(release.steps) || release.steps.length < 1 || release.steps.length > 20) return '发布包步骤数量无效';
  if (release.engine?.type !== 'drools' || release.engine?.drools !== DROOLS_VERSION) return 'Drools 版本不兼容';
  if (release.model != null) {
    const modelError = validateBom(release.model);
    if (modelError || !Number.isInteger(release.model.version) || release.model.version < 1) return `发布包字段模型无效${modelError ? `：${modelError}` : ''}`;
  }
  if (release.variables != null) {
    const variableError = validateRuleSetVariables(release.variables);
    if (variableError) return `发布包规则集变量无效：${variableError}`;
    const modelKeys = new Set((release.model?.fields || []).map(field => field.key));
    if (release.variables.some(variable => modelKeys.has(variable.name))) return '规则集变量名称不能与 BOM 字段重复';
  }
  if (release.routing != null) {
    const routing = release.routing;
    if (routing.type === 'exclusive-dag' || routing.type === 'decision-dag') {
      if (typeof routing.entry !== 'string' || !routing.entry || !Array.isArray(routing.nodes) || !routing.nodes.length || routing.nodes.length > 36) return '发布包图路由定义无效';
      const ids = new Set();
      const branchIds = new Set();
      const stepIndexes = new Set();
      const parallelJoins = new Set();
      for (const node of routing.nodes) {
        if (typeof node?.id !== 'string' || !node.id || node.id === 'end' || ids.has(node.id)) return '发布包图节点无效';
        ids.add(node.id);
        if (node.type === 'step') {
          if (!Number.isInteger(node.stepIndex) || node.stepIndex < 0 || node.stepIndex >= release.steps.length || stepIndexes.has(node.stepIndex) || typeof node.next !== 'string' || !node.next) return '发布包图步骤节点无效';
          stepIndexes.add(node.stepIndex);
        } else if (node.type === 'gateway') {
          if (typeof node.name !== 'string' || !node.name || !Array.isArray(node.branches) || node.branches.length < 1 || node.branches.length > 8) return '发布包图网关无效';
          let defaults = 0;
          let conditions = 0;
          for (const branch of node.branches) {
            if (typeof branch?.id !== 'string' || !branch.id || branchIds.has(branch.id) || typeof branch.name !== 'string' || !branch.name || typeof branch.next !== 'string' || !branch.next) return '发布包图分支无效';
            branchIds.add(branch.id);
            if (branch.default === true) defaults++;
            else {
              conditions++;
              if (!branch.condition || typeof branch.condition.field !== 'string' || !['==', '!=', '>', '>=', '<', '<='].includes(branch.condition.operator) || branch.condition.value == null) return '发布包图分支条件无效';
              if (release.model && !release.model.fields.some(field => field.key === branch.condition.field)) return '发布包图分支字段不在冻结模型中';
            }
          }
          if (!conditions || defaults > 1) return '发布包图网关定义不完整';
        } else if (node.type === 'parallel' && routing.type === 'decision-dag') {
          if (typeof node.name !== 'string' || !node.name || typeof node.join !== 'string' || !node.join || !Array.isArray(node.branches) || node.branches.length < 2 || node.branches.length > 8) return '发布包并行网关无效';
          if (parallelJoins.has(node.join)) return '发布包聚合节点重复引用';
          parallelJoins.add(node.join);
          for (const branch of node.branches) {
            if (typeof branch?.id !== 'string' || !branch.id || branchIds.has(branch.id) || typeof branch.name !== 'string' || !branch.name || typeof branch.next !== 'string' || !branch.next) return '发布包并行分支无效';
            branchIds.add(branch.id);
          }
        } else if (node.type === 'join' && routing.type === 'decision-dag') {
          if (typeof node.name !== 'string' || !node.name || typeof node.next !== 'string' || !node.next) return '发布包聚合节点无效';
        } else return '发布包图节点类型无效';
      }
      if (!ids.has(routing.entry) || stepIndexes.size !== release.steps.length) return '发布包图路由定义不完整';
      const byId = new Map(routing.nodes.map(node => [node.id, node]));
      if (routing.type === 'decision-dag') {
        const joins = routing.nodes.filter(node => node.type === 'join');
        const parallels = routing.nodes.filter(node => node.type === 'parallel');
        if (joins.length !== parallels.length || joins.length > 4 || joins.some(join => !parallelJoins.has(join.id)) || parallels.some(node => byId.get(node.join)?.type !== 'join')) return '发布包并行与聚合节点必须一一配对';
        const targetsOf = node => node.type === 'step' || node.type === 'join' ? [node.next] : node.branches.map(branch => branch.next);
        for (const parallel of parallels) {
          const branchNodeSets = [];
          const reachesJoin = (id, seen = new Set()) => {
            if (id === parallel.join) return true;
            if (id === 'end' || seen.has(id)) return false;
            const node = byId.get(id);
            if (!node || node.type === 'parallel' || node.type === 'join') return false;
            seen.add(id);
            return targetsOf(node).every(target => reachesJoin(target, new Set(seen)));
          };
          for (const branch of parallel.branches) {
            if (!reachesJoin(branch.next)) return '发布包并行分支未汇入指定聚合节点或包含嵌套并行';
            const collected = new Set();
            const collect = id => {
              if (id === parallel.join || collected.has(id)) return;
              collected.add(id);
              const node = byId.get(id);
              if (node) for (const target of targetsOf(node)) collect(target);
            };
            collect(branch.next);
            if (branchNodeSets.some(existing => [...collected].some(id => existing.has(id)))) return '发布包并行分支在聚合前共享节点';
            branchNodeSets.push(collected);
          }
        }
      }
      const visiting = new Set();
      const visited = new Set();
      const walk = id => {
        if (id === 'end') return true;
        if (visiting.has(id) || !byId.has(id)) return false;
        if (visited.has(id)) return true;
        visiting.add(id);
        const node = byId.get(id);
        const targets = node.type === 'step' || node.type === 'join' ? [node.next] : node.branches.map(branch => branch.next);
        if (!targets.every(walk)) return false;
        visiting.delete(id);
        visited.add(id);
        return true;
      };
      if (!walk(routing.entry) || visited.size !== routing.nodes.length) return '发布包图路由存在循环或不可达节点';
    } else {
    const gateways = routing.type === 'exclusive-chain' ? routing.gateways : routing.type === 'exclusive' ? [{ id: 'gateway', afterStep: routing.afterStep, branches: routing.branches }] : null;
    const commonStepCount = routing.type === 'exclusive-chain' ? routing.commonStepCount : routing.afterStep;
    if (!gateways || !Number.isInteger(commonStepCount) || commonStepCount < 0 || commonStepCount > release.steps.length) return '发布包路由定义无效';
    if (routing.type === 'exclusive-chain' && (!Array.isArray(gateways) || gateways.length < 1 || gateways.length > 4)) return '发布包网关数量无效';
    const indexes = new Set();
    const gatewayIds = new Set();
    const branchIds = new Set();
    const positions = new Set();
    for (const gateway of gateways) {
      if (typeof gateway?.id !== 'string' || !gateway.id || gatewayIds.has(gateway.id) || !Number.isInteger(gateway.afterStep) || gateway.afterStep < 0 || gateway.afterStep > commonStepCount || positions.has(gateway.afterStep)) return '发布包网关定义无效';
      gatewayIds.add(gateway.id);
      positions.add(gateway.afterStep);
      if (!Array.isArray(gateway.branches) || gateway.branches.length < 1 || gateway.branches.length > 8) return '发布包路由分支数量无效';
      let defaults = 0;
      let conditions = 0;
      for (const branch of gateway.branches) {
        if (typeof branch?.id !== 'string' || !branch.id || branchIds.has(branch.id) || typeof branch.name !== 'string' || !branch.name) return '发布包路由分支无效';
        branchIds.add(branch.id);
        if (!Array.isArray(branch.stepIndexes) || !branch.stepIndexes.length) return '发布包路由分支缺少步骤';
        for (const index of branch.stepIndexes) {
          if (!Number.isInteger(index) || index < commonStepCount || index >= release.steps.length || indexes.has(index)) return '发布包路由步骤索引无效';
          indexes.add(index);
        }
        if (branch.default === true) defaults++;
        else {
          conditions++;
          const condition = branch.condition;
          if (!condition || typeof condition.field !== 'string' || !['==', '!=', '>', '>=', '<', '<='].includes(condition.operator) || condition.value == null) return '发布包路由条件无效';
          if (release.model && !release.model.fields.some(field => field.key === condition.field)) return '发布包路由字段不在冻结模型中';
        }
      }
      if (!conditions || defaults > 1) return '发布包路由定义不完整';
    }
    if (indexes.size !== release.steps.length - commonStepCount) return '发布包路由定义不完整';
    }
  }
  if (release.checksum !== releaseChecksum(release)) return '发布包校验和不匹配';
  for (const [index, step] of release.steps.entries()) {
    if (typeof step?.name !== 'string' || !step.name || !['rule', 'table', 'rule-group'].includes(step.type) || typeof step.drl !== 'string' || !step.drl) {
      return `发布包第 ${index + 1} 步无效`;
    }
    if (!verifyStepMappings(step, release.model)) return `发布包第 ${index + 1} 步字段映射无效`;
  }
  return null;
}
