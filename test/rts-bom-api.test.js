// RTS 模块 2：BOM / 业务词汇管理
// 对标 传统规则平台 RTS：BOM 编辑、字段校验、影响分析、与规则/决策表联动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

test('RTS-BOM-01: 首次启动自动初始化默认 BOM', async () => {
  const env = await startTestEnv();
  try {
    const res = await env.request('/api/bom');
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 1);
    assert.ok(res.body.fields.length >= 8);
    assert.ok(res.body.fields.some(f => f.key === 'customerAge' && f.type === 'Integer'));
    assert.ok(res.body.fields.some(f => f.key === 'riskLevel' && f.kind === 'output'));
    assert.ok(res.body.fields.every(f => f.factType && f.factTypeLabel && f.semanticType));
  } finally { await env.stop(); }
});

test('RTS-BOM-02: PUT 更新 BOM 后版本递增，新字段在规则条件中可用', async () => {
  const env = await startTestEnv();
  try {
    const before = (await env.request('/api/bom')).body;
    const newField = {
      key: 'occupation', label: '职业', type: 'String', kind: 'input',
      group: '客户', unit: null, min: null, max: null, enum: null, control: 'text', description: '',
    };
    const updated = await env.request('/api/bom', 'PUT', { fields: [...before.fields, newField] });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.bom.version, 2);
    assert.ok(updated.body.bom.fields.some(f => f.key === 'occupation'));

    // 新规则可以引用新字段
    const rule = (await env.request('/api/rules', 'POST')).body;
    const draft = {
      ...rule.draft,
      conditions: [{ field: 'occupation', operator: '==', value: '教师' }],
      actions: [{ field: 'riskLevel', value: '低' }],
    };
    const saved = await env.request(`/api/rules/${rule.id}`, 'PUT', draft);
    assert.equal(saved.status, 200);
  } finally { await env.stop(); }
});

test('RTS-BOM-03: 删除被已发布规则引用的字段被拒绝', async () => {
  const env = await startTestEnv();
  try {
    // 先发布一条引用了 creditScore 的规则
    const rule = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${rule.id}/publish`, 'POST');

    // 尝试删除 creditScore 字段
    const bom = (await env.request('/api/bom')).body;
    const reduced = bom.fields.filter(f => f.key !== 'creditScore');
    const result = await env.request('/api/bom', 'PUT', { fields: reduced });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /信用评分.*不能删除/);
  } finally { await env.stop(); }
});

test('RTS-BOM-04: BOM 类型变更返回警告但不阻止保存', async () => {
  const env = await startTestEnv();
  try {
    const bom = (await env.request('/api/bom')).body;
    const mutated = bom.fields.map(f => f.key === 'overdue' ? { ...f, type: 'String', semanticType: 'String', control: 'text' } : f);
    const result = await env.request('/api/bom', 'PUT', { fields: mutated });
    assert.equal(result.status, 200);
    assert.ok(result.body.warnings.some(w => /类型由 Boolean 变更为 String/.test(w)));
  } finally { await env.stop(); }
});

test('RTS-BOM-05: 非法 BOM 被拒绝（重复 key、错误类型、缺 input 字段）', async () => {
  const env = await startTestEnv();
  try {
    const bom = (await env.request('/api/bom')).body;
    // 重复 key
    const dup = structuredClone(bom.fields);
    dup.push({ ...dup[0] });
    const r1 = await env.request('/api/bom', 'PUT', { fields: dup });
    assert.equal(r1.status, 400);
    assert.match(r1.body.error, /重复/);

    // 错误类型
    const badType = bom.fields.map(f => f.key === 'overdue' ? { ...f, type: 'Date' } : f);
    const r2 = await env.request('/api/bom', 'PUT', { fields: badType });
    assert.equal(r2.status, 400);
    assert.match(r2.body.error, /类型/);

    // 删掉所有 input 字段
    const noInput = bom.fields.filter(f => f.kind !== 'input');
    const r3 = await env.request('/api/bom', 'PUT', { fields: noInput });
    assert.equal(r3.status, 400);
    assert.match(r3.body.error, /input/);
  } finally { await env.stop(); }
});

test('RTS-BOM-06: 枚举字段值不在 BOM 枚举列表内时规则保存被拒', async () => {
  const env = await startTestEnv();
  try {
    // 默认 BOM 中 riskLevel 枚举是 [低,中,高]
    const rule = (await env.request('/api/rules', 'POST')).body;
    const bad = { ...rule.draft, actions: [{ field: 'riskLevel', value: '极高' }] };
    const result = await env.request(`/api/rules/${rule.id}`, 'PUT', bad);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /风险等级/);
  } finally { await env.stop(); }
});

test('RTS-BOM-07: 数值范围 min/max 被执行（creditScore min=300）', async () => {
  const env = await startTestEnv();
  try {
    // 默认 BOM 中 creditScore min=300
    const rule = (await env.request('/api/rules', 'POST')).body;
    const bad = {
      ...rule.draft,
      conditions: [{ field: 'creditScore', operator: '>=', value: '100' }],
      actions: [{ field: 'riskLevel', value: '低' }],
    };
    const result = await env.request(`/api/rules/${rule.id}`, 'PUT', bad);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /信用评分/);
  } finally { await env.stop(); }
});

test('RTS-BOM-08: PUT 接受纯 fields 数组作为请求体', async () => {
  const env = await startTestEnv();
  try {
    const before = (await env.request('/api/bom')).body;
    // 直接传数组，不带 wrapper
    const result = await env.request('/api/bom', 'PUT', before.fields);
    assert.equal(result.status, 200);
    assert.equal(result.body.bom.version, 2);
  } finally { await env.stop(); }
});

test('RTS-BOM-09: 字段引用接口返回规则、决策表和规则集资产', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    const references = await env.request(`/api/bom/references?field=${rule.draft.conditions[0].field}`);
    assert.equal(references.status, 200);
    assert.ok(references.body.some(item => item.id === rule.id && item.type === 'rule' && item.status === 'draft'));
  } finally { await env.stop(); }
});

test('RTS-BOM-10: 已确认影响时允许删除被引用字段，未确认仍拒绝', async () => {
  const env = await startTestEnv();
  try {
    const rule = (await env.request('/api/rules', 'POST')).body;
    const bom = (await env.request('/api/bom')).body;
    const referencedKey = rule.draft.conditions[0].field;
    const fields = bom.fields.filter(field => field.key !== referencedKey);

    const blocked = await env.request('/api/bom', 'PUT', { version: bom.version, fields });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /不能删除/);

    const acknowledged = await env.request('/api/bom', 'PUT', { version: bom.version, fields, acknowledgeImpact: true });
    assert.equal(acknowledged.status, 200);
    assert.ok(acknowledged.body.warnings.some(warning => warning.includes(referencedKey)));
    assert.ok(!acknowledged.body.bom.fields.some(field => field.key === referencedKey));
  } finally { await env.stop(); }
});
