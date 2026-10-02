import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChangeSetReferences, snapshotChangeItem, structuredDiff, summarizeDiff, validateChangeSet } from '../shared/changes.js';

test('结构化差异按对象字段和稳定数组 ID 定位变化', () => {
  const before = { name: '旧规则', conditions: [{ id: 'age', field: 'customerAge', value: '18' }] };
  const after = { name: '新规则', conditions: [{ id: 'age', field: 'customerAge', value: '21' }, { id: 'score', field: 'creditScore', value: '600' }] };
  const changes = structuredDiff(before, after);
  assert.deepEqual(changes.map(change => [change.path, change.kind]), [
    ['conditions[age].value', 'changed'],
    ['conditions[score]', 'added'],
    ['name', 'changed'],
  ]);
  assert.deepEqual(summarizeDiff(changes), { added: 1, removed: 0, changed: 2 });
});

test('变更项固定当前草稿、基线版本和资产修订', () => {
  const asset = {
    id: 'rule-1', revision: 4,
    draft: { name: '当前草稿', priority: 20 },
    versions: [{ number: 2, rule: { name: '已发布', priority: 10 } }],
  };
  const item = snapshotChangeItem('rule', asset);
  asset.draft.name = '后续修改';
  assert.equal(item.assetRevision, 4);
  assert.equal(item.baseVersion, 2);
  assert.equal(item.after.name, '当前草稿');
  assert.equal(item.summary.changed, 2);
});

test('没有发布基线的资产整体标记为新增', () => {
  const item = snapshotChangeItem('table', { id: 'table-new', revision: 1, draft: { name: '新决策表', rows: [] }, versions: [] });
  assert.equal(item.baseVersion, null);
  assert.deepEqual(item.summary, { added: 1, removed: 0, changed: 0 });
  assert.equal(item.changes[0].path, '$');
});

test('变更集校验拒绝重复资产和非法状态输入', () => {
  assert.equal(validateChangeSet({ name: '', items: [] }), '变更集名称长度应为 1-100 个字符');
  assert.equal(validateChangeSet({ name: '测试', items: [{ type: 'rule', id: 'one' }, { type: 'rule', id: 'one' }] }), '同一资产不能重复加入变更集');
  assert.equal(validateChangeSet({ name: '测试', description: '', items: [{ type: 'table', id: 'one' }] }), null);
  assert.equal(validateChangeSet({ name: '别名', items: [{ kind: 'decision-table', id: 'one' }] }), null);
  assert.deepEqual(normalizeChangeSetReferences([{ kind: 'decision-table', id: 'one' }]), [{ kind: 'decision-table', type: 'table', id: 'one' }]);
});
