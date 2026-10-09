import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { BomDataType, BomDomain, BomEventType, BomFactType, BomField, BomMethod, BomModel } from '../types'
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
  domainId?: string | null
}

export interface FlatBomModel {
  version: number
  updatedAt?: string
  fields: FlatBomField[]
  eventTypes?: BomEventType[]
  domains?: BomDomain[]
  methods?: BomMethod[]
}

export interface BomReference {
  id: string
  name: string
  type: 'rule' | 'decision-table' | 'decision-tree' | 'scorecard' | 'rule-template' | 'flow'
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
  const domains = new Map((flat.domains || []).map(domain => [domain.id, domain]))
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
      enum: field.domainId ? domains.get(field.domainId)?.values || null : field.enum || null,
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
      domainId: field.domainId || null,
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
    domains: flat.domains || [],
    methods: flat.methods || [],
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
    enum: field.domainId ? null : field.enum || null,
    control: field.control || (field.type === 'Enum' ? 'select' : field.type === 'Boolean' ? 'boolean' : ['Integer', 'Decimal'].includes(field.type) ? 'number' : field.type === 'Date' ? 'date' : 'text'),
    description: field.description || '',
    maxLength: field.maxLength ?? null,
    regex: field.regex ?? null,
    allowDuplicates: field.type === 'List<String>' ? field.allowDuplicates ?? true : undefined,
    required: field.direction === 'input' ? field.required === true : undefined,
    domainId: field.domainId || null,
  })))
}

export async function loadBom(projectId: string): Promise<BomModel> {
  return (await http.get<BomModel>(`/projects/${encodeURIComponent(projectId)}/bom`)).data
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
  try {
    const { data } = await http.put<{ bom: FlatBomModel; warnings: string[] }>(`/projects/${encodeURIComponent(projectId)}/bom`, {
      version: model.version,
      fields: flattenFromFactTypes(model),
      eventTypes: model.eventTypes || [],
      domains: model.domains || [],
      methods: model.methods || [],
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
