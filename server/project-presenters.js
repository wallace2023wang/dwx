import { generateDrl } from '../shared/rules.js';
import { conditionCellExportValue, resolveRuleGroupMembers, ruleGroupFingerprint, tableDrl, validateTable } from '../shared/assets.js';
import { findField, inferSemanticType } from '../shared/bom.js';
import { compileEventStreamDraft } from '../shared/event-streams.js';
import { canonicalPackageName, packageLabel } from '../shared/packages.js';

function assetBomIssue(draft, type, bom) {
  const invalidCondition = draft.conditions?.find(column => {
    if (column.raw || column.pattern) return false;
    const field = findField(bom, column.field);
    return !field || field.kind !== 'input';
  });
  if (invalidCondition) return `条件字段 ${invalidCondition.field || '（空）'} 不存在或不是输入字段`;
  const invalidValueField = draft.conditions?.find(column => {
    if (column.raw || column.pattern || column.valueSource !== 'field') return false;
    const field = findField(bom, column.field);
    const valueField = findField(bom, column.valueField);
    return !field || !valueField || valueField.kind !== 'input' || valueField.key === field.key
      || inferSemanticType(valueField) !== inferSemanticType(field);
  });
  if (invalidValueField) return `比较字段 ${invalidValueField.valueField || '（空）'} 不存在、不是输入字段或类型不匹配`;
  if (type === 'table') {
    for (const row of draft.rows || []) {
      for (let index = 0; index < (row.conditions || []).length; index += 1) {
        const cell = row.conditions[index];
        if (!cell || typeof cell !== 'object' || cell.valueSource !== 'field') continue;
        const column = draft.conditions?.[index];
        const field = findField(bom, column?.field);
        const valueField = findField(bom, cell.valueField);
        if (!field || !valueField || valueField.kind !== 'input' || valueField.key === field.key
          || inferSemanticType(valueField) !== inferSemanticType(field)) {
          return `比较字段 ${cell.valueField || '（空）'} 不存在、不是输入字段或类型不匹配`;
        }
      }
    }
  }
  const invalidAction = draft.actions?.find(column => {
    const field = findField(bom, column.field);
    return !field || field.kind !== 'output';
  });
  if (invalidAction) return `动作字段 ${invalidAction.field || '（空）'} 不存在或不是输出字段`;
  if (type === 'table' && (!Array.isArray(draft.conditions) || !Array.isArray(draft.actions))) return '决策表列定义无效';
  return null;
}

function assetWorkflowStatus(item, changeSets) {
  if (item.archived || item.lifecycleStatus === 'archived') return 'archived';
  if (item.lifecycleStatus === 'deprecated') return 'deprecated';
  for (const changeSet of changeSets) {
    const pinned = changeSet.items?.find(entry => entry.assetId === item.id);
    if (!pinned) continue;
    if (changeSet.status === 'SUBMITTED') return 'in-review';
    if (changeSet.status === 'REJECTED' && pinned.assetRevision === (item.revision || 1)) return 'rejected';
  }
  const publishedRevision = item.versions.at(-1)?.assetRevision;
  return item.published && (publishedRevision == null || publishedRevision === (item.revision || 1)) ? 'published' : 'draft';
}

function projectAssetSummaryWithReview(item, type, bom, changeSets = []) {
  const bomIssue = assetBomIssue(item.draft, type, bom);
  return {
    id: item.id,
    name: item.draft.name,
    type: type === 'table' ? 'decision-table' : 'rule',
    modifiedBy: 'Team Server',
    status: assetWorkflowStatus(item, changeSets),
    version: String(item.versions.at(-1)?.number || item.revision || 1),
    priority: item.draft.priority ?? 0,
    bomInvalid: Boolean(bomIssue),
    bomIssue: bomIssue || undefined,
    lifecycleStatus: item.lifecycleStatus || (item.archived ? 'archived' : 'active'),
  };
}

export function projectPackages(rules, tables, packageRecords = [], bom, changeSets = []) {
  const packages = new Map(packageRecords.map(pkg => [pkg.name, { id: pkg.name, name: pkg.name, label: pkg.label, parentId: pkg.parentId || null, assets: [] }]));
  for (const [items, type] of [[rules, 'rule'], [tables, 'table']]) {
    for (const item of items) {
      const category = item.draft.category || '未分类';
      if (!packages.has(category)) packages.set(category, { id: category, name: category, label: category, assets: [] });
      packages.get(category).assets.push(projectAssetSummaryWithReview(item, type, bom, changeSets));
    }
  }
  return [...packages.values()];
}

export function projectAssetDetail(item, type, bom, changeSets = []) {
  const summary = projectAssetSummaryWithReview(item, type, bom, changeSets);
  const draft = item.draft;
  const reviewedAt = item.published ? item.versions.at(-1)?.createdAt || item.updatedAt : '尚未审核';
  const tableHitPolicy = draft.hitPolicy === 'FIRST' ? 'FIRST' : draft.hitPolicy === 'PRIORITY' ? 'PRIORITY' : 'COLLECT';
  const detail = {
    ...summary,
    packageId: draft.category || '未分类',
    packageName: draft.category || '未分类',
    updatedAt: item.updatedAt,
    revision: item.revision || 1,
    versions: (item.versions || []).map(version => ({
      number: version.number,
      createdAt: version.createdAt,
      bomVersion: version.bomVersion ?? null,
      engineVersion: version.engineVersion ?? null,
    })),
    publishedBomVersion: item.versions?.at(-1)?.bomVersion ?? null,
    currentBomVersion: bom.version,
    bomOutdated: item.versions?.at(-1)?.bomVersion != null && item.versions.at(-1).bomVersion !== bom.version,
    deprecatedAt: item.deprecatedAt || null,
    deprecatedBy: item.deprecatedBy || null,
    deprecationReason: item.deprecationReason || null,
    replacedByAssetId: item.replacedByAssetId || null,
    draft: structuredClone(draft),
    attributes: {
      priority: draft.priority || 0,
      hitPolicy: type === 'table' ? tableHitPolicy : 'FIRST',
      effectiveDate: '始终',
      createdBy: 'Team Server',
      reviewedAt,
    },
  };
  if (type === 'rule') {
    try { detail.content = generateDrl([draft], bom); }
    catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
    return detail;
  }
  const validation = validateTable(draft, bom);
  detail.validationWarnings = validation.warnings;
  try { detail.content = tableDrl(draft, bom, item.id); }
  catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
  const conditionColumns = draft.conditions.map((column, index) => ({
    id: `condition-${index}`,
    label: findField(bom, column.field)?.label || column.field,
    kind: 'condition',
  }));
  const actionColumns = draft.actions.map((column, index) => ({
    id: `action-${index}`,
    label: findField(bom, column.field)?.label || column.field,
    kind: 'action',
  }));
  detail.decisionTable = {
    hitPolicy: tableHitPolicy,
    columns: [...conditionColumns, ...actionColumns],
    rows: draft.rows.map(row => Object.fromEntries([
      ...conditionColumns.map((column, index) => [column.id, conditionCellExportValue(row.conditions[index]) || '任意']),
      ...actionColumns.map((column, index) => [column.id, row.actions[index] || '']),
    ])),
  };
  return detail;
}

export function projectBomModel({ rules, tables, flows }, bom) {
  const references = new Map(bom.fields.map(field => [field.key, 0]));
  const count = key => { if (references.has(key)) references.set(key, references.get(key) + 1); };
  const scanRule = rule => {
    for (const condition of rule?.conditions || []) {
      if (!condition.pattern && !condition.raw) {
        count(condition.field);
        if (condition.valueSource === 'field') count(condition.valueField);
      }
    }
    for (const action of rule?.actions || []) count(action.field);
  };
  const scanTable = table => {
    for (const condition of table?.conditions || []) count(condition.field);
    for (const row of table?.rows || []) for (const cell of row.conditions || []) if (cell?.valueSource === 'field') count(cell.valueField);
    for (const action of table?.actions || []) count(action.field);
  };
  const scanFlowSteps = steps => {
    for (const step of steps || []) {
      for (const mapping of step.inputMappings || []) { count(mapping.source); count(mapping.target); }
      for (const mapping of step.outputMappings || []) { count(mapping.source); count(mapping.target); }
    }
  };
  const scanFlow = flow => {
    scanFlowSteps(flow?.steps);
    for (const branch of flow?.branches || []) {
      if (!branch.default) count(branch.condition?.field);
      scanFlowSteps(branch.steps);
    }
  };
  for (const item of rules) scanRule(item.draft);
  for (const item of tables) scanTable(item.draft);
  for (const item of flows) scanFlow(item.draft);

  const fields = bom.fields.map(field => ({
    key: field.key,
    label: field.label,
    type: inferSemanticType(field),
    runtimeType: field.type,
    direction: field.kind,
    references: references.get(field.key) || 0,
    enum: field.enum || null,
    unit: field.unit || null,
    min: field.min ?? null,
    max: field.max ?? null,
    control: field.control || null,
    factType: field.factType || null,
    factTypeLabel: field.factTypeLabel || null,
  }));
  const facts = new Map();
  for (const field of fields) {
    const name = field.factType || 'RuleInput';
    const fact = facts.get(name) || { name, label: field.factTypeLabel || (name === 'RuleInput' ? '规则输入与决策结果' : name), direction: field.direction, fields: [] };
    fact.fields.push({ ...field, factName: name, factLabel: fact.label });
    if (fact.direction !== field.direction) fact.direction = 'mixed';
    facts.set(name, fact);
  }
  const factTypes = [...facts.values()];
  return {
    version: bom.version,
    updatedAt: bom.updatedAt,
    updatedBy: 'Team Server',
    eventTypes: bom.eventTypes || [],
    factTypes,
    vocabulary: fields.map(field => ({
      property: `${field.factType || 'RuleInput'}.${field.key}`,
      label: field.label,
      type: field.type,
      references: field.references,
    })),
    relationships: factTypes.map(fact => `调用请求 1 -> 1 ${fact.label}`),
    drl: bom.fields.length ? generateDrl([], bom) : '// 空白 BOM：请先创建输入和输出事实类型',
  };
}

export function projectTestSuite(suite, { rules, tables, flows, eventStreams = [] }) {
  const collections = { rule: rules, table: tables, flow: flows, 'event-stream': eventStreams };
  const target = collections[suite.target.type]?.find(item => item.id === suite.target.id);
  return {
    ...suite,
    targetName: target?.draft?.name || suite.target.id,
    targetVersions: (target?.versions || []).map(version => version.number),
  };
}

function projectFlowAssets({ rules, tables }) {
  return [
    ...rules.filter(item => item.published).map(item => ({
      id: item.id, name: item.draft.name, type: 'rule', category: item.draft.category || '未分类',
      version: item.versions.at(-1)?.number || 1,
      outputFields: [...new Set((item.published.actions || []).map(action => action.field))],
    })),
    ...tables.filter(item => item.published).map(item => ({
      id: item.id, name: item.draft.name, type: 'table', category: item.draft.category || '未分类',
      version: item.versions.at(-1)?.number || 1,
      outputFields: [...new Set((item.published.actions || []).map(action => action.field))],
    })),
  ];
}

function allFlowSteps(flow) {
  return [...(flow?.steps || []), ...(flow?.branches || []).flatMap(branch => branch.steps || [])];
}

export function flowPackageSelectors(flow) {
  return allFlowSteps(flow).filter(step => step.type === 'rule-group' && step.selector?.packageName).map(step => step.selector);
}

export function flowReferencesPackage(flow, packageName) {
  return flowPackageSelectors(flow).some(selector => selector.packageName === packageName || selector.packageName.startsWith(`${packageName}.`));
}

function projectFlowPackages(data) {
  const records = data.packageRecords || [];
  const names = new Set([
    ...records.map(pkg => pkg.name),
    ...data.rules.map(item => canonicalPackageName(item.draft.category)),
    ...data.tables.map(item => canonicalPackageName(item.draft.category)),
  ].filter(Boolean));
  return [...names].sort().map(name => {
    const record = records.find(pkg => pkg.name === name);
    const directRules = data.rules.filter(item => canonicalPackageName(item.draft.category) === name);
    const directTables = data.tables.filter(item => canonicalPackageName(item.draft.category) === name);
    const publishedRules = directRules.filter(item => item.published && !item.archived && item.lifecycleStatus !== 'deprecated');
    const publishedTables = directTables.filter(item => item.published && !item.archived && item.lifecycleStatus !== 'deprecated');
    const members = [
      ...publishedRules.map(item => ({ id: item.id, name: item.published.name, type: 'rule', version: item.versions.at(-1)?.number || 0 })),
      ...publishedTables.map(item => ({ id: item.id, name: item.published.name, type: 'table', version: item.versions.at(-1)?.number || 0 })),
    ];
    return {
      name,
      label: record?.label || packageLabel(name),
      parentId: record?.parentId || null,
      publishedRuleCount: publishedRules.length,
      publishedTableCount: publishedTables.length,
      excludedDraftCount: directRules.length + directTables.length - members.length,
      outputFields: [...new Set([
        ...publishedRules.flatMap(item => (item.published.actions || []).map(action => action.field)),
        ...publishedTables.flatMap(item => (item.published.actions || []).map(action => action.field)),
      ])],
      members,
    };
  });
}

export function projectRuleset(item, data) {
  const assetMap = new Map(projectFlowAssets(data).map(asset => [asset.id, asset]));
  const source = item.published && typeof item.published === 'object' ? item.published : (item.draft || {});
  const steps = [
    ...(source.steps || []),
    ...(source.branches || []).flatMap(branch => branch.steps || []),
  ];
  const packages = [...new Set(steps.map(step => step.type === 'rule-group' ? step.packageName || step.selector?.packageName : assetMap.get(step.id)?.category).filter(Boolean))];
  const outdatedDependencies = steps.flatMap(step => {
    if (step.type === 'rule-group') {
      if (!step.memberFingerprint) return [];
      try {
        const selector = step.selector || { packageName: step.packageName, includeChildren: step.includeChildren === true };
        if (source.bomVersion != null && source.bomVersion !== data.bom.version) return [{
          kind: 'rule-group', nodeId: step.nodeId, packageName: selector.packageName, reason: 'bom-changed',
        }];
        const members = resolveRuleGroupMembers(selector, data.rules, data.tables, data.packageRecords || []);
        return ruleGroupFingerprint(members) === step.memberFingerprint ? [] : [{
          kind: 'rule-group', nodeId: step.nodeId, packageName: selector.packageName, reason: 'members-changed',
        }];
      } catch {
        return [{ kind: 'rule-group', nodeId: step.nodeId, packageName: step.packageName || step.selector?.packageName, reason: 'members-changed' }];
      }
    }
    const current = assetMap.get(step.id);
    return current && step.version && step.version < current.version
      ? [{ id: step.id, name: step.name || current.name, publishedVersion: step.version, latestVersion: current.version }]
      : [];
  }).filter((dependency, index, all) => all.findIndex(item => (item.kind || 'asset') === (dependency.kind || 'asset') && (item.id || item.nodeId) === (dependency.id || dependency.nodeId)) === index);
  const flowSteps = [
    ...(source.steps || []).map((step, index) => ({
      order: index + 1, type: step.type, id: step.id,
      name: step.name || assetMap.get(step.id)?.name || step.selector?.packageName || step.id,
      version: step.version || assetMap.get(step.id)?.version || 0, branchName: null,
    })),
    ...(source.branches || []).flatMap(branch => (branch.steps || []).map((step, index) => ({
      order: index + 1, type: step.type, id: step.id,
      name: step.name || assetMap.get(step.id)?.name || step.selector?.packageName || step.id,
      version: step.version || assetMap.get(step.id)?.version || 0, branchName: branch.name,
    }))),
  ];
  return {
    id: item.id,
    name: source.name || item.draft.name,
    flowId: item.id,
    flowName: source.name || item.draft.name,
    hitPolicy: 'COLLECT',
    maxFirings: 100,
    inputs: ['RuleInput'],
    outputs: ['RuleInput'],
    packages,
    branchCount: (source.branches || []).length,
    stepCount: flowSteps.length,
    steps: flowSteps,
    sequential: true,
    revision: item.revision || 1,
    status: assetWorkflowStatus(item, data.changeSets || []),
    version: item.versions.at(-1)?.number || 0,
    needsRepublish: outdatedDependencies.length > 0,
    outdatedDependencies,
    updatedAt: item.updatedAt,
  };
}

export function projectFlowDetail(item, data) {
  return {
    ...projectRuleset(item, data),
    description: item.draft.description || '',
    category: item.draft.category || '未分类',
    draft: structuredClone(item.draft),
    availableAssets: projectFlowAssets(data),
    availablePackages: projectFlowPackages(data),
  };
}

function eventStreamStatus(item) {
  if (item.archived) return 'archived';
  return item.published ? 'published' : 'draft';
}

export function projectEventStreamSummary(item) {
  const statementLabels = (item.draft.statements || []).flatMap(statement => [statement.label, statement.name, statement.description]).filter(Boolean);
  return {
    id: item.id,
    name: item.draft.name,
    description: item.draft.description || '',
    type: 'event-stream',
    status: eventStreamStatus(item),
    package: item.draft.category || 'default',
    version: item.versions.at(-1)?.number || 0,
    bomVersion: item.versions.at(-1)?.bomVersion || null,
    revision: item.revision || 1,
    statementCount: item.draft.statements?.length || 0,
    statementLabels,
    updatedAt: item.updatedAt,
    modifiedBy: item.updatedBy || 'Team Server',
  };
}

export function projectEventStreamDetail(item, data) {
  const compiled = compileEventStreamDraft(item.draft, data.bom);
  return {
    ...projectEventStreamSummary(item),
    description: item.draft.description || '',
    draft: structuredClone(item.draft),
    published: item.published || null,
    versions: item.versions || [],
    schemas: compiled.result?.schemas || [],
    validationError: compiled.error || null,
  };
}

export function eventStreamAuthoring(statements = []) {
  return statements.map(statement => ({
    name: statement.name,
    ...(statement.label ? { label: statement.label } : {}),
    ...(statement.description ? { description: statement.description } : {}),
    ...(statement.mode ? { mode: statement.mode } : {}),
    ...(statement.template ? { template: statement.template } : {}),
    ...(statement.params ? { params: structuredClone(statement.params) } : {}),
  }));
}
