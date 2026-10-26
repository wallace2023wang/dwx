import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DECISION_TABLE_ROWS, newTable, validateTable } from '../shared/assets.js';

function capacityTable(rows) {
  const table = newTable();
  table.name = `容量表 ${rows}`;
  table.hitPolicy = 'FIRST';
  table.conditions = [{ field: 'creditScore', operator: '>=' }];
  table.actions = [{ field: 'riskLevel' }];
  table.rows = Array.from({ length: rows }, (_, index) => ({
    enabled: true,
    priority: index % 1000,
    conditions: [String(300 + (index % 601))],
    actions: ['低'],
  }));
  return table;
}

test('decision table accepts the 10k capacity tier and skips expensive synchronous analysis', () => {
  const validation = validateTable(capacityTable(MAX_DECISION_TABLE_ROWS));
  assert.equal(validation.error, null);
  assert.ok(validation.warnings.some(warning => /超过 500.*跳过同步重叠、不可达和缺口分析/.test(warning)));
});

test('decision table rejects rows above the capacity limit', () => {
  const validation = validateTable(capacityTable(MAX_DECISION_TABLE_ROWS + 1));
  assert.match(validation.error, /1–10000 行/);
  assert.deepEqual(validation.warnings, []);
});
