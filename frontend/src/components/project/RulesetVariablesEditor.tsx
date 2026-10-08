import { Plus, Trash2 } from 'lucide-react'
import type { RuleSetVariable, RuleSetVariableType } from '../../types'

interface RulesetVariablesEditorProps {
  variables: RuleSetVariable[]
  onChange: (variables: RuleSetVariable[]) => void
  title?: string
  description?: string
  emptyText?: string
  readOnly?: boolean
  className?: string
}

const variableTypes: RuleSetVariableType[] = ['Boolean', 'Integer', 'Double', 'String']

function defaultValue(type: RuleSetVariableType, variable?: RuleSetVariable) {
  if (type === 'Boolean') return false
  if (type === 'String') return variable?.enum?.[0] || ''
  return 0
}

function nextVariableName(variables: RuleSetVariable[]) {
  const names = new Set(variables.map(variable => variable.name))
  let index = variables.length + 1
  while (names.has(`temp${index}`)) index += 1
  return `temp${index}`
}

function enumValues(value: string) {
  const values = value.split(',').map(item => item.trim()).filter(Boolean)
  return values.length ? values : null
}

export default function RulesetVariablesEditor({
  variables,
  onChange,
  title = '规则集变量',
  description = '当前 Rule Project 的规则集执行上下文内共享；不进入 BOM，不由 facts 传入。规则 A 可赋值，规则 B 可读取。',
  emptyText = '暂无变量。变量定义完成后，发布时会冻结到规则集 Release。',
  readOnly = false,
  className = 'border-b border-ink-border px-4 py-3',
}: RulesetVariablesEditorProps) {
  const addVariable = () => {
    const type: RuleSetVariableType = 'Boolean'
    onChange([
      ...variables,
      {
        name: nextVariableName(variables),
        label: '临时变量',
        type,
        defaultValue: defaultValue(type),
        enum: null,
        description: '',
      },
    ])
  }

  const updateVariable = (index: number, patch: Partial<RuleSetVariable>) => {
    onChange(variables.map((variable, position) => position === index ? { ...variable, ...patch } : variable))
  }

  return (
    <section className={className} aria-labelledby="flow-variables-heading">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div>
          <h2 id="flow-variables-heading" className="text-[11px] font-semibold text-ink-2">{title}</h2>
          <p className="mt-0.5 text-[10px] font-normal text-ink-3">{description}</p>
        </div>
        {!readOnly && <button type="button" className="ml-auto inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={addVariable}>
          <Plus size={13} />添加变量
        </button>}
      </div>
      {variables.length === 0
        ? <p className="rounded-[3px] border border-dashed border-ink-border bg-[#fafafa] px-3 py-2 text-[10px] text-ink-3">{emptyText}</p>
        : <div className="space-y-2">
            {variables.map((variable, index) => (
              <div key={`${variable.name}-${index}`} className="grid grid-cols-[minmax(110px,1fr)_minmax(110px,1fr)_100px_minmax(100px,1fr)_auto] items-start gap-2 rounded-[3px] border border-[#b8c9f5] bg-[#f5f8ff] p-2 max-lg:grid-cols-2">
                <input className="control-input h-8 font-mono text-[11px]" disabled={readOnly} value={variable.name} onChange={event => updateVariable(index, { name: event.target.value })} placeholder="变量名，如 pctAtLeastMax" aria-label={`规则集变量 ${index + 1} 名称`} />
                <input className="control-input h-8 text-[11px]" disabled={readOnly} value={variable.label} onChange={event => updateVariable(index, { label: event.target.value })} placeholder="显示名" aria-label={`规则集变量 ${index + 1} 显示名`} />
                <select className="control-input h-8 text-[11px]" disabled={readOnly} value={variable.type} onChange={event => {
                  const type = event.target.value as RuleSetVariableType
                  updateVariable(index, { type, defaultValue: defaultValue(type, variable), enum: type === 'String' ? variable.enum : null })
                }} aria-label={`规则集变量 ${index + 1} 类型`}>
                  {variableTypes.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
                {variable.type === 'Boolean'
                  ? <select className="control-input h-8 text-[11px]" disabled={readOnly} value={String(variable.defaultValue)} onChange={event => updateVariable(index, { defaultValue: event.target.value === 'true' })} aria-label={`规则集变量 ${index + 1} 默认值`}><option value="false">false</option><option value="true">true</option></select>
                  : <input className="control-input h-8 text-[11px]" disabled={readOnly} type={variable.type === 'String' ? 'text' : 'number'} value={String(variable.defaultValue)} onChange={event => updateVariable(index, { defaultValue: variable.type === 'String' ? event.target.value : Number(event.target.value) })} placeholder="默认值" aria-label={`规则集变量 ${index + 1} 默认值`} />}
                {!readOnly && <button type="button" className="inline-flex size-8 items-center justify-center text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={() => onChange(variables.filter((_, position) => position !== index))} title="删除变量" aria-label={`删除规则集变量 ${index + 1}`}><Trash2 size={13} /></button>}
                {readOnly && <span className="inline-flex h-8 items-center text-[10px] text-ink-3">只读</span>}
                {variable.type === 'String' && <input className="col-span-4 control-input h-8 text-[11px] max-lg:col-span-2" disabled={readOnly} value={(variable.enum || []).join(', ')} onChange={event => updateVariable(index, { enum: enumValues(event.target.value) })} placeholder="String 枚举（可选，逗号分隔）" aria-label={`规则集变量 ${index + 1} 枚举值`} />}
                <input className="col-span-4 control-input h-8 text-[11px] max-lg:col-span-2" disabled={readOnly} value={variable.description || ''} onChange={event => updateVariable(index, { description: event.target.value })} placeholder="说明（可选）" aria-label={`规则集变量 ${index + 1} 说明`} />
              </div>
            ))}
          </div>}
    </section>
  )
}
