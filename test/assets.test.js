import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFlowMappings, flowSnapshot, newFlow, newTable, parseConditionCell, resolveFlowVariables, resolveRuleGroupMembers, ruleGroupFingerprint, selectFlowBranch, tableCollectedHits, tableDrl, tableExecutionTrace, tableRules, validateFlow, validateTable } from '../shared/assets.js';
import { defaultBom } from '../shared/bom.js';

// 语法测试用的宽松 BOM：customerType 不预设枚举值域，以便验证任意 a,b,c 语法。
function looseBom() {
  const bom = structuredClone(defaultBom());
  const ct = bom.fields.find(f => f.key === 'customerType');
  ct.enum = null;
  return bom;
}

// 构造一个无冲突的标准表：行1 creditScore<600,行2 creditScore>=600
function cleanTable() {
  const t = newTable();
  t.rows[0].conditions[0] = '600';           // <600
  t.rows[1].conditions[0] = '600';
  t.rows[1].conditions[0] = '600';
  t.conditions[1] = { field: 'overdue', operator: '==' };
  t.rows[0].conditions[1] = 'true';
  t.rows[1].conditions[1] = 'false';
  return t;
}

test('decision table validates and generates one DRL rule per enabled row', () => {
  const table = cleanTable();
  assert.equal(table.hitPolicy, 'COLLECT');
  const v = validateTable(table);
  assert.equal(v.error, null);
  assert.equal(tableRules(table).length, 2);
  const drl = tableDrl(table);
  assert.match(drl, /未命名决策表 第1行/);
  assert.match(drl, /未命名决策表 第2行/);
  assert.match(drl, /declare DecisionHit/);
  assert.match(drl, /insert\(\$hit\)/);
  assert.doesNotMatch(drl, /activation-group/);
  assert.match(drl, /第1行 \[1\]"\n    salience 2/);
  assert.match(drl, /第2行 \[2\]"\n    salience 1/);
});

test('legacy ALL execution trace maps fired rules to rows and output overwrites', () => {
  const table = cleanTable();
  table.hitPolicy = 'ALL';
  table.name = '额度决策';
  table.rows[0].actions[0] = '低';
  table.rows[1].actions[0] = '高';
  const rules = tableRules(table);
  const fired = rules.map((rule, index) => `${rule.name} [${index + 1}]`);
  const trace = tableExecutionTrace(table, fired);

  assert.deepEqual(trace.map(hit => hit.rowIndex), [0, 1]);
  assert.equal(trace[0].actions[0].overwritten, false);
  assert.equal(trace[1].actions[0].overwritten, true);
  assert.equal(trace[1].actions[0].previousValue, '低');
  assert.equal(trace[1].actions[0].previousOrder, 1);
});

test('COLLECT execution trace exposes independent hit collection', () => {
  const table = cleanTable();
  table.name = '额度决策';
  table.rows[0].actions[0] = '低';
  table.rows[1].actions[0] = '高';
  const rules = tableRules(table);
  const fired = rules.map((rule, index) => `${rule.name} [${index + 1}]`);
  const trace = tableExecutionTrace(table, fired);
  const hits = tableCollectedHits(table, fired);

  assert.deepEqual(trace.map(hit => hit.collected), [true, true]);
  assert.equal(trace[1].actions[0].overwritten, false);
  assert.deepEqual(hits.map(hit => hit.outputs.riskLevel), ['低', '高']);
  assert.deepEqual(hits.map(hit => hit.rowIndex), [0, 1]);
});

test('decision table execution trace identifies default rows and preserves unknown names', () => {
  const table = cleanTable();
  table.rows[1] = { ...table.rows[1], isDefault: true, conditions: ['', ''] };
  const rules = tableRules(table);
  const defaultName = `${rules[1].name} [2]`;
  const trace = tableExecutionTrace(table, [defaultName, '外部规则 [9]']);

  assert.equal(trace[0].rowIndex, 1);
  assert.equal(trace[0].isDefault, true);
  assert.equal(trace[1].rowIndex, null);
  assert.deepEqual(trace[1].actions, []);
});

test('decision table rejects duplicate columns and invalid cells', () => {
  const table = cleanTable();
  table.conditions[1].field = table.conditions[0].field;
  assert.match(validateTable(table).error, /重复/);
  const valid = cleanTable();
  valid.rows[0].conditions[0] = 'not-a-number';
  assert.match(validateTable(valid).error, /第 1 行/);
  const invalidAction = cleanTable();
  invalidAction.rows[0].actions[1] = '不是布尔值';
  assert.match(validateTable(invalidAction).error, /第 1 行.*结果值/);
  const invalidConditionType = cleanTable();
  invalidConditionType.rows[0].conditions[0] = 600;
  assert.match(validateTable(invalidConditionType).error, /第 1 行条件值/);
});

test('FIRST uses display order and an isolated Drools activation group', () => {
  const table = cleanTable();
  table.hitPolicy = 'FIRST';
  table.rows[0].conditions = ['600..', ''];
  table.rows[1].conditions = ['500..', ''];
  assert.equal(validateTable(table).error, null);
  const drl = tableDrl(table, undefined, 'table-first');
  assert.equal(drl.match(/activation-group "decision-table:table-first"/g)?.length, 2);
  assert.match(drl, /第1行 \[1\]"\n    salience 2/);
  assert.match(drl, /第2行 \[2\]"\n    salience 1/);
});

test('PRIORITY chooses business priority before display order', () => {
  const table = cleanTable();
  table.hitPolicy = 'PRIORITY';
  table.rows[0] = { ...table.rows[0], priority: 2, conditions: ['600..', ''] };
  table.rows[1] = { ...table.rows[1], priority: 9, conditions: ['500..', ''] };
  assert.equal(validateTable(table).error, null);
  const rules = tableRules(table, undefined, 'table-priority');
  assert.deepEqual(rules.map(rule => rule.salience), [2002, 9001]);
  assert.ok(rules.every(rule => rule.activationGroup === 'decision-table:table-priority'));
  table.rows[1].priority = 1001;
  assert.match(validateTable(table).error, /第 2 行优先级/);
});

test('legacy tables default to ALL and COLLECT hit policy is accepted', () => {
  const table = cleanTable();
  delete table.hitPolicy;
  assert.equal(validateTable(table).error, null);
  assert.doesNotMatch(tableDrl(table), /activation-group/);
  table.hitPolicy = 'COLLECT';
  assert.equal(validateTable(table).error, null);
  assert.doesNotMatch(tableDrl(table), /activation-group/);
  table.hitPolicy = 'UNKNOWN';
  assert.match(validateTable(table).error, /命中策略/);
});

test('decision table allows blank cells to omit a condition or action', () => {
  const table = cleanTable();
  table.rows[0].conditions[1] = '';
  table.rows[0].actions[1] = '';
  assert.equal(validateTable(table).error, null);
  const rules = tableRules(table);
  assert.equal(rules[0].conditions.length, 1);
  assert.equal(rules[0].actions.length, 1);
});

test('range syntax 600..700 generates AND clauses', () => {
  const table = cleanTable();
  table.rows[0].conditions[0] = '600..700';
  table.rows[1].conditions[0] = '700..';
  const v = validateTable(table);
  assert.equal(v.error, null);
  const drl = tableDrl(table);
  assert.match(drl, /creditScore >= 600/);
  assert.match(drl, /creditScore <= 700/);
  assert.match(drl, /creditScore >= 700/);
});

test('half-open range syntax generates explicit boundary comparisons', () => {
  const table = cleanTable();
  table.rows[0].conditions[0] = '[600,700)';
  table.rows[1].conditions[0] = '[700,900]';
  const validation = validateTable(table);
  assert.equal(validation.error, null);
  const drl = tableDrl(table);
  assert.match(drl, /creditScore >= 600/);
  assert.match(drl, /creditScore < 700/);
  assert.match(drl, /creditScore >= 700/);
  assert.match(drl, /creditScore <= 900/);
});

test('all-blank enabled condition row is reported as wildcard', () => {
  const table = cleanTable();
  table.rows[0].conditions = ['', ''];
  const validation = validateTable(table);
  assert.equal(validation.error, null);
  assert.ok(validation.warnings.some(warning => /第 1 行所有条件均为空.*通配/.test(warning)));
});

test('cell comparison prefix overrides the legacy column operator', () => {
  const table = cleanTable();
  table.conditions[0] = { field: 'creditScore', operator: '<' };
  table.rows[0].conditions[0] = '>=700';
  table.rows[1].conditions[0] = '< 600';
  const drl = tableDrl(table);
  assert.match(drl, /creditScore >= 700/);
  assert.match(drl, /creditScore < 600/);
});

test('string condition supports Chinese contains syntax', () => {
  const field = defaultBom().fields.find(entry => entry.key === 'customerType');
  field.enum = null;
  field.semanticType = 'String';
  assert.deepEqual(parseConditionCell(field, '==', '包含"企业"'), ['customerType matches ".*企业.*"']);
  assert.deepEqual(parseConditionCell(field, '==', '不包含“同业”'), ['customerType not matches ".*同业.*"']);
});

test('range syntax rejects lo > hi', () => {
  const table = cleanTable();
  table.rows[0].conditions[0] = '700..600';
  assert.match(validateTable(table).error, /下界不能大于上界/);
});

test('condition cell parser rejects malformed ranges', () => {
  const field = defaultBom().fields.find(f => f.key === 'creditScore');
  assert.throws(() => parseConditionCell(field, '==', '500..600..700'), /格式无效/);
});

test('decision table supports structured same-type field references and treats analysis as unknown', () => {
  const table = newTable();
  table.conditions = [{ field: 'creditScore', operator: '>=' }];
  table.actions = [{ field: 'riskLevel' }];
  table.rows = [{ enabled: true, priority: 0, conditions: [{ valueSource: 'field', valueField: 'customerAge' }], actions: ['高'] }];
  const validation = validateTable(table);
  assert.equal(validation.error, null);
  assert.match(tableDrl(table), /creditScore >= customerAge/);

  table.rows[0].conditions[0] = { valueSource: 'field', valueField: 'customerType' };
  assert.match(validateTable(table).error, /同类型/);
  table.rows[0].conditions[0] = { valueSource: 'field', valueField: 'creditScore' };
  assert.match(validateTable(table).error, /自身比较/);
});

test('range syntax rejects non-numeric fields', () => {
  const table = cleanTable();
  table.conditions[0] = { field: 'customerType', operator: '==' };
  table.rows[0].conditions[0] = 'a..b';
  assert.match(validateTable(table).error, /不支持区间/);
});

test('enum syntax a,b,c generates in() clause', () => {
  const table = cleanTable();
  table.conditions[0] = { field: 'customerType', operator: '==' };
  table.rows[0].conditions[0] = 'VIP,whale';
  table.rows[1].conditions[0] = 'normal';
  const bom = looseBom();
  const v = validateTable(table, bom);
  assert.equal(v.error, null);
  const drl = tableDrl(table, bom);
  assert.match(drl, /customerType in \("VIP", "whale"\)/);
});

test('conflict detection flags identical rows', () => {
  const table = cleanTable();
  table.rows[1] = { ...table.rows[0] };  // 完全相同
  const v = validateTable(table);
  assert.match(v.error, /完全一致/);
});

test('decision table analysis proves numeric partitions are disjoint and complete', () => {
  const table = cleanTable();
  table.rows[0].conditions = ['..599', ''];
  table.rows[1].conditions = ['600..', ''];
  const v = validateTable(table);
  assert.equal(v.error, null);
  assert.deepEqual(v.warnings, []);
});

test('decision table analysis honors comparison prefixes in cells', () => {
  const table = cleanTable();
  table.conditions = [{ field: 'creditScore', operator: '<' }];
  table.rows[0].conditions = ['<600'];
  table.rows[1].conditions = ['>=600'];
  const v = validateTable(table);
  assert.equal(v.error, null);
  assert.deepEqual(v.warnings, []);
});

test('decision table analysis reports exact overlap and a field-domain gap', () => {
  const table = cleanTable();
  table.rows[0].conditions = ['500..700', ''];
  table.rows[1].conditions = ['650..800', ''];
  const v = validateTable(table);
  assert.equal(v.error, null);
  assert.ok(v.warnings.some(warning => /第 1 行与第 2 行条件存在重叠/.test(warning)));
  assert.ok(v.warnings.some(warning => /决策表有命中缺口.*信用评分=/.test(warning)));
});

test('decision table analysis identifies conflicting actions on overlapping rows', () => {
  const table = cleanTable();
  table.rows[0] = { ...table.rows[0], conditions: ['500..700', ''], actions: ['低', 'false'] };
  table.rows[1] = { ...table.rows[1], conditions: ['650..800', ''], actions: ['高', 'false'] };
  const v = validateTable(table);
  assert.equal(v.error, null);
  assert.ok(v.warnings.some(warning => /条件存在重叠，且动作结果冲突：风险等级/.test(warning)));
  assert.equal(v.warnings.some(warning => /需要人工审核/.test(warning)), false);
});

test('FIRST and PRIORITY analysis reports rows covered by a winning row', () => {
  const first = cleanTable();
  first.hitPolicy = 'FIRST';
  first.rows[0].conditions = ['500..800', ''];
  first.rows[1].conditions = ['600..700', ''];
  assert.ok(validateTable(first).warnings.some(warning => /第 2 行被获胜顺序中的第 1 行联合覆盖.*FIRST/.test(warning)));

  const priority = cleanTable();
  priority.hitPolicy = 'PRIORITY';
  priority.rows[0] = { ...priority.rows[0], priority: 1, conditions: ['600..700', ''] };
  priority.rows[1] = { ...priority.rows[1], priority: 10, conditions: ['500..800', ''] };
  assert.ok(validateTable(priority).warnings.some(warning => /第 1 行被获胜顺序中的第 2 行联合覆盖.*PRIORITY/.test(warning)));
});

test('FIRST analysis detects coverage formed by multiple earlier rows', () => {
  const table = cleanTable();
  table.hitPolicy = 'FIRST';
  table.rows = [
    { enabled: true, priority: 0, conditions: ['300..599', ''], actions: ['低', 'false'] },
    { enabled: true, priority: 0, conditions: ['600..900', ''], actions: ['中', 'false'] },
    { enabled: true, priority: 0, conditions: ['300..900', ''], actions: ['高', 'true'] },
  ];
  const v = validateTable(table);
  assert.equal(v.error, null);
  assert.ok(v.warnings.some(warning => /第 3 行被获胜顺序中的第 1、2 行联合覆盖.*FIRST/.test(warning)));
});

test('analysis finds a multidimensional gap even when each column is covered', () => {
  const table = cleanTable();
  table.conditions = [
    { field: 'customerType', operator: '==' },
    { field: 'overdue', operator: '==' },
  ];
  table.rows = [
    { enabled: true, priority: 0, conditions: ['个人,企业', 'true'], actions: ['低', 'false'] },
    { enabled: true, priority: 0, conditions: ['同业', 'false'], actions: ['高', 'true'] },
  ];
  const v = validateTable(table);
  assert.equal(v.error, null);
  assert.ok(v.warnings.some(warning => /命中缺口.*客户类型=.*是否逾期=/.test(warning)));
});

test('enum analysis recognizes complete disjoint coverage and default suppresses gaps', () => {
  const table = cleanTable();
  table.conditions[0] = { field: 'customerType', operator: '==' };
  table.rows[0].conditions = ['个人,企业', ''];
  table.rows[1].conditions = ['同业', ''];
  assert.deepEqual(validateTable(table).warnings, []);

  table.rows[1].conditions[0] = '企业';
  table.rows.push({ enabled: true, isDefault: true, conditions: ['', ''], actions: ['低', 'false'] });
  assert.equal(validateTable(table).warnings.some(warning => /命中缺口/.test(warning)), false);
});

test('default row uses not() pattern', () => {
  const table = cleanTable();
  table.rows.push({ enabled: true, isDefault: true, conditions: ['', ''], actions: ['低', 'false'] });
  const v = validateTable(table);
  assert.equal(v.error, null);
  const drl = tableDrl(table);
  assert.match(drl, /not RuleInput\(/);
  assert.match(drl, /默认行/);
});

test('table defaultRow marker is accepted and default-only table warns', () => {
  const marked = cleanTable();
  marked.rows.push({ enabled: true, conditions: ['', ''], actions: ['低', 'false'] });
  marked.defaultRow = 2;
  assert.equal(validateTable(marked).error, null);
  assert.equal(tableRules(marked).at(-1).tableDefault, true);

  const only = cleanTable();
  only.rows = [{ enabled: true, isDefault: true, conditions: ['', ''], actions: ['低', 'false'] }];
  const v = validateTable(only);
  assert.equal(v.error, null);
  assert.ok(v.warnings.some(warning => /没有任何显式启用行/.test(warning)));
});

test('default row must have empty conditions', () => {
  const table = cleanTable();
  table.rows.push({ enabled: true, isDefault: true, conditions: ['500', ''], actions: ['低', 'false'] });
  assert.match(validateTable(table).error, /默认行/);
});

test('decision tables can read and write Rule Project variables', () => {
  const variables = [
    { name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false },
  ];
  const table = {
    ...newTable(),
    name: '变量决策表',
    conditions: [{ field: 'approved', fieldSource: 'variable', operator: '==' }],
    actions: [{ field: 'approved', fieldSource: 'variable' }],
    rows: [{ enabled: true, conditions: ['true'], actions: ['true'] }],
  };
  assert.equal(validateTable(table, undefined, variables).error, null);
  const drl = tableDrl(table, undefined, 'variable-table', variables);
  assert.match(drl, /declare RuleContext/);
  assert.match(drl, /RuleContext\( approved == true \)/);
  assert.match(drl, /setApproved\(true\)/);
});

test('published rule flow freezes source versions and generated DRL', () => {
  const table = cleanTable();
  table.hitPolicy = 'FIRST';
  const rules = [{ id: 'rule-1', archived: false, published: { name: '已发布规则', description: '', conditions: [{ field: 'customerAge', operator: '>=', value: '18' }], actions: [{ field: 'riskLevel', value: '低' }], category: '通用', priority: 0 }, versions: [{ number: 3 }] }];
  const tables = [{ id: 'table-1', archived: false, published: table, versions: [{ number: 2 }] }];
  const flow = { ...newFlow(), name: '客户分层流', steps: [{ type: 'rule', id: 'rule-1' }, { type: 'table', id: 'table-1' }] };
  assert.equal(validateFlow(flow, rules, tables), null);
  const snapshot = flowSnapshot(flow, rules, tables);
  assert.deepEqual(snapshot.steps.map(step => [step.type, step.id, step.version]), [['rule', 'rule-1', 3], ['table', 'table-1', 2]]);
  assert.match(snapshot.steps[0].drl, /已发布规则/);
  assert.match(snapshot.steps[1].drl, /未命名决策表 第1行/);
  assert.match(snapshot.steps[1].drl, /activation-group "decision-table:table-1"/);
});

test('rule flow variables provide one shared scope across member rules', () => {
  const variable = { name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false, enum: null, description: '规则间共享的中间结果' };
  const first = {
    name: '规则 A', description: '', category: 'common', priority: 0, variables: [variable],
    conditions: [{ field: 'customerAge', operator: '>=', value: '18' }],
    actions: [{ fieldSource: 'variable', field: 'approved', value: 'true' }],
  };
  const second = {
    name: '规则 B', description: '', category: 'common', priority: 0, variables: [variable],
    conditions: [{ fieldSource: 'variable', field: 'approved', operator: '==', value: 'true' }],
    actions: [{ field: 'riskLevel', value: '低' }],
  };
  const rules = [
    { id: 'rule-a', archived: false, published: first, versions: [{ number: 1 }] },
    { id: 'rule-b', archived: false, published: second, versions: [{ number: 1 }] },
  ];
  const flow = {
    ...newFlow(),
    name: '共享变量流程',
    variables: [variable],
    steps: [{ type: 'rule', id: 'rule-a' }, { type: 'rule', id: 'rule-b' }],
  };

  assert.equal(validateFlow(flow, rules, []), null);
  assert.deepEqual(resolveFlowVariables(flow, rules, []), [variable]);
  const snapshot = flowSnapshot(flow, rules, []);
  assert.deepEqual(snapshot.variables, [variable]);
  assert.match(snapshot.steps[0].drl, /setApproved\(true\)/);
  assert.match(snapshot.steps[1].drl, /RuleContext\( approved == true \)/);
  assert.match(snapshot.steps[0].drl, /declare RuleContext/);
  assert.match(snapshot.steps[1].drl, /declare RuleContext/);
});

test('legacy member declarations are compatible, but flow definitions are authoritative', () => {
  const variable = { name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false, enum: null, description: '' };
  const rule = {
    name: '兼容规则', description: '', category: 'common', priority: 0, variables: [variable],
    conditions: [{ fieldSource: 'variable', field: 'approved', operator: '==', value: 'true' }],
    actions: [{ field: 'riskLevel', value: '低' }],
  };
  const asset = { id: 'legacy-variable-rule', archived: false, published: rule, versions: [{ number: 1 }] };
  const legacyFlow = { ...newFlow(), name: '旧变量流程', steps: [{ type: 'rule', id: asset.id }] };
  assert.equal(validateFlow(legacyFlow, [asset], []), null);
  assert.deepEqual(flowSnapshot(legacyFlow, [asset], []).variables, [variable]);

  const mismatched = {
    ...newFlow(),
    name: '变量冲突流程',
    variables: [{ ...variable, defaultValue: true }],
    steps: [{ type: 'rule', id: asset.id }],
  };
  assert.match(validateFlow(mismatched, [asset], []), /定义冲突/);

  const undeclared = {
    ...newFlow(),
    name: '未声明变量流程',
    variables: [{ name: 'other', label: '其他', type: 'Boolean', defaultValue: false, enum: null, description: '' }],
    steps: [{ type: 'rule', id: asset.id }],
  };
  assert.match(validateFlow(undeclared, [asset], []), /未在规则集中定义/);
});

test('rule flow validates, freezes and applies typed step mappings', () => {
  const rule = { name: '映射规则', description: '', conditions: [{ field: 'customerAge', operator: '>=', value: '18' }], actions: [{ field: 'approvedLimit', value: '1000' }], category: '通用', priority: 0 };
  const rules = [{ id: 'rule-map', archived: false, published: rule, versions: [{ number: 1 }] }];
  const flow = {
    ...newFlow(), name: '映射流程',
    steps: [{
      type: 'rule', id: 'rule-map',
      inputMappings: [{ source: 'approvedLimit', target: 'annualIncome' }],
      outputMappings: [{ source: 'approvedLimit', target: 'annualIncome' }],
    }],
  };
  assert.equal(validateFlow(flow, rules, []), null);
  const snapshot = flowSnapshot(flow, rules, []);
  assert.deepEqual(snapshot.steps[0].inputMappings, [{ source: 'approvedLimit', target: 'annualIncome' }]);
  assert.deepEqual(snapshot.steps[0].outputMappings, [{ source: 'approvedLimit', target: 'annualIncome' }]);

  const facts = { approvedLimit: 2500 };
  assert.deepEqual(applyFlowMappings(snapshot.steps[0].inputMappings, facts), [
    { source: 'approvedLimit', target: 'annualIncome', value: 2500, applied: true },
  ]);
  assert.equal(facts.annualIncome, 2500);

  flow.steps[0].inputMappings = [{ source: 'riskLevel', target: 'annualIncome' }];
  assert.match(validateFlow(flow, rules, []), /类型不一致/);
  flow.steps[0].inputMappings = [{ source: 'annualIncome', target: 'approvedLimit' }];
  assert.match(validateFlow(flow, rules, []), /字段方向无效/);
});

test('rule flow freezes typed exclusive branches and selects default fallback', () => {
  const rule = { name: '分支规则', description: '', conditions: [{ field: 'customerAge', operator: '>=', value: '18' }], actions: [{ field: 'riskLevel', value: '低' }], category: '通用', priority: 0 };
  const rules = [{ id: 'rule-branch', archived: false, published: rule, versions: [{ number: 1 }] }];
  const flow = {
    ...newFlow(),
    name: '分支流程',
    branches: [
      { id: 'high-score', name: '高分支', default: false, condition: { field: 'creditScore', operator: '>=', value: '700' }, steps: [{ type: 'rule', id: 'rule-branch' }] },
      { id: 'fallback', name: '默认分支', default: true, condition: null, steps: [{ type: 'rule', id: 'rule-branch' }] },
    ],
  };
  assert.equal(validateFlow(flow, rules, []), null);
  const snapshot = flowSnapshot(flow, rules, []);
  assert.equal(snapshot.branches[0].condition.value, 700);
  assert.equal(selectFlowBranch(snapshot.branches, { creditScore: 750 }).id, 'high-score');
  assert.equal(selectFlowBranch(snapshot.branches, { creditScore: 650 }).id, 'fallback');
});

test('rule flow rejects duplicate defaults and branches without steps', () => {
  const rule = { name: '分支规则', description: '', conditions: [{ field: 'customerAge', operator: '>=', value: '18' }], actions: [{ field: 'riskLevel', value: '低' }], category: '通用', priority: 0 };
  const rules = [{ id: 'rule-branch', archived: false, published: rule, versions: [{ number: 1 }] }];
  const flow = {
    ...newFlow(),
    branches: [
      { id: 'condition', name: '条件分支', condition: { field: 'creditScore', operator: '>=', value: '700' }, steps: [] },
      { id: 'default-1', name: '默认一', default: true, steps: [{ type: 'rule', id: 'rule-branch' }] },
      { id: 'default-2', name: '默认二', default: true, steps: [{ type: 'rule', id: 'rule-branch' }] },
    ],
  };
  assert.match(validateFlow(flow, rules, []), /至少需要一个步骤/);
  flow.branches[0].steps = [{ type: 'rule', id: 'rule-branch' }];
  assert.match(validateFlow(flow, rules, []), /最多一个默认分支/);
});

test('rule group resolves published package members and freezes one combined DRL', () => {
  const rule = { name: '包内规则', description: '', conditions: [{ field: 'customerAge', operator: '>=', value: '18' }], actions: [{ field: 'riskLevel', value: '低' }], category: 'eligibility', priority: 0 };
  const table = cleanTable();
  table.name = '包内决策表';
  table.category = 'eligibility.child';
  const rules = [
    { id: 'rule-published', draft: rule, archived: false, published: rule, versions: [{ number: 2 }] },
    { id: 'rule-draft', draft: { ...rule, name: '未发布规则' }, archived: false, published: null, versions: [] },
  ];
  const tables = [{ id: 'table-published', draft: table, archived: false, published: table, versions: [{ number: 3 }] }];
  const packages = [{ name: 'eligibility' }, { name: 'eligibility.child' }];
  const direct = resolveRuleGroupMembers({ packageName: 'eligibility', includeChildren: false }, rules, tables, packages);
  assert.deepEqual(direct.map(member => member.id), ['rule-published']);
  const recursive = resolveRuleGroupMembers({ packageName: 'eligibility', includeChildren: true }, rules, tables, packages);
  assert.deepEqual(recursive.map(member => member.id).sort(), ['rule-published', 'table-published']);

  const flow = {
    ...newFlow(), name: '规则组流程',
    steps: [{ nodeId: 'group-node', type: 'rule-group', selector: { packageName: 'eligibility', includeChildren: true } }],
  };
  assert.equal(validateFlow(flow, rules, tables, defaultBom(), packages), null);
  const snapshot = flowSnapshot(flow, rules, tables, defaultBom(), packages);
  assert.equal(snapshot.steps[0].type, 'rule-group');
  assert.equal(snapshot.steps[0].nodeId, 'group-node');
  assert.deepEqual(snapshot.steps[0].members.map(member => member.id).sort(), ['rule-published', 'table-published']);
  assert.equal(snapshot.steps[0].memberFingerprint, ruleGroupFingerprint(recursive));
  assert.match(snapshot.steps[0].drl, /包内规则/);
  assert.match(snapshot.steps[0].drl, /包内决策表/);
  assert.equal((snapshot.steps[0].drl.match(/declare RuleInput/g) || []).length, 1);
});

test('rule group draft may be empty but strict validation and duplicate paths reject it', () => {
  const packages = [{ name: 'empty' }, { name: 'common' }];
  const empty = { ...newFlow(), name: '空组草稿', steps: [{ nodeId: 'empty-group', type: 'rule-group', selector: { packageName: 'empty', includeChildren: false } }] };
  assert.equal(validateFlow(empty, [], [], defaultBom(), packages, { allowEmptyRuleGroups: true }), null);
  assert.match(validateFlow(empty, [], [], defaultBom(), packages), /没有已发布/);

  const rule = { name: '重复规则', description: '', conditions: [{ field: 'customerAge', operator: '>=', value: '18' }], actions: [{ field: 'riskLevel', value: '低' }], category: 'common', priority: 0 };
  const rules = [{ id: 'same-rule', draft: rule, archived: false, published: rule, versions: [{ number: 1 }] }];
  const duplicate = {
    ...newFlow(), name: '重复流程',
    steps: [
      { nodeId: 'direct', type: 'rule', id: 'same-rule' },
      { nodeId: 'group', type: 'rule-group', selector: { packageName: 'common', includeChildren: false } },
    ],
  };
  assert.match(validateFlow(duplicate, rules, [], defaultBom(), packages), /重复执行/);
});
