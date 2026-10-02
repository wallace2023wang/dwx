import { ChevronDown, ChevronUp, Code2, LockKeyhole, Plus, Trash2 } from 'lucide-react'
import type { BomField, RuleActionDraft, RuleConditionDraft, RuleDraft, RuleFieldConditionDraft, RulePatternConditionDraft, RuleRawConditionDraft } from '../../types'
import { BOM_TYPE_CAPABILITIES, defaultOperatorForType, operatorsForType, supportsFieldValueForType } from '../../domain/bomTypes'

interface BalRuleViewProps {
  draft: RuleDraft
  fields: BomField[]
  editable?: boolean
  onChange?: (draft: RuleDraft) => void
  onOpenBom?: (fieldKey: string) => void
}

interface FactOption {
  name: string
  label: string
  fields: BomField[]
}

const quantifiers = [
  { value: 'one', label: '一个' },
  { value: 'exists', label: '存在' },
  { value: 'all', label: '所有' },
  { value: 'none', label: '没有' },
] as const

function isNumberField(field: BomField | undefined) {
  return Boolean(field && BOM_TYPE_CAPABILITIES[field.type].control === 'number')
}

function isBooleanField(field: BomField | undefined) {
  return Boolean(field && field.type === 'Boolean')
}

function isDateField(field: BomField | undefined) {
  return Boolean(field && field.type === 'Date')
}

function isListField(field: BomField | undefined) {
  return Boolean(field && field.type === 'List<String>')
}

function enumValues(field: BomField | undefined) {
  if (!field) return []
  if (field.enum?.length) return field.enum
  const match = field.type.match(/enum\s*\{([^}]+)\}/i)
  return match ? match[1].split(',').map(value => value.trim()).filter(Boolean) : []
}

function operatorsFor(field: BomField | undefined) {
  return operatorsForType(field?.type)
}

function factsFor(fields: BomField[], direction: BomField['direction']): FactOption[] {
  const facts = new Map<string, FactOption>()
  for (const field of fields.filter(candidate => candidate.direction === direction)) {
    const name = field.factName || (direction === 'input' ? 'Input' : 'Output')
    const label = field.factLabel || (direction === 'input' ? '输入事实' : '输出事实')
    const fact = facts.get(name) || { name, label, fields: [] }
    fact.fields.push(field)
    facts.set(name, fact)
  }
  return [...facts.values()]
}

function selectedFact(facts: FactOption[], factType: string | undefined, fieldKey: string) {
  return facts.find(fact => fact.name === factType && fact.fields.some(field => field.key === fieldKey))
    || facts.find(fact => fact.fields.some(field => field.key === fieldKey))
    || facts.find(fact => fact.name === factType)
}

function selectedField(facts: FactOption[], fieldKey: string) {
  return facts.flatMap(fact => fact.fields).find(field => field.key === fieldKey)
}

function displayValue(value: string, field: BomField | undefined) {
  if (!value) return '未设置'
  if (/^(['"]).*\1$/.test(value) || ['true', 'false', 'null'].includes(value) || Number.isFinite(Number(value))) return value
  return isDateField(field) ? value : JSON.stringify(value)
}

function valueError(value: string, field: BomField | undefined) {
  if (!field) return '引用的 BOM 字段不存在'
  if (!value.trim()) return '请填写值'
  if (isNumberField(field) && !Number.isFinite(Number(value))) return '请输入有效数字'
  if (isBooleanField(field) && !['true', 'false'].includes(value)) return '请选择 true 或 false'
  if (isDateField(field)) {
    const parsed = new Date(`${value}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) return '请选择有效日期'
  }
  const values = enumValues(field)
  if (values.length && !values.includes(value)) return '该枚举值已不在 BOM 中'
  return null
}

function usesFieldValue(condition: RuleFieldConditionDraft) {
  return condition.valueSource === 'field'
}

function compatibleValueFields(facts: FactOption[], field: BomField | undefined) {
  if (!field) return []
  return facts.flatMap(fact => fact.fields
    .filter(candidate => candidate.key !== field.key && candidate.type === field.type)
    .map(candidate => ({ fact, field: candidate })))
}

function fieldValueError(condition: RuleFieldConditionDraft, field: BomField | undefined, facts: FactOption[]) {
  if (!field) return '引用的 BOM 字段不存在'
  if (!supportsFieldValueForType(field.type, condition.operator)) return `“${operatorsFor(field).find(option => option.value === condition.operator)?.label || condition.operator}”只支持固定值`
  if (!condition.valueField) return '请选择用于比较的业务字段'
  if (condition.valueField === field.key) return '不能与同一业务字段比较'
  const rightField = selectedField(facts, condition.valueField)
  if (!rightField || rightField.direction !== 'input') return '用于比较的业务字段不存在或不是输入字段'
  if (rightField.type !== field.type) return `用于比较的字段必须是 ${field.type} 类型`
  return null
}

function literalConditionError(condition: RuleFieldConditionDraft, field: BomField | undefined) {
  if (condition.operator === 'between') {
    const lowerError = valueError(condition.value, field)
    const upperError = valueError(condition.valueEnd || '', field)
    if (lowerError || upperError) return lowerError || upperError
    if (isDateField(field) ? condition.value > (condition.valueEnd || '') : Number(condition.value) > Number(condition.valueEnd)) return '区间下界不能大于上界'
    return null
  }
  if (condition.operator === 'in' || condition.operator === 'not in') {
    const values = condition.values || []
    if (!values.length) return '请至少选择一个枚举值'
    if (new Set(values).size !== values.length || values.some(value => !enumValues(field).includes(value))) return '枚举条件包含失效值'
    return null
  }
  if (condition.operator === 'matches') {
    const error = valueError(condition.value, field)
    if (error) return error
    try { new RegExp(condition.value) } catch { return '请输入有效正则表达式' }
    return null
  }
  if (condition.operator === 'size >' || condition.operator === 'size <') {
    if (!/^\d+$/.test(condition.value) || Number(condition.value) > 1000000) return '长度必须是 0–1000000 的整数'
    return null
  }
  return valueError(condition.value, field)
}

function conditionValueError(condition: RuleFieldConditionDraft, field: BomField | undefined, facts: FactOption[]) {
  return usesFieldValue(condition)
    ? fieldValueError(condition, field, facts)
    : literalConditionError(condition, field)
}

function defaultLiteralValue(field: BomField | undefined, operator = defaultOperatorForType(field?.type)) {
  if (operator === 'size >' || operator === 'size <') return '0'
  return isBooleanField(field) ? 'true' : enumValues(field)[0] || ''
}

function literalDefaults(field: BomField | undefined, operator: string) {
  return {
    value: defaultLiteralValue(field, operator),
    valueEnd: operator === 'between' ? '' : undefined,
    values: operator === 'in' || operator === 'not in' ? enumValues(field).slice(0, 1) : undefined,
  }
}

function displayConditionValue(condition: RuleFieldConditionDraft, field: BomField | undefined) {
  if (condition.operator === 'between') return `${displayValue(condition.value, field)} 至 ${displayValue(condition.valueEnd || '', field)}`
  if (condition.operator === 'in' || condition.operator === 'not in') return `[${(condition.values || []).map(value => displayValue(value, field)).join(', ')}]`
  return displayValue(condition.value, field)
}

function isAdvancedCondition(condition: RuleConditionDraft): condition is RuleRawConditionDraft | RulePatternConditionDraft {
  return Boolean(condition.raw || condition.pattern)
}

function advancedExpression(condition: RuleRawConditionDraft | RulePatternConditionDraft) {
  return condition.raw || `${condition.pattern} ${condition.condition}`
}

export function validateBalDraft(draft: RuleDraft, fields: BomField[]) {
  const issues: string[] = []
  const actionKeys = new Set<string>()
  for (const [index, condition] of draft.conditions.entries()) {
    if (isAdvancedCondition(condition)) continue
    const field = fields.find(candidate => candidate.key === condition.field && candidate.direction === 'input')
    if (!field) issues.push(`第 ${index + 1} 个条件引用的 BOM 字段不存在`)
    else {
      const operator = operatorsFor(field).find(candidate => candidate.value === condition.operator)
      if (!operator) issues.push(`第 ${index + 1} 个条件的比较符不适用于${field.label}`)
      else if (!operator.runtimeSupported) issues.push(`第 ${index + 1} 个条件的“${operator.label}”操作符尚未启用执行支持`)
    }
    const error = conditionValueError(condition, field, factsFor(fields, 'input'))
    if (error) issues.push(`第 ${index + 1} 个条件：${error}`)
  }
  for (const [index, action] of draft.actions.entries()) {
    const field = fields.find(candidate => candidate.key === action.field && candidate.direction === 'output')
    if (!field) issues.push(`第 ${index + 1} 个动作引用的 BOM 字段不存在`)
    const error = valueError(action.value, field)
    if (error) issues.push(`第 ${index + 1} 个动作：${error}`)
    if (actionKeys.has(action.field)) issues.push(`第 ${index + 1} 个动作重复设置了同一字段`)
    actionKeys.add(action.field)
  }
  return [...new Set(issues)]
}

export function normalizeBalDraft(draft: RuleDraft, fields: BomField[]): RuleDraft {
  const inputFacts = factsFor(fields, 'input')
  const outputFacts = factsFor(fields, 'output')
  return {
    ...draft,
    conditions: draft.conditions.map((condition, index) => {
      if (isAdvancedCondition(condition)) return condition
      return {
        ...condition,
        factType: selectedFact(inputFacts, condition.factType, condition.field)?.name || condition.factType,
        quantifier: condition.quantifier || 'one',
        connector: index === 0 ? 'and' : condition.connector || 'and',
      }
    }),
    actions: draft.actions.map(action => {
      const field = selectedField(outputFacts, action.field)
      return {
        ...action,
        factType: selectedFact(outputFacts, action.factType, action.field)?.name || action.factType,
        actionType: action.actionType || (isListField(field) ? 'add' : 'set'),
      }
    }),
  }
}

function moveItem<T>(items: T[], index: number, offset: number) {
  const target = index + offset
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

function TermSelect({ value, label, options, invalid, onChange }: {
  value: string
  label: string
  options: Array<{ value: string; label: string }>
  invalid?: boolean
  onChange: (value: string) => void
}) {
  return (
    <select
      className={`h-8 max-w-[190px] appearance-none border-0 border-b bg-transparent px-1 text-[12px] font-medium outline-none ${invalid ? 'border-solid border-[#c62828] bg-[#ffebee] text-[#c62828]' : 'border-dashed border-brand-primary text-brand-primary focus:bg-brand-primary-l'}`}
      value={value}
      onChange={event => onChange(event.target.value)}
      aria-label={label}
    >
      {invalid && <option value={value}>字段已失效</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

function ValueControl({ value, field, label, placeholder = '输入值', forceNumber = false, onChange }: {
  value: string
  field: BomField | undefined
  label?: string
  placeholder?: string
  forceNumber?: boolean
  onChange: (value: string) => void
}) {
  const error = valueError(value, field)
  const values = enumValues(field)
  const className = `h-8 min-w-[104px] flex-1 rounded-[2px] border px-2 font-mono text-[12px] outline-none ${error ? 'border-[#c62828] bg-[#fff1f1]' : 'border-transparent bg-[#f0f0f0] focus:border-brand-primary focus:bg-white'}`
  if (isBooleanField(field)) {
    return <select className={className} value={value} onChange={event => onChange(event.target.value)} aria-label={label || '布尔值'}><option value="true">true</option><option value="false">false</option></select>
  }
  if (values.length) {
    return <select className={className} value={value} onChange={event => onChange(event.target.value)} aria-label={label || '枚举值'}>{error && <option value={value}>{value}（已失效）</option>}{values.map(option => <option key={option} value={option}>{option}</option>)}</select>
  }
  return (
    <input
      className={className}
      type={forceNumber || isNumberField(field) ? 'number' : isDateField(field) ? 'date' : 'text'}
      min={field?.min ?? undefined}
      max={field?.max ?? undefined}
      step={field && BOM_TYPE_CAPABILITIES[field.type].step ? BOM_TYPE_CAPABILITIES[field.type].step : 'any'}
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={Boolean(error)}
      title={error || undefined}
    />
  )
}

function EnumMultiControl({ condition, field, onChange }: {
  condition: RuleFieldConditionDraft
  field: BomField | undefined
  onChange: (condition: RuleFieldConditionDraft) => void
}) {
  const selected = condition.values || []
  const options = enumValues(field)
  return (
    <details className="group relative min-w-[160px] flex-1">
      <summary className={`flex h-8 cursor-pointer list-none items-center justify-between rounded-[2px] border px-2 text-[12px] outline-none ${selected.length ? 'border-transparent bg-[#f0f0f0] text-ink-1' : 'border-[#c62828] bg-[#fff1f1] text-[#c62828]'}`} aria-label="枚举多选值">
        <span className="truncate">{selected.length ? `已选 ${selected.length} 项：${selected.join('、')}` : '请选择枚举值'}</span><ChevronDown size={13} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 top-9 z-30 max-h-52 min-w-full overflow-auto border border-ink-border bg-white p-1 shadow-lg">
        {options.map(option => (
          <label key={option} className="flex h-8 cursor-pointer items-center gap-2 px-2 text-[12px] hover:bg-ink-bg">
            <input type="checkbox" checked={selected.includes(option)} aria-label={`选择枚举值 ${option}`} onChange={event => onChange({ ...condition, values: event.target.checked ? [...selected, option] : selected.filter(value => value !== option) })} />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </details>
  )
}

function ConditionLiteralControl({ condition, field, onChange }: {
  condition: RuleFieldConditionDraft
  field: BomField | undefined
  onChange: (condition: RuleFieldConditionDraft) => void
}) {
  if (condition.operator === 'between') {
    return (
      <div className="flex min-w-[250px] flex-1 items-center gap-1.5">
        <ValueControl value={condition.value} field={field} label="区间下界" placeholder="下界" onChange={value => onChange({ ...condition, value })} />
        <span className="shrink-0 text-[11px] text-ink-3">至</span>
        <ValueControl value={condition.valueEnd || ''} field={field} label="区间上界" placeholder="上界" onChange={valueEnd => onChange({ ...condition, valueEnd })} />
      </div>
    )
  }
  if (condition.operator === 'in' || condition.operator === 'not in') return <EnumMultiControl condition={condition} field={field} onChange={onChange} />
  if (condition.operator === 'size >' || condition.operator === 'size <') return <ValueControl value={condition.value} field={field} label="列表长度" placeholder="长度" forceNumber onChange={value => onChange({ ...condition, value })} />
  return <ValueControl value={condition.value} field={field} label="条件值" placeholder={condition.operator === 'matches' ? '输入正则表达式' : '输入值'} onChange={value => onChange({ ...condition, value })} />
}

function ValueSourceControl({ value, fieldModeAvailable, disabledReason, onChange }: {
  value: 'literal' | 'field'
  fieldModeAvailable: boolean
  disabledReason?: string
  onChange: (value: 'literal' | 'field') => void
}) {
  return (
    <div className="inline-flex h-8 shrink-0 rounded-[2px] border border-ink-border bg-white p-0.5" role="group" aria-label="比较值来源">
      <button type="button" className={`px-2 text-[11px] ${value === 'literal' ? 'bg-ink-1 font-medium text-white' : 'text-ink-2 hover:bg-ink-bg'}`} aria-pressed={value === 'literal'} onClick={() => onChange('literal')}>固定值</button>
      <button type="button" className={`px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${value === 'field' ? 'bg-brand-primary font-medium text-white' : 'text-ink-2 hover:bg-ink-bg'}`} aria-pressed={value === 'field'} disabled={!fieldModeAvailable} title={fieldModeAvailable ? '选择同类型的输入字段' : disabledReason || '没有可比较的同类型输入字段'} onClick={() => onChange('field')}>业务字段</button>
    </div>
  )
}

function RowActions({ index, count, onMove, onDelete }: {
  index: number
  count: number
  onMove: (offset: number) => void
  onDelete: () => void
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <button type="button" className="inline-flex size-7 items-center justify-center text-ink-3 hover:bg-ink-bg hover:text-ink-1 disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} title="上移"><ChevronUp size={13} /></button>
      <button type="button" className="inline-flex size-7 items-center justify-center text-ink-3 hover:bg-ink-bg hover:text-ink-1 disabled:opacity-30" disabled={index === count - 1} onClick={() => onMove(1)} title="下移"><ChevronDown size={13} /></button>
      <button type="button" className="inline-flex size-7 items-center justify-center text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828] disabled:opacity-30" disabled={count === 1} onClick={onDelete} title="删除"><Trash2 size={13} /></button>
    </div>
  )
}

function ReadonlyTerm({ children, fieldKey, onOpenBom }: { children: string; fieldKey: string; onOpenBom?: (fieldKey: string) => void }) {
  if (!onOpenBom) return <span className="border-b border-dashed border-brand-primary font-medium text-brand-primary">{children}</span>
  return <button type="button" className="border-b border-dashed border-brand-primary font-medium text-brand-primary hover:bg-brand-primary-l" onClick={() => onOpenBom(fieldKey)} title="在 BOM 中查看">{children}</button>
}

function ConditionRow({ condition, index, count, facts, editable, onChange, onMove, onDelete, onOpenBom }: {
  condition: RuleConditionDraft
  index: number
  count: number
  facts: FactOption[]
  editable: boolean
  onChange: (condition: RuleConditionDraft) => void
  onMove: (offset: number) => void
  onDelete: () => void
  onOpenBom?: (fieldKey: string) => void
}) {
  const connector = condition.connector === 'or' ? '或者' : '并且'
  if (isAdvancedCondition(condition)) {
    const quantifier = condition.raw && condition.quantifier && condition.quantifier !== 'one'
      ? quantifiers.find(option => option.value === condition.quantifier)?.label
      : null
    return (
      <div>
        {index > 0 && <div className="mb-1 text-[11px] font-medium text-ink-3">{connector}</div>}
        <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-[3px] border border-[#f3c65f] bg-[#fff8e1] px-3 py-2" aria-label="高级表达式">
          <Code2 size={14} className="shrink-0 text-[#8a5a00]" />
          {quantifier && <span className="text-[11px] font-medium text-[#734d00]">{quantifier}</span>}
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] text-ink-1">{advancedExpression(condition)}</code>
          <span className="rounded-[2px] border border-[#d9aa38] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#734d00]">高级表达式</span>
          <span className="rounded-[2px] border border-ink-border bg-white px-1.5 py-0.5 text-[10px] text-ink-2">{condition.raw ? '内联 DRL' : '独立 DRL'}</span>
          <span className="inline-flex items-center gap-1 text-[10px] text-ink-3" title="高级表达式保持原样，不能在 BAL 编辑器中修改"><LockKeyhole size={11} />只读</span>
        </div>
      </div>
    )
  }

  const fact = selectedFact(facts, condition.factType, condition.field)
  const field = selectedField(facts, condition.field)
  const invalid = !field
  const operator = operatorsFor(field).find(option => option.value === condition.operator)
  const quantifier = quantifiers.find(option => option.value === (condition.quantifier || 'one'))?.label || '一个'
  const fieldValues = compatibleValueFields(facts, field)
  const rightField = usesFieldValue(condition) ? selectedField(facts, condition.valueField || '') : undefined
  const rightFact = rightField ? facts.find(candidate => candidate.fields.some(option => option.key === rightField.key)) : undefined
  const conditionError = conditionValueError(condition, field, facts)

  if (!editable) {
    return (
      <div>
        {index > 0 && <div className="mb-1 text-[11px] font-medium text-ink-3">{connector}</div>}
        <div className={`flex min-h-11 flex-wrap items-center gap-2 rounded-[3px] border px-3 py-2 ${invalid ? 'border-[#c62828] bg-[#fff1f1]' : 'border-ink-border bg-[#fafafa]'}`}>
          <span className="text-ink-3">{quantifier}</span>
          <ReadonlyTerm fieldKey={condition.field} onOpenBom={onOpenBom}>{fact?.label || condition.factType || '未知事实'}</ReadonlyTerm>
          <span className="text-ink-3">的</span>
          <ReadonlyTerm fieldKey={condition.field} onOpenBom={onOpenBom}>{field?.label || condition.field}</ReadonlyTerm>
          <strong className="font-semibold text-ink-1">{operator?.label || condition.operator}</strong>
          {usesFieldValue(condition) ? (
            <>
              <ReadonlyTerm fieldKey={condition.valueField || ''} onOpenBom={onOpenBom}>{rightFact?.label || '未知事实'}</ReadonlyTerm>
              <span className="text-ink-3">的</span>
              <ReadonlyTerm fieldKey={condition.valueField || ''} onOpenBom={onOpenBom}>{rightField?.label || condition.valueField || '未选择字段'}</ReadonlyTerm>
            </>
          ) : (
            <>
              <code className="rounded-[2px] bg-[#f0f0f0] px-2 py-1 font-mono text-[12px] text-ink-1">{displayConditionValue(condition, field)}</code>
              {field?.unit && <span className="text-[11px] text-ink-3">{field.unit}</span>}
            </>
          )}
        </div>
      </div>
    )
  }

  const selectFact = (factName: string) => {
    const nextFact = facts.find(candidate => candidate.name === factName)
    const nextField = nextFact?.fields[0]
    const nextOperator = defaultOperatorForType(nextField?.type)
    const nextValueField = compatibleValueFields(facts, nextField)[0]?.field.key
    const keepFieldValue = usesFieldValue(condition) && supportsFieldValueForType(nextField?.type, nextOperator)
    onChange({ ...condition, factType: factName, field: nextField?.key || '', operator: nextOperator, valueSource: keepFieldValue ? 'field' : 'literal', valueField: keepFieldValue ? nextValueField : undefined, ...(keepFieldValue ? { value: '', valueEnd: undefined, values: undefined } : literalDefaults(nextField, nextOperator)) })
  }
  const selectField = (fieldKey: string) => {
    const nextField = fact?.fields.find(candidate => candidate.key === fieldKey)
    const nextOperator = defaultOperatorForType(nextField?.type)
    const nextValueField = compatibleValueFields(facts, nextField)[0]?.field.key
    const keepFieldValue = usesFieldValue(condition) && supportsFieldValueForType(nextField?.type, nextOperator)
    onChange({ ...condition, field: fieldKey, operator: nextOperator, valueSource: keepFieldValue ? 'field' : 'literal', valueField: keepFieldValue ? nextValueField : undefined, ...(keepFieldValue ? { value: '', valueEnd: undefined, values: undefined } : literalDefaults(nextField, nextOperator)) })
  }
  const selectOperator = (operator: string) => {
    if (usesFieldValue(condition) && supportsFieldValueForType(field?.type, operator)) {
      onChange({ ...condition, operator, value: '', valueEnd: undefined, values: undefined })
      return
    }
    onChange({ ...condition, operator, valueSource: 'literal', valueField: undefined, ...literalDefaults(field, operator) })
  }
  const selectValueSource = (valueSource: 'literal' | 'field') => {
    if (valueSource === 'field') {
      onChange({ ...condition, valueSource, value: '', valueField: fieldValues[0]?.field.key })
      return
    }
    onChange({ ...condition, valueSource, valueField: undefined, ...literalDefaults(field, condition.operator) })
  }

  return (
    <div>
      {index > 0 && (
        <select className="mb-1 h-7 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] font-medium text-ink-3 outline-none focus:border-brand-primary" value={condition.connector || 'and'} onChange={event => onChange({ ...condition, connector: event.target.value as 'and' | 'or' })} aria-label="条件连接词">
          <option value="and">并且</option><option value="or">或者</option>
        </select>
      )}
      <div className={`flex min-h-12 flex-wrap items-center gap-2 rounded-[3px] border px-3 py-2 ${invalid || conditionError ? 'border-[#c62828] bg-[#fffafa]' : 'border-ink-border bg-[#fafafa]'}`}>
        <select className="h-8 rounded-[2px] border border-ink-border bg-white px-1.5 text-[11px] text-ink-2 outline-none focus:border-brand-primary" value={condition.quantifier || 'one'} onChange={event => onChange({ ...condition, quantifier: event.target.value as RuleConditionDraft['quantifier'] })} aria-label="量词">
          {quantifiers.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <TermSelect value={fact?.name || condition.factType || ''} label="事实类型" options={facts.map(option => ({ value: option.name, label: option.label }))} invalid={!fact} onChange={selectFact} />
        <span className="text-ink-3">的</span>
        <TermSelect value={condition.field} label="业务字段" options={(fact?.fields || []).map(option => ({ value: option.key, label: option.label }))} invalid={invalid} onChange={selectField} />
        <select className="h-8 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] font-semibold text-ink-1 outline-none focus:border-brand-primary" value={condition.operator} onChange={event => selectOperator(event.target.value)} aria-label="比较符">
          {operatorsFor(field).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ValueSourceControl value={usesFieldValue(condition) ? 'field' : 'literal'} fieldModeAvailable={fieldValues.length > 0 && supportsFieldValueForType(field?.type, condition.operator)} disabledReason={fieldValues.length ? '该操作只支持固定值' : undefined} onChange={selectValueSource} />
        {usesFieldValue(condition) ? (
          <select className={`h-8 min-w-[180px] flex-1 rounded-[2px] border bg-white px-2 text-[12px] font-medium outline-none ${conditionError ? 'border-[#c62828] text-[#c62828]' : 'border-brand-primary text-brand-primary'}`} value={condition.valueField || ''} onChange={event => onChange({ ...condition, valueField: event.target.value })} aria-label="用于比较的业务字段" aria-invalid={Boolean(conditionError)} title={conditionError || undefined}>
            {!condition.valueField && <option value="">请选择业务字段</option>}
            {condition.valueField && !fieldValues.some(option => option.field.key === condition.valueField) && <option value={condition.valueField}>字段已失效或类型不匹配</option>}
            {fieldValues.map(option => <option key={option.field.key} value={option.field.key}>{option.fact.label} · {option.field.label}</option>)}
          </select>
        ) : (
          <>
            <ConditionLiteralControl condition={condition} field={field} onChange={onChange} />
            {field?.unit && <span className="text-[11px] text-ink-3">{field.unit}</span>}
          </>
        )}
        <RowActions index={index} count={count} onMove={onMove} onDelete={onDelete} />
      </div>
    </div>
  )
}

function ActionRow({ action, index, count, facts, editable, onChange, onMove, onDelete, onOpenBom }: {
  action: RuleActionDraft
  index: number
  count: number
  facts: FactOption[]
  editable: boolean
  onChange: (action: RuleActionDraft) => void
  onMove: (offset: number) => void
  onDelete: () => void
  onOpenBom?: (fieldKey: string) => void
}) {
  const fact = selectedFact(facts, action.factType, action.field)
  const field = selectedField(facts, action.field)
  const invalid = !field
  const actionType = action.actionType || (isListField(field) ? 'add' : 'set')
  const verb = actionType === 'add' ? '添加' : '设置'

  if (!editable) {
    return (
      <div className={`flex min-h-11 flex-wrap items-center gap-2 rounded-[3px] border px-3 py-2 ${invalid ? 'border-[#c62828] bg-[#fff1f1]' : 'border-ink-border bg-[#fafafa]'}`}>
        <strong className="font-semibold text-ink-2">{verb}</strong>
        <ReadonlyTerm fieldKey={action.field} onOpenBom={onOpenBom}>{fact?.label || action.factType || '未知事实'}</ReadonlyTerm>
        <span className="text-ink-3">的</span>
        <ReadonlyTerm fieldKey={action.field} onOpenBom={onOpenBom}>{field?.label || action.field}</ReadonlyTerm>
        {actionType === 'set' && <span className="text-ink-3">为</span>}
        <code className="rounded-[2px] bg-[#f0f0f0] px-2 py-1 font-mono text-[12px] text-ink-1">{displayValue(action.value, field)}</code>
      </div>
    )
  }

  const selectFact = (factName: string) => {
    const nextFact = facts.find(candidate => candidate.name === factName)
    const nextField = nextFact?.fields[0]
    onChange({ ...action, factType: factName, field: nextField?.key || '', actionType: isListField(nextField) ? 'add' : 'set', value: isBooleanField(nextField) ? 'true' : enumValues(nextField)[0] || '' })
  }
  const selectField = (fieldKey: string) => {
    const nextField = fact?.fields.find(candidate => candidate.key === fieldKey)
    onChange({ ...action, field: fieldKey, actionType: isListField(nextField) ? 'add' : 'set', value: isBooleanField(nextField) ? 'true' : enumValues(nextField)[0] || '' })
  }

  return (
    <div className={`flex min-h-12 flex-wrap items-center gap-2 rounded-[3px] border px-3 py-2 ${invalid || valueError(action.value, field) ? 'border-[#c62828] bg-[#fffafa]' : 'border-ink-border bg-[#fafafa]'}`}>
      <strong className="min-w-8 font-semibold text-ink-2">{verb}</strong>
      <TermSelect value={fact?.name || action.factType || ''} label="目标事实类型" options={facts.map(option => ({ value: option.name, label: option.label }))} invalid={!fact} onChange={selectFact} />
      <span className="text-ink-3">的</span>
      <TermSelect value={action.field} label="目标业务字段" options={(fact?.fields || []).map(option => ({ value: option.key, label: option.label }))} invalid={invalid} onChange={selectField} />
      {actionType === 'set' && <span className="text-ink-3">为</span>}
      <ValueControl value={action.value} field={field} onChange={value => onChange({ ...action, value })} />
      <RowActions index={index} count={count} onMove={onMove} onDelete={onDelete} />
    </div>
  )
}

function balPreview(draft: RuleDraft, fields: BomField[]) {
  const inputFacts = factsFor(fields, 'input')
  const outputFacts = factsFor(fields, 'output')
  const lines = [`规则 ${JSON.stringify(draft.name)}`, '', '  当']
  draft.conditions.forEach((condition, index) => {
    const prefix = index ? `${condition.connector === 'or' ? '或者' : '并且'} ` : ''
    if (isAdvancedCondition(condition)) {
      const quantifier = condition.raw && condition.quantifier && condition.quantifier !== 'one'
        ? `${quantifiers.find(option => option.value === condition.quantifier)?.label || condition.quantifier} `
        : ''
      lines.push(`    ${prefix}${quantifier}[高级表达式] ${advancedExpression(condition)}`)
      return
    }
    const fact = selectedFact(inputFacts, condition.factType, condition.field)
    const field = selectedField(inputFacts, condition.field)
    const quantifier = quantifiers.find(option => option.value === (condition.quantifier || 'one'))?.label || '一个'
    const operator = operatorsFor(field).find(option => option.value === condition.operator)?.label || condition.operator
    if (usesFieldValue(condition)) {
      const rightField = selectedField(inputFacts, condition.valueField || '')
      const rightFact = rightField ? inputFacts.find(candidate => candidate.fields.some(option => option.key === rightField.key)) : undefined
      lines.push(`    ${prefix}${quantifier} ${fact?.label || '未知事实'} 的 ${field?.label || condition.field} ${operator} ${rightFact?.label || '未知事实'} 的 ${rightField?.label || condition.valueField || '未选择字段'}`)
    } else {
      lines.push(`    ${prefix}${quantifier} ${fact?.label || '未知事实'} 的 ${field?.label || condition.field} ${operator} ${displayConditionValue(condition, field)}`)
    }
  })
  lines.push('', '  那么')
  draft.actions.forEach(action => {
    const fact = selectedFact(outputFacts, action.factType, action.field)
    const field = selectedField(outputFacts, action.field)
    const add = action.actionType === 'add' || isListField(field)
    lines.push(`    ${add ? '添加' : '设置'} ${fact?.label || '未知事实'} 的 ${field?.label || action.field}${add ? '' : ' 为'} ${displayValue(action.value, field)}`)
  })
  return lines.join('\n')
}

export default function BalRuleView({ draft, fields, editable = false, onChange, onOpenBom }: BalRuleViewProps) {
  const inputFacts = factsFor(fields, 'input')
  const outputFacts = factsFor(fields, 'output')
  const setDraft = (next: RuleDraft) => onChange?.(next)
  const firstConditionField = inputFacts[0]?.fields[0]
  const firstActionField = outputFacts[0]?.fields[0]

  return (
    <div className="bg-white px-5 py-5 text-[13px] max-sm:px-4" aria-label={editable ? 'BAL 规则编辑区' : 'BAL 规则只读视图'}>
      <section aria-labelledby="bal-when-heading">
        <div className="mb-2 flex min-h-7 items-center gap-3">
          <h3 id="bal-when-heading" className="font-semibold text-ink-3">当</h3>
          {editable && <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l" disabled={!firstConditionField} onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { factType: inputFacts[0]?.name, quantifier: 'one', connector: 'and', field: firstConditionField?.key || '', operator: defaultOperatorForType(firstConditionField?.type), value: isBooleanField(firstConditionField) ? 'true' : enumValues(firstConditionField)[0] || '' }] })}><Plus size={13} />添加条件</button>}
        </div>
        <div className="space-y-2">
          {draft.conditions.map((condition, index) => (
            <ConditionRow
              key={`${condition.field || condition.raw || condition.pattern || 'condition'}-${index}`}
              condition={condition}
              index={index}
              count={draft.conditions.length}
              facts={inputFacts}
              editable={editable}
              onOpenBom={onOpenBom}
              onChange={next => setDraft({ ...draft, conditions: draft.conditions.map((item, position) => position === index ? next : item) })}
              onMove={offset => setDraft({ ...draft, conditions: moveItem(draft.conditions, index, offset) })}
              onDelete={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, position) => position !== index) })}
            />
          ))}
        </div>
      </section>

      <section className="mt-5 border-t border-ink-border pt-4" aria-labelledby="bal-then-heading">
        <div className="mb-2 flex min-h-7 items-center gap-3">
          <h3 id="bal-then-heading" className="font-semibold text-ink-3">那么</h3>
          {editable && <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l" disabled={!firstActionField} onClick={() => setDraft({ ...draft, actions: [...draft.actions, { factType: outputFacts[0]?.name, actionType: isListField(firstActionField) ? 'add' : 'set', field: firstActionField?.key || '', value: isBooleanField(firstActionField) ? 'true' : enumValues(firstActionField)[0] || '' }] })}><Plus size={13} />添加动作</button>}
        </div>
        <div className="space-y-2">
          {draft.actions.map((action, index) => (
            <ActionRow
              key={`${action.field}-${index}`}
              action={action}
              index={index}
              count={draft.actions.length}
              facts={outputFacts}
              editable={editable}
              onOpenBom={onOpenBom}
              onChange={next => setDraft({ ...draft, actions: draft.actions.map((item, position) => position === index ? next : item) })}
              onMove={offset => setDraft({ ...draft, actions: moveItem(draft.actions, index, offset) })}
              onDelete={() => setDraft({ ...draft, actions: draft.actions.filter((_, position) => position !== index) })}
            />
          ))}
        </div>
      </section>

      {editable && (
        <details className="mt-5 border-t border-ink-border pt-3">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-ink-2">BAL 中文预览</summary>
          <pre className="mt-2 overflow-auto rounded-[3px] border border-ink-border bg-[#fafafa] p-3 font-sans text-[12px] leading-6 text-ink-1">{balPreview(draft, fields)}</pre>
        </details>
      )}
    </div>
  )
}
