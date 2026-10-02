import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTestCases, normalizeTestSuite, validateTestSuite } from '../shared/test-suites.js';

const bom = {
  version: 1,
  fields: [
    { key: 'warehouseId', label: '粮仓 ID', type: 'String', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样' },
    { key: 'ammoniaPpm', label: '氨气浓度', type: 'Double', kind: 'input', factType: 'NH3Reading', factTypeLabel: '氨气采样' },
  ],
  eventTypes: [{ name: 'NH3Reading', fields: [{ field: 'warehouseId', required: true }, { field: 'ammoniaPpm', required: true }] }],
};

const event = { type: 'NH3Reading', data: { warehouseId: 'WH-01', ammoniaPpm: 25 } };

test('CEP test suites preserve waitMs for tumbling-window tests', () => {
  const suite = {
    name: '跳跃窗口测试', description: '', required: false,
    target: { type: 'event-stream', id: 'event-stream-1' },
    cases: [{
      id: 'case-1', name: 'batch 输出', enabled: true,
      events: [event], waitMs: 1200,
      expectedEvents: [{ statement: 'WindowAverage', eventType: 'WindowAverageEvent', count: 1 }],
    }],
  };
  assert.equal(validateTestSuite(suite, bom), null);
  const normalized = normalizeTestSuite(suite);
  assert.equal(normalized.cases[0].waitMs, 1200);
  assert.deepEqual(expandTestCases(normalized)[0].facts, { events: [event], waitMs: 1200 });
});

test('CEP test suites reject invalid waitMs', () => {
  const suite = {
    name: '非法等待', description: '', required: false,
    target: { type: 'event-stream', id: 'event-stream-1' },
    cases: [{ id: 'case-1', name: 'bad', enabled: true, events: [event], waitMs: 300001, expectedEvents: [{ statement: 'S', eventType: 'SEvent' }] }],
  };
  assert.match(validateTestSuite(suite, bom), /等待时间/);
});

test('CEP test suites allow pure time-driven cases with waitMs', () => {
  const suite = {
    name: '周期巡检',
    description: '',
    required: true,
    target: { type: 'event-stream', id: 'event-stream-1' },
    cases: [{
      id: 'timer-1',
      name: '等待周期输出',
      enabled: true,
      events: [],
      waitMs: 1100,
      expectedEvents: [{ statement: 'PeriodicTick', eventType: 'TickEvent', count: 1 }],
    }],
  };
  assert.equal(validateTestSuite(suite, bom), null);
  const normalized = normalizeTestSuite(suite);
  assert.deepEqual(expandTestCases(normalized)[0].facts, { events: [], waitMs: 1100 });
});
