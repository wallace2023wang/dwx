import { ChevronDown, ChevronUp, Code2, LockKeyhole, Plus, Trash2 } from 'lucide-react'
import type { BomField, RuleActionDraft, RuleConditionDraft, RuleDraft, RulePatternConditionDraft, RuleRawConditionDraft } from '../../types'
import { BOM_TYPE_CAPABILITIES, defaultOperatorForType, operatorsForType } from '../../domain/bomTypes'

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
  const values = enumValues(field)
  if (values.length && !values.includes(value)) return '该枚举值已不在 BOM 中'
  return null
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
    const error = valueError(condition.value, field)
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

function ValueControl({ value, field, onChange }: {
  value: string
  field: BomField | undefined
  onChange: (value: string) => void
}) {
  const error = valueError(value, field)
  const values = enumValues(field)
  const className = `h-8 min-w-[104px] flex-1 rounded-[2px] border px-2 font-mono text-[12px] outline-none ${error ? 'border-[#c62828] bg-[#fff1f1]' : 'border-transparent bg-[#f0f0f0] focus:border-brand-primary focus:bg-white'}`
  if (isBooleanField(field)) {
    return <select className={className} value={value} onChange={event => onChange(event.target.value)} aria-label="布尔值"><option value="true">true</option><option value="false">false</option></select>
  }
  if (values.length) {
    return <select className={className} value={value} onChange={event => onChange(event.target.value)} aria-label="枚举值">{error && <option value={value}>{value}（已失效）</option>}{values.map(option => <option key={option} value={option}>{option}</option>)}</select>
  }
  return (
    <input
      className={className}
      type={isNumberField(field) ? 'number' : isDateField(field) ? 'date' : 'text'}
      min={field?.min ?? undefined}
      max={field?.max ?? undefined}
      step={field && BOM_TYPE_CAPABILITIES[field.type].step ? BOM_TYPE_CAPABILITIES[field.type].step : 'any'}
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder="输入值"
      aria-invalid={Boolean(error)}
      title={error || undefined}
    />
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
          <code className="rounded-[2px] bg-[#f0f0f0] px-2 py-1 font-mono text-[12px] text-ink-1">{displayValue(condition.value, field)}</code>
          {field?.unit && <span className="text-[11px] text-ink-3">{field.unit}</span>}
        </div>
      </div>
    )
  }

  const selectFact = (factName: string) => {
    const nextFact = facts.find(candidate => candidate.name === factName)
    const nextField = nextFact?.fields[0]
    onChange({ ...condition, factType: factName, field: nextField?.key || '', operator: defaultOperatorForType(nextField?.type), value: isBooleanField(nextField) ? 'true' : enumValues(nextField)[0] || '' })
  }
  const selectField = (fieldKey: string) => {
    const nextField = fact?.fields.find(candidate => candidate.key === fieldKey)
    onChange({ ...condition, field: fieldKey, operator: defaultOperatorForType(nextField?.type), value: isBooleanField(nextField) ? 'true' : enumValues(nextField)[0] || '' })
  }

  return (
    <div>
      {index > 0 && (
        <select className="mb-1 h-7 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] font-medium text-ink-3 outline-none focus:border-brand-primary" value={condition.connector || 'and'} onChange={event => onChange({ ...condition, connector: event.target.value as 'and' | 'or' })} aria-label="条件连接词">
          <option value="and">并且</option><option value="or">或者</option>
        </select>
      )}
      <div className={`flex min-h-12 flex-wrap items-center gap-2 rounded-[3px] border px-3 py-2 ${invalid || valueError(condition.value, field) ? 'border-[#c62828] bg-[#fffafa]' : 'border-ink-border bg-[#fafafa]'}`}>
        <select className="h-8 rounded-[2px] border border-ink-border bg-white px-1.5 text-[11px] text-ink-2 outline-none focus:border-brand-primary" value={condition.quantifier || 'one'} onChange={event => onChange({ ...condition, quantifier: event.target.value as RuleConditionDraft['quantifier'] })} aria-label="量词">
          {quantifiers.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <TermSelect value={fact?.name || condition.factType || ''} label="事实类型" options={facts.map(option => ({ value: option.name, label: option.label }))} invalid={!fact} onChange={selectFact} />
        <span className="text-ink-3">的</span>
        <TermSelect value={condition.field} label="业务字段" options={(fact?.fields || []).map(option => ({ value: option.key, label: option.label }))} invalid={invalid} onChange={selectField} />
        <select className="h-8 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] font-semibold text-ink-1 outline-none focus:border-brand-primary" value={condition.operator} onChange={event => onChange({ ...condition, operator: event.target.value })} aria-label="比较符" title="灰色操作符需要后续启用执行支持">
          {operatorsFor(field).map(option => <option key={option.value} value={option.value} disabled={!option.runtimeSupported}>{option.label}{option.runtimeSupported ? '' : '（待支持）'}</option>)}
        </select>
        <ValueControl value={condition.value} field={field} onChange={value => onChange({ ...condition, value })} />
        {field?.unit && <span className="text-[11px] text-ink-3">{field.unit}</span>}
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
    lines.push(`    ${prefix}${quantifier} ${fact?.label || '未知事实'} 的 ${field?.label || condition.field} ${operator} ${displayValue(condition.value, field)}`)
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
