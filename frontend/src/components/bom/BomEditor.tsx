import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { bomDrlPreview, loadBomReferences, type BomReference, type SaveBomResult } from '../../api/bom'
import type { BomDataType, BomFactType, BomField, BomModel } from '../../types'
import DrlPreview from './DrlPreview'

interface BomEditorProps {
  model: BomModel
  projectId?: string
  saving: boolean
  onSave: (model: BomModel, acknowledgeImpact: boolean) => Promise<SaveBomResult>
  onCancel: () => void
  onSaved: (result: SaveBomResult) => void
}

interface FieldLocation {
  factIndex: number
  fieldIndex: number
}

interface ImpactItem {
  key: string
  text: string
}

const typeOptions: Array<{ value: BomDataType; label: string }> = [
  { value: 'Integer', label: 'Integer（整数）' },
  { value: 'Decimal', label: 'Decimal（高精度小数）' },
  { value: 'Boolean', label: 'Boolean（布尔）' },
  { value: 'String', label: 'String（字符串）' },
  { value: 'Enum', label: 'Enum（枚举）' },
  { value: 'Date', label: 'Date（日期）' },
  { value: 'List<String>', label: 'List<String>（字符串列表）' },
]

function Modal({ title, children, onClose, width = 'max-w-lg' }: { title: string; children: React.ReactNode; onClose: () => void; width?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className={`w-full ${width} border border-ink-border bg-white shadow-xl`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex h-11 items-center border-b border-ink-border bg-[#fafafa] px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" className="ml-auto inline-flex size-7 items-center justify-center text-ink-3 hover:bg-ink-bg hover:text-ink-1" onClick={onClose} title="关闭"><X size={15} /></button>
        </header>
        {children}
      </section>
    </div>
  )
}

function toCamelCase(value: string) {
  const words = value.trim().replace(/[^a-zA-Z0-9]+/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  return words[0].charAt(0).toLowerCase() + words[0].slice(1) + words.slice(1).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('')
}

function FactDialog({ facts, onClose, onSubmit }: { facts: BomFactType[]; onClose: () => void; onSubmit: (fact: BomFactType) => void }) {
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [direction, setDirection] = useState<'input' | 'output'>('input')
  const normalized = name.trim()
  const error = !/^[A-Z][a-zA-Z0-9_]{0,63}$/.test(normalized)
    ? '类名必须以大写字母开头，只能包含英文、数字和下划线'
    : facts.some(fact => fact.name === normalized) ? '该事实类型已经存在' : !label.trim() ? '请填写业务名称' : null
  return (
    <Modal title="新增事实类型" onClose={onClose}>
      <div className="space-y-4 p-4">
        <label className="block text-[11px] font-semibold text-ink-2">类名<input className="control-input mt-1 h-9 font-mono text-xs" value={name} onChange={event => setName(event.target.value.replace(/\s/g, ''))} placeholder="Borrower" autoFocus /></label>
        <label className="block text-[11px] font-semibold text-ink-2">业务名称<input className="control-input mt-1 h-9 text-xs" value={label} onChange={event => setLabel(event.target.value)} placeholder="借款申请人" /></label>
        <fieldset><legend className="mb-1.5 text-[11px] font-semibold text-ink-2">方向</legend><div className="flex gap-5 text-xs"><label className="flex items-center gap-1.5"><input type="radio" checked={direction === 'input'} onChange={() => setDirection('input')} />输入事实</label><label className="flex items-center gap-1.5"><input type="radio" checked={direction === 'output'} onChange={() => setDirection('output')} />输出事实</label></div></fieldset>
        {error && <p className="text-[11px] text-[#c62828]">{error}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] px-4 py-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={onClose}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={Boolean(error)} onClick={() => onSubmit({ name: normalized, label: label.trim(), direction, fields: [] })}>确认新增</button></footer>
    </Modal>
  )
}

function fieldKind(type: BomDataType) {
  if (type === 'Enum') return 'select'
  if (type === 'Boolean') return 'boolean'
  if (['Integer', 'Decimal'].includes(type)) return 'number'
  if (type === 'Date') return 'date'
  return 'text'
}

function FieldDialog({ fact, allFields, initial, onClose, onSubmit }: {
  fact: BomFactType
  allFields: BomField[]
  initial?: BomField
  onClose: () => void
  onSubmit: (field: BomField) => void
}) {
  const [key, setKey] = useState(initial?.key || '')
  const [label, setLabel] = useState(initial?.label || '')
  const [type, setType] = useState<BomDataType>(initial?.type || 'String')
  const [direction, setDirection] = useState<'input' | 'output'>(initial?.direction || (fact.direction === 'output' ? 'output' : 'input'))
  const [unit, setUnit] = useState(initial?.unit || '')
  const [min, setMin] = useState(initial?.min?.toString() || '')
  const [max, setMax] = useState(initial?.max?.toString() || '')
  const [enumText, setEnumText] = useState(initial?.enum?.join('，') || '')
  const [maxLength, setMaxLength] = useState(initial?.maxLength?.toString() || '')
  const [regex, setRegex] = useState(initial?.regex || '')
  const [allowDuplicates, setAllowDuplicates] = useState(initial?.allowDuplicates ?? true)
  const [required, setRequired] = useState(initial?.required ?? false)
  const normalizedKey = toCamelCase(key)
  const enumValues = enumText.split(/[,，]/).map(value => value.trim()).filter(Boolean)
  const keyTaken = allFields.some(field => field.key === normalizedKey && field !== initial)
  const error = !/^[a-z][a-zA-Z0-9_]{1,31}$/.test(normalizedKey)
    ? '字段名需转换为 2-32 位小驼峰英文标识符'
    : keyTaken ? '字段名在 BOM 中必须全局唯一'
      : !label.trim() ? '请填写业务说法'
        : type === 'Enum' && enumValues.length < 1 ? 'Enum 至少需要一个枚举值'
          : min && max && Number(min) > Number(max) ? '最小值不能大于最大值' : null
  const typeChanged = initial && initial.type !== type

  const submit = () => onSubmit({
    ...initial,
    key: normalizedKey,
    label: label.trim(),
    type,
    runtimeType: type === 'Decimal' ? 'Double' : ['Enum', 'Date', 'List<String>'].includes(type) ? 'String' : type as BomField['runtimeType'],
    direction,
    references: initial?.references || 0,
    enum: type === 'Enum' ? enumValues : null,
    unit: ['Integer', 'Decimal'].includes(type) ? unit.trim() || null : null,
    min: ['Integer', 'Decimal'].includes(type) && min !== '' ? Number(min) : null,
    max: ['Integer', 'Decimal'].includes(type) && max !== '' ? Number(max) : null,
    maxLength: type === 'String' && maxLength !== '' ? Number(maxLength) : null,
    regex: type === 'String' ? regex.trim() || null : null,
    allowDuplicates: type === 'List<String>' ? allowDuplicates : undefined,
    required: direction === 'input' ? required : undefined,
    control: fieldKind(type),
    group: initial?.group || fact.label,
    description: initial?.description || '',
  })

  return (
    <Modal title={initial ? `编辑字段 ${initial.key}` : `新增字段 · ${fact.label}`} onClose={onClose} width="max-w-xl">
      <div className="grid grid-cols-2 gap-4 p-4 max-sm:grid-cols-1">
        <label className="text-[11px] font-semibold text-ink-2">字段名<input className="control-input mt-1 h-9 font-mono text-xs" value={key} onChange={event => setKey(event.target.value)} placeholder="creditScore" autoFocus={!initial} /><span className="mt-1 block font-normal text-ink-3">存储为 {normalizedKey || '-'}</span></label>
        <label className="text-[11px] font-semibold text-ink-2">业务说法<input className="control-input mt-1 h-9 text-xs" value={label} onChange={event => setLabel(event.target.value)} placeholder="信用分" /></label>
        <label className="text-[11px] font-semibold text-ink-2">数据类型<select className="control-input mt-1 h-9 text-xs" value={type} onChange={event => setType(event.target.value as BomDataType)}>{typeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {fact.direction === 'mixed' && <label className="text-[11px] font-semibold text-ink-2">方向<select className="control-input mt-1 h-9 text-xs" value={direction} onChange={event => setDirection(event.target.value as 'input' | 'output')}><option value="input">输入</option><option value="output">输出</option></select></label>}
        {direction === 'input' && <label className="flex items-center gap-2 self-end pb-2 text-[11px] font-semibold text-ink-2"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)} />执行时必填</label>}
        {['Integer', 'Decimal'].includes(type) && <>
          <label className="text-[11px] font-semibold text-ink-2">最小值<input className="control-input mt-1 h-9 font-mono text-xs" type="number" step={type === 'Integer' ? 1 : 0.01} value={min} onChange={event => setMin(event.target.value)} /></label>
          <label className="text-[11px] font-semibold text-ink-2">最大值<input className="control-input mt-1 h-9 font-mono text-xs" type="number" step={type === 'Integer' ? 1 : 0.01} value={max} onChange={event => setMax(event.target.value)} /></label>
          <label className="text-[11px] font-semibold text-ink-2">单位<input className="control-input mt-1 h-9 text-xs" value={unit} onChange={event => setUnit(event.target.value)} placeholder="元 / 岁 / 月" /></label>
        </>}
        {type === 'Enum' && <label className="col-span-2 text-[11px] font-semibold text-ink-2 max-sm:col-span-1">枚举值<input className="control-input mt-1 h-9 text-xs" value={enumText} onChange={event => setEnumText(event.target.value)} placeholder="低，中，高，拒绝" /><span className="mt-1 block font-normal text-ink-3">{enumValues.length} 个枚举值</span></label>}
        {type === 'String' && <>
          <label className="text-[11px] font-semibold text-ink-2">最大长度<input className="control-input mt-1 h-9 font-mono text-xs" type="number" min={1} value={maxLength} onChange={event => setMaxLength(event.target.value)} /></label>
          <label className="text-[11px] font-semibold text-ink-2">正则约束<input className="control-input mt-1 h-9 font-mono text-xs" value={regex} onChange={event => setRegex(event.target.value)} placeholder="可选" /></label>
        </>}
        {type === 'List<String>' && <label className="col-span-2 flex items-center gap-2 text-[11px] font-semibold text-ink-2 max-sm:col-span-1"><input type="checkbox" checked={allowDuplicates} onChange={event => setAllowDuplicates(event.target.checked)} />允许重复元素</label>}
        {typeChanged && <div className="col-span-2 flex gap-2 border border-[#f3c65f] bg-[#fff8e1] p-2 text-[11px] text-[#734d00] max-sm:col-span-1"><AlertTriangle size={14} className="shrink-0" />类型由 {initial.type} 变更为 {type}，保存前将执行规则影响分析。</div>}
        {error && <p className="col-span-2 text-[11px] text-[#c62828] max-sm:col-span-1">{error}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] px-4 py-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={onClose}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={Boolean(error)} onClick={submit}>{initial ? '应用修改' : '确认新增'}</button></footer>
    </Modal>
  )
}

function impactItems(original: BomModel, draft: BomModel): ImpactItem[] {
  const before = new Map(original.factTypes.flatMap(fact => fact.fields.map(field => [field.key, { fact, field }] as const)))
  const after = new Map(draft.factTypes.flatMap(fact => fact.fields.map(field => [field.key, { fact, field }] as const)))
  const impacts: ImpactItem[] = []
  for (const [key, previous] of before) {
    const next = after.get(key)
    if (!next && previous.field.references > 0) impacts.push({ key: `remove:${key}`, text: `删除 ${previous.fact.name}.${key}，影响 ${previous.field.references} 个引用` })
    if (!next) continue
    if (previous.field.type !== next.field.type && previous.field.references > 0) impacts.push({ key: `type:${key}`, text: `${previous.fact.name}.${key} 类型由 ${previous.field.type} 变更为 ${next.field.type}` })
    const removedEnums = (previous.field.enum || []).filter(value => !(next.field.enum || []).includes(value))
    if (removedEnums.length && previous.field.references > 0) impacts.push({ key: `enum:${key}`, text: `${previous.fact.name}.${key} 删除枚举值：${removedEnums.join('、')}` })
  }
  return impacts
}

export default function BomEditor({ model, projectId = 'default', saving, onSave, onCancel, onSaved }: BomEditorProps) {
  const [draft, setDraft] = useState<BomModel>(() => structuredClone(model))
  const [factDialog, setFactDialog] = useState(false)
  const [fieldDialog, setFieldDialog] = useState<(FieldLocation & { mode: 'add' | 'edit' }) | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ factIndex: number; fieldIndex?: number } | null>(null)
  const [references, setReferences] = useState<BomReference[] | null>(null)
  const [saveConfirm, setSaveConfirm] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allFields = draft.factTypes.flatMap(fact => fact.fields)
  const impacts = useMemo(() => impactItems(model, draft), [model, draft])
  const emptyFact = draft.factTypes.find(fact => fact.fields.length === 0)
  const missingDirection = !allFields.some(field => field.direction === 'input') || !allFields.some(field => field.direction === 'output')

  const updateField = (factIndex: number, fieldIndex: number, field: BomField) => setDraft(current => ({
    ...current,
    factTypes: current.factTypes.map((fact, index) => index === factIndex ? { ...fact, fields: fact.fields.map((item, position) => position === fieldIndex ? field : item) } : fact),
  }))

  const openDelete = async (target: { factIndex: number; fieldIndex?: number }) => {
    setDeleteTarget(target)
    setReferences(null)
    const fields = target.fieldIndex == null ? draft.factTypes[target.factIndex].fields : [draft.factTypes[target.factIndex].fields[target.fieldIndex]]
    try {
      const lists = await Promise.all(fields.map(field => loadBomReferences(field.key, projectId)))
      setReferences([...new Map(lists.flat().map(reference => [`${reference.type}:${reference.id}`, reference])).values()])
    } catch (cause) {
      setReferences([])
      setError(cause instanceof Error ? cause.message : '无法读取字段引用')
    }
  }

  const confirmDelete = () => {
    if (!deleteTarget) return
    setDraft(current => ({
      ...current,
      factTypes: deleteTarget.fieldIndex == null
        ? current.factTypes.filter((_, index) => index !== deleteTarget.factIndex)
        : current.factTypes.map((fact, index) => index === deleteTarget.factIndex ? { ...fact, fields: fact.fields.filter((_, position) => position !== deleteTarget.fieldIndex) } : fact),
    }))
    setDeleteTarget(null)
    setReferences(null)
  }

  const commit = async (acknowledgeImpact: boolean) => {
    setError(null)
    try {
      const result = await onSave(draft, acknowledgeImpact)
      onSaved(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'BOM 保存失败')
      setSaveConfirm(false)
    }
  }

  const requestSave = () => {
    if (emptyFact) { setError(`事实类型 ${emptyFact.label} 至少需要一个字段`); return }
    if (missingDirection) { setError('BOM 至少需要一个输入字段和一个输出字段'); return }
    if (impacts.length) { setAcknowledged(false); setSaveConfirm(true); return }
    void commit(false)
  }

  return (
    <>
      <div className="mb-3 flex min-h-10 items-center gap-3 border border-[#f3c65f] bg-[#fff8e1] px-3 py-2 text-[11px] text-[#734d00]">
        <AlertTriangle size={15} className="shrink-0" /><span>正在编辑 BOM，保存后将影响所有规则资产。</span>
        {error && <span className="ml-2 truncate text-[#c62828]">{error}</span>}
        <div className="ml-auto flex shrink-0 gap-2"><button className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-3 text-[11px] text-ink-2" onClick={onCancel}><X size={13} />取消</button><button className="inline-flex h-8 items-center gap-1 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-50" disabled={saving} onClick={requestSave}><Save size={13} />{saving ? '保存中...' : '保存模型'}</button></div>
      </div>

      <div className="grid grid-cols-[320px_minmax(600px,1fr)] gap-[14px] max-lg:grid-cols-1">
        <div className="space-y-3">
          {draft.factTypes.map((fact, factIndex) => (
            <section key={`${fact.name}-${factIndex}`} className="border border-ink-border bg-white">
              <header className="flex min-h-10 items-center gap-2 border-b border-ink-border bg-[#fafafa] px-3">
                <div className="min-w-0"><h2 className="truncate text-xs font-semibold"><code className="font-mono">{fact.name}</code> {fact.label}</h2><span className="text-[10px] text-ink-3">{fact.direction === 'mixed' ? '输入/输出事实' : fact.direction === 'output' ? '输出事实' : '输入事实'}</span></div>
                <button type="button" className="ml-auto inline-flex size-7 items-center justify-center text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={() => void openDelete({ factIndex })} title="删除事实类型"><Trash2 size={13} /></button>
              </header>
              <div>
                {fact.fields.map((field, fieldIndex) => (
                  <div id={`bom-field-${field.key}`} key={field.key} className="group flex min-h-10 items-center gap-2 border-b border-[#e8e8e8] px-3 hover:bg-[#f0f6fc]">
                    <span className="min-w-0 flex-1 truncate text-[11px]"><code className="font-mono">{field.key}</code><span className="ml-1.5 text-ink-3">{field.label}</span></span>
                    <span className="shrink-0 text-[10px] text-ink-3">{field.type}</span>
                    <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"><button type="button" className="inline-flex size-7 items-center justify-center text-ink-3 hover:text-brand-primary" onClick={() => setFieldDialog({ factIndex, fieldIndex, mode: 'edit' })} title="编辑字段"><Pencil size={12} /></button><button type="button" className="inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828]" onClick={() => void openDelete({ factIndex, fieldIndex })} title="删除字段"><Trash2 size={12} /></button></div>
                  </div>
                ))}
              </div>
              <button type="button" className="inline-flex h-9 w-full items-center justify-center gap-1 text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={() => setFieldDialog({ factIndex, fieldIndex: fact.fields.length, mode: 'add' })}><Plus size={13} />新增字段</button>
            </section>
          ))}
          <button type="button" className="inline-flex h-9 w-full items-center justify-center gap-1 border border-dashed border-brand-primary bg-white text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={() => setFactDialog(true)}><Plus size={13} />新增事实类型</button>
          <section className="border border-ink-border bg-white"><header className="border-b border-ink-border bg-[#fafafa] px-3 py-2 text-xs font-semibold">对象关系</header><div className="space-y-1 px-3 py-2 text-[11px]">{draft.factTypes.map(fact => <p key={fact.name}>调用请求 → {fact.label} <span className="text-ink-3">1</span></p>)}</div></section>
        </div>

        <div className="min-w-0 space-y-[14px]">
          <section className="overflow-hidden border border-ink-border bg-white">
            <header className="border-b border-ink-border bg-[#fafafa] px-3 py-2 text-xs font-semibold">业务词汇表</header>
            <div className="overflow-x-auto"><table className="w-full min-w-[620px] border-collapse text-left text-xs"><thead className="bg-[#fafafa] text-[11px] text-ink-2"><tr><th className="border-b border-ink-border px-3 py-2">BOM 属性</th><th className="border-b border-ink-border px-3 py-2">业务说法</th><th className="border-b border-ink-border px-3 py-2">类型</th><th className="w-16 border-b border-ink-border px-3 py-2 text-right">引用</th></tr></thead><tbody>
              {draft.factTypes.flatMap((fact, factIndex) => fact.fields.map((field, fieldIndex) => <tr key={`${fact.name}.${field.key}`} className="border-b border-[#e8e8e8] last:border-0"><td className="px-3 py-1.5 font-mono text-[11px]">{fact.name}.{field.key}</td><td className="px-3 py-1"><input className="h-7 w-full border border-transparent bg-transparent px-1.5 text-xs outline-none hover:border-ink-border focus:border-brand-primary focus:bg-white" value={field.label} onChange={event => updateField(factIndex, fieldIndex, { ...field, label: event.target.value })} /></td><td className="px-3 py-1.5 text-[11px] text-ink-3">{field.type}</td><td className="px-3 py-1.5 text-right text-[11px] text-ink-3">{field.references}</td></tr>))}
            </tbody></table></div>
          </section>
          <DrlPreview drl={bomDrlPreview(draft)} />
        </div>
      </div>

      {factDialog && <FactDialog facts={draft.factTypes} onClose={() => setFactDialog(false)} onSubmit={fact => { setDraft(current => ({ ...current, factTypes: [...current.factTypes, fact] })); setFactDialog(false) }} />}
      {fieldDialog && <FieldDialog key={`${fieldDialog.factIndex}:${fieldDialog.fieldIndex}:${fieldDialog.mode}`} fact={draft.factTypes[fieldDialog.factIndex]} allFields={allFields} initial={fieldDialog.mode === 'edit' ? draft.factTypes[fieldDialog.factIndex].fields[fieldDialog.fieldIndex] : undefined} onClose={() => setFieldDialog(null)} onSubmit={field => { setDraft(current => ({ ...current, factTypes: current.factTypes.map((fact, index) => index === fieldDialog.factIndex ? { ...fact, fields: fieldDialog.mode === 'edit' ? fact.fields.map((item, position) => position === fieldDialog.fieldIndex ? field : item) : [...fact.fields, field] } : fact) })); setFieldDialog(null) }} />}
      {deleteTarget && <Modal title={deleteTarget.fieldIndex == null ? '删除事实类型' : '删除字段'} onClose={() => setDeleteTarget(null)}><div className="space-y-3 p-4 text-xs"><p>确定删除 <b>{deleteTarget.fieldIndex == null ? draft.factTypes[deleteTarget.factIndex].label : `${draft.factTypes[deleteTarget.factIndex].name}.${draft.factTypes[deleteTarget.factIndex].fields[deleteTarget.fieldIndex].key}`}</b>？</p>{references == null ? <p className="text-ink-3">正在读取引用...</p> : references.length ? <><p className="text-[#a31515]">该对象被以下 {references.length} 个资产引用，删除后资产将标红：</p><ul className="max-h-40 overflow-auto border border-[#ef9a9a] bg-[#fffafa] p-2">{references.map(reference => <li key={`${reference.type}:${reference.id}`} className="flex justify-between py-1"><span>{reference.name}</span><span className="text-[10px] text-ink-3">{reference.type === 'decision-table' ? '决策表' : reference.type === 'flow' ? '规则集' : '规则'}</span></li>)}</ul></> : <p className="text-ink-3">没有资产引用该对象。</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] px-4 py-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDeleteTarget(null)}>取消</button><button className="h-8 bg-[#c62828] px-3 text-[11px] text-white disabled:opacity-40" disabled={references == null} onClick={confirmDelete}>确认删除</button></footer></Modal>}
      {saveConfirm && <Modal title="确认 BOM 变更影响" onClose={() => setSaveConfirm(false)}><div className="space-y-3 p-4 text-xs"><p>以下变更可能使现有规则失效：</p><ul className="border border-[#f3c65f] bg-[#fff8e1] p-2">{impacts.map(impact => <li key={impact.key} className="flex gap-2 py-1"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{impact.text}</li>)}</ul><label className="flex items-start gap-2"><input className="mt-0.5" type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>我已知晓这些影响，并确认保存 BOM。</span></label></div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] px-4 py-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setSaveConfirm(false)}>取消</button><button className="inline-flex h-8 items-center gap-1 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={!acknowledged || saving} onClick={() => void commit(true)}><Check size={13} />确认保存</button></footer></Modal>}
    </>
  )
}
