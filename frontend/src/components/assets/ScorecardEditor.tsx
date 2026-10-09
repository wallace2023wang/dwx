import { Calculator, CheckCircle2, FileCode2, Plus, Rocket, Save, Trash2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { AssetDetail, BomField, ScorecardBandDraft, ScorecardBinDraft, ScorecardCharacteristicDraft, ScorecardDraft } from '../../types'
import { operatorsForType } from '../../domain/bomTypes'
import { ActionRow, defaultLiteralValue, factsFor } from './BalRuleView'
import BomVersionNotice from './BomVersionNotice'

const MonacoTextEditor = lazy(() => import('./MonacoTextEditor'))
const binOperators = new Set(['==', '!=', '>', '>=', '<', '<='])

interface Props {
  detail: AssetDetail
  fields: BomField[]
  busy?: boolean
  editable?: boolean
  onSave?: (draft: ScorecardDraft) => Promise<void>
  onCompile?: (draft: ScorecardDraft) => Promise<{ engineVersion: string; drl: string }>
  onSubmit?: () => Promise<void>
}

const nextId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

function defaultOperator(field?: BomField) {
  return field?.type === 'Boolean' ? '==' : operatorsForType(field?.type).find(operator => binOperators.has(operator.value))?.value || '=='
}

function valueFor(field?: BomField) {
  return defaultLiteralValue(field, defaultOperator(field))
}

function issuesFor(draft: ScorecardDraft, fields: BomField[]) {
  const issues: string[] = []
  const scoreField = fields.find(field => field.key === draft.scoreOutputField && field.direction === 'output')
  if (!scoreField || !['Integer', 'Decimal'].includes(scoreField.type)) issues.push('请选择数值输出字段保存总分')
  if (!Number.isFinite(draft.initialScore)) issues.push('初始分无效')
  if (!draft.characteristics.length) issues.push('至少需要一个评分特征')
  for (const characteristic of draft.characteristics) {
    const field = fields.find(candidate => candidate.key === characteristic.field && candidate.direction === 'input')
    if (!field) issues.push(`评分特征“${characteristic.name}”引用的输入字段不存在`)
    if (characteristic.rows.length < 2) issues.push(`评分特征“${characteristic.name}”至少需要一个条件分箱和一个默认分箱`)
    if (characteristic.rows.filter(row => row.default).length !== 1 || !characteristic.rows[characteristic.rows.length - 1]?.default) issues.push(`评分特征“${characteristic.name}”必须以唯一默认分箱结尾`)
    if (characteristic.rows.some(row => !Number.isFinite(row.score))) issues.push(`评分特征“${characteristic.name}”存在无效分值`)
  }
  if (!draft.bands.length) issues.push('至少需要一个结果分段')
  draft.bands.forEach((band, index) => {
    if (index === 0 && band.min !== null) issues.push('第一个结果分段必须从负无穷开始')
    if (index === draft.bands.length - 1 && band.max !== null) issues.push('最后一个结果分段必须覆盖到正无穷')
    if (index > 0 && draft.bands[index - 1].max !== band.min) issues.push(`结果分段“${band.label}”与前一段不连续`)
  })
  return [...new Set(issues)]
}

function BinValue({ row, field, onChange }: { row: ScorecardBinDraft; field?: BomField; onChange: (row: ScorecardBinDraft) => void }) {
  if (field?.type === 'Boolean') return <select className="control-input h-8 min-w-24" value={row.value || 'true'} onChange={event => onChange({ ...row, value: event.target.value })}><option value="true">true</option><option value="false">false</option></select>
  if (field?.enum?.length) return <select className="control-input h-8 min-w-32" value={row.value || ''} onChange={event => onChange({ ...row, value: event.target.value })}>{field.enum.map(value => <option key={value}>{value}</option>)}</select>
  return <input className="control-input h-8 min-w-28" type={field?.type === 'Integer' || field?.type === 'Decimal' ? 'number' : field?.type === 'Date' ? 'date' : 'text'} value={row.value || ''} onChange={event => onChange({ ...row, value: event.target.value })} />
}

function CharacteristicEditor({ characteristic, fields, editable, onChange, onDelete }: { characteristic: ScorecardCharacteristicDraft; fields: BomField[]; editable: boolean; onChange: (characteristic: ScorecardCharacteristicDraft) => void; onDelete: () => void }) {
  const inputs = fields.filter(field => field.direction === 'input')
  const field = inputs.find(candidate => candidate.key === characteristic.field)
  const operators = operatorsForType(field?.type).filter(operator => binOperators.has(operator.value))
  const changeField = (fieldKey: string) => {
    const next = inputs.find(candidate => candidate.key === fieldKey)
    onChange({ ...characteristic, field: fieldKey, rows: characteristic.rows.map(row => row.default ? row : { ...row, operator: defaultOperator(next), value: valueFor(next) }) })
  }
  const addBin = () => {
    const rows = [...characteristic.rows]
    rows.splice(Math.max(0, rows.length - 1), 0, { id: nextId('bin'), label: '新分箱', operator: defaultOperator(field), value: valueFor(field), score: 0 })
    onChange({ ...characteristic, rows })
  }
  return <section className="overflow-hidden rounded-[4px] border border-ink-border bg-white">
    <header className="flex items-center gap-2 border-b border-ink-border bg-[#fafafa] p-3">{editable ? <><input className="control-input h-8 min-w-40 flex-1 font-semibold" value={characteristic.name} onChange={event => onChange({ ...characteristic, name: event.target.value })} /><select className="control-input h-8 min-w-40" value={characteristic.field} onChange={event => changeField(event.target.value)}>{inputs.map(input => <option key={input.key} value={input.key}>{input.label}</option>)}</select><button className="inline-flex size-8 items-center justify-center text-[#c62828] hover:bg-[#fff1f1]" onClick={onDelete}><Trash2 size={13} /></button></> : <><strong className="text-xs">{characteristic.name}</strong><span className="text-[11px] text-ink-3">{field?.label || characteristic.field}</span></>}</header>
    <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-[11px]"><thead className="bg-[#f7f7f7] text-ink-3"><tr><th className="px-2 py-1.5 text-left">分箱</th><th className="px-2 py-1.5 text-left">比较</th><th className="px-2 py-1.5 text-left">值</th><th className="px-2 py-1.5 text-right">分值</th>{editable && <th className="w-10" />}</tr></thead><tbody>{characteristic.rows.map(row => <tr key={row.id} className="border-t border-ink-border"><td className="px-2 py-2">{editable ? <input className="control-input h-8" value={row.label} onChange={event => onChange({ ...characteristic, rows: characteristic.rows.map(item => item.id === row.id ? { ...item, label: event.target.value } : item) })} /> : row.label}</td><td className="px-2 py-2">{row.default ? <span className="rounded bg-[#fff3e0] px-2 py-1 text-[#8a5a00]">默认</span> : editable ? <select className="control-input h-8" value={row.operator} onChange={event => onChange({ ...characteristic, rows: characteristic.rows.map(item => item.id === row.id ? { ...item, operator: event.target.value } : item) })}>{operators.map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select> : row.operator}</td><td className="px-2 py-2">{row.default ? '其他所有值' : editable ? <BinValue row={row} field={field} onChange={next => onChange({ ...characteristic, rows: characteristic.rows.map(item => item.id === row.id ? next : item) })} /> : row.value}</td><td className="px-2 py-2 text-right">{editable ? <input className="control-input ml-auto h-8 w-24 text-right font-mono" type="number" value={row.score} onChange={event => onChange({ ...characteristic, rows: characteristic.rows.map(item => item.id === row.id ? { ...item, score: Number(event.target.value) } : item) })} /> : row.score}</td>{editable && <td className="px-1">{!row.default && <button className="inline-flex size-7 items-center justify-center text-[#c62828] hover:bg-[#fff1f1]" onClick={() => onChange({ ...characteristic, rows: characteristic.rows.filter(item => item.id !== row.id) })}><Trash2 size={12} /></button>}</td>}</tr>)}</tbody></table></div>
    {editable && <button className="m-2 inline-flex h-7 items-center gap-1 px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l" onClick={addBin}><Plus size={12} />添加条件分箱</button>}
  </section>
}

function BandEditor({ band, index, count, fields, scoreOutputField, editable, onChange, onDelete }: { band: ScorecardBandDraft; index: number; count: number; fields: BomField[]; scoreOutputField: string; editable: boolean; onChange: (band: ScorecardBandDraft) => void; onDelete: () => void }) {
  const outputFacts = useMemo(() => factsFor(fields, 'output'), [fields])
  const outputs = fields.filter(field => field.direction === 'output' && field.key !== scoreOutputField)
  const addAction = () => {
    const field = outputs.find(candidate => !band.actions.some(action => action.field === candidate.key)) || outputs[0]
    if (field) onChange({ ...band, actions: [...band.actions, { field: field.key, value: defaultLiteralValue(field) }] })
  }
  return <section className="rounded-[4px] border border-[#e4c77a] bg-[#fffaf0] p-3"><div className="flex flex-wrap items-center gap-2">{editable ? <input className="control-input h-8 min-w-36 flex-1 font-semibold" value={band.label} onChange={event => onChange({ ...band, label: event.target.value })} /> : <strong>{band.label}</strong>}<span className="text-ink-3">总分</span>{index === 0 ? <span className="font-mono">−∞</span> : editable ? <input className="control-input h-8 w-24 font-mono" type="number" value={band.min ?? ''} onChange={event => onChange({ ...band, min: Number(event.target.value) })} /> : band.min}<span>≤ 分数 &lt;</span>{index === count - 1 ? <span className="font-mono">+∞</span> : editable ? <input className="control-input h-8 w-24 font-mono" type="number" value={band.max ?? ''} onChange={event => onChange({ ...band, max: Number(event.target.value) })} /> : band.max}{editable && count > 1 && <button className="ml-auto inline-flex size-8 items-center justify-center text-[#c62828] hover:bg-[#fff1f1]" onClick={onDelete}><Trash2 size={13} /></button>}</div><div className="mt-2 space-y-2">{band.actions.map((action, actionIndex) => <ActionRow key={`${action.field}-${actionIndex}`} action={action} index={actionIndex} count={band.actions.length} facts={outputFacts} allFields={fields} variables={[]} methods={[]} editable={editable} onChange={next => onChange({ ...band, actions: band.actions.map((item, position) => position === actionIndex ? next : item) })} onMove={() => {}} onDelete={() => onChange({ ...band, actions: band.actions.filter((_, position) => position !== actionIndex) })} />)}</div>{editable && <button className="mt-2 inline-flex h-7 items-center gap-1 px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l" onClick={addAction}><Plus size={12} />添加结果动作</button>}</section>
}

export default function ScorecardEditor({ detail, fields, busy = false, editable = false, onSave, onCompile, onSubmit }: Props) {
  const source = detail.draft as ScorecardDraft
  const [draft, setDraft] = useState(() => structuredClone(source))
  const [view, setView] = useState<'scorecard' | 'drl'>('scorecard')
  const [drl, setDrl] = useState(detail.content || '')
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  useEffect(() => { setDraft(structuredClone(source)); setDrl(detail.content || ''); setView('scorecard'); setNotice(null) }, [detail.id, detail.revision])
  const inputs = fields.filter(field => field.direction === 'input')
  const numericOutputs = fields.filter(field => field.direction === 'output' && ['Integer', 'Decimal'].includes(field.type))
  const issues = issuesFor(draft, fields)
  const dirty = JSON.stringify(draft) !== JSON.stringify(source)
  const addCharacteristic = () => {
    const field = inputs.find(candidate => !draft.characteristics.some(characteristic => characteristic.field === candidate.key)) || inputs[0]
    if (!field) return
    setDraft({ ...draft, characteristics: [...draft.characteristics, { id: nextId('characteristic'), name: field.label, field: field.key, rows: [{ id: nextId('bin'), label: '条件分箱', operator: defaultOperator(field), value: valueFor(field), score: 0 }, { id: nextId('bin'), label: '其他', default: true, score: 0 }] }] })
  }
  const addBand = () => {
    const bands = [...draft.bands]
    const last = bands[bands.length - 1]
    const boundary = last?.min === null ? 0 : Number(last?.min || 0) + 10
    if (last) last.max = boundary
    bands.push({ id: nextId('band'), label: '新分段', min: boundary, max: null, actions: [] })
    setDraft({ ...draft, bands })
  }
  const run = async (action: () => Promise<unknown>, success: string) => { setNotice(null); try { await action(); setNotice({ error: false, text: success }) } catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : '操作失败' }) } }
  const compile = async () => { if (!onCompile) return; const result = await onCompile(draft); setDrl(result.drl) }
  return <section className="flex h-full min-w-[500px] flex-1 flex-col overflow-hidden bg-white" aria-label="计分卡编辑器"><header className="shrink-0 border-b border-ink-border px-4 py-3"><div className="flex items-center gap-2"><Calculator size={16} className="text-[#a15c00]" />{editable ? <input className="min-w-0 flex-1 border-0 border-b border-transparent text-[15px] font-semibold outline-none focus:border-brand-primary" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /> : <h2 className="flex-1 text-[15px] font-semibold">{draft.name}</h2>}<span className="rounded bg-[#fff3e0] px-2 py-0.5 text-[10px] text-[#a15c00]">计分卡</span><span className="text-[11px] text-ink-3">v{detail.version} · r{detail.revision}</span></div><div className="mt-2 flex flex-wrap items-end gap-3 text-[11px]"><label>规则包{editable ? <input className="control-input ml-1 h-7 w-32" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} /> : `：${draft.category}`}</label><label>初始分{editable ? <input className="control-input ml-1 h-7 w-24" type="number" value={draft.initialScore} onChange={event => setDraft({ ...draft, initialScore: Number(event.target.value) })} /> : `：${draft.initialScore}`}</label><label>总分字段{editable ? <select className="control-input ml-1 h-7 min-w-36" value={draft.scoreOutputField} onChange={event => setDraft({ ...draft, scoreOutputField: event.target.value })}>{numericOutputs.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select> : `：${fields.find(field => field.key === draft.scoreOutputField)?.label || draft.scoreOutputField}`}</label><button className={`ml-auto h-7 px-2 text-[10px] ${view === 'scorecard' ? 'bg-brand-primary text-white' : 'border border-ink-border'}`} onClick={() => setView('scorecard')}>计分卡设计</button><button className={`h-7 px-2 text-[10px] ${view === 'drl' ? 'bg-brand-primary text-white' : 'border border-ink-border'}`} onClick={() => setView('drl')}><FileCode2 size={11} className="mr-1 inline" />DRL</button></div></header><BomVersionNotice detail={detail} />{issues.length > 0 && <div className="border-b border-[#ef9a9a] bg-[#fff1f1] px-4 py-2 text-[11px] text-[#a31515]">{issues[0]}{issues.length > 1 ? `，另有 ${issues.length - 1} 项问题` : ''}</div>}<div className="min-h-0 flex-1 overflow-auto">{view === 'drl' ? <div className="h-full min-h-[420px]"><Suspense fallback={<div className="p-5 text-[11px] text-ink-3">正在加载 DRL...</div>}><MonacoTextEditor value={drl} /></Suspense></div> : <div className="space-y-5 p-4"><section><div className="mb-2 flex items-center"><h3 className="text-xs font-semibold">评分特征</h3>{editable && <button className="ml-auto inline-flex h-7 items-center gap-1 px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l" onClick={addCharacteristic}><Plus size={12} />添加特征</button>}</div><div className="space-y-3">{draft.characteristics.map(characteristic => <CharacteristicEditor key={characteristic.id} characteristic={characteristic} fields={fields} editable={editable} onChange={next => setDraft({ ...draft, characteristics: draft.characteristics.map(item => item.id === characteristic.id ? next : item) })} onDelete={() => setDraft({ ...draft, characteristics: draft.characteristics.filter(item => item.id !== characteristic.id) })} />)}</div></section><section><div className="mb-2 flex items-center"><h3 className="text-xs font-semibold">结果分段</h3>{editable && <button className="ml-auto inline-flex h-7 items-center gap-1 px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l" onClick={addBand}><Plus size={12} />添加分段</button>}</div><div className="space-y-3">{draft.bands.map((band, index) => <BandEditor key={band.id} band={band} index={index} count={draft.bands.length} fields={fields} scoreOutputField={draft.scoreOutputField} editable={editable} onChange={next => { const bands = draft.bands.map(item => item.id === band.id ? next : item); if (index > 0) bands[index - 1] = { ...bands[index - 1], max: next.min }; if (index < bands.length - 1) bands[index + 1] = { ...bands[index + 1], min: next.max }; setDraft({ ...draft, bands }) }} onDelete={() => { const bands = draft.bands.filter(item => item.id !== band.id); if (bands.length) { bands[0] = { ...bands[0], min: null }; bands[bands.length - 1] = { ...bands[bands.length - 1], max: null }; for (let position = 1; position < bands.length; position += 1) bands[position] = { ...bands[position], min: bands[position - 1].max }; } setDraft({ ...draft, bands }) }} />)}</div></section><label className="block text-[10px] font-semibold text-ink-3">业务说明<textarea className="mt-1 min-h-20 w-full border border-ink-border p-2 text-xs font-normal" readOnly={!editable} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></div>}</div>{editable && <footer className="flex min-h-12 shrink-0 items-center gap-2 border-t border-ink-border bg-[#fafafa] px-3 py-2">{notice ? <span className={`mr-auto text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span> : <span className="mr-auto text-[10px] text-ink-3">{dirty ? '有未保存的计分卡修改' : '计分卡草稿已同步'}</span>}<button className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-2.5 text-[11px] disabled:opacity-50" disabled={busy || !dirty || issues.length > 0} onClick={() => onSave && run(() => onSave(draft), '计分卡草稿已保存')}><Save size={13} />保存草稿</button><button className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-2.5 text-[11px] disabled:opacity-50" disabled={busy || issues.length > 0} onClick={() => run(compile, 'Drools 编译通过')}><CheckCircle2 size={13} />编译</button><button className="inline-flex h-8 items-center gap-1 bg-brand-primary px-2.5 text-[11px] text-white disabled:opacity-50" disabled={busy || dirty || issues.length > 0} onClick={() => onSubmit && run(onSubmit, '已提交审核')}><Rocket size={13} />提交审核</button></footer>}</section>
}
