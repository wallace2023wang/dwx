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
