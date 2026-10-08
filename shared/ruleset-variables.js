export const RULESET_VARIABLE_NAME_RE = /^[a-z][a-zA-Z0-9_]{1,31}$/;

export const RULESET_VARIABLE_TYPES = ['Integer', 'Double', 'Boolean', 'String'];

export function runtimeVariableType(type) {
  return ({
    Integer: 'java.lang.Integer',
    Double: 'java.lang.Double',
    Boolean: 'java.lang.Boolean',
    String: 'String',
  })[type] || null;
}

export function defaultVariableValue(type) {
  return type === 'Boolean' ? false : type === 'String' ? '' : type === 'Integer' ? 0 : 0;
}

export function normalizeRuleSetVariables(variables = []) {
  if (!Array.isArray(variables)) return [];
  return variables
    .filter(variable => variable && typeof variable === 'object' && !Array.isArray(variable))
    .map(variable => ({
      name: typeof variable.name === 'string' ? variable.name.trim() : '',
      label: typeof variable.label === 'string' ? variable.label.trim() : '',
      type: variable.type,
      defaultValue: variable.defaultValue,
      enum: Array.isArray(variable.enum) ? [...variable.enum] : null,
      description: typeof variable.description === 'string' ? variable.description : '',
    }));
}

export function canonicalRuleSetVariables(variables = []) {
  return normalizeRuleSetVariables(variables).map(variable => ({
    ...variable,
    defaultValue: (() => {
      const raw = variable.defaultValue == null ? defaultVariableValue(variable.type) : variable.defaultValue;
      const parsed = parseVariableValue(variable, raw);
      return parsed === null ? raw : parsed;
    })(),
    enum: variable.enum?.length ? [...variable.enum] : null,
  }));
}

export function findRuleSetVariable(variables, name) {
  return normalizeRuleSetVariables(variables).find(variable => variable.name === name) || null;
}

export function parseVariableValue(variable, raw) {
  if (!variable) return null;
  if (variable.type === 'Boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    return null;
  }
  if (variable.type === 'String') {
    if (typeof raw !== 'string' || raw.length > 200) return null;
    if (variable.enum?.length && !variable.enum.includes(raw)) return null;
    return raw;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (variable.type === 'Integer' && Number.isInteger(raw)) return raw;
    if (variable.type === 'Double') return raw;
  }
  if (typeof raw !== 'string' || raw.length > 200 || !raw.trim()) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return null;
  if (variable.type === 'Integer' && Number.isInteger(value)) return value;
  if (variable.type === 'Double') return value;
  return null;
}

export function validateRuleSetVariables(variables = []) {
  if (!Array.isArray(variables) || variables.length > 50) return '规则集变量最多 50 个';
  const names = new Set();
  for (const [index, raw] of variables.entries()) {
    const label = `第 ${index + 1} 个规则集变量`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${label}定义无效`;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!RULESET_VARIABLE_NAME_RE.test(name)) return `${label}名称必须是 2-32 位小驼峰标识符`;
    if (names.has(name)) return `规则集变量 "${name}" 重复`;
    names.add(name);
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 40) return `${label}显示名需为 1-40 个字符`;
    if (!RULESET_VARIABLE_TYPES.includes(raw.type)) return `${label}类型必须是 ${RULESET_VARIABLE_TYPES.join('/')}`;
    if (raw.description != null && (typeof raw.description !== 'string' || raw.description.length > 200)) return `${label}说明不能超过 200 个字符`;
    if (raw.enum != null) {
      if (raw.type !== 'String' || !Array.isArray(raw.enum) || raw.enum.length < 1 || raw.enum.length > 50) return `${label}枚举值仅支持 String 类型，且数量为 1-50`;
      if (raw.enum.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(raw.enum).size !== raw.enum.length) return `${label}枚举值无效或重复`;
    }
    const defaultValue = raw.defaultValue == null ? defaultVariableValue(raw.type) : parseVariableValue(raw, raw.defaultValue);
    if (defaultValue === null || (raw.type === 'String' && raw.enum?.length && !raw.enum.includes(defaultValue))) return `${label}默认值无效`;
  }
  return null;
}

export function variableDrlValue(variable, raw) {
  const value = parseVariableValue(variable, raw);
  if (value === null) return null;
  if (variable.type === 'String') return JSON.stringify(value);
  if (variable.type === 'Boolean') return String(value);
  return variable.type === 'Double' ? `${value}d` : String(value);
}
