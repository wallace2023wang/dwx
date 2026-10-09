import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBom } from '../shared/bom.js';
import { analyzeDwxAssetPackage, buildDwxAssetPackage, DWX_ASSET_PACKAGE_FORMAT } from '../shared/dwx-asset-package.js';

function manifest() {
  return {
    format: DWX_ASSET_PACKAGE_FORMAT,
    schemaVersion: 1,
    project: { name: '贷款决策项目', version: '1.0.0' },
    packages: [{ name: 'migration', label: '迁移规则' }],
    assets: [{
      sourceId: 'rule/customer-age', type: 'bal', name: '成年客户', package: 'migration',
      draft: {
        name: 'ignored', description: '导入的 BAL 规则', category: 'ignored', priority: 10,
        conditions: [{ field: 'customerAge', operator: '>=', value: '18' }],
        actions: [{ field: 'riskLevel', value: '低' }],
      },
    }],
    rulesets: [{ sourceId: 'ruleset/eligibility', name: '准入决策服务', packages: ['migration'] }],
  };
}

test('DWX asset package normalizes aliases and previews packages, assets, and rulesets', () => {
  const preview = analyzeDwxAssetPackage(manifest(), { bom: defaultBom(), packages: [], rules: [], tables: [], flows: [] });
  assert.equal(preview.valid, true);
  assert.match(preview.checksum, /^sha256:/);
  assert.equal(preview.assets[0].type, 'rule');
  assert.equal(preview.assets[0].draft.name, '成年客户');
  assert.equal(preview.assets[0].draft.category, 'migration');
  assert.deepEqual(preview.summary, {
    packages: { create: 1, reuse: 0 },
    assets: { create: 1, skip: 0, byType: { rule: 1, 'decision-table': 0, 'decision-tree': 0, scorecard: 0, 'rule-template': 0 } },
    rulesets: { create: 1, skip: 0 },
  });
});

test('DWX asset package rejects unsupported free IRL and reports imported source ids as skips', () => {
  const unsupported = manifest();
  unsupported.assets[0].type = 'irl';
  const invalid = analyzeDwxAssetPackage(unsupported, { bom: defaultBom(), packages: [], rules: [], tables: [], flows: [] });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /自由 IRL\/DRL/);

  const imported = manifest();
  const checksum = analyzeDwxAssetPackage(imported, { bom: defaultBom(), packages: [], rules: [], tables: [], flows: [] }).checksum;
  const preview = analyzeDwxAssetPackage(imported, {
    bom: defaultBom(), packages: [{ name: 'migration' }], tables: [], flows: [],
    rules: [{ id: 'existing', draft: { name: '成年客户', category: 'migration' }, migration: { provider: 'dwx', sourceId: 'rule/customer-age', manifestChecksum: checksum } }],
  });
  assert.equal(preview.valid, true);
  assert.equal(preview.assets[0].action, 'skip');
  assert.equal(preview.assets[0].existingId, 'existing');

  imported.project.version = '1.0.1';
  const changed = analyzeDwxAssetPackage(imported, {
    bom: defaultBom(), packages: [{ name: 'migration' }], tables: [], flows: [],
    rules: [{ id: 'existing', draft: { name: '成年客户', category: 'migration' }, migration: { provider: 'dwx', sourceId: 'rule/customer-age', manifestChecksum: checksum } }],
  });
  assert.equal(changed.valid, false);
  assert.match(changed.errors[0], /不自动覆盖/);
});

test('DWX export builds a re-importable asset package and reports unsupported rulesets', () => {
  const exported = buildDwxAssetPackage({
    project: { name: '来源项目', version: 'v3.0.0' },
    packages: [{ name: 'migration', label: '迁移规则', parentId: null }],
    rules: [{ id: 'rule-1', draft: manifest().assets[0].draft, archived: false }],
    tables: [],
    flows: [
      { id: 'flow-1', draft: { name: '可移植规则集', description: '', steps: [{ type: 'rule-group', selector: { packageName: 'migration', includeChildren: true } }], gateways: [] }, archived: false },
      { id: 'flow-2', draft: { name: '复杂规则集', description: '', steps: [{ type: 'rule', id: 'rule-1' }], gateways: [] }, archived: false },
    ],
  });
  assert.equal(exported.format, DWX_ASSET_PACKAGE_FORMAT);
  assert.equal(exported.assets.length, 1);
  assert.equal(exported.rulesets.length, 1);
  assert.equal(exported.warnings.length, 1);
  const preview = analyzeDwxAssetPackage(exported, { bom: defaultBom(), packages: [], rules: [], tables: [], flows: [] });
  assert.equal(preview.valid, true);
});
