import { diffBom, validateBom } from '../../shared/bom.js';
import { flowBranches, flowSteps } from '../../shared/assets.js';
import { isDecisionTree } from '../../shared/decision-trees.js';
import { isRuleTemplate } from '../../shared/rule-templates.js';
import { ruleConditions } from '../../shared/rules.js';
import { isScorecard } from '../../shared/scorecards.js';
import { StorageConflictError } from '../postgres-store.js';
import { bodyOf, expectedRevision, reply } from '../http-utils.js';

function normalizeIncomingBom(body, current) {
  const hasEventTypes = body && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'eventTypes');
  const hasDomains = body && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'domains');
  const hasMethods = body && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'methods');
  const fields = Array.isArray(body?.fields) ? body.fields : body;
  return {
    fields,
    eventTypes: hasEventTypes ? body.eventTypes : (current.eventTypes || []),
    domains: hasDomains ? body.domains : (current.domains || []),
    methods: hasMethods ? body.methods : (current.methods || []),
  };
}

export function createBomHandlers({
  getCurrentBom,
  setCurrentBom,
  getPostgresStore,
  readBom,
  readRules,
  readAssets,
  collectUsedKeys,
  writeBom,
  appendAuditEvent,
}) {
  async function bomFieldReferences(fieldKey, projectId = 'default') {
    const [rules, tables, flows] = await Promise.all([readRules(projectId), readAssets('tables', projectId), readAssets('flows', projectId)]);
    const bom = projectId === 'default' ? getCurrentBom() : await readBom(projectId);
    const references = [];
    const add = (item, type, used) => {
      if (!used || references.some(reference => reference.id === item.id && reference.type === type)) return;
      references.push({
        id: item.id,
        name: item.draft?.name || item.id,
        type,
        status: item.published ? 'published' : 'draft',
      });
    };
    const expressionUses = (node, key, bom) => {
      if (!node || typeof node !== 'object') return false;
      if (node.type === 'field') return node.fieldSource !== 'variable' && node.field === key;
      if (node.type === 'binary') return expressionUses(node.left, key, bom) || expressionUses(node.right, key, bom);
      if (node.type === 'function') return node.args?.some(argument => expressionUses(argument, key, bom));
      if (node.type === 'method') return expressionUses((bom.methods || []).find(method => method.name === node.name)?.expression, key, bom);
      return false;
    };
    for (const item of rules.filter(rule => !rule.archived)) {
      const used = [...ruleConditions(item.draft || {}), ...(item.draft?.actions || [])]
        .some(entry => entry.field === fieldKey || (entry.valueSource === 'field' && entry.valueField === fieldKey) || expressionUses(entry.valueExpression, fieldKey, bom));
      add(item, 'rule', used);
    }
    for (const item of tables.filter(table => !table.archived)) {
      const draft = item.draft || {};
      if (isRuleTemplate(draft)) {
        const used = [...(draft.blueprint?.conditions || []), ...(draft.blueprint?.actions || [])]
          .some(entry => entry.field === fieldKey);
        add(item, 'rule-template', used);
        continue;
      }
      if (isScorecard(draft)) {
        const used = draft.scoreOutputField === fieldKey
          || (draft.characteristics || []).some(characteristic => characteristic.field === fieldKey)
          || (draft.bands || []).some(band => (band.actions || []).some(action => action.field === fieldKey || expressionUses(action.valueExpression, fieldKey, bom)));
        add(item, 'scorecard', used);
        continue;
      }
      if (isDecisionTree(draft)) {
        const nodeUses = node => {
          if (!node) return false;
          if (node.type === 'condition') {
            return node.condition?.field === fieldKey
              || (node.condition?.valueSource === 'field' && node.condition.valueField === fieldKey)
              || nodeUses(node.trueChild)
              || nodeUses(node.falseChild);
          }
          return (node.actions || []).some(action => action.field === fieldKey || expressionUses(action.valueExpression, fieldKey, bom));
        };
        add(item, 'decision-tree', nodeUses(draft.root));
        continue;
      }
      const used = [...(draft.conditions || []), ...(draft.actions || [])].some(entry => entry.field === fieldKey)
        || (draft.rows || []).some(row => (row.conditions || []).some(cell => cell?.valueSource === 'field' && cell.valueField === fieldKey));
      add(item, 'decision-table', used);
    }
    for (const item of flows.filter(flow => !flow.archived)) {
      const branches = flowBranches(item.draft);
      const steps = flowSteps(item.draft);
      const mappings = steps.flatMap(step => [...(step.inputMappings || []), ...(step.outputMappings || [])]);
      const branchUses = branches.some(branch => !branch.default && branch.condition?.field === fieldKey);
      add(item, 'flow', branchUses || mappings.some(mapping => mapping.source === fieldKey || mapping.target === fieldKey));
    }
    return references;
  }

  async function handleBom(req, res, segments, url) {
    const currentBom = getCurrentBom();
    if (req.method === 'GET' && segments.length === 3 && segments[2] === 'references') {
      const fieldKey = url.searchParams.get('field');
      if (!fieldKey) return reply(res, 400, { error: '缺少字段 key' });
      return reply(res, 200, await bomFieldReferences(fieldKey));
    }
    if (req.method === 'GET') return reply(res, 200, currentBom);
    if (req.method !== 'PUT') return reply(res, 405, { error: 'Method not allowed' });
    const body = await bodyOf(req);
    const expected = expectedRevision(req, { revision: body?.version });
    if (Number.isNaN(expected)) return reply(res, 400, { error: '字段模型版本无效' });
    if (expected != null && expected !== currentBom.version) return reply(res, 409, {
      error: '字段模型已被其他用户修改，请刷新后重试', currentRevision: currentBom.version, current: currentBom,
    });
    const incoming = normalizeIncomingBom(body, currentBom);
    const validation = validateBom(incoming);
    if (validation) return reply(res, 400, { error: validation });
    const used = await collectUsedKeys();
    const { errors, warnings } = diffBom(currentBom, incoming, used);
    if (errors.length && body?.acknowledgeImpact !== true) return reply(res, 400, { error: errors[0], warnings: [...errors, ...warnings] });
    const acknowledgedWarnings = errors.length ? [...errors, ...warnings] : warnings;
    const next = {
      version: (currentBom.version || 0) + 1,
      updatedAt: new Date().toISOString(),
      fields: incoming.fields,
      eventTypes: incoming.eventTypes || [],
      domains: incoming.domains || [],
      methods: incoming.methods || [],
    };
    try {
      await writeBom(next, currentBom.version);
    } catch (error) {
      const postgresStore = getPostgresStore();
      if (!(error instanceof StorageConflictError) || !postgresStore) throw error;
      const latest = await postgresStore.getBom();
      setCurrentBom(latest);
      return reply(res, 409, {
        error: '字段模型已被其他用户修改，请刷新后重试',
        currentRevision: latest.version,
        current: latest,
      });
    }
    setCurrentBom(next);
    await appendAuditEvent('bom.updated', 'bom', 'default', `更新字段模型到 v${next.version}`, { version: next.version, warnings: acknowledgedWarnings }, req);
    return reply(res, 200, { bom: next, warnings: acknowledgedWarnings });
  }

  async function updateProjectBom(req, res, projectId, bom) {
    const body = await bodyOf(req);
    const expected = expectedRevision(req, { revision: body?.version });
    if (Number.isNaN(expected)) return reply(res, 400, { error: '字段模型版本无效' });
    if (expected != null && expected !== bom.version) return reply(res, 409, {
      error: '字段模型已被其他用户修改，请刷新后重试', currentRevision: bom.version, current: bom,
    });
    const incoming = normalizeIncomingBom(body, bom);
    const validation = validateBom(incoming);
    if (validation) return reply(res, 400, { error: validation });
    const used = await collectUsedKeys(projectId);
    const { errors, warnings } = diffBom(bom, incoming, used);
    if (errors.length && body?.acknowledgeImpact !== true) return reply(res, 400, { error: errors[0], warnings: [...errors, ...warnings] });
    const acknowledgedWarnings = errors.length ? [...errors, ...warnings] : warnings;
    const next = { version: (bom.version || 0) + 1, updatedAt: new Date().toISOString(), fields: incoming.fields, eventTypes: incoming.eventTypes || [], domains: incoming.domains || [], methods: incoming.methods || [] };
    await writeBom(next, bom.version, projectId);
    if (projectId === 'default') setCurrentBom(next);
    await appendAuditEvent('bom.updated', 'bom', projectId, `更新字段模型到 v${next.version}`, { version: next.version, warnings: acknowledgedWarnings }, req);
    return reply(res, 200, { bom: next, warnings: acknowledgedWarnings });
  }

  return { bomFieldReferences, handleBom, updateProjectBom };
}
