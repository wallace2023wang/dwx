import type { BomDataType } from '../types'

export interface BomOperatorCapability {
  value: string
  label: string
  runtimeSupported: boolean
}

export interface BomTypeCapability {
  control: 'number' | 'boolean' | 'select' | 'date' | 'text'
  step?: number
  operators: BomOperatorCapability[]
}

const supported = (value: string, label: string): BomOperatorCapability => ({ value, label, runtimeSupported: true })

const equality = [supported('==', '等于'), supported('!=', '不等于')]

export const BOM_TYPE_CAPABILITIES: Record<BomDataType, BomTypeCapability> = {
  Integer: {
    control: 'number', step: 1,
    operators: [...equality, supported('>', '大于'), supported('<', '小于'), supported('>=', '大于等于'), supported('<=', '小于等于'), supported('between', '介于')],
  },
  Decimal: {
    control: 'number', step: 0.01,
    operators: [...equality, supported('>', '大于'), supported('<', '小于'), supported('>=', '大于等于'), supported('<=', '小于等于'), supported('between', '介于')],
  },
  Boolean: { control: 'boolean', operators: equality },
  String: {
    control: 'text',
    operators: [...equality, supported('contains', '包含'), supported('not contains', '不包含'), supported('starts with', '开头是'), supported('ends with', '结尾是'), supported('matches', '匹配正则')],
  },
  Enum: {
    control: 'select',
    operators: [supported('==', '是'), supported('!=', '不是'), supported('in', '属于'), supported('not in', '不属于')],
  },
  Date: {
    control: 'date',
    operators: [...equality, supported('before', '早于'), supported('after', '晚于'), supported('between', '介于')],
  },
  'List<String>': {
    control: 'text',
    operators: [supported('contains', '包含'), supported('not contains', '不包含'), supported('size >', '长度大于'), supported('size <', '长度小于')],
  },
}

export function operatorsForType(type: BomDataType | undefined) {
  return type ? BOM_TYPE_CAPABILITIES[type].operators : equality
}

export function defaultOperatorForType(type: BomDataType | undefined) {
  const operators = operatorsForType(type)
  return operators.find(operator => operator.runtimeSupported)?.value || operators[0]?.value || '=='
}

const FIELD_VALUE_OPERATORS: Partial<Record<BomDataType, string[]>> = {
  Integer: ['==', '!=', '>', '<', '>=', '<='],
  Decimal: ['==', '!=', '>', '<', '>=', '<='],
  Boolean: ['==', '!='],
  String: ['==', '!=', 'contains', 'not contains', 'starts with', 'ends with', 'matches'],
  Enum: ['==', '!='],
  Date: ['==', '!=', 'before', 'after'],
}

export function supportsFieldValueForType(type: BomDataType | undefined, operator: string) {
  return Boolean(type && FIELD_VALUE_OPERATORS[type]?.includes(operator))
}
