import { CheckCircle2, Copy, FileCode2, Plus, Rocket, Save, Trash2, Wand2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { operatorsForType } from '../../domain/bomTypes'
import type { AssetDetail, BomField, RuleTemplateDraft, RuleTemplateInstanceDraft, RuleTemplateParameterDraft, RuleTemplateParameterType, RuleTemplateSlotDraft } from '../../types'
import BomVersionNotice from './BomVersionNotice'

const MonacoTextEditor = lazy(() => import('./MonacoTextEditor'))
const nextId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

interface Props {
  detail: AssetDetail
  fields: BomField[]
  busy?: boolean
  editable?: boolean
  onSave?: (draft: RuleTemplateDraft) => Promise<void>
  onCompile?: (draft: RuleTemplateDraft) => Promise<{ engineVersion: string; drl: string }>
  onSubmit?: () => Promise<void>
}

function parameterType(field?: BomField): RuleTemplateParameterType {
  return field?.type === 'List<String>' ? 'String' : field?.type || 'String'
}

function defaultValue(field?: BomField) {
  if (field?.type === 'Boolean') return 'true'
  if (field?.type === 'Integer' || field?.type === 'Decimal') return String(field.min ?? 0)
  return field?.enum?.[0] || ''
}

function issuesFor(draft: RuleTemplateDraft, fields: BomField[]) {
  const issues: string[] = []
  if (!draft.name.trim()) issues.push('请填写模板名称')
  if (!draft.parameters.length) issues.push('至少需要一个参数')
  if (!draft.blueprint.conditions.length) issues.push('至少需要一个条件槽')
  if (!draft.blueprint.actions.length) issues.push('至少需要一个动作槽')
  if (!draft.instances.some(instance => instance.enabled)) issues.push('至少需要启用一个实例')
  const names = new Set<string>()
  for (const parameter of draft.parameters) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(parameter.name) || names.has(parameter.name)) issues.push('参数英文名无效或重复')
    names.add(parameter.name)
  }
  for (const slot of draft.blueprint.conditions) {
    const field = fields.find(item => item.key === slot.field && item.direction === 'input')
    const parameter = draft.parameters.find(item => item.name === slot.parameter)
    if (!field || !parameter || parameter.type !== parameterType(field)) issues.push('条件槽字段与参数类型不匹配')
  }
  for (const slot of draft.blueprint.actions) {
    const field = fields.find(item => item.key === slot.field && item.direction === 'output')
    const parameter = draft.parameters.find(item => item.name === slot.parameter)
    if (!field || !parameter || parameter.type !== parameterType(field)) issues.push('动作槽字段与参数类型不匹配')
  }
  return [...new Set(issues)]
}

function ParameterValue({ parameter, value, onChange }: { parameter: RuleTemplateParameterDraft; value: string; onChange: (value: string) => void }) {
  if (parameter.type === 'Boolean') return <select className="control-input h-8" value={value} onChange={event => onChange(event.target.value)}><option value="true">true</option><option value="false">false</option></select>
  if (parameter.type === 'Enum') return <select className="control-input h-8" value={value} onChange={event => onChange(event.target.value)}>{parameter.enum?.map(item => <option key={item}>{item}</option>)}</select>
  return <input className="control-input h-8" type={parameter.type === 'Integer' || parameter.type === 'Decimal' ? 'number' : parameter.type === 'Date' ? 'date' : 'text'} value={value} onChange={event => onChange(event.target.value)} />
}

function SlotRow({ slot, direction, fields, parameters, editable, onChange, onDelete }: { slot: RuleTemplateSlotDraft; direction: 'input' | 'output'; fields: BomField[]; parameters: RuleTemplateParameterDraft[]; editable: boolean; onChange: (slot: RuleTemplateSlotDraft) => void; onDelete: () => void }) {
  const options = fields.filter(field => field.direction === direction && field.type !== 'List<String>')
  const field = options.find(item => item.key === slot.field)
  const compatible = parameters.filter(parameter => parameter.type === parameterType(field))
  const changeField = (key: string) => {
    const next = options.find(item => item.key === key)
    const parameter = parameters.find(item => item.type === parameterType(next))
    onChange({ ...slot, field: key, ...(direction === 'input' ? { operator: operatorsForType(next?.type)[0]?.value || '==' } : {}), parameter: parameter?.name || '' })
  }
  return <div className="grid grid-cols-[minmax(150px,1fr)_120px_minmax(150px,1fr)_32px] items-end gap-2 border-t border-ink-border px-3 py-2 first:border-0">
    <label className="text-[10px] text-ink-3">业务字段<select className="control-input mt-1 h-8" disabled={!editable} value={slot.field} onChange={event => changeField(event.target.value)}>{options.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
    {direction === 'input' ? <label className="text-[10px] text-ink-3">比较<select className="control-input mt-1 h-8" disabled={!editable} value={slot.operator} onChange={event => onChange({ ...slot, operator: event.target.value })}>{operatorsForType(field?.type).filter(item => !['between', 'in', 'not in', 'matches', 'size >', 'size <'].includes(item.value)).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label> : <span />}
    <label className="text-[10px] text-ink-3">参数<select className="control-input mt-1 h-8" disabled={!editable} value={slot.parameter} onChange={event => onChange({ ...slot, parameter: event.target.value })}>{compatible.map(item => <option key={item.name} value={item.name}>{item.label} · {item.name}</option>)}</select></label>
    {editable ? <button className="inline-flex size-8 items-center justify-center text-[#c62828]" onClick={onDelete}><Trash2 size={13} /></button> : <span />}
  </div>
}

export default function RuleTemplateEditor({ detail, fields, busy = false, editable = false, onSave, onCompile, onSubmit }: Props) {
  const source = detail.draft as RuleTemplateDraft
  const [draft, setDraft] = useState(() => structuredClone(source))
  const [view, setView] = useState<'template' | 'drl'>('template')
  const [drl, setDrl] = useState(detail.content || '')
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  useEffect(() => { setDraft(structuredClone(source)); setDrl(detail.content || ''); setView('template'); setNotice(null) }, [detail.id, detail.revision])
  const issues = issuesFor(draft, fields)
  const dirty = JSON.stringify(draft) !== JSON.stringify(source)
  const inputs = useMemo(() => fields.filter(field => field.direction === 'input' && field.type !== 'List<String>'), [fields])
  const outputs = useMemo(() => fields.filter(field => field.direction === 'output' && field.type !== 'List<String>'), [fields])
  const run = async (action: () => Promise<unknown>, success: string) => { setNotice(null); try { await action(); setNotice({ error: false, text: success }) } catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : '操作失败' }) } }
  const addParameter = () => {
    const field = inputs.find(input => !draft.parameters.some(parameter => parameter.type === parameterType(input))) || inputs[0]
    if (!field) return
    const ordinal = draft.parameters.length + 1
    const parameter: RuleTemplateParameterDraft = { id: nextId('parameter'), name: `parameter${ordinal}`, label: `参数 ${ordinal}`, type: parameterType(field), defaultValue: defaultValue(field), ...(field.enum?.length ? { enum: [...field.enum] } : {}) }
    setDraft({ ...draft, parameters: [...draft.parameters, parameter], instances: draft.instances.map(instance => ({ ...instance, values: { ...instance.values, [parameter.name]: parameter.defaultValue } })) })
  }
  const updateParameter = (position: number, next: RuleTemplateParameterDraft) => {
    const previous = draft.parameters[position]
    const instances = draft.instances.map(instance => { const values = { ...instance.values }; if (previous.name !== next.name) { values[next.name] = values[previous.name] ?? next.defaultValue; delete values[previous.name] } return { ...instance, values } })
    const replace = (slot: RuleTemplateSlotDraft) => slot.parameter === previous.name ? { ...slot, parameter: next.name } : slot
    setDraft({ ...draft, parameters: draft.parameters.map((item, index) => index === position ? next : item), instances, blueprint: { conditions: draft.blueprint.conditions.map(replace), actions: draft.blueprint.actions.map(replace) } })
  }
  const deleteParameter = (parameter: RuleTemplateParameterDraft) => setDraft({ ...draft, parameters: draft.parameters.filter(item => item.id !== parameter.id), instances: draft.instances.map(instance => { const values = { ...instance.values }; delete values[parameter.name]; return { ...instance, values } }), blueprint: { conditions: draft.blueprint.conditions.filter(slot => slot.parameter !== parameter.name), actions: draft.blueprint.actions.filter(slot => slot.parameter !== parameter.name) } })
  const addSlot = (direction: 'input' | 'output') => {
    const options = direction === 'input' ? inputs : outputs
    const field = options[0]
    if (!field) return
    const parameter = draft.parameters.find(item => item.type === parameterType(field))
    if (!parameter) return
    const slot = { field: field.key, parameter: parameter.name, ...(direction === 'input' ? { operator: operatorsForType(field.type)[0]?.value || '==' } : {}) }
    setDraft({ ...draft, blueprint: { ...draft.blueprint, [direction === 'input' ? 'conditions' : 'actions']: [...draft.blueprint[direction === 'input' ? 'conditions' : 'actions'], slot] } })
  }
  const addInstance = () => {
    const instance: RuleTemplateInstanceDraft = { id: nextId('instance'), name: `实例 ${draft.instances.length + 1}`, enabled: true, priorityOffset: 0, values: Object.fromEntries(draft.parameters.map(parameter => [parameter.name, parameter.defaultValue])) }
    setDraft({ ...draft, instances: [...draft.instances, instance] })
  }
  const compile = async () => { if (!onCompile) return; const result = await onCompile(draft); setDrl(result.drl) }
  return <section className="flex h-full min-w-[500px] flex-1 flex-col overflow-hidden bg-white" aria-label="规则模板编辑器">
    <header className="shrink-0 border-b border-ink-border px-4 py-3"><div className="flex items-center gap-2"><Wand2 size={16} className="text-[#8e44ad]" />{editable ? <input className="min-w-0 flex-1 border-0 border-b border-transparent text-[15px] font-semibold outline-none focus:border-brand-primary" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /> : <h2 className="flex-1 text-[15px] font-semibold">{draft.name}</h2>}<span className="rounded bg-[#f3e5f5] px-2 py-0.5 text-[10px] text-[#7b1fa2]">规则模板</span><span className="text-[11px] text-ink-3">v{detail.version} · r{detail.revision}</span></div><div className="mt-2 flex items-center gap-3 text-[11px]"><label>规则包{editable ? <input className="control-input ml-1 h-7 w-32" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} /> : `：${draft.category}`}</label><label>基础优先级{editable ? <input className="control-input ml-1 h-7 w-20" type="number" value={draft.priority} onChange={event => setDraft({ ...draft, priority: Number(event.target.value) })} /> : `：${draft.priority}`}</label><button className={`ml-auto h-7 px-2 text-[10px] ${view === 'template' ? 'bg-brand-primary text-white' : 'border border-ink-border'}`} onClick={() => setView('template')}>模板设计</button><button className={`h-7 px-2 text-[10px] ${view === 'drl' ? 'bg-brand-primary text-white' : 'border border-ink-border'}`} onClick={() => setView('drl')}><FileCode2 size={11} className="mr-1 inline" />DRL</button></div></header>
    <BomVersionNotice detail={detail} />
    {issues.length > 0 && <div className="border-b border-[#ef9a9a] bg-[#fff1f1] px-4 py-2 text-[11px] text-[#a31515]">{issues[0]}{issues.length > 1 ? `，另有 ${issues.length - 1} 项问题` : ''}</div>}
    <div className="min-h-0 flex-1 overflow-auto">{view === 'drl' ? <div className="h-full min-h-[420px]"><Suspense fallback={<div className="p-5 text-[11px] text-ink-3">正在加载 DRL...</div>}><MonacoTextEditor value={drl} /></Suspense></div> : <div className="space-y-5 p-4">
      <section className="border border-ink-border"><header className="flex h-10 items-center border-b border-ink-border bg-[#fafafa] px-3"><h3 className="text-xs font-semibold">参数定义</h3>{editable && <button className="ml-auto inline-flex items-center gap-1 text-[10px] text-brand-primary" onClick={addParameter}><Plus size={12} />添加参数</button>}</header><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[11px]"><thead><tr className="bg-[#f7f7f7] text-left text-ink-3"><th className="p-2">显示名</th><th className="p-2">英文名</th><th className="p-2">类型</th><th className="p-2">默认值</th>{editable && <th className="w-10" />}</tr></thead><tbody>{draft.parameters.map((parameter, index) => <tr key={parameter.id} className="border-t border-ink-border"><td className="p-2"><input className="control-input h-8" disabled={!editable} value={parameter.label} onChange={event => updateParameter(index, { ...parameter, label: event.target.value })} /></td><td className="p-2"><input className="control-input h-8 font-mono" disabled={!editable} value={parameter.name} onChange={event => updateParameter(index, { ...parameter, name: event.target.value })} /></td><td className="p-2"><span>{parameter.type}</span></td><td className="p-2"><ParameterValue parameter={parameter} value={parameter.defaultValue} onChange={value => updateParameter(index, { ...parameter, defaultValue: value })} /></td>{editable && <td><button className="text-[#c62828]" onClick={() => deleteParameter(parameter)}><Trash2 size={13} /></button></td>}</tr>)}</tbody></table></div></section>
      <section className="grid grid-cols-2 gap-4 max-xl:grid-cols-1">{(['input', 'output'] as const).map(direction => <div key={direction} className="border border-ink-border"><header className="flex h-10 items-center border-b border-ink-border bg-[#fafafa] px-3"><h3 className="text-xs font-semibold">{direction === 'input' ? '条件槽' : '动作槽'}</h3>{editable && <button className="ml-auto inline-flex items-center gap-1 text-[10px] text-brand-primary" onClick={() => addSlot(direction)}><Plus size={12} />添加</button>}</header>{draft.blueprint[direction === 'input' ? 'conditions' : 'actions'].map((slot, index) => <SlotRow key={`${direction}-${index}`} slot={slot} direction={direction} fields={fields} parameters={draft.parameters} editable={editable} onChange={next => setDraft({ ...draft, blueprint: { ...draft.blueprint, [direction === 'input' ? 'conditions' : 'actions']: draft.blueprint[direction === 'input' ? 'conditions' : 'actions'].map((item, position) => position === index ? next : item) } })} onDelete={() => setDraft({ ...draft, blueprint: { ...draft.blueprint, [direction === 'input' ? 'conditions' : 'actions']: draft.blueprint[direction === 'input' ? 'conditions' : 'actions'].filter((_, position) => position !== index) } })} />)}</div>)}</section>
      <section className="border border-ink-border"><header className="flex h-10 items-center border-b border-ink-border bg-[#fafafa] px-3"><h3 className="text-xs font-semibold">实例矩阵</h3><span className="ml-2 text-[10px] text-ink-3">{draft.instances.filter(instance => instance.enabled).length} 个启用 / {draft.instances.length} 个实例</span>{editable && <button className="ml-auto inline-flex items-center gap-1 text-[10px] text-brand-primary" onClick={addInstance}><Plus size={12} />添加实例</button>}</header><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[11px]"><thead><tr className="bg-[#f7f7f7] text-left text-ink-3"><th className="w-14 p-2">启用</th><th className="min-w-36 p-2">实例名称</th>{draft.parameters.map(parameter => <th key={parameter.id} className="min-w-32 p-2">{parameter.label}</th>)}<th className="w-24 p-2">优先级偏移</th>{editable && <th className="w-16" />}</tr></thead><tbody>{draft.instances.map((instance, index) => <tr key={instance.id} className="border-t border-ink-border"><td className="p-2"><input type="checkbox" disabled={!editable} checked={instance.enabled} onChange={event => setDraft({ ...draft, instances: draft.instances.map((item, position) => position === index ? { ...item, enabled: event.target.checked } : item) })} /></td><td className="p-2"><input className="control-input h-8" disabled={!editable} value={instance.name} onChange={event => setDraft({ ...draft, instances: draft.instances.map((item, position) => position === index ? { ...item, name: event.target.value } : item) })} /></td>{draft.parameters.map(parameter => <td key={parameter.id} className="p-2"><ParameterValue parameter={parameter} value={instance.values[parameter.name] ?? parameter.defaultValue} onChange={value => setDraft({ ...draft, instances: draft.instances.map((item, position) => position === index ? { ...item, values: { ...item.values, [parameter.name]: value } } : item) })} /></td>)}<td className="p-2"><input className="control-input h-8 w-20" type="number" disabled={!editable} value={instance.priorityOffset} onChange={event => setDraft({ ...draft, instances: draft.instances.map((item, position) => position === index ? { ...item, priorityOffset: Number(event.target.value) } : item) })} /></td>{editable && <td className="p-2"><button className="mr-2 text-brand-primary" title="复制实例" onClick={() => setDraft({ ...draft, instances: [...draft.instances.slice(0, index + 1), { ...structuredClone(instance), id: nextId('instance'), name: `${instance.name} 副本` }, ...draft.instances.slice(index + 1)] })}><Copy size={13} /></button><button className="text-[#c62828]" title="删除实例" onClick={() => setDraft({ ...draft, instances: draft.instances.filter((_, position) => position !== index) })}><Trash2 size={13} /></button></td>}</tr>)}</tbody></table></div></section>
      <label className="block text-[10px] font-semibold text-ink-3">业务说明<textarea className="mt-1 min-h-20 w-full border border-ink-border p-2 text-xs font-normal" readOnly={!editable} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
    </div>}</div>
    {editable && <footer className="flex min-h-12 shrink-0 items-center gap-2 border-t border-ink-border bg-[#fafafa] px-3 py-2">{notice ? <span className={`mr-auto text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span> : <span className="mr-auto text-[10px] text-ink-3">{dirty ? '有未保存的模板修改' : '模板草稿已同步'}</span>}<button className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-2.5 text-[11px] disabled:opacity-50" disabled={busy || !dirty || issues.length > 0} onClick={() => onSave && run(() => onSave(draft), '规则模板已保存')}><Save size={13} />保存草稿</button><button className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-2.5 text-[11px] disabled:opacity-50" disabled={busy || issues.length > 0} onClick={() => run(compile, 'Drools 编译通过')}><CheckCircle2 size={13} />编译</button><button className="inline-flex h-8 items-center gap-1 bg-brand-primary px-2.5 text-[11px] text-white disabled:opacity-50" disabled={busy || dirty || issues.length > 0} onClick={() => onSubmit && run(onSubmit, '已提交审核')}><Rocket size={13} />提交审核</button></footer>}
  </section>
}
