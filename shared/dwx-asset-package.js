import { createHash } from 'node:crypto';
import { validateTable } from './assets.js';
import { validateDecisionTree } from './decision-trees.js';
import { canonicalPackageName, packageLabel, PACKAGE_NAME_RE } from './packages.js';
import { validateRuleTemplate } from './rule-templates.js';
import { validateRule } from './rules.js';
import { validateScorecard } from './scorecards.js';

export const DWX_ASSET_PACKAGE_FORMAT = 'dwx-asset-package';
export const DWX_ASSET_PACKAGE_VERSION = 1;

const TYPE_ALIASES = Object.freeze({
  rule: 'rule',
  bal: 'rule',
  'decision-table': 'decision-table',
  table: 'decision-table',
  'decision-tree': 'decision-tree',
  tree: 'decision-tree',
  scorecard: 'scorecard',
  'rule-template': 'rule-template',
  template: 'rule-template',
});

const typeLabels = Object.freeze({
  rule: 'BAL 规则',
  'decision-table': '决策表',
  'decision-tree': '决策树',
  scorecard: '计分卡',
  'rule-template': '规则模板',
});

function text(value, max = 120) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
}

function sourceKey(kind, sourceId) {
  return `${kind}:${sourceId}`;
}

function migrationSourceId(item) {
  return item?.migration?.provider === 'dwx' ? item.migration.sourceId : null;
}

function normalizedPackageRecord(input) {
  const name = canonicalPackageName(input?.name);
  const label = text(input?.label, 40) || packageLabel(name);
  const parentId = input?.parentId ? canonicalPackageName(input.parentId) : name.includes('.') ? name.split('.').slice(0, -1).join('.') : null;
  return { name, label, parentId };
}

function validatePackageRecord(pkg) {
  if (!PACKAGE_NAME_RE.test(pkg.name)) return '包名必须是最多 3 层的英文小写标识符';
  if (!pkg.label || pkg.label.length > 40) return '包中文显示名需为 1–40 个字符';
  if (pkg.parentId && (!PACKAGE_NAME_RE.test(pkg.parentId) || !pkg.name.startsWith(`${pkg.parentId}.`))) return '父包与子包层级不一致';
  return null;
}

function ensurePackage(packages, name) {
  const parts = name.split('.');
  for (let length = 1; length <= parts.length; length += 1) {
    const packageName = parts.slice(0, length).join('.');
    if (!packages.has(packageName)) packages.set(packageName, {
      name: packageName,
      label: packageLabel(packageName),
      parentId: length > 1 ? parts.slice(0, length - 1).join('.') : null,
    });
  }
}

function assetValidation(type, draft, bom, variables) {
  if (type === 'rule') return validateRule(draft, bom, variables);
  if (type === 'decision-tree') return validateDecisionTree(draft, bom, variables);
  if (type === 'scorecard') return validateScorecard(draft, bom, variables);
  if (type === 'rule-template') return validateRuleTemplate(draft, bom);
  return validateTable(draft, bom, variables).error;
}

function normalizeAsset(input, index, bom, variables) {
  const sourceId = text(input?.sourceId, 200);
  const type = TYPE_ALIASES[input?.type];
  const name = text(input?.name || input?.draft?.name, 80);
  const category = canonicalPackageName(input?.package || input?.category || input?.draft?.category);
  const errors = [];
  if (!sourceId) errors.push('sourceId 需为 1–200 个字符');
  if (!type) errors.push(`不支持资产类型“${input?.type || '（空）'}”；自由 IRL/DRL 与专有二进制构件需先转换为结构化资产`);
  if (!name) errors.push('名称需为 1–80 个字符');
  if (!PACKAGE_NAME_RE.test(category)) errors.push('规则包必须是最多 3 层的英文小写标识符');
  if (!input?.draft || typeof input.draft !== 'object' || Array.isArray(input.draft)) errors.push('draft 必须是结构化对象');
  const draft = input?.draft && typeof input.draft === 'object' && !Array.isArray(input.draft)
    ? { ...structuredClone(input.draft), name: name || '', category }
    : null;
  if (type && draft && !errors.length) {
    const issue = assetValidation(type, draft, bom, variables);
    if (issue) errors.push(issue);
  }
  return {
    index,
    sourceId: sourceId || `invalid-${index + 1}`,
    type: type || input?.type || 'unknown',
    typeLabel: typeLabels[type] || input?.type || '未知类型',
    name: name || `第 ${index + 1} 个资产`,
    package: category || '',
    draft,
    errors,
  };
}

function normalizeRuleset(input, index) {
  const sourceId = text(input?.sourceId, 200);
  const name = text(input?.name, 80);
  const description = typeof input?.description === 'string' && input.description.length <= 500 ? input.description : '';
  const packages = Array.isArray(input?.packages) ? [...new Set(input.packages.map(canonicalPackageName).filter(Boolean))] : [];
  const errors = [];
  if (!sourceId) errors.push('sourceId 需为 1–200 个字符');
  if (!name) errors.push('名称需为 1–80 个字符');
  if (!Array.isArray(input?.packages) || !packages.length) errors.push('至少需要引用一个规则包');
  if (packages.some(packageName => !PACKAGE_NAME_RE.test(packageName))) errors.push('引用了无效规则包');
  return { index, sourceId: sourceId || `invalid-ruleset-${index + 1}`, name: name || `第 ${index + 1} 个规则集`, description, packages, errors };
}

export function normalizeDwxAssetPackage(input, bom, variables = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('DWX 资产包必须是 JSON 对象');
  if (input.format !== DWX_ASSET_PACKAGE_FORMAT) throw new Error(`format 必须是 ${DWX_ASSET_PACKAGE_FORMAT}`);
  if (input.schemaVersion !== DWX_ASSET_PACKAGE_VERSION) throw new Error(`仅支持 schemaVersion ${DWX_ASSET_PACKAGE_VERSION}`);
  const projectName = text(input.project?.name, 120);
  if (!projectName) throw new Error('project.name 需为 1–120 个字符');
  const projectVersion = input.project?.version == null ? null : text(String(input.project.version), 80);
  if (input.project?.version != null && !projectVersion) throw new Error('project.version 不能超过 80 个字符');
  const packageInputs = Array.isArray(input.packages) ? input.packages : [];
  const assetInputs = Array.isArray(input.assets) ? input.assets : [];
  const rulesetInputs = Array.isArray(input.rulesets) ? input.rulesets : [];
  if (!assetInputs.length) throw new Error('迁移清单至少需要一个资产');
  if (packageInputs.length > 200 || assetInputs.length > 500 || rulesetInputs.length > 100) throw new Error('单次最多导入 200 个包、500 个资产和 100 个规则集');
  const packages = new Map();
  for (const packageInput of packageInputs) {
    const pkg = normalizedPackageRecord(packageInput);
    if (packages.has(pkg.name)) throw new Error(`规则包重复：${pkg.name || '（空）'}`);
    packages.set(pkg.name, pkg);
  }
  const assets = assetInputs.map((asset, index) => normalizeAsset(asset, index, bom, variables));
  for (const asset of assets) if (PACKAGE_NAME_RE.test(asset.package)) ensurePackage(packages, asset.package);
  const rulesets = rulesetInputs.map(normalizeRuleset);
  for (const ruleset of rulesets) for (const packageName of ruleset.packages) ensurePackage(packages, packageName);
  const packageErrors = [];
  for (const pkg of packages.values()) {
    const issue = validatePackageRecord(pkg);
    if (issue) packageErrors.push(`规则包“${pkg.name || '（空）'}”：${issue}`);
    if (pkg.parentId && !packages.has(pkg.parentId)) packageErrors.push(`规则包“${pkg.name}”的父包不存在`);
  }
  const seen = new Set();
  for (const asset of assets) {
    const key = sourceKey('asset', asset.sourceId);
    if (seen.has(key)) asset.errors.push('sourceId 在清单中重复');
    seen.add(key);
  }
  for (const ruleset of rulesets) {
    const key = sourceKey('ruleset', ruleset.sourceId);
    if (seen.has(key)) ruleset.errors.push('sourceId 在清单中重复');
    seen.add(key);
    for (const packageName of ruleset.packages) if (!packages.has(packageName)) ruleset.errors.push(`规则包不存在：${packageName}`);
  }
  return {
    format: DWX_ASSET_PACKAGE_FORMAT,
    schemaVersion: DWX_ASSET_PACKAGE_VERSION,
    project: { name: projectName, version: projectVersion },
    packages: [...packages.values()].sort((left, right) => left.name.localeCompare(right.name)),
    assets,
    rulesets,
    packageErrors,
  };
}

export function dwxAssetPackageChecksum(manifest) {
  return `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}

export function analyzeDwxAssetPackage(input, { bom, variables = [], packages = [], rules = [], tables = [], flows = [] }) {
  let manifest;
  try { manifest = normalizeDwxAssetPackage(input, bom, variables); }
  catch (error) {
    return { valid: false, checksum: null, manifest: null, summary: null, packages: [], assets: [], rulesets: [], errors: [error.message], warnings: [] };
  }
  const existingPackages = new Map(packages.map(pkg => [pkg.name, pkg]));
  const existingAssets = [...rules, ...tables];
  const importedAssets = new Map(existingAssets.map(item => [migrationSourceId(item), item]).filter(([sourceId]) => sourceId));
  const importedFlows = new Map(flows.map(item => [migrationSourceId(item), item]).filter(([sourceId]) => sourceId));
  const checksum = dwxAssetPackageChecksum(manifest);
  const packagePreview = manifest.packages.map(pkg => ({ ...pkg, action: existingPackages.has(pkg.name) ? 'reuse' : 'create' }));
  const assetPreview = manifest.assets.map(asset => {
    const errors = [...asset.errors];
    const imported = importedAssets.get(asset.sourceId);
    if (imported && imported.migration?.manifestChecksum !== checksum) errors.push('相同 sourceId 已由另一版本清单导入；首版不自动覆盖，请创建新 sourceId 或人工合并');
    const nameConflict = existingAssets.find(item => !item.archived && item.draft?.category === asset.package && item.draft?.name === asset.name && item !== imported);
    if (nameConflict) errors.push('同一规则包已存在同名资产');
    const action = errors.length ? 'error' : imported ? 'skip' : 'create';
    return { ...asset, action, existingId: imported?.id || null, errors };
  });
  const rulesetPreview = manifest.rulesets.map(ruleset => {
    const errors = [...ruleset.errors];
    const imported = importedFlows.get(ruleset.sourceId);
    if (imported && imported.migration?.manifestChecksum !== checksum) errors.push('相同 sourceId 已由另一版本清单导入；首版不自动覆盖，请创建新 sourceId 或人工合并');
    const nameConflict = flows.find(item => !item.archived && item.draft?.name === ruleset.name && item !== imported);
    if (nameConflict) errors.push('项目中已存在同名规则集');
    const action = errors.length ? 'error' : imported ? 'skip' : 'create';
    return { ...ruleset, action, existingId: imported?.id || null, errors };
  });
  const errors = [
    ...manifest.packageErrors,
    ...assetPreview.flatMap(asset => asset.errors.map(error => `${asset.typeLabel}“${asset.name}”：${error}`)),
    ...rulesetPreview.flatMap(ruleset => ruleset.errors.map(error => `规则集“${ruleset.name}”：${error}`)),
  ];
  const warnings = [];
  const skipped = assetPreview.filter(asset => asset.action === 'skip').length + rulesetPreview.filter(ruleset => ruleset.action === 'skip').length;
  if (skipped) warnings.push(`${skipped} 个对象已由相同 sourceId 导入，将跳过`);
  if (!manifest.rulesets.length) warnings.push('清单没有 Ruleset；本次只创建规则资产草稿');
  const byType = Object.fromEntries(Object.keys(typeLabels).map(type => [type, assetPreview.filter(asset => asset.type === type && asset.action === 'create').length]));
  return {
    valid: errors.length === 0,
    checksum,
    manifest,
    summary: {
      packages: { create: packagePreview.filter(pkg => pkg.action === 'create').length, reuse: packagePreview.filter(pkg => pkg.action === 'reuse').length },
      assets: { create: assetPreview.filter(asset => asset.action === 'create').length, skip: assetPreview.filter(asset => asset.action === 'skip').length, byType },
      rulesets: { create: rulesetPreview.filter(ruleset => ruleset.action === 'create').length, skip: rulesetPreview.filter(ruleset => ruleset.action === 'skip').length },
    },
    packages: packagePreview,
    assets: assetPreview,
    rulesets: rulesetPreview,
    errors,
    warnings,
  };
}

export function dwxAssetStorage(type) {
  return type === 'rule' ? 'rule' : 'table';
}

function exportedAssetType(draft) {
  if (draft?.kind === 'decision-tree') return 'decision-tree';
  if (draft?.kind === 'scorecard') return 'scorecard';
  if (draft?.kind === 'rule-template') return 'rule-template';
  return Array.isArray(draft?.rows) ? 'decision-table' : 'rule';
}

function exportedSourceId(item, type) {
  return migrationSourceId(item) || `${type}/${item.id}`;
}

function exportableRuleset(flow) {
  const steps = Array.isArray(flow.draft?.steps) ? flow.draft.steps : [];
  if (flow.draft?.graph || (flow.draft?.gateways || []).length || (flow.draft?.branches || []).length) return null;
  if (!steps.length || steps.some(step => step.type !== 'rule-group' || !step.selector?.packageName)) return null;
  return [...new Set(steps.map(step => canonicalPackageName(step.selector.packageName)).filter(Boolean))];
}

export function buildDwxAssetPackage({ project, packages = [], rules = [], tables = [], flows = [] }) {
  const exportedAssets = [...rules, ...tables].filter(item => !item.archived).map(item => {
    const draft = structuredClone(item.draft);
    const type = exportedAssetType(draft);
    return {
      sourceId: exportedSourceId(item, type),
      type,
      name: draft.name,
      package: canonicalPackageName(draft.category),
      draft,
    };
  });
  const exportedRulesets = [];
  const warnings = [];
  for (const flow of flows.filter(item => !item.archived)) {
    const packageNames = exportableRuleset(flow);
    if (!packageNames) {
      warnings.push(`规则集“${flow.draft?.name || flow.id}”包含分支、子流程或直接资产步骤，当前 DWX 资产包无法无损表示，已跳过`);
      continue;
    }
    exportedRulesets.push({
      sourceId: exportedSourceId(flow, 'ruleset'),
      name: flow.draft.name,
      description: flow.draft.description || '',
      packages: packageNames,
    });
  }
  const usedPackages = new Set([
    ...exportedAssets.map(asset => asset.package),
    ...exportedRulesets.flatMap(ruleset => ruleset.packages),
  ]);
  const packageMap = new Map(packages.map(pkg => [pkg.name, pkg]));
  for (const name of [...usedPackages]) ensurePackage(packageMap, name);
  const exportedPackages = [...packageMap.values()]
    .filter(pkg => usedPackages.has(pkg.name) || [...usedPackages].some(name => name.startsWith(`${pkg.name}.`)))
    .map(pkg => ({ name: pkg.name, label: pkg.label || packageLabel(pkg.name), parentId: pkg.parentId || null }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    format: DWX_ASSET_PACKAGE_FORMAT,
    schemaVersion: DWX_ASSET_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { name: project.name, version: project.version || null },
    packages: exportedPackages,
    assets: exportedAssets,
    rulesets: exportedRulesets,
    warnings,
  };
}
