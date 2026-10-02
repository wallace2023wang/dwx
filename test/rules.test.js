import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDrl, newRule, validateRule } from '../shared/rules.js';
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
