import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBom, validateBom, diffBom, findField, inputFields, outputFields, inferSemanticType,
} from '../shared/bom.js';
import { generateDrl, validateRule, parseValue } from '../shared/rules.js';

test('默认 BOM 结构合法且包含 5 个输入 3 个输出', () => {
  const bom = defaultBom();
  assert.equal(validateBom(bom), null);
  assert.equal(inputFields(bom).length, 5);
  assert.equal(outputFields(bom).length, 3);
  assert.ok(bom.fields.every(field => field.factType && field.factTypeLabel && field.semanticType));
  assert.equal(findField(bom, 'annualIncome').semanticType, 'Decimal');
  assert.equal(findField(bom, 'annualIncome').type, 'Double');
  assert.equal(findField(bom, 'riskLevel').semanticType, 'Enum');
});

test('七种业务类型保持独立语义并校验运行时兼容映射', () => {
  const base = defaultBom();
  const input = base.fields.find(field => field.kind === 'input');
  const output = base.fields.find(field => field.kind === 'output');
  const semanticFields = [
    { ...input, key: 'integerValue', type: 'Integer', semanticType: 'Integer', enum: null },
    { ...input, key: 'decimalValue', type: 'Double', semanticType: 'Decimal', enum: null },
    { ...input, key: 'booleanValue', type: 'Boolean', semanticType: 'Boolean', enum: null, min: null, max: null },
    { ...input, key: 'stringValue', type: 'String', semanticType: 'String', enum: null, min: null, max: null, maxLength: 80, regex: '^[A-Z]' },
    { ...input, key: 'enumValue', type: 'String', semanticType: 'Enum', enum: ['A', 'B'], min: null, max: null },
    { ...input, key: 'dateValue', type: 'String', semanticType: 'Date', enum: null, min: null, max: null, control: 'date' },
    { ...output, key: 'listValue', type: 'String', semanticType: 'List<String>', enum: null, min: null, max: null, allowDuplicates: false },
  ];
  assert.equal(validateBom({ fields: semanticFields }), null);
  assert.deepEqual(semanticFields.map(inferSemanticType), ['Integer', 'Decimal', 'Boolean', 'String', 'Enum', 'Date', 'List<String>']);

  const badMapping = structuredClone(semanticFields);
  badMapping[1].type = 'String';
  assert.match(validateBom({ fields: badMapping }), /Decimal.*Double/);

  const missingEnum = structuredClone(semanticFields);
  missingEnum[4].enum = [];
  assert.match(validateBom({ fields: missingEnum }), /Enum.*枚举值/);

  const badRegex = structuredClone(semanticFields);
  badRegex[3].regex = '[';
  assert.match(validateBom({ fields: badRegex }), /有效正则/);
});

test('validateBom 拒绝非法 key、重复 key、错误类型和缺失方向', () => {
  const base = defaultBom();
  const badKey = structuredClone(base);
  badKey.fields[0].key = 'CustomerAge'; // 大写开头
  assert.match(validateBom(badKey), /不合法/);

  const dup = structuredClone(base);
  dup.fields.push({ ...dup.fields[0] });
  assert.match(validateBom(dup), /重复/);

  const badType = structuredClone(base);
  badType.fields[0].type = 'Date';
  assert.match(validateBom(badType), /类型/);

  const noInput = structuredClone(base);
  noInput.fields = noInput.fields.filter(f => f.kind !== 'input');
  assert.match(validateBom(noInput), /input/);
});

test('required 仅允许用于 input 字段', () => {
  const bom = defaultBom();
  bom.fields.find(field => field.kind === 'input').required = true;
  assert.equal(validateBom(bom), null);
  bom.fields.find(field => field.kind === 'output').required = true;
  assert.match(validateBom(bom), /required 只能用于 input/);
});

test('eventTypes 作为 BOM 事件视图并校验字段引用', () => {
  const bom = defaultBom();
  bom.fields.push({
    key: 'eventId', label: '事件 ID', type: 'String', semanticType: 'String', kind: 'input',
    factType: 'BorrowerEvent', factTypeLabel: '借款事件', group: '事件信封', unit: null, min: null, max: null, enum: null, control: 'text', description: '',
  });
  bom.eventTypes = [{
    name: 'BorrowerEvent', label: '借款人事件', version: 1,
    keyField: 'customerAge', timeField: 'eventId', sourceField: 'customerType', retention: '24h', allowedLateness: '5m', duplicateKey: ['eventId'],
    fields: [{ field: 'eventId', required: true }, { field: 'customerAge', required: true }, { field: 'customerType', required: false }],
  }];
  assert.equal(validateBom(bom), null);

  const missingField = structuredClone(bom);
  missingField.eventTypes[0].fields[0].field = 'missingKey';
  assert.match(validateBom(missingField), /不存在的字段/);

  const invalidDuration = structuredClone(bom);
  invalidDuration.eventTypes[0].retention = 'one-day';
  assert.match(validateBom(invalidDuration), /retention/);

  const duplicatedName = structuredClone(bom);
  duplicatedName.eventTypes.push(structuredClone(duplicatedName.eventTypes[0]));
  assert.match(validateBom(duplicatedName), /重复/);
});

test('数值范围 min/max 被 parseValue 执行', () => {
  const bom = defaultBom();
  const age = findField(bom, 'customerAge');
  // min=0, max=150
  assert.equal(parseValue(age, '160'), null);
  assert.equal(parseValue(age, '-5'), null);
  assert.equal(parseValue(age, '35'), '35');
  // String 字段不能配 min/max
  const bad = structuredClone(bom);
  findField(bad, 'customerType').min = 0;
  assert.match(validateBom(bad), /不是数值类型/);
});

test('枚举字段的值必须在枚举列表内', () => {
  const bom = defaultBom();
  const rule = {
    name: 't', description: '', category: '通用', priority: 0,
    conditions: [{ field: 'customerType', operator: '==', value: '个人' }],
    actions: [{ field: 'riskLevel', value: '高' }],
  };
  assert.equal(validateRule(rule, bom), null);
  const bad = structuredClone(rule);
  bad.actions[0].value = '极高'; // 不在 低/中/高 内
  assert.match(validateRule(bad, bom), /风险等级/);
});

test('generateDrl 从自定义 BOM 生成 declare 块', () => {
  const bom = defaultBom();
  // 新增一个字段
  bom.fields.push({
    key: 'occupation', label: '职业', type: 'String', kind: 'input',
    group: '客户基本信息', unit: null, min: null, max: null, enum: null, control: 'text', description: '',
  });
  const rule = {
    name: 't', description: '', category: '通用', priority: 0,
    conditions: [{ field: 'occupation', operator: '==', value: '教师' }],
    actions: [{ field: 'riskLevel', value: '低' }],
  };
  const drl = generateDrl([rule], bom);
  assert.match(drl, /occupation : String/);
  assert.match(drl, /occupation == "教师"/);
});

test('diffBom 检测删除、类型变更和枚举收缩', () => {
  const oldBom = defaultBom();
  const newBom = structuredClone(oldBom);
  // 删除 creditScore，但它被 usedKeys 引用 → error
  newBom.fields = newBom.fields.filter(f => f.key !== 'creditScore');
  // 改 riskLevel 类型
  newBom.fields.find(f => f.key === 'riskLevel').type = 'Boolean';
  // 枚举收缩：customerType 去掉"同业"
  newBom.fields.find(f => f.key === 'customerType').enum = ['个人', '企业'];
  const used = new Set(['creditScore']);
  const { errors, warnings } = diffBom(oldBom, newBom, used);
  assert.ok(errors.some(e => /信用评分.*不能删除/.test(e)));
  assert.ok(warnings.some(w => /风险等级.*类型由 String 变更为 Boolean/.test(w)));
  assert.ok(warnings.some(w => /枚举收缩/));
});

test('未被引用的字段删除不报错', () => {
  const oldBom = defaultBom();
  const newBom = structuredClone(oldBom);
  newBom.fields = newBom.fields.filter(f => f.key !== 'overdue');
  const { errors } = diffBom(oldBom, newBom, new Set());
  assert.equal(errors.length, 0);
});
