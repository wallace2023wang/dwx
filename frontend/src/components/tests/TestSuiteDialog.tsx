import { Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useRuleFlow } from '../../api/flows'
import type { ServerSuite, TestSuitePayload, TestValue } from '../../api/tests'
import type { BomField, BomModel, FlowDetail } from '../../types'
import Modal from '../Modal'

export interface TestTargetOption {
  id: string
  name: string
  type: 'rule' | 'table' | 'flow'
  version: string
}

interface FormCase {
  id: string
  name: string
  enabled: boolean
  facts: Record<string, TestValue>
  outputs: Record<string, TestValue>
  fired: string
  path: string
  parameters: Array<{ id: string; name: string; facts: Record<string, TestValue> }>
}

interface TestSuiteDialogProps {
  projectId: string
  bom: BomModel
  targets: TestTargetOption[]
  initial?: ServerSuite
  saving: boolean
  error?: string
  onClose: () => void
  onSave: (payload: TestSuitePayload) => void
}

const unsetPath = '__unset__'
const nullPath = '__null__'

function caseId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `case-${Date.now()}`
}

function parameterId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `parameter-${Date.now()}`
}

function defaultValue(field: BomField): TestValue {
  if (field.type === 'Boolean') return false
  if (field.type === 'Integer' || field.type === 'Decimal') return 0
  if (field.type === 'Enum') return field.enum?.[0] || ''
  return ''
}

function toFormCase(testCase?: ServerSuite['cases'][number]): FormCase {
  return testCase ? {
    id: testCase.id,
    name: testCase.name,
    enabled: testCase.enabled,
    facts: structuredClone(testCase.facts),
    outputs: structuredClone(testCase.expected.outputs),
    fired: testCase.expected.fired.join('\n'),
    path: Object.prototype.hasOwnProperty.call(testCase.expected, 'path')
      ? testCase.expected.path === null ? nullPath : testCase.expected.path || unsetPath
      : unsetPath,
    parameters: structuredClone(testCase.parameters || []),
  } : { id: caseId(), name: '新场景', enabled: true, facts: {}, outputs: {}, fired: '', path: unsetPath, parameters: [] }
}

function ValueControl({ field, value, onChange }: { field: BomField; value: TestValue; onChange: (value: TestValue) => void }) {
  if (field.type === 'Boolean') {
    return <select className="control-input h-8" value={String(value)} onChange={event => onChange(event.target.value === 'true')}><option value="true">是</option><option value="false">否</option></select>
  }
  if (field.type === 'Enum') {
    return <select className="control-input h-8" value={String(value)} onChange={event => onChange(event.target.value)}>{(field.enum || []).map(option => <option key={option}>{option}</option>)}</select>
  }
  if (field.type === 'Integer' || field.type === 'Decimal') {
    return <input className="control-input h-8 font-mono" type="number" step={field.type === 'Integer' ? 1 : 'any'} min={field.min ?? undefined} max={field.max ?? undefined} value={String(value)} onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
  }
  return <input className="control-input h-8" type={field.type === 'Date' ? 'date' : 'text'} value={String(value)} onChange={event => onChange(event.target.value)} placeholder={field.type === 'List<String>' ? '使用逗号分隔多个值' : undefined} />
}

function FieldAssertions({ title, fields, values, onChange }: {
  title: string
  fields: BomField[]
  values: Record<string, TestValue>
  onChange: (values: Record<string, TestValue>) => void
}) {
  return (
    <fieldset className="border border-ink-border p-2">
      <legend className="px-1 text-[11px] font-semibold text-ink-2">{title}</legend>
      <div className="space-y-1.5">
        {fields.map(field => {
          const included = Object.prototype.hasOwnProperty.call(values, field.key)
          return <div key={field.key} className="grid grid-cols-[minmax(130px,1fr)_minmax(120px,1.2fr)] items-center gap-2"><label className="flex min-w-0 items-center gap-2 text-[11px]"><input type="checkbox" checked={included} onChange={() => {
            const next = { ...values }
            if (included) delete next[field.key]
            else next[field.key] = defaultValue(field)
            onChange(next)
          }} /><span className="truncate" title={`${field.factLabel || ''}.${field.label}`}>{field.factLabel} · {field.label}</span></label>{included ? <ValueControl field={field} value={values[field.key]} onChange={value => onChange({ ...values, [field.key]: value })} /> : <span className="text-[10px] text-ink-3">不传入</span>}</div>
        })}
      </div>
    </fieldset>
  )
}

export default function TestSuiteDialog({ projectId, bom, targets, initial, saving, error, onClose, onSave }: TestSuiteDialogProps) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [required, setRequired] = useState(initial?.required ?? false)
  const [targetKey, setTargetKey] = useState(initial ? `${initial.target.type}:${initial.target.id}` : targets[0] ? `${targets[0].type}:${targets[0].id}` : '')
  const [cases, setCases] = useState<FormCase[]>(initial?.cases.map(toFormCase) || [toFormCase()])
  const target = targets.find(option => `${option.type}:${option.id}` === targetKey)
  const { data: flow } = useRuleFlow(projectId, target?.type === 'flow' ? target.id : undefined)
  const flowDraft = target?.type === 'flow' && flow && 'draft' in flow ? (flow as FlowDetail).draft : null
  const flowGateways = flowDraft?.graph
    ? flowDraft.graph.nodes.filter(node => node.type === 'gateway')
    : flowDraft?.gateways?.length ? flowDraft.gateways : (flowDraft?.branches?.length ? [{ id: 'gateway', name: '排他网关', afterStep: flowDraft.steps.length, branches: flowDraft.branches }] : flowDraft?.gateways ?? [])
  const branches = flowGateways.flatMap(gateway => gateway.branches.map(branch => ({ ...branch, gatewayName: gateway.name })))
  const inputFields = useMemo(() => bom.factTypes.flatMap(fact => fact.fields.map(field => ({ ...field, factLabel: fact.label }))).filter(field => field.direction === 'input'), [bom])
  const outputFields = useMemo(() => bom.factTypes.flatMap(fact => fact.fields.map(field => ({ ...field, factLabel: fact.label }))).filter(field => field.direction === 'output'), [bom])
  const invalidCase = cases.some(testCase => !testCase.name.trim()
    || testCase.parameters.some(parameter => !parameter.name.trim())
    || (!Object.keys(testCase.outputs).length && !testCase.fired.trim() && (target?.type !== 'flow' || testCase.path === unsetPath)))
  const canSave = Boolean(name.trim() && target && cases.length && cases.some(testCase => testCase.enabled) && !invalidCase && !saving)

  const updateCase = (index: number, update: Partial<FormCase>) => setCases(current => current.map((testCase, position) => position === index ? { ...testCase, ...update } : testCase))
  const submit = () => {
    if (!target || !canSave) return
    onSave({
      name: name.trim(), description: description.trim(), required,
      target: { type: target.type, id: target.id },
      cases: cases.map(testCase => ({
        id: testCase.id, name: testCase.name.trim(), enabled: testCase.enabled,
        facts: testCase.facts,
        ...(testCase.parameters.length ? { parameters: testCase.parameters.map(parameter => ({
          id: parameter.id, name: parameter.name.trim(), facts: parameter.facts,
        })) } : {}),
        expected: {
          outputs: testCase.outputs,
          fired: testCase.fired.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean),
          ...(target.type === 'flow' && testCase.path !== unsetPath ? { path: testCase.path === nullPath ? null : testCase.path } : {}),
        },
      })),
    })
  }

  return (
    <Modal title={initial ? '编辑测试套件' : '新建测试套件'} onClose={onClose} width="max-w-5xl">
      <div className="max-h-[75vh] space-y-4 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <label className="text-[11px] font-semibold text-ink-2">名称<input className="control-input mt-1" value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus /></label>
          <label className="text-[11px] font-semibold text-ink-2">测试目标<select className="control-input mt-1" value={targetKey} onChange={event => { setTargetKey(event.target.value); setCases(current => current.map(testCase => ({ ...testCase, path: unsetPath }))) }}><option value="">请选择已发布资产</option>{targets.map(option => <option key={`${option.type}:${option.id}`} value={`${option.type}:${option.id}`}>{option.type === 'rule' ? '规则' : option.type === 'table' ? '决策表' : '规则集'} · {option.name} · v{option.version}</option>)}</select></label>
        </div>
        <label className="block text-[11px] font-semibold text-ink-2">说明<textarea className="mt-1 min-h-16 w-full resize-y border border-ink-border bg-white px-[10px] py-2 text-xs outline-none focus:border-brand-primary" value={description} maxLength={500} onChange={event => setDescription(event.target.value)} /></label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)} />作为 Release 发布门禁</label>

        <div className="space-y-3">
          {cases.map((testCase, index) => <section key={testCase.id} className="border border-ink-border bg-[#fafafa]">
            <header className="flex min-h-10 items-center gap-2 border-b border-ink-border px-3"><span className="font-mono text-[10px] text-ink-3">#{index + 1}</span><input className="h-7 min-w-0 flex-1 border border-transparent bg-transparent px-1.5 text-xs font-semibold outline-none hover:border-ink-border focus:border-brand-primary focus:bg-white" value={testCase.name} maxLength={80} onChange={event => updateCase(index, { name: event.target.value })} /><label className="flex items-center gap-1 text-[10px] text-ink-2"><input type="checkbox" checked={testCase.enabled} onChange={event => updateCase(index, { enabled: event.target.checked })} />启用</label><button type="button" className="inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828] disabled:opacity-30" disabled={cases.length === 1} onClick={() => setCases(current => current.filter((_, position) => position !== index))} title="删除场景"><Trash2 size={13} /></button></header>
            <div className="grid grid-cols-2 gap-3 p-3 max-md:grid-cols-1">
              <div className="space-y-3">
                <FieldAssertions title="基础输入事实" fields={inputFields} values={testCase.facts} onChange={facts => updateCase(index, { facts })} />
                <section className="border border-ink-border bg-white p-2">
                  <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[11px] font-semibold text-ink-2">参数数据集 <span className="font-normal text-ink-3">{testCase.parameters.length}/100</span></h3><button type="button" disabled={testCase.parameters.length >= 100} className="inline-flex h-7 items-center gap-1 border border-ink-border bg-white px-2 text-[10px] text-brand-primary hover:border-brand-primary disabled:cursor-not-allowed disabled:opacity-40" onClick={() => updateCase(index, { parameters: [...testCase.parameters, { id: parameterId(), name: `参数 ${testCase.parameters.length + 1}`, facts: {} }] })}><Plus size={12} />添加参数</button></div>
                  {testCase.parameters.length === 0 ? <p className="py-2 text-center text-[10px] text-ink-3">未添加参数时，基础输入只执行一次。</p> : <div className="space-y-2">{testCase.parameters.map((parameter, parameterIndex) => <div key={parameter.id} className="border border-[#e8e8e8] p-2">
                    <div className="mb-2 flex items-center gap-2"><span className="font-mono text-[10px] text-ink-3">P{parameterIndex + 1}</span><input className="h-7 min-w-0 flex-1 border border-ink-border px-2 text-[11px] outline-none focus:border-brand-primary" value={parameter.name} maxLength={80} onChange={event => updateCase(index, { parameters: testCase.parameters.map((entry, position) => position === parameterIndex ? { ...entry, name: event.target.value } : entry) })} aria-label={`参数 ${parameterIndex + 1} 名称`} /><button type="button" className="inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828]" title="删除参数" onClick={() => updateCase(index, { parameters: testCase.parameters.filter((_, position) => position !== parameterIndex) })}><Trash2 size={12} /></button></div>
                    <FieldAssertions title="覆盖字段" fields={inputFields} values={parameter.facts} onChange={facts => updateCase(index, { parameters: testCase.parameters.map((entry, position) => position === parameterIndex ? { ...entry, facts } : entry) })} />
                  </div>)}</div>}
                </section>
              </div>
              <div className="space-y-3"><FieldAssertions title="期望输出" fields={outputFields} values={testCase.outputs} onChange={outputs => updateCase(index, { outputs })} /><label className="block text-[11px] font-semibold text-ink-2">期望命中规则<input className="control-input mt-1 h-8" value={testCase.fired} onChange={event => updateCase(index, { fired: event.target.value })} placeholder="可选，多个规则用逗号分隔" /></label>{target?.type === 'flow' && <label className="block text-[11px] font-semibold text-ink-2">期望流程路径<select className="control-input mt-1 h-8" value={testCase.path} onChange={event => updateCase(index, { path: event.target.value })}><option value={unsetPath}>不校验路径</option><option value={nullPath}>无匹配分支</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{flowGateways.length > 1 ? `${branch.gatewayName} / ` : ''}{branch.name}{branch.default ? '（默认）' : ''}</option>)}</select></label>}</div>
            </div>
          </section>)}
          <button type="button" className="inline-flex h-8 items-center gap-1 border border-dashed border-brand-primary bg-white px-3 text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={() => setCases(current => [...current, toFormCase()])}><Plus size={13} />新增场景</button>
        </div>
        {invalidCase && <p className="text-[11px] text-[#a15c00]">场景和参数行需要名称；每个场景还需至少设置一项期望输出、命中规则或流程路径。</p>}
        {!targets.length && <p className="border border-[#f3c65f] bg-[#fff8e1] p-2 text-[11px] text-[#734d00]">当前项目没有已发布资产，请先发布规则、决策表或规则集。</p>}
        {error && <p className="text-[11px] text-[#c62828]">{error}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button type="button" className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={onClose}>取消</button><button type="button" className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={!canSave} onClick={submit}>{saving ? '保存中...' : '保存套件'}</button></footer>
    </Modal>
  )
}
