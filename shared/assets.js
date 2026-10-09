import { createHash } from 'node:crypto';
import { fieldConstraint, generateDrl, operators, formatDrlValue, ruleConditions } from './rules.js';
import { defaultBom, findField, inferSemanticType, inputFields as bomInputs, outputFields as bomOutputs } from './bom.js';
import { canonicalPackageName, DEFAULT_PACKAGE_NAME, PACKAGE_NAME_RE } from './packages.js';
import { DomainError } from './errors.js';
import { canonicalRuleSetVariables, findRuleSetVariable, normalizeRuleSetVariables, validateRuleSetVariables, variableDrlValue } from './ruleset-variables.js';
import { decisionTreeDrl, decisionTreeRules, isDecisionTree } from './decision-trees.js';
import { isScorecard, scorecardDrl, scorecardRules } from './scorecards.js';
import { isRuleTemplate, ruleTemplateDrl, ruleTemplateRules } from './rule-templates.js';

const DEFAULT_BOM = defaultBom();

export const newTable = () => ({
  name: '未命名决策表', description: '', category: DEFAULT_PACKAGE_NAME, priority: 0,
  hitPolicy: 'COLLECT',
  conditions: [{ field: 'creditScore', operator: '<' }, { field: 'overdue', operator: '==' }],
  actions: [{ field: 'riskLevel' }, { field: 'reviewRequired' }],
  rows: [
    { enabled: true, priority: 0, conditions: ['600', 'true'], actions: ['高', 'true'] },
    { enabled: true, priority: 0, conditions: ['600', 'false'], actions: ['中', 'false'] },
  ],
  defaultRow: null,
});

export const hitPolicies = [
  { key: 'FIRST', label: '首条命中', description: '按表格顺序执行第一条匹配行' },
  { key: 'COLLECT', label: '收集命中', description: '按表格顺序执行所有匹配行，并记录独立命中结果集合' },
  { key: 'ALL', label: '全部命中（兼容）', description: '兼容旧版本；新表请使用 COLLECT' },
  { key: 'PRIORITY', label: '优先命中', description: '执行优先级最高的匹配行，同级按表格顺序' },
];

const hitPolicyOf = table => table.hitPolicy || 'ALL';
const collectsHits = table => hitPolicyOf(table) === 'COLLECT';
const TABLE_PRIORITY_SCALE = 1000000;
const ROW_PRIORITY_SCALE = 1000;

function fallbackExecutionKey(table) {
  const source = JSON.stringify([table.name, table.conditions, table.actions]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

function rowSalience(table, row, position, activeCount) {
  const tableBase = table.priority * TABLE_PRIORITY_SCALE;
  const displayOrder = activeCount - position;
  return hitPolicyOf(table) === 'PRIORITY'
    ? tableBase + (row.priority ?? 0) * ROW_PRIORITY_SCALE + displayOrder
    : tableBase + displayOrder;
}

export const newFlow = () => ({ name: '未命名规则集', description: '', variables: [], steps: [], gateways: [], editor: { positions: {} } });

export function isFlowGraph(flow = {}) {
  return Boolean(flow.graph && Array.isArray(flow.graph.nodes));
}

export function flowGraphNodes(flow = {}) {
  return isFlowGraph(flow) ? flow.graph.nodes : [];
}

export function flowGateways(flow = {}) {
  if (isFlowGraph(flow)) return flow.graph.nodes.filter(node => node.type === 'gateway');
  if (Array.isArray(flow.gateways) && (flow.gateways.length || !Array.isArray(flow.branches) || !flow.branches.length)) return flow.gateways;
  if (!Array.isArray(flow.branches) || !flow.branches.length) return [];
  return [{ id: 'gateway', name: '排他网关', afterStep: Array.isArray(flow.steps) ? flow.steps.length : 0, branches: flow.branches }];
}

export function flowBranches(flow = {}) {
  return flowGateways(flow).flatMap(gateway => gateway.branches || []);
}

export function flowSteps(flow = {}) {
  if (isFlowGraph(flow)) return flow.graph.nodes.filter(node => node.type === 'step').map(node => node.step);
  return [...(flow.steps || []), ...flowBranches(flow).flatMap(branch => branch.steps || [])];
}

/**
 * 解析一个条件单元格，返回 DRL 条件片段数组。
 * 返回 [] 表示空单元格（不限制）。
 * 抛出 Error 表示值非法。
 *
 * 语法：
 *   空            → []
 *   单值          → [field op value]
 *   a..b / a.. / ..b → 闭区间，忽略列运算符 → [field >= a, field <= b]
 *   [a,b) / (a,b] 等 → 可配置开闭边界的数值区间
 *   v1,v2,v3     → 字符串枚举，== 生成 in，!= 生成 not in
 */
export function isFieldReferenceCell(cell) {
  return Boolean(cell && typeof cell === 'object' && !Array.isArray(cell) && cell.valueSource === 'field');
}

export function conditionCellText(cell) {
  return typeof cell === 'string' ? cell : '';
}

export function conditionCellExportValue(cell) {
  return isFieldReferenceCell(cell) ? `\${${cell.valueField}}` : conditionCellText(cell);
}

export function parseConditionCell(field, operator, raw, bom = DEFAULT_BOM) {
  if (isFieldReferenceCell(raw)) {
    const valueField = findField(bom, raw.valueField);
    // 允许引用 input 或 output 字段：决策表输出（如动态阈值）写回 RuleInput 后，BAL/决策表行可同事实内比较
    if (!valueField || (valueField.kind !== 'input' && valueField.kind !== 'output')) throw new Error(`${field.label}用于比较的业务字段不存在或不是输入字段`);
    if (valueField.key === field.key) throw new Error(`${field.label}不能与自身比较`);
    if (inferSemanticType(valueField) !== inferSemanticType(field)) throw new Error(`${field.label}只能与同类型业务字段比较`);
    const allowed = ['==', '!=', '>', '>=', '<', '<='];
    if (!allowed.includes(operator) || (inferSemanticType(field) === 'Boolean' && !['==', '!='].includes(operator))) {
      throw new Error(`${field.label}的${operator}操作不支持业务字段值`);
    }
    return [fieldConstraint({ field: field.key, operator, valueField: valueField.key }, field)];
  }
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];

  const comparison = text.match(/^(>=|<=|!=|==|>|<)\s*(.+)$/);
  const effectiveOperator = comparison?.[1] || operator;
  const operand = comparison?.[2]?.trim() || text;

  if (field.type === 'String') {
    const contains = text.match(/^包含\s*["“](.*)["”]$/);
    const notContains = text.match(/^不包含\s*["“](.*)["”]$/);
    const matched = contains || notContains;
    if (matched) {
      const escaped = matched[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return [`${field.key} ${notContains ? 'not matches' : 'matches'} ${JSON.stringify(`.*${escaped}.*`)}`];
    }
  }

  const bracketRange = operand.match(/^([[(])\s*(-?\d+(?:\.\d+)?)?\s*,\s*(-?\d+(?:\.\d+)?)?\s*([\])])$/);

  // 区间语法 a..b（闭区间）或 [a,b)（显式开闭边界）
  if (operand.includes('..') || bracketRange) {
    if (field.type !== 'Integer' && field.type !== 'Double') {
      throw new Error(`${field.label}是${field.type}类型，不支持区间语法`);
    }
    if (comparison) throw new Error(`${field.label}区间不能再添加比较符`);
    const parts = bracketRange ? [bracketRange[2] || '', bracketRange[3] || ''] : operand.split('..');
    if (parts.length !== 2) throw new Error(`${field.label}区间"${operand}"格式无效`);
    const [lo, hi] = parts;
    const lowerOperator = bracketRange?.[1] === '(' ? '>' : '>=';
    const upperOperator = bracketRange?.[4] === ')' ? '<' : '<=';
    const fragments = [];
    if (lo.trim() !== '') {
      const v = formatDrlValue(field, lo);
      if (!v) throw new Error(`${field.label}区间下界"${lo}"无效`);
      fragments.push(`${field.key} ${lowerOperator} ${v}`);
    }
    if (hi.trim() !== '') {
      const v = formatDrlValue(field, hi);
      if (!v) throw new Error(`${field.label}区间上界"${hi}"无效`);
      fragments.push(`${field.key} ${upperOperator} ${v}`);
    }
    if (lo.trim() !== '' && hi.trim() !== '') {
      if (Number(lo) > Number(hi)) throw new Error(`${field.label}区间下界不能大于上界`);
      if (Number(lo) === Number(hi) && (lowerOperator === '>' || upperOperator === '<')) throw new Error(`${field.label}区间为空，请检查开闭符号`);
    }
    if (!fragments.length) throw new Error(`${field.label}区间"${operand}"为空`);
    return fragments;
  }

  // 多值枚举（逗号分隔）
  if (operand.includes(',')) {
    if (field.type !== 'String') {
      throw new Error(`${field.label}是${field.type}类型，多值枚举仅支持文本字段`);
    }
    const values = operand.split(',').map(s => s.trim()).filter(Boolean);
    if (!values.length) throw new Error(`${field.label}枚举为空`);
    for (const v of values) {
      if (v.length > 200) throw new Error(`${field.label}枚举值过长`);
      // 若 BOM 配置了枚举值域，每个值必须在列表内
      if (field.enum && !field.enum.includes(v)) throw new Error(`${field.label}枚举值"${v}"不在可选范围内 [${field.enum.join('/')}]`);
    }
    const quoted = values.map(v => JSON.stringify(v)).join(', ');
    if (effectiveOperator === '==') return [`${field.key} in (${quoted})`];
    if (effectiveOperator === '!=') return [`${field.key} not in (${quoted})`];
    throw new Error(`${field.label}多值枚举只支持等于/不等于`);
  }

  // 单值
  const v = formatDrlValue(field, operand);
  if (!v) throw new Error(`${field.label}条件值"${operand}"无效`);
  if (field.type === 'Boolean' && !['==', '!='].includes(effectiveOperator)) throw new Error(`${field.label}布尔条件只支持等于或不等于`);
  return [`${field.key} ${effectiveOperator} ${v}`];
}

function variableField(variable, direction = 'input') {
  return {
    key: variable.name,
    label: variable.label || variable.name,
    type: variable.type,
    kind: direction,
    enum: variable.enum || null,
  };
}

function tableColumnField(column, bom, variables, direction) {
  if (column?.fieldSource === 'variable') {
    const variable = findRuleSetVariable(variables, column.field);
    return variable ? variableField(variable, direction) : null;
  }
  return findField(bom, column?.field);
}

function parseVariableConditionCell(variable, operator, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const text = raw.trim();
  const comparison = text.match(/^(>=|<=|!=|==|>|<)\s*(.+)$/);
  const effectiveOperator = comparison?.[1] || operator;
  const operand = comparison?.[2]?.trim() || text;
  if (!['==', '!=', '>', '>=', '<', '<='].includes(effectiveOperator)) throw new Error(`${variable.label}的变量条件运算符无效`);
  if (['Boolean', 'String'].includes(variable.type) && !['==', '!='].includes(effectiveOperator)) throw new Error(`${variable.label}只支持等于或不等于`);
  const value = variableDrlValue(variable, operand);
  if (value === null) throw new Error(`${variable.label}的条件值无效`);
  return [{ fieldSource: 'variable', field: variable.name, operator: effectiveOperator, value: operand }];
}

/**
 * 把一行的条件列解析成 DRL 条件片段数组（AND 连接）。
 * 默认行（条件全空）返回空数组。
 */
function rowConditionParts(table, row, inputs, bom = DEFAULT_BOM, variables = []) {
  const input = [];
  const variable = [];
  for (let i = 0; i < table.conditions.length; i++) {
    const col = table.conditions[i];
    const field = tableColumnField(col, bom, variables, 'input');
    const cell = row.conditions[i] ?? '';
    if (col.fieldSource === 'variable') variable.push(...parseVariableConditionCell(findRuleSetVariable(variables, col.field), col.operator, cell));
    else input.push(...parseConditionCell(field, col.operator, cell, bom));
  }
  return { input, variable };
}

function rowConditions(table, row, inputs, bom = DEFAULT_BOM, variables = []) {
  const fragments = [];
  const parts = rowConditionParts(table, row, inputs, bom, variables);
  fragments.push(...parts.input, ...parts.variable.map(item => `${item.field} ${item.operator} ${variableDrlValue(findRuleSetVariable(variables, item.field), item.value)}`));
  return fragments;
}

function numericConstraint(field, operator, text) {
  const integer = field.type === 'Integer';
  const domainLo = field.min ?? (integer ? -2147483648 : -Number.MAX_VALUE);
  const domainHi = field.max ?? (integer ? 2147483647 : Number.MAX_VALUE);
  const interval = (lo, hi, loInc = true, hiInc = true) => ({ lo, hi, loInc, hiInc });
  let intervals;
  if (!text) intervals = [interval(domainLo, domainHi)];
  else if (text.includes('..') || /^([[(]).*([\])])$/.test(text)) {
    const bracketRange = text.match(/^([[(])\s*(-?\d+(?:\.\d+)?)?\s*,\s*(-?\d+(?:\.\d+)?)?\s*([\])])$/);
    const [rawLo, rawHi] = bracketRange ? [bracketRange[2] || '', bracketRange[3] || ''] : text.split('..', 2);
    intervals = [interval(
      rawLo.trim() ? Number(rawLo) : domainLo,
      rawHi.trim() ? Number(rawHi) : domainHi,
      bracketRange ? bracketRange[1] === '[' : true,
      bracketRange ? bracketRange[4] === ']' : true,
    )];
  } else {
    const value = Number(text);
    if (integer) {
      if (operator === '==') intervals = [interval(value, value)];
      if (operator === '!=') intervals = [interval(domainLo, value - 1), interval(value + 1, domainHi)];
      if (operator === '>') intervals = [interval(value + 1, domainHi)];
      if (operator === '>=') intervals = [interval(value, domainHi)];
      if (operator === '<') intervals = [interval(domainLo, value - 1)];
      if (operator === '<=') intervals = [interval(domainLo, value)];
    } else {
      if (operator === '==') intervals = [interval(value, value)];
      if (operator === '!=') intervals = [interval(domainLo, value, true, false), interval(value, domainHi, false, true)];
      if (operator === '>') intervals = [interval(value, domainHi, false, true)];
      if (operator === '>=') intervals = [interval(value, domainHi)];
      if (operator === '<') intervals = [interval(domainLo, value, true, false)];
      if (operator === '<=') intervals = [interval(domainLo, value)];
    }
  }
  return {
    kind: 'numeric', integer, domain: interval(domainLo, domainHi),
    intervals: intervals.filter(part => part.lo < part.hi || (part.lo === part.hi && part.loInc && part.hiInc)),
  };
}

function conditionConstraint(field, operator, raw) {
  if (isFieldReferenceCell(raw)) return { kind: 'unknown' };
  const text = conditionCellText(raw).trim();
  const comparison = text.match(/^(>=|<=|!=|==|>|<)\s*(.+)$/);
  const effectiveOperator = comparison?.[1] || operator;
  const operand = comparison?.[2]?.trim() || text;
  if (field.type === 'Integer' || field.type === 'Double') return numericConstraint(field, effectiveOperator, operand);
  if (field.type === 'Boolean') {
    const universe = new Set([true, false]);
    if (!operand) return { kind: 'finite', universe, values: new Set(universe) };
    const value = operand === 'true';
    return { kind: 'finite', universe, values: effectiveOperator === '==' ? new Set([value]) : new Set([!value]) };
  }
  if (/^不?包含\s*["“]/.test(text)) return { kind: 'unknown' };
  const values = new Set(operand ? operand.split(',').map(value => value.trim()).filter(Boolean) : []);
  if (field.enum) {
    const universe = new Set(field.enum);
    if (!operand) return { kind: 'finite', universe, values: new Set(universe) };
    if (!['==', '!='].includes(effectiveOperator)) return { kind: 'unknown' };
    return { kind: 'finite', universe, values: effectiveOperator === '==' ? values : new Set([...universe].filter(value => !values.has(value))) };
  }
  if (!operand) return { kind: 'symbolic', mode: 'exclude', values: new Set() };
  if (!['==', '!='].includes(effectiveOperator)) return { kind: 'unknown' };
  return { kind: 'symbolic', mode: effectiveOperator === '==' ? 'allow' : 'exclude', values };
}

function intervalIntersection(a, b) {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (lo < hi) return true;
  if (lo > hi) return false;
  const loIncluded = (a.lo !== lo || a.loInc) && (b.lo !== lo || b.loInc);
  const hiIncluded = (a.hi !== hi || a.hiInc) && (b.hi !== hi || b.hiInc);
  return loIncluded && hiIncluded;
}

function intervalSubset(a, b) {
  const lowerCovered = b.lo < a.lo || (b.lo === a.lo && (b.loInc || !a.loInc));
  const upperCovered = b.hi > a.hi || (b.hi === a.hi && (b.hiInc || !a.hiInc));
  return lowerCovered && upperCovered;
}

function mergeIntervals(intervals, integer) {
  const sorted = intervals.map(part => ({ ...part })).sort((a, b) => a.lo - b.lo || Number(b.loInc) - Number(a.loInc));
  const merged = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    const touches = previous && (current.lo < previous.hi
      || (current.lo === previous.hi && (current.loInc || previous.hiInc))
      || (integer && current.lo === previous.hi + 1));
    if (!touches) { merged.push(current); continue; }
    if (current.hi > previous.hi) {
      previous.hi = current.hi;
      previous.hiInc = current.hiInc;
    } else if (current.hi === previous.hi) previous.hiInc ||= current.hiInc;
  }
  return merged;
}

function setSubset(a, b) { return [...a].every(value => b.has(value)); }

function constraintsOverlap(a, b) {
  if (a.kind === 'unknown' || b.kind === 'unknown') return null;
  if (a.kind === 'numeric') return a.intervals.some(left => b.intervals.some(right => intervalIntersection(left, right)));
  if (a.kind === 'finite') return [...a.values].some(value => b.values.has(value));
  if (a.mode === 'allow' && b.mode === 'allow') return [...a.values].some(value => b.values.has(value));
  if (a.mode === 'allow') return [...a.values].some(value => !b.values.has(value));
  if (b.mode === 'allow') return [...b.values].some(value => !a.values.has(value));
  return true;
}

function constraintSubset(a, b) {
  if (a.kind === 'unknown' || b.kind === 'unknown') return null;
  if (a.kind === 'numeric') {
    const covering = mergeIntervals(b.intervals, b.integer);
    return a.intervals.every(part => covering.some(candidate => intervalSubset(part, candidate)));
  }
  if (a.kind === 'finite') return setSubset(a.values, b.values);
  if (a.mode === 'allow' && b.mode === 'allow') return setSubset(a.values, b.values);
  if (a.mode === 'allow' && b.mode === 'exclude') return [...a.values].every(value => !b.values.has(value));
  if (a.mode === 'exclude' && b.mode === 'exclude') return setSubset(b.values, a.values);
  return false;
}

function rowConstraints(table, entry, inputs, bom = DEFAULT_BOM, variables = []) {
  return table.conditions.map((column, index) => conditionConstraint(
    tableColumnField(column, bom, variables, 'input'), column.operator, entry.row.conditions[index],
  ));
}

function rowOverlap(a, b) {
  let unknown = false;
  for (let i = 0; i < a.length; i++) {
    const overlap = constraintsOverlap(a[i], b[i]);
    if (overlap === false) return false;
    if (overlap === null) unknown = true;
  }
  return unknown ? null : true;
}

function rowSubset(a, b) {
  let unknown = false;
  for (let i = 0; i < a.length; i++) {
    const subset = constraintSubset(a[i], b[i]);
    if (subset === false) return false;
    if (subset === null) unknown = true;
  }
  return unknown ? null : true;
}

function constraintAccepts(constraint, value) {
  if (constraint.kind === 'numeric') {
    return constraint.intervals.some(part => (
      (value > part.lo || (value === part.lo && part.loInc))
      && (value < part.hi || (value === part.hi && part.hiInc))
    ));
  }
  if (constraint.kind === 'finite') return constraint.values.has(value);
  if (constraint.kind === 'symbolic') return constraint.mode === 'allow' ? constraint.values.has(value) : !constraint.values.has(value);
  return false;
}

function atomicCandidates(columnConstraints) {
  if (columnConstraints.some(constraint => constraint.kind === 'unknown')) return null;
  const first = columnConstraints[0];
  if (first.kind === 'finite') return [...first.universe];
  if (first.kind === 'symbolic') {
    const values = new Set(columnConstraints.flatMap(constraint => [...constraint.values]));
    let other = '__其他值__';
    while (values.has(other)) other += '_';
    return [...values, other];
  }
  const boundaries = new Set([first.domain.lo, first.domain.hi]);
  for (const constraint of columnConstraints) {
    for (const part of constraint.intervals) {
      boundaries.add(part.lo);
      boundaries.add(part.hi);
    }
  }
  const sorted = [...boundaries].filter(Number.isFinite).sort((a, b) => a - b);
  const candidates = new Set(sorted);
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i];
    const right = sorted[i + 1];
    const middle = first.integer ? Math.floor(left + (right - left) / 2) : left / 2 + right / 2;
    if (middle > left && middle < right) candidates.add(middle);
  }
  return [...candidates].filter(value => value >= first.domain.lo && value <= first.domain.hi);
}

const ANALYSIS_NODE_LIMIT = 200000;

function findUncoveredWitness(allConstraints, targetIndex, blockerIndexes) {
  const candidates = allConstraints[0].map((_, column) => atomicCandidates(allConstraints.map(row => row[column])));
  if (candidates.some(values => values === null)) return { status: 'unknown' };
  let visited = 0;
  let witness = null;
  let limited = false;

  function visit(column, activeBlockers, values) {
    if (witness || limited) return;
    if (++visited > ANALYSIS_NODE_LIMIT) { limited = true; return; }
    if (column === candidates.length) {
      if (activeBlockers.length === 0) witness = [...values];
      return;
    }
    const target = targetIndex == null ? null : allConstraints[targetIndex][column];
    for (const value of candidates[column]) {
      if (target && !constraintAccepts(target, value)) continue;
      const nextBlockers = activeBlockers.filter(index => constraintAccepts(allConstraints[index][column], value));
      values.push(value);
      visit(column + 1, nextBlockers, values);
      values.pop();
      if (witness || limited) return;
    }
  }

  visit(0, blockerIndexes, []);
  if (witness) return { status: 'found', witness };
  if (limited) return { status: 'limited' };
  return { status: 'covered' };
}

function formatWitness(values, table, inputs, variables = []) {
  return values.map((value, index) => {
    const field = tableColumnField(table.conditions[index], DEFAULT_BOM, variables, 'input')
      || inputs.find(entry => entry.key === table.conditions[index].field);
    const display = typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
    return `${field.label}=${display}`;
  }).join('，');
}

/** 返回可证明的重复、重叠、不可达和单字段域缺口。 */
function conflictingActions(table, left, right, outputs, variables = []) {
  return table.actions.flatMap((column, index) => {
    const leftValue = String(left.actions[index] ?? '').trim();
    const rightValue = String(right.actions[index] ?? '').trim();
    if (!leftValue || !rightValue || leftValue === rightValue) return [];
    return [tableColumnField(column, DEFAULT_BOM, variables, 'output')?.label
      || outputs.find(field => field.key === column.field)?.label
      || column.field];
  });
}

function analyzeTable(table, activeRows, inputs, outputs, bom = DEFAULT_BOM, variables = []) {
  const errors = [];
  const warnings = [];
  if (!activeRows.length) return { errors, warnings };
  const constraints = activeRows.map(entry => rowConstraints(table, entry, inputs, bom, variables));
  for (let i = 0; i < activeRows.length; i++) {
    if (constraints[i].some(constraint => constraint.kind === 'numeric' && constraint.intervals.length === 0)) {
      warnings.push(`第 ${activeRows[i].index + 1} 行条件域为空，永远不会命中`);
    }
    for (let j = i + 1; j < activeRows.length; j++) {
      const overlap = rowOverlap(constraints[i], constraints[j]);
      const equivalent = rowSubset(constraints[i], constraints[j]) === true && rowSubset(constraints[j], constraints[i]) === true;
      if (equivalent) errors.push(`第 ${activeRows[i].index + 1} 行与第 ${activeRows[j].index + 1} 行条件完全一致，必然同时触发`);
      else if (overlap === true) {
        const conflicts = conflictingActions(table, activeRows[i].row, activeRows[j].row, outputs, variables);
        warnings.push(conflicts.length
          ? `第 ${activeRows[i].index + 1} 行与第 ${activeRows[j].index + 1} 行条件存在重叠，且动作结果冲突：${conflicts.join('、')}`
          : `第 ${activeRows[i].index + 1} 行与第 ${activeRows[j].index + 1} 行条件存在重叠`);
      }
      else if (overlap === null) warnings.push(`第 ${activeRows[i].index + 1} 行与第 ${activeRows[j].index + 1} 行包含暂不支持精确分析的条件`);
    }
  }

  const policy = hitPolicyOf(table);
  if (policy !== 'ALL' && policy !== 'COLLECT') {
    for (let target = 0; target < activeRows.length; target++) {
      const targetPriority = activeRows[target].row.priority ?? 0;
      const blockers = activeRows.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => {
        if (index === target) return false;
        const blockerPriority = entry.row.priority ?? 0;
        return policy === 'FIRST'
          ? index < target
          : blockerPriority > targetPriority || (blockerPriority === targetPriority && index < target);
      }).map(({ index }) => index).filter(index => rowOverlap(constraints[target], constraints[index]) !== false);
      if (!blockers.length) continue;
      const coverage = findUncoveredWitness(constraints, target, blockers);
      if (coverage.status === 'covered') {
        const rows = blockers.map(index => activeRows[index].index + 1).join('、');
        warnings.push(`第 ${activeRows[target].index + 1} 行被获胜顺序中的第 ${rows} 行联合覆盖，在 ${policy} 策略下不可达`);
      } else if (coverage.status === 'limited') {
        warnings.push(`第 ${activeRows[target].index + 1} 行的联合覆盖分析超过 ${ANALYSIS_NODE_LIMIT} 个组合，未能完成`);
      }
    }
  }

  if (!table.rows.some((row, index) => row.enabled && (row.isDefault || table.defaultRow === index))) {
    const gap = findUncoveredWitness(constraints, null, activeRows.map((_, index) => index));
    if (gap.status === 'found') warnings.push(`决策表有命中缺口，例如：${formatWitness(gap.witness, table, inputs, variables)}`);
    if (gap.status === 'limited') warnings.push(`多维缺口分析超过 ${ANALYSIS_NODE_LIMIT} 个组合，未能完成`);
  }
  return { errors, warnings };
}

export function validateTable(table, bom = DEFAULT_BOM, declaredVariables = []) {
  const inputs = bomInputs(bom);
  const outputs = bomOutputs(bom);
  const variableError = validateRuleSetVariables(declaredVariables);
  if (variableError) return { error: `规则集变量无效：${variableError}`, warnings: [] };
  const variables = canonicalRuleSetVariables(declaredVariables);
  if (variables.some(variable => (bom.fields || []).some(field => field.key === variable.name))) {
    return { error: '规则集变量名称不能与 BOM 字段重复', warnings: [] };
  }
  if (!table || typeof table !== 'object') return { error: '决策表内容无效', warnings: [] };
  if (typeof table.name !== 'string' || !table.name.trim() || table.name.length > 80) return { error: '名称需为 1–80 个字符', warnings: [] };
  if (typeof table.description !== 'string' || table.description.length > 500) return { error: '说明不能超过 500 个字符', warnings: [] };
  if (typeof table.category !== 'string' || !PACKAGE_NAME_RE.test(canonicalPackageName(table.category))) return { error: '规则包需为有效英文包名', warnings: [] };
  if (!Number.isInteger(table.priority) || table.priority < -1000 || table.priority > 1000) return { error: '优先级需为 -1000 到 1000 的整数', warnings: [] };
  if (!hitPolicies.some(policy => policy.key === hitPolicyOf(table))) return { error: '命中策略无效', warnings: [] };
  if (!Array.isArray(table.conditions) || table.conditions.length < 1 || table.conditions.length > inputs.length + variables.length) return { error: '条件列数量无效', warnings: [] };
  if (!Array.isArray(table.actions) || table.actions.length < 1 || table.actions.length > outputs.length + variables.length) return { error: '结果列数量无效', warnings: [] };
  const conditionKeys = new Set();
  for (const column of table.conditions) {
    const field = tableColumnField(column, bom, variables, 'input');
    if (!field || field.kind !== 'input' || conditionKeys.has(`${column?.fieldSource || 'bom'}:${field.key}`) || !operators.some(op => op.key === column.operator) || (field.type === 'Boolean' && !['==', '!='].includes(column.operator))) return { error: '条件列字段重复或比较方式无效', warnings: [] };
    conditionKeys.add(`${column?.fieldSource || 'bom'}:${field.key}`);
  }
  const actionKeys = new Set();
  for (const column of table.actions) {
    const field = tableColumnField(column, bom, variables, 'output');
    if (!field || field.kind !== 'output' || actionKeys.has(`${column?.fieldSource || 'bom'}:${field.key}`)) return { error: '结果列字段重复或无效', warnings: [] };
    actionKeys.add(`${column?.fieldSource || 'bom'}:${field.key}`);
  }
  if (!Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 200) return { error: '决策表需要 1–200 行', warnings: [] };

  const warnings = [];
  if (table.defaultRow != null && (!Number.isInteger(table.defaultRow) || table.defaultRow < 0 || table.defaultRow >= table.rows.length)) {
    return { error: '默认行标记无效', warnings: [] };
  }
  let defaultCount = 0;
  const activeRows = [];

  for (const [index, row] of table.rows.entries()) {
    if (typeof row?.enabled !== 'boolean' || !Array.isArray(row.conditions) || !Array.isArray(row.actions) || row.conditions.length !== table.conditions.length || row.actions.length !== table.actions.length) return { error: `第 ${index + 1} 行列数不匹配`, warnings: [] };
    if (row.conditions.some(cell => typeof cell !== 'string' && !isFieldReferenceCell(cell))) return { error: `第 ${index + 1} 行条件值无效`, warnings: [] };
    if (row.priority != null && (!Number.isInteger(row.priority) || row.priority < -1000 || row.priority > 1000)) return { error: `第 ${index + 1} 行优先级需为 -1000 到 1000 的整数`, warnings: [] };
    if (!row.enabled) continue;

    const isDefault = row.isDefault === true || table.defaultRow === index;
    if (isDefault) {
      defaultCount++;
      if (row.conditions.some(c => isFieldReferenceCell(c) || conditionCellText(c).trim() !== '')) return { error: `第 ${index + 1} 行被标记为默认行，但条件列不为空`, warnings: [] };
    }
    if (!isDefault && row.conditions.every(cell => !isFieldReferenceCell(cell) && conditionCellText(cell).trim() === '')) {
      warnings.push(`第 ${index + 1} 行所有条件均为空，将匹配任意输入（通配）`);
    }

    // 校验条件单元格值（区间/枚举/单值）
    for (let c = 0; c < table.conditions.length; c++) {
      const col = table.conditions[c];
      const field = tableColumnField(col, bom, variables, 'input');
      try {
        if (col.fieldSource === 'variable') parseVariableConditionCell(findRuleSetVariable(variables, col.field), col.operator, row.conditions[c]);
        else parseConditionCell(field, col.operator, row.conditions[c], bom);
      } catch (e) {
        return { error: `第 ${index + 1} 行：${e.message}`, warnings: [] };
      }
    }

    // 校验动作单元格
    let actionCount = 0;
    for (let c = 0; c < table.actions.length; c++) {
      const col = table.actions[c];
      const field = tableColumnField(col, bom, variables, 'output');
      if (typeof (row.actions[c] ?? '') !== 'string') return { error: `第 ${index + 1} 行：${field.label}的结果值无效`, warnings: [] };
      const cell = (row.actions[c] ?? '').trim();
      if (!cell) continue;
      actionCount++;
      if (col.fieldSource === 'variable'
        ? variableDrlValue(findRuleSetVariable(variables, col.field), cell) === null
        : formatDrlValue(field, cell) === null) return { error: `第 ${index + 1} 行：${field.label}的结果值"${cell}"无效`, warnings: [] };
    }
    if (actionCount === 0) return { error: `第 ${index + 1} 行没有任何结果赋值`, warnings: [] };

    if (!isDefault) activeRows.push({ row, index });
  }

  if (defaultCount > 1) return { error: '一个决策表最多一个默认行', warnings: [] };
  if (defaultCount === 1 && activeRows.length === 0) warnings.push('默认行存在但没有任何显式启用行，将作为全量兜底规则触发');

  // 冲突检测
  const { errors, warnings: conflicts } = analyzeTable(table, activeRows, inputs, outputs, bom, variables);
  if (errors.length) return { error: errors[0], warnings: conflicts };
  warnings.push(...conflicts);

  if (!activeRows.length && !defaultCount) return { error: '至少启用一行', warnings: [] };
  return { error: null, warnings };
}

export function tableRules(table, bom = DEFAULT_BOM, executionKey, declaredVariables = []) {
  const v = validateTable(table, bom, declaredVariables);
  if (v.error) throw new Error(v.error);
  const inputs = bomInputs(bom);
  const variables = canonicalRuleSetVariables(declaredVariables);
  const rules = [];
  const activeRows = [];
  const defaultRows = [];
  const policy = hitPolicyOf(table);
  const activationGroup = policy === 'ALL' || policy === 'COLLECT' ? null : `decision-table:${executionKey || fallbackExecutionKey(table)}`;
  for (const [index, row] of table.rows.entries()) {
    if (!row.enabled) continue;
    if (row.isDefault || table.defaultRow === index) defaultRows.push({ row, index });
    else activeRows.push({ row, index });
  }

  // 生成所有显式行的规则条件片段，供默认行引用
  const allRowFragments = activeRows.map(({ row, index }) => {
    const fragments = rowConditions(table, row, inputs, bom, variables);
    return { fragments, row, index };
  });

  for (const [position, { row, index }] of activeRows.entries()) {
    const parts = rowConditionParts(table, row, inputs, bom, variables);
    const actionEntries = [];
    for (let c = 0; c < table.actions.length; c++) {
      const cell = (row.actions[c] ?? '').trim();
      if (!cell) continue;
      actionEntries.push({ field: table.actions[c].field, fieldSource: table.actions[c].fieldSource || 'bom', value: cell });
    }
    rules.push({
      name: `${table.name} 第${index + 1}行`, description: '', category: table.category, priority: table.priority,
      salience: rowSalience(table, row, position, activeRows.length),
      activationGroup,
      tableRowIndex: index,
      tableDefault: false,
      collectHit: collectsHits(table) ? { tableName: table.name, rowIndex: index, defaultRow: false } : null,
      conditions: [...parts.input.map(frag => ({ raw: frag })), ...parts.variable],
      actions: actionEntries,
    });
  }

  // 默认行：为每个显式行生成一个独立的 not pattern
  for (const { row, index } of defaultRows) {
    const actionEntries = [];
    for (let c = 0; c < table.actions.length; c++) {
      const cell = (row.actions[c] ?? '').trim();
      if (!cell) continue;
      actionEntries.push({ field: table.actions[c].field, fieldSource: table.actions[c].fieldSource || 'bom', value: cell });
    }
    const notPatterns = allRowFragments.map(({ row: explicitRow }) => {
      const parts = rowConditionParts(table, explicitRow, inputs, bom, variables);
      const clauses = [
        `RuleInput( ${parts.input.join(', ')} )`,
        ...(parts.variable.length ? [`RuleContext( ${parts.variable.map(item => `${item.field} ${item.operator} ${variableDrlValue(findRuleSetVariable(variables, item.field), item.value)}`).join(', ')} )`] : []),
      ];
      return {
      pattern: 'not',
      condition: clauses.length === 1 ? clauses[0] : `( ${clauses.join(' and ')} )`,
      };
    });
    rules.push({
      name: `${table.name} 默认行`, description: '', category: table.category, priority: table.priority,
      salience: table.priority * TABLE_PRIORITY_SCALE - 1,
      activationGroup,
      tableRowIndex: index,
      tableDefault: true,
      collectHit: collectsHits(table) ? { tableName: table.name, rowIndex: index, defaultRow: true } : null,
      conditions: notPatterns,
      actions: actionEntries,
    });
  }
  return rules;
}

export const tableDrl = (table, bom = DEFAULT_BOM, executionKey, declaredVariables = null) => generateDrl(tableRules(table, bom, executionKey, declaredVariables || []), bom, declaredVariables);

/**
 * 将 Drools 返回的规则名转换为稳定的决策表行轨迹。
 * fired 的顺序就是实际触发顺序；COLLECT 额外标记为独立收集结果。
 */
export function tableExecutionTrace(table, fired = [], bom = DEFAULT_BOM, declaredVariables = []) {
  const generated = tableRules(table, bom, undefined, declaredVariables);
  const byRuleName = new Map(generated.map((rule, index) => [
    `${rule.name} [${index + 1}]`,
    rule,
  ]));
  const assignments = new Map();
  const collecting = collectsHits(table);

  return fired.map((ruleName, index) => {
    const rule = byRuleName.get(ruleName);
    if (!rule) return { order: index + 1, ruleName, rowIndex: null, isDefault: false, collected: false, actions: [] };
    const actions = rule.actions.map(action => {
      const previous = assignments.get(action.field);
      const entry = {
        field: action.field,
        value: action.value,
        collected: collecting,
        overwritten: collecting ? false : Boolean(previous),
        previousValue: collecting ? null : (previous?.value ?? null),
        previousOrder: collecting ? null : (previous?.order ?? null),
      };
      if (!collecting) assignments.set(action.field, { value: action.value, order: index + 1 });
      return entry;
    });
    return {
      order: index + 1,
      ruleName,
      rowIndex: rule.tableRowIndex,
      isDefault: rule.tableDefault,
      collected: collecting,
      actions,
    };
  });
}

export function tableCollectedHits(table, fired = [], bom = DEFAULT_BOM, declaredVariables = []) {
  if (!collectsHits(table)) return [];
  return tableExecutionTrace(table, fired, bom, declaredVariables)
    .filter(entry => entry.rowIndex !== null)
    .map(entry => ({
      order: entry.order,
      tableName: table.name,
      ruleName: entry.ruleName,
      rowIndex: entry.rowIndex,
      defaultRow: entry.isDefault,
      outputs: Object.fromEntries(entry.actions.map(action => [action.field, action.value])),
    }));
}

function flowConditionValue(field, raw) {
  if (formatDrlValue(field, raw) === null) throw new Error(`${field.label}的分支条件值无效`);
  const text = raw.trim();
  if (field.type === 'Boolean') return text === 'true';
  if (field.type === 'Integer' || field.type === 'Double') return Number(text);
  return text;
}

function flowConditionMatches(condition, facts) {
  if (!condition || facts[condition.field] == null) return false;
  const actual = facts[condition.field];
  const expected = condition.value;
  if (condition.operator === '==') return actual === expected;
  if (condition.operator === '!=') return actual !== expected;
  if (condition.operator === '>') return actual > expected;
  if (condition.operator === '>=') return actual >= expected;
  if (condition.operator === '<') return actual < expected;
  if (condition.operator === '<=') return actual <= expected;
  return false;
}

export function selectFlowBranch(branches = [], facts = {}) {
  const fallback = branches.find(branch => branch.default);
  return branches.find(branch => !branch.default && flowConditionMatches(branch.condition, facts)) || fallback || null;
}

function validateStepMappings(step, bom, label) {
  const groups = [
    { key: 'inputMappings', name: '输入映射', sourceKind: null, targetKind: 'input' },
    { key: 'outputMappings', name: '输出映射', sourceKind: 'output', targetKind: null },
  ];
  for (const group of groups) {
    const mappings = step?.[group.key] ?? [];
    if (!Array.isArray(mappings) || mappings.length > 20) return `${label}${group.name}数量无效`;
    const targets = new Set();
    for (const [index, mapping] of mappings.entries()) {
      const source = findField(bom, mapping?.source);
      const target = findField(bom, mapping?.target);
      if (!source || !target) return `${label}第 ${index + 1} 个${group.name}字段不存在`;
      if ((group.sourceKind && source.kind !== group.sourceKind) || (group.targetKind && target.kind !== group.targetKind)) {
        return `${label}第 ${index + 1} 个${group.name}字段方向无效`;
      }
      if (source.type !== target.type) return `${label}第 ${index + 1} 个${group.name}字段类型不一致`;
      if (source.key === target.key) return `${label}第 ${index + 1} 个${group.name}源字段和目标字段不能相同`;
      if (targets.has(target.key)) return `${label}${group.name}目标字段不能重复`;
      targets.add(target.key);
    }
  }
  return null;
}

export function applyFlowMappings(mappings = [], facts = {}) {
  return mappings.map(mapping => {
    const applied = facts[mapping.source] !== undefined && facts[mapping.source] !== null;
    const value = applied ? facts[mapping.source] : null;
    if (applied) facts[mapping.target] = value;
    return { source: mapping.source, target: mapping.target, value, applied };
  });
}

function packageExists(packageName, rules, tables, packages) {
  return packages.some(pkg => (pkg.name || pkg.id) === packageName)
    || [...rules, ...tables].some(asset => canonicalPackageName(asset.draft?.category) === packageName);
}

export function resolveRuleGroupMembers(selector, rules, tables, packages = []) {
  const packageName = canonicalPackageName(selector?.packageName);
  if (!packageName || !PACKAGE_NAME_RE.test(packageName)) throw new Error('Rule Group 规则包无效');
  if (typeof selector?.includeChildren !== 'boolean') throw new Error('Rule Group 包含子包选项无效');
  if (!packageExists(packageName, rules, tables, packages)) throw new Error(`规则包“${packageName}”不存在`);
  const included = category => category === packageName || (selector.includeChildren && category.startsWith(`${packageName}.`));
  const collect = (assets, type) => assets.flatMap(asset => {
    const category = canonicalPackageName(asset.draft?.category);
    if (!included(category) || asset.archived || asset.lifecycleStatus === 'deprecated' || !asset.published) return [];
    const version = asset.versions?.at(-1);
    if (!version) return [];
    return [{
      type,
      id: asset.id,
      name: asset.published.name || asset.draft?.name || asset.id,
      version: version.number,
      bomVersion: version.bomVersion ?? null,
      asset,
    }];
  });
  return [...collect(rules, 'rule'), ...collect(tables, 'table')]
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

export function ruleGroupFingerprint(members) {
  const manifest = members.map(member => `${member.type}:${member.id}:${member.version}`).sort().join('\n');
  return createHash('sha256').update(manifest).digest('hex');
}

function flowStepMembers(step, rules, tables, packages) {
  if (step?.type === 'rule-group') return resolveRuleGroupMembers(step.selector, rules, tables, packages);
  if (step?.type === 'subflow') return [];
  return step?.id ? [{ type: step.type, id: step.id }] : [];
}

function referencedFlow(step, flows = []) {
  return step?.type === 'subflow'
    ? flows.find(item => item.id === step.id && !item.archived && item.lifecycleStatus !== 'deprecated' && item.published && item.versions?.length)
    : null;
}

function publishedFlowDraft(item) {
  return item?.versions?.at(-1)?.draft || item?.draft || null;
}

function flowSubflowIds(flow) {
  return flowSteps(flow).filter(step => step?.type === 'subflow' && typeof step.id === 'string').map(step => step.id);
}

function validateSubflowDependency(rootFlow, rootFlowId, flows, bom, projectVariables, maximumDepth = 4) {
  const walk = (flow, path, depth) => {
    if (depth > maximumDepth) return `子流程最多嵌套 ${maximumDepth} 层`;
    for (const childId of flowSubflowIds(flow)) {
      if (childId === rootFlowId || path.includes(childId)) return '子流程引用存在直接或间接循环';
      const child = referencedFlow({ type: 'subflow', id: childId }, flows);
      if (!child) return `子流程“${childId}”不存在、未发布或已停用`;
      const version = child.versions.at(-1);
      if (version.bomVersion != null && version.bomVersion !== bom.version) {
        return `子流程“${child.published?.name || child.draft?.name || child.id}”使用 BOM v${version.bomVersion}，当前为 v${bom.version}，请先重新发布子流程`;
      }
      const childVariables = canonicalRuleSetVariables(child.published?.variables || []);
      const parentVariables = canonicalRuleSetVariables(projectVariables || []);
      if (parentVariables.length && childVariables.length && JSON.stringify(parentVariables) !== JSON.stringify(childVariables)) {
        return `子流程“${child.published?.name || child.draft?.name || child.id}”的规则集变量与当前项目不兼容`;
      }
      const childDraft = publishedFlowDraft(child);
      if (!childDraft) return `子流程“${child.id}”缺少已发布定义`;
      const error = walk(childDraft, [...path, childId], depth + 1);
      if (error) return error;
    }
    return null;
  };
  return walk(rootFlow, rootFlowId ? [rootFlowId] : [], 0);
}

function flowRuleAssets(flow, rules, tables, packages) {
  return flowSteps(flow)
    .flatMap(step => flowStepMembers(step, rules, tables, packages)
      .map(member => member.asset || (member.type === 'rule'
        ? rules.find(asset => asset.id === member.id)
        : tables.find(asset => asset.id === member.id)))
      .filter(asset => asset?.published)
      .filter(asset => rules.includes(asset)));
}

function validateFlowRuleVariableUsage(flow, rules, tables, packages, variables) {
  for (const asset of flowRuleAssets(flow, rules, tables, packages)) {
    const rule = asset.published;
    const ruleName = rule.name || asset.id;
    const conditions = ruleConditions(rule);
    for (const item of [...conditions, ...(rule.actions || [])]) {
      if (item?.fieldSource !== 'variable') continue;
      const variable = findRuleSetVariable(variables, item.field);
      if (!variable) return `规则“${ruleName}”引用的规则集变量“${item.field}”未在规则集中定义；正式入口为 Rule Project 属性`;
      if (conditions.includes(item)) {
        if (!['==', '!=', '>', '<', '>=', '<='].includes(item.operator)) return `规则“${ruleName}”的变量条件运算符无效`;
        if (variable.type === 'Boolean' && !['==', '!='].includes(item.operator)) return `规则“${ruleName}”的布尔变量只支持等于或不等于`;
      }
      if (variableDrlValue(variable, item.value) === null) return `规则“${ruleName}”的变量“${item.field}”值无效`;
    }
  }
  return null;
}

/**
 * Resolve the single variable scope used by a rule flow.
 *
 * A non-empty project variable array is authoritative. When it is empty or
 * absent, legacy flow/member declarations are merged for compatibility with
 * older assets that predate the Rule Project entry point.
 */
export function resolveFlowVariables(flow, rules, tables, bom = DEFAULT_BOM, packages = [], projectVariables = null) {
  if (flow?.variables != null && !Array.isArray(flow.variables)) throw new Error('规则集变量定义必须是数组');
  if (projectVariables != null && !Array.isArray(projectVariables)) throw new Error('Rule Project 变量定义必须是数组');
  const rawFlowVariables = Array.isArray(projectVariables) && projectVariables.length
    ? projectVariables
    : Array.isArray(flow?.variables) ? flow.variables : [];
  const flowVariableError = validateRuleSetVariables(rawFlowVariables);
  if (flowVariableError) throw new Error(`规则集变量无效：${flowVariableError}`);

  const authoritative = rawFlowVariables.length > 0;
  const merged = new Map(canonicalRuleSetVariables(rawFlowVariables).map(variable => [variable.name, variable]));
  for (const asset of flowRuleAssets(flow, rules, tables, packages)) {
    const memberVariables = normalizeRuleSetVariables(asset.published.variables);
    const memberError = validateRuleSetVariables(memberVariables);
    if (memberError) throw new Error(`规则“${asset.published.name || asset.id}”的变量无效：${memberError}`);
    for (const variable of canonicalRuleSetVariables(memberVariables)) {
      const previous = merged.get(variable.name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(variable)) {
        throw new Error(`规则集变量 "${variable.name}" 定义冲突`);
      }
      if (!authoritative) merged.set(variable.name, variable);
    }
  }

  const variables = canonicalRuleSetVariables([...merged.values()]);
  const bomKeys = new Set((bom?.fields || []).map(field => field.key));
  if (variables.some(variable => bomKeys.has(variable.name))) throw new Error('规则集变量名称不能与 BOM 字段重复');
  const usageError = validateFlowRuleVariableUsage(flow, rules, tables, packages, variables);
  if (usageError) throw new Error(usageError);
  return variables;
}

function repeatedGroupMemberError(steps, rules, tables, packages, label) {
  const seen = new Map();
  for (const [index, step] of steps.entries()) {
    for (const member of flowStepMembers(step, rules, tables, packages)) {
      const key = `${member.type}:${member.id}`;
      const previous = seen.get(key);
      if (previous && (previous.group || step.type === 'rule-group')) {
        return `${label}中资产“${member.name || member.id}”被步骤 ${previous.index + 1} 和 ${index + 1} 重复执行`;
      }
      if (!previous) seen.set(key, { index, group: step.type === 'rule-group' });
    }
  }
  return null;
}

function validateFlowEditor(editor) {
  if (editor == null) return null;
  if (typeof editor !== 'object' || Array.isArray(editor)) return '规则集画布信息无效';
  if (editor.positions != null) {
    if (typeof editor.positions !== 'object' || Array.isArray(editor.positions)) return '规则集节点位置无效';
    for (const position of Object.values(editor.positions)) {
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return '规则集节点位置无效';
    }
  }
  if (editor.viewport != null) {
    const { x, y, zoom } = editor.viewport;
    if (![x, y, zoom].every(Number.isFinite) || zoom < 0.25 || zoom > 2) return '规则集画布视口无效';
  }
  return null;
}

export function validateFlow(flow, rules, tables, bom = DEFAULT_BOM, packages = [], options = {}) {
  if (!flow || typeof flow !== 'object') return '规则集内容无效';
  if (typeof flow.name !== 'string' || !flow.name.trim() || flow.name.length > 80) return '名称需为 1–80 个字符';
  if (typeof flow.description !== 'string' || flow.description.length > 500) return '说明不能超过 500 个字符';
  const gateways = flowGateways(flow);
  if (!Array.isArray(flow.steps) || flow.steps.length > 20) return '规则集公共步骤数量无效';
  if (flow.gateways != null && !Array.isArray(flow.gateways)) return '规则集网关定义无效';
  if (gateways.length > 4) return '规则集最多支持 4 个排他网关';
  if (!isFlowGraph(flow) && !flow.steps.length && !gateways.length) return '规则集至少需要一个步骤或条件分支';
  const editorError = validateFlowEditor(flow.editor);
  if (editorError) return editorError;
  const nodeIds = new Set();
  const validateStep = (step, label) => {
    if (step?.nodeId != null) {
      if (typeof step.nodeId !== 'string' || !step.nodeId.trim() || step.nodeId.length > 100 || nodeIds.has(step.nodeId)) return `${label}节点 ID 无效或重复`;
      nodeIds.add(step.nodeId);
    }
    if (step?.type === 'rule-group') {
      let members;
      try { members = resolveRuleGroupMembers(step.selector, rules, tables, packages); }
      catch (error) { return `${label}${error.message}`; }
      if (!members.length && !options.allowEmptyRuleGroups) return `${label}引用的规则包没有已发布规则或决策表`;
      return null;
    }
    if (step?.type === 'subflow') {
      if (step.inputMappings?.length || step.outputMappings?.length) return `${label}子流程节点首版不支持字段映射`;
      const child = referencedFlow(step, options.flows || []);
      if (!child) return `${label}引用的子流程不存在、未发布或已停用`;
      if (child.id === options.currentFlowId) return `${label}不能引用当前规则集自身`;
      return null;
    }
    const collection = step?.type === 'rule' ? rules : step?.type === 'table' ? tables : null;
    return collection?.some(asset => asset.id === step.id && !asset.archived && asset.lifecycleStatus !== 'deprecated' && asset.published) ? null : `${label}引用的资产不存在或未发布（也可能已停用）`;
  };
  if (isFlowGraph(flow)) {
    const nodes = flowGraphNodes(flow);
    if (!nodes.length || nodes.length > 36) return '规则集图需包含 1–36 个节点';
    if (typeof flow.graph.entry !== 'string' || !flow.graph.entry || flow.graph.entry === 'end') return '规则集图入口无效';
    const graphNodeIds = new Set();
    const graphBranchIds = new Set();
    let graphStepCount = 0;
    let graphGatewayCount = 0;
    let graphParallelCount = 0;
    let graphJoinCount = 0;
    for (const [index, node] of nodes.entries()) {
      if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id || node.id === 'end' || node.id.length > 100 || graphNodeIds.has(node.id)) return `规则集图第 ${index + 1} 个节点 ID 无效或重复`;
      graphNodeIds.add(node.id);
      if (node.type === 'step') {
        graphStepCount++;
        const stepError = validateStep(node.step, `节点“${node.id}”`);
        if (stepError) return stepError;
        const mappingError = validateStepMappings(node.step, bom, `节点“${node.id}”`);
        if (mappingError) return mappingError;
        if (typeof node.next !== 'string' || !node.next) return `节点“${node.id}”后继节点无效`;
      } else if (node.type === 'gateway') {
        graphGatewayCount++;
        if (typeof node.name !== 'string' || !node.name.trim() || node.name.length > 40) return `网关“${node.id}”名称需为 1–40 个字符`;
        if (!Array.isArray(node.branches) || node.branches.length < 1 || node.branches.length > 8) return `网关“${node.name}”需包含 1–8 个分支`;
        let defaults = 0;
        let conditions = 0;
        for (const branch of node.branches) {
          if (!branch || typeof branch.id !== 'string' || !branch.id || branch.id.length > 80 || graphBranchIds.has(branch.id)) return `网关“${node.name}”分支 ID 无效或重复`;
          graphBranchIds.add(branch.id);
          if (typeof branch.name !== 'string' || !branch.name.trim() || branch.name.length > 40 || typeof branch.next !== 'string' || !branch.next) return `网关“${node.name}”分支定义无效`;
          if (branch.default === true) defaults++;
          else {
            conditions++;
            const field = findField(bom, branch.condition?.field);
            if (!field || !operators.some(operator => operator.key === branch.condition?.operator)) return `分支“${branch.name}”的条件字段或运算符无效`;
            if (field.type === 'Boolean' && !['==', '!='].includes(branch.condition.operator)) return `分支“${branch.name}”的布尔条件只支持等于或不等于`;
            try { flowConditionValue(field, branch.condition.value); }
            catch (error) { return `分支“${branch.name}”：${error.message}`; }
          }
        }
        if (!conditions || defaults > 1) return `网关“${node.name}”需至少一个条件分支且最多一个默认分支`;
      } else if (node.type === 'parallel') {
        graphParallelCount++;
        if (typeof node.name !== 'string' || !node.name.trim() || node.name.length > 40) return `并行网关“${node.id}”名称需为 1–40 个字符`;
        if (!Array.isArray(node.branches) || node.branches.length < 2 || node.branches.length > 8) return `并行网关“${node.name}”需包含 2–8 个分支`;
        if (typeof node.join !== 'string' || !node.join) return `并行网关“${node.name}”缺少聚合节点`;
        for (const branch of node.branches) {
          if (!branch || typeof branch.id !== 'string' || !branch.id || branch.id.length > 80 || graphBranchIds.has(branch.id)) return `并行网关“${node.name}”分支 ID 无效或重复`;
          graphBranchIds.add(branch.id);
          if (typeof branch.name !== 'string' || !branch.name.trim() || branch.name.length > 40 || typeof branch.next !== 'string' || !branch.next) return `并行网关“${node.name}”分支定义无效`;
        }
      } else if (node.type === 'join') {
        graphJoinCount++;
        if (typeof node.name !== 'string' || !node.name.trim() || node.name.length > 40 || typeof node.next !== 'string' || !node.next) return `聚合节点“${node.id}”定义无效`;
      } else return `规则集图节点“${node.id}”类型无效`;
    }
    if (graphStepCount < 1 || graphStepCount > 20) return '规则集图需包含 1–20 个步骤节点';
    if (graphGatewayCount > 8) return '规则集图最多支持 8 个排他网关';
    if (graphParallelCount > 4 || graphJoinCount > 4 || graphParallelCount !== graphJoinCount) return '规则集图最多支持 4 组并行网关与聚合节点，且必须一一配对';
    if (!graphNodeIds.has(flow.graph.entry)) return '规则集图入口节点不存在';
    const targets = node => node.type === 'step' || node.type === 'join' ? [node.next] : node.branches.map(branch => branch.next);
    for (const node of nodes) {
      for (const target of targets(node)) if (target !== 'end' && !graphNodeIds.has(target)) return `节点“${node.id}”引用的后继节点“${target}”不存在`;
    }
    const byId = new Map(nodes.map(node => [node.id, node]));
    const assignedJoins = new Set();
    for (const parallel of nodes.filter(node => node.type === 'parallel')) {
      const join = byId.get(parallel.join);
      if (join?.type !== 'join' || assignedJoins.has(join.id)) return `并行网关“${parallel.name}”引用的聚合节点无效或重复`;
      assignedJoins.add(join.id);
      const branchNodes = [];
      const reachesJoin = (id, seen = new Set()) => {
        if (id === join.id) return true;
        if (id === 'end' || seen.has(id)) return false;
        const node = byId.get(id);
        if (!node || node.type === 'parallel' || node.type === 'join') return false;
        seen.add(id);
        const nextTargets = targets(node);
        const valid = nextTargets.length > 0 && nextTargets.every(target => reachesJoin(target, new Set(seen)));
        if (valid) for (const target of nextTargets) if (target !== join.id) seen.add(target);
        return valid;
      };
      for (const branch of parallel.branches) {
        const collected = new Set();
        const collect = id => {
          if (id === join.id || collected.has(id)) return;
          collected.add(id);
          const node = byId.get(id);
          if (node) for (const target of targets(node)) collect(target);
        };
        if (!reachesJoin(branch.next)) return `并行分支“${branch.name}”必须汇入聚合节点“${join.name}”且不能包含嵌套并行`;
        collect(branch.next);
        if (branchNodes.some(existing => [...collected].some(id => existing.has(id)))) return `并行网关“${parallel.name}”的分支在聚合前不能共享节点`;
        branchNodes.push(collected);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const paths = [];
    const walk = (id, path = []) => {
      if (id === 'end') { paths.push(path); return null; }
      if (visiting.has(id)) return '规则集图存在循环';
      const node = byId.get(id);
      if (!node) return `规则集图节点“${id}”不存在`;
      visiting.add(id);
      visited.add(id);
      const nextPath = node.type === 'step' ? [...path, node.step] : path;
      for (const target of targets(node)) {
        const error = walk(target, nextPath);
        if (error) return error;
      }
      visiting.delete(id);
      return null;
    };
    const graphError = walk(flow.graph.entry);
    if (graphError) return graphError;
    if (visited.size !== nodes.length) return '规则集图存在从入口不可达的孤立节点';
    for (const [index, path] of paths.entries()) {
      const repeated = repeatedGroupMemberError(path, rules, tables, packages, `第 ${index + 1} 条图路径`);
      if (repeated) return repeated;
    }
    const subflowError = validateSubflowDependency(flow, options.currentFlowId, options.flows || [], bom, options.projectVariables);
    if (subflowError) return subflowError;
    try { resolveFlowVariables(flow, rules, tables, bom, packages, options.projectVariables); }
    catch (error) { return error.message; }
    return null;
  }
  for (const [index, step] of flow.steps.entries()) {
    const stepError = validateStep(step, `第 ${index + 1} 个公共步骤`);
    if (stepError) return stepError;
    const mappingError = validateStepMappings(step, bom, `第 ${index + 1} 个公共步骤`);
    if (mappingError) return mappingError;
  }
  const gatewayIds = new Set();
  const branchIds = new Set();
  let totalSteps = flow.steps.length;
  const gatewayPositions = new Set();
  for (const [gatewayIndex, gateway] of gateways.entries()) {
    if (!gateway || typeof gateway !== 'object') return `第 ${gatewayIndex + 1} 个网关无效`;
    if (typeof gateway.id !== 'string' || !gateway.id || gateway.id.length > 80 || gatewayIds.has(gateway.id)) return `第 ${gatewayIndex + 1} 个网关 ID 无效或重复`;
    gatewayIds.add(gateway.id);
    if (gateway.name != null && (typeof gateway.name !== 'string' || !gateway.name.trim() || gateway.name.length > 40)) return `第 ${gatewayIndex + 1} 个网关名称需为 1–40 个字符`;
    if (!Number.isInteger(gateway.afterStep) || gateway.afterStep < 0 || gateway.afterStep > flow.steps.length || gatewayPositions.has(gateway.afterStep)) return `网关“${gateway.name || gateway.id}”插入位置无效或重复`;
    gatewayPositions.add(gateway.afterStep);
    const branches = gateway.branches;
    if (!Array.isArray(branches) || branches.length < 1 || branches.length > 8) return `网关“${gateway.name || gateway.id}”需包含 1–8 个分支`;
    let defaultCount = 0;
    let conditionalCount = 0;
    for (const [branchIndex, branch] of branches.entries()) {
      if (!branch || typeof branch !== 'object') return `网关“${gateway.name || gateway.id}”第 ${branchIndex + 1} 个分支无效`;
      if (typeof branch.id !== 'string' || !branch.id || branch.id.length > 80 || branchIds.has(branch.id)) return `第 ${branchIndex + 1} 个分支 ID 无效或重复`;
      branchIds.add(branch.id);
      if (typeof branch.name !== 'string' || !branch.name.trim() || branch.name.length > 40) return `第 ${branchIndex + 1} 个分支名称需为 1–40 个字符`;
      if (!Array.isArray(branch.steps) || branch.steps.length < 1) return `分支“${branch.name}”至少需要一个步骤`;
      totalSteps += branch.steps.length;
      if (branch.default === true) defaultCount++;
      else {
        conditionalCount++;
        const condition = branch.condition;
        const field = findField(bom, condition?.field);
        if (!field || !operators.some(operator => operator.key === condition?.operator)) return `分支“${branch.name}”的条件字段或运算符无效`;
        if (field.type === 'Boolean' && !['==', '!='].includes(condition.operator)) return `分支“${branch.name}”的布尔条件只支持等于或不等于`;
        try { flowConditionValue(field, condition.value); }
        catch (error) { return `分支“${branch.name}”：${error.message}`; }
      }
      for (const [stepIndex, step] of branch.steps.entries()) {
        const stepError = validateStep(step, `分支“${branch.name}”第 ${stepIndex + 1} 步`);
        if (stepError) return stepError;
        const mappingError = validateStepMappings(step, bom, `分支“${branch.name}”第 ${stepIndex + 1} 步`);
        if (mappingError) return mappingError;
      }
    }
    if (!conditionalCount) return `网关“${gateway.name || gateway.id}”至少需要一个条件分支`;
    if (defaultCount > 1) return `网关“${gateway.name || gateway.id}”最多一个默认分支`;
  }
  if (totalSteps > 20) return '规则集全部路径合计最多 20 个步骤';
  if (flow.steps.some(step => step.type === 'rule-group')) {
    const repeated = repeatedGroupMemberError(flow.steps, rules, tables, packages, '公共路径');
    if (repeated) return repeated;
  }
  for (const gateway of gateways) {
    for (const branch of gateway.branches) {
      const path = [...flow.steps, ...branch.steps];
      if (!path.some(step => step.type === 'rule-group')) continue;
      const repeated = repeatedGroupMemberError(path, rules, tables, packages, `分支“${branch.name}”路径`);
      if (repeated) return repeated;
    }
  }
  const subflowError = validateSubflowDependency(flow, options.currentFlowId, options.flows || [], bom, options.projectVariables);
  if (subflowError) return subflowError;
  try {
    resolveFlowVariables(flow, rules, tables, bom, packages, options.projectVariables);
  } catch (error) {
    return error.message;
  }
  return null;
}

function frozenFlowGraph(flow) {
  if (isFlowGraph(flow)) return structuredClone(flow.graph);
  const gateways = flowGateways(flow);
  const gatewayAt = new Map(gateways.map(gateway => [gateway.afterStep, gateway]));
  const commonIds = flow.steps.map((step, index) => step.nodeId || `common:${index}`);
  const boundaryTarget = boundary => gatewayAt.get(boundary)?.id || commonIds[boundary] || 'end';
  const nodes = flow.steps.map((step, index) => ({
    id: commonIds[index], type: 'step', step: structuredClone(step), next: boundaryTarget(index + 1),
  }));
  for (const gateway of gateways) {
    const mergeTarget = commonIds[gateway.afterStep] || 'end';
    nodes.push({
      id: gateway.id, type: 'gateway', name: gateway.name || '排他网关',
      branches: gateway.branches.map(branch => ({
        id: branch.id, name: branch.name, default: branch.default === true,
        condition: branch.default ? null : structuredClone(branch.condition),
        next: branch.steps[0]?.nodeId || `branch:${branch.id}:0`,
      })),
    });
    for (const branch of gateway.branches) branch.steps.forEach((step, index) => nodes.push({
      id: step.nodeId || `branch:${branch.id}:${index}`,
      type: 'step', step: structuredClone(step),
      next: branch.steps[index + 1]?.nodeId || (index + 1 < branch.steps.length ? `branch:${branch.id}:${index + 1}` : mergeTarget),
    }));
  }
  return { entry: boundaryTarget(0), nodes };
}

function namespaceGraph(graph, prefix, exit, subflow) {
  const nodeId = id => id === 'end' ? exit : `${prefix}/${id}`;
  const branchId = id => `${prefix}/${id}`;
  const inheritedPath = step => (step.subflowPath || []).map(item => ({ ...item, nodeId: `${prefix}/${item.nodeId}` }));
  return {
    entry: nodeId(graph.entry),
    nodes: graph.nodes.map(node => node.type === 'step'
      ? {
          id: nodeId(node.id), type: 'step', next: nodeId(node.next),
          step: { ...structuredClone(node.step), nodeId: nodeId(node.id), subflowPath: [subflow, ...inheritedPath(node.step)] },
        }
      : node.type === 'join'
        ? { ...structuredClone(node), id: nodeId(node.id), next: nodeId(node.next) }
        : node.type === 'parallel'
          ? { ...structuredClone(node), id: nodeId(node.id), join: nodeId(node.join), branches: node.branches.map(branch => ({ ...structuredClone(branch), id: branchId(branch.id), next: nodeId(branch.next) })) }
          : { ...structuredClone(node), id: nodeId(node.id), branches: node.branches.map(branch => ({ ...structuredClone(branch), id: branchId(branch.id), next: nodeId(branch.next) })) }),
  };
}

function expandFrozenSubflows(snapshot) {
  if (!flowSteps(snapshot).some(step => step.type === 'subflow')) return snapshot;
  const graph = frozenFlowGraph(snapshot);
  const manifests = [];
  let nodes = structuredClone(graph.nodes);
  let entry = graph.entry;
  while (nodes.some(node => node.type === 'step' && node.step.type === 'subflow')) {
    const target = nodes.find(node => node.type === 'step' && node.step.type === 'subflow');
    const child = expandFrozenSubflows(target.step.snapshot);
    const childGraph = frozenFlowGraph(child);
    const manifest = { id: target.step.id, name: target.step.name, version: target.step.version, nodeId: target.id };
    manifests.push(manifest, ...(child.subflows || []).map(item => ({ ...item, nodeId: `${target.id}/${item.nodeId}` })));
    const namespaced = namespaceGraph(childGraph, target.id, target.next, manifest);
    entry = entry === target.id ? namespaced.entry : entry;
    nodes = nodes.flatMap(node => {
      if (node.id === target.id) return namespaced.nodes;
      if (node.type === 'step' || node.type === 'join') return [{ ...node, next: node.next === target.id ? namespaced.entry : node.next }];
      return [{ ...node, branches: node.branches.map(branch => ({ ...branch, next: branch.next === target.id ? namespaced.entry : branch.next })) }];
    });
  }
  const stepCount = nodes.filter(node => node.type === 'step').length;
  if (stepCount > 20 || nodes.length > 36) throw new Error('展开子流程后最多支持 20 个步骤和 36 个图节点');
  if (nodes.filter(node => node.type === 'gateway').length > 8) throw new Error('展开子流程后最多支持 8 个排他网关');
  if (nodes.filter(node => node.type === 'parallel').length > 4) throw new Error('展开子流程后最多支持 4 组并行网关与聚合节点');
  const byId = new Map(nodes.map(node => [node.id, node]));
  const targets = node => node.type === 'step' || node.type === 'join' ? [node.next] : node.branches.map(branch => branch.next);
  for (const parallel of nodes.filter(node => node.type === 'parallel')) {
    const containsNestedParallel = (id, seen = new Set()) => {
      if (id === parallel.join || id === 'end' || seen.has(id)) return false;
      const node = byId.get(id);
      if (!node) return false;
      if (node.type === 'parallel') return true;
      seen.add(id);
      return targets(node).some(target => containsNestedParallel(target, new Set(seen)));
    };
    if (parallel.branches.some(branch => containsNestedParallel(branch.next))) throw new Error('子流程展开后形成嵌套并行，当前版本不支持');
  }
  return {
    ...snapshot,
    steps: [],
    graph: { entry, nodes },
    subflows: manifests.filter((item, index, all) => all.findIndex(candidate => candidate.nodeId === item.nodeId) === index),
  };
}

export function flowSnapshot(flow, rules, tables, bom = DEFAULT_BOM, packages = [], projectVariables = null, options = {}) {
  const validationOptions = { ...options, projectVariables };
  const error = validateFlow(flow, rules, tables, bom, packages, validationOptions);
  if (error) throw new Error(error);
  const variables = resolveFlowVariables(flow, rules, tables, bom, packages, projectVariables);
  const freezeStep = step => {
    if (step.type === 'subflow') {
      const child = referencedFlow(step, options.flows || []);
      const version = child.versions.at(-1);
      return {
        nodeId: step.nodeId,
        type: 'subflow',
        id: child.id,
        name: child.published.name || child.draft?.name || child.id,
        version: version.number,
        snapshot: structuredClone(child.published),
      };
    }
    if (step.type === 'rule-group') {
      const resolved = resolveRuleGroupMembers(step.selector, rules, tables, packages);
      const executableRules = resolved.flatMap(member => {
        const published = member.asset.published;
        if (member.bomVersion != null && member.bomVersion !== bom.version) {
          throw new DomainError('ASSET_BOM_OUTDATED', `${member.name} 使用 BOM v${member.bomVersion}，当前为 v${bom.version}，请先重新发布该资产`, {
            assetId: member.id, assetName: member.name, pinnedBomVersion: member.bomVersion,
            currentBomVersion: bom.version, suggestedAction: 'republish',
          });
        }
        if (member.type === 'rule') {
          return [{ ...structuredClone(published), name: `${published.name} [${member.id}]` }];
        }
        const generated = isRuleTemplate(published)
          ? ruleTemplateRules(published, bom)
          : isScorecard(published)
          ? scorecardRules(published, bom, member.id, variables)
          : isDecisionTree(published)
          ? decisionTreeRules(published, bom, member.id, variables)
          : tableRules(published, bom, member.id, variables);
        return generated.map(rule => ({ ...rule, name: `${rule.name} [${member.id}]` }));
      });
      const frozen = {
        nodeId: step.nodeId,
        type: 'rule-group',
        name: `规则组：${step.selector.packageName}`,
        packageName: step.selector.packageName,
        includeChildren: step.selector.includeChildren,
        members: resolved.map(({ type, id, name, version, bomVersion }) => ({ type, id, name, version, bomVersion })),
        memberFingerprint: ruleGroupFingerprint(resolved),
        variables,
        drl: generateDrl(executableRules, bom, variables),
      };
      if (step.inputMappings?.length) frozen.inputMappings = structuredClone(step.inputMappings);
      if (step.outputMappings?.length) frozen.outputMappings = structuredClone(step.outputMappings);
      return frozen;
    }
    const asset = (step.type === 'rule' ? rules : tables).find(item => item.id === step.id);
    const version = asset.versions.at(-1);
    if (version.bomVersion != null && version.bomVersion !== bom.version) {
      throw new DomainError('ASSET_BOM_OUTDATED', `${asset.published.name} 使用 BOM v${version.bomVersion}，当前为 v${bom.version}，请先重新发布该资产`, {
        assetId: asset.id, assetName: asset.published.name, pinnedBomVersion: version.bomVersion,
        currentBomVersion: bom.version, suggestedAction: 'republish',
      });
    }
    const frozen = { nodeId: step.nodeId, type: step.type, id: step.id, name: asset.published.name, version: asset.versions.at(-1)?.number,
      variables,
      drl: step.type === 'rule'
        ? generateDrl([asset.published], bom, variables)
        : isRuleTemplate(asset.published)
          ? ruleTemplateDrl(asset.published, bom)
        : isScorecard(asset.published)
          ? scorecardDrl(asset.published, bom, asset.id, variables)
          : isDecisionTree(asset.published)
          ? decisionTreeDrl(asset.published, bom, asset.id, variables)
          : tableDrl(asset.published, bom, asset.id, variables) };
    if (step.inputMappings?.length) frozen.inputMappings = structuredClone(step.inputMappings);
    if (step.outputMappings?.length) frozen.outputMappings = structuredClone(step.outputMappings);
    return frozen;
  };
  if (isFlowGraph(flow)) {
    return expandFrozenSubflows({
      name: flow.name,
      description: flow.description,
      bomVersion: bom.version,
      bom: structuredClone(bom),
      variables,
      steps: [],
      graph: {
        entry: flow.graph.entry,
        nodes: flow.graph.nodes.map(node => node.type === 'step'
          ? { id: node.id, type: 'step', step: freezeStep(node.step), next: node.next }
          : node.type === 'join'
            ? { id: node.id, type: 'join', name: node.name, next: node.next }
          : node.type === 'parallel'
            ? { id: node.id, type: 'parallel', name: node.name, join: node.join, branches: structuredClone(node.branches) }
          : {
              id: node.id,
              type: 'gateway',
              name: node.name,
              branches: node.branches.map(branch => {
                const field = branch.default ? null : findField(bom, branch.condition.field);
                return {
                  id: branch.id,
                  name: branch.name,
                  default: branch.default === true,
                  condition: branch.default ? null : {
                    field: branch.condition.field,
                    operator: branch.condition.operator,
                    value: flowConditionValue(field, branch.condition.value),
                  },
                  next: branch.next,
                };
              }),
            }),
      },
    });
  }
  const steps = flow.steps.map(freezeStep);
  const gateways = flowGateways(flow).map(gateway => ({
    id: gateway.id,
    name: gateway.name || '排他网关',
    afterStep: gateway.afterStep,
    branches: gateway.branches.map(branch => {
      const field = branch.default ? null : findField(bom, branch.condition.field);
      return {
        id: branch.id,
        name: branch.name,
        default: branch.default === true,
        condition: branch.default ? null : {
          field: branch.condition.field,
          operator: branch.condition.operator,
          value: flowConditionValue(field, branch.condition.value),
        },
        steps: branch.steps.map(freezeStep),
      };
    }),
  }));
  const snapshot = {
    name: flow.name,
    description: flow.description,
    bomVersion: bom.version,
    bom: structuredClone(bom),
    variables,
    steps,
  };
  if (Array.isArray(flow.gateways) && (flow.gateways.length || !Array.isArray(flow.branches) || !flow.branches.length)) snapshot.gateways = gateways;
  else snapshot.branches = gateways[0]?.branches || [];
  return expandFrozenSubflows(snapshot);
}
