import { createHash } from 'node:crypto';
import { generateDrl } from './rules.js';
import { tableDrl } from './assets.js';
import { defaultBom, findField, validateBom } from './bom.js';
import { CEP_ENGINE_VERSION } from './event-streams.js';

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
  if (typeof (request.description ?? '') !== 'string' || (request.description ?? '').length > 500) return '发布说明不能超过 500 个字符';
  if (!request.target || !['rule', 'table', 'flow', 'event-stream'].includes(request.target.type) || typeof request.target.id !== 'string' || !request.target.id) {
    return '发布来源必须是有效的规则、决策表、规则流或事件流';
  }
  return null;
}

function publishedAsset(collection, id, label) {
  const asset = collection.find(item => item.id === id && !item.archived && item.lifecycleStatus !== 'deprecated');
  if (!asset) throw new Error(`${label}不存在`);
  if (!asset.published || !asset.versions?.length) throw new Error(`${label}尚未发布`);
  return asset;
}

function releaseStep(step) {
  const result = {
    name: step.name,
    type: step.type,
    assetId: step.id,
    assetVersion: step.version,
    drl: step.drl,
  };
  if (step.inputMappings?.length) result.inputMappings = structuredClone(step.inputMappings);
  if (step.outputMappings?.length) result.outputMappings = structuredClone(step.outputMappings);
  return result;
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

export function buildRelease({ id, request, rules, tables, flows, eventStreams = [], releases, bom = defaultBom(), createdAt = new Date().toISOString(), createdBy = 'Team Server' }) {
  const error = validateReleaseRequest(request);
  if (error) throw new Error(error);

  const nextVersion = releases
    .filter(item => item.decisionService === request.decisionService)
    .reduce((maximum, item) => Math.max(maximum, item.version || 0), 0) + 1;
  let targetAsset;
  let steps;
  let model;
  let routing;

  if (request.target.type === 'rule') {
    targetAsset = publishedAsset(rules, request.target.id, '规则');
    const version = targetAsset.versions.at(-1);
    model = structuredClone(version.bom || bom);
    steps = [{
      name: targetAsset.published.name,
      type: 'rule',
      assetId: targetAsset.id,
      assetVersion: version.number,
      drl: version.drl || generateDrl([targetAsset.published], model),
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
      drl: version.drl || tableDrl(targetAsset.published, model, targetAsset.id),
    }];
  } else if (request.target.type === 'flow') {
    targetAsset = publishedAsset(flows, request.target.id, '规则流');
    model = structuredClone(targetAsset.published.bom || targetAsset.versions.at(-1).bom || bom);
    steps = targetAsset.published.steps.map(releaseStep);
    if (targetAsset.published.branches?.length) {
      routing = {
        type: 'exclusive',
        afterStep: steps.length,
        branches: targetAsset.published.branches.map(branch => {
          const stepIndexes = [];
          for (const step of branch.steps) {
            stepIndexes.push(steps.length);
            steps.push(releaseStep(step));
          }
          return {
            id: branch.id,
            name: branch.name,
            default: branch.default === true,
            condition: branch.default ? null : branch.condition,
            stepIndexes,
          };
        }),
      };
    }
  } else {
    targetAsset = publishedAsset(eventStreams, request.target.id, '事件流');
    const version = targetAsset.versions.at(-1);
    const release = {
      schemaVersion: CEP_RELEASE_SCHEMA_VERSION,
      id,
      decisionService: request.decisionService,
      version: nextVersion,
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
  if (release.routing != null) {
    const routing = release.routing;
    if (routing.type !== 'exclusive' || !Number.isInteger(routing.afterStep) || routing.afterStep < 0 || routing.afterStep > release.steps.length) return '发布包路由定义无效';
    if (!Array.isArray(routing.branches) || routing.branches.length < 1 || routing.branches.length > 8) return '发布包路由分支数量无效';
    const indexes = new Set();
    const ids = new Set();
    let defaults = 0;
    let conditions = 0;
    for (const branch of routing.branches) {
      if (typeof branch?.id !== 'string' || !branch.id || ids.has(branch.id) || typeof branch.name !== 'string' || !branch.name) return '发布包路由分支无效';
      ids.add(branch.id);
      if (!Array.isArray(branch.stepIndexes) || !branch.stepIndexes.length) return '发布包路由分支缺少步骤';
      for (const index of branch.stepIndexes) {
        if (!Number.isInteger(index) || index < routing.afterStep || index >= release.steps.length || indexes.has(index)) return '发布包路由步骤索引无效';
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
    if (!conditions || defaults > 1 || indexes.size !== release.steps.length - routing.afterStep) return '发布包路由定义不完整';
  }
  if (release.checksum !== releaseChecksum(release)) return '发布包校验和不匹配';
  for (const [index, step] of release.steps.entries()) {
    if (typeof step?.name !== 'string' || !step.name || !['rule', 'table'].includes(step.type) || typeof step.drl !== 'string' || !step.drl) {
      return `发布包第 ${index + 1} 步无效`;
    }
    if (!verifyStepMappings(step, release.model)) return `发布包第 ${index + 1} 步字段映射无效`;
  }
  return null;
}
