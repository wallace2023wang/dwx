import type { BomField, BomModel } from '../types'

export type CepTemplateId = 'single-threshold' | 'window-average' | 'window-fluctuation' | 'event-count' | 'window-sum'
export type CepTemplateCategory = 'threshold' | 'window'

export interface CepTemplate {
  id: CepTemplateId
  name: string
  category: CepTemplateCategory
  summary: string
}

export interface CepTemplateParams {
  statementName: string
  label: string
  eventType: string
  field?: string
  groupField?: string
  operator?: string
  value?: string | number | boolean
  delta?: string | number
  count?: string | number
  windowType?: 'sliding' | 'tumbling'
  windowSize?: string | number
  windowUnit?: 'seconds' | 'minutes' | 'hours'
  outputFields?: CepOutputField[]
}

export type CepOutputField =
  | { alias: string; source: 'field'; field: string }
  | { alias: string; source: 'constant'; value: string | number | boolean }

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const OPERATOR_MAP: Record<string, string> = { '=': '=', '==': '=', '!=': '!=', '≠': '!=', '>': '>', '>=': '>=', '≥': '>=', '<': '<', '<=': '<=', '≤': '<=' }
const UNIT_LABEL: Record<string, string> = { seconds: '秒', minutes: '分钟', hours: '小时' }
const WINDOW_LABEL: Record<string, string> = { sliding: '滑动', tumbling: '跳跃' }

export const CEP_TEMPLATES: CepTemplate[] = [
  { id: 'single-threshold', name: '单点阈值', category: 'threshold', summary: '单条事件字段超过阈值即告警' },
  { id: 'window-average', name: '窗口均值', category: 'window', summary: '时间窗口内字段均值超阈值' },
  { id: 'window-fluctuation', name: '窗口波动', category: 'window', summary: '时间窗口内最大值与最小值差值超阈值' },
  { id: 'event-count', name: '事件计数', category: 'window', summary: '时间窗口内事件数量超阈值' },
  { id: 'window-sum', name: '窗口求和', category: 'window', summary: '时间窗口内字段求和超阈值' },
]

export const ENVELOPE_FIELDS: BomField[] = [
  { key: 'eventId', label: '事件 ID', type: 'String', runtimeType: 'String', direction: 'input', references: 0, group: '信封字段' },
  { key: 'eventTime', label: '事件时间', type: 'Date', runtimeType: 'String', direction: 'input', references: 0, group: '信封字段' },
  { key: 'ingestTime', label: '接收时间', type: 'Date', runtimeType: 'String', direction: 'input', references: 0, group: '信封字段' },
  { key: 'source', label: '事件来源', type: 'String', runtimeType: 'String', direction: 'input', references: 0, group: '信封字段' },
  { key: 'eventKey', label: '分区键', type: 'String', runtimeType: 'String', direction: 'input', references: 0, group: '信封字段' },
  { key: 'schemaVersion', label: 'Schema 版本', type: 'Integer', runtimeType: 'Integer', direction: 'input', references: 0, group: '信封字段' },
  { key: 'traceId', label: '链路 ID', type: 'String', runtimeType: 'String', direction: 'input', references: 0, group: '信封字段' },
]

function requireIdentifier(value: unknown, label: string, field = false) {
  const text = String(value || '').trim()
  const pattern = field ? FIELD_RE : IDENTIFIER_RE
  if (!pattern.test(text)) throw new Error(`${label}必须是英文标识符`)
  return text
}

function op(value: unknown, allowed = ['>', '>=', '<', '<=', '=', '!=']) {
  const normalized = OPERATOR_MAP[String(value || '').trim()]
  if (!normalized || !allowed.includes(normalized)) throw new Error('操作符无效')
  return normalized
}

function positiveInteger(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label}必须是正整数`)
  return number
}

function finiteNumber(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label}必须是数字`)
  return number
}

function literal(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : (() => { throw new Error('数值无效') })()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value ?? '').trim()
  if (!text) throw new Error('比较值不能为空')
  const number = Number(text)
  if (Number.isFinite(number)) return String(number)
  return `'${text.replace(/'/g, "''")}'`
}

function outputLiteral(value: unknown) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('输出固定值数字无效')
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value !== 'string') throw new Error('输出固定值只能是文本、数字或布尔值')
  return `'${value.replace(/'/g, "''")}'`
}

function selectClause(outputFields: CepOutputField[] | undefined) {
  if (!outputFields?.length) return '*'
  if (outputFields.length > 50) throw new Error('输出字段不能超过 50 个')
  const aliases = new Set<string>()
  return outputFields.map((output, index) => {
    const alias = requireIdentifier(output.alias, '输出字段别名', true)
    if (aliases.has(alias)) throw new Error(`输出字段别名重复：${alias}`)
    aliases.add(alias)
    if (output.source === 'field') return `${requireIdentifier(output.field, '源字段', true)} as ${alias}`
    if (output.source === 'constant') return `${outputLiteral(output.value)} as ${alias}`
    throw new Error(`第 ${index + 1} 个输出字段来源无效`)
  }).join(', ')
}

function windowClause(params: CepTemplateParams) {
  const unit = params.windowUnit || 'minutes'
  const view = params.windowType === 'tumbling' ? '#time_batch' : '#time'
  return `${view}(${positiveInteger(params.windowSize || 3, '窗口时长')} ${unit})`
}

export function buildCepTemplate(id: CepTemplateId, params: CepTemplateParams) {
  const name = requireIdentifier(params.statementName, '语句 ID')
  const eventType = requireIdentifier(params.eventType, '事件源')
  const field = params.field ? requireIdentifier(params.field, '字段', true) : ''
  const groupField = params.groupField ? requireIdentifier(params.groupField, '分组字段', true) : ''
  if (id === 'single-threshold') return `insert into ${name}Event select ${selectClause(params.outputFields)} from ${eventType} where ${field} ${op(params.operator || '>=')} ${literal(params.value)}`
  if (id === 'window-average') return `insert into ${name}Event select ${groupField}, avg(${field}) as avg_${field} from ${eventType}${windowClause(params)} group by ${groupField} having avg(${field}) ${op(params.operator || '>=', ['>', '>=', '<', '<=', '='])} ${literal(params.value)}`
  if (id === 'window-fluctuation') return `insert into ${name}Event select ${groupField}, max(${field}) as max_${field}, min(${field}) as min_${field} from ${eventType}${windowClause(params)} group by ${groupField} having max(${field}) - min(${field}) >= ${finiteNumber(params.delta ?? params.value, '差值阈值')}`
  if (id === 'event-count') return `insert into ${name}Event select ${groupField}, count(*) as cnt from ${eventType}${windowClause(params)} group by ${groupField} having count(*) >= ${positiveInteger(params.count ?? params.value, '次数阈值')}`
  return `insert into ${name}Event select ${groupField}, sum(${field}) as sum_${field} from ${eventType}${windowClause(params)} group by ${groupField} having sum(${field}) >= ${literal(params.value)}`
}

export function describeCepTemplate(id: CepTemplateId, params: CepTemplateParams) {
  const label = params.label || params.statementName
  const unit = UNIT_LABEL[params.windowUnit || 'minutes'] || params.windowUnit || '分钟'
  const windowLabel = WINDOW_LABEL[params.windowType || 'sliding'] || '滑动'
  if (id === 'single-threshold') return `当 ${params.eventType}.${params.field} ${op(params.operator || '>=')} ${literal(params.value)} 时，输出检测 ${label}`
  if (id === 'window-average') return `当 ${params.eventType} 在 ${params.windowSize || 3} ${unit}${windowLabel}窗口内按 ${params.groupField} 分组的 ${params.field} 均值 ${op(params.operator || '>=')} ${literal(params.value)} 时，输出检测 ${label}`
  if (id === 'window-fluctuation') return `当 ${params.eventType} 在 ${params.windowSize || 3} ${unit}${windowLabel}窗口内按 ${params.groupField} 分组的 ${params.field} 波动 >= ${finiteNumber(params.delta ?? params.value, '差值阈值')} 时，输出检测 ${label}`
  if (id === 'event-count') return `当 ${params.eventType} 在 ${params.windowSize || 3} ${unit}${windowLabel}窗口内按 ${params.groupField} 分组的事件数 >= ${positiveInteger(params.count ?? params.value, '次数阈值')} 时，输出检测 ${label}`
  return `当 ${params.eventType} 在 ${params.windowSize || 3} ${unit}${windowLabel}窗口内按 ${params.groupField} 分组的 ${params.field} 求和 >= ${literal(params.value)} 时，输出检测 ${label}`
}

export function fieldsForEventType(bom: BomModel | undefined, eventTypeName: string) {
  const allFields = new Map<string, BomField>()
  for (const fact of bom?.factTypes || []) for (const field of fact.fields) allFields.set(field.key, field)
  const eventType = bom?.eventTypes?.find(item => item.name === eventTypeName)
  const refs = eventType?.fields?.map(ref => ref.field) || bom?.factTypes?.find(fact => fact.name === eventTypeName)?.fields.map(field => field.key) || []
  const fields = refs.map(key => allFields.get(key)).filter((field): field is BomField => Boolean(field))
  const withEnvelope = [...ENVELOPE_FIELDS, ...fields.filter(field => !ENVELOPE_FIELDS.some(envelope => envelope.key === field.key))]
  return withEnvelope
}

export function numericFields(fields: BomField[]) {
  return fields.filter(field => ['Integer', 'Decimal'].includes(field.type) || ['Integer', 'Double'].includes(field.runtimeType || ''))
}

export function defaultCepParams(id: CepTemplateId, bom: BomModel | undefined, index: number): CepTemplateParams {
  const eventType = bom?.eventTypes?.[0]?.name || bom?.factTypes?.find(fact => fact.direction !== 'output')?.name || 'DefaultEvent'
  const fields = fieldsForEventType(bom, eventType)
  const numbers = numericFields(fields)
  const businessFields = fields.filter(field => field.group !== '信封字段')
  const valueField = numericFields(businessFields)[0]?.key || numbers[0]?.key || businessFields[0]?.key || fields.find(field => field.key !== 'eventId')?.key || 'value'
  const group = fields.find(field => ['eventKey', 'warehouseId', 'sensorId', 'source'].includes(field.key))?.key || fields[0]?.key || 'eventKey'
  const baseName = ({ 'single-threshold': 'SingleThreshold', 'window-average': 'WindowAverage', 'window-fluctuation': 'WindowFluctuation', 'event-count': 'EventCount', 'window-sum': 'WindowSum' } as const)[id]
  return {
    statementName: `${baseName}${index}`,
    label: CEP_TEMPLATES.find(template => template.id === id)?.name || baseName,
    eventType,
    field: id === 'event-count' ? undefined : valueField,
    groupField: id === 'single-threshold' ? undefined : group,
    operator: '>=',
    value: id === 'event-count' ? undefined : 25,
    delta: id === 'window-fluctuation' ? 10 : undefined,
    count: id === 'event-count' ? 3 : undefined,
    windowType: id === 'single-threshold' ? undefined : 'sliding',
    windowSize: id === 'single-threshold' ? undefined : 3,
    windowUnit: 'minutes',
  }
}

function eventTypeFromEpl(epl: string) {
  return epl.match(/\bfrom\s+([A-Z][A-Za-z0-9_]*)\b/)?.[1] || 'DefaultEvent'
}

export function outputEventTypeFromEpl(statementName: string, epl: string) {
  return epl.match(/\binsert\s+into\s+([A-Za-z][A-Za-z0-9_]*)\b/i)?.[1] || `${statementName}Event`
}

function sampleValueForField(field: BomField, params: CepTemplateParams, index: number) {
  if (field.key === 'eventId') return `${params.statementName || 'event'}-${index}`
  if (field.key === 'warehouseId' || field.key === 'eventKey') return 'WH-01'
  if (field.key === 'sensorId' || field.key === 'source') return 'S-01'
  if (field.key === 'sampledAt') return '2026-10-01'
  if (field.key === 'eventTime' || field.key === 'ingestTime') return `2026-10-01T00:00:${String(index).padStart(2, '0')}Z`
  if (field.key === 'schemaVersion') return 1
  if (field.key === 'traceId') return `trace-${index}`
  if (field.type === 'Boolean') return true
  if (field.type === 'Enum') return field.enum?.[0] || 'A'
  if (field.type === 'Integer') return 1
  if (field.type === 'Decimal' || field.runtimeType === 'Double') return 1
  return `${field.key}-${index}`
}

function passingFieldValue(templateId: CepTemplateId | undefined, params: CepTemplateParams, index: number) {
  const threshold = Number(params.value || 1)
  if (templateId === 'single-threshold') {
    if (params.operator === '<' || params.operator === '<=') return threshold - 1
    if (params.operator === '=' || params.operator === '==') return Number.isFinite(threshold) ? threshold : params.value
    if (params.operator === '!=' || params.operator === '≠') return Number.isFinite(threshold) ? threshold + 1 : `${params.value}-other`
    return threshold + 1
  }
  if (templateId === 'window-fluctuation') return index === 1 ? 0 : Number(params.delta || 1) + 1
  if (templateId === 'window-sum') return threshold / 2 + index
  return threshold + 1
}

function waitMsForWindow(params: CepTemplateParams) {
  const size = Number(params.windowSize || 1)
  const factor = params.windowUnit === 'hours' ? 60 * 60 * 1000 : params.windowUnit === 'minutes' ? 60 * 1000 : 1000
  return Math.min(300000, Math.max(1, size) * factor + 200)
}

export function buildCepTestSkeleton(statement: { name: string; epl: string; label?: string; template?: string; params?: Record<string, unknown> }, bom: BomModel | undefined) {
  const templateId = statement.template as CepTemplateId | undefined
  const params = ({ ...(statement.params || {}), statementName: statement.name, label: statement.label || statement.name } as unknown) as CepTemplateParams
  const eventType = params.eventType || eventTypeFromEpl(statement.epl)
  const fields = fieldsForEventType(bom, eventType)
  const repetitions = templateId === 'event-count' ? Number(params.count || 3) : ['window-average', 'window-fluctuation', 'window-sum'].includes(templateId || '') ? 2 : 1
  const events = Array.from({ length: Math.max(1, repetitions) }, (_, index) => {
    const ordinal = index + 1
    const data: Record<string, string | number | boolean> = {}
    for (const field of fields.filter(field => field.group !== '信封字段')) data[field.key] = sampleValueForField(field, params, ordinal)
    if (params.field) data[params.field] = passingFieldValue(templateId, params, ordinal) ?? ''
    return {
      id: `${statement.name}-${ordinal}`,
      type: eventType,
      eventTime: `2026-10-01T00:00:${String(ordinal).padStart(2, '0')}Z`,
      source: 'visual-builder',
      key: String(params.groupField ? data[params.groupField] || 'WH-01' : 'WH-01'),
      schemaVersion: 1,
      traceId: `trace-${ordinal}`,
      data,
    }
  })
  return {
    id: `${statement.name}-case`,
    name: `${statement.label || statement.name} 命中`,
    enabled: true,
    facts: {},
    events,
    ...(params.windowType === 'tumbling' ? { waitMs: waitMsForWindow(params) } : {}),
    expected: { outputs: {}, fired: [] },
    expectedEvents: [{ statement: statement.name, eventType: outputEventTypeFromEpl(statement.name, statement.epl), count: 1 }],
  }
}
