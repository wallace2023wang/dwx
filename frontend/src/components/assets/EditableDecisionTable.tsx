import { AlertTriangle, CheckCircle2, Code2, Copy, Download, FileSpreadsheet, Info, MoreVertical, Plus, Rocket, Save, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { read, utils, writeFile } from 'xlsx'
import type { AssetDetail, BomField, DecisionTableAnalysis, DecisionTableDraft, RuleSetVariable } from '../../types'
import Modal from '../Modal'
import BomFieldPicker, { type BomFieldPickerOption } from '../bom/BomFieldPicker'
import BomVersionNotice from './BomVersionNotice'

interface EditableDecisionTableProps {
  detail: AssetDetail
  fields: BomField[]
  projectVariables: RuleSetVariable[]
  busy: boolean
  onSave: (draft: DecisionTableDraft) => Promise<void>
  onCompile: (draft: DecisionTableDraft) => Promise<{ engineVersion: string }>
  onSubmit: () => Promise<void>
  onAnalyze: (draft: DecisionTableDraft) => Promise<DecisionTableAnalysis>
}

type CellKind = 'conditions' | 'actions'
type DecisionTableRow = DecisionTableDraft['rows'][number]
type ConditionCell = DecisionTableRow['conditions'][number]

function isFieldCell(value: ConditionCell): value is { valueSource: 'field'; valueField: string } {
  return typeof value === 'object' && value?.valueSource === 'field'
}

function exportConditionCell(value: ConditionCell) {
  return isFieldCell(value) ? `\${${value.valueField}}` : value
}

function importConditionCell(value: unknown): ConditionCell {
  const text = String(value ?? '').trim()
  const field = text.match(/^\$\{([a-zA-Z][a-zA-Z0-9_]*)\}$/)
  return field ? { valueSource: 'field', valueField: field[1] } : text
}

interface ColumnView {
  id: string
  kind: CellKind
  index: number
  fieldKey: string
  field?: BomField
  fieldSource: 'bom' | 'variable'
}

interface ColumnOption {
  field: BomField
  fieldSource: 'bom' | 'variable'
}

interface ImportPreview {
  filename: string
  rows: DecisionTableRow[]
  added: number
  removed: number
  changed: number
  unchanged: number
  details: string[]
}

function tableAoA(draft: DecisionTableDraft) {
  const columnHeader = (kind: 'condition' | 'action', column: { field: string; fieldSource?: 'bom' | 'variable' }) =>
    `${kind === 'condition' ? '条件' : '动作'}:${column.fieldSource === 'variable' ? '变量:' : ''}${column.field}`
  const headers = [
    '行号',
    '启用',
    '默认',
    '优先级',
    ...draft.conditions.map(column => columnHeader('condition', column)),
    ...draft.actions.map(column => columnHeader('action', column)),
  ]
  const rows = draft.rows.map((row, index) => [
    String(index + 1),
    row.enabled ? 'true' : 'false',
    row.isDefault ? 'true' : 'false',
    String(row.priority ?? 0),
    ...draft.conditions.map((_, columnIndex) => exportConditionCell(row.conditions[columnIndex] || '')),
    ...draft.actions.map((_, columnIndex) => row.actions[columnIndex] || ''),
  ])
  return [headers, ...rows]
}

function boolCell(value: unknown, fallback = false) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return fallback
  return !['false', '0', 'no', 'n', '否', '禁用'].includes(text)
}

function rowsEqual(left?: DecisionTableRow, right?: DecisionTableRow) {
  if (!left || !right) return false
  return left.enabled === right.enabled
    && Boolean(left.isDefault) === Boolean(right.isDefault)
    && (left.priority ?? 0) === (right.priority ?? 0)
    && JSON.stringify(left.conditions) === JSON.stringify(right.conditions)
    && JSON.stringify(left.actions) === JSON.stringify(right.actions)
}

function parseImportedRows(aoa: unknown[][], draft: DecisionTableDraft) {
  const header = (aoa[0] || []).map(cell => String(cell ?? '').trim())
  const findIndex = (name: string) => header.findIndex(cell => cell === name)
  const enabledIndex = findIndex('启用')
  const defaultIndex = findIndex('默认')
  const priorityIndex = findIndex('优先级')
  const conditionIndexes = draft.conditions.map(column => findIndex(`条件:${column.fieldSource === 'variable' ? '变量:' : ''}${column.field}`))
  const actionIndexes = draft.actions.map(column => findIndex(`动作:${column.fieldSource === 'variable' ? '变量:' : ''}${column.field}`))
  if (conditionIndexes.some(index => index < 0) || actionIndexes.some(index => index < 0)) throw new Error('导入文件列与当前决策表不匹配，请先保持条件/动作列一致')
  return aoa.slice(1).filter(row => row.some(cell => String(cell ?? '').trim())).map((row): DecisionTableRow => ({
    enabled: enabledIndex >= 0 ? boolCell(row[enabledIndex], true) : true,
    isDefault: defaultIndex >= 0 ? boolCell(row[defaultIndex], false) : false,
    priority: priorityIndex >= 0 && String(row[priorityIndex] ?? '').trim() ? Number(row[priorityIndex]) : 0,
    conditions: conditionIndexes.map(index => importConditionCell(row[index])),
    actions: actionIndexes.map(index => String(row[index] ?? '').trim()),
  }))
}

function buildImportPreview(filename: string, rows: DecisionTableRow[], currentRows: DecisionTableRow[]): ImportPreview {
  let added = 0; let removed = 0; let changed = 0; let unchanged = 0
  const details: string[] = []
  const max = Math.max(rows.length, currentRows.length)
  for (let index = 0; index < max; index += 1) {
    const before = currentRows[index]
    const after = rows[index]
    if (!before && after) { added += 1; if (details.length < 8) details.push(`新增第 ${index + 1} 行`) }
    else if (before && !after) { removed += 1; if (details.length < 8) details.push(`删除第 ${index + 1} 行`) }
    else if (rowsEqual(before, after)) unchanged += 1
    else { changed += 1; if (details.length < 8) details.push(`更新第 ${index + 1} 行`) }
  }
  return { filename, rows, added, removed, changed, unchanged, details }
}

function operatorsFor(field?: BomField) {
  return field && ['Integer', 'Decimal'].includes(field.type)
    ? ['==', '!=', '>', '>=', '<', '<=']
    : ['==', '!=']
}

function variableAsField(variable: RuleSetVariable, direction: 'input' | 'output'): BomField {
  return {
    key: variable.name,
    label: variable.label || variable.name,
    type: variable.type === 'String' && variable.enum?.length ? 'Enum' : variable.type === 'Double' ? 'Decimal' : variable.type,
    direction,
    references: 0,
    factName: 'RuleProject',
    factLabel: 'Rule Project 变量',
    enum: variable.enum || null,
  }
}

function bracketInterval(value: string) {
  return value.match(/^([[(])\s*(-?\d+(?:\.\d+)?)?\s*,\s*(-?\d+(?:\.\d+)?)?\s*([\])])$/)
}

function conditionError(value: ConditionCell, field: BomField | undefined, fields: BomField[] = []) {
  if (isFieldCell(value)) {
    if (!field) return 'BOM 字段不存在'
    const operand = fields.find(candidate => candidate.key === value.valueField)
    if (!operand || operand.direction !== 'input') return '比较字段不存在或不是输入字段'
    if (operand.key === field.key) return '不能与自身比较'
    if (operand.type !== field.type) return '只能与同类型业务字段比较'
    return null
  }
  const text = value.trim()
  if (!field) return 'BOM 字段不存在'
  if (!text) return null
  if (['Integer', 'Decimal'].includes(field.type)) {
    const bounded = bracketInterval(text)
    if (bounded) {
      const [, left, lower, upper, right] = bounded
      if (!lower && !upper) return '区间至少需要一个边界'
      if (field.type === 'Integer' && [lower, upper].filter(Boolean).some(part => !/^-?\d+$/.test(part || ''))) return '整数区间不能包含小数'
      if (lower && upper && (Number(lower) > Number(upper) || (Number(lower) === Number(upper) && (left === '(' || right === ')')))) return '区间为空，请检查上下界和开闭符号'
      return null
    }
    const interval = text.match(/^(-?\d+(?:\.\d+)?)?\.\.(-?\d+(?:\.\d+)?)?$/)
    if (interval) {
      if (!interval[1] && !interval[2]) return '区间至少需要一个边界'
      if (interval[1] && interval[2] && Number(interval[1]) > Number(interval[2])) return '区间下界不能大于上界'
      if (field.type === 'Integer' && [interval[1], interval[2]].filter(Boolean).some(part => !/^-?\d+$/.test(part || ''))) return '整数区间不能包含小数'
      return null
    }
    const comparison = text.match(/^(?:>=|<=|!=|==|>|<)?\s*(-?\d+(?:\.\d+)?)$/)
    if (!comparison) return '请输入数字、比较表达式或区间'
    if (field.type === 'Integer' && !/^-?\d+$/.test(comparison[1])) return '请输入整数'
    return null
  }
  const operand = text.replace(/^(?:!=|==)\s*/, '')
  if (field.type === 'Boolean') return ['true', 'false'].includes(operand) ? null : '请选择 true 或 false'
  if (field.type === 'Enum') {
    const invalid = operand.split(/[,，]/).map(item => item.trim()).filter(Boolean).find(item => !field.enum?.includes(item))
    return invalid ? `枚举值“${invalid}”已失效` : null
  }
  if (field.type === 'Date') return /^\d{4}-\d{2}-\d{2}$/.test(operand) ? null : '请选择有效日期'
  return null
}

function warningLevel(warning: string): 'warn' | 'info' {
  return /动作结果冲突|不可达|条件域为空|所有条件均为空/.test(warning) ? 'warn' : 'info'
}

function rowConditionSummary(row: DecisionTableRow, draft: DecisionTableDraft, fields: Map<string, BomField>) {
  if (row.isDefault) return '默认行：其他行均未命中时执行'
  return draft.conditions.map((column, index) => {
    const field = fields.get(column.field)
    const value = row.conditions[index]
    if (value && isFieldCell(value)) return `${field?.label || column.field} ${column.operator} ${fields.get(value.valueField)?.label || value.valueField}`
    const text = typeof value === 'string' ? value.trim() : ''
    return text ? `${field?.label || column.field} ${text.match(/^(>=|<=|!=|==|>|<)/) ? '' : `${column.operator} `}${text}` : `${field?.label || column.field}：无条件（通配）`
  }).join(' AND ')
}

function actionError(value: string, field?: BomField) {
  const text = value.trim()
  if (!field) return 'BOM 字段不存在'
  if (!text) return null
  if (field.type === 'Integer' && !/^-?\d+$/.test(text)) return '请输入整数'
  if (field.type === 'Decimal' && !Number.isFinite(Number(text))) return '请输入数字'
  if (field.type === 'Boolean' && !['true', 'false'].includes(text)) return '请选择 true 或 false'
  if (field.type === 'Enum' && !field.enum?.includes(text)) return `枚举值“${text}”已失效`
  if (field.type === 'Date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return '请选择有效日期'
  return null
}

function CellEditor({ value, field, fields, kind, disabled, open, onOpen, onChange, onEnter }: {
  value: string | ConditionCell
  field?: BomField
  fields: BomField[]
  kind: CellKind
  disabled?: boolean
  open: boolean
  onOpen: () => void
  onChange: (value: ConditionCell | string) => void
  onEnter: () => void
}) {
  const conditionValue = kind === 'conditions' ? value as ConditionCell : ''
  const fieldMode = kind === 'conditions' && isFieldCell(conditionValue)
  const literalValue = typeof value === 'string' ? value : ''
  const error = kind === 'conditions' ? conditionError(conditionValue, field, fields) : actionError(literalValue, field)
  const base = `h-8 w-full border px-2 font-mono text-[11px] outline-none ${error ? 'border-[#c62828] bg-[#fff1f1]' : literalValue ? 'border-transparent bg-white focus:border-brand-primary' : 'border-transparent bg-[#f7f7f7] text-ink-3 focus:border-brand-primary focus:bg-white'}`
  if (fieldMode) {
    const candidates = fields.filter(candidate => candidate.direction === 'input' && candidate.type === field?.type && candidate.key !== field?.key)
    return <div className="flex min-w-48 gap-1"><select className="h-8 w-[58px] border border-ink-border bg-[#fafafa] px-1 text-[9px]" disabled={disabled} value="field" onChange={() => onChange('')} aria-label="比较值来源"><option value="literal">固定值</option><option value="field">业务字段</option></select><select className={`${base} min-w-28`} disabled={disabled} value={conditionValue.valueField} onChange={event => onChange({ valueSource: 'field', valueField: event.target.value })} title={error || '同类型输入字段'}>{candidates.length === 0 && <option value="">无同类型字段</option>}{candidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.factLabel} · {candidate.label}</option>)}</select></div>
  }
  const source = kind === 'conditions' ? <select className="h-8 w-[58px] shrink-0 border border-ink-border bg-[#fafafa] px-1 text-[9px]" disabled={disabled} value="literal" onChange={event => {
    if (event.target.value === 'field') {
      const first = fields.find(candidate => candidate.direction === 'input' && candidate.type === field?.type && candidate.key !== field?.key)
      onChange({ valueSource: 'field', valueField: first?.key || '' })
    }
  }} aria-label="比较值来源"><option value="literal">固定值</option><option value="field">业务字段</option></select> : null
  if (field?.type === 'Enum') {
    const selected = literalValue.split(/[,，]/).map(item => item.trim()).filter(Boolean)
    const options = field.enum || []
    const stale = selected.filter(item => !options.includes(item))
    const removeValue = (item: string) => onChange(selected.filter(existing => existing !== item).join(','))
    return <div className="flex gap-1">{source}<div className="relative min-w-28 flex-1"><button type="button" className={`${base} truncate text-left`} disabled={disabled} onClick={onOpen} title={error || (literalValue || '留空 = 通配')}>{literalValue || (kind === 'conditions' ? '任意' : '请选择')}</button>{open && <div className="absolute left-0 top-full z-30 mt-1 min-w-full border border-ink-border bg-white p-1 shadow-lg">
      {literalValue && <button type="button" className="mb-1 flex h-7 w-full items-center px-2 text-left text-[11px] text-ink-3 hover:bg-ink-bg" onClick={() => onChange('')}>清空当前值</button>}
      {stale.length > 0 && <div className="mb-1 border border-[#ef9a9a] bg-[#fff5f5] p-1">
        <div className="px-1 pb-1 text-[10px] text-[#c62828]">已失效枚举值，可单独删除</div>
        {stale.map(item => <button key={item} type="button" className="flex h-7 w-full items-center justify-between gap-3 px-2 text-left font-mono text-[11px] text-[#c62828] hover:bg-[#ffecec]" onClick={() => removeValue(item)}><span className="truncate">{item}</span><span aria-hidden="true">x</span></button>)}
      </div>}
      {options.map(option => <label key={option} className="flex h-7 items-center gap-2 whitespace-nowrap px-2 hover:bg-ink-bg"><input type={kind === 'conditions' ? 'checkbox' : 'radio'} checked={selected.includes(option)} onChange={() => {
      if (kind === 'actions') { onChange(option); onOpen(); return }
      const next = selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option]
      onChange(next.join(','))
      }} />{option}</label>)}</div>}</div></div>
  }
  if (field?.type === 'Boolean') return <div className="flex gap-1">{source}<select className={base} disabled={disabled} value={literalValue} onChange={event => onChange(event.target.value)} title={error || undefined}><option value="">{kind === 'conditions' ? '任意' : '请选择'}</option><option value="true">true</option><option value="false">false</option></select></div>
  return <div className="flex gap-1">{source}<input className={base} disabled={disabled} type={field?.type === 'Date' ? 'date' : 'text'} value={literalValue} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onEnter() } }} placeholder={kind === 'conditions' ? '任意' : '输入结果'} title={error || (!literalValue && kind === 'conditions' ? '留空 = 通配' : undefined)} aria-invalid={Boolean(error)} /></div>
}

export default function EditableDecisionTable({ detail, fields, projectVariables, busy, onSave, onCompile, onSubmit, onAnalyze }: EditableDecisionTableProps) {
  const source = detail.draft as DecisionTableDraft
  const [draft, setDraft] = useState<DecisionTableDraft>(() => structuredClone(source))
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [analysis, setAnalysis] = useState<DecisionTableAnalysis>({ error: null, warnings: detail.validationWarnings || [], drl: detail.content || null })
  const [addKind, setAddKind] = useState<CellKind | null>(null)
  const [pendingColumnIds, setPendingColumnIds] = useState<string[]>([])
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number; column: ColumnView } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; row: number } | null>(null)
  const [enumCell, setEnumCell] = useState<string | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const analyzeRef = useRef(onAnalyze)
  const analysisSequence = useRef(0)
  const fieldMap = useMemo(() => new Map(fields.map(field => [field.key, field])), [fields])
  const fieldForColumn = (column: { field: string; fieldSource?: 'bom' | 'variable' }, direction: 'input' | 'output') => {
    if (column.fieldSource === 'variable') {
      const variable = projectVariables.find(candidate => candidate.name === column.field)
      return variable ? variableAsField(variable, direction) : undefined
    }
    return fieldMap.get(column.field)
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(source)
  const columns: ColumnView[] = [
    ...draft.conditions.map((column, index) => ({ id: `condition:${column.fieldSource || 'bom'}:${column.field}`, kind: 'conditions' as const, index, fieldKey: column.field, field: fieldForColumn(column, 'input'), fieldSource: column.fieldSource || 'bom' })),
    ...draft.actions.map((column, index) => ({ id: `action:${column.fieldSource || 'bom'}:${column.field}`, kind: 'actions' as const, index, fieldKey: column.field, field: fieldForColumn(column, 'output'), fieldSource: column.fieldSource || 'bom' })),
  ]
  const columnGroups = columns.reduce<Array<{ key: string; label: string; kind: CellKind; count: number }>>((groups, column) => {
    const factKey = column.fieldSource === 'variable' ? 'RuleProject' : column.field?.factName || `missing:${column.id}`
    const key = `${column.kind}:${factKey}`
    const previous = groups[groups.length - 1]
    if (previous?.key === key) previous.count += 1
    else groups.push({ key, label: column.field?.factLabel || '失效字段', kind: column.kind, count: 1 })
    return groups
  }, [])
  const usedFields = new Set(columns.map(column => `${column.fieldSource}:${column.fieldKey}`))
  const availableFields: ColumnOption[] = [
    ...fields.filter(field => field.direction === (addKind === 'conditions' ? 'input' : 'output')).map(field => ({ field, fieldSource: 'bom' as const })),
    ...projectVariables.map(variable => ({ field: variableAsField(variable, addKind === 'conditions' ? 'input' : 'output'), fieldSource: 'variable' as const })),
  ].filter(option => !usedFields.has(`${option.fieldSource}:${option.field.key}`))
  const availableColumnOptions = availableFields.map(option => ({ id: `${option.fieldSource}:${option.field.key}`, option }))
  const pickerOptions: BomFieldPickerOption[] = availableColumnOptions.map(({ id, option }) => ({ id, field: option.field, sourceLabel: option.fieldSource === 'variable' ? 'Rule Project' : undefined }))
  const cellIssues = draft.rows.flatMap((row, rowIndex) => [
    ...row.conditions.map((value, index) => ({ row: rowIndex, kind: 'conditions' as const, index, error: conditionError(value, fieldForColumn(draft.conditions[index] || { field: '' }, 'input'), fields) })),
    ...row.actions.map((value, index) => ({ row: rowIndex, kind: 'actions' as const, index, error: actionError(value, fieldForColumn(draft.actions[index] || { field: '' }, 'output')) })),
  ]).filter(issue => issue.error)
  const invalid = cellIssues.length > 0 || Boolean(analysis.error) || columns.some(column => !column.field)
  const wildcardRows = draft.rows.filter(row => row.enabled && !row.isDefault && row.conditions.every(value => typeof value === 'string' && !value.trim())).length

  useEffect(() => { analyzeRef.current = onAnalyze }, [onAnalyze])
  useEffect(() => {
    setDraft(structuredClone(source))
    setNotice(null)
    setAnalysis({ error: null, warnings: detail.validationWarnings || [], drl: detail.content || null })
  }, [detail.id, detail.revision])
  useEffect(() => {
    const sequence = ++analysisSequence.current
    const timer = window.setTimeout(() => {
      void analyzeRef.current(draft).then(result => { if (sequence === analysisSequence.current) setAnalysis(result) }).catch(error => {
        if (sequence === analysisSequence.current) setAnalysis({ error: error instanceof Error ? error.message : '分析失败', warnings: [], drl: null })
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [draft])

  const run = async (action: () => Promise<unknown>, success: string) => {
    setNotice(null)
    try { await action(); setNotice({ error: false, text: success }) }
    catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : '操作失败' }) }
  }
  const saveDraft = () => {
    if (wildcardRows > 0 && !window.confirm(`有 ${wildcardRows} 个启用行的条件全部为空，将匹配任意输入。确认仍要保存吗？`)) return
    void run(() => onSave(draft), '草稿已保存')
  }
  const updateCell = (rowIndex: number, kind: CellKind, columnIndex: number, value: ConditionCell | string) => setDraft(current => ({
    ...current,
    rows: current.rows.map((row, position) => position !== rowIndex ? row : { ...row, [kind]: row[kind].map((cell, index) => index === columnIndex ? value : cell) }),
  }))
  const blankRow = (): DecisionTableRow => ({ enabled: true, priority: 0, conditions: draft.conditions.map(() => ''), actions: draft.actions.map(() => '') })
  const insertRow = (index: number, row: DecisionTableRow = blankRow()) => setDraft(current => ({ ...current, rows: [...current.rows.slice(0, index), row, ...current.rows.slice(index)] }))
  const removeRow = (index: number) => setDraft(current => ({ ...current, rows: current.rows.filter((_, position) => position !== index) }))
  const openAddColumns = (kind: CellKind) => {
    setPendingColumnIds([])
    setAddKind(kind)
  }
  const addColumns = () => {
    if (!addKind || !pendingColumnIds.length) return
    const selectedOptions = pendingColumnIds.map(id => availableColumnOptions.find(entry => entry.id === id)?.option).filter((option): option is ColumnOption => Boolean(option))
    if (!selectedOptions.length) return
    setDraft(current => ({
      ...current,
      conditions: addKind === 'conditions' ? [...current.conditions, ...selectedOptions.map(option => ({ field: option.field.key, fieldSource: option.fieldSource, operator: operatorsFor(option.field)[0] || '==' }))] : current.conditions,
      actions: addKind === 'actions' ? [...current.actions, ...selectedOptions.map(option => ({ field: option.field.key, fieldSource: option.fieldSource }))] : current.actions,
      rows: current.rows.map(row => ({ ...row, [addKind]: [...row[addKind], ...selectedOptions.map(() => '')] })),
    }))
    setAddKind(null)
    setPendingColumnIds([])
  }
  const removeColumn = (column: ColumnView) => {
    if ((column.kind === 'conditions' ? draft.conditions.length : draft.actions.length) <= 1) return
    setDraft(current => ({
      ...current,
      [column.kind]: current[column.kind].filter((_, index) => index !== column.index),
      rows: current.rows.map(row => ({ ...row, [column.kind]: row[column.kind].filter((_, index) => index !== column.index) })),
    }))
    setColumnMenu(null)
  }
  const focusNextRow = (row: number, kind: CellKind, column: number) => {
    const next = document.querySelector<HTMLElement>(`[data-cell="${row + 1}:${kind}:${column}"] input, [data-cell="${row + 1}:${kind}:${column}"] select, [data-cell="${row + 1}:${kind}:${column}"] button`)
    next?.focus()
  }
  const warningRows = new Set(analysis.warnings.flatMap(warning => [...warning.matchAll(/第\s*(\d+)\s*行/g)].map(match => Number(match[1]) - 1)))
  const warningsForRow = (row: number) => analysis.warnings.filter(warning => [...warning.matchAll(/第\s*(\d+)\s*行/g)].some(match => Number(match[1]) - 1 === row))

  const exportTable = (format: 'csv' | 'xlsx') => {
    const sheet = utils.aoa_to_sheet(tableAoA(draft))
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, sheet, 'decision-table')
    writeFile(workbook, `${draft.name || 'decision-table'}.${format}`, { bookType: format })
  }
  const handleImportFile = async (file: File) => {
    setNotice(null)
    try {
      const workbook = file.name.toLowerCase().endsWith('.csv')
        ? read(await file.text(), { type: 'string', raw: true })
        : read(await file.arrayBuffer(), { type: 'array', raw: true })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = parseImportedRows(utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' }), draft)
      if (rows.length === 0) throw new Error('导入文件没有可用决策行')
      if (rows.some(row => !Number.isInteger(row.priority))) throw new Error('导入文件包含无效优先级')
      setImportPreview(buildImportPreview(file.name, rows, draft.rows))
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : '导入失败' })
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }
  const applyImportPreview = () => {
    if (!importPreview) return
    setDraft(current => ({ ...current, rows: importPreview.rows }))
    setNotice({ error: false, text: `已应用 ${importPreview.filename}，请保存草稿` })
    setImportPreview(null)
  }

  return (
    <section className="relative flex h-full min-w-[680px] flex-1 flex-col overflow-hidden bg-white" aria-label="可编辑决策表" onClick={() => { setColumnMenu(null); setRowMenu(null) }}>
      <div className="flex min-h-[42px] shrink-0 items-center gap-2 border-b border-ink-border bg-[#fafafa] px-3">
        <span className="text-[11px] text-ink-3">修订 r{detail.revision}</span>
        <span className={`rounded-[2px] px-1.5 py-px text-[10px] ${detail.status === 'published' ? 'bg-[#e8f5e9] text-env-production' : detail.status === 'rejected' ? 'bg-[#fff1f1] text-[#c62828]' : 'bg-[#fff3e0] text-env-staging'}`}>{detail.status === 'published' ? '已发布' : detail.status === 'rejected' ? '已驳回' : '草稿'}</span>
        {notice && <span className={`ml-auto max-w-[260px] truncate text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span>}
        <input ref={fileInputRef} className="hidden" type="file" accept=".csv,.xlsx" onChange={event => { const file = event.target.files?.[0]; if (file) void handleImportFile(file) }} />
        <button className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy} onClick={() => fileInputRef.current?.click()}><Upload size={13} />导入</button>
        <button className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg" onClick={() => exportTable('csv')}><Download size={13} />CSV</button>
        <button className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg" onClick={() => exportTable('xlsx')}><FileSpreadsheet size={13} />XLSX</button>
        <button className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy || !dirty || invalid} onClick={saveDraft} title={invalid ? cellIssues[0]?.error || analysis.error || '存在失效列' : '保存结构化决策表'}><Save size={13} />保存</button>
        <button className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy || invalid} onClick={() => run(() => onCompile(draft), 'Drools 校验通过')}><CheckCircle2 size={13} />编译</button>
        <button className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-brand-primary bg-brand-primary px-2 text-[11px] text-white hover:bg-brand-primary-d disabled:opacity-50" disabled={busy || dirty || invalid} onClick={() => run(onSubmit, '已提交审核')} title={dirty ? '请先保存草稿' : invalid ? '修复问题后才能提交' : '编译并提交当前草稿审核'}><Rocket size={13} />提交审核</button>
      </div>
      <BomVersionNotice detail={detail} />

      <div className="grid shrink-0 grid-cols-[minmax(220px,1fr)_140px_90px_150px] gap-3 border-b border-ink-border px-4 py-3">
        <label className="text-[10px] font-semibold text-ink-3">决策表名称<input className="control-input mt-1 h-8 text-xs" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="text-[10px] font-semibold text-ink-3">规则包<input className="control-input mt-1 h-8 text-xs" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} /></label>
        <label className="text-[10px] font-semibold text-ink-3">优先级<input className="control-input mt-1 h-8 text-xs" type="number" value={draft.priority} onChange={event => setDraft({ ...draft, priority: Number(event.target.value) })} /></label>
        <label className="text-[10px] font-semibold text-ink-3">命中策略<select className="control-input mt-1 h-8 text-xs" value={draft.hitPolicy === 'ALL' ? 'COLLECT' : (draft.hitPolicy || 'COLLECT')} onChange={event => setDraft({ ...draft, hitPolicy: event.target.value as DecisionTableDraft['hitPolicy'] })}><option value="FIRST">FIRST 首条命中</option><option value="COLLECT">COLLECT 收集命中</option><option value="PRIORITY">PRIORITY 优先命中</option></select></label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-2 flex items-center gap-2"><h2 className="text-xs font-semibold">决策行</h2><span className="inline-flex items-center gap-1 text-[10px] text-ink-3" title="空条件不会生成约束，会匹配该字段的任意值"><Info size={12} />空条件 = 不参与匹配（通配）；支持 &lt;0.8、[20,25)、20..25</span><button className="ml-auto inline-flex h-7 items-center gap-1 border border-ink-border px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={() => openAddColumns('conditions')}><Plus size={13} />条件列</button><button className="inline-flex h-7 items-center gap-1 border border-ink-border px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={() => openAddColumns('actions')}><Plus size={13} />动作列</button><button className="inline-flex h-7 items-center gap-1 px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={() => insertRow(draft.rows.length)}><Plus size={13} />添加行</button></div>
        <div className="min-w-[860px] overflow-visible border border-ink-border">
          <table className="w-full border-collapse text-xs">
            <thead className="bg-[#f0f0f0] text-left text-[11px]">
              <tr><th rowSpan={2} className="sticky left-0 z-20 w-12 border-r border-ink-border bg-[#f0f0f0] px-2 text-center">行</th><th rowSpan={2} className="w-12 border-r border-ink-border px-2 text-center">启用</th>{columnGroups.map(group => <th key={group.key} colSpan={group.count} className={`border-r border-ink-border px-2 py-1 text-center font-medium ${group.kind === 'conditions' ? 'text-brand-primary' : 'text-env-production'}`}>{group.kind === 'conditions' ? '条件' : '动作'} · {group.label}</th>)}<th rowSpan={2} className="w-12 text-center">操作</th></tr>
              <tr>{columns.map(column => <th key={column.id} className={`relative min-w-36 border-r border-t border-ink-border px-2 py-1 ${column.field ? '' : 'bg-[#fff1f1] text-[#c62828]'}`} onContextMenu={event => { event.preventDefault(); setColumnMenu({ x: event.clientX, y: event.clientY, column }) }}><div className="flex items-center gap-1"><button type="button" className="min-w-0 flex-1 truncate border-b border-dashed border-brand-primary text-left font-medium text-brand-primary" title={column.field ? (column.fieldSource === 'variable' ? '来自 Rule Project 变量' : '来自 BOM') : '引用已删除'}>{column.field?.label || column.fieldKey}</button><button type="button" className="inline-flex size-6 shrink-0 items-center justify-center text-ink-3 hover:bg-white" onClick={event => { event.stopPropagation(); setColumnMenu({ x: event.clientX, y: event.clientY, column }) }} title="列菜单"><MoreVertical size={12} /></button></div>{column.kind === 'conditions' && <select className="mt-1 h-5 w-full border-0 bg-transparent text-[9px] font-normal text-ink-3 outline-none" value={draft.conditions[column.index].operator} onChange={event => setDraft(current => ({ ...current, conditions: current.conditions.map((item, index) => index === column.index ? { ...item, operator: event.target.value } : item) }))}>{operatorsFor(column.field).map(operator => <option key={operator} value={operator}>无前缀时默认 {operator}</option>)}</select>}</th>)}</tr>
            </thead>
            <tbody>
              {draft.rows.map((row, rowIndex) => {
                const isDefault = row.isDefault === true
                return <tr className="border-t border-ink-border" key={rowIndex} title={rowConditionSummary(row, draft, fieldMap)}>
                  <td className="sticky left-0 z-10 border-r border-ink-border bg-[#fafafa] px-1 text-center font-mono" onContextMenu={event => { event.preventDefault(); setRowMenu({ x: event.clientX, y: event.clientY, row: rowIndex }) }}>{warningRows.has(rowIndex) && <span title={warningsForRow(rowIndex).join('\n')}><AlertTriangle size={12} className="mr-1 inline text-[#b26a00]" /></span>}{rowIndex + 1}{isDefault && <span className="ml-1 text-[9px] text-brand-primary">默认</span>}</td>
                  <td className="border-r border-ink-border px-2 text-center"><input type="checkbox" checked={row.enabled} onChange={event => setDraft(current => ({ ...current, rows: current.rows.map((item, index) => index === rowIndex ? { ...item, enabled: event.target.checked } : item) }))} /></td>
                  {columns.map(column => <td data-cell={`${rowIndex}:${column.kind}:${column.index}`} className={`border-r border-ink-border p-1 ${!column.field ? 'bg-[#fff1f1]' : ''}`} key={`${column.id}:${rowIndex}`}><CellEditor value={row[column.kind][column.index] || ''} field={column.field} fields={fields} kind={column.kind} disabled={isDefault && column.kind === 'conditions'} open={enumCell === `${rowIndex}:${column.id}`} onOpen={() => setEnumCell(current => current === `${rowIndex}:${column.id}` ? null : `${rowIndex}:${column.id}`)} onChange={value => updateCell(rowIndex, column.kind, column.index, value)} onEnter={() => focusNextRow(rowIndex, column.kind, column.index)} /></td>)}
                  <td className="text-center"><button className="inline-flex size-7 items-center justify-center text-ink-3 hover:bg-ink-bg" onClick={event => { event.stopPropagation(); setRowMenu({ x: event.clientX, y: event.clientY, row: rowIndex }) }} title="行操作"><MoreVertical size={13} /></button></td>
                </tr>
              })}
            </tbody>
          </table>
        </div>

        {(analysis.error || analysis.warnings.length > 0 || cellIssues.length > 0) && <section className={`mt-3 border p-3 text-[11px] ${analysis.error || cellIssues.length ? 'border-[#ef9a9a] bg-[#fff5f5]' : 'border-[#f3c65f] bg-[#fff8e1]'}`}><h3 className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle size={13} />决策表检查</h3>{cellIssues.slice(0, 5).map(issue => <p key={`${issue.row}:${issue.kind}:${issue.index}`} className="py-0.5 text-[#c62828]"><b>错误</b> · 第 {issue.row + 1} 行：{issue.error}</p>)}{analysis.error && <p className="py-0.5 text-[#c62828]"><b>错误</b> · {analysis.error}</p>}{analysis.warnings.map(warning => <p key={warning} className={`py-0.5 ${warningLevel(warning) === 'warn' ? 'text-[#8a5a00]' : 'text-ink-2'}`}><b>{warningLevel(warning) === 'warn' ? '警告' : '提示'}</b> · {warning}</p>)}</section>}
        <details className="mt-3 border border-ink-border bg-white"><summary className="flex cursor-pointer items-center gap-1 px-3 py-2 text-[11px] font-medium"><Code2 size={13} />高级 · 查看 DRL</summary><pre className="max-h-72 overflow-auto border-t border-ink-border bg-[#fafafa] p-3 font-mono text-[11px] leading-5">{analysis.drl || analysis.error || '正在生成 DRL...'}</pre></details>
        <label className="mt-3 block text-[10px] font-semibold text-ink-3">业务说明<textarea className="mt-1 min-h-16 w-full resize-y border border-ink-border px-[10px] py-2 text-xs font-normal text-ink-1 outline-none focus:border-brand-primary" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
      </div>

      {importPreview && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={event => { if (event.target === event.currentTarget) setImportPreview(null) }}><section className="w-full max-w-lg border border-ink-border bg-white shadow-xl" role="dialog" aria-modal="true"><header className="border-b border-ink-border bg-[#fafafa] px-4 py-3 text-sm font-semibold">导入差异预览 · {importPreview.filename}</header><div className="space-y-3 p-4 text-xs"><div className="grid grid-cols-4 gap-2"><b className="border border-ink-border p-2 text-center text-env-production">新增 {importPreview.added}</b><b className="border border-ink-border p-2 text-center text-[#b26a00]">更新 {importPreview.changed}</b><b className="border border-ink-border p-2 text-center text-[#c62828]">删除 {importPreview.removed}</b><b className="border border-ink-border p-2 text-center text-ink-3">不变 {importPreview.unchanged}</b></div>{importPreview.details.length > 0 ? <ul className="max-h-44 overflow-auto border border-ink-border bg-[#fafafa] p-2 font-mono text-[11px]">{importPreview.details.map(item => <li key={item} className="py-0.5">{item}</li>)}</ul> : <p className="border border-ink-border bg-[#fafafa] p-3 text-ink-3">没有检测到行级差异。</p>}<p className="text-[11px] text-ink-3">导入只替换决策行，条件列和动作列必须与当前表一致；应用后仍需点击保存。</p></div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setImportPreview(null)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white" onClick={applyImportPreview}>应用导入</button></footer></section></div>}
      {addKind && <Modal title={`添加${addKind === 'conditions' ? '条件' : '动作'}列`} width="max-w-4xl" onClose={() => { setAddKind(null); setPendingColumnIds([]) }}><div className="p-4"><BomFieldPicker options={pickerOptions} selectedIds={pendingColumnIds} onChange={setPendingColumnIds} emptyText="没有可添加的 BOM 字段或 Rule Project 变量" /></div><footer className="flex items-center justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><span className="mr-auto text-[10px] text-ink-3">已选择 {pendingColumnIds.length} 列</span><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => { setAddKind(null); setPendingColumnIds([]) }}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={!pendingColumnIds.length} onClick={addColumns}>添加所选列</button></footer></Modal>}
      {columnMenu && <div className="fixed z-50 min-w-36 border border-ink-border bg-white py-1 text-[11px] shadow-lg" style={{ left: columnMenu.x, top: columnMenu.y }} onClick={event => event.stopPropagation()}><button type="button" className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg disabled:opacity-40" disabled={(columnMenu.column.kind === 'conditions' ? draft.conditions.length : draft.actions.length) <= 1} onClick={() => removeColumn(columnMenu.column)}><Trash2 size={12} />删除列</button></div>}
      {rowMenu && <div className="fixed z-50 min-w-40 border border-ink-border bg-white py-1 text-[11px] shadow-lg" style={{ left: rowMenu.x, top: rowMenu.y }} onClick={event => event.stopPropagation()}><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { insertRow(rowMenu.row); setRowMenu(null) }}><Plus size={12} />在上方插入</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { insertRow(rowMenu.row + 1); setRowMenu(null) }}><Plus size={12} />在下方插入</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { const duplicate = { ...structuredClone(draft.rows[rowMenu.row]), isDefault: false }; insertRow(rowMenu.row + 1, duplicate); setRowMenu(null) }}><Copy size={12} />复制行</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { const unset = draft.rows[rowMenu.row]?.isDefault === true; setDraft(current => ({ ...current, rows: current.rows.map((row, index) => ({ ...row, isDefault: unset ? false : index === rowMenu.row, conditions: !unset && index === rowMenu.row ? row.conditions.map(() => '') : row.conditions })) })); setRowMenu(null) }}>{draft.rows[rowMenu.row]?.isDefault ? '取消默认行' : '设为默认行'}</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left text-[#c62828] hover:bg-[#fff1f1] disabled:opacity-40" disabled={draft.rows.length === 1} onClick={() => { removeRow(rowMenu.row); setRowMenu(null) }}><Trash2 size={12} />删除行</button></div>}
    </section>
  )
}
