import { defaultBom, findBomMethod, findField, inferSemanticType, resolvedBomFields } from './bom.js';
import { canonicalPackageName, DEFAULT_PACKAGE_NAME, PACKAGE_NAME_RE } from './packages.js';
import { findRuleSetVariable, normalizeRuleSetVariables, runtimeVariableType, validateRuleSetVariables, variableDrlValue } from './ruleset-variables.js';

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
  variables: [],
});

function enumValuesForField(field, bom) {
  if (field?.domainId) return (bom?.domains || []).find(domain => domain.id === field.domainId)?.values || null;
  return field?.enum || null;
}

/**
 * 把用户输入的值转成 DRL 字面量。
 * field 来自 BOM；返回 DRL 片段字符串，非法时返回 null。
 */
export function parseValue(field, raw, bom = null) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (inferSemanticType(field) === 'Date') return validIsoDate(trimmed) ? JSON.stringify(trimmed) : null;
  if (field.type === 'String') {
    // 枚举字段：值必须在枚举列表内
    const values = enumValuesForField(field, bom);
    if (values && !values.includes(trimmed)) return null;
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
  // 零值必须带小数点（Drools 不认 "0d"，实测 "0.0d" 通过）
  return n === 0 ? '0.0d' : `${n}d`;
}

export function formatDrlValue(field, raw) { return parseValue(field, raw); }

function validateLiteralCondition(item, field, bom) {
  const semanticType = inferSemanticType(field);
  if (item.operator === 'between') {
    const lower = parseValue(field, item.value, bom);
    const upper = parseValue(field, item.valueEnd, bom);
    if (lower === null || upper === null) return `${field.label}的区间上下界无效`;
    const reversed = semanticType === 'Date'
      ? item.value > item.valueEnd
      : Number(item.value) > Number(item.valueEnd);
    if (reversed) return `${field.label}的区间下界不能大于上界`;
    return null;
  }
  if (item.operator === 'in' || item.operator === 'not in') {
    if (!Array.isArray(item.values) || item.values.length < 1 || item.values.length > 50) return `${field.label}请至少选择一个枚举值`;
    if (new Set(item.values).size !== item.values.length || item.values.some(value => parseValue(field, value, bom) === null)) return `${field.label}的枚举条件值无效`;
    return null;
  }
  if (item.operator === 'matches') {
    if (parseValue(field, item.value, bom) === null) return `${field.label}的正则表达式无效`;
    try { new RegExp(item.value); } catch { return `${field.label}的正则表达式无效`; }
    return null;
  }
  if (item.operator === 'size >' || item.operator === 'size <') {
    if (!/^\d+$/.test(item.value || '') || Number(item.value) > 1000000) return `${field.label}的长度必须是 0–1000000 的整数`;
    return null;
  }
  return parseValue(field, item.value, bom) === null ? `${field.label}的条件值无效` : null;
}

export function fieldConstraint(item, field) {
  const semanticType = inferSemanticType(field);
  if (semanticType === 'Date') {
    if (item.operator === 'before') return `${item.field} != null && ${item.valueField} != null && ${item.field}.compareTo(${item.valueField}) < 0`;
    if (item.operator === 'after') return `${item.field} != null && ${item.valueField} != null && ${item.field}.compareTo(${item.valueField}) > 0`;
    const comparison = ({ '==': '== 0', '!=': '!= 0', '>': '> 0', '>=': '>= 0', '<': '< 0', '<=': '<= 0' })[item.operator];
    if (comparison) return `${item.field} != null && ${item.valueField} != null && ${item.field}.compareTo(${item.valueField}) ${comparison}`;
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

function variableAction(item, variable) {
  return `set${item.field[0].toUpperCase()}${item.field.slice(1)}(${variableDrlValue(variable, item.value)})`;
}

const NUMERIC_TYPES = new Set(['Integer', 'Decimal']);
const EXPRESSION_FUNCTIONS = new Set(['min', 'max', 'round', 'abs']);

export function ruleConditions(rule) {
  if (!rule?.conditionTree) return Array.isArray(rule?.conditions) ? rule.conditions : [];
  const conditions = [];
  const visit = node => {
    if (node?.type === 'condition') conditions.push(node.condition);
    else if (node?.type === 'group') node.children?.forEach(visit);
  };
  visit(rule.conditionTree);
  return conditions;
}

function validateConditionTree(tree) {
  let leaves = 0;
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return '条件组节点无效';
    if (depth > 5) return '嵌套条件组最多支持 5 层';
    if (node.type === 'condition') {
      leaves += 1;
      return node.condition && typeof node.condition === 'object' && !Array.isArray(node.condition) ? null : '条件组叶子无效';
    }
    if (node.type !== 'group' || !['and', 'or'].includes(node.operator)) return '条件组运算符无效';
    if (!Array.isArray(node.children) || node.children.length < 2 || node.children.length > 20) return '每个条件组需包含 2–20 个子项';
    for (const child of node.children) {
      const error = visit(child, depth + 1);
      if (error) return error;
    }
    return null;
  };
  const error = visit(tree, 1);
  if (error) return error;
  return leaves < 1 || leaves > 20 ? '条件树需包含 1–20 个条件' : null;
}

function numericTypeForField(field) {
  const semanticType = field ? inferSemanticType(field) : null;
  return NUMERIC_TYPES.has(semanticType) ? semanticType : null;
}

function expressionType(node, bom, variables, depth = 1, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > 10 || state.nodes > 100) return { error: '动作表达式最多支持 10 层、100 个节点' };
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { error: '动作表达式节点无效' };
  if (node.type === 'literal') {
    if (typeof node.value !== 'string' || !node.value.trim() || !Number.isFinite(Number(node.value))) return { error: '动作表达式数值无效' };
    if (/^-?\d+$/.test(node.value.trim())) {
      const value = Number(node.value);
      return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        ? { type: 'Integer' }
        : { error: '动作表达式整数超出 32 位范围' };
    }
    return { type: 'Decimal' };
  }
  if (node.type === 'field') {
    if (node.fieldSource === 'variable') {
      const variable = findRuleSetVariable(variables, node.field);
      const type = variable?.type === 'Double' ? 'Decimal' : variable?.type;
      return NUMERIC_TYPES.has(type) ? { type } : { error: `表达式变量 ${node.field || ''} 不存在或不是数值类型` };
    }
    const field = findField(bom, node.field);
    const type = field?.kind === 'input' ? numericTypeForField(field) : null;
    return type ? { type } : { error: `表达式字段 ${node.field || ''} 不存在或不是数值输入字段` };
  }
  if (node.type === 'binary') {
    if (!['+', '-', '*', '/'].includes(node.operator)) return { error: '动作表达式运算符无效' };
    const left = expressionType(node.left, bom, variables, depth + 1, state);
    if (left.error) return left;
    const right = expressionType(node.right, bom, variables, depth + 1, state);
    if (right.error) return right;
    if (node.operator === '/' && node.right?.type === 'literal' && Number(node.right.value) === 0) return { error: '动作表达式不能除以 0' };
    return { type: node.operator === '/' || left.type === 'Decimal' || right.type === 'Decimal' ? 'Decimal' : 'Integer' };
  }
  if (node.type === 'function') {
    if (!EXPRESSION_FUNCTIONS.has(node.name) || !Array.isArray(node.args)) return { error: '动作表达式函数无效' };
    const expected = ['abs', 'round'].includes(node.name) ? 1 : 2;
    if (node.args.length < expected || (['abs', 'round'].includes(node.name) && node.args.length !== 1) || node.args.length > 10) {
      return { error: `函数 ${node.name} 的参数数量无效` };
    }
    const argumentTypes = [];
    for (const argument of node.args) {
      const result = expressionType(argument, bom, variables, depth + 1, state);
      if (result.error) return result;
      argumentTypes.push(result.type);
    }
    return { type: node.name === 'round' ? 'Integer' : argumentTypes.includes('Decimal') ? 'Decimal' : 'Integer' };
  }
  if (node.type === 'method') {
    const method = findBomMethod(bom, node.name);
    return method ? { type: method.returnType } : { error: `BOM 方法 ${node.name || ''} 不存在` };
  }
  return { error: '动作表达式节点类型无效' };
}

function expressionDrl(node, bom, variables) {
  if (node.type === 'literal') {
    const value = Number(node.value);
    return /^-?\d+$/.test(node.value.trim()) ? String(value) : value === 0 ? '0.0d' : `${value}d`;
  }
  if (node.type === 'field') {
    const binding = node.fieldSource === 'variable' ? '$ctx' : '$input';
    return `${binding}.get${node.field[0].toUpperCase()}${node.field.slice(1)}()`;
  }
  if (node.type === 'binary') {
    const left = expressionDrl(node.left, bom, variables);
    const right = expressionDrl(node.right, bom, variables);
    return node.operator === '/' ? `((double) (${left}) / (${right}))` : `(${left} ${node.operator} ${right})`;
  }
  if (node.type === 'method') return expressionDrl(findBomMethod(bom, node.name).expression, bom, variables);
  const args = node.args.map(argument => expressionDrl(argument, bom, variables));
  if (node.name === 'round') return `(int) Math.round(${args[0]})`;
  if (node.name === 'abs') return `Math.abs(${args[0]})`;
  return args.slice(1).reduce((result, argument) => `Math.${node.name}(${result}, ${argument})`, args[0]);
}

function expressionUsesVariables(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'field') return node.fieldSource === 'variable';
  if (node.type === 'binary') return expressionUsesVariables(node.left) || expressionUsesVariables(node.right);
  if (node.type === 'function') return node.args?.some(expressionUsesVariables) || false;
  if (node.type === 'method') return false;
  return false;
}

export function validateRule(rule, bom = DEFAULT_BOM, variables = rule?.variables || []) {
  if (!rule || typeof rule !== 'object') return '规则内容无效';
  if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 80) return '规则名称需为 1–80 个字符';
  if (typeof rule.description !== 'string' || rule.description.length > 500) return '规则说明不能超过 500 个字符';
  if (typeof rule.category !== 'string' || !PACKAGE_NAME_RE.test(canonicalPackageName(rule.category))) return '规则包需为有效英文包名';
  if (!Number.isInteger(rule.priority) || rule.priority < -1000 || rule.priority > 1000) return '优先级需为 -1000 到 1000 的整数';
  if (rule.salience != null && (!Number.isInteger(rule.salience) || rule.salience < -2147483648 || rule.salience > 2147483647)) return '内部执行顺序无效';
  if (rule.activationGroup != null && (typeof rule.activationGroup !== 'string' || !rule.activationGroup || rule.activationGroup.length > 200)) return '内部互斥分组无效';
  if (rule.conditionTree) {
    const treeError = validateConditionTree(rule.conditionTree);
    if (treeError) return treeError;
  } else if (!Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > 20) return '至少需要一个条件，最多 20 个';
  if (!Array.isArray(rule.actions) || rule.actions.length < 1 || rule.actions.length > 20) return '至少需要一个动作，最多 20 个';
  const variableError = validateRuleSetVariables(variables);
  if (variableError) return variableError;
  const declaredVariables = normalizeRuleSetVariables(variables);
  const bomKeys = new Set((bom?.fields || []).map(field => field.key));
  if (declaredVariables.some(variable => bomKeys.has(variable.name))) return '规则集变量名称不能与 BOM 字段重复';
  const conditions = ruleConditions(rule);
  for (const [index, item] of conditions.entries()) {
    if (item.raw || item.pattern) continue; // 决策表生成的内联 DRL 片段，跳过字段校验
    if (item.fieldSource === 'variable') {
      const variable = findRuleSetVariable(declaredVariables, item.field);
      if (!variable || !['==', '!=', '>', '<', '>=', '<='].includes(item.operator)) return '条件变量或运算符无效';
      if (item.quantifier != null && item.quantifier !== 'one') return '规则集变量条件不支持量词';
      if (variable.type === 'Boolean' && !['==', '!='].includes(item.operator)) return '布尔变量只支持等于或不等于';
      if (variableDrlValue(variable, item.value) === null) return `变量 ${item.field} 的条件值无效`;
      continue;
    }
    const field = findField(bom, item.field);
    const semanticType = field ? inferSemanticType(field) : null;
    if (!field || field.kind !== 'input' || !BAL_OPERATORS_BY_TYPE[semanticType]?.includes(item.operator)) return '条件字段或运算符无效';
    if (item.quantifier != null && !['one', 'exists', 'all', 'none'].includes(item.quantifier)) return '条件量词无效';
    if (index > 0 && item.connector != null && !['and', 'or'].includes(item.connector)) return '条件连接词无效';
    if (item.valueSource != null && !['literal', 'field'].includes(item.valueSource)) return '条件值来源无效';
    if (item.valueSource === 'field') {
      if (!FIELD_VALUE_OPERATORS_BY_TYPE[semanticType]?.includes(item.operator)) return `${field.label}的${item.operator}操作不支持业务字段值`;
      const valueField = findField(bom, item.valueField);
      // 允许引用 input 或 output 字段：决策表输出（动态阈值）写回 RuleInput 后可同事实内比较
      if (!valueField || valueField.kind !== 'input') return `${field.label}用于比较的业务字段不存在或不是输入字段`;
      if (valueField.key === field.key) return `${field.label}不能与自身比较`;
      if (inferSemanticType(valueField) !== inferSemanticType(field)) return `${field.label}只能与同类型业务字段比较`;
    } else {
      const valueIssue = validateLiteralCondition(item, field, bom);
      if (valueIssue) return valueIssue;
    }
  }
  const actionKeys = new Set();
  for (const item of rule.actions) {
    if (item.fieldSource === 'variable') {
      const variable = findRuleSetVariable(declaredVariables, item.field);
      if (!variable || actionKeys.has(`variable:${item.field}`)) return '动作变量无效或重复';
      if (item.valueExpression) return '规则集变量动作暂不支持表达式';
      if (variableDrlValue(variable, item.value) === null) return `变量 ${item.field} 的动作值无效`;
      actionKeys.add(`variable:${item.field}`);
      continue;
    }
    const field = findField(bom, item.field);
    if (!field || field.kind !== 'output' || actionKeys.has(item.field)) return '动作字段无效或重复';
    actionKeys.add(item.field);
    if (item.valueExpression) {
      if (!NUMERIC_TYPES.has(inferSemanticType(field))) return `${field.label}不是数值字段，不能使用表达式`;
      const result = expressionType(item.valueExpression, bom, declaredVariables);
      if (result.error) return result.error;
      if (inferSemanticType(field) === 'Integer' && result.type !== 'Integer') return `${field.label}是整数，动作表达式必须返回整数`;
    } else if (parseValue(field, item.value, bom) === null) return `${field.label}的动作值无效`;
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
    lines.push(`    $hitOutputs.put(${drlString(action.field)}, ${drlString(action.valueExpression ? JSON.stringify(action.valueExpression) : action.value)});`);
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

function conditionConstraint(item, bom, variables, bindFacts = false) {
  if (item.pattern) return `${item.pattern} ${item.condition}`;
  if (item.raw) return `RuleInput( ${bindFacts ? 'this == $input, ' : ''}${item.raw} )`;
  if (item.fieldSource === 'variable') {
    const variable = findRuleSetVariable(variables, item.field);
    return `RuleContext( ${bindFacts ? 'this == $ctx, ' : ''}${item.field} ${item.operator} ${variableDrlValue(variable, item.value)} )`;
  }
  const field = findField(bom, item.field);
  const constraint = item.valueSource === 'field' ? fieldConstraint(item, field) : literalConstraint(item, field);
  const pattern = `RuleInput( ${bindFacts ? 'this == $input, ' : ''}${constraint} )`;
  if (item.quantifier === 'none') return `not ${pattern}`;
  if (item.quantifier === 'all') return `forall( RuleInput() ${pattern} )`;
  if (item.quantifier === 'exists') return `exists ${pattern}`;
  return pattern;
}

function conditionTreeLines(node, bom, variables, indent = '    ') {
  if (node.type === 'condition') return [`${indent}${conditionConstraint(node.condition, bom, variables, true)}`];
  const lines = [`${indent}(`];
  node.children.forEach((child, index) => {
    if (index) lines.push(`${indent}    ${node.operator}`);
    lines.push(...conditionTreeLines(child, bom, variables, `${indent}    `));
  });
  lines.push(`${indent})`);
  return lines;
}

function renderDrl(rules, bom = DEFAULT_BOM, declaredVariables = null, trusted = false) {
  const variableMap = new Map();
  for (const variable of normalizeRuleSetVariables(declaredVariables || rules.flatMap(rule => rule?.variables || []))) {
    const previous = variableMap.get(variable.name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(variable)) throw new Error(`规则集变量 "${variable.name}" 定义冲突`);
    variableMap.set(variable.name, variable);
  }
  const variables = [...variableMap.values()];
  const variableError = validateRuleSetVariables(variables);
  if (variableError) throw new Error(variableError);
  if (!trusted) for (const rule of rules) {
    const error = validateRule(rule, bom, variables);
    if (error) throw new Error(`${rule?.name || '规则'}：${error}`);
  }
  const hasDecisionHits = rules.some(rule => rule.collectHit);
  const lines = [
    'package workbench',
    '',
    '// 与业务系统交换的事实类型；输入字段由调用方设置，动作写回输出字段。',
    'declare RuleInput',
    ...resolvedBomFields(bom).map(f => `    ${f.key} : ${({ Integer: 'java.lang.Integer', Double: 'java.lang.Double', Boolean: 'java.lang.Boolean' })[f.type] || f.type}`),
    'end',
  ];
  if (variables.length) {
    lines.push('', '// 规则集内部变量；由 RES 为本次执行创建，调用方无需传入。', 'declare RuleContext',
      ...variables.map(variable => `    ${variable.name} : ${runtimeVariableType(variable.type)}`),
      'end');
  }
  if (hasDecisionHits) {
    lines.push('', '// COLLECT 命中策略输出的独立命中结果集合。', 'declare DecisionHit', '    tableName : String', '    ruleName : String', '    rowIndex : Integer', '    defaultRow : Boolean', '    outputs : java.util.Map', 'end');
  }
  for (const [index, rule] of rules.entries()) {
    const ruleName = `${rule.name} [${index + 1}]`;
    // conditions 支持两种形态：
    //   1) { field, operator, value } 或 { field, operator, valueSource: "field", valueField }
    //      —— 标准字段约束，拼进 RuleInput( )
    //   2) { pattern: "not"|"exists", condition: "..." } —— 独立 when pattern
    const conditions = ruleConditions(rule);
    const inlinePatterns = [];
    const fieldConditions = [];
    const variableConditions = [];
    for (const item of conditions) {
      if (item.pattern) { inlinePatterns.push(item); continue; }
      if (item.raw) { fieldConditions.push({ item, constraint: item.raw }); continue; }
      if (item.fieldSource === 'variable') {
        const variable = findRuleSetVariable(variables, item.field);
        variableConditions.push({ item, constraint: `${item.field} ${item.operator} ${variableDrlValue(variable, item.value)}` });
        continue;
      }
      const field = findField(bom, item.field);
      const constraint = item.valueSource === 'field' ? fieldConstraint(item, field) : literalConstraint(item, field);
      fieldConditions.push({ item, constraint });
    }
    lines.push('', `rule ${JSON.stringify(ruleName)}`, `    salience ${rule.salience ?? rule.priority}`);
    if (rule.activationGroup) lines.push(`    activation-group ${JSON.stringify(rule.activationGroup)}`);
    lines.push('    no-loop true', 'when');
    const inputActions = rule.actions.filter(item => item.fieldSource !== 'variable');
    const variableActions = rule.actions.filter(item => item.fieldSource === 'variable');
    const expressionVariableActions = inputActions.some(item => expressionUsesVariables(item.valueExpression));
    if (rule.conditionTree) {
      lines.push('    $input : RuleInput()');
      if (conditions.some(item => item.fieldSource === 'variable') || variableActions.length || expressionVariableActions) lines.push('    $ctx : RuleContext()');
      lines.push(...conditionTreeLines(rule.conditionTree, bom, variables));
    } else {
      for (const p of inlinePatterns) lines.push(`    ${p.pattern} ${p.condition}`);
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
      if (variableConditions.length) lines.push(`    $ctx : RuleContext( ${variableConditions.map(entry => entry.constraint).join(', ')} )`);
      else if (variableActions.length || expressionVariableActions) lines.push('    $ctx : RuleContext()');
    }
    lines.push('then', ...collectHitLines(rule, ruleName));
    if (inputActions.length) {
      lines.push('    modify($input) {');
      lines.push(...inputActions.map((item, i) => {
        const field = findField(bom, item.field);
        const expression = item.valueExpression ? expressionDrl(item.valueExpression, bom, variables) : null;
        const value = trusted && typeof item.valueDrl === 'string'
          ? item.valueDrl
          : expression && inferSemanticType(field) === 'Decimal' ? `(double) (${expression})` : expression || parseValue(field, item.value);
        return `        set${item.field[0].toUpperCase()}${item.field.slice(1)}(${value})${i < inputActions.length - 1 ? ',' : ''}`;
      }));
      lines.push('    }');
    }
    if (variableActions.length) {
      lines.push('    modify($ctx) {');
      lines.push(...variableActions.map((item, i) => {
        const variable = findRuleSetVariable(variables, item.field);
        return `        ${variableAction(item, variable)}${i < variableActions.length - 1 ? ',' : ''}`;
      }));
      lines.push('    }');
    }
    lines.push('end');
  }
  return `${lines.join('\n')}\n`;
}

export function generateDrl(rules, bom = DEFAULT_BOM, declaredVariables = null) {
  return renderDrl(rules, bom, declaredVariables, false);
}

export function generateTrustedDrl(rules, bom = DEFAULT_BOM, declaredVariables = null) {
  return renderDrl(rules, bom, declaredVariables, true);
}
