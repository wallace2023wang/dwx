import { createHash } from 'node:crypto';
import { inferSemanticType } from './bom.js';
import { buildCepTemplate } from './cep-templates.js';

export const CEP_ENGINE_VERSION = '8.8.0';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DURATION_RE = /^\d+(ms|s|m|h|d)$/;
const ENVELOPE_FIELDS = [
  { key: 'eventId', label: '事件 ID', type: 'string', sourceType: 'String', envelope: true, required: false },
  { key: 'eventTime', label: '事件时间', type: 'string', sourceType: 'String', envelope: true, required: false },
  { key: 'ingestTime', label: '接收时间', type: 'string', sourceType: 'String', envelope: true, required: false },
  { key: 'source', label: '事件来源', type: 'string', sourceType: 'String', envelope: true, required: false },
  { key: 'eventKey', label: '分区键', type: 'string', sourceType: 'String', envelope: true, required: false },
  { key: 'schemaVersion', label: 'Schema 版本', type: 'int', sourceType: 'Integer', envelope: true, required: false },
  { key: 'traceId', label: '链路 ID', type: 'string', sourceType: 'String', envelope: true, required: false },
];
const ENVELOPE_FIELD_KEYS = new Set(ENVELOPE_FIELDS.map(field => field.key));

function hash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function eventFields(bom = { fields: [] }) {
  return (bom.fields || []).filter(field => field.kind === 'input' && field.factType);
}

function schemaType(field) {
  const semantic = inferSemanticType(field);
  if (field.type === 'Integer') return 'int';
  if (field.type === 'Double') return 'double';
  if (field.type === 'Boolean') return 'boolean';
  if (semantic === 'List<String>') return 'string[]';
  return 'string';
}

function fieldByKey(bom, key) {
  return (bom.fields || []).find(field => field.key === key) || null;
}

function schemaFieldFromBom(field, config = {}) {
  return {
    key: field.key,
    label: field.label,
    type: schemaType(field),
    sourceType: field.type,
    required: config.required ?? field.required === true,
    unit: field.unit ?? null,
    min: field.min ?? null,
    max: field.max ?? null,
  };
}

function eventTypeSchemas(bom) {
  if (!Array.isArray(bom.eventTypes) || !bom.eventTypes.length) return [];
  return bom.eventTypes.map(eventType => {
    const fields = [];
    const seen = new Set();
    const addField = reference => {
      const key = typeof reference === 'string' ? reference : reference?.field;
      if (!key || seen.has(key)) return;
      const field = fieldByKey(bom, key);
      if (!field) return;
      fields.push(schemaFieldFromBom(field, typeof reference === 'object' ? reference : {}));
      seen.add(key);
    };
    for (const reference of eventType.fields || []) addField(reference);
    for (const key of [eventType.keyField, eventType.timeField, eventType.sourceField].filter(Boolean)) addField({ field: key, required: true });
    const envelope = ENVELOPE_FIELDS.filter(field => !seen.has(field.key));
    return {
      name: eventType.name,
      label: eventType.label || eventType.name,
      version: eventType.version || 1,
      keyField: eventType.keyField || null,
      timeField: eventType.timeField || null,
      sourceField: eventType.sourceField || null,
      retention: eventType.retention || null,
      allowedLateness: eventType.allowedLateness || null,
      duplicateKey: eventType.duplicateKey || ['eventId'],
      fields: [...envelope, ...fields],
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function fallbackSchemas(bom) {
  const schemas = new Map();
  for (const field of eventFields(bom)) {
    const type = field.factType || 'DefaultEvent';
    if (!schemas.has(type)) schemas.set(type, { name: type, label: field.factTypeLabel || type, version: 1, fields: [...ENVELOPE_FIELDS] });
    schemas.get(type).fields.push(schemaFieldFromBom(field));
  }
  return [...schemas.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function eventSchemasFromBom(bom = { fields: [] }) {
  const explicit = eventTypeSchemas(bom);
  return explicit.length ? explicit : fallbackSchemas(bom);
}

export function validateEventTypes(bom = { fields: [] }) {
  if (bom.eventTypes == null) return null;
  if (!Array.isArray(bom.eventTypes)) return 'eventTypes 必须是数组';
  const fieldKeys = new Set((bom.fields || []).map(field => field.key));
  const names = new Set();
  for (const [index, eventType] of bom.eventTypes.entries()) {
    const label = `第 ${index + 1} 个事件类型`;
    if (!eventType || typeof eventType !== 'object') return `${label}定义无效`;
    if (!NAME_RE.test(eventType.name || '')) return `${label} name 必须是大写字母开头的英文标识符`;
    if (names.has(eventType.name)) return `${label} name 重复`;
    names.add(eventType.name);
    if (eventType.label != null && (typeof eventType.label !== 'string' || !eventType.label.trim() || eventType.label.length > 40)) return `${label}业务名称需为 1-40 字`;
    if (eventType.version != null && (!Number.isInteger(eventType.version) || eventType.version < 1)) return `${label} version 必须是正整数`;
    for (const key of ['keyField', 'timeField', 'sourceField']) {
      if (eventType[key] != null && !fieldKeys.has(eventType[key])) return `${label} ${key} 引用了不存在的字段 ${eventType[key]}`;
    }
    if (eventType.retention != null && (typeof eventType.retention !== 'string' || !DURATION_RE.test(eventType.retention))) return `${label} retention 格式应为 30s/5m/24h/7d`;
    if (eventType.allowedLateness != null && (typeof eventType.allowedLateness !== 'string' || !DURATION_RE.test(eventType.allowedLateness))) return `${label} allowedLateness 格式应为 30s/5m/24h/7d`;
    if (!Array.isArray(eventType.fields) || !eventType.fields.length) return `${label} 至少需要一个字段`;
    const fields = new Set();
    for (const reference of eventType.fields) {
      const key = typeof reference === 'string' ? reference : reference?.field;
      if (!key || !fieldKeys.has(key)) return `${label} fields 引用了不存在的字段 ${key || ''}`;
      if (fields.has(key)) return `${label} fields 字段 ${key} 重复`;
      fields.add(key);
      if (typeof reference === 'object' && reference.required != null && typeof reference.required !== 'boolean') return `${label} fields.${key}.required 必须是 boolean`;
    }
    if (eventType.duplicateKey != null) {
      if (!Array.isArray(eventType.duplicateKey) || eventType.duplicateKey.some(key => typeof key !== 'string' || !key)) return `${label} duplicateKey 必须是字段名数组`;
      const missing = eventType.duplicateKey.filter(key => !fieldKeys.has(key) && !ENVELOPE_FIELD_KEYS.has(key));
      if (missing.length) return `${label} duplicateKey 引用了不存在的字段 ${missing.join(', ')}`;
    }
  }
  return null;
}

function eventPayload(event) {
  return {
    eventId: event.eventId ?? event.id,
    eventTime: event.eventTime ?? (typeof event.timestamp === 'string' ? event.timestamp : undefined),
    ingestTime: event.ingestTime ?? event.receivedAt,
    source: event.source,
    eventKey: event.eventKey ?? event.key,
    schemaVersion: event.schemaVersion,
    traceId: event.traceId ?? event.headers?.traceId,
    ...(event.data || {}),
  };
}

function valueMatchesType(value, type) {
  if (value == null) return false;
  if (type === 'int') return Number.isInteger(value);
  if (type === 'double') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string[]') return Array.isArray(value) && value.every(item => typeof item === 'string');
  return typeof value === 'string';
}

export function validateEventPayloads(events, bom = { fields: [] }) {
  if (!Array.isArray(events)) return '事件输入必须是数组';
  const schemas = eventSchemasFromBom(bom);
  const schemaMap = new Map(schemas.map(schema => [schema.name, schema]));
  for (const [eventIndex, event] of events.entries()) {
    const label = `第 ${eventIndex + 1} 个事件`;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return `${label}无效`;
    if (typeof event.type !== 'string' || !event.type) return `${label}类型无效`;
    const schema = schemaMap.get(event.type);
    if (!schema) return `${label}类型 ${event.type} 未在 BOM 事件类型中定义`;
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return `${label} data 必须是对象`;
    const payload = eventPayload(event);
    for (const field of schema.fields || []) {
      const value = payload[field.key];
      if (field.required && value == null) return `${label}缺少必填字段 ${field.key}`;
      if (value != null && !valueMatchesType(value, field.type)) return `${label}字段 ${field.key} 类型应为 ${field.type}`;
    }
  }
  return null;
}

function patternBodies(epl) {
  const bodies = [];
  const pattern = /\bfrom\s+pattern\s*\[/ig;
  let match;
  while ((match = pattern.exec(epl))) {
    let depth = 1;
    let index = pattern.lastIndex;
    for (; index < epl.length && depth > 0; index++) {
      if (epl[index] === '[') depth++;
      else if (epl[index] === ']') depth--;
    }
    bodies.push(epl.slice(pattern.lastIndex, Math.max(pattern.lastIndex, index - 1)));
    pattern.lastIndex = index;
  }
  return bodies;
}

function referencedTypes(epl) {
  const result = new Set();
  for (const match of epl.matchAll(/\bfrom\s+([A-Z][A-Za-z0-9_]*)\b/g)) result.add(match[1]);
  for (const body of patternBodies(epl)) {
    for (const match of body.matchAll(/\b(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?([A-Z][A-Za-z0-9_]*)\s*(?=\(|#|\[|\s*(?:->|and|or|where|\]))/g)) {
      result.add(match[1]);
    }
  }
  return [...result];
}

function hasTimeDrivenPattern(epl) {
  return /\bfrom\s+pattern\s*\[[\s\S]*\btimer\s*:/i.test(epl);
}

function outputEventType(statement) {
  const inserted = statement.epl.match(/\binsert\s+into\s+([A-Za-z][A-Za-z0-9_]*)\b/i)?.[1];
  return inserted || statement.outputEventType || `${statement.name}Event`;
}

export function normalizeEventStreamDraft(input = {}) {
  return {
    name: String(input.name || '未命名事件流').trim(),
    description: String(input.description || '').trim(),
    category: typeof input.category === 'string' && input.category.trim() ? input.category.trim() : 'default',
    statements: Array.isArray(input.statements) ? input.statements.map(statement => ({
      name: String(statement?.name || '').trim(),
      epl: String(statement?.epl || '').trim(),
      enabled: statement?.enabled !== false,
      ...(Array.isArray(statement?.output) ? { output: statement.output.filter(item => typeof item === 'string') } : {}),
      ...(typeof statement?.label === 'string' ? { label: statement.label.trim() } : {}),
      ...(typeof statement?.description === 'string' ? { description: statement.description.trim() } : {}),
      ...(['guided', 'advanced'].includes(statement?.mode) ? { mode: statement.mode } : {}),
      ...(typeof statement?.template === 'string' && statement.template.trim() ? { template: statement.template.trim() } : {}),
      ...(statement?.params && typeof statement.params === 'object' && !Array.isArray(statement.params) ? { params: structuredClone(statement.params) } : {}),
    })) : [],
  };
}

export function validateEventStreamDraft(input, bom = { fields: [] }) {
  const draft = normalizeEventStreamDraft(input);
  if (!draft.name || draft.name.length > 80) return '事件流名称需为 1-80 个字符';
  if (draft.description.length > 500) return '事件流说明不能超过 500 个字符';
  if (!Array.isArray(draft.statements) || draft.statements.length < 1 || draft.statements.length > 100) return '事件流至少需要 1 条 EPL 语句且不能超过 100 条';
  const eventTypeError = validateEventTypes(bom);
  if (eventTypeError) return eventTypeError;
  const schemas = eventSchemasFromBom(bom);
  const schemaNames = new Set(schemas.map(schema => schema.name));
  const derivedNames = new Set(draft.statements.filter(statement => statement.enabled !== false).map(outputEventType).filter(Boolean));
  const names = new Set();
  for (const [index, statement] of draft.statements.entries()) {
    const label = `第 ${index + 1} 条 EPL`;
    if (!NAME_RE.test(statement.name)) return `${label}语句名必须是英文标识符`;
    if (names.has(statement.name)) return `${label}语句名重复`;
    names.add(statement.name);
    if (statement.label != null && (typeof statement.label !== 'string' || statement.label.length > 80)) return `${label}中文检测名不能超过 80 字`;
    if (statement.description != null && (typeof statement.description !== 'string' || statement.description.length > 500)) return `${label}业务说明不能超过 500 字`;
    if (statement.mode != null && !['guided', 'advanced'].includes(statement.mode)) return `${label}编辑模式无效`;
    if (statement.template != null && (typeof statement.template !== 'string' || statement.template.length > 80)) return `${label}模板 ID 无效`;
    if (statement.params != null && (typeof statement.params !== 'object' || Array.isArray(statement.params))) return `${label}模板参数无效`;
    if (statement.mode === 'guided' && (!statement.template || !statement.params)) return `${label}向导语句缺少模板或参数`;
    if (!statement.epl || statement.epl.length > 4000) return `${label}内容需为 1-4000 个字符`;
    if (statement.template || statement.params) {
      if (!statement.template || !statement.params) return `${label}模板与参数必须同时提供`;
      let generatedEpl;
      try {
        generatedEpl = buildCepTemplate(statement.template, {
          ...statement.params,
          statementName: statement.name,
          label: statement.label || statement.name,
        });
      } catch (error) {
        return `${label}模板参数无效：${error instanceof Error ? error.message : '无法生成 EPL'}`;
      }
      if (generatedEpl.trim() !== statement.epl.trim()) return `${label}向导参数与 EPL 不一致，请重新生成或切换到高级模式`;
    }
    if (!/\bselect\b/i.test(statement.epl) && !/\bpattern\s*\[/i.test(statement.epl)) return `${label}必须包含 select 或 pattern`;
    const refs = referencedTypes(statement.epl);
    if (!refs.length && !hasTimeDrivenPattern(statement.epl)) return `${label}必须通过 from 引用 BOM 事件类型或时间驱动 pattern`;
    const missing = refs.filter(type => !schemaNames.has(type) && !derivedNames.has(type));
    if (missing.length) return `${label}引用了不存在的事件类型：${missing.join(', ')}`;
  }
  return null;
}

export function compileEventStreamDraft(draft, bom = { fields: [] }) {
  const normalized = normalizeEventStreamDraft(draft);
  const error = validateEventStreamDraft(normalized, bom);
  if (error) return { status: 400, error };
  const schemas = eventSchemasFromBom(bom);
  const module = {
    schemas,
    statements: normalized.statements.filter(statement => statement.enabled !== false).map(statement => ({
      name: statement.name,
      epl: statement.epl,
      enabled: statement.enabled !== false,
      eventTypes: referencedTypes(statement.epl),
      outputEventType: outputEventType(statement),
    })),
  };
  return { status: 200, result: { ok: true, version: CEP_ENGINE_VERSION, schemas, module, checksum: hash(module) } };
}

function parseLiteral(value) {
  const trimmed = value.trim();
  if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : trimmed;
}

function compare(left, operator, right) {
  if (operator === '==') return Object.is(left, right);
  if (operator === '!=') return !Object.is(left, right);
  if (operator === '>') return Number(left) > Number(right);
  if (operator === '>=') return Number(left) >= Number(right);
  if (operator === '<') return Number(left) < Number(right);
  if (operator === '<=') return Number(left) <= Number(right);
  return false;
}

export function runEventStream(module = {}, events = []) {
  const detections = [];
  for (const statement of module.statements || []) {
    if (statement.enabled === false) continue;
    const epl = statement.epl || '';
    const sourceType = epl.match(/\bfrom\s+([A-Z][A-Za-z0-9_]*)\b/i)?.[1];
    if (!sourceType) continue;
    const where = epl.match(/\bwhere\s+([a-zA-Z][a-zA-Z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*([^\s;]+)/i);
    const eventType = outputEventType(statement);
    for (const event of events) {
      if (event.type !== sourceType) continue;
      const data = eventPayload(event);
      if (where && !compare(data[where[1]], where[2], parseLiteral(where[3]))) continue;
      detections.push({ statement: statement.name, eventType, timestamp: null, data });
    }
  }
  return { detections };
}
