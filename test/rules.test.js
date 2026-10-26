import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDrl,
  migrateLegacyRuleOperators,
  newRule,
  validateRule,
  validateRuleBomCompatibility,
} from '../shared/rules.js';
import { defaultBom } from '../shared/bom.js';

// 语法测试用的宽松 BOM：去掉枚举值域，避免业务约束干扰字符串转义等语言层测试。
function looseBom() {
  const bom = structuredClone(defaultBom());
  for (const f of bom.fields) f.enum = null;
  return bom;
}

function operatorBom() {
  const bom = structuredClone(defaultBom());
  bom.fields.push(
    { key: 'textValue', label: '文本值', type: 'String', semanticType: 'String', kind: 'input', enum: null },
    { key: 'textOther', label: '另一文本', type: 'String', semanticType: 'String', kind: 'input', enum: null },
    { key: 'dateValue', label: '业务日期', type: 'String', semanticType: 'Date', kind: 'input', enum: null },
    { key: 'dateOther', label: '另一日期', type: 'String', semanticType: 'Date', kind: 'input', enum: null },
    { key: 'listValue', label: '标签列表', type: 'String', semanticType: 'List<String>', kind: 'input', enum: null },
  );
  return bom;
}

function ruleWith(condition, name = '操作符测试') {
  return { ...newRule(), name, conditions: [condition] };
}

test('valid rule generates a declared fact and action', () => {
  const rule = newRule();
  assert.equal(validateRule(rule), null);
  const drl = generateDrl([rule]);
  assert.match(drl, /declare RuleInput/);
  assert.match(drl, /customerAge : java\.lang\.Integer/);
  assert.match(drl, /overdue : java\.lang\.Boolean/);
  assert.match(drl, /customerAge >= 18/);
  assert.match(drl, /setRiskLevel\("低"\)/);
});

test('invalid values and duplicate action fields are rejected', () => {
  const rule = newRule();
  rule.conditions[0].value = 'not a number';
  assert.match(validateRule(rule), /客户年龄/);
  rule.conditions[0].value = '18';
  rule.actions.push({ field: 'riskLevel', value: '中' });
  assert.match(validateRule(rule), /重复/);
});

test('string literals are escaped for DRL', () => {
  const rule = newRule();
  rule.actions[0].value = '高"风险';
  assert.match(generateDrl([rule], looseBom()), /setRiskLevel\("高\\"风险"\)/);
});

test('double outputs use a Java double literal and integers stay in range', () => {
  const rule = newRule();
  rule.actions = [{ field: 'approvedLimit', value: '10000' }];
  assert.match(generateDrl([rule]), /setApprovedLimit\(10000d\)/);
  rule.conditions[0].value = '2147483648';
  assert.match(validateRule(rule), /客户年龄/);
});

test('generated rule metadata emits deterministic salience and activation group', () => {
  const rule = { ...newRule(), salience: 42, activationGroup: 'decision-table:test' };
  const drl = generateDrl([rule]);
  assert.match(drl, /salience 42/);
  assert.match(drl, /activation-group "decision-table:test"/);
});

test('BAL quantifiers and OR connectors generate Drools conditional elements', () => {
  const base = newRule();
  base.conditions = [
    { field: 'customerAge', operator: '<', value: '18', quantifier: 'none', connector: 'and' },
    { field: 'creditScore', operator: '<', value: '600', quantifier: 'exists', connector: 'or' },
  ];
  const drl = generateDrl([base]);
  assert.match(drl, /\$input : RuleInput\(\)/);
  assert.match(drl, /not RuleInput\( customerAge < 18 \)/);
  assert.match(drl, /\bor\b/);
  assert.match(drl, /exists RuleInput\( creditScore < 600 \)/);

  base.conditions = [{ field: 'customerAge', operator: '<', value: '18', quantifier: 'all' }];
  assert.match(generateDrl([base]), /forall\( RuleInput\(\) RuleInput\( customerAge < 18 \) \)/);
});

test('nested condition groups preserve explicit boolean precedence', () => {
  const rule = newRule();
  rule.conditions = [];
  rule.conditionTree = {
    type: 'group',
    operator: 'or',
    children: [
      {
        type: 'group', operator: 'and', children: [
          { type: 'condition', condition: { field: 'customerAge', operator: '>=', value: '18' } },
          { type: 'condition', condition: { field: 'creditScore', operator: '>=', value: '600' } },
        ],
      },
      {
        type: 'group', operator: 'and', children: [
          { type: 'condition', condition: { field: 'customerType', operator: '==', value: '企业' } },
          { type: 'condition', condition: { field: 'overdue', operator: '==', value: 'false' } },
        ],
      },
    ],
  };

  assert.equal(validateRule(rule), null);
  const drl = generateDrl([rule]);
  assert.match(drl, /\(\n        \(\n            RuleInput\( this == \$input, customerAge >= 18 \)\n            and\n            RuleInput\( this == \$input, creditScore >= 600 \)\n        \)\n        or/);
  assert.match(drl, /RuleInput\( this == \$input, customerType == "企业" \)/);
  assert.match(drl, /RuleInput\( this == \$input, overdue == false \)/);
});

test('nested condition groups reject malformed and overly deep trees', () => {
  const rule = newRule();
  rule.conditionTree = { type: 'group', operator: 'xor', children: [] };
  assert.match(validateRule(rule), /运算符/);

  let tree = { type: 'condition', condition: rule.conditions[0] };
  for (let index = 0; index < 6; index += 1) {
    tree = { type: 'group', operator: 'and', children: [tree, { type: 'condition', condition: rule.conditions[0] }] };
  }
  rule.conditionTree = tree;
  assert.match(validateRule(rule), /最多支持 5 层/);
});

test('numeric action expressions generate deterministic field arithmetic and functions', () => {
  const rule = newRule();
  rule.actions = [{
    field: 'approvedLimit',
    value: '',
    valueExpression: {
      type: 'function',
      name: 'min',
      args: [
        { type: 'binary', operator: '*', left: { type: 'field', field: 'annualIncome' }, right: { type: 'literal', value: '0.3' } },
        { type: 'literal', value: '100000' },
      ],
    },
  }];

  assert.equal(validateRule(rule), null);
  assert.match(generateDrl([rule]), /setApprovedLimit\(\(double\) \(Math\.min\(\(\$input\.getAnnualIncome\(\) \* 0\.3d\), 100000\)\)\)/);
});

test('numeric action expressions support project variables and reject unsafe shapes', () => {
  const rule = newRule();
  rule.variables = [{ name: 'multiplier', label: '系数', type: 'Double', defaultValue: 0.5 }];
  rule.actions = [{
    field: 'approvedLimit', value: '', valueExpression: {
      type: 'binary', operator: '*',
      left: { type: 'field', field: 'annualIncome' },
      right: { type: 'field', fieldSource: 'variable', field: 'multiplier' },
    },
  }];
  assert.equal(validateRule(rule), null);
  const drl = generateDrl([rule]);
  assert.match(drl, /\$ctx : RuleContext\(\)/);
  assert.match(drl, /\$ctx\.getMultiplier\(\)/);

  rule.actions[0].valueExpression = { type: 'binary', operator: '/', left: { type: 'literal', value: '1' }, right: { type: 'literal', value: '0' } };
  assert.match(validateRule(rule), /除以 0/);
  rule.actions[0].valueExpression = { type: 'function', name: 'system', args: [{ type: 'literal', value: '1' }] };
  assert.match(validateRule(rule), /函数无效/);
  rule.actions[0].valueExpression = { type: 'field', field: 'riskLevel' };
  assert.match(validateRule(rule), /不是数值输入字段/);
});

test('structured BAL conditions compare compatible input fields without quoting the right operand', () => {
  const rule = newRule();
  rule.conditions = [{
    field: 'customerAge', operator: '>=', valueSource: 'field', valueField: 'creditScore', value: '',
  }];

  assert.equal(validateRule(rule), null);
  assert.match(generateDrl([rule]), /RuleInput\( customerAge >= creditScore \)/);
  assert.doesNotMatch(generateDrl([rule]), /customerAge >= "creditScore"/);
});

test('structured BAL field operands must be input fields of the same semantic type and not self references', () => {
  const rule = newRule();
  const compareWith = valueField => {
    rule.conditions = [{
      field: 'customerAge', operator: '>=', valueSource: 'field', valueField, value: '',
    }];
    return validateRule(rule);
  };

  assert.match(compareWith('customerType'), /同类型/);
  assert.match(compareWith('approvedLimit'), /不存在或不是输入字段/);
  assert.match(compareWith('customerAge'), /不能与自身比较/);
  assert.match(compareWith('missingField'), /不存在或不是输入字段/);
  rule.conditions[0].valueSource = 'expression';
  assert.match(validateRule(rule), /值来源无效/);
});

test('legacy BAL literal conditions keep their original validation and DRL output', () => {
  const rule = newRule();
  assert.equal(rule.conditions[0].valueSource, undefined);
  assert.equal(validateRule(rule), null);
  assert.match(generateDrl([rule]), /RuleInput\( customerAge >= 18 \)/);
});

test('legacy List<String> equality operators migrate immutably to membership operators', () => {
  const bom = operatorBom();
  const legacy = {
    ...newRule(),
    conditions: [
      { field: 'listValue', operator: '==', value: '高风险' },
      { field: 'listValue', operator: '!=', value: '已失效', connector: 'and' },
    ],
  };
  const original = structuredClone(legacy);

  const migrated = migrateLegacyRuleOperators(legacy, bom);

  assert.deepEqual(legacy, original);
  assert.notEqual(migrated.rule, legacy);
  assert.deepEqual(migrated.rule.conditions.map(condition => condition.operator), ['contains', 'not contains']);
  assert.deepEqual(migrated.migrations, [
    '标签列表：== 已转换为 contains',
    '标签列表：!= 已转换为 not contains',
  ]);
  assert.equal(validateRuleBomCompatibility(legacy, bom), '标签列表不支持 == 操作符');
  assert.equal(validateRuleBomCompatibility(migrated.rule, bom), null);
  assert.equal(validateRule(migrated.rule, bom), null);
  const drl = generateDrl([migrated.rule], bom);
  assert.match(drl, /listValue != null && listValue\.contains\("高风险"\)/);
  assert.match(drl, /listValue != null && !listValue\.contains\("已失效"\)/);
});

test('legacy List<String> equality operators migrate inside nested condition trees', () => {
  const bom = operatorBom();
  const legacy = {
    ...newRule(),
    conditions: [],
    conditionTree: {
      type: 'group',
      operator: 'and',
      children: [
        { type: 'condition', condition: { field: 'listValue', operator: '==', value: '高风险' } },
        { type: 'condition', condition: { field: 'listValue', operator: '!=', value: '已失效' } },
      ],
    },
  };

  const { rule, migrations } = migrateLegacyRuleOperators(legacy, bom);

  assert.deepEqual(rule.conditionTree.children.map(node => node.condition.operator), ['contains', 'not contains']);
  assert.equal(migrations.length, 2);
  assert.equal(validateRuleBomCompatibility(rule, bom), null);
  assert.equal(validateRule(rule, bom), null);
});

test('legacy operator migration leaves ambiguous and unrelated conditions unchanged', () => {
  const bom = operatorBom();
  const conditions = [
    { field: 'textValue', operator: '==', value: '高风险' },
    { field: 'listValue', operator: '==', valueSource: 'field', valueField: 'textOther', value: '' },
    { fieldSource: 'variable', field: 'flag', operator: '==', value: 'true' },
    { field: 'listValue', operator: 'starts with', value: '高' },
    { field: 'removedField', operator: '==', value: '高风险' },
  ];
  const legacy = { ...newRule(), conditions };

  const migrated = migrateLegacyRuleOperators(legacy, bom);

  assert.equal(migrated.rule, legacy);
  assert.deepEqual(migrated.rule.conditions, conditions);
  assert.deepEqual(migrated.migrations, []);
});

test('BAL range, date, string, enum, and serialized-list operators generate executable constraints', () => {
  const bom = operatorBom();
  const rules = [
    ruleWith({ field: 'customerAge', operator: 'between', value: '18', valueEnd: '65' }, '数字介于'),
    ruleWith({ field: 'dateValue', operator: 'before', value: '2026-10-01' }, '日期早于'),
    ruleWith({ field: 'dateValue', operator: 'after', value: '2026-01-01' }, '日期晚于'),
    ruleWith({ field: 'dateValue', operator: 'between', value: '2026-01-01', valueEnd: '2026-12-31' }, '日期介于'),
    ruleWith({ field: 'textValue', operator: 'contains', value: '企业' }, '文本包含'),
    ruleWith({ field: 'textValue', operator: 'not contains', value: '个人' }, '文本不包含'),
    ruleWith({ field: 'textValue', operator: 'starts with', value: '华东' }, '文本开头'),
    ruleWith({ field: 'textValue', operator: 'ends with', value: '公司' }, '文本结尾'),
    ruleWith({ field: 'textValue', operator: 'matches', value: '^A[0-9]+$' }, '文本正则'),
    ruleWith({ field: 'customerType', operator: 'in', value: '', values: ['个人', '企业'] }, '枚举属于'),
    ruleWith({ field: 'customerType', operator: 'not in', value: '', values: ['同业'] }, '枚举不属于'),
    ruleWith({ field: 'listValue', operator: 'contains', value: '高风险' }, '列表包含'),
    ruleWith({ field: 'listValue', operator: 'not contains', value: '已失效' }, '列表不包含'),
    ruleWith({ field: 'listValue', operator: 'size >', value: '2' }, '列表长度大于'),
    ruleWith({ field: 'listValue', operator: 'size <', value: '20' }, '列表长度小于'),
  ];

  for (const rule of rules) assert.equal(validateRule(rule, bom), null, rule.name);
  const drl = generateDrl(rules, bom);
  assert.match(drl, /customerAge >= 18 && customerAge <= 65/);
  assert.match(drl, /dateValue\.compareTo\("2026-10-01"\) < 0/);
  assert.match(drl, /dateValue\.compareTo\("2026-01-01"\) > 0/);
  assert.match(drl, /dateValue\.compareTo\("2026-01-01"\) >= 0 && dateValue\.compareTo\("2026-12-31"\) <= 0/);
  assert.match(drl, /textValue\.contains\("企业"\)/);
  assert.match(drl, /!textValue\.contains\("个人"\)/);
  assert.match(drl, /textValue\.startsWith\("华东"\)/);
  assert.match(drl, /textValue\.endsWith\("公司"\)/);
  assert.match(drl, /textValue\.matches\("\^A\[0-9\]\+\$"\)/);
  assert.match(drl, /customerType in \("个人", "企业"\)/);
  assert.match(drl, /customerType not in \("同业"\)/);
  assert.match(drl, /listValue\.contains\("高风险"\)/);
  assert.match(drl, /!listValue\.contains\("已失效"\)/);
  assert.match(drl, /listValue\.length\(\) > 2/);
  assert.match(drl, /listValue\.length\(\) < 20/);
});

test('extended BAL operators reject malformed structured values and incompatible field operands', () => {
  const bom = operatorBom();
  assert.match(validateRule(ruleWith({ field: 'customerAge', operator: 'between', value: '65', valueEnd: '18' }), bom), /下界不能大于上界/);
  assert.match(validateRule(ruleWith({ field: 'dateValue', operator: 'before', value: '2026-02-30' }), bom), /条件值无效/);
  assert.match(validateRule(ruleWith({ field: 'textValue', operator: 'matches', value: '[invalid' }), bom), /正则表达式无效/);
  assert.match(validateRule(ruleWith({ field: 'customerType', operator: 'in', value: '', values: [] }), bom), /至少选择一个/);
  assert.match(validateRule(ruleWith({ field: 'customerType', operator: 'in', value: '', values: ['未知'] }), bom), /枚举条件值无效/);
  assert.match(validateRule(ruleWith({ field: 'listValue', operator: 'size >', value: '-1' }), bom), /长度必须/);
  assert.match(validateRule(ruleWith({ field: 'textValue', operator: 'between', value: 'a', valueEnd: 'z' }), bom), /字段或运算符无效/);
  assert.match(validateRule(ruleWith({ field: 'customerType', operator: 'in', valueSource: 'field', valueField: 'customerType', value: '' }), bom), /不支持业务字段值/);
});

test('extended string and date operators support compatible business-field operands', () => {
  const bom = operatorBom();
  const rules = [
    ruleWith({ field: 'textValue', operator: 'contains', valueSource: 'field', valueField: 'textOther', value: '' }, '字段文本包含'),
    ruleWith({ field: 'textValue', operator: 'not contains', valueSource: 'field', valueField: 'textOther', value: '' }, '字段文本不包含'),
    ruleWith({ field: 'textValue', operator: 'starts with', valueSource: 'field', valueField: 'textOther', value: '' }, '字段文本开头'),
    ruleWith({ field: 'textValue', operator: 'ends with', valueSource: 'field', valueField: 'textOther', value: '' }, '字段文本结尾'),
    ruleWith({ field: 'textValue', operator: 'matches', valueSource: 'field', valueField: 'textOther', value: '' }, '字段文本正则'),
    ruleWith({ field: 'dateValue', operator: 'before', valueSource: 'field', valueField: 'dateOther', value: '' }, '字段日期早于'),
    ruleWith({ field: 'dateValue', operator: 'after', valueSource: 'field', valueField: 'dateOther', value: '' }, '字段日期晚于'),
  ];
  const drl = generateDrl(rules, bom);
  assert.match(drl, /textValue\.contains\(textOther\)/);
  assert.match(drl, /!textValue\.contains\(textOther\)/);
  assert.match(drl, /textValue\.startsWith\(textOther\)/);
  assert.match(drl, /textValue\.endsWith\(textOther\)/);
  assert.match(drl, /textValue\.matches\(textOther\)/);
  assert.match(drl, /dateValue\.compareTo\(dateOther\) < 0/);
  assert.match(drl, /dateValue\.compareTo\(dateOther\) > 0/);
});

test('Ruleset Variables are declared separately from BOM and can be read and written', () => {
  const rule = newRule();
  rule.variables = [
    { name: 'pctAtLeastMax', label: '浓度达到最大值', type: 'Boolean', defaultValue: false },
    { name: 'phaseCandidate', label: '候选阶段', type: 'String', defaultValue: 'FILLING', enum: ['FILLING', 'CIRCULATION'] },
  ];
  rule.conditions = [{ fieldSource: 'variable', field: 'pctAtLeastMax', operator: '==', value: 'true' }];
  rule.actions = [{ fieldSource: 'variable', field: 'phaseCandidate', value: 'CIRCULATION' }];

  assert.equal(validateRule(rule), null);
  const drl = generateDrl([rule]);
  assert.match(drl, /declare RuleContext/);
  assert.match(drl, /pctAtLeastMax : java\.lang\.Boolean/);
  assert.match(drl, /phaseCandidate : String/);
  assert.match(drl, /\$ctx : RuleContext\( pctAtLeastMax == true \)/);
  assert.match(drl, /modify\(\$ctx\)/);
  assert.doesNotMatch(drl, /pctAtLeastMax :.*RuleInput/);
});

test('Ruleset Variables reject undeclared references, invalid defaults, duplicates, and BOM collisions', () => {
  const rule = newRule();
  rule.variables = [{ name: 'flag', label: '标记', type: 'Boolean', defaultValue: 'yes' }];
  assert.match(validateRule(rule), /默认值无效/);

  rule.variables = [
    { name: 'flag', label: '标记', type: 'Boolean', defaultValue: false },
    { name: 'flag', label: '另一个标记', type: 'Boolean', defaultValue: false },
  ];
  assert.match(validateRule(rule), /重复/);

  rule.variables = [{ name: 'customerAge', label: '年龄副本', type: 'Integer', defaultValue: 18 }];
  assert.match(validateRule(rule), /BOM/);

  rule.variables = [{ name: 'flag', label: '标记', type: 'Boolean', defaultValue: false }];
  rule.conditions = [{ fieldSource: 'variable', field: 'missing', operator: '==', value: 'true' }];
  assert.match(validateRule(rule), /条件变量/);
});
