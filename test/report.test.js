import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReportData, renderProjectReport } from '../shared/report.js';
import { startTestEnv } from './helpers.js';

test('REPORT-01: 项目报告返回自包含 HTML 并过滤归档资产', async () => {
  const env = await startTestEnv();
  try {
    const response = await env.request('/api/projects/default/report');
    assert.equal(response.status, 200);
    assert.match(response.body, /项目知识资产报告/);
  } finally { await env.stop(); }
});

test('REPORT-02: 报告聚合统计 BOM、资产、测试和发布信息', () => {
  const project = { id: 'demo', name: '报告项目', description: '描述', updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'tester' };
  const data = {
    rules: [{ id: 'r1', draft: { name: '规则一', category: 'risk', priority: 5 }, versions: [{ number: 2 }], published: {} }],
    tables: [{ id: 't1', draft: { name: '表一', category: 'risk', priority: 1 }, versions: [{ number: 1 }], published: {} }],
    flows: [{ id: 'f1', draft: { name: '草稿流', steps: [{ id: 'draft-step', type: 'rule' }], branches: [] }, versions: [{ number: 1 }], published: { name: '已发布流', steps: [{ id: 'r1', type: 'rule', version: 1 }], branches: [] } }],
    releases: [{ id: 'rel-1', version: 3, decisionService: 'demo/risk', deployments: [{ environment: 'test' }] }],
    testSuites: [{ id: 'suite-1', name: '回归', target: { type: 'rule', id: 'r1' }, required: true, lastRun: { total: 2, passedCount: 1, failedCount: 1, runAt: '2026-01-01T00:00:00.000Z', coverage: { percentage: 50 } } }],
    bom: { version: 4, factTypes: [{ name: 'Borrower', label: '借款人', direction: 'input', fields: [{ key: 'age', type: 'Integer', direction: 'input' }] }] },
  };
  const packages = [{ id: 'risk', name: 'risk', label: '风控', assets: [{ id: 'r1', name: '规则一', type: 'rule', status: 'published', version: '2' }, { id: 't1', name: '表一', type: 'decision-table', status: 'draft', version: '1' }] }];
  const report = aggregateReportData(project, data, packages, 'tester');
  assert.deepEqual(report.overview, {
    assetCount: 2, ruleCount: 1, tableCount: 1, packageCount: 1,
    factTypeCount: 1, fieldCount: 1, testPassRate: 0, releaseVersion: 3,
    environmentCount: 1, environments: ['test'], updatedAt: project.updatedAt, updatedBy: 'tester',
  });
  assert.equal(report.tests[0].passRate, 50);
  assert.equal(report.flows[0].stepCount, 1);
  assert.equal(report.flows[0].name, '已发布流');
  assert.equal(report.assets[0].assets[0].priority, 5);
  assert.match(renderProjectReport(project, data, packages, 'tester'), /项目知识资产报告/);
});

test('REPORT-03: HTML 报告转义用户输入', () => {
  const html = renderProjectReport(
    { id: 'x', name: '<script>alert(1)</script>', description: '" onclick="bad', updatedAt: null, updatedBy: '<b>bad</b>' },
    { rules: [], tables: [], flows: [], releases: [], testSuites: [], bom: { version: 1, factTypes: [] } }, [], '<img src=x>',
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /<img src=x>/);
});

test('REPORT-04: 事件流报告展示语句业务元数据', () => {
  const project = { id: 'cep-demo', name: 'CEP 项目', description: '', updatedAt: null, updatedBy: 'tester' };
  const data = {
    rules: [], tables: [], flows: [], releases: [], testSuites: [],
    bom: { version: 1, factTypes: [] },
    eventStreams: [{
      id: 'es-1',
      draft: {
        name: '氨气事件流',
        statements: [{
          name: 'NH3HighAlarm',
          label: '氨气超限',
          description: '超过 25ppm 时告警',
          mode: 'guided',
          template: 'single-threshold',
          epl: 'insert into NH3HighAlarmEvent select * from NH3Reading where ammoniaPpm >= 25',
        }],
      },
      versions: [{ number: 2 }],
      published: null,
    }],
  };
  const report = aggregateReportData(project, data, [], 'tester');
  assert.equal(report.eventStreams[0].statements[0].label, '氨气超限');
  assert.equal(report.eventStreams[0].statements[0].templateLabel, '单点阈值');
  const html = renderProjectReport(project, data, [], 'tester');
  assert.match(html, /事件流检测明细/);
  assert.match(html, /氨气超限/);
  assert.match(html, /单点阈值/);
});

test('REPORT-05: 项目报告统计多级排他网关的所有分支步骤', () => {
  const report = aggregateReportData(
    { id: 'flow-demo', name: '编排项目' },
    {
      rules: [], tables: [], releases: [], testSuites: [],
      bom: { version: 1, factTypes: [] },
      flows: [{
        id: 'flow-1', versions: [{ number: 1 }],
        published: {
          name: '多级风控',
          steps: [{ id: 'common-1', type: 'rule' }],
          gateways: [
            { id: 'g1', name: '准入网关', afterStep: 0, branches: [{ id: 'b1', name: '通过', steps: [{ id: 'branch-1', type: 'rule' }] }] },
            { id: 'g2', name: '复核网关', afterStep: 1, branches: [{ id: 'b2', name: '人工', steps: [{ id: 'branch-2', type: 'table' }] }] },
          ],
        },
      }],
    },
  );
  assert.equal(report.flows[0].branchCount, 2);
  assert.equal(report.flows[0].stepCount, 3);
  assert.deepEqual(report.flows[0].steps.map(step => step.branchName), [null, '准入网关 / 通过', '复核网关 / 人工']);
});

test('REPORT-06: 项目报告统计 DAG 网关、分支和图步骤', () => {
  const report = aggregateReportData(
    { id: 'dag-demo', name: 'DAG 项目' },
    {
      rules: [], tables: [], releases: [], testSuites: [],
      bom: { version: 1, factTypes: [] },
      flows: [{
        id: 'flow-dag', versions: [{ number: 1 }],
        published: {
          name: '嵌套流程', steps: [],
          graph: { entry: 'entry', nodes: [
            { id: 'entry', type: 'step', step: { id: 'rule-a', type: 'rule', version: 1 }, next: 'gateway' },
            { id: 'gateway', type: 'gateway', name: '判断', branches: [
              { id: 'yes', name: '是', condition: { field: 'score', operator: '>=', value: 60 }, next: 'merge' },
              { id: 'no', name: '否', default: true, next: 'merge' },
            ] },
            { id: 'merge', type: 'step', step: { id: 'rule-b', type: 'rule', version: 2 }, next: 'end' },
          ] },
        },
      }],
    },
  );
  assert.equal(report.flows[0].branchCount, 2);
  assert.equal(report.flows[0].stepCount, 2);
  assert.deepEqual(report.flows[0].steps.map(step => step.branchName), ['图节点', '图节点']);
});

test('REPORT-07: 项目报告统计并行分支和聚合节点', () => {
  const report = aggregateReportData(
    { id: 'parallel-demo', name: '并行项目' },
    { rules: [], tables: [], releases: [], testSuites: [], bom: { version: 1, factTypes: [] }, flows: [{
      id: 'parallel-flow', versions: [{ number: 1 }], published: { name: '并行流程', steps: [], graph: { entry: 'parallel', nodes: [
        { id: 'parallel', type: 'parallel', name: '并行检查', join: 'join', branches: [{ id: 'a', name: 'A', next: 'a-step' }, { id: 'b', name: 'B', next: 'b-step' }] },
        { id: 'a-step', type: 'step', step: { id: 'a', type: 'rule', version: 1 }, next: 'join' },
        { id: 'b-step', type: 'step', step: { id: 'b', type: 'rule', version: 1 }, next: 'join' },
        { id: 'join', type: 'join', name: '聚合', next: 'end' },
      ] } },
    }] },
  );
  assert.equal(report.flows[0].branchCount, 2);
  assert.equal(report.flows[0].parallelCount, 1);
  assert.equal(report.flows[0].joinCount, 1);
});

test('REPORT-08: 项目报告显示高级决策资产类型', () => {
  const packages = [{ id: 'advanced', name: 'advanced', label: '高级决策', assets: [
    { id: 'tree', name: '准入分支', type: 'decision-tree', status: 'published', version: '1' },
    { id: 'scorecard', name: '授信评分', type: 'scorecard', status: 'published', version: '1' },
    { id: 'template', name: '年龄变体', type: 'rule-template', status: 'draft', version: '1' },
  ] }];
  const html = renderProjectReport(
    { id: 'advanced', name: '高级决策项目' },
    { rules: [], tables: [], flows: [], releases: [], testSuites: [], bom: { version: 1, factTypes: [] } },
    packages,
    'tester',
  );
  assert.match(html, />决策树</);
  assert.match(html, />计分卡</);
  assert.match(html, />规则模板</);
});
