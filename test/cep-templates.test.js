import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CEP_TEMPLATES, buildCepTemplate, normalizeCepOperator, renderCepTemplateDescription } from '../shared/cep-templates.js';
import { compileEventStreamDraft, normalizeEventStreamDraft } from '../shared/event-streams.js';

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
  assert.equal(CEP_TEMPLATES.length, 9);
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

test('advanced CEP templates generate validated EPL', () => {
  const advanced = [
    ['absence', { statementName: 'NoAck', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '>=', value: 25, groupField: 'warehouseId', secondEventType: 'NH3Reading', secondGroupField: 'warehouseId', secondField: 'leakagePpm', secondOperator: '>=', secondValue: 0, windowSize: 5, windowUnit: 'seconds' }],
    ['event-sequence', { statementName: 'AckAfterAlarm', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '>=', value: 25, groupField: 'warehouseId', secondEventType: 'NH3Reading', secondGroupField: 'warehouseId', secondField: 'leakagePpm', secondOperator: '>=', secondValue: 0, windowSize: 5, windowUnit: 'seconds' }],
    ['consecutive-count', { statementName: 'ThreeHigh', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '>=', value: 25, groupField: 'warehouseId', count: 3 }],
    ['periodic', { statementName: 'Heartbeat', windowSize: 5, windowUnit: 'seconds' }],
  ];
  for (const [templateId, params] of advanced) {
    const epl = buildCepTemplate(templateId, params);
    assert.match(epl, new RegExp(`^insert into ${params.statementName}Event select `));
    const compiled = compileEventStreamDraft({ name: '高级模板', statements: [{ name: params.statementName, epl }] }, bom);
    assert.equal(compiled.status, 200, `${templateId}: ${compiled.error || ''}`);
  }
});

test('guided EventStream metadata must reproduce the persisted EPL', () => {
  const params = { statementName: 'NH3HighAlarm', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '>=', value: '25' };
  const epl = buildCepTemplate('single-threshold', params);
  assert.match(epl, />= 25$/);

  const valid = compileEventStreamDraft({
    name: '氨气模板',
    statements: [{ name: params.statementName, enabled: true, mode: 'guided', template: 'single-threshold', params, epl }],
  }, bom);
  assert.equal(valid.status, 200);

  const conflicting = compileEventStreamDraft({
    name: '氨气模板',
    statements: [{ name: params.statementName, enabled: true, mode: 'guided', template: 'single-threshold', params, epl: epl.replace('>= 25', '< 10') }],
  }, bom);
  assert.equal(conflicting.status, 400);
  assert.match(conflicting.error, /向导参数与 EPL 不一致/);

  const incomplete = compileEventStreamDraft({
    name: '氨气模板',
    statements: [{ name: params.statementName, enabled: true, mode: 'guided', epl }],
  }, bom);
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.error, /缺少模板或参数/);

  const missingEpl = compileEventStreamDraft({
    name: '氨气模板',
    statements: [{ name: params.statementName, enabled: true, mode: 'guided', template: 'single-threshold', params }],
  }, bom);
  assert.equal(missingEpl.status, 400);
  assert.match(missingEpl.error, /内容需为 1-4000 个字符/);
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

test('single-threshold template supports renamed fields and typed constant outputs', () => {
  const params = {
    statementName: 'PhaseChanged',
    eventType: 'NH3Reading',
    field: 'ammoniaPpm',
    operator: '>=',
    value: 25,
    outputFields: [
      { source: 'constant', alias: 'phase', value: 'CIRCULATION' },
      { source: 'field', alias: 'siteId', field: 'warehouseId' },
      { source: 'constant', alias: 'active', value: true },
    ],
  };
  const epl = buildCepTemplate('single-threshold', params);
  assert.equal(epl, "insert into PhaseChangedEvent select 'CIRCULATION' as phase, warehouseId as siteId, true as active from NH3Reading where ammoniaPpm >= 25");
  assert.equal(buildCepTemplate('single-threshold', {
    ...params,
    outputFields: [{ source: 'constant', alias: 'message', value: "operator's alert" }],
  }), "insert into PhaseChangedEvent select 'operator''s alert' as message from NH3Reading where ammoniaPpm >= 25");
  assert.match(buildCepTemplate('single-threshold', {
    ...params,
    outputFields: [{ source: 'constant', alias: 'code', value: '123' }],
  }), /select '123' as code/);

  const compiled = compileEventStreamDraft({
    name: '派生输出',
    statements: [{ name: params.statementName, mode: 'guided', template: 'single-threshold', params, epl }],
  }, bom);
  assert.equal(compiled.status, 200, compiled.error || '');
});

test('derived output validation rejects unsafe or duplicate aliases and fields', () => {
  const base = { statementName: 'BadOutput', eventType: 'NH3Reading', field: 'ammoniaPpm', value: 25 };
  assert.throws(() => buildCepTemplate('single-threshold', { ...base, outputFields: [{ source: 'field', alias: 'bad alias', field: 'warehouseId' }] }), /输出字段别名/);
  assert.throws(() => buildCepTemplate('single-threshold', { ...base, outputFields: [{ source: 'field', alias: 'site', field: 'warehouseId;drop' }] }), /源字段/);
  assert.throws(() => buildCepTemplate('single-threshold', { ...base, outputFields: [{ source: 'field', alias: 'site', field: 'warehouseId' }, { source: 'constant', alias: 'site', value: 1 }] }), /输出字段别名重复/);
});

test('EventStream authoring metadata persists in draft but stays out of runtime module checksum', () => {
  const params = { statementName: 'NH3HighAlarm', eventType: 'NH3Reading', field: 'ammoniaPpm', operator: '>=', value: 25 };
  const epl = buildCepTemplate('single-threshold', params);
  const first = compileEventStreamDraft({
    name: '氨气检测',
    statements: [{ name: 'NH3HighAlarm', epl, label: '氨气超限', description: '业务说明 A', mode: 'guided', template: 'single-threshold', params }],
  }, bom);
  const second = compileEventStreamDraft({
    name: '氨气检测（更新说明）',
    description: '事件流总体说明',
    statements: [{ name: 'NH3HighAlarm', epl, label: '氨气严重超限', description: '  业务说明 B  ', mode: 'guided', template: 'single-threshold', params }],
  }, bom);
  const normalized = normalizeEventStreamDraft({
    name: '氨气检测',
    description: '  总体说明  ',
    statements: [{ name: 'NH3HighAlarm', epl, description: '  人工业务说明  ' }],
  });
  assert.equal(normalized.description, '总体说明');
  assert.equal(normalized.statements[0].description, '人工业务说明');
  assert.equal(first.result.checksum, second.result.checksum);
  assert.deepEqual(Object.keys(first.result.module.statements[0]).sort(), ['enabled', 'epl', 'eventTypes', 'name', 'outputEventType']);
});

test('EPL preserves Chinese comments as runtime text', () => {
  const plainEpl = 'select * from NH3Reading';
  const commentedEpl = '// 检测氨气浓度\n/* 中文块注释 */\nselect * from NH3Reading';
  const plain = compileEventStreamDraft({ name: '无注释', statements: [{ name: 'DetectNH3', epl: plainEpl }] }, bom);
  const commented = compileEventStreamDraft({ name: '中文注释', statements: [{ name: 'DetectNH3', epl: commentedEpl }] }, bom);
  assert.equal(commented.status, 200, commented.error || '');
  assert.equal(commented.result.module.statements[0].epl, commentedEpl);
  assert.notEqual(plain.result.checksum, commented.result.checksum);
});

test('EventStream statement groups persist as authoring metadata without changing runtime checksum', () => {
  const statements = cases.slice(0, 2).map(([template, params], index) => ({
    name: params.statementName,
    epl: buildCepTemplate(template, params),
    group: index === 0 ? '实时检测' : '窗口检测',
  }));
  const normalized = normalizeEventStreamDraft({ name: '分组检测', statements: [{ ...statements[0], group: '  实时检测  ' }, statements[1]] });
  assert.equal(normalized.statements[0].group, '实时检测');

  const grouped = compileEventStreamDraft({ name: '分组检测', statements }, bom);
  const renamed = compileEventStreamDraft({ name: '分组检测', statements: statements.map(statement => ({ ...statement, group: '其他分组' })) }, bom);
  assert.equal(grouped.status, 200, grouped.error || '');
  assert.equal(grouped.result.checksum, renamed.result.checksum);

  const tooLong = compileEventStreamDraft({ name: '分组检测', statements: [{ ...statements[0], group: 'x'.repeat(81) }] }, bom);
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.error, /分组名称不能超过 80 字/);
});

test('EventStream statement order remains runtime-significant', () => {
  const statements = cases.slice(0, 2).map(([template, params]) => ({ name: params.statementName, epl: buildCepTemplate(template, params) }));
  const forward = compileEventStreamDraft({ name: '排序检测', statements }, bom);
  const reversed = compileEventStreamDraft({ name: '排序检测', statements: [...statements].reverse() }, bom);
  assert.equal(forward.status, 200, forward.error || '');
  assert.equal(reversed.status, 200, reversed.error || '');
  assert.notEqual(forward.result.checksum, reversed.result.checksum);
  assert.deepEqual(forward.result.module.statements.map(statement => statement.name), statements.map(statement => statement.name));
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
