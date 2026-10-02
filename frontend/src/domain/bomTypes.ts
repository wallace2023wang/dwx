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
const planned = (value: string, label: string): BomOperatorCapability => ({ value, label, runtimeSupported: false })

const equality = [supported('==', '等于'), supported('!=', '不等于')]

export const BOM_TYPE_CAPABILITIES: Record<BomDataType, BomTypeCapability> = {
  Integer: {
    control: 'number', step: 1,
    operators: [...equality, supported('>', '大于'), supported('<', '小于'), supported('>=', '大于等于'), supported('<=', '小于等于'), planned('between', '介于')],
  },
  Decimal: {
    control: 'number', step: 0.01,
    operators: [...equality, supported('>', '大于'), supported('<', '小于'), supported('>=', '大于等于'), supported('<=', '小于等于'), planned('between', '介于')],
  },
  Boolean: { control: 'boolean', operators: equality },
  String: {
    control: 'text',
    operators: [...equality, planned('contains', '包含'), planned('not contains', '不包含'), planned('starts with', '开头是'), planned('ends with', '结尾是'), planned('matches', '匹配正则')],
  },
  Enum: {
    control: 'select',
    operators: [supported('==', '是'), supported('!=', '不是'), planned('in', '属于'), planned('not in', '不属于')],
  },
  Date: {
    control: 'date',
    operators: [...equality, planned('before', '早于'), planned('after', '晚于'), planned('between', '介于')],
  },
  'List<String>': {
    control: 'text',
    operators: [planned('contains', '包含'), planned('not contains', '不包含'), planned('size >', '长度大于'), planned('size <', '长度小于')],
  },
}

export function operatorsForType(type: BomDataType | undefined) {
  return type ? BOM_TYPE_CAPABILITIES[type].operators : equality
}

export function defaultOperatorForType(type: BomDataType | undefined) {
  const operators = operatorsForType(type)
  return operators.find(operator => operator.runtimeSupported)?.value || operators[0]?.value || '=='
}
