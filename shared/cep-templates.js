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
  const raw = String(value).trim();
  if (!raw) throw new Error('比较值不能为空');
  const number = Number(raw);
  if (Number.isFinite(number)) return String(number);
  const text = raw.replaceAll("'", "''");
  return `'${text}'`;
}

function outputLiteral(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('输出固定值数字无效');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'string') throw new Error('输出固定值只能是文本、数字或布尔值');
  return `'${value.replaceAll("'", "''")}'`;
}

function selectClause(params) {
  if (params.outputFields == null) return '*';
  if (!Array.isArray(params.outputFields)) throw new Error('输出字段必须是数组');
  if (!params.outputFields.length) return '*';
  if (params.outputFields.length > 50) throw new Error('输出字段不能超过 50 个');
  const aliases = new Set();
  return params.outputFields.map((output, index) => {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error(`第 ${index + 1} 个输出字段无效`);
    const alias = requireIdentifier(output.alias, '输出字段别名', true);
    if (aliases.has(alias)) throw new Error(`输出字段别名重复：${alias}`);
    aliases.add(alias);
    if (output.source === 'field') return `${requireIdentifier(output.field, '源字段', true)} as ${alias}`;
    if (output.source === 'constant') return `${outputLiteral(output.value)} as ${alias}`;
    throw new Error(`第 ${index + 1} 个输出字段来源无效`);
  }).join(', ');
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

function interval(params) {
  return `${positiveInteger(params.windowSize, '等待时长')} ${unit(params.windowUnit || 'seconds')}`;
}

function secondFilter(params) {
  return `${requireIdentifier(params.secondEventType, '后续事件源')}(${requireIdentifier(params.secondGroupField || params.groupField, '后续关联字段', true)} = a.${groupField(params)}, ${field(params, 'secondField')} ${operator(params.secondOperator || '>=')} ${literal(params.secondValue)})`;
}

function consecutiveCount(params) {
  const count = positiveInteger(params.count, '连续次数');
  if (count < 2 || count > 100) throw new Error('连续次数必须为 2 到 100');
  return count;
}

export const CEP_TEMPLATES = Object.freeze([
  {
    id: 'absence', name: '缺席检测', category: 'pattern',
    params: ['statementName', 'eventType', 'field', 'operator', 'value', 'groupField', 'secondEventType', 'secondGroupField', 'secondField', 'secondOperator', 'secondValue', 'windowSize', 'windowUnit'],
    build(params) {
      const { source, watchedField, op, value } = thresholdParams(params);
      return `insert into ${outputEvent(params)} select a.${groupField(params)} as ${groupField(params)}, current_timestamp() as detectedAt from pattern [every a=${source}(${watchedField} ${op} ${value}) -> (timer:interval(${interval(params)}) and not ${secondFilter(params)})]`;
    },
    describe(params) {
      return `每次 ${eventType(params)}.${field(params)} ${operator(params.operator || '>=')} ${literal(params.value)} 后，若 ${interval(params)} 内未收到同关联键 ${groupField(params)} 的 ${secondFilter(params)}，输出 ${labelOf(params)}；没有起始事件不计时。`;
    },
  },
  {
    id: 'event-sequence', name: '双事件时序', category: 'pattern',
    params: ['statementName', 'eventType', 'field', 'operator', 'value', 'groupField', 'secondEventType', 'secondGroupField', 'secondField', 'secondOperator', 'secondValue', 'windowSize', 'windowUnit'],
    build(params) {
      const { source, watchedField, op, value } = thresholdParams(params);
      return `insert into ${outputEvent(params)} select a.${groupField(params)} as ${groupField(params)}, current_timestamp() as detectedAt from pattern [every a=${source}(${watchedField} ${op} ${value}) -> (b=${secondFilter(params)} where timer:within(${interval(params)}))]`;
    },
    describe(params) {
      return `每次 ${eventType(params)}.${field(params)} ${operator(params.operator || '>=')} ${literal(params.value)} 后，在 ${interval(params)} 内收到首个同关联键 ${groupField(params)} 的 ${secondFilter(params)} 时输出 ${labelOf(params)}；超时取消本次匹配。`;
    },
  },
  {
    id: 'consecutive-count', name: '连续次数', category: 'pattern',
    params: ['statementName', 'eventType', 'field', 'operator', 'value', 'groupField', 'count'],
    build(params) {
      const { source, watchedField, op, value } = thresholdParams(params);
      const count = consecutiveCount(params);
      return `insert into ${outputEvent(params)} select correlationKey as ${groupField(params)}, matchedCount as cnt from ${source} match_recognize (partition by ${groupField(params)} measures A[0].${groupField(params)} as correlationKey, ${count} as matchedCount after match skip past last row pattern (A{${count}}) define A as coalesce(A.${watchedField} ${op} ${value}, false))`;
    },
    describe(params) {
      return `按 ${groupField(params)} 独立检测 ${eventType(params)}，连续 ${consecutiveCount(params)} 次 ${field(params)} ${operator(params.operator || '>=')} ${literal(params.value)} 输出 ${labelOf(params)}；同键不满足条件（含空值）即重置，其他键不打断；每满一组输出一次，不重叠计数。`;
    },
  },
  {
    id: 'periodic', name: '周期触发', category: 'timer',
    params: ['statementName', 'windowSize', 'windowUnit'],
    build(params) {
      return `insert into ${outputEvent(params)} select current_timestamp() as triggeredAt from pattern [every timer:interval(${interval(params)})]`;
    },
    describe(params) {
      return `从部署开始，每 ${interval(params)} 输出 ${labelOf(params)}；不需要输入事件，首次输出在一个完整周期之后，重新部署重新计时。`;
    },
  },
  {
    id: 'single-threshold',
    name: '单点阈值',
    category: 'threshold',
    params: ['statementName', 'eventType', 'field', 'operator', 'value', 'outputFields'],
    build(params) {
      const name = statementName(params);
      const { source, watchedField, op, value } = thresholdParams(params);
      return `insert into ${name}Event select ${selectClause(params)} from ${source} where ${watchedField} ${op} ${value}`;
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
