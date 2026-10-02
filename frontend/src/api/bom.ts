import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { BomDataType, BomEventType, BomFactType, BomField, BomModel } from '../types'
import { http } from './client'

export interface FlatBomField {
  key: string
  label: string
  type: 'Integer' | 'Double' | 'String' | 'Boolean'
  semanticType?: BomDataType
  kind: 'input' | 'output'
  factType?: string
  factTypeLabel?: string
  group?: string
  unit?: string | null
  min?: number | null
  max?: number | null
  enum?: string[] | null
  control?: 'text' | 'number' | 'select' | 'boolean' | 'date'
  description?: string
  maxLength?: number | null
  regex?: string | null
  allowDuplicates?: boolean
  required?: boolean
}

export interface FlatBomModel {
  version: number
  updatedAt?: string
  fields: FlatBomField[]
  eventTypes?: BomEventType[]
}

export interface BomReference {
  id: string
  name: string
  type: 'rule' | 'decision-table' | 'flow'
  status: 'draft' | 'published'
}

export interface SaveBomResult {
  bom: BomModel
  warnings: string[]
}

const knownFacts: Record<string, { name: string; label: string }> = {
  '客户基本信息': { name: 'Borrower', label: '借款申请人' },
  '客户信用': { name: 'Borrower', label: '借款申请人' },
  '结果输出': { name: 'LoanDecision', label: '审批结果' },
}

function inferredFact(field: FlatBomField) {
  if (field.factType) return { name: field.factType, label: field.factTypeLabel || field.factType }
  return knownFacts[field.group || '']
    || (field.kind === 'output'
      ? { name: 'LoanDecision', label: '审批结果' }
      : { name: 'RuleInput', label: '规则输入' })
}

function semanticType(field: FlatBomField): BomDataType {
  if (field.semanticType) return field.semanticType
  if (field.enum?.length) return 'Enum'
  if (field.type === 'Double') return 'Decimal'
  return field.type
}

function runtimeType(type: BomDataType): FlatBomField['type'] {
  if (type === 'Decimal') return 'Double'
  if (['Enum', 'Date', 'List<String>'].includes(type)) return 'String'
  return type as FlatBomField['type']
}

function flatDrl(fields: FlatBomField[]) {
  return `declare RuleInput\n${fields.map(field => `  ${field.key} : ${field.type}`).join('\n')}\nend`
}

export function bomDrlPreview(model: BomModel) {
  return flatDrl(flattenFromFactTypes(model))
}

export function flattenToFactTypes(flat: FlatBomModel, references: Record<string, number> = {}, drl?: string): BomModel {
  const facts = new Map<string, BomFactType>()
  for (const field of flat.fields) {
    const meta = inferredFact(field)
    const fact = facts.get(meta.name) || { name: meta.name, label: meta.label, direction: field.kind, fields: [] }
    const nextField: BomField = {
      key: field.key,
      label: field.label,
      type: semanticType(field),
      runtimeType: field.type,
      direction: field.kind,
      references: references[field.key] || 0,
      factName: meta.name,
      factLabel: meta.label,
      enum: field.enum || null,
      unit: field.unit || null,
      min: field.min ?? null,
      max: field.max ?? null,
      control: field.control,
      group: field.group,
      description: field.description,
      maxLength: field.maxLength ?? null,
      regex: field.regex ?? null,
      allowDuplicates: field.allowDuplicates,
      required: field.required === true,
    }
    fact.fields.push(nextField)
    if (fact.direction !== field.kind) fact.direction = 'mixed'
    facts.set(meta.name, fact)
  }
  const factTypes = [...facts.values()]
  return {
    version: flat.version,
    updatedAt: flat.updatedAt,
    updatedBy: 'Team Server',
    eventTypes: flat.eventTypes || [],
    factTypes,
    vocabulary: factTypes.flatMap(fact => fact.fields.map(field => ({
      property: `${fact.name}.${field.key}`,
      label: field.label,
      type: field.enum?.length ? 'enum' : field.type,
      references: field.references,
    }))),
    relationships: factTypes.map(fact => `调用请求 1 -> 1 ${fact.label}`),
    drl: drl || flatDrl(flat.fields),
  }
}

export function flattenFromFactTypes(model: BomModel): FlatBomField[] {
  return model.factTypes.flatMap(fact => fact.fields.map(field => ({
    key: field.key,
    label: field.label,
    type: runtimeType(field.type),
    semanticType: field.type,
    kind: field.direction,
    factType: fact.name,
    factTypeLabel: fact.label,
    group: field.group || fact.label,
    unit: field.unit || null,
    min: field.min ?? null,
    max: field.max ?? null,
    enum: field.enum || null,
    control: field.control || (field.type === 'Enum' ? 'select' : field.type === 'Boolean' ? 'boolean' : ['Integer', 'Decimal'].includes(field.type) ? 'number' : field.type === 'Date' ? 'date' : 'text'),
    description: field.description || '',
    maxLength: field.maxLength ?? null,
    regex: field.regex ?? null,
    allowDuplicates: field.type === 'List<String>' ? field.allowDuplicates ?? true : undefined,
    required: field.direction === 'input' ? field.required === true : undefined,
  })))
}

const miniloanBom: BomModel = {
  version: 4,
  updatedBy: '陈分析师',
  factTypes: [
    {
      name: 'Borrower', label: '借款申请人', direction: 'input',
      fields: [
        { key: 'age', label: '年龄', type: 'Integer', direction: 'input', references: 2, min: 0, max: 150, unit: '岁', control: 'number' },
        { key: 'yearlyIncome', label: '申请人年收入', type: 'Decimal', runtimeType: 'Double', direction: 'input', references: 3, min: 0, unit: '元', control: 'number' },
        { key: 'creditScore', label: '信用分', type: 'Integer', direction: 'input', references: 2 },
        { key: 'delinquencies', label: '历史逾期次数', type: 'Integer', direction: 'input', references: 2 },
        { key: 'residency', label: '居住地类型', type: 'String', direction: 'input', references: 1 },
      ],
    },
    {
      name: 'Loan', label: '贷款申请', direction: 'input',
      fields: [
        { key: 'amount', label: '申请贷款金额', type: 'Decimal', runtimeType: 'Double', direction: 'input', references: 3, min: 0, unit: '元', control: 'number' },
        { key: 'durationMonths', label: '贷款期限', type: 'Integer', direction: 'input', references: 2, min: 1, unit: '月', control: 'number' },
        { key: 'productType', label: '贷款产品', type: 'Enum', runtimeType: 'String', direction: 'input', references: 1, enum: ['消费贷', '经营贷', '房贷'], control: 'select' },
      ],
    },
    {
      name: 'LoanDecision', label: '审批结果', direction: 'output',
      fields: [
        { key: 'approved', label: '批准', type: 'Boolean', direction: 'output', references: 4, control: 'boolean' },
        { key: 'riskLevel', label: '风险等级', type: 'Enum', runtimeType: 'String', direction: 'output', references: 5, enum: ['低', '中', '高', '拒绝'], control: 'select' },
        { key: 'maxAmount', label: '最高审批额度', type: 'Decimal', runtimeType: 'Double', direction: 'output', references: 2, unit: '元' },
        { key: 'reasons', label: '理由', type: 'List<String>', runtimeType: 'String', direction: 'output', references: 3 },
      ],
    },
  ],
  vocabulary: [],
  relationships: ['调用请求 1 -> 1 借款申请人', '调用请求 1 -> 1 贷款申请', '调用请求 1 -> 1 审批结果'],
  drl: 'declare RuleInput\n  age : Integer\n  amount : Double\n  approved : Boolean\nend',
}
miniloanBom.vocabulary = miniloanBom.factTypes.flatMap(fact => fact.fields.map(field => ({ property: `${fact.name}.${field.key}`, label: field.label, type: field.type, references: field.references })))

const grainBom: BomModel = {
  version: 2,
  updatedBy: '王工程师',
  factTypes: [
    { name: 'GrainStore', label: '粮仓', direction: 'input', fields: [
      { key: 'averageTemperature', label: '整仓均温', type: 'Decimal', runtimeType: 'Double', direction: 'input', references: 4 },
      { key: 'insideTemperature', label: '仓内温度', type: 'Decimal', runtimeType: 'Double', direction: 'input', references: 3 },
      { key: 'outsideTemperature', label: '仓外温度', type: 'Decimal', runtimeType: 'Double', direction: 'input', references: 2 },
      { key: 'humidity', label: '仓内湿度', type: 'Decimal', runtimeType: 'Double', direction: 'input', references: 2 },
    ] },
    { name: 'ControlDecision', label: '调控决策', direction: 'output', fields: [
      { key: 'alertLevel', label: '告警等级', type: 'String', direction: 'output', references: 3 },
      { key: 'ventilationRequired', label: '是否通风', type: 'Boolean', direction: 'output', references: 2 },
      { key: 'reason', label: '决策原因', type: 'String', direction: 'output', references: 2 },
    ] },
  ],
  vocabulary: [],
  relationships: ['调用请求 1 -> 1 粮仓', '调用请求 1 -> 1 调控决策'],
  drl: 'declare RuleInput\n  averageTemperature : Double\n  ventilationRequired : Boolean\nend',
}
grainBom.vocabulary = grainBom.factTypes.flatMap(fact => fact.fields.map(field => ({ property: `${fact.name}.${field.key}`, label: field.label, type: field.type, references: field.references })))

export async function loadBom(projectId: string): Promise<BomModel> {
  if (!['miniloan', 'grain-temperature'].includes(projectId)) return (await http.get<BomModel>(`/projects/${encodeURIComponent(projectId)}/bom`)).data
  await new Promise(resolve => window.setTimeout(resolve, 140))
  return projectId === 'grain-temperature' ? grainBom : miniloanBom
}

function requestError(error: unknown) {
  if (axios.isAxiosError<{ error?: string; warnings?: string[] }>(error)) {
    const wrapped = new Error(error.response?.data?.error || error.message) as Error & { warnings?: string[] }
    wrapped.warnings = error.response?.data?.warnings
    return wrapped
  }
  return error instanceof Error ? error : new Error('BOM 操作失败')
}

async function saveBom(projectId: string, model: BomModel, acknowledgeImpact: boolean): Promise<SaveBomResult> {
  if (['miniloan', 'grain-temperature'].includes(projectId)) throw new Error('演示项目的 BOM 不能修改')
  try {
    const { data } = await http.put<{ bom: FlatBomModel; warnings: string[] }>(`/projects/${encodeURIComponent(projectId)}/bom`, {
      version: model.version,
      fields: flattenFromFactTypes(model),
      eventTypes: model.eventTypes || [],
      acknowledgeImpact,
    })
    return { bom: flattenToFactTypes(data.bom), warnings: data.warnings || [] }
  } catch (error) {
    throw requestError(error)
  }
}

export async function loadBomReferences(fieldKey: string, projectId = 'default'): Promise<BomReference[]> {
  const { data } = await http.get<BomReference[]>(`/projects/${encodeURIComponent(projectId)}/bom/references`, { params: { field: fieldKey } })
  return data
}

export function useBom(projectId: string | undefined) {
  return useQuery({ queryKey: ['projects', projectId, 'bom'], queryFn: () => loadBom(projectId || ''), enabled: Boolean(projectId) })
}

export function useSaveBom(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ model, acknowledgeImpact = false }: { model: BomModel; acknowledgeImpact?: boolean }) => saveBom(projectId || '', model, acknowledgeImpact),
    onSuccess: result => {
      queryClient.setQueryData(['projects', projectId, 'bom'], result.bom)
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'bom'] })
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] })
    },
  })
}
