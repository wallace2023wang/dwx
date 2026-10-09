import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBom } from '../shared/bom.js';
import { expandRuleTemplate, newRuleTemplate, ruleTemplateDrl, ruleTemplateExecutionTrace, validateRuleTemplate } from '../shared/rule-templates.js';

function sampleTemplate() {
  const template = newRuleTemplate(defaultBom());
  template.name = '年龄风险模板';
  template.category = 'templates';
  template.parameters = [
    { id: 'age-param', name: 'minimumAge', label: '最低年龄', type: 'Integer', defaultValue: '18' },
    { id: 'risk-param', name: 'risk', label: '风险等级', type: 'Enum', enum: ['低', '中', '高'], defaultValue: '低' },
  ];
  template.blueprint = {
    conditions: [{ field: 'customerAge', operator: '>=', parameter: 'minimumAge' }],
    actions: [{ field: 'riskLevel', parameter: 'risk' }],
  };
  template.instances = [
    { id: 'adult', name: '成年人', enabled: true, priorityOffset: 0, values: { minimumAge: '18', risk: '低' } },
    { id: 'senior', name: '老年客户', enabled: true, priorityOffset: 1, values: { minimumAge: '65', risk: '中' } },
  ];
  return template;
}

test('rule template expands enabled instances into validated BAL rules', () => {
  const template = sampleTemplate();
  assert.equal(validateRuleTemplate(template, defaultBom()), null);
  const rules = expandRuleTemplate(template, defaultBom());
  assert.deepEqual(rules.map(rule => rule.name), ['年龄风险模板 / 成年人', '年龄风险模板 / 老年客户']);
  assert.equal(rules[1].conditions[0].value, '65');
  assert.equal(rules[1].actions[0].value, '中');
  const drl = ruleTemplateDrl(template, defaultBom());
  assert.match(drl, /customerAge >= 18/);
  assert.match(drl, /customerAge >= 65/);
  assert.match(drl, /setRiskLevel\("中"\)/);
});

test('rule template rejects incompatible slots and invalid instance values', () => {
  const incompatible = sampleTemplate();
  incompatible.blueprint.conditions[0].parameter = 'risk';
  assert.match(validateRuleTemplate(incompatible, defaultBom()), /类型不匹配/);
  const invalid = sampleTemplate();
  invalid.instances[0].values.minimumAge = 'abc';
  assert.match(validateRuleTemplate(invalid, defaultBom()), /类型 Integer 不匹配/);
});

test('rule template execution trace maps fired rules to instances', () => {
  const template = sampleTemplate();
  const trace = ruleTemplateExecutionTrace(template, ['年龄风险模板 / 老年客户 [2]']);
  assert.deepEqual(trace.map(item => [item.instanceId, item.fired]), [['adult', false], ['senior', true]]);
});
