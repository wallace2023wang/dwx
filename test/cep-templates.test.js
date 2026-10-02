import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CEP_TEMPLATES, buildCepTemplate, normalizeCepOperator, renderCepTemplateDescription } from '../shared/cep-templates.js';
import { compileEventStreamDraft } from '../shared/event-streams.js';

const bom = {
  version: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  fields: [
    { key: 'eventId', label: '事件 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样', group: '事件' },
    { key: 'warehouseId', label: '粮仓 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样', group: '事件' },
    { key: 'sensorId', label: '传感器 ID', type: 'String', semanticType: 'String', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样', group: '事件' },
    { key: 'sampledAt', label: '采样时间', type: 'String', semanticType: 'Date', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样', group: '事件' },
    { key: 'ammoniaPpm', label: '氨气浓度', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样', group: '监测' },
    { key: 'leakagePpm', label: '泄漏量', type: 'Double', semanticType: 'Decimal', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样', group: '监测' },
    { key: 'alertRequired', label: '需要告警', type: 'Boolean', semanticType: 'Boolean', kind: 'output', factType: 'NH3Alert', factTypeLabel: '氨气告警', group: '输出' },
  ],
  eventTypes: [{
    name: 'NH3Reading', label: '氨气采样事件', version: 1,
    keyField: 'warehouseId', timeField: 'sampledAt', sourceField: 'sensorId', duplicateKey: ['eventId'],
    fields: [
      { field: 'eventId', required: true },
      { field: 'warehouseId', required: true },
      { field: 'sensorId', required: true },
      { field: 'sampledAt', required: true },
      { field: 'ammoniaPpm', required: true },
      { field: 'leakagePpm', required: false },
    ],
  }],
};

const cases = [
  ['single-threshold', { statementName: 'NH3HighAlarm', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '≥', value: 25 }],
  ['window-average', { statementName: 'NH3SustainedWarning', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '>=', value: 20, groupField: 'warehouseId', windowSize: 3, windowUnit: 'minutes' }],
  ['window-fluctuation', { statementName: 'NH3RapidFluctuation', eventType: 'NH3Reading', field: 'ammoniaPpm', delta: 15, groupField: 'warehouseId', windowSize: 5, windowUnit: 'minutes' }],
  ['event-count', { statementName: 'NH3FrequentAlarm', eventType: 'NH3Reading', groupField: 'warehouseId', count: 3, windowSize: 5, windowUnit: 'minutes' }],
  ['window-sum', { statementName: 'NH3LeakageTotal', eventType: 'NH3Reading', field: 'leakagePpm', value: 100, groupField: 'warehouseId', windowSize: 10, windowUnit: 'minutes' }],
];

test('CEP P0 templates generate stable insert-into EPL', () => {
  assert.equal(CEP_TEMPLATES.length, 5);
  for (const [templateId, params] of cases) {
    const epl = buildCepTemplate(templateId, params);
    assert.match(epl, new RegExp(`^insert into ${params.statementName}Event select `));
    assert.doesNotMatch(epl, /≥|≤|≠/);
    assert.match(renderCepTemplateDescription(templateId, params), /输出检测/);
    const compiled = compileEventStreamDraft({ name: '氨气模板', statements: [{ name: params.statementName, epl }] }, bom);
    assert.equal(compiled.status, 200, `${templateId}: ${compiled.error || ''}`);
    assert.equal(compiled.result.module.statements[0].outputEventType, `${params.statementName}Event`);
  }
});

test('CEP window templates support sliding and tumbling window clauses', () => {
  for (const [templateId, params] of cases.filter(([templateId]) => templateId !== 'single-threshold')) {
    const sliding = buildCepTemplate(templateId, { ...params, windowType: 'sliding' });
    const tumbling = buildCepTemplate(templateId, { ...params, windowType: 'tumbling' });
    assert.match(sliding, /#time\(/, `${templateId} should default to sliding #time`);
    assert.match(tumbling, /#time_batch\(/, `${templateId} should support tumbling #time_batch`);
    assert.match(renderCepTemplateDescription(templateId, { ...params, windowType: 'tumbling' }), /跳跃窗口/);
    const compiled = compileEventStreamDraft({ name: '氨气模板', statements: [{ name: params.statementName, epl: tumbling }] }, bom);
    assert.equal(compiled.status, 200, `${templateId}: ${compiled.error || ''}`);
    assert.equal(compiled.result.module.statements[0].outputEventType, `${params.statementName}Event`);
  }
});

test('CEP template validation rejects unsafe identifiers and normalizes UI operators', () => {
  assert.equal(normalizeCepOperator('≥'), '>=');
  assert.equal(normalizeCepOperator('≠'), '!=');
  assert.throws(() => buildCepTemplate('single-threshold', { statementName: '坏 名称', eventType: 'NH3Reading', field: 'ammoniaPpm', value: 1 }), /语句 ID/);
  assert.throws(() => buildCepTemplate('single-threshold', { statementName: 'Bad', eventType: 'NH3Reading', field: 'ammoniaPpm;delete', value: 1 }), /字段/);
});

test('EventStream authoring metadata persists in draft but stays out of runtime module checksum', () => {
  const epl = buildCepTemplate('single-threshold', { statementName: 'NH3HighAlarm', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '>=', value: 25 });
  const first = compileEventStreamDraft({
    name: '氨气检测',
    statements: [{ name: 'NH3HighAlarm', epl, label: '氨气超限', description: '业务说明 A', mode: 'guided', template: 'single-threshold', params: { value: 25 } }],
  }, bom);
  const second = compileEventStreamDraft({
    name: '氨气检测',
    statements: [{ name: 'NH3HighAlarm', epl, label: '氨气严重超限', description: '业务说明 B', mode: 'guided', template: 'single-threshold', params: { value: 30 } }],
  }, bom);
  assert.equal(first.result.checksum, second.result.checksum);
  assert.deepEqual(Object.keys(first.result.module.statements[0]).sort(), ['enabled', 'epl', 'eventTypes', 'name', 'outputEventType']);
});

test('CEP validation accepts time-driven patterns and same-stream derived events', () => {
  const bomWithPhase = {
    ...bom,
    fields: [
      ...bom.fields,
      { key: 'phase', label: '阶段', type: 'String', semanticType: 'Enum', kind: 'output', factType: 'NitrogenPhaseEvent', factTypeLabel: '氮气阶段' },
    ],
    eventTypes: [
      ...bom.eventTypes,
      { name: 'NitrogenPhaseEvent', label: '氮气阶段事件', fields: [{ field: 'phase' }, { field: 'warehouseId' }] },
    ],
  };
  const draft = {
    name: '时间驱动检测',
    statements: [
      {
        name: 'ToCirculation',
        epl: "insert into NitrogenPhaseEvent select 'CIRCULATION' as phase, warehouseId from NH3Reading where ammoniaPpm >= 25",
      },
      {
        name: 'AfterPhase',
        epl: "insert into NitrogenPhaseEvent select 'HOLDING' as phase, a.warehouseId as warehouseId from pattern [every (a=NitrogenPhaseEvent(phase='CIRCULATION') -> timer:interval(1 seconds))]",
      },
      {
        name: 'MissingReading',
        epl: "insert into MissingEvent select a.warehouseId as warehouseId from pattern [every (a=NitrogenPhaseEvent -> (timer:interval(1 seconds) and not NH3Reading(warehouseId = a.warehouseId)))]",
      },
    ],
  };
  const compiled = compileEventStreamDraft(draft, bomWithPhase);
  assert.equal(compiled.status, 200, compiled.error || '');
  assert.deepEqual(compiled.result.module.statements.map(statement => statement.eventTypes), [
    ['NH3Reading'],
    ['NitrogenPhaseEvent'],
    ['NitrogenPhaseEvent', 'NH3Reading'],
  ]);

  const periodic = compileEventStreamDraft({
    name: '周期巡检',
    statements: [{
      name: 'PeriodicTick',
      epl: 'insert into TickEvent select current_timestamp() as ts from pattern [every timer:interval(1 seconds)]',
    }],
  }, bom);
  assert.equal(periodic.status, 200, periodic.error || '');
  assert.deepEqual(periodic.result.module.statements[0].eventTypes, []);
});

test('CEP template baseline fixture stays aligned with builders', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/cep-template-baseline.json', import.meta.url), 'utf8'));
  assert.equal(fixture.cases.length, 15);
  for (const item of fixture.cases) {
    assert.equal(item.outputEventType, `${item.statementName}Event`);
    assert.equal(item.esper.ok, true);
    assert.equal(item.sampleExecution.ok, true);
    assert.ok(item.sampleExecution.eventTypes.includes(item.outputEventType));
    assert.match(item.epl, /^insert into [A-Za-z][A-Za-z0-9_]*Event select /);
  }
});
