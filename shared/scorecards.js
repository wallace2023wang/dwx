import { findField, inferSemanticType, inputFields, outputFields } from './bom.js';
import { generateTrustedDrl, parseValue, validateRule } from './rules.js';
import { canonicalPackageName, DEFAULT_PACKAGE_NAME, PACKAGE_NAME_RE } from './packages.js';

const SCORE_LIMIT = 1000000;
const SCORECARD_PRIORITY_SCALE = 1000000;
const operators = new Set(['==', '!=', '>', '>=', '<', '<=']);

const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;

function numericOutputs(bom) {
  return outputFields(bom).filter(field => ['Integer', 'Decimal'].includes(inferSemanticType(field)));
}

function rowValue(field) {
  if (!field) return '';
  if (field.type === 'Boolean') return 'true';
  if (field.type === 'Integer' || field.type === 'Double') return String(field.min ?? 0);
  return field.enum?.[0] || '';
}

function defaultBandAction(bom, scoreField) {
  const output = outputFields(bom).find(field => field.key !== scoreField);
  return output ? [{ field: output.key, value: rowValue(output) }] : [];
}

export function newScorecard(bom) {
  const input = inputFields(bom).find(field => ['Integer', 'Decimal'].includes(inferSemanticType(field))) || inputFields(bom)[0];
  const scoreOutput = numericOutputs(bom)[0];
  const actions = defaultBandAction(bom, scoreOutput?.key);
  return {
    kind: 'scorecard',
    name: '未命名计分卡',
    description: '',
    category: DEFAULT_PACKAGE_NAME,
    priority: 0,
    scoreOutputField: scoreOutput?.key || '',
    initialScore: 0,
    characteristics: [{
      id: id('characteristic'), name: input?.label || '评分特征', field: input?.key || '',
      rows: [
        { id: id('bin'), label: '低分箱', operator: input?.type === 'Boolean' ? '==' : '<', value: rowValue(input), score: 0 },
        { id: id('bin'), label: '其他', default: true, score: 10 },
      ],
    }],
    bands: [
      { id: id('band'), label: '低分段', min: null, max: 10, actions: structuredClone(actions) },
      { id: id('band'), label: '高分段', min: 10, max: null, actions: structuredClone(actions) },
    ],
  };
}

export function isScorecard(value) {
  return value?.kind === 'scorecard';
}

function finiteScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -SCORE_LIMIT && value <= SCORE_LIMIT;
}

function conditionFor(characteristic, row) {
  return { field: characteristic.field, operator: row.operator, value: row.value };
}

function validateBandActions(scorecard, band, bom, condition) {
  if (!Array.isArray(band.actions) || band.actions.length > 20) return '结果动作数量无效';
  if (band.actions.some(action => action.field === scorecard.scoreOutputField && action.fieldSource !== 'variable')) return '结果动作不能重复设置总分字段';
  if (!band.actions.length) return null;
  return validateRule({
    name: `${scorecard.name} / ${band.label}`, description: '', category: scorecard.category, priority: scorecard.priority,
    conditions: [condition], actions: band.actions,
  }, bom, []);
}

export function validateScorecard(scorecard, bom, variables = []) {
  if (!isScorecard(scorecard)) return '计分卡内容无效';
  if (typeof scorecard.name !== 'string' || !scorecard.name.trim() || scorecard.name.length > 80) return '名称需为 1–80 个字符';
  if (typeof scorecard.description !== 'string' || scorecard.description.length > 500) return '说明不能超过 500 个字符';
  if (typeof scorecard.category !== 'string' || !PACKAGE_NAME_RE.test(canonicalPackageName(scorecard.category))) return '规则包需为有效英文包名';
  if (!Number.isInteger(scorecard.priority) || scorecard.priority < -1000 || scorecard.priority > 1000) return '优先级需为 -1000 到 1000 的整数';
  const scoreField = findField(bom, scorecard.scoreOutputField);
  if (!scoreField || scoreField.kind !== 'output' || !['Integer', 'Decimal'].includes(inferSemanticType(scoreField))) return '总分输出字段必须是数值输出字段';
  if (!finiteScore(scorecard.initialScore)) return '初始分需为 -1000000 到 1000000 的数字';
  if (inferSemanticType(scoreField) === 'Integer' && !Number.isInteger(scorecard.initialScore)) return '整数总分字段要求初始分和分箱分值均为整数';
  if (!Array.isArray(scorecard.characteristics) || scorecard.characteristics.length < 1 || scorecard.characteristics.length > 20) return '计分卡需要 1–20 个评分特征';
  const characteristicIds = new Set();
  let sampleCondition = null;
  for (const [characteristicIndex, characteristic] of scorecard.characteristics.entries()) {
    if (typeof characteristic?.id !== 'string' || !characteristic.id || characteristicIds.has(characteristic.id)) return '评分特征 ID 无效或重复';
    characteristicIds.add(characteristic.id);
    if (typeof characteristic.name !== 'string' || !characteristic.name.trim() || characteristic.name.length > 80) return `第 ${characteristicIndex + 1} 个评分特征名称无效`;
    const field = findField(bom, characteristic.field);
    if (!field || field.kind !== 'input') return `评分特征“${characteristic.name}”引用的输入字段无效`;
    if (!Array.isArray(characteristic.rows) || characteristic.rows.length < 2 || characteristic.rows.length > 50) return `评分特征“${characteristic.name}”需要 2–50 个分箱`;
    const rowIds = new Set();
    let defaults = 0;
    for (const [rowIndex, row] of characteristic.rows.entries()) {
      if (typeof row?.id !== 'string' || !row.id || rowIds.has(row.id)) return `评分特征“${characteristic.name}”分箱 ID 无效或重复`;
      rowIds.add(row.id);
      if (typeof row.label !== 'string' || !row.label.trim() || row.label.length > 80) return `评分特征“${characteristic.name}”第 ${rowIndex + 1} 个分箱名称无效`;
      if (!finiteScore(row.score)) return `评分特征“${characteristic.name}”第 ${rowIndex + 1} 个分箱分值无效`;
      if (inferSemanticType(scoreField) === 'Integer' && !Number.isInteger(row.score)) return '整数总分字段要求初始分和分箱分值均为整数';
      if (row.default === true) { defaults += 1; continue; }
      if (!operators.has(row.operator)) return `评分特征“${characteristic.name}”第 ${rowIndex + 1} 个分箱运算符无效`;
      const condition = conditionFor(characteristic, row);
      const validation = validateRule({
        name: '分箱校验', description: '', category: scorecard.category, priority: 0,
        conditions: [condition], actions: [{ field: scorecard.scoreOutputField, value: '0' }],
      }, bom, []);
      if (validation) return `评分特征“${characteristic.name}”第 ${rowIndex + 1} 个分箱：${validation}`;
      sampleCondition ||= condition;
    }
    if (defaults !== 1) return `评分特征“${characteristic.name}”必须且只能包含一个默认分箱`;
    if (characteristic.rows.at(-1)?.default !== true) return `评分特征“${characteristic.name}”的默认分箱必须放在最后`;
  }
  if (!Array.isArray(scorecard.bands) || scorecard.bands.length < 1 || scorecard.bands.length > 20) return '计分卡需要 1–20 个结果分段';
  const bandIds = new Set();
  for (const [index, band] of scorecard.bands.entries()) {
    if (typeof band?.id !== 'string' || !band.id || bandIds.has(band.id)) return '结果分段 ID 无效或重复';
    bandIds.add(band.id);
    if (typeof band.label !== 'string' || !band.label.trim() || band.label.length > 80) return `第 ${index + 1} 个结果分段名称无效`;
    if (band.min !== null && !finiteScore(band.min)) return `结果分段“${band.label}”下界无效`;
    if (band.max !== null && !finiteScore(band.max)) return `结果分段“${band.label}”上界无效`;
    if (band.min !== null && band.max !== null && band.min >= band.max) return `结果分段“${band.label}”下界必须小于上界`;
    if (index === 0 && band.min !== null) return '第一个结果分段必须从负无穷开始';
    if (index === scorecard.bands.length - 1 && band.max !== null) return '最后一个结果分段必须覆盖到正无穷';
    if (index > 0 && scorecard.bands[index - 1].max !== band.min) return `结果分段“${band.label}”与前一分段之间存在重叠或缺口`;
    const actionError = validateBandActions(scorecard, band, bom, sampleCondition);
    if (actionError) return `结果分段“${band.label}”：${actionError}`;
  }
  return null;
}

function literalDrl(field, value) {
  return parseValue(field, String(value));
}

function rowConstraint(field, row, getter = false) {
  const left = getter ? `$input.get${field.key[0].toUpperCase()}${field.key.slice(1)}()` : field.key;
  const value = literalDrl(field, row.value);
  const semanticType = inferSemanticType(field);
  if (semanticType === 'String' || semanticType === 'Date') {
    if (row.operator === '==') return `${left} != null && ${left}.equals(${value})`;
    if (row.operator === '!=') return `${left} == null || !${left}.equals(${value})`;
  }
  return `${left} != null && ${left} ${row.operator} ${value}`;
}

function scoreExpression(scorecard, bom, getter = false) {
  const characteristicExpressions = scorecard.characteristics.map(characteristic => {
    const field = findField(bom, characteristic.field);
    const rows = characteristic.rows;
    let expression = `${Number(rows.at(-1).score)}d`;
    for (let index = rows.length - 2; index >= 0; index -= 1) {
      const row = rows[index];
      expression = `((${rowConstraint(field, row, getter)}) ? ${Number(row.score)}d : ${expression})`;
    }
    return expression;
  });
  return characteristicExpressions.reduce((total, expression) => `(${total} + ${expression})`, `${Number(scorecard.initialScore)}d`);
}

function bandConstraint(expression, band) {
  const parts = [];
  if (band.min !== null) parts.push(`${expression} >= ${Number(band.min)}d`);
  if (band.max !== null) parts.push(`${expression} < ${Number(band.max)}d`);
  return parts.length ? parts.map(part => `(${part})`).join(' && ') : 'true';
}

function fallbackExecutionKey(scorecard) {
  let hash = 2166136261;
  for (const character of JSON.stringify([scorecard.name, scorecard.characteristics, scorecard.bands])) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

export function scorecardRules(scorecard, bom, executionKey, variables = []) {
  const error = validateScorecard(scorecard, bom, variables);
  if (error) throw new Error(error);
  const constraintExpression = scoreExpression(scorecard, bom, false);
  const valueExpression = scoreExpression(scorecard, bom, true);
  const scoreField = findField(bom, scorecard.scoreOutputField);
  const scoreValueDrl = inferSemanticType(scoreField) === 'Integer'
    ? `(int) Math.round(${valueExpression})`
    : `(double) (${valueExpression})`;
  const activationGroup = `scorecard:${executionKey || fallbackExecutionKey(scorecard)}`;
  return scorecard.bands.map((band, index) => ({
    name: `${scorecard.name} / ${band.label}`,
    description: scorecard.description,
    category: scorecard.category,
    priority: scorecard.priority,
    salience: scorecard.priority * SCORECARD_PRIORITY_SCALE + scorecard.bands.length - index,
    activationGroup,
    scorecardBandId: band.id,
    conditions: [{ raw: bandConstraint(constraintExpression, band) }],
    actions: [{ field: scorecard.scoreOutputField, value: '0', valueDrl: scoreValueDrl }, ...structuredClone(band.actions)],
  }));
}

export function scorecardDrl(scorecard, bom, executionKey, variables = []) {
  return generateTrustedDrl(scorecardRules(scorecard, bom, executionKey, variables), bom, variables);
}

function matchesRow(field, row, value) {
  if (row.default) return true;
  const expected = field.type === 'Boolean' ? row.value === 'true'
    : field.type === 'Integer' || field.type === 'Double' ? Number(row.value) : row.value;
  if (row.operator === '==') return value === expected;
  if (row.operator === '!=') return value !== expected;
  if (row.operator === '>') return value > expected;
  if (row.operator === '>=') return value >= expected;
  if (row.operator === '<') return value < expected;
  return value <= expected;
}

export function evaluateScorecard(scorecard, facts, bom) {
  const characteristicHits = scorecard.characteristics.map(characteristic => {
    const field = findField(bom, characteristic.field);
    const row = characteristic.rows.find(candidate => matchesRow(field, candidate, facts[characteristic.field]));
    return { characteristicId: characteristic.id, characteristic: characteristic.name, field: characteristic.field, rowId: row.id, row: row.label, score: row.score };
  });
  const total = characteristicHits.reduce((sum, hit) => sum + hit.score, scorecard.initialScore);
  const band = scorecard.bands.find(candidate => (candidate.min === null || total >= candidate.min) && (candidate.max === null || total < candidate.max));
  return { initialScore: scorecard.initialScore, total, characteristicHits, bandId: band?.id || null, band: band?.label || null };
}

export function scorecardExecutionTrace(scorecard, fired = [], facts = {}, bom) {
  const evaluation = evaluateScorecard(scorecard, facts, bom);
  const rules = scorecardRules(scorecard, bom);
  const firedBand = fired.map(name => {
    const index = rules.findIndex((rule, position) => name === `${rule.name} [${position + 1}]` || name.startsWith(`${rule.name} [`));
    return index >= 0 ? scorecard.bands[index] : null;
  }).find(Boolean);
  return { ...evaluation, firedBandId: firedBand?.id || null, firedBand: firedBand?.label || null };
}
