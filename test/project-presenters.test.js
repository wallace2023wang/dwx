import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAssetDetail, projectPackages } from '../server/project-presenters.js';
import { defaultBom } from '../shared/bom.js';
import { newRule } from '../shared/rules.js';

function listBom() {
  const bom = defaultBom();
  bom.fields.push({
    key: 'listValue',
    label: '标签列表',
    type: 'String',
    semanticType: 'List<String>',
    kind: 'input',
    enum: null,
  });
  return bom;
}

function ruleItem(operator = '==', revision = 1) {
  return {
    id: 'legacy-list-rule',
    revision,
    updatedAt: '2026-10-10T00:00:00.000Z',
    archived: false,
    published: null,
    versions: [],
    revisions: [],
    draft: {
      ...newRule(),
      name: '旧版列表规则',
      conditions: [{ field: 'listValue', operator, value: '高风险' }],
    },
  };
}

test('rule presentation flags persisted legacy list equality while returning a safe editable migration', () => {
  const bom = listBom();
  const item = ruleItem();

  const packages = projectPackages([item], [], [], bom);
  const summary = packages.flatMap(pkg => pkg.assets).find(asset => asset.id === item.id);
  assert.equal(summary.bomInvalid, true);
  assert.equal(summary.bomIssue, '标签列表不支持 == 操作符');

  const detail = projectAssetDetail(item, 'rule', bom);
  assert.equal(detail.bomInvalid, true);
  assert.equal(detail.bomIssue, '标签列表不支持 == 操作符');
  assert.equal(detail.draft.conditions[0].operator, 'contains');
  assert.deepEqual(detail.migrationWarnings, ['标签列表：== 已转换为 contains']);
  assert.match(detail.content, /listValue != null && listValue\.contains\("高风险"\)/);
  assert.equal(item.draft.conditions[0].operator, '==');
});

test('rule presentation becomes BOM-valid after the migrated draft is persisted', () => {
  const bom = listBom();
  const item = ruleItem('contains', 2);

  const summary = projectPackages([item], [], [], bom)
    .flatMap(pkg => pkg.assets)
    .find(asset => asset.id === item.id);
  const detail = projectAssetDetail(item, 'rule', bom);

  assert.equal(summary.bomInvalid, false);
  assert.equal(summary.bomIssue, undefined);
  assert.equal(detail.bomInvalid, false);
  assert.deepEqual(detail.migrationWarnings, []);
  assert.equal(detail.draft.conditions[0].operator, 'contains');
  assert.match(detail.content, /listValue != null && listValue\.contains\("高风险"\)/);
});
