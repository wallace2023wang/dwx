import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { flowSnapshot } from '../shared/assets.js';

const read = file => JSON.parse(fs.readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'));
const inDefaultProject = item => (item.projectId || 'default') === 'default';

test('default published rule flow remains compatible with the current BOM', () => {
  const rules = read('rules.json').filter(inDefaultProject);
  const tables = read('tables.json').filter(inDefaultProject);
  const packages = read('packages.json').filter(inDefaultProject);
  const flow = read('flows.json').find(item => item.id === '899825a4-4526-4972-9e7d-c9261fdd6a8d');
  const bom = read('bom.json');

  assert.ok(flow, 'default demo flow is missing');
  const snapshot = flowSnapshot(flow.draft, rules, tables, bom, packages);
  assert.equal(snapshot.steps.length, 2);
  assert.equal(snapshot.steps[0].version, 2);
});
