import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelease, releaseChecksum, verifyRelease } from '../shared/releases.js';
import { newRule } from '../shared/rules.js';
import { newTable } from '../shared/assets.js';

function published(id, draft, version = 1) {
  return {
    id,
    draft: structuredClone(draft),
    published: structuredClone(draft),
    versions: [{ number: version }],
    archived: false,
  };
}

test('release is built from published snapshot and has a stable checksum', () => {
  const rule = newRule();
  rule.name = '已发布规则';
  const asset = published('rule-1', rule, 4);
  asset.draft.name = '未发布草稿名称';
  const release = buildRelease({
    id: 'release-1',
    request: {
      decisionService: 'default/customer-risk',
      name: '客户风险决策',
      description: '测试发布',
      target: { type: 'rule', id: asset.id },
    },
    rules: [asset], tables: [], flows: [], releases: [],
    createdAt: '2026-09-29T00:00:00.000Z',
  });

  assert.equal(release.version, 1);
  assert.equal(release.target.assetVersion, 4);
  assert.equal(release.model.version, 1);
  assert.match(release.steps[0].drl, /已发布规则/);
  assert.doesNotMatch(release.steps[0].drl, /未发布草稿名称/);
  assert.equal(release.checksum, releaseChecksum(release));
  assert.equal(verifyRelease(release), null);

  const reordered = {
    ...release,
    engine: { drools: release.engine.drools, type: release.engine.type },
  };
  assert.equal(releaseChecksum(reordered), release.checksum);
  reordered.steps = [{ ...reordered.steps[0], drl: `${reordered.steps[0].drl}\n` }];
  assert.match(verifyRelease(reordered), /校验和/);
});

test('release checksum protects the pinned BOM while legacy releases remain verifiable', () => {
  const asset = published('rule-model', newRule());
  const release = buildRelease({
    id: 'release-model',
    request: { decisionService: 'default/model', name: '模型快照', target: { type: 'rule', id: asset.id } },
    rules: [asset], tables: [], flows: [], releases: [],
  });
  const changed = structuredClone(release);
  changed.model.fields[0].label = '被篡改';
  assert.match(verifyRelease(changed), /校验和/);

  const legacy = structuredClone(release);
  delete legacy.model;
  legacy.checksum = releaseChecksum(legacy);
  assert.equal(verifyRelease(legacy), null);
});

test('release versions increase per decision service and flow steps stay frozen', () => {
  const flow = published('flow-1', { name: '风控流', description: '', steps: [] }, 3);
  flow.published = {
    name: '风控流', description: '',
    steps: [{ type: 'rule', id: 'rule-1', name: '规则 A', version: 7, drl: 'package workbench\n' }],
  };
  const release = buildRelease({
    id: 'release-2',
    request: { decisionService: 'default/customer-risk', name: '风控流发布', target: { type: 'flow', id: flow.id } },
    rules: [], tables: [], flows: [flow],
    releases: [{ decisionService: 'default/customer-risk', version: 5 }],
  });
  assert.equal(release.version, 6);
  assert.deepEqual(release.steps[0], {
    name: '规则 A', type: 'rule', assetId: 'rule-1', assetVersion: 7, drl: 'package workbench\n',
  });
});

test('table release isolates FIRST hit policy with the asset id', () => {
  const table = newTable();
  table.hitPolicy = 'FIRST';
  const asset = published('table-asset-1', table, 2);
  const release = buildRelease({
    id: 'release-table',
    request: { decisionService: 'default/table-risk', name: '决策表发布', target: { type: 'table', id: asset.id } },
    rules: [], tables: [asset], flows: [], releases: [],
  });
  assert.match(release.steps[0].drl, /activation-group "decision-table:table-asset-1"/);
});

test('flow release freezes exclusive gateway routes into step indexes', () => {
  const flow = published('flow-routed', { name: '分支流', description: '', steps: [] }, 2);
  flow.published = {
    name: '分支流', description: '',
    steps: [{ type: 'rule', id: 'common', name: '公共规则', version: 1, drl: 'package workbench\n' }],
    branches: [
      { id: 'approved', name: '通过', default: false, condition: { field: 'creditScore', operator: '>=', value: 700 }, steps: [{ type: 'rule', id: 'yes', name: '通过规则', version: 2, drl: 'package workbench\n', inputMappings: [{ source: 'approvedLimit', target: 'annualIncome' }] }] },
      { id: 'fallback', name: '默认', default: true, condition: null, steps: [{ type: 'rule', id: 'no', name: '拒绝规则', version: 3, drl: 'package workbench\n' }] },
    ],
  };
  const release = buildRelease({
    id: 'release-routed',
    request: { decisionService: 'default/routed', name: '分支发布', target: { type: 'flow', id: flow.id } },
    rules: [], tables: [], flows: [flow], releases: [],
  });
  assert.equal(release.steps.length, 3);
  assert.equal(release.routing.afterStep, 1);
  assert.deepEqual(release.routing.branches.map(branch => branch.stepIndexes), [[1], [2]]);
  assert.deepEqual(release.steps[1].inputMappings, [{ source: 'approvedLimit', target: 'annualIncome' }]);
  assert.equal(verifyRelease(release), null);
  const invalidMapping = structuredClone(release);
  invalidMapping.steps[1].inputMappings[0].source = 'riskLevel';
  invalidMapping.checksum = releaseChecksum(invalidMapping);
  assert.match(verifyRelease(invalidMapping), /字段映射/);
  release.routing.branches[0].stepIndexes = [2];
  assert.match(verifyRelease(release), /步骤索引|不完整/);
});
