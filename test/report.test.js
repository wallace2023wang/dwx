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
