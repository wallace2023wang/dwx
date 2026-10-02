const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const OPERATOR_MAP = Object.freeze({
  '=': '=',
  '==': '=',
  '!=': '!=',
  '≠': '!=',
  '>': '>',
  '>=': '>=',
  '≥': '>=',
  '<': '<',
  '<=': '<=',
  '≤': '<=',
});

const UNIT_MAP = Object.freeze({
  second: 'seconds',
  seconds: 'seconds',
  s: 'seconds',
  秒: 'seconds',
  minute: 'minutes',
  minutes: 'minutes',
  m: 'minutes',
  分钟: 'minutes',
  hour: 'hours',
  hours: 'hours',
  h: 'hours',
  小时: 'hours',
});

const WINDOW_TYPE_MAP = Object.freeze({
  sliding: 'sliding',
  slide: 'sliding',
  time: 'sliding',
  '#time': 'sliding',
  滑动: 'sliding',
  tumbling: 'tumbling',
  batch: 'tumbling',
  time_batch: 'tumbling',
  '#time_batch': 'tumbling',
  跳跃: 'tumbling',
});

function requireIdentifier(value, label, field = false) {
  const text = String(value || '').trim();
  const pattern = field ? FIELD_RE : IDENTIFIER_RE;
  if (!pattern.test(text)) throw new Error(`${label}必须是英文标识符`);
  return text;
}

function statementName(params) {
  return requireIdentifier(params.statementName || params.name, '语句 ID');
}

function outputEvent(params) {
  return `${statementName(params)}Event`;
}

function operator(value, allowed = ['>', '>=', '<', '<=', '=', '!=']) {
  const op = OPERATOR_MAP[String(value || '').trim()];
  if (!op || !allowed.includes(op)) throw new Error(`操作符无效：${value}`);
  return op;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100000) throw new Error(`${label}必须是正整数`);
  return number;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是数字`);
  return number;
}

function unit(value) {
  const normalized = UNIT_MAP[String(value || '').trim()];
  if (!normalized) throw new Error(`时间单位无效：${value}`);
  return normalized;
}

function windowType(value) {
  const normalized = WINDOW_TYPE_MAP[String(value || 'sliding').trim()];
  if (!normalized) throw new Error(`窗口类型无效：${value}`);
  return normalized;
}

function windowTypeLabel(params) {
  return windowType(params.windowType || params.windowKind || params.windowMode) === 'tumbling' ? '跳跃' : '滑动';
}

function literal(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('数值无效');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null || value === '') throw new Error('比较值不能为空');
  const text = String(value).replaceAll("'", "''");
  return `'${text}'`;
}

function eventType(params) {
  return requireIdentifier(params.eventType, '事件源');
}

function field(params, key = 'field') {
  return requireIdentifier(params[key], '字段', true);
}

function groupField(params) {
  return requireIdentifier(params.groupField || params.groupBy, '分组字段', true);
}

function windowClause(params) {
  const view = windowType(params.windowType || params.windowKind || params.windowMode) === 'tumbling' ? '#time_batch' : '#time';
  return `${view}(${positiveInteger(params.windowSize || params.window, '窗口时长')} ${unit(params.windowUnit || params.unit || 'minutes')})`;
}

function thresholdParams(params, allowed) {
  const source = eventType(params);
  const watchedField = field(params);
  const op = operator(params.operator || '>=', allowed);
  const value = literal(params.value ?? params.threshold);
  return { source, watchedField, op, value };
}

function labelOf(params) {
  return String(params.label || params.description || statementName(params)).trim();
}

export const CEP_TEMPLATES = Object.freeze([
  {
    id: 'single-threshold',
    name: '单点阈值',
    category: 'threshold',
    params: ['statementName', 'eventType', 'field', 'operator', 'value'],
    build(params) {
      const name = statementName(params);
      const { source, watchedField, op, value } = thresholdParams(params);
      return `insert into ${name}Event select * from ${source} where ${watchedField} ${op} ${value}`;
    },
    describe(params) {
      const { source, watchedField, op, value } = thresholdParams(params);
      return `当 ${source}.${watchedField} ${op} ${value} 时，输出检测 ${labelOf(params)}`;
    },
  },
  {
    id: 'window-average',
    name: '窗口均值',
    category: 'window',
    params: ['statementName', 'eventType', 'windowType', 'windowSize', 'windowUnit', 'groupField', 'field', 'operator', 'value'],
    build(params) {
      const name = statementName(params);
      const source = eventType(params);
      const grouped = groupField(params);
      const watchedField = field(params);
      const op = operator(params.operator || '>=', ['>', '>=', '<', '<=', '=']);
      const value = literal(params.value ?? params.threshold);
      return `insert into ${name}Event select ${grouped}, avg(${watchedField}) as avg_${watchedField} from ${source}${windowClause(params)} group by ${grouped} having avg(${watchedField}) ${op} ${value}`;
    },
    describe(params) {
      return `当 ${eventType(params)} 在 ${positiveInteger(params.windowSize || params.window, '窗口时长')} ${unit(params.windowUnit || params.unit || 'minutes')} ${windowTypeLabel(params)}窗口内按 ${groupField(params)} 分组的 ${field(params)} 均值 ${operator(params.operator || '>=')} ${literal(params.value ?? params.threshold)} 时，输出检测 ${labelOf(params)}`;
    },
  },
  {
    id: 'window-fluctuation',
    name: '窗口波动',
    category: 'window',
    params: ['statementName', 'eventType', 'windowType', 'windowSize', 'windowUnit', 'groupField', 'field', 'delta'],
    build(params) {
      const name = statementName(params);
      const source = eventType(params);
      const grouped = groupField(params);
      const watchedField = field(params);
      const delta = finiteNumber(params.delta ?? params.value ?? params.threshold, '差值阈值');
      return `insert into ${name}Event select ${grouped}, max(${watchedField}) as max_${watchedField}, min(${watchedField}) as min_${watchedField} from ${source}${windowClause(params)} group by ${grouped} having max(${watchedField}) - min(${watchedField}) >= ${delta}`;
    },
    describe(params) {
      return `当 ${eventType(params)} 在 ${positiveInteger(params.windowSize || params.window, '窗口时长')} ${unit(params.windowUnit || params.unit || 'minutes')} ${windowTypeLabel(params)}窗口内按 ${groupField(params)} 分组的 ${field(params)} 波动 >= ${finiteNumber(params.delta ?? params.value ?? params.threshold, '差值阈值')} 时，输出检测 ${labelOf(params)}`;
    },
  },
  {
    id: 'event-count',
    name: '事件计数',
    category: 'window',
    params: ['statementName', 'eventType', 'windowType', 'windowSize', 'windowUnit', 'groupField', 'count'],
    build(params) {
      const name = statementName(params);
      const source = eventType(params);
      const grouped = groupField(params);
      const count = positiveInteger(params.count ?? params.value ?? params.threshold, '次数阈值');
      return `insert into ${name}Event select ${grouped}, count(*) as cnt from ${source}${windowClause(params)} group by ${grouped} having count(*) >= ${count}`;
    },
    describe(params) {
      return `当 ${eventType(params)} 在 ${positiveInteger(params.windowSize || params.window, '窗口时长')} ${unit(params.windowUnit || params.unit || 'minutes')} ${windowTypeLabel(params)}窗口内按 ${groupField(params)} 分组的事件数 >= ${positiveInteger(params.count ?? params.value ?? params.threshold, '次数阈值')} 时，输出检测 ${labelOf(params)}`;
    },
  },
  {
    id: 'window-sum',
    name: '窗口求和',
    category: 'window',
    params: ['statementName', 'eventType', 'windowType', 'windowSize', 'windowUnit', 'groupField', 'field', 'value'],
    build(params) {
      const name = statementName(params);
      const source = eventType(params);
      const grouped = groupField(params);
      const watchedField = field(params);
      const value = literal(params.value ?? params.threshold);
      return `insert into ${name}Event select ${grouped}, sum(${watchedField}) as sum_${watchedField} from ${source}${windowClause(params)} group by ${grouped} having sum(${watchedField}) >= ${value}`;
    },
    describe(params) {
      return `当 ${eventType(params)} 在 ${positiveInteger(params.windowSize || params.window, '窗口时长')} ${unit(params.windowUnit || params.unit || 'minutes')} ${windowTypeLabel(params)}窗口内按 ${groupField(params)} 分组的 ${field(params)} 求和 >= ${literal(params.value ?? params.threshold)} 时，输出检测 ${labelOf(params)}`;
    },
  },
]);

export function cepTemplateById(id) {
  return CEP_TEMPLATES.find(template => template.id === id) || null;
}

export function buildCepTemplate(id, params = {}) {
  const template = cepTemplateById(id);
  if (!template) throw new Error(`未知 CEP 模板：${id}`);
  return template.build(params);
}

export function renderCepTemplateDescription(id, params = {}) {
  const template = cepTemplateById(id);
  if (!template) throw new Error(`未知 CEP 模板：${id}`);
  return template.describe(params);
}

export function normalizeCepOperator(value) {
  return operator(value);
}
