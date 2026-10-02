import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

async function publishedRule(env, name, category = 'common') {
  const created = (await env.request('/api/projects/default/rules', 'POST', { type: 'rule', name, category })).body;
  const draft = {
    ...created.draft,
    name,
    category,
    conditions: [{ field: 'customerAge', operator: '>=', value: '18' }],
    actions: [{ field: 'riskLevel', value: '低' }],
  };
  const saved = (await env.request(`/api/projects/default/rules/${created.id}`, 'PUT', { revision: created.revision, draft })).body;
  return (await env.request(`/api/projects/default/rules/${created.id}/publish`, 'POST', { revision: saved.revision })).body;
}

test('PLATFORM-GAP-R2/R8: deprecated assets stay traceable, leave executable groups, restore to draft, and archive cleanly', async () => {
  const env = await startTestEnv();
  try {
    const retired = await publishedRule(env, '待退役规则');
    const replacement = await publishedRule(env, '替代规则');
    const deprecated = await env.request(`/api/projects/default/rules/${retired.id}/deprecate`, 'POST', {
      revision: retired.revision, reason: '由统一阈值规则替代', replacedByAssetId: replacement.id,
    });
    assert.equal(deprecated.status, 200);
    assert.equal(deprecated.body.status, 'deprecated');
    assert.equal(deprecated.body.lifecycleStatus, 'deprecated');
    assert.equal(deprecated.body.replacedByAssetId, replacement.id);

    const packages = (await env.request('/api/projects/default/packages')).body;
    assert.equal(packages.flatMap(pkg => pkg.assets).find(asset => asset.id === retired.id).status, 'deprecated');
    assert.equal((await env.request(`/api/projects/default/rules/${retired.id}`, 'PUT', {
      revision: deprecated.body.revision, draft: deprecated.body.draft,
    })).status, 409);
    assert.equal((await env.request(`/api/projects/default/rules/${retired.id}/publish`, 'POST', { revision: deprecated.body.revision })).status, 409);
    assert.equal((await env.request('/api/projects/default/releases', 'POST', {
      decisionService: 'default/deprecated', name: '废弃资产 Release', target: { type: 'rule', id: retired.id },
    })).status, 400);

    const flow = (await env.request('/api/projects/default/flows', 'POST')).body;
    const savedFlow = await env.request(`/api/projects/default/flows/${flow.id}`, 'PUT', {
      revision: flow.revision,
      draft: { ...flow.draft, name: '废弃过滤流程', steps: [{ nodeId: 'group', type: 'rule-group', selector: { packageName: 'common', includeChildren: false } }] },
    });
    const publishedFlow = await env.request(`/api/projects/default/flows/${flow.id}/publish`, 'POST', { revision: savedFlow.body.revision });
    assert.equal(publishedFlow.status, 200);
    assert.deepEqual(publishedFlow.body.availablePackages.find(pkg => pkg.name === 'common').members.map(member => member.id), [replacement.id]);

    const restored = await env.request(`/api/projects/default/rules/${retired.id}/reactivate`, 'POST', { revision: deprecated.body.revision });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.status, 'draft');
    assert.equal(restored.body.lifecycleStatus, 'active');
    assert.equal(restored.body.deprecationReason, null);

    const archived = await env.request(`/api/projects/default/rules/${retired.id}`, 'DELETE');
    assert.equal(archived.status, 200);
    assert.equal(archived.body.status, 'archived');
    assert.equal((await env.request('/api/projects/default/packages')).body.flatMap(pkg => pkg.assets).some(asset => asset.id === retired.id), false);
    assert.equal((await env.request('/api/projects/default/packages?includeArchived=true')).body.flatMap(pkg => pkg.assets).find(asset => asset.id === retired.id).status, 'archived');
    const events = (await env.request('/api/projects/default/audit-events')).body;
    assert.ok(events.some(event => event.action === 'asset.deprecated' && event.resourceId === retired.id));
    assert.ok(events.some(event => event.action === 'asset.reactivated' && event.resourceId === retired.id));
    assert.ok(events.some(event => event.action === 'asset.archived' && event.resourceId === retired.id));
  } finally { await env.stop(); }
});

test('PLATFORM-GAP-R3: decision-table cells compare compatible business fields and persist structurally', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/projects/default/rules', 'POST', {
      type: 'decision-table', name: '动态阈值表', category: 'common',
      conditionFields: ['creditScore'], actionFields: ['riskLevel'], hitPolicy: 'FIRST',
    })).body;
    const draft = structuredClone(created.draft);
    draft.rows = [{ enabled: true, priority: 0, conditions: [{ valueSource: 'field', valueField: 'customerAge' }], actions: ['高'] }];
    draft.conditions[0].operator = '>=';
    const saved = await env.request(`/api/projects/default/rules/${created.id}`, 'PUT', { revision: created.revision, draft });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.draft.rows[0].conditions[0], { valueSource: 'field', valueField: 'customerAge' });
    const analyzed = await env.request(`/api/projects/default/rules/${created.id}/analyze`, 'POST', { revision: saved.body.revision, draft: saved.body.draft });
    assert.equal(analyzed.status, 200);
    assert.match(analyzed.body.drl, /creditScore >= customerAge/);
    assert.ok(analyzed.body.warnings.some(warning => /暂不支持精确分析/.test(warning)) || analyzed.body.warnings.length === 0);

    draft.rows[0].conditions[0] = { valueSource: 'field', valueField: 'customerType' };
    const invalid = await env.request(`/api/projects/default/rules/${created.id}/analyze`, 'POST', { revision: saved.body.revision, draft });
    assert.match(invalid.body.error, /同类型/);
  } finally { await env.stop(); }
});

test('PLATFORM-GAP-R7/R10: outdated BOM failures are structured and asset detail exposes both versions', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedRule(env, 'BOM 冻结规则');
    const bom = (await env.request('/api/projects/default/bom')).body;
    const fields = bom.factTypes.flatMap(fact => fact.fields.map(field => ({
      key: field.key, label: field.label, type: field.runtimeType, semanticType: field.type,
      kind: field.direction, factType: fact.name, factTypeLabel: fact.label, group: field.group,
      unit: field.unit, min: field.min, max: field.max, enum: field.enum, control: field.control,
      required: field.required, description: field.description || '',
    })));
    fields.push({ key: 'newSignal', label: '新信号', type: 'Boolean', semanticType: 'Boolean', kind: 'input', factType: 'Borrower', factTypeLabel: '借款申请人', group: '扩展', unit: null, min: null, max: null, enum: null, control: 'boolean', required: false, description: '' });
    assert.equal((await env.request('/api/projects/default/bom', 'PUT', { version: bom.version, fields })).status, 200);

    const detail = (await env.request(`/api/projects/default/rules/${rule.id}`)).body;
    assert.equal(detail.publishedBomVersion, 1);
    assert.equal(detail.currentBomVersion, 2);
    assert.equal(detail.bomOutdated, true);

    const flow = (await env.request('/api/projects/default/flows', 'POST')).body;
    const saved = (await env.request(`/api/projects/default/flows/${flow.id}`, 'PUT', {
      revision: flow.revision, draft: { ...flow.draft, name: '过期依赖流程', steps: [{ nodeId: 'rule', type: 'rule', id: rule.id }] },
    })).body;
    const compiled = await env.request(`/api/projects/default/flows/${flow.id}/compile`, 'POST', { revision: saved.revision, draft: saved.draft });
    assert.equal(compiled.status, 400);
    assert.equal(compiled.body.code, 'ASSET_BOM_OUTDATED');
    assert.deepEqual(compiled.body.details, {
      assetId: rule.id, assetName: 'BOM 冻结规则', pinnedBomVersion: 1, currentBomVersion: 2, suggestedAction: 'republish',
    });
  } finally { await env.stop(); }
});

test('PLATFORM-GAP-R4: settle options and feedback mappings reach the active RES deployment', async () => {
  const env = await startTestEnv();
  try {
    const rule = await publishedRule(env, '多轮执行规则');
    const release = (await env.request('/api/projects/default/releases', 'POST', {
      decisionService: 'default/settle', name: '多轮 Release', target: { type: 'rule', id: rule.id },
    })).body;
    await env.request(`/api/projects/default/releases/${release.id}/deploy`, 'POST', { environment: 'local' });
    const executed = await env.request('/api/projects/default/services/settle/execute', 'POST', {
      facts: { customerAge: 20 }, settle: true, maxRounds: 6,
      feedbackMappings: [{ source: 'riskLevel', target: 'customerType' }],
    });
    assert.equal(executed.status, 200);
    assert.deepEqual(env.resCalls.at(-1).body.feedbackMappings, [{ source: 'riskLevel', target: 'customerType' }]);
    assert.equal(env.resCalls.at(-1).body.settle, true);
    assert.equal(env.resCalls.at(-1).body.maxRounds, 6);
  } finally { await env.stop(); }
});
