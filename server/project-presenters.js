import { generateDrl, ruleConditions } from '../shared/rules.js';
import { conditionCellExportValue, flowBranches, flowGateways, flowSteps, resolveRuleGroupMembers, ruleGroupFingerprint, tableDrl, validateTable } from '../shared/assets.js';
import { decisionTreeDrl, decisionTreeLeaves, isDecisionTree, validateDecisionTree } from '../shared/decision-trees.js';
import { isScorecard, scorecardDrl, validateScorecard } from '../shared/scorecards.js';
import { findField, inferSemanticType, resolvedBomFields } from '../shared/bom.js';
import { compileEventStreamDraft, eventStreamDependencies } from '../shared/event-streams.js';
import { canonicalPackageName, packageLabel } from '../shared/packages.js';
import { assetOwner } from './asset-ownership.js';
import { assetGovernance } from './domain-utils.js';

function presentedGovernance(item) {
  const governance = assetGovernance(item);
  const today = new Date().toISOString().slice(0, 10);
  const effectiveStatus = governance.effectiveFrom && today < governance.effectiveFrom
    ? 'scheduled'
    : governance.effectiveTo && today > governance.effectiveTo ? 'expired' : 'effective';
  return { ...governance, effectiveStatus };
}

function effectiveDateLabel(item) {
  const { effectiveFrom, effectiveTo } = assetGovernance(item);
  if (effectiveFrom && effectiveTo) return `${effectiveFrom} 至 ${effectiveTo}`;
  if (effectiveFrom) return `${effectiveFrom} 起`;
  if (effectiveTo) return `截至 ${effectiveTo}`;
  return '始终';
}

function assetBomIssue(draft, type, bom) {
  if (isScorecard(draft)) {
    const scoreField = findField(bom, draft.scoreOutputField);
    if (!scoreField || scoreField.kind !== 'output' || !['Integer', 'Decimal'].includes(inferSemanticType(scoreField))) return '总分输出字段不存在或不是数值输出字段';
    for (const characteristic of draft.characteristics || []) {
      const field = findField(bom, characteristic.field);
      if (!field || field.kind !== 'input') return `评分特征字段 ${characteristic.field || '（空）'} 不存在或不是输入字段`;
    }
    for (const band of draft.bands || []) for (const action of band.actions || []) {
      if (action.fieldSource === 'variable') continue;
      const field = findField(bom, action.field);
      if (!field || field.kind !== 'output') return `动作字段 ${action.field || '（空）'} 不存在或不是输出字段`;
    }
    return null;
  }
  if (isDecisionTree(draft)) {
    let issue = null;
    const visit = node => {
      if (!node || issue) return;
      if (node.type === 'condition') {
        if (node.condition?.fieldSource !== 'variable') {
          const field = findField(bom, node.condition?.field);
          if (!field || field.kind !== 'input') issue = `条件字段 ${node.condition?.field || '（空）'} 不存在或不是输入字段`;
          if (!issue && node.condition?.valueSource === 'field') {
            const valueField = findField(bom, node.condition.valueField);
            if (!valueField || valueField.kind !== 'input' || valueField.key === field.key || inferSemanticType(valueField) !== inferSemanticType(field)) {
              issue = `比较字段 ${node.condition.valueField || '（空）'} 不存在、不是输入字段或类型不匹配`;
            }
          }
        }
        visit(node.trueChild);
        visit(node.falseChild);
        return;
      }
      for (const action of node.actions || []) {
        if (action.fieldSource === 'variable') continue;
        const field = findField(bom, action.field);
        if (!field || field.kind !== 'output') { issue = `动作字段 ${action.field || '（空）'} 不存在或不是输出字段`; break; }
      }
    };
    visit(draft.root);
    return issue;
  }
  const invalidCondition = draft.conditions?.find(column => {
    if (column.fieldSource === 'variable') return false;
    if (column.raw || column.pattern) return false;
    const field = findField(bom, column.field);
    return !field || field.kind !== 'input';
  });
  if (invalidCondition) return `条件字段 ${invalidCondition.field || '（空）'} 不存在或不是输入字段`;
  const invalidValueField = draft.conditions?.find(column => {
    if (column.fieldSource === 'variable') return false;
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
    if (column.fieldSource === 'variable') return false;
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
  const latestDraftRevision = item.revisions?.at(-1)?.number || item.revision || 1;
  return item.published && (publishedRevision == null || latestDraftRevision <= publishedRevision) ? 'published' : 'draft';
}

function projectAssetSummaryWithReview(item, type, bom, changeSets = []) {
  const bomIssue = assetBomIssue(item.draft, type, bom);
  return {
    id: item.id,
    name: item.draft.name,
    type: type === 'table' ? (isScorecard(item.draft) ? 'scorecard' : isDecisionTree(item.draft) ? 'decision-tree' : 'decision-table') : 'rule',
    modifiedBy: 'Team Server',
    status: assetWorkflowStatus(item, changeSets),
    version: String(item.versions.at(-1)?.number || item.revision || 1),
    revision: item.revision || 1,
    priority: item.draft.priority ?? 0,
    bomInvalid: Boolean(bomIssue),
    bomIssue: bomIssue || undefined,
    lifecycleStatus: item.lifecycleStatus || (item.archived ? 'archived' : 'active'),
    owner: assetOwner(item),
    ...presentedGovernance(item),
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

export function projectAssetDetail(item, type, bom, changeSets = [], projectVariables = null) {
  const summary = projectAssetSummaryWithReview(item, type, bom, changeSets);
  const draft = item.draft;
  const reviewedAt = item.published ? item.versions.at(-1)?.createdAt || item.updatedAt : '尚未审核';
  const tableHitPolicy = draft.hitPolicy === 'FIRST' ? 'FIRST' : draft.hitPolicy === 'PRIORITY' ? 'PRIORITY' : 'COLLECT';
  const detail = {
    ...summary,
    packageId: draft.category || '未分类',
    packageName: draft.category || '未分类',
    updatedAt: item.updatedAt,
    owner: assetOwner(item),
    ...presentedGovernance(item),
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
    projectVariables: structuredClone(projectVariables || []),
    bomMethods: structuredClone(bom.methods || []),
    deprecatedAt: item.deprecatedAt || null,
    deprecatedBy: item.deprecatedBy || null,
    deprecationReason: item.deprecationReason || null,
    replacedByAssetId: item.replacedByAssetId || null,
    draft: structuredClone(draft),
    attributes: {
      priority: draft.priority || 0,
      hitPolicy: type === 'table' ? tableHitPolicy : 'FIRST',
      effectiveDate: effectiveDateLabel(item),
      createdBy: 'Team Server',
      reviewedAt,
    },
  };
  if (type === 'rule') {
    try { detail.content = generateDrl([draft], bom, projectVariables?.length ? projectVariables : draft.variables); }
    catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
    return detail;
  }
  if (isDecisionTree(draft)) {
    const variables = projectVariables?.length ? projectVariables : [];
    const validation = validateDecisionTree(draft, bom, variables);
    detail.validationWarnings = [];
    detail.decisionTreeLeaves = decisionTreeLeaves(draft);
    try { detail.content = decisionTreeDrl(draft, bom, item.id, variables); }
    catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
    if (validation) detail.bomIssue ||= validation;
    return detail;
  }
  if (isScorecard(draft)) {
    const variables = projectVariables?.length ? projectVariables : [];
    detail.validationWarnings = [];
    try { detail.content = scorecardDrl(draft, bom, item.id, variables); }
    catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
    return detail;
  }
  const variables = projectVariables?.length ? projectVariables : [];
  const validation = validateTable(draft, bom, variables);
  detail.validationWarnings = validation.warnings;
  try { detail.content = tableDrl(draft, bom, item.id, variables); }
  catch (error) { detail.content = `// 当前草稿无法生成 DRL：${error.message}`; }
  const conditionColumns = draft.conditions.map((column, index) => ({
    id: `condition-${index}`,
    label: column.fieldSource === 'variable'
      ? projectVariables?.find(variable => variable.name === column.field)?.label || column.field
      : findField(bom, column.field)?.label || column.field,
    kind: 'condition',
  }));
  const actionColumns = draft.actions.map((column, index) => ({
    id: `action-${index}`,
    label: column.fieldSource === 'variable'
      ? projectVariables?.find(variable => variable.name === column.field)?.label || column.field
      : findField(bom, column.field)?.label || column.field,
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
  const scanExpression = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'field' && node.fieldSource !== 'variable') count(node.field);
    else if (node.type === 'binary') { scanExpression(node.left); scanExpression(node.right); }
    else if (node.type === 'function') for (const argument of node.args || []) scanExpression(argument);
    else if (node.type === 'method') scanExpression((bom.methods || []).find(method => method.name === node.name)?.expression);
  };
  const scanRule = rule => {
    for (const condition of ruleConditions(rule || {})) {
      if (!condition.pattern && !condition.raw) {
        count(condition.field);
        if (condition.valueSource === 'field') count(condition.valueField);
      }
    }
    for (const action of rule?.actions || []) { count(action.field); scanExpression(action.valueExpression); }
  };
  const scanTable = table => {
    if (isScorecard(table)) {
      count(table.scoreOutputField);
      for (const characteristic of table.characteristics || []) count(characteristic.field);
      for (const band of table.bands || []) for (const action of band.actions || []) { count(action.field); scanExpression(action.valueExpression); }
      return;
    }
    if (isDecisionTree(table)) {
      const visit = node => {
        if (!node) return;
        if (node.type === 'condition') {
          count(node.condition?.field);
          if (node.condition?.valueSource === 'field') count(node.condition.valueField);
          visit(node.trueChild);
          visit(node.falseChild);
          return;
        }
        for (const action of node.actions || []) { count(action.field); scanExpression(action.valueExpression); }
      };
      visit(table.root);
      return;
    }
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
    for (const branch of flowBranches(flow)) {
      if (!branch.default) count(branch.condition?.field);
      scanFlowSteps(branch.steps);
    }
  };
  for (const item of rules) scanRule(item.draft);
  for (const item of tables) scanTable(item.draft);
  for (const item of flows) scanFlow(item.draft);

  const fields = resolvedBomFields(bom).map(field => ({
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
    domainId: field.domainId || null,
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
    domains: bom.domains || [],
    methods: bom.methods || [],
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
  const treeActions = tree => decisionTreeLeaves(tree).flatMap(leaf => leaf.actions || []);
  const structuredActions = draft => isScorecard(draft)
    ? [{ field: draft.scoreOutputField }, ...(draft.bands || []).flatMap(band => band.actions || [])]
    : isDecisionTree(draft) ? treeActions(draft) : draft.actions || [];
  return [
    ...rules.filter(item => item.published).map(item => ({
      id: item.id, name: item.draft.name, type: 'rule', category: item.draft.category || '未分类',
      version: item.versions.at(-1)?.number || 1,
      outputFields: [...new Set((item.published.actions || []).map(action => action.field))],
    })),
    ...tables.filter(item => item.published).map(item => ({
      id: item.id, name: item.draft.name, type: 'table', category: item.draft.category || '未分类',
      version: item.versions.at(-1)?.number || 1,
      assetKind: isScorecard(item.published) ? 'scorecard' : isDecisionTree(item.published) ? 'decision-tree' : 'decision-table',
      outputFields: [...new Set(structuredActions(item.published).map(action => action.field))],
    })),
  ];
}

function allFlowSteps(flow) {
  return flowSteps(flow);
}

export function flowPackageSelectors(flow) {
  return allFlowSteps(flow).filter(step => step.type === 'rule-group' && step.selector?.packageName).map(step => step.selector);
}

export function flowReferencesPackage(flow, packageName) {
  return flowPackageSelectors(flow).some(selector => selector.packageName === packageName || selector.packageName.startsWith(`${packageName}.`));
}

function projectFlowPackages(data) {
  const structuredActions = draft => isDecisionTree(draft)
    ? decisionTreeLeaves(draft).flatMap(leaf => leaf.actions || [])
    : isScorecard(draft)
      ? [{ field: draft.scoreOutputField }, ...(draft.bands || []).flatMap(band => band.actions || [])]
      : draft.actions || [];
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
        ...publishedTables.flatMap(item => structuredActions(item.published).map(action => action.field)),
      ])],
      members,
    };
  });
}

export function projectRuleset(item, data) {
  const assetMap = new Map(projectFlowAssets(data).map(asset => [asset.id, asset]));
  const source = item.published && typeof item.published === 'object' ? item.published : (item.draft || {});
  const steps = flowSteps(source);
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
  });
  for (const subflow of source.subflows || []) {
    const current = (data.flows || []).find(flow => flow.id === subflow.id && !flow.archived && flow.lifecycleStatus !== 'deprecated');
    const latestVersion = current?.versions?.at(-1)?.number || 0;
    if (!current || latestVersion !== subflow.version) outdatedDependencies.push({
      kind: 'subflow', id: subflow.id, name: subflow.name || current?.published?.name || current?.draft?.name || subflow.id,
      publishedVersion: subflow.version, latestVersion,
    });
  }
  const uniqueOutdatedDependencies = outdatedDependencies.filter((dependency, index, all) => all.findIndex(entry => (entry.kind || 'asset') === (dependency.kind || 'asset') && (entry.id || entry.nodeId) === (dependency.id || dependency.nodeId)) === index);
  const graphMode = Boolean(source.graph?.nodes);
  const parallelNodes = graphMode ? source.graph.nodes.filter(node => node.type === 'parallel') : [];
  const presentedSteps = graphMode
    ? source.graph.nodes.filter(node => node.type === 'step').map((node, index) => ({
        order: index + 1, type: node.step.type, id: node.step.id,
        name: node.step.name || assetMap.get(node.step.id)?.name || node.step.selector?.packageName || node.step.id,
        version: node.step.version || assetMap.get(node.step.id)?.version || 0, branchName: '图节点',
      }))
    : [
        ...(source.steps || []).map((step, index) => ({
          order: index + 1, type: step.type, id: step.id,
          name: step.name || assetMap.get(step.id)?.name || step.selector?.packageName || step.id,
          version: step.version || assetMap.get(step.id)?.version || 0, branchName: null,
        })),
        ...flowBranches(source).flatMap(branch => (branch.steps || []).map((step, index) => ({
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
    branchCount: flowBranches(source).length + parallelNodes.reduce((total, node) => total + node.branches.length, 0),
    gatewayCount: flowGateways(source).length,
    parallelCount: parallelNodes.length,
    joinCount: graphMode ? source.graph.nodes.filter(node => node.type === 'join').length : 0,
    stepCount: presentedSteps.length,
    steps: presentedSteps,
    sequential: parallelNodes.length === 0,
    revision: item.revision || 1,
    status: assetWorkflowStatus(item, data.changeSets || []),
    version: item.versions.at(-1)?.number || 0,
    owner: assetOwner(item),
    ...presentedGovernance(item),
    needsRepublish: uniqueOutdatedDependencies.length > 0,
    outdatedDependencies: uniqueOutdatedDependencies,
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
    availableFlows: (data.flows || [])
      .filter(flow => flow.id !== item.id && !flow.archived && flow.lifecycleStatus !== 'deprecated' && flow.published && flow.versions?.length)
      .map(flow => ({ id: flow.id, name: flow.published.name || flow.draft.name, version: flow.versions.at(-1).number }))
      .sort((left, right) => left.name.localeCompare(right.name)),
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
    hasDraftChanges: Boolean(item.published && JSON.stringify(item.draft) !== JSON.stringify(item.published.draft)),
    package: item.draft.category || 'default',
    version: item.versions.at(-1)?.number || 0,
    bomVersion: item.versions.at(-1)?.bomVersion || null,
    revision: item.revision || 1,
    statementCount: item.draft.statements?.length || 0,
    statementLabels,
    updatedAt: item.updatedAt,
    modifiedBy: item.updatedBy || 'Team Server',
    owner: assetOwner(item),
    ...presentedGovernance(item),
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
    dependencyGraph: eventStreamDependencies(item.draft),
    validationError: compiled.error || null,
  };
}

export function eventStreamAuthoring(statements = []) {
  return statements.map(statement => ({
    name: statement.name,
    ...(statement.label ? { label: statement.label } : {}),
    ...(statement.description ? { description: statement.description } : {}),
    ...(statement.group ? { group: statement.group } : {}),
    ...(statement.mode ? { mode: statement.mode } : {}),
    ...(statement.template ? { template: statement.template } : {}),
    ...(statement.params ? { params: structuredClone(statement.params) } : {}),
  }));
}
