// BOM（业务对象模型）：字段字典的可配置版本。
// 设计时由 Team Server 从 data/bom.json 加载，生成 DRL 时据此 declare RuleInput。
// RES 端不读此文件，而是从编译后 KieBase 的 FactType 反射字段类型。

export const FIELD_TYPES = ['Integer', 'Double', 'String', 'Boolean'];
export const SEMANTIC_TYPES = ['Integer', 'Decimal', 'Boolean', 'String', 'Enum', 'Date', 'List<String>'];
export const FIELD_KINDS = ['input', 'output'];
export const CONTROLS = ['text', 'number', 'select', 'boolean', 'date'];

export const SEMANTIC_RUNTIME_TYPES = Object.freeze({
  Integer: 'Integer',
  Decimal: 'Double',
  Boolean: 'Boolean',
  String: 'String',
  Enum: 'String',
  Date: 'String',
  'List<String>': 'String',
});

const KEY_RE = /^[a-z][a-zA-Z0-9_]{1,31}$/;
const METHOD_RE = /^[a-z][a-zA-Z0-9_]{1,31}$/;
const EVENT_NAME_RE = /^[A-Z][a-zA-Z0-9_]{0,63}$/;
const DURATION_RE = /^\d+(ms|s|m|h|d)$/;
const EVENT_ENVELOPE_KEYS = new Set(['eventId', 'eventTime', 'ingestTime', 'source', 'eventKey', 'schemaVersion', 'traceId']);

/**
 * 默认 BOM：迁移自原 shared/rules.js 写死的 8 个字段，
 * 补充分组、枚举、单位、范围和输入控件。
 */
export function defaultBom() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    fields: [
      {
        key: 'customerAge', label: '客户年龄', type: 'Integer', kind: 'input',
        semanticType: 'Integer',
        factType: 'Borrower', factTypeLabel: '借款申请人',
        group: '客户基本信息', unit: '岁', min: 0, max: 150, enum: null, control: 'number',
        description: '申请客户周岁年龄',
      },
      {
        key: 'annualIncome', label: '年收入', type: 'Double', kind: 'input',
        semanticType: 'Decimal',
        factType: 'Borrower', factTypeLabel: '借款申请人',
        group: '客户基本信息', unit: '元', min: 0, max: null, enum: null, control: 'number',
        description: '客户年度可支配收入',
      },
      {
        key: 'creditScore', label: '信用评分', type: 'Integer', kind: 'input',
        semanticType: 'Integer',
        factType: 'Borrower', factTypeLabel: '借款申请人',
        group: '客户信用', unit: '分', min: 300, max: 900, enum: null, control: 'number',
        description: '征信评分',
      },
      {
        key: 'customerType', label: '客户类型', type: 'String', kind: 'input',
        semanticType: 'Enum',
        factType: 'Borrower', factTypeLabel: '借款申请人',
        group: '客户基本信息', unit: null, min: null, max: null,
        enum: ['个人', '企业', '同业'], control: 'select', description: '',
      },
      {
        key: 'overdue', label: '是否逾期', type: 'Boolean', kind: 'input',
        semanticType: 'Boolean',
        factType: 'Borrower', factTypeLabel: '借款申请人',
        group: '客户信用', unit: null, min: null, max: null, enum: null, control: 'boolean',
        description: '当前是否有逾期记录',
      },
      {
        key: 'riskLevel', label: '风险等级', type: 'String', kind: 'output',
        semanticType: 'Enum',
        factType: 'LoanDecision', factTypeLabel: '审批结果',
        group: '结果输出', unit: null, min: null, max: null,
        enum: ['低', '中', '高'], control: 'select', description: '综合风险评级',
      },
      {
        key: 'reviewRequired', label: '需要人工审核', type: 'Boolean', kind: 'output',
        semanticType: 'Boolean',
        factType: 'LoanDecision', factTypeLabel: '审批结果',
        group: '结果输出', unit: null, min: null, max: null, enum: null, control: 'boolean',
        description: '是否转人工复核',
      },
      {
        key: 'approvedLimit', label: '批准额度', type: 'Double', kind: 'output',
        semanticType: 'Decimal',
        factType: 'LoanDecision', factTypeLabel: '审批结果',
        group: '结果输出', unit: '元', min: 0, max: null, enum: null, control: 'number',
        description: '最终批准授信额度',
      },
    ],
  };
}

export function inputFields(bom) {
  return resolvedBomFields(bom).filter(f => f.kind === 'input');
}

export function outputFields(bom) {
  return resolvedBomFields(bom).filter(f => f.kind === 'output');
}

export function findField(bom, key) {
  const field = bom.fields.find(f => f.key === key) || null;
  if (!field?.domainId) return field;
  const domain = (bom.domains || []).find(candidate => candidate.id === field.domainId);
  return domain ? { ...field, enum: [...domain.values] } : field;
}

export function findBomMethod(bom, name) {
  return (bom?.methods || []).find(method => method.name === name) || null;
}

export function resolvedBomFields(bom) {
  return (bom?.fields || []).map(field => findField(bom, field.key));
}

export function inferSemanticType(field) {
  if (field.semanticType) return field.semanticType;
  if (field.enum?.length) return 'Enum';
  if (field.type === 'Double') return 'Decimal';
  return field.type;
}

/**
 * 校验 BOM，返回 null 表示通过，否则返回中文错误信息。
 */
export function validateBom(bom) {
  if (!bom || typeof bom !== 'object' || Array.isArray(bom)) return 'BOM 必须是对象';
  if (!Array.isArray(bom.fields)) return 'BOM 必须包含 fields 数组';
  if (bom.fields.length < 2) return 'BOM 至少需要 2 个字段';
  const keys = new Set();
  const domains = new Map();
  if (bom.domains != null && (!Array.isArray(bom.domains) || bom.domains.length > 50)) return 'BOM 动态域必须是最多 50 项的数组';
  for (const [index, domain] of (bom.domains || []).entries()) {
    const label = `第 ${index + 1} 个动态域`;
    if (!domain || typeof domain !== 'object' || typeof domain.id !== 'string' || !METHOD_RE.test(domain.id)) return `${label}标识无效`;
    if (domains.has(domain.id)) return `动态域 ${domain.id} 重复`;
    if (typeof domain.label !== 'string' || !domain.label.trim() || domain.label.length > 40) return `${label}显示名需为 1-40 字`;
    if (!Array.isArray(domain.values) || domain.values.length < 1 || domain.values.length > 200) return `${label}需包含 1-200 个值`;
    if (domain.values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(domain.values).size !== domain.values.length) return `${label}包含无效或重复值`;
    domains.set(domain.id, domain);
  }
  for (const f of bom.fields) {
    if (!f || typeof f !== 'object') return '字段定义无效';
    if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) return `字段 key "${f.key}" 不合法（小驼峰标识符，1-32 字符）`;
    if (keys.has(f.key)) return `字段 key "${f.key}" 重复`;
    keys.add(f.key);
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > 40) return `字段 ${f.key} 的显示名需为 1-40 字`;
    if (f.factType != null && (typeof f.factType !== 'string' || !/^[A-Z][a-zA-Z0-9_]{0,63}$/.test(f.factType))) return `字段 ${f.key} 的 factType 必须是大写字母开头的英文标识符`;
    if (f.factTypeLabel != null && (typeof f.factTypeLabel !== 'string' || !f.factTypeLabel.trim() || f.factTypeLabel.length > 40)) return `字段 ${f.key} 的事实类型业务名称需为 1-40 字`;
    if (!FIELD_TYPES.includes(f.type)) return `字段 ${f.key} 的类型必须是 ${FIELD_TYPES.join('/')}`;
    if (f.semanticType != null && !SEMANTIC_TYPES.includes(f.semanticType)) return `字段 ${f.key} 的业务类型必须是 ${SEMANTIC_TYPES.join('/')}`;
    const semanticType = inferSemanticType(f);
    if (f.semanticType != null && SEMANTIC_RUNTIME_TYPES[semanticType] !== f.type) return `字段 ${f.key} 的业务类型 ${semanticType} 必须映射为运行时类型 ${SEMANTIC_RUNTIME_TYPES[semanticType]}`;
    if (f.domainId != null && (typeof f.domainId !== 'string' || !domains.has(f.domainId))) return `字段 ${f.key} 引用了不存在的动态域`;
    if (f.domainId != null && semanticType !== 'Enum') return `字段 ${f.key} 只有 Enum 类型能引用动态域`;
    if (semanticType === 'Enum' && f.domainId == null && (!Array.isArray(f.enum) || f.enum.length < 1)) return `字段 ${f.key} 的 Enum 类型必须配置枚举值或动态域`;
    if (!FIELD_KINDS.includes(f.kind)) return `字段 ${f.key} 的 kind 必须是 input/output`;
    if (f.required != null && (typeof f.required !== 'boolean' || f.kind !== 'input')) return `字段 ${f.key} 的 required 只能用于 input 字段`;
    if (f.group != null && typeof f.group !== 'string') return `字段 ${f.key} 的分组必须是字符串`;
    if (f.unit != null && typeof f.unit !== 'string') return `字段 ${f.key} 的单位必须是字符串`;
    if (f.description != null && (typeof f.description !== 'string' || f.description.length > 200)) return `字段 ${f.key} 的说明不能超过 200 字`;
    if (f.maxLength != null && (semanticType !== 'String' || !Number.isInteger(f.maxLength) || f.maxLength < 1)) return `字段 ${f.key} 的 maxLength 只能是 String 类型的正整数约束`;
    if (f.regex != null) {
      if (semanticType !== 'String' || typeof f.regex !== 'string' || !f.regex) return `字段 ${f.key} 的 regex 只能用于 String 类型`;
      try { new RegExp(f.regex); } catch { return `字段 ${f.key} 的 regex 不是有效正则表达式`; }
    }
    if (f.allowDuplicates != null && (semanticType !== 'List<String>' || typeof f.allowDuplicates !== 'boolean')) return `字段 ${f.key} 的 allowDuplicates 只能用于 List<String> 类型`;
    // 数值范围
    if (f.type === 'Integer' || f.type === 'Double') {
      if (f.min != null && (typeof f.min !== 'number' || !Number.isFinite(f.min))) return `字段 ${f.key} 的 min 必须是数字`;
      if (f.max != null && (typeof f.max !== 'number' || !Number.isFinite(f.max))) return `字段 ${f.key} 的 max 必须是数字`;
      if (f.min != null && f.max != null && f.min > f.max) return `字段 ${f.key} 的 min 不能大于 max`;
      if (f.type === 'Integer' && f.min != null && !Number.isInteger(f.min)) return `字段 ${f.key} 是 Integer 类型，min 必须是整数`;
      if (f.type === 'Integer' && f.max != null && !Number.isInteger(f.max)) return `字段 ${f.key} 是 Integer 类型，max 必须是整数`;
    } else {
      if (f.min != null || f.max != null) return `字段 ${f.key} 不是数值类型，不能配置 min/max`;
    }
    // 枚举
    if (f.enum != null && f.domainId == null) {
      if (!Array.isArray(f.enum) || f.enum.length < 1) return `字段 ${f.key} 的 enum 必须是非空数组或 null`;
      if (semanticType !== 'Enum') return `字段 ${f.key} 是 ${semanticType} 类型，只有 Enum 字段能配置枚举`;
      for (const v of f.enum) {
        if (typeof v !== 'string' || !v.trim() || v.length > 200) return `字段 ${f.key} 的枚举值必须是非空字符串（<=200 字）`;
      }
    }
    // 控件
    if (f.control != null && !CONTROLS.includes(f.control)) return `字段 ${f.key} 的 control 必须是 ${CONTROLS.join('/')}`;
  }
  if (!bom.fields.some(f => f.kind === 'input')) return 'BOM 至少需要一个 input 字段';
  if (!bom.fields.some(f => f.kind === 'output')) return 'BOM 至少需要一个 output 字段';
  const eventTypeError = validateBomEventTypes(bom);
  if (eventTypeError) return eventTypeError;
  const methodError = validateBomMethods(bom);
  if (methodError) return methodError;
  return null;
}

function methodExpressionType(node, bom, depth = 1, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > 10 || state.nodes > 100) return { error: 'BOM 方法表达式最多支持 10 层、100 个节点' };
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { error: 'BOM 方法表达式节点无效' };
  if (node.type === 'literal') {
    if (typeof node.value !== 'string' || !node.value.trim() || !Number.isFinite(Number(node.value))) return { error: 'BOM 方法数值常量无效' };
    return { type: /^-?\d+$/.test(node.value.trim()) ? 'Integer' : 'Decimal' };
  }
  if (node.type === 'field') {
    if (node.fieldSource === 'variable') return { error: 'BOM 方法不能引用 Rule Project 变量' };
    const field = findField(bom, node.field);
    const semanticType = field && field.kind === 'input' ? inferSemanticType(field) : null;
    return ['Integer', 'Decimal'].includes(semanticType) ? { type: semanticType } : { error: `BOM 方法字段 ${node.field || ''} 不存在或不是数值输入字段` };
  }
  if (node.type === 'binary') {
    if (!['+', '-', '*', '/'].includes(node.operator)) return { error: 'BOM 方法运算符无效' };
    const left = methodExpressionType(node.left, bom, depth + 1, state);
    if (left.error) return left;
    const right = methodExpressionType(node.right, bom, depth + 1, state);
    if (right.error) return right;
    if (node.operator === '/' && node.right?.type === 'literal' && Number(node.right.value) === 0) return { error: 'BOM 方法不能除以 0' };
    return { type: node.operator === '/' || left.type === 'Decimal' || right.type === 'Decimal' ? 'Decimal' : 'Integer' };
  }
  if (node.type === 'function') {
    if (!['min', 'max', 'round', 'abs'].includes(node.name) || !Array.isArray(node.args)) return { error: 'BOM 方法函数无效' };
    const expected = ['round', 'abs'].includes(node.name) ? 1 : 2;
    if (node.args.length !== expected) return { error: `BOM 方法函数 ${node.name} 需要 ${expected} 个参数` };
    const types = [];
    for (const argument of node.args) {
      const result = methodExpressionType(argument, bom, depth + 1, state);
      if (result.error) return result;
      types.push(result.type);
    }
    return { type: node.name === 'round' ? 'Integer' : types.includes('Decimal') ? 'Decimal' : 'Integer' };
  }
  return { error: 'BOM 方法只支持数值、字段、四则运算和白名单函数' };
}

function validateBomMethods(bom) {
  if (bom.methods != null && (!Array.isArray(bom.methods) || bom.methods.length > 50)) return 'BOM 方法必须是最多 50 项的数组';
  const names = new Set();
  for (const [index, method] of (bom.methods || []).entries()) {
    const label = `第 ${index + 1} 个 BOM 方法`;
    if (!method || typeof method !== 'object' || typeof method.name !== 'string' || !METHOD_RE.test(method.name)) return `${label}名称无效`;
    if (names.has(method.name)) return `BOM 方法 ${method.name} 重复`;
    names.add(method.name);
    if (typeof method.label !== 'string' || !method.label.trim() || method.label.length > 40) return `${label}显示名需为 1-40 字`;
    if (!['Integer', 'Decimal'].includes(method.returnType)) return `${label}返回类型必须是 Integer 或 Decimal`;
    const result = methodExpressionType(method.expression, bom);
    if (result.error) return `${method.label || method.name}：${result.error}`;
    if (method.returnType === 'Integer' && result.type !== 'Integer') return `${method.label || method.name}：Integer 方法不能返回小数表达式`;
  }
  return null;
}

function validateBomEventTypes(bom) {
  if (bom.eventTypes == null) return null;
  if (!Array.isArray(bom.eventTypes)) return 'eventTypes 必须是数组';
  const fieldKeys = new Set((bom.fields || []).map(field => field.key));
  const names = new Set();
  for (const [index, eventType] of bom.eventTypes.entries()) {
    const label = `第 ${index + 1} 个事件类型`;
    if (!eventType || typeof eventType !== 'object') return `${label}定义无效`;
    if (typeof eventType.name !== 'string' || !EVENT_NAME_RE.test(eventType.name)) return `${label} name 必须是大写字母开头的英文标识符`;
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
      const missing = eventType.duplicateKey.filter(key => !fieldKeys.has(key) && !EVENT_ENVELOPE_KEYS.has(key));
      if (missing.length) return `${label} duplicateKey 引用了不存在的字段 ${missing.join(', ')}`;
    }
  }
  return null;
}

/**
 * 对比新旧 BOM，返回影响分析结果。
 * usedKeys: 当前所有资产（规则、决策表和规则集）引用过的 field key 集合。
 * 返回 { errors: string[], warnings: string[] }
 *   errors：被删除字段仍被引用 → 必须阻止保存
 *   warnings：类型/kind 变更、枚举收缩 → 提示但不阻止
 */
export function diffBom(oldBom, newBom, usedKeys = new Set()) {
  const errors = [];
  const warnings = [];
  const oldMap = new Map(oldBom.fields.map(f => [f.key, f]));
  const newMap = new Map(newBom.fields.map(f => [f.key, f]));
  const oldDomains = new Map((oldBom.domains || []).map(domain => [domain.id, domain]));
  const newDomains = new Map((newBom.domains || []).map(domain => [domain.id, domain]));

  for (const [key, oldField] of oldMap) {
    if (!newMap.has(key)) {
      if (usedKeys.has(key)) errors.push(`字段 "${oldField.label}"(${key}) 已被规则资产引用，不能删除`);
      continue;
    }
    const newField = newMap.get(key);
    if (oldField.type !== newField.type) {
      warnings.push(`字段 "${oldField.label}" 类型由 ${oldField.type} 变更为 ${newField.type}，引用它的规则可能失效`);
    }
    if (oldField.kind !== newField.kind) {
      warnings.push(`字段 "${oldField.label}" 方向由 ${oldField.kind} 变更为 ${newField.kind}，引用它的条件/动作可能失效`);
    }
    if ((oldField.factType || null) !== (newField.factType || null)) {
      warnings.push(`字段 "${oldField.label}" 所属事实类型由 ${oldField.factType || '未分配'} 变更为 ${newField.factType || '未分配'}`);
    }
    if ((oldField.semanticType || oldField.type) !== (newField.semanticType || newField.type)) {
      warnings.push(`字段 "${oldField.label}" 业务类型由 ${oldField.semanticType || oldField.type} 变更为 ${newField.semanticType || newField.type}，引用它的规则值可能需要调整`);
    }
    // 枚举收缩：旧枚举里有但新枚举里没有的值
    if (oldField.enum && newField.enum) {
      const removed = oldField.enum.filter(v => !newField.enum.includes(v));
      if (removed.length) warnings.push(`字段 "${oldField.label}" 枚举收缩，移除了 [${removed.join(', ')}]，已发布规则可能引用这些值`);
    }
    if ((oldField.domainId || null) !== (newField.domainId || null)) warnings.push(`字段 "${oldField.label}" 动态域由 ${oldField.domainId || '未绑定'} 变更为 ${newField.domainId || '未绑定'}`);
  }
  for (const [id, oldDomain] of oldDomains) {
    const next = newDomains.get(id);
    if (!next) { warnings.push(`动态域 "${oldDomain.label}"(${id}) 已删除`); continue; }
    const removed = oldDomain.values.filter(value => !next.values.includes(value));
    if (removed.length) warnings.push(`动态域 "${oldDomain.label}" 收缩，移除了 [${removed.join(', ')}]`);
  }
  const oldMethods = new Map((oldBom.methods || []).map(method => [method.name, method]));
  const newMethods = new Map((newBom.methods || []).map(method => [method.name, method]));
  for (const [name, method] of oldMethods) {
    if (!newMethods.has(name)) warnings.push(`BOM 方法 "${method.label}"(${name}) 已删除，引用它的规则将失效`);
    else if (JSON.stringify(method) !== JSON.stringify(newMethods.get(name))) warnings.push(`BOM 方法 "${method.label}"(${name}) 定义已变更`);
  }
  return { errors, warnings };
}

/**
 * 从 BOM 推导某个字段在前端使用的控件类型。
 */
export function inferControl(field) {
  if (field.control) return field.control;
  if (field.enum) return 'select';
  if (field.type === 'Boolean') return 'boolean';
  if (field.type === 'Integer' || field.type === 'Double') return 'number';
  return 'text';
}
