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

test('release preserves the requested semantic display version', () => {
  const asset = published('rule-semver', newRule(), 2);
  const release = buildRelease({
    id: 'release-semver',
    request: { decisionService: 'default/semver', version: '2.1.2', name: '语义版本', target: { type: 'rule', id: asset.id } },
    rules: [asset], tables: [], flows: [], releases: [],
  });
  assert.equal(release.version, 1);
  assert.equal(release.displayVersion, '2.1.2');
  assert.equal(verifyRelease(release), null);
});

test('new releases reject a flow snapshot with outdated direct dependencies', () => {
  const rule = published('rule-updated', newRule(), 2);
  const flow = published('flow-outdated', { name: '过期规则集', description: '', steps: [] }, 1);
  flow.published = {
    name: '过期规则集', description: '',
    steps: [{ type: 'rule', id: rule.id, name: rule.published.name, version: 1, drl: 'package workbench\n' }],
  };
  assert.throws(() => buildRelease({
    id: 'release-outdated',
    request: { decisionService: 'default/outdated', name: '过期构建', target: { type: 'flow', id: flow.id } },
    rules: [rule], tables: [], flows: [flow], releases: [],
    enforceCurrentFlowDependencies: true,
  }), error => error.code === 'FLOW_DEPENDENCIES_OUTDATED' && /重新发布规则集/.test(error.message));
});

test('new releases reject a flow snapshot with changed rule-group members', () => {
  const rule = newRule();
  rule.category = 'grain.rule.singlepoint';
  const asset = published('rule-group-member', rule, 2);
  const flow = published('flow-outdated-group', { name: '规则包规则集', description: '', steps: [] }, 1);
  flow.published = {
    name: '规则包规则集', description: '',
    steps: [{
      type: 'rule-group', name: '规则组：grain.rule.singlepoint', packageName: 'grain.rule.singlepoint', includeChildren: false,
      members: [{ type: 'rule', id: asset.id, name: rule.name, version: 1 }], memberFingerprint: 'outdated', drl: 'package workbench\n',
    }],
  };
  assert.throws(() => buildRelease({
    id: 'release-outdated-group',
    request: { decisionService: 'default/outdated-group', name: '过期规则包构建', target: { type: 'flow', id: flow.id } },
    rules: [asset], tables: [], flows: [flow], releases: [],
    enforceCurrentFlowDependencies: true,
  }), error => error.code === 'FLOW_DEPENDENCIES_OUTDATED' && /grain\.rule\.singlepoint/.test(error.message));
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

test('flow release freezes a chain of exclusive gateways and merge points', () => {
  const flow = published('flow-multi-routed', { name: '多级分支流', description: '', steps: [] }, 1);
  const common = index => ({ nodeId: `common-${index}`, type: 'rule', id: `common-${index}`, name: `公共规则 ${index}`, version: 1, drl: 'package workbench\n' });
  const branch = id => ({ nodeId: `node-${id}`, type: 'rule', id, name: id, version: 1, drl: 'package workbench\n' });
  flow.published = {
    name: '多级分支流', description: '', steps: [common(1), common(2)],
    gateways: [
      { id: 'g1', name: '网关一', afterStep: 1, branches: [
        { id: 'g1-yes', name: '是', condition: { field: 'creditScore', operator: '>=', value: 700 }, steps: [branch('g1-yes')] },
        { id: 'g1-no', name: '否', default: true, condition: null, steps: [branch('g1-no')] },
      ] },
      { id: 'g2', name: '网关二', afterStep: 2, branches: [
        { id: 'g2-yes', name: '是', condition: { field: 'customerAge', operator: '>=', value: 18 }, steps: [branch('g2-yes')] },
        { id: 'g2-no', name: '否', default: true, condition: null, steps: [branch('g2-no')] },
      ] },
    ],
  };
  const release = buildRelease({
    id: 'release-multi-routed',
    request: { decisionService: 'default/multi-routed', name: '多级分支发布', target: { type: 'flow', id: flow.id } },
    rules: [], tables: [], flows: [flow], releases: [],
  });
  assert.equal(release.routing.type, 'exclusive-chain');
  assert.equal(release.routing.commonStepCount, 2);
  assert.deepEqual(release.routing.gateways.map(gateway => gateway.afterStep), [1, 2]);
  assert.deepEqual(release.routing.gateways.flatMap(gateway => gateway.branches.map(branch => branch.stepIndexes)), [[2], [3], [4], [5]]);
  assert.equal(verifyRelease(release), null);
});

test('flow release freezes and verifies an exclusive DAG', () => {
  const graphStep = nodeId => ({ nodeId, type: 'rule', id: `rule-${nodeId}`, name: `规则 ${nodeId}`, version: 1, drl: 'package workbench\n' });
  const flow = published('flow-dag', { name: '图流程', description: '', steps: [] }, 1);
  flow.published = {
    name: '图流程', description: '', variables: [], steps: [],
    graph: {
      entry: 'start-step',
      nodes: [
        { id: 'start-step', type: 'step', step: graphStep('start-step'), next: 'gateway-a' },
        { id: 'gateway-a', type: 'gateway', name: '判断', branches: [
          { id: 'yes', name: '是', condition: { field: 'customerAge', operator: '>=', value: 18 }, next: 'merge-step' },
          { id: 'no', name: '否', default: true, condition: null, next: 'merge-step' },
        ] },
        { id: 'merge-step', type: 'step', step: graphStep('merge-step'), next: 'end' },
      ],
    },
  };
  const release = buildRelease({
    id: 'release-dag',
    request: { decisionService: 'default/dag', name: '图发布', target: { type: 'flow', id: flow.id } },
    rules: [], tables: [], flows: [flow], releases: [],
  });
  assert.equal(release.routing.type, 'exclusive-dag');
  assert.equal(release.steps.length, 2);
  assert.equal(verifyRelease(release), null);
  release.routing.nodes.find(node => node.id === 'merge-step').next = 'gateway-a';
  release.checksum = releaseChecksum(release);
  assert.match(verifyRelease(release), /循环|不可达/);
});

test('flow release freezes and verifies a parallel decision DAG', () => {
  const graphStep = nodeId => ({ nodeId, type: 'rule', id: `rule-${nodeId}`, name: `规则 ${nodeId}`, version: 1, drl: 'package workbench\n' });
  const flow = published('flow-parallel', { name: '并行流程', description: '', steps: [] }, 1);
  flow.published = { name: '并行流程', description: '', variables: [], steps: [], graph: { entry: 'parallel', nodes: [
    { id: 'parallel', type: 'parallel', name: '并行检查', join: 'join', branches: [{ id: 'a', name: 'A', next: 'a-step' }, { id: 'b', name: 'B', next: 'b-step' }] },
    { id: 'a-step', type: 'step', step: graphStep('a-step'), next: 'join' },
    { id: 'b-step', type: 'step', step: graphStep('b-step'), next: 'join' },
    { id: 'join', type: 'join', name: '结果聚合', next: 'end' },
  ] } };
  const release = buildRelease({
    id: 'release-parallel', request: { decisionService: 'default/parallel', name: '并行发布', target: { type: 'flow', id: flow.id } },
    rules: [], tables: [], flows: [flow], releases: [],
  });
  assert.equal(release.routing.type, 'decision-dag');
  assert.equal(verifyRelease(release), null);
  release.routing.nodes.find(node => node.id === 'b-step').next = 'end';
  release.checksum = releaseChecksum(release);
  assert.match(verifyRelease(release), /未汇入/);
});

test('flow release uses the top-level variable scope', () => {
  const variable = { name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false, enum: null, description: '流程内部变量' };
  const flow = published('flow-variable-scope', { name: '变量流', description: '', steps: [] }, 1);
  flow.published = {
    name: '变量流',
    description: '',
    variables: [variable],
    steps: [{
      type: 'rule',
      id: 'rule-a',
      name: '规则 A',
      version: 1,
      variables: [{ ...variable, defaultValue: true }],
      drl: 'package workbench\n',
    }],
  };
  const release = buildRelease({
    id: 'release-flow-variable-scope',
    request: { decisionService: 'default/flow-variable', name: '变量流发布', target: { type: 'flow', id: flow.id } },
    rules: [], tables: [], flows: [flow], releases: [],
  });
  assert.deepEqual(release.variables, [variable]);
  assert.equal(verifyRelease(release), null);
});

test('flow release applies the current Rule Project variable scope to step DRL', () => {
  const variable = { name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false, enum: null, description: '' };
  const rule = newRule();
  rule.name = '项目变量规则';
  rule.conditions = [{ fieldSource: 'variable', field: 'approved', operator: '==', value: 'true' }];
  rule.actions = [{ field: 'riskLevel', value: '低' }];
  const ruleAsset = published('rule-project-variable', rule, 2);
  const flow = published('flow-project-variable', { name: '项目变量规则集', description: '', steps: [] }, 1);
  flow.published = {
    name: '项目变量规则集',
    description: '',
    steps: [{
      type: 'rule',
      id: ruleAsset.id,
      name: rule.name,
      version: 2,
      drl: 'stale DRL without RuleContext',
    }],
  };

  const release = buildRelease({
    id: 'release-project-variable-flow',
    request: { decisionService: 'default/project-variable-flow', name: '项目变量规则集发布', target: { type: 'flow', id: flow.id } },
    rules: [ruleAsset], tables: [], flows: [flow], releases: [],
    projectVariables: [variable],
  });

  assert.deepEqual(release.variables, [variable]);
  assert.match(release.steps[0].drl, /declare RuleContext/);
  assert.doesNotMatch(release.steps[0].drl, /stale DRL/);
  assert.equal(verifyRelease(release), null);
});

test('release freezes Ruleset Variable definitions and protects them with checksum', () => {
  const rule = newRule();
  rule.variables = [{ name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false }];
  rule.conditions = [{ fieldSource: 'variable', field: 'approved', operator: '==', value: 'true' }];
  rule.actions = [{ field: 'riskLevel', value: '低' }];
  const asset = published('rule-with-variable', rule, 1);
  asset.versions[0].drl = undefined;
  const release = buildRelease({
    id: 'release-variable',
    request: { decisionService: 'default/variable', name: '变量发布', target: { type: 'rule', id: asset.id } },
    rules: [asset], tables: [], flows: [], releases: [],
  });

  assert.deepEqual(release.variables.map(variable => variable.name), ['approved']);
  assert.equal(release.variables[0].defaultValue, false);
  assert.match(release.steps[0].drl, /declare RuleContext/);
  assert.equal(verifyRelease(release), null);

  const changed = structuredClone(release);
  changed.variables[0].defaultValue = true;
  assert.match(verifyRelease(changed), /校验和/);
});
