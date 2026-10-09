import { CheckCircle2, FileCode2, GitFork, Plus, Rocket, Save, Trash2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { AssetDetail, BomField, BomMethod, DecisionTreeDraft, DecisionTreeNode, RuleFieldConditionDraft, RuleSetVariable } from '../../types'
import { defaultOperatorForType, operatorsForType } from '../../domain/bomTypes'
import { ActionRow, defaultLiteralValue, factsFor, validateBalDraft } from './BalRuleView'
import BomVersionNotice from './BomVersionNotice'

const MonacoTextEditor = lazy(() => import('./MonacoTextEditor'))
const branchOperators = new Set(['==', '!=', '>', '>=', '<', '<='])

interface Props {
  detail: AssetDetail
  fields: BomField[]
  projectVariables?: RuleSetVariable[]
  busy?: boolean
  editable?: boolean
  onSave?: (draft: DecisionTreeDraft) => Promise<void>
  onCompile?: (draft: DecisionTreeDraft) => Promise<{ engineVersion: string; drl: string }>
  onSubmit?: () => Promise<void>
}

const nextId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

function valueFor(field: BomField | undefined) {
  return defaultLiteralValue(field, field?.type === 'Boolean' ? '==' : defaultOperatorForType(field?.type))
}

function resultNode(field: BomField | undefined, label = ''): DecisionTreeNode {
  return { id: nextId('result'), type: 'result', label, actions: field ? [{ field: field.key, value: valueFor(field) }] : [] }
}

function nodeIssues(node: DecisionTreeNode, fields: BomField[], variables: RuleSetVariable[], methods: BomMethod[], depth = 1): string[] {
  if (depth > 8) return ['决策树最多支持 8 层']
  if (node.type === 'result') {
    if (!node.actions.length) return [`结果“${node.label || node.id}”至少需要一个动作`]
    const actionIssues = validateBalDraft({ name: '结果校验', description: '', category: 'validation', priority: 0, conditions: [{ field: fields.find(field => field.direction === 'input')?.key || '', operator: '==', value: '0' }], actions: node.actions }, fields, variables, methods)
      .filter(issue => issue.includes('动作'))
    return actionIssues.map(issue => `结果“${node.label || node.id}”：${issue}`)
  }
  const field = fields.find(candidate => candidate.direction === 'input' && candidate.key === node.condition.field)
  const issues = !field ? ['条件引用的输入字段不存在'] : !branchOperators.has(node.condition.operator) ? ['条件运算符不支持“是/否”分支'] : !node.condition.value.trim() ? ['条件值不能为空'] : []
  return [...issues, ...nodeIssues(node.trueChild, fields, variables, methods, depth + 1), ...nodeIssues(node.falseChild, fields, variables, methods, depth + 1)]
}

function ConditionValue({ condition, field, editable, onChange }: { condition: RuleFieldConditionDraft; field?: BomField; editable: boolean; onChange: (condition: RuleFieldConditionDraft) => void }) {
  if (!editable) return <code className="rounded-[2px] bg-white px-2 py-1 font-mono text-[11px]">{condition.value}</code>
  if (field?.type === 'Boolean') return <select className="control-input h-8 w-24" value={condition.value} onChange={event => onChange({ ...condition, value: event.target.value })}><option value="true">true</option><option value="false">false</option></select>
  if (field?.enum?.length) return <select className="control-input h-8 min-w-32" value={condition.value} onChange={event => onChange({ ...condition, value: event.target.value })}>{field.enum.map(value => <option key={value}>{value}</option>)}</select>
  const type = field?.type === 'Integer' || field?.type === 'Decimal' ? 'number' : field?.type === 'Date' ? 'date' : 'text'
  return <input className="control-input h-8 min-w-28 flex-1" type={type} value={condition.value} onChange={event => onChange({ ...condition, value: event.target.value })} />
}

function TreeNodeEditor({ node, fields, variables, methods, editable, depth, onChange }: {
  node: DecisionTreeNode
  fields: BomField[]
  variables: RuleSetVariable[]
  methods: BomMethod[]
  editable: boolean
  depth: number
  onChange: (node: DecisionTreeNode) => void
}) {
  const inputs = fields.filter(field => field.direction === 'input')
  const outputs = fields.filter(field => field.direction === 'output')
  const outputFacts = useMemo(() => factsFor(fields, 'output'), [fields])
  if (node.type === 'result') {
    const addAction = () => {
      const field = outputs.find(candidate => !node.actions.some(action => action.field === candidate.key)) || outputs[0]
      if (field) onChange({ ...node, actions: [...node.actions, { field: field.key, value: valueFor(field) }] })
    }
    const split = () => {
      const field = inputs[0]
      if (!field) return
      const operator = field.type === 'Boolean' ? '==' : operatorsForType(field.type).find(option => branchOperators.has(option.value))?.value || '=='
      onChange({
        id: nextId('condition'), type: 'condition', condition: { field: field.key, operator, value: valueFor(field) },
        trueChild: { ...structuredClone(node), id: nextId('result') }, falseChild: resultNode(outputs[0], '其他结果'),
      })
    }
    return <section className="rounded-[4px] border border-[#9fd5ad] bg-[#f3fbf5] p-3">
      <div className="mb-2 flex items-center gap-2"><span className="rounded bg-[#dff3e4] px-2 py-0.5 text-[10px] font-semibold text-[#287a3d]">结果</span>{editable ? <input className="h-7 min-w-40 flex-1 border-0 border-b border-[#9fd5ad] bg-transparent px-1 text-xs font-semibold outline-none" value={node.label} placeholder="结果名称" onChange={event => onChange({ ...node, label: event.target.value })} /> : <strong className="text-xs">{node.label || '未命名结果'}</strong>}{editable && depth < 8 && <button className="ml-auto inline-flex h-7 items-center gap-1 px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l" onClick={split}><GitFork size={12} />继续判断</button>}</div>
      <div className="space-y-2">{node.actions.map((action, index) => <ActionRow key={`${action.field}-${index}`} action={action} index={index} count={node.actions.length} facts={outputFacts} allFields={fields} variables={variables} methods={methods} editable={editable} onChange={next => onChange({ ...node, actions: node.actions.map((item, position) => position === index ? next : item) })} onMove={offset => { const target = index + offset; if (target < 0 || target >= node.actions.length) return; const actions = [...node.actions]; [actions[index], actions[target]] = [actions[target], actions[index]]; onChange({ ...node, actions }) }} onDelete={() => onChange({ ...node, actions: node.actions.filter((_, position) => position !== index) })} />)}</div>
      {editable && <button className="mt-2 inline-flex h-7 items-center gap-1 px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l" onClick={addAction}><Plus size={12} />添加动作</button>}
    </section>
  }
  const field = inputs.find(candidate => candidate.key === node.condition.field)
  const operators = operatorsForType(field?.type).filter(operator => branchOperators.has(operator.value))
  const changeField = (fieldKey: string) => {
    const next = inputs.find(candidate => candidate.key === fieldKey)
    const operator = next?.type === 'Boolean' ? '==' : operatorsForType(next?.type).find(option => branchOperators.has(option.value))?.value || '=='
    onChange({ ...node, condition: { field: fieldKey, operator, value: valueFor(next) } })
  }
  return <section className="rounded-[4px] border border-[#9bbcf7] bg-[#f6f9ff] p-3">
    <div className="mb-3 flex flex-wrap items-center gap-2"><span className="rounded bg-brand-primary-l px-2 py-0.5 text-[10px] font-semibold text-brand-primary">判断</span>{editable ? <><select className="control-input h-8 min-w-40" value={node.condition.field} onChange={event => changeField(event.target.value)}>{inputs.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select><select className="control-input h-8 min-w-28" value={node.condition.operator} onChange={event => onChange({ ...node, condition: { ...node.condition, operator: event.target.value } })}>{operators.map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select></> : <><strong>{field?.label || node.condition.field}</strong><span>{operators.find(operator => operator.value === node.condition.operator)?.label || node.condition.operator}</span></>}<ConditionValue condition={node.condition} field={field} editable={editable} onChange={condition => onChange({ ...node, condition })} />{editable && depth > 1 && <button className="ml-auto inline-flex h-7 items-center gap-1 px-2 text-[10px] text-[#a31515] hover:bg-[#fff1f1]" onClick={() => onChange(resultNode(outputs[0], '合并结果'))}><Trash2 size={12} />转为结果</button>}</div>
    <div className="grid grid-cols-2 gap-3 max-xl:grid-cols-1"><div><div className="mb-1 text-[10px] font-semibold text-[#287a3d]">是 · 条件成立</div><TreeNodeEditor node={node.trueChild} fields={fields} variables={variables} methods={methods} editable={editable} depth={depth + 1} onChange={trueChild => onChange({ ...node, trueChild })} /></div><div><div className="mb-1 text-[10px] font-semibold text-[#a31515]">否 · 条件不成立</div><TreeNodeEditor node={node.falseChild} fields={fields} variables={variables} methods={methods} editable={editable} depth={depth + 1} onChange={falseChild => onChange({ ...node, falseChild })} /></div></div>
  </section>
}

export default function DecisionTreeEditor({ detail, fields, projectVariables = [], busy = false, editable = false, onSave, onCompile, onSubmit }: Props) {
  const source = detail.draft as DecisionTreeDraft
  const [draft, setDraft] = useState(() => structuredClone(source))
  const [view, setView] = useState<'tree' | 'drl'>('tree')
  const [drl, setDrl] = useState(detail.content || '')
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  useEffect(() => { setDraft(structuredClone(source)); setDrl(detail.content || ''); setView('tree'); setNotice(null) }, [detail.id, detail.revision])
  const methods = detail.bomMethods || []
  const issues = nodeIssues(draft.root, fields, projectVariables, methods)
  const dirty = JSON.stringify(draft) !== JSON.stringify(source)
  const run = async (action: () => Promise<unknown>, success: string) => { setNotice(null); try { await action(); setNotice({ error: false, text: success }) } catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : '操作失败' }) } }
  const compile = async () => { if (!onCompile) return; const result = await onCompile(draft); setDrl(result.drl) }
  return <section className="flex h-full min-w-[500px] flex-1 flex-col overflow-hidden bg-white" aria-label="决策树编辑器">
    <header className="shrink-0 border-b border-ink-border px-4 py-3"><div className="flex items-center gap-2">{editable ? <input className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent text-[15px] font-semibold outline-none focus:border-brand-primary" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /> : <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{draft.name}</h2>}<span className="rounded bg-[#ede9fe] px-2 py-0.5 text-[10px] text-[#6d28d9]">决策树</span><span className="text-[11px] text-ink-3">v{detail.version} · r{detail.revision}</span></div><div className="mt-2 flex items-center gap-4 text-[11px] text-ink-3"><label>规则包：{editable ? <input className="ml-1 h-6 border-0 border-b border-dashed border-ink-border px-1" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} /> : draft.category}</label><label>优先级：{editable ? <input className="ml-1 h-6 w-20 border border-ink-border px-1" type="number" min={-1000} max={1000} value={draft.priority} onChange={event => setDraft({ ...draft, priority: Number(event.target.value) })} /> : draft.priority}</label><button className={`ml-auto h-7 px-2 text-[10px] ${view === 'tree' ? 'bg-brand-primary text-white' : 'border border-ink-border'}`} onClick={() => setView('tree')}>树形设计</button><button className={`h-7 px-2 text-[10px] ${view === 'drl' ? 'bg-brand-primary text-white' : 'border border-ink-border'}`} onClick={() => setView('drl')}><FileCode2 size={11} className="mr-1 inline" />DRL</button></div></header>
    <BomVersionNotice detail={detail} />
    {issues.length > 0 && <div className="border-b border-[#ef9a9a] bg-[#fff1f1] px-4 py-2 text-[11px] text-[#a31515]">{issues[0]}{issues.length > 1 ? `，另有 ${issues.length - 1} 项问题` : ''}</div>}
    <div className="min-h-0 flex-1 overflow-auto">{view === 'tree' ? <div className="space-y-4 p-4"><TreeNodeEditor node={draft.root} fields={fields} variables={projectVariables} methods={methods} editable={editable} depth={1} onChange={root => setDraft({ ...draft, root })} /><label className="block text-[10px] font-semibold text-ink-3">业务说明<textarea className="mt-1 min-h-20 w-full border border-ink-border p-2 text-xs font-normal" readOnly={!editable} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></div> : <div className="h-full min-h-[420px]"><Suspense fallback={<div className="p-5 text-[11px] text-ink-3">正在加载 DRL...</div>}><MonacoTextEditor value={drl} /></Suspense></div>}</div>
    {editable && <footer className="flex min-h-12 shrink-0 items-center gap-2 border-t border-ink-border bg-[#fafafa] px-3 py-2">{notice ? <span className={`mr-auto text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span> : <span className="mr-auto text-[10px] text-ink-3">{dirty ? '有未保存的决策树修改' : '决策树草稿已同步'}</span>}<button className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-2.5 text-[11px] disabled:opacity-50" disabled={busy || !dirty || issues.length > 0} onClick={() => onSave && run(() => onSave(draft), '决策树草稿已保存')}><Save size={13} />保存草稿</button><button className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-2.5 text-[11px] disabled:opacity-50" disabled={busy || issues.length > 0} onClick={() => run(compile, 'Drools 编译通过')}><CheckCircle2 size={13} />编译</button><button className="inline-flex h-8 items-center gap-1 bg-brand-primary px-2.5 text-[11px] text-white disabled:opacity-50" disabled={busy || dirty || issues.length > 0} onClick={() => onSubmit && run(onSubmit, '已提交审核')}><Rocket size={13} />提交审核</button></footer>}
  </section>
}
