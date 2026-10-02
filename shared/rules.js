import { defaultBom, findField, inferSemanticType } from './bom.js';
import { canonicalPackageName, DEFAULT_PACKAGE_NAME, PACKAGE_NAME_RE } from './packages.js';

// 向后兼容：现有测试和代码可能 import { fields }。
// 真实运行时由 server/index.js 从 data/bom.json 加载并传入 generateDrl/validateRule。
const DEFAULT_BOM = defaultBom();
export const fields = DEFAULT_BOM.fields;

export const operators = [
  { key: '==', label: '等于' },
  { key: '!=', label: '不等于' },
  { key: '>', label: '大于' },
  { key: '>=', label: '大于等于' },
  { key: '<', label: '小于' },
  { key: '<=', label: '小于等于' },
];

const BAL_OPERATORS_BY_TYPE = Object.freeze({
  Integer: ['==', '!=', '>', '<', '>=', '<=', 'between'],
  Decimal: ['==', '!=', '>', '<', '>=', '<=', 'between'],
  Boolean: ['==', '!='],
  String: ['==', '!=', 'contains', 'not contains', 'starts with', 'ends with', 'matches'],
  Enum: ['==', '!=', 'in', 'not in'],
  Date: ['==', '!=', 'before', 'after', 'between'],
  'List<String>': ['contains', 'not contains', 'size >', 'size <'],
});

const FIELD_VALUE_OPERATORS_BY_TYPE = Object.freeze({
  Integer: ['==', '!=', '>', '<', '>=', '<='],
  Decimal: ['==', '!=', '>', '<', '>=', '<='],
  Boolean: ['==', '!='],
  String: ['==', '!=', 'contains', 'not contains', 'starts with', 'ends with', 'matches'],
  Enum: ['==', '!='],
  Date: ['==', '!=', 'before', 'after'],
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(value) {
  return ISO_DATE_RE.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export const newRule = () => ({
  name: '未命名规则',
  description: '',
  category: DEFAULT_PACKAGE_NAME,
  priority: 0,
  conditions: [{ field: 'customerAge', operator: '>=', value: '18' }],
  actions: [{ field: 'riskLevel', value: '低' }],
});

/**
 * 把用户输入的值转成 DRL 字面量。
 * field 来自 BOM；返回 DRL 片段字符串，非法时返回 null。
 */
export function parseValue(field, raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (inferSemanticType(field) === 'Date') return validIsoDate(trimmed) ? JSON.stringify(trimmed) : null;
  if (field.type === 'String') {
    // 枚举字段：值必须在枚举列表内
    if (field.enum && !field.enum.includes(trimmed)) return null;
    return JSON.stringify(trimmed);
  }
  if (field.type === 'Boolean') {
    if (!['true', 'false'].includes(trimmed)) return null;
    return trimmed;
  }
  if (!Number.isFinite(Number(trimmed))) return null;
  if (field.type === 'Integer') {
    if (!/^-?\d+$/.test(trimmed) || Number(trimmed) < -2147483648 || Number(trimmed) > 2147483647) return null;
    const n = Number(trimmed);
    if (field.min != null && n < field.min) return null;
    if (field.max != null && n > field.max) return null;
    return String(n);
  }
  // Double
  const n = Number(trimmed);
  if (field.min != null && n < field.min) return null;
  if (field.max != null && n > field.max) return null;
  return `${n}d`;
}

export function formatDrlValue(field, raw) { return parseValue(field, raw); }

function validateLiteralCondition(item, field) {
  const semanticType = inferSemanticType(field);
  if (item.operator === 'between') {
    const lower = parseValue(field, item.value);
    const upper = parseValue(field, item.valueEnd);
    if (lower === null || upper === null) return `${field.label}的区间上下界无效`;
    const reversed = semanticType === 'Date'
      ? item.value > item.valueEnd
      : Number(item.value) > Number(item.valueEnd);
    if (reversed) return `${field.label}的区间下界不能大于上界`;
    return null;
  }
  if (item.operator === 'in' || item.operator === 'not in') {
    if (!Array.isArray(item.values) || item.values.length < 1 || item.values.length > 50) return `${field.label}请至少选择一个枚举值`;
    if (new Set(item.values).size !== item.values.length || item.values.some(value => parseValue(field, value) === null)) return `${field.label}的枚举条件值无效`;
    return null;
  }
  if (item.operator === 'matches') {
    if (parseValue(field, item.value) === null) return `${field.label}的正则表达式无效`;
    try { new RegExp(item.value); } catch { return `${field.label}的正则表达式无效`; }
    return null;
  }
  if (item.operator === 'size >' || item.operator === 'size <') {
    if (!/^\d+$/.test(item.value || '') || Number(item.value) > 1000000) return `${field.label}的长度必须是 0–1000000 的整数`;
    return null;
  }
  return parseValue(field, item.value) === null ? `${field.label}的条件值无效` : null;
}

function fieldConstraint(item, field) {
  const semanticType = inferSemanticType(field);
  if (semanticType === 'Date') {
    if (item.operator === 'before') return `${item.field} != null && ${item.valueField} != null && ${item.field}.compareTo(${item.valueField}) < 0`;
    if (item.operator === 'after') return `${item.field} != null && ${item.valueField} != null && ${item.field}.compareTo(${item.valueField}) > 0`;
  }
  if (semanticType === 'String') {
    if (item.operator === 'contains') return `${item.field} != null && ${item.valueField} != null && ${item.field}.contains(${item.valueField})`;
    if (item.operator === 'not contains') return `${item.field} != null && ${item.valueField} != null && !${item.field}.contains(${item.valueField})`;
    if (item.operator === 'starts with') return `${item.field} != null && ${item.valueField} != null && ${item.field}.startsWith(${item.valueField})`;
    if (item.operator === 'ends with') return `${item.field} != null && ${item.valueField} != null && ${item.field}.endsWith(${item.valueField})`;
    if (item.operator === 'matches') return `${item.field} != null && ${item.valueField} != null && ${item.field}.matches(${item.valueField})`;
  }
  return `${item.field} ${item.operator} ${item.valueField}`;
}

function literalConstraint(item, field) {
  const semanticType = inferSemanticType(field);
  if (item.operator === 'between') {
    const lower = parseValue(field, item.value);
    const upper = parseValue(field, item.valueEnd);
    if (semanticType === 'Date') return `${item.field} != null && ${item.field}.compareTo(${lower}) >= 0 && ${item.field}.compareTo(${upper}) <= 0`;
    return `${item.field} >= ${lower} && ${item.field} <= ${upper}`;
  }
  if (item.operator === 'in' || item.operator === 'not in') {
    return `${item.field} ${item.operator} (${item.values.map(value => parseValue(field, value)).join(', ')})`;
  }
  const value = parseValue(field, item.value);
  if (semanticType === 'Date') {
    if (item.operator === 'before') return `${item.field} != null && ${item.field}.compareTo(${value}) < 0`;
    if (item.operator === 'after') return `${item.field} != null && ${item.field}.compareTo(${value}) > 0`;
  }
  if (semanticType === 'String' || semanticType === 'List<String>') {
    if (item.operator === 'contains') return `${item.field} != null && ${item.field}.contains(${value})`;
    if (item.operator === 'not contains') return `${item.field} != null && !${item.field}.contains(${value})`;
    if (item.operator === 'starts with') return `${item.field} != null && ${item.field}.startsWith(${value})`;
    if (item.operator === 'ends with') return `${item.field} != null && ${item.field}.endsWith(${value})`;
    if (item.operator === 'matches') return `${item.field} != null && ${item.field}.matches(${value})`;
    if (item.operator === 'size >' || item.operator === 'size <') return `${item.field} != null && ${item.field}.length() ${item.operator.slice(5)} ${Number(item.value)}`;
  }
  return `${item.field} ${item.operator} ${value}`;
}

/**
 * 校验规则。bom 缺省用内置默认 BOM。
 */
export function validateRule(rule, bom = DEFAULT_BOM) {
  if (!rule || typeof rule !== 'object') return '规则内容无效';
  if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 80) return '规则名称需为 1–80 个字符';
  if (typeof rule.description !== 'string' || rule.description.length > 500) return '规则说明不能超过 500 个字符';
  if (typeof rule.category !== 'string' || !PACKAGE_NAME_RE.test(canonicalPackageName(rule.category))) return '规则包需为有效英文包名';
  if (!Number.isInteger(rule.priority) || rule.priority < -1000 || rule.priority > 1000) return '优先级需为 -1000 到 1000 的整数';
  if (rule.salience != null && (!Number.isInteger(rule.salience) || rule.salience < -2147483648 || rule.salience > 2147483647)) return '内部执行顺序无效';
  if (rule.activationGroup != null && (typeof rule.activationGroup !== 'string' || !rule.activationGroup || rule.activationGroup.length > 200)) return '内部互斥分组无效';
  if (!Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > 20) return '至少需要一个条件，最多 20 个';
  if (!Array.isArray(rule.actions) || rule.actions.length < 1 || rule.actions.length > 20) return '至少需要一个动作，最多 20 个';
  for (const [index, item] of rule.conditions.entries()) {
    if (item.raw || item.pattern) continue; // 决策表生成的内联 DRL 片段，跳过字段校验
    const field = findField(bom, item.field);
    const semanticType = field ? inferSemanticType(field) : null;
    if (!field || field.kind !== 'input' || !BAL_OPERATORS_BY_TYPE[semanticType]?.includes(item.operator)) return '条件字段或运算符无效';
    if (item.quantifier != null && !['one', 'exists', 'all', 'none'].includes(item.quantifier)) return '条件量词无效';
    if (index > 0 && item.connector != null && !['and', 'or'].includes(item.connector)) return '条件连接词无效';
    if (item.valueSource != null && !['literal', 'field'].includes(item.valueSource)) return '条件值来源无效';
    if (item.valueSource === 'field') {
      if (!FIELD_VALUE_OPERATORS_BY_TYPE[semanticType]?.includes(item.operator)) return `${field.label}的${item.operator}操作不支持业务字段值`;
      const valueField = findField(bom, item.valueField);
      if (!valueField || valueField.kind !== 'input') return `${field.label}用于比较的业务字段不存在或不是输入字段`;
      if (valueField.key === field.key) return `${field.label}不能与自身比较`;
      if (inferSemanticType(valueField) !== inferSemanticType(field)) return `${field.label}只能与同类型业务字段比较`;
    } else {
      const valueIssue = validateLiteralCondition(item, field);
      if (valueIssue) return valueIssue;
    }
  }
  const actionKeys = new Set();
  for (const item of rule.actions) {
    const field = findField(bom, item.field);
    if (!field || field.kind !== 'output' || actionKeys.has(item.field)) return '动作字段无效或重复';
    actionKeys.add(item.field);
    if (parseValue(field, item.value) === null) return `${field.label}的动作值无效`;
  }
  return null;
}

/**
 * 生成完整 DRL。declare RuleInput 块从 BOM 动态生成。
 */
function drlString(value) {
  return JSON.stringify(String(value));
}

function collectHitLines(rule, ruleName) {
  if (!rule.collectHit) return [];
  const lines = ['    java.util.Map $hitOutputs = new java.util.LinkedHashMap();'];
  for (const action of rule.actions) {
    lines.push(`    $hitOutputs.put(${drlString(action.field)}, ${drlString(action.value)});`);
  }
  lines.push(
    '    DecisionHit $hit = new DecisionHit();',
    `    $hit.setTableName(${drlString(rule.collectHit.tableName || '')});`,
    `    $hit.setRuleName(${drlString(ruleName)});`,
    `    $hit.setRowIndex(${Number.isInteger(rule.collectHit.rowIndex) ? rule.collectHit.rowIndex : -1});`,
    `    $hit.setDefaultRow(${rule.collectHit.defaultRow === true ? 'true' : 'false'});`,
    '    $hit.setOutputs($hitOutputs);',
    '    insert($hit);',
  );
  return lines;
}

export function generateDrl(rules, bom = DEFAULT_BOM) {
  for (const rule of rules) {
    const error = validateRule(rule, bom);
    if (error) throw new Error(`${rule?.name || '规则'}：${error}`);
  }
  const hasDecisionHits = rules.some(rule => rule.collectHit);
  const lines = [
    'package workbench',
    '',
    '// 与业务系统交换的事实类型；输入字段由调用方设置，动作写回输出字段。',
    'declare RuleInput',
    ...bom.fields.map(f => `    ${f.key} : ${f.type}`),
    'end',
  ];
  if (hasDecisionHits) {
    lines.push('', '// COLLECT 命中策略输出的独立命中结果集合。', 'declare DecisionHit', '    tableName : String', '    ruleName : String', '    rowIndex : Integer', '    defaultRow : Boolean', '    outputs : java.util.Map', 'end');
  }
  for (const [index, rule] of rules.entries()) {
    const ruleName = `${rule.name} [${index + 1}]`;
    // conditions 支持两种形态：
    //   1) { field, operator, value } 或 { field, operator, valueSource: "field", valueField }
    //      —— 标准字段约束，拼进 RuleInput( )
    //   2) { pattern: "not"|"exists", condition: "..." } —— 独立 when pattern
    const inlinePatterns = [];
    const fieldConditions = [];
    for (const item of rule.conditions) {
      if (item.pattern) { inlinePatterns.push(item); continue; }
      if (item.raw) { fieldConditions.push({ item, constraint: item.raw }); continue; }
      const field = findField(bom, item.field);
      const constraint = item.valueSource === 'field' ? fieldConstraint(item, field) : literalConstraint(item, field);
      fieldConditions.push({ item, constraint });
    }
    lines.push('', `rule ${JSON.stringify(ruleName)}`, `    salience ${rule.salience ?? rule.priority}`);
    if (rule.activationGroup) lines.push(`    activation-group ${JSON.stringify(rule.activationGroup)}`);
    lines.push('    no-loop true', 'when');
    for (const p of inlinePatterns) {
      lines.push(`    ${p.pattern} ${p.condition}`);
    }
    const usesConditionalElements = fieldConditions.some(({ item }, conditionIndex) =>
      (item.quantifier && item.quantifier !== 'one') || (conditionIndex > 0 && item.connector === 'or'));
    if (!usesConditionalElements) {
      lines.push(`    $input : RuleInput( ${fieldConditions.map(entry => entry.constraint).join(', ')} )`);
    } else {
      lines.push('    $input : RuleInput()', '    (');
      fieldConditions.forEach(({ item, constraint }, conditionIndex) => {
        if (conditionIndex > 0) lines.push(`        ${item.connector === 'or' ? 'or' : 'and'}`);
        const pattern = `RuleInput( ${constraint} )`;
        if (item.quantifier === 'none') lines.push(`        not ${pattern}`);
        else if (item.quantifier === 'all') lines.push(`        forall( RuleInput() ${pattern} )`);
        else if (item.quantifier === 'exists') lines.push(`        exists ${pattern}`);
        else lines.push(`        ${pattern}`);
      });
      lines.push('    )');
    }
    lines.push('then', ...collectHitLines(rule, ruleName), '    modify($input) {');
    lines.push(...rule.actions.map((item, i) => {
      const field = findField(bom, item.field);
      return `        set${item.field[0].toUpperCase()}${item.field.slice(1)}(${parseValue(field, item.value)})${i < rule.actions.length - 1 ? ',' : ''}`;
    }));
    lines.push('    }', 'end');
  }
  return `${lines.join('\n')}\n`;
}
