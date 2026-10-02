import crypto from 'node:crypto';
import { generateDrl, newRule, validateRule } from '../../shared/rules.js';
import { flowSnapshot, newFlow, newTable, tableCollectedHits, tableDrl, tableExecutionTrace, tableRules, validateFlow, validateTable } from '../../shared/assets.js';
import { advanceAssetRevision, initializeAssetRevision, normalizePackageReferences } from '../domain-utils.js';
import { bodyOf, expectedRevision, operationError, reply, revisionConflict } from '../http-utils.js';

export function createLegacyApiHandler({
  engine,
  readRules,
  readAssets,
  readPackageRecords,
  mutate,
  mutateAssets,
  appendAuditEvent,
  parseFacts,
  executeFlow,
  getCurrentBom,
}) {
  async function handleAsset(req, res, segments) {
    const kind = segments[1];
    const isTable = kind === 'tables';
    const currentBom = getCurrentBom();
    function validateTableSafe(draft) { const v = validateTable(draft, currentBom); return v.error ? v.error : null; }
    const validate = isTable ? validateTableSafe : validateFlow;
    if (segments.length === 2) {
      if (req.method === 'GET') return reply(res, 200, await readAssets(kind));
      if (req.method === 'POST') {
        const result = await mutateAssets(kind, assets => {
          const now = new Date().toISOString();
          const item = initializeAssetRevision({ id: crypto.randomUUID(), draft: isTable ? newTable() : newFlow(), published: null, versions: [], archived: false, updatedAt: now });
          assets.unshift(item);
          return { item };
        });
        await appendAuditEvent('asset.created', isTable ? 'table' : 'flow', result.item.id, `创建${isTable ? '决策表' : '规则流'}：${result.item.draft.name}`, { revision: 1 }, req);
        return reply(res, 201, result.item);
      }
    }
    if (segments.length < 3 || segments.length > 4) return reply(res, 404, { error: '未找到资源' });
    const id = segments[2];
    if (segments.length === 3 && req.method === 'PUT') {
      const payload = await bodyOf(req);
      const expected = expectedRevision(req, payload);
      if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
      const draft = normalizePackageReferences(structuredClone(payload?.draft && payload.revision != null ? payload.draft : payload));
      const rules = isTable ? null : await readRules();
      const tables = isTable ? null : await readAssets('tables');
      const packageRecords = isTable ? [] : await readPackageRecords('default', { rules, tables });
      const error = isTable ? validate(draft) : validate(draft, rules, tables, currentBom, packageRecords, { allowEmptyRuleGroups: true });
      if (error) return reply(res, 400, { error });
      const result = await mutateAssets(kind, assets => {
        const item = assets.find(asset => asset.id === id && !asset.archived);
        if (!item) return { status: 404, error: '资产不存在' };
        const conflict = revisionConflict(item, expected);
        if (conflict) return conflict;
        item.draft = draft;
        advanceAssetRevision(item, 'saved', true);
        return { item };
      });
      if (result.error) return reply(res, result.status, operationError(result));
      await appendAuditEvent('asset.saved', isTable ? 'table' : 'flow', id, `保存${isTable ? '决策表' : '规则流'}：${result.item.draft.name}`, { revision: result.item.revision }, req);
      return reply(res, 200, result.item);
    }
    if (segments.length !== 4 || req.method !== 'POST') return reply(res, 404, { error: '未找到操作' });
    const action = segments[3];
    if (action === 'test') {
      const payload = await bodyOf(req);
      const item = (await readAssets(kind)).find(asset => asset.id === id && !asset.archived);
      if (!item) return reply(res, 404, { error: '资产不存在' });
      const facts = parseFacts(payload.facts);
      if (!facts) return reply(res, 400, { error: '测试输入字段或类型无效' });
      if (isTable) {
        const table = payload.draft || item.draft;
        const v = validateTable(table, currentBom);
        if (v.error) return reply(res, 400, { error: v.error });
        const checked = await engine('/test', { drl: tableDrl(table, currentBom, item.id), facts });
        if (checked.error) return reply(res, checked.status, { error: checked.error });
        return reply(res, 200, {
          ...checked.result,
          hitPolicy: table.hitPolicy || 'ALL',
          validationWarnings: v.warnings,
          decisionTrace: tableExecutionTrace(table, checked.result.fired, currentBom),
          decisionHits: Array.isArray(checked.result.decisionHits) && checked.result.decisionHits.length ? checked.result.decisionHits : tableCollectedHits(table, checked.result.fired, currentBom),
        });
      }
      const rules = await readRules();
      const tables = await readAssets('tables');
      let flow;
      try {
        const packageRecords = await readPackageRecords('default', { rules, tables });
        flow = payload.published ? item.published : flowSnapshot(payload.draft || item.draft, rules, tables, currentBom, packageRecords);
      } catch (error) { return reply(res, 400, { error: error.message }); }
      if (!flow) return reply(res, 400, { error: '规则流尚未发布' });
      const options = {};
      if (Object.prototype.hasOwnProperty.call(payload, 'stopAfter')) options.stopAfter = payload.stopAfter;
      if (Object.prototype.hasOwnProperty.call(payload, 'expectedPath')) options.expectedPath = payload.expectedPath;
      const executed = await executeFlow(flow, facts, options);
      return reply(res, executed.status, executed.result || { error: executed.error });
    }
    if (!['publish', 'restore', 'archive'].includes(action)) return reply(res, 404, { error: '未找到操作' });
    const params = await bodyOf(req);
    const expected = expectedRevision(req, params);
    if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
    const result = await mutateAssets(kind, async assets => {
      const item = assets.find(asset => asset.id === id && !asset.archived);
      if (!item) return { status: 404, error: '资产不存在' };
      const conflict = revisionConflict(item, expected);
      if (conflict) return conflict;
      if (action === 'archive') {
        item.archived = true;
        advanceAssetRevision(item, 'saved');
      }
      else if (action === 'restore') {
        const version = item.versions.find(entry => entry.number === params.version);
        if (!version) return { status: 404, error: '版本不存在' };
        item.draft = structuredClone(version.draft);
        advanceAssetRevision(item, 'restored', true);
      } else if (isTable) {
        const v = validateTable(item.draft, currentBom);
        if (v.error) return { status: 400, error: v.error };
        const drl = tableDrl(item.draft, currentBom, item.id);
        const checked = await engine('/compile', { drl });
        if (checked.error) return { status: checked.status, error: checked.error };
        const version = {
          number: (item.versions.at(-1)?.number || 0) + 1,
          createdAt: new Date().toISOString(),
          draft: structuredClone(item.draft),
          bomVersion: currentBom.version,
          bom: structuredClone(currentBom),
          drl,
          engineVersion: checked.result.version,
        };
        item.versions.push(version);
        item.published = structuredClone(item.draft);
        advanceAssetRevision(item, 'saved');
      } else {
        const rules = await readRules();
        const tables = await readAssets('tables');
        let snapshot;
        try {
          const packageRecords = await readPackageRecords('default', { rules, tables });
          snapshot = flowSnapshot(item.draft, rules, tables, currentBom, packageRecords);
        } catch (error) { return { status: 400, error: error.message }; }
        const steps = [...snapshot.steps, ...snapshot.branches.flatMap(branch => branch.steps)];
        for (const step of steps) {
          const checked = await engine('/compile', { drl: step.drl });
          if (checked.error) return { status: checked.status, error: `${step.name}：${checked.error}` };
        }
        item.versions.push({
          number: (item.versions.at(-1)?.number || 0) + 1,
          createdAt: new Date().toISOString(),
          draft: structuredClone(item.draft),
          bomVersion: currentBom.version,
          bom: structuredClone(currentBom),
          snapshot,
        });
        item.published = snapshot;
        advanceAssetRevision(item, 'saved');
      }
      return { item };
    });
    if (result.error) return reply(res, result.status, operationError(result));
    const actionLabels = { publish: '发布', restore: '恢复', archive: '归档' };
    await appendAuditEvent(`asset.${action}`, isTable ? 'table' : 'flow', id,
      `${actionLabels[action]}${isTable ? '决策表' : '规则流'}：${result.item.draft.name}`,
      { revision: result.item.revision, version: result.item.versions.at(-1)?.number || null }, req);
    return reply(res, 200, result.item);
  }

  async function handleRules(req, res, segments, url) {
    const currentBom = getCurrentBom();
    if (req.method === 'GET' && url.pathname === '/api/rules') return reply(res, 200, await readRules());
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const rules = (await readRules()).filter(r => !r.archived && r.published).map(r => r.published);
      const tables = (await readAssets('tables')).filter(asset => !asset.archived && asset.published).flatMap(asset => tableRules(asset.published, currentBom, asset.id));
      const drl = generateDrl([...rules, ...tables], currentBom);
      res.setHeader('content-disposition', 'attachment; filename="published-rules.drl"');
      return reply(res, 200, drl, 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/rules') {
      const item = await mutate(rules => {
        const now = new Date().toISOString();
        const created = initializeAssetRevision({ id: crypto.randomUUID(), draft: newRule(), published: null, versions: [], archived: false, updatedAt: now });
        rules.unshift(created);
        return created;
      });
      await appendAuditEvent('asset.created', 'rule', item.id, `创建规则：${item.draft.name}`, { revision: 1 }, req);
      return reply(res, 201, item);
    }
    if (segments.length === 3 && segments[1] === 'rules') {
      const id = segments[2];
      if (req.method === 'PUT') {
        const payload = await bodyOf(req);
        const expected = expectedRevision(req, payload);
        if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
        const draft = normalizePackageReferences(structuredClone(payload?.draft && payload.revision != null ? payload.draft : payload));
        const error = validateRule(draft, currentBom);
        if (error) return reply(res, 400, { error });
        const item = await mutate(rules => {
          const found = rules.find(r => r.id === id && !r.archived);
          if (!found) return null;
          const conflict = revisionConflict(found, expected);
          if (conflict) return conflict;
          found.draft = draft;
          advanceAssetRevision(found, 'saved', true);
          return { item: found };
        });
        if (!item) return reply(res, 404, { error: '规则不存在' });
        if (item.error) return reply(res, item.status, operationError(item));
        await appendAuditEvent('asset.saved', 'rule', id, `保存规则：${item.item.draft.name}`, { revision: item.item.revision }, req);
        return reply(res, 200, item.item);
      }
    }
    if (segments.length === 4 && segments[1] === 'rules' && segments[3] === 'test' && req.method === 'POST') {
      const payload = await bodyOf(req);
      const current = (await readRules()).find(r => r.id === segments[2] && !r.archived);
      if (!current) return reply(res, 404, { error: '规则不存在' });
      const rule = payload.rule || current.draft;
      const error = validateRule(rule, currentBom);
      if (error) return reply(res, 400, { error });
      const facts = parseFacts(payload.facts);
      if (!facts) return reply(res, 400, { error: '测试输入字段或类型无效' });
      const checked = await engine('/test', { drl: generateDrl([rule], currentBom), facts });
      return reply(res, checked.status || 200, checked.result || { error: checked.error });
    }
    if (segments.length === 4 && segments[1] === 'rules' && req.method === 'POST') {
      const [,, id, action] = segments;
      if (!['publish', 'restore', 'archive'].includes(action)) return reply(res, 404, { error: '未找到操作' });
      const params = await bodyOf(req);
      const expected = expectedRevision(req, params);
      if (Number.isNaN(expected)) return reply(res, 400, { error: '修订号无效' });
      const result = await mutate(async rules => {
        const found = rules.find(r => r.id === id && !r.archived);
        if (!found) return { error: '规则不存在', status: 404 };
        const conflict = revisionConflict(found, expected);
        if (conflict) return conflict;
        if (action === 'archive') { found.archived = true; advanceAssetRevision(found, 'saved'); return { item: found }; }
        if (action === 'restore') {
          const version = found.versions.find(v => v.number === params.version);
          if (!version) return { error: '版本不存在', status: 404 };
          found.draft = structuredClone(version.rule);
          advanceAssetRevision(found, 'restored', true);
        } else {
          const error = validateRule(found.draft, currentBom);
          if (error) return { error, status: 400 };
          const drl = generateDrl([found.draft], currentBom);
          const checked = await engine('/compile', { drl });
          if (checked.error) return { error: checked.error, status: checked.status };
          const version = {
            number: (found.versions.at(-1)?.number || 0) + 1,
            createdAt: new Date().toISOString(),
            rule: structuredClone(found.draft),
            bomVersion: currentBom.version,
            bom: structuredClone(currentBom),
            drl,
            engineVersion: checked.result.version,
          };
          found.versions.push(version);
          found.published = structuredClone(version.rule);
          advanceAssetRevision(found, 'saved');
        }
        return { item: found };
      });
      if (result.error) return reply(res, result.status, operationError(result));
      const actionLabels = { publish: '发布', restore: '恢复', archive: '归档' };
      await appendAuditEvent(`asset.${action}`, 'rule', id, `${actionLabels[action]}规则：${result.item.draft.name}`, {
        revision: result.item.revision, version: result.item.versions.at(-1)?.number || null,
      }, req);
      return reply(res, 200, result.item);
    }
    return null;
  }

  return async function handleLegacyApi(req, res, segments, url) {
    if (['tables', 'flows'].includes(segments[1])) return handleAsset(req, res, segments);
    return handleRules(req, res, segments, url);
  };
}
