import { findField, inferSemanticType, inputFields, outputFields } from './bom.js';
import { canonicalPackageName, DEFAULT_PACKAGE_NAME, PACKAGE_NAME_RE } from './packages.js';
import { generateDrl, parseValue, validateRule } from './rules.js';

const PARAMETER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PARAMETER_TYPES = new Set(['Integer', 'Decimal', 'Boolean', 'String', 'Enum', 'Date']);
const SLOT_OPERATORS = new Set(['==', '!=', '>', '>=', '<', '<=', 'contains', 'not contains', 'starts with', 'ends with', 'before', 'after']);

const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;

function parameterType(field) {
  return inferSemanticType(field);
}

function defaultValue(field) {
  if (!field) return '';
  if (field.type === 'Boolean') return 'true';
  if (field.type === 'Integer' || field.type === 'Double') return String(field.min ?? 0);
  return field.enum?.[0] || '';
}

export function newRuleTemplate(bom) {
  const input = inputFields(bom)[0];
  const output = outputFields(bom)[0];
  const conditionParameter = { id: id('parameter'), name: 'conditionValue', label: `${input?.label || '条件'}参数`, type: parameterType(input) || 'String', defaultValue: defaultValue(input) };
  const actionParameter = { id: id('parameter'), name: 'actionValue', label: `${output?.label || '结果'}参数`, type: parameterType(output) || 'String', defaultValue: defaultValue(output) };
  return {
    kind: 'rule-template',
    name: '未命名规则模板',
    description: '',
    category: DEFAULT_PACKAGE_NAME,
    priority: 0,
    parameters: [conditionParameter, actionParameter],
    blueprint: {
      conditions: input ? [{ field: input.key, operator: '==', parameter: conditionParameter.name }] : [],
      actions: output ? [{ field: output.key, parameter: actionParameter.name }] : [],
    },
    instances: [{
      id: id('instance'), name: '默认实例', enabled: true, priorityOffset: 0,
      values: { [conditionParameter.name]: conditionParameter.defaultValue, [actionParameter.name]: actionParameter.defaultValue },
    }],
  };
}

export function isRuleTemplate(value) {
  return value?.kind === 'rule-template';
}

function parameterValueError(parameter, raw, bom) {
  if (typeof raw !== 'string' || raw.length > 200) return `参数“${parameter.label}”值无效`;
  const field = {
    key: parameter.name,
    label: parameter.label,
    kind: 'input',
    type: parameter.type === 'Decimal' ? 'Double' : parameter.type === 'Enum' ? 'String' : parameter.type,
    ...(parameter.enum?.length ? { enum: parameter.enum } : {}),
  };
  return parseValue(field, raw, bom) === null ? `参数“${parameter.label}”值与类型 ${parameter.type} 不匹配` : null;
}

function slotParameter(slot, parameters) {
  return slot.parameter ? parameters.get(slot.parameter) : null;
}

function slotTypeMatches(parameter, field) {
  return parameter?.type === inferSemanticType(field);
}

export function expandRuleTemplate(template, bom) {
  const parameters = new Map((template.parameters || []).map(parameter => [parameter.name, parameter]));
  return (template.instances || []).flatMap((instance, instanceIndex) => {
    if (instance.enabled === false) return [];
    const value = slot => slot.parameter ? instance.values?.[slot.parameter] : slot.value;
    return [{
      name: `${template.name} / ${instance.name}`,
      description: template.description,
      category: template.category,
      priority: template.priority + (instance.priorityOffset || 0),
      templateInstanceId: instance.id,
      templateInstanceIndex: instanceIndex,
      conditions: template.blueprint.conditions.map(slot => ({
        field: slot.field,
        operator: slot.operator,
        value: value(slot),
      })),
      actions: template.blueprint.actions.map(slot => ({
        field: slot.field,
        value: value(slot),
      })),
    }];
  });
}

export function validateRuleTemplate(template, bom) {
  if (!isRuleTemplate(template)) return '规则模板内容无效';
  if (typeof template.name !== 'string' || !template.name.trim() || template.name.length > 80) return '模板名称需为 1–80 个字符';
  if (typeof template.description !== 'string' || template.description.length > 500) return '模板说明不能超过 500 个字符';
  if (typeof template.category !== 'string' || !PACKAGE_NAME_RE.test(canonicalPackageName(template.category))) return '规则包需为有效英文包名';
  if (!Number.isInteger(template.priority) || template.priority < -1000 || template.priority > 1000) return '优先级需为 -1000 到 1000 的整数';
  if (!Array.isArray(template.parameters) || template.parameters.length < 1 || template.parameters.length > 20) return '规则模板需要 1–20 个参数';
  const parameters = new Map();
  for (const parameter of template.parameters) {
    if (typeof parameter?.id !== 'string' || !parameter.id) return '模板参数 ID 无效';
    if (!PARAMETER_NAME_RE.test(parameter.name || '') || parameters.has(parameter.name)) return '模板参数名称无效或重复';
    if (typeof parameter.label !== 'string' || !parameter.label.trim() || parameter.label.length > 80) return `参数 ${parameter.name} 的显示名称无效`;
    if (!PARAMETER_TYPES.has(parameter.type)) return `参数“${parameter.label}”类型无效`;
    if (parameter.type === 'Enum' && (!Array.isArray(parameter.enum) || parameter.enum.length < 1 || parameter.enum.length > 50 || new Set(parameter.enum).size !== parameter.enum.length)) return `参数“${parameter.label}”枚举值无效`;
    const valueError = parameterValueError(parameter, parameter.defaultValue, bom);
    if (valueError) return valueError;
    parameters.set(parameter.name, parameter);
  }
  if (!template.blueprint || !Array.isArray(template.blueprint.conditions) || template.blueprint.conditions.length < 1 || template.blueprint.conditions.length > 20) return '模板规则需要 1–20 个条件槽';
  if (!Array.isArray(template.blueprint.actions) || template.blueprint.actions.length < 1 || template.blueprint.actions.length > 20) return '模板规则需要 1–20 个动作槽';
  const used = new Set();
  for (const slot of template.blueprint.conditions) {
    const field = findField(bom, slot.field);
    if (!field || field.kind !== 'input' || !SLOT_OPERATORS.has(slot.operator)) return '模板条件字段或运算符无效';
    if (slot.parameter) {
      const parameter = slotParameter(slot, parameters);
      if (!parameter || !slotTypeMatches(parameter, field)) return `条件字段“${field.label}”的参数不存在或类型不匹配`;
      used.add(parameter.name);
    } else if (parseValue(field, slot.value, bom) === null) return `条件字段“${field.label}”的固定值无效`;
  }
  const actionFields = new Set();
  for (const slot of template.blueprint.actions) {
    const field = findField(bom, slot.field);
    if (!field || field.kind !== 'output' || actionFields.has(slot.field)) return '模板动作字段无效或重复';
    actionFields.add(slot.field);
    if (slot.parameter) {
      const parameter = slotParameter(slot, parameters);
      if (!parameter || !slotTypeMatches(parameter, field)) return `动作字段“${field.label}”的参数不存在或类型不匹配`;
      used.add(parameter.name);
    } else if (parseValue(field, slot.value, bom) === null) return `动作字段“${field.label}”的固定值无效`;
  }
  const unused = template.parameters.find(parameter => !used.has(parameter.name));
  if (unused) return `参数“${unused.label}”未绑定到条件或动作`;
  if (!Array.isArray(template.instances) || template.instances.length < 1 || template.instances.length > 200) return '规则模板需要 1–200 个实例';
  const instanceIds = new Set();
  const instanceNames = new Set();
  for (const instance of template.instances) {
    if (typeof instance?.id !== 'string' || !instance.id || instanceIds.has(instance.id)) return '模板实例 ID 无效或重复';
    instanceIds.add(instance.id);
    if (typeof instance.name !== 'string' || !instance.name.trim() || instance.name.length > 80 || instanceNames.has(instance.name.trim())) return '模板实例名称无效或重复';
    instanceNames.add(instance.name.trim());
    if (!Number.isInteger(instance.priorityOffset || 0) || template.priority + (instance.priorityOffset || 0) < -1000 || template.priority + (instance.priorityOffset || 0) > 1000) return `实例“${instance.name}”优先级偏移无效`;
    if (!instance.values || typeof instance.values !== 'object' || Array.isArray(instance.values)) return `实例“${instance.name}”参数值无效`;
    for (const parameter of template.parameters) {
      const valueError = parameterValueError(parameter, instance.values[parameter.name], bom);
      if (valueError) return `实例“${instance.name}”：${valueError}`;
    }
  }
  if (!template.instances.some(instance => instance.enabled !== false)) return '至少需要启用一个模板实例';
  for (const rule of expandRuleTemplate(template, bom)) {
    const error = validateRule(rule, bom, []);
    if (error) return `实例“${rule.name.slice(template.name.length + 3)}”：${error}`;
  }
  return null;
}

export function ruleTemplateRules(template, bom) {
  const error = validateRuleTemplate(template, bom);
  if (error) throw new Error(error);
  return expandRuleTemplate(template, bom);
}

export function ruleTemplateDrl(template, bom) {
  return generateDrl(ruleTemplateRules(template, bom), bom, []);
}

export function ruleTemplateExecutionTrace(template, fired = []) {
  const enabled = (template.instances || []).filter(instance => instance.enabled !== false);
  return enabled.map((instance, index) => ({
    instanceId: instance.id,
    instance: instance.name,
    fired: fired.some(name => name === `${template.name} / ${instance.name} [${index + 1}]` || name.startsWith(`${template.name} / ${instance.name} [`)),
  }));
}
