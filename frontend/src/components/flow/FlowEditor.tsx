import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileText, GitBranch, GitFork, LayoutGrid, Layers3, Network, Plus, Redo2, Rocket, Save, Search, Table2, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { flowDefinitionFromDetail } from '../../api/flows'
import type { BomField, FlowAssetOption, FlowBranchDraft, FlowDetail, FlowDraft, FlowMapping, FlowPackageOption, FlowStepDraft, FlowSubflowOption } from '../../types'
import FlowCanvas from './FlowCanvas'

type FlowPalettePayload = { type: 'rule-group' | 'rule' | 'table' | 'subflow' | 'gateway'; id?: string; packageName?: string }

interface FlowEditorProps {
  detail: FlowDetail
  fields: BomField[]
  busy: boolean
  onSave: (draft: FlowDraft) => Promise<void>
  onCompile: (draft: FlowDraft) => Promise<{ engineVersion: string; stepCount: number; branchCount: number }>
  onPublish: () => Promise<void>
}

const operators = [
  ['==', '等于'], ['!=', '不等于'], ['>', '大于'], ['>=', '大于等于'], ['<', '小于'], ['<=', '小于等于'],
] as const

function MappingEditor({ label, mappings, sourceFields, targetFields, onChange }: {
  label: string
  mappings: FlowMapping[]
  sourceFields: BomField[]
  targetFields: BomField[]
  onChange: (mappings: FlowMapping[]) => void
}) {
  const add = () => {
    for (const source of sourceFields) {
      const target = targetFields.find(field => field.type === source.type && field.key !== source.key && !mappings.some(mapping => mapping.target === field.key))
      if (target) {
        onChange([...mappings, { source: source.key, target: target.key }])
        return
      }
    }
  }
  return (
    <div className="border-t border-[#e8e8e8] px-3 py-2">
      <div className="mb-1.5 flex items-center text-[10px] font-semibold text-ink-3">
        <span>{label}</span>
        <button type="button" className="ml-auto inline-flex size-6 items-center justify-center rounded-[2px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-40" onClick={add} disabled={!sourceFields.some(source => targetFields.some(target => target.type === source.type && target.key !== source.key))} title={`添加${label}`}><Plus size={12} /></button>
      </div>
      {mappings.length === 0 && <p className="text-[10px] text-ink-3">无映射</p>}
      <div className="space-y-1.5">
        {mappings.map((mapping, index) => {
          const source = sourceFields.find(field => field.key === mapping.source)
          const compatibleTargets = targetFields.filter(field => field.type === source?.type && field.key !== source?.key)
          return (
            <div key={`${mapping.source}-${mapping.target}-${index}`} className="grid grid-cols-[minmax(120px,1fr)_18px_minmax(120px,1fr)_24px] items-center gap-1.5">
              <select className="control-input h-7 text-[11px]" value={mapping.source} onChange={event => {
                const nextSource = sourceFields.find(field => field.key === event.target.value)
                const target = targetFields.find(field => field.type === nextSource?.type && field.key !== nextSource?.key)
                onChange(mappings.map((item, position) => position === index ? { source: event.target.value, target: target?.key || '' } : item))
              }}>{sourceFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select>
              <span className="text-center text-ink-3">→</span>
              <select className="control-input h-7 text-[11px]" value={mapping.target} onChange={event => onChange(mappings.map((item, position) => position === index ? { ...item, target: event.target.value } : item))}>{compatibleTargets.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select>
              <button type="button" className="inline-flex size-6 items-center justify-center rounded-[2px] text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={() => onChange(mappings.filter((_, position) => position !== index))} title={`删除${label}`}><Trash2 size={12} /></button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StepEditor({ step, index, count, assets, packages, subflows, fields, onChange, onDelete, onMove }: {
  step: FlowStepDraft
  index: number
  count: number
  assets: FlowAssetOption[]
  packages: FlowPackageOption[]
  subflows: FlowSubflowOption[]
  fields: BomField[]
  onChange: (step: FlowStepDraft) => void
  onDelete: () => void
  onMove: (direction: -1 | 1) => void
}) {
  const inputFields = fields.filter(field => field.direction === 'input')
  const outputFields = fields.filter(field => field.direction === 'output')
  const selected = step.type === 'rule-group' ? `rule-group:${step.selector?.packageName}` : `${step.type}:${step.id}`
  return (
    <div className="border-b border-[#e8e8e8] bg-white last:border-b-0">
      <div className="grid grid-cols-[24px_minmax(190px,1fr)_54px_26px] items-center gap-2 px-3 py-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-brand-primary-l text-[10px] font-semibold text-brand-primary">{index + 1}</span>
        <select className="control-input h-8 text-xs" value={selected} onChange={event => {
          if (event.target.value.startsWith('rule-group:')) {
            onChange({ nodeId: step.nodeId, type: 'rule-group', selector: { packageName: event.target.value.slice('rule-group:'.length), includeChildren: false }, inputMappings: step.inputMappings, outputMappings: step.outputMappings })
            return
          }
          if (event.target.value.startsWith('subflow:')) {
            onChange({ nodeId: step.nodeId, type: 'subflow', id: event.target.value.slice('subflow:'.length) })
            return
          }
          const asset = assets.find(item => `${item.type}:${item.id}` === event.target.value)
          if (asset) onChange({ nodeId: step.nodeId, id: asset.id, type: asset.type, inputMappings: step.inputMappings, outputMappings: step.outputMappings })
        }}>
          <optgroup label="规则包">
            {packages.map(entry => <option key={`group:${entry.name}`} value={`rule-group:${entry.name}`}>{entry.label} · {entry.publishedRuleCount + entry.publishedTableCount} 个已发布资产</option>)}
          </optgroup>
          <optgroup label="单个资产">
          {assets.map(asset => <option key={`${asset.type}:${asset.id}`} value={`${asset.type}:${asset.id}`}>{asset.name} · {asset.assetKind === 'decision-tree' ? '决策树' : asset.assetKind === 'scorecard' ? '计分卡' : asset.assetKind === 'rule-template' ? '规则模板' : asset.type === 'table' ? '决策表' : '规则'} v{asset.version}</option>)}
          </optgroup>
          <optgroup label="子流程">
            {subflows.map(flow => <option key={`subflow:${flow.id}`} value={`subflow:${flow.id}`}>{flow.name} · v{flow.version}</option>)}
          </optgroup>
        </select>
        <span className="text-[10px] text-ink-3">{step.type === 'subflow' ? '子流程' : step.type === 'rule-group' ? '规则组' : step.type === 'table' ? '决策表' : '规则'}</span>
        <button type="button" className="inline-flex size-6 items-center justify-center rounded-[2px] text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={onDelete} title="删除步骤"><Trash2 size={13} /></button>
      </div>
      <div className="flex gap-1 border-t border-[#f2f2f2] px-3 py-1">
        <button type="button" className="inline-flex size-6 items-center justify-center rounded-[2px] text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} title="上移"><ChevronUp size={13} /></button>
        <button type="button" className="inline-flex size-6 items-center justify-center rounded-[2px] text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={index === count - 1} onClick={() => onMove(1)} title="下移"><ChevronDown size={13} /></button>
        <span className="ml-auto self-center text-[10px] text-ink-3">字段映射</span>
      </div>
      {step.type === 'subflow' ? <p className="border-t border-[#f2f2f2] px-3 py-2 text-[10px] text-ink-3">子流程共享当前事实与规则集变量，无需字段映射。</p> : <><MappingEditor label="输入映射" mappings={step.inputMappings ?? []} sourceFields={fields} targetFields={inputFields} onChange={inputMappings => onChange({ ...step, inputMappings: inputMappings.length ? inputMappings : undefined })} /><MappingEditor label="输出映射" mappings={step.outputMappings ?? []} sourceFields={outputFields} targetFields={fields} onChange={outputMappings => onChange({ ...step, outputMappings: outputMappings.length ? outputMappings : undefined })} /></>}
    </div>
  )
}

function GraphEditor({ draft, assets, packages, subflows, fields, canAddStep, onEntryChange, onNodeChange, onNodeDelete, onAddStep, onAddGateway, onAddParallel, onAddParallelBranch }: {
  draft: FlowDraft
  assets: FlowAssetOption[]
  packages: FlowPackageOption[]
  subflows: FlowSubflowOption[]
  fields: BomField[]
  canAddStep: boolean
  onEntryChange: (entry: string) => void
  onNodeChange: (index: number, updater: (node: NonNullable<FlowDraft['graph']>['nodes'][number]) => NonNullable<FlowDraft['graph']>['nodes'][number]) => void
  onNodeDelete: (id: string) => void
  onAddStep: () => void
  onAddGateway: () => void
  onAddParallel: () => void
  onAddParallelBranch: (nodeIndex: number) => void
}) {
  const graph = draft.graph
  if (!graph) return null
  const inputFields = fields.filter(field => field.direction === 'input')
  const nodeLabel = (node: NonNullable<FlowDraft['graph']>['nodes'][number]) => node.type === 'step' ? `步骤·${node.id}` : node.type === 'gateway' ? `排他·${node.name}` : node.type === 'parallel' ? `并行·${node.name}` : `聚合·${node.name}`
  const targets = [{ id: 'end', label: '结束' }, ...graph.nodes.map(node => ({ id: node.id, label: nodeLabel(node) }))]
  const targetOptions = (selfId: string) => targets.filter(target => target.id !== selfId).map(target => <option key={target.id} value={target.id}>{target.label}</option>)
  return <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
    <div className="flex flex-wrap items-end gap-2 border-b border-ink-border bg-[#fafafa] px-4 py-2.5">
      <div><h2 className="text-xs font-semibold">高级有向图编排</h2><p className="mt-1 text-[10px] text-ink-3">支持嵌套排他、并行聚合和子流程；不支持循环。</p></div>
      <label className="ml-auto min-w-52 text-[10px] font-semibold text-ink-3">入口节点<select className="control-input mt-1 h-8 text-xs" value={graph.entry} onChange={event => onEntryChange(event.target.value)}>{graph.nodes.map(node => <option key={node.id} value={node.id}>{nodeLabel(node)}</option>)}</select></label>
      <button type="button" className="inline-flex h-8 items-center gap-1 border border-ink-border bg-white px-2 text-[11px] text-brand-primary disabled:opacity-40" disabled={!canAddStep} onClick={onAddStep}><Plus size={12} />步骤</button>
      <button type="button" className="inline-flex h-8 items-center gap-1 border border-[#e65100] bg-white px-2 text-[11px] text-[#b84600] disabled:opacity-40" disabled={!inputFields.length || graph.nodes.filter(node => node.type === 'gateway').length >= 8} onClick={onAddGateway}><Plus size={12} />网关</button>
      <button type="button" className="inline-flex h-8 items-center gap-1 border border-[#1565c0] bg-white px-2 text-[11px] text-[#0d47a1] disabled:opacity-40" disabled={!canAddStep || graph.nodes.filter(node => node.type === 'parallel').length >= 4} onClick={onAddParallel}><GitFork size={12} />并行</button>
    </div>
    {graph.nodes.map((node, nodeIndex) => node.type === 'step' ? <div key={node.id} className="border-b border-ink-border last:border-b-0">
      <div className="flex items-end gap-2 bg-[#f7faff] px-3 py-2"><span className="pb-2 font-mono text-[10px] text-ink-3">{node.id}</span><label className="ml-auto min-w-52 text-[10px] font-semibold text-ink-3">后继节点<select className="control-input mt-1 h-8 text-xs" value={node.next} onChange={event => onNodeChange(nodeIndex, current => current.type === 'step' ? { ...current, next: event.target.value } : current)}>{targetOptions(node.id)}</select></label><button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828]" onClick={() => onNodeDelete(node.id)} title="删除节点"><Trash2 size={13} /></button></div>
      <StepEditor step={node.step} index={0} count={1} assets={assets} packages={packages} subflows={subflows} fields={fields} onChange={step => onNodeChange(nodeIndex, current => current.type === 'step' ? { ...current, step: { ...step, nodeId: current.id } } : current)} onDelete={() => onNodeDelete(node.id)} onMove={() => undefined} />
    </div> : node.type === 'join' ? <div key={node.id} className="flex items-end gap-2 border-b border-ink-border bg-[#f3e5f5] px-3 py-2"><label className="min-w-52 flex-1 text-[10px] font-semibold text-ink-3">聚合节点名称<input className="control-input mt-1 h-8 text-xs" value={node.name} onChange={event => onNodeChange(nodeIndex, current => current.type === 'join' ? { ...current, name: event.target.value } : current)} /></label><label className="min-w-52 text-[10px] font-semibold text-ink-3">聚合后继<select className="control-input mt-1 h-8 text-xs" value={node.next} onChange={event => onNodeChange(nodeIndex, current => current.type === 'join' ? { ...current, next: event.target.value } : current)}>{targetOptions(node.id)}</select></label><span className="pb-2 font-mono text-[10px] text-ink-3">{node.id}</span><button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828]" onClick={() => onNodeDelete(node.id)}><Trash2 size={13} /></button></div> : node.type === 'parallel' ? <div key={node.id} className="border-b border-ink-border last:border-b-0">
      <div className="flex items-end gap-2 bg-[#e3f2fd] px-3 py-2"><label className="min-w-52 flex-1 text-[10px] font-semibold text-ink-3">并行网关名称<input className="control-input mt-1 h-8 text-xs" value={node.name} onChange={event => onNodeChange(nodeIndex, current => current.type === 'parallel' ? { ...current, name: event.target.value } : current)} /></label><label className="min-w-52 text-[10px] font-semibold text-ink-3">聚合节点<select className="control-input mt-1 h-8 text-xs" value={node.join} onChange={event => onNodeChange(nodeIndex, current => current.type === 'parallel' ? { ...current, join: event.target.value } : current)}>{graph.nodes.filter(item => item.type === 'join').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span className="pb-2 font-mono text-[10px] text-ink-3">{node.id}</span><button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828]" onClick={() => onNodeDelete(node.id)}><Trash2 size={13} /></button></div>
      {node.branches.map((branch, branchIndex) => <div key={branch.id} className="grid grid-cols-[minmax(160px,1fr)_minmax(190px,1fr)_28px] items-end gap-2 border-t border-[#bbdefb] px-3 py-2"><label className="text-[10px] font-semibold text-ink-3">并行分支名称<input className="control-input mt-1 h-8 text-xs" value={branch.name} onChange={event => onNodeChange(nodeIndex, current => current.type === 'parallel' ? { ...current, branches: current.branches.map((item, index) => index === branchIndex ? { ...item, name: event.target.value } : item) } : current)} /></label><label className="text-[10px] font-semibold text-ink-3">入口节点<select className="control-input mt-1 h-8 text-xs" value={branch.next} onChange={event => onNodeChange(nodeIndex, current => current.type === 'parallel' ? { ...current, branches: current.branches.map((item, index) => index === branchIndex ? { ...item, next: event.target.value } : item) } : current)}>{targetOptions(node.id)}</select></label><button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828] disabled:opacity-30" disabled={node.branches.length <= 2} onClick={() => onNodeChange(nodeIndex, current => current.type === 'parallel' ? { ...current, branches: current.branches.filter((_, index) => index !== branchIndex) } : current)}><Trash2 size={13} /></button></div>)}
      <div className="border-t border-[#bbdefb] px-3 py-2"><button type="button" className="h-7 px-2 text-[10px] text-[#0d47a1] disabled:opacity-40" disabled={!canAddStep || node.branches.length >= 8} onClick={() => onAddParallelBranch(nodeIndex)}><Plus size={11} className="inline" /> 并行分支</button></div>
    </div> : <div key={node.id} className="border-b border-ink-border last:border-b-0">
      <div className="flex items-end gap-2 bg-[#fff8e1] px-3 py-2"><label className="min-w-52 flex-1 text-[10px] font-semibold text-ink-3">网关名称<input className="control-input mt-1 h-8 text-xs" value={node.name} onChange={event => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, name: event.target.value } : current)} /></label><span className="pb-2 font-mono text-[10px] text-ink-3">{node.id}</span><button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828]" onClick={() => onNodeDelete(node.id)} title="删除网关"><Trash2 size={13} /></button></div>
      {node.branches.map((branch, branchIndex) => <div key={branch.id} className="grid grid-cols-[minmax(130px,0.8fr)_minmax(150px,1fr)_100px_minmax(110px,1fr)_minmax(170px,1fr)_28px] items-end gap-2 border-t border-[#e8e8e8] px-3 py-2 max-xl:grid-cols-2">
        <label className="text-[10px] font-semibold text-ink-3">分支名称<input className="control-input mt-1 h-8 text-xs" value={branch.name} onChange={event => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: current.branches.map((item, index) => index === branchIndex ? { ...item, name: event.target.value } : item) } : current)} /></label>
        {branch.default ? <span className="self-center text-[11px] text-ink-3">默认分支</span> : <><label className="text-[10px] font-semibold text-ink-3">条件字段<select className="control-input mt-1 h-8 text-xs" value={branch.condition?.field ?? ''} onChange={event => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: current.branches.map((item, index) => index === branchIndex ? { ...item, condition: { field: event.target.value, operator: item.condition?.operator || '==', value: '' } } : item) } : current)}>{inputFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select></label><label className="text-[10px] font-semibold text-ink-3">运算符<select className="control-input mt-1 h-8 text-xs" value={branch.condition?.operator ?? '=='} onChange={event => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: current.branches.map((item, index) => index === branchIndex ? { ...item, condition: { field: item.condition?.field || inputFields[0]?.key || '', operator: event.target.value, value: item.condition?.value || '' } } : item) } : current)}>{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-[10px] font-semibold text-ink-3">比较值<input className="control-input mt-1 h-8 text-xs" value={branch.condition?.value ?? ''} onChange={event => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: current.branches.map((item, index) => index === branchIndex ? { ...item, condition: { field: item.condition?.field || inputFields[0]?.key || '', operator: item.condition?.operator || '==', value: event.target.value } } : item) } : current)} /></label></>}
        <label className="text-[10px] font-semibold text-ink-3">目标节点<select className="control-input mt-1 h-8 text-xs" value={branch.next} onChange={event => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: current.branches.map((item, index) => index === branchIndex ? { ...item, next: event.target.value } : item) } : current)}>{targetOptions(node.id)}</select></label>
        <button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center text-ink-3 hover:text-[#c62828] disabled:opacity-30" disabled={node.branches.length <= 1} onClick={() => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: current.branches.filter((_, index) => index !== branchIndex) } : current)}><Trash2 size={13} /></button>
      </div>)}
      <div className="flex gap-2 border-t border-[#e8e8e8] px-3 py-2"><button type="button" className="h-7 px-2 text-[10px] text-brand-primary disabled:opacity-40" disabled={!inputFields.length || node.branches.length >= 8} onClick={() => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: [...current.branches, { id: crypto.randomUUID(), name: `条件路径 ${current.branches.length + 1}`, condition: { field: inputFields[0].key, operator: '==', value: '' }, next: 'end' }] } : current)}><Plus size={11} className="inline" /> 条件分支</button><button type="button" className="h-7 px-2 text-[10px] text-ink-2 disabled:opacity-40" disabled={node.branches.some(branch => branch.default) || node.branches.length >= 8} onClick={() => onNodeChange(nodeIndex, current => current.type === 'gateway' ? { ...current, branches: [...current.branches, { id: crypto.randomUUID(), name: '默认路径', default: true, next: 'end' }] } : current)}><Plus size={11} className="inline" /> 默认分支</button></div>
    </div>)}
  </section>
}

function newStep(assets: FlowAssetOption[], packages: FlowPackageOption[] = [], subflows: FlowSubflowOption[] = []): FlowStepDraft | null {
  const asset = assets[0]
  if (asset) return { nodeId: crypto.randomUUID(), type: asset.type, id: asset.id }
  const executablePackage = packages.find(entry => entry.publishedRuleCount + entry.publishedTableCount > 0)
  if (executablePackage) return { nodeId: crypto.randomUUID(), type: 'rule-group', selector: { packageName: executablePackage.name, includeChildren: false } }
  const subflow = subflows[0]
  return subflow ? { nodeId: crypto.randomUUID(), type: 'subflow', id: subflow.id } : null
}

function moveStep(steps: FlowStepDraft[], index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= steps.length) return steps
  const next = [...steps]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

function normalizeFlowDraft(source: FlowDraft): FlowDraft {
  const draft = structuredClone(source)
  const positions = { ...(draft.editor?.positions ?? {}) }
  if (!draft.gateways?.length && draft.branches?.length) {
    draft.gateways = draft.branches?.length
      ? [{ id: 'gateway', name: '排他网关', afterStep: draft.steps.length, branches: draft.branches }]
      : []
  }
  draft.gateways ??= []
  delete draft.branches
  draft.steps = draft.steps.map((step, index) => {
    if (step.nodeId) return step
    const nodeId = crypto.randomUUID()
    const legacy = `common:${index}`
    if (positions[legacy]) positions[nodeId] = positions[legacy]
    return { ...step, nodeId }
  })
  draft.gateways = draft.gateways.map(gateway => ({
    ...gateway,
    branches: gateway.branches.map(branch => ({
      ...branch,
      steps: branch.steps.map((step, index) => {
        if (step.nodeId) return step
        const nodeId = crypto.randomUUID()
        const legacy = `branch:${branch.id}:${index}`
        if (positions[legacy]) positions[nodeId] = positions[legacy]
        return { ...step, nodeId }
      }),
    })),
  }))
  if (draft.graph) draft.graph.nodes = draft.graph.nodes.map(node => node.type === 'step'
    ? { ...node, step: { ...node.step, nodeId: node.id } }
    : node)
  draft.editor = { ...draft.editor, positions }
  return draft
}

function graphFromLinearFlow(draft: FlowDraft) {
  const gateways = draft.gateways ?? []
  const gatewayAt = new Map(gateways.map(gateway => [gateway.afterStep, gateway]))
  const commonIds = draft.steps.map(step => step.nodeId || crypto.randomUUID())
  const boundaryTarget = (boundary: number) => gatewayAt.get(boundary)?.id || commonIds[boundary] || 'end'
  const nodes: NonNullable<FlowDraft['graph']>['nodes'] = draft.steps.map((step, index) => ({
    id: commonIds[index], type: 'step' as const, step: { ...step, nodeId: commonIds[index] }, next: boundaryTarget(index + 1),
  }))
  for (const gateway of gateways) {
    const mergeTarget = commonIds[gateway.afterStep] || 'end'
    nodes.push({
      id: gateway.id, type: 'gateway', name: gateway.name,
      branches: gateway.branches.map(branch => {
        const branchIds = branch.steps.map(step => step.nodeId || crypto.randomUUID())
        branch.steps.forEach((step, index) => nodes.push({
          id: branchIds[index], type: 'step', step: { ...step, nodeId: branchIds[index] }, next: branchIds[index + 1] || mergeTarget,
        }))
        return { id: branch.id, name: branch.name, default: branch.default, condition: branch.condition, next: branchIds[0] || mergeTarget }
      }),
    })
  }
  return { entry: boundaryTarget(0), nodes }
}

function PaletteItem({ icon: Icon, title, detail, payload }: {
  icon: typeof Layers3
  title: string
  detail: string
  payload: FlowPalettePayload
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={event => {
        event.dataTransfer.setData('application/decision-workbench-flow', JSON.stringify(payload))
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className="flex min-h-[54px] w-full cursor-grab items-center gap-2 border-b border-[#e8e8e8] bg-white px-2.5 py-2 text-left hover:bg-brand-primary-l active:cursor-grabbing"
      title={`拖入画布：${title}`}
    >
      <Icon size={15} className={payload.type === 'table' ? 'text-[#7c3aed]' : 'text-brand-primary'} />
      <span className="min-w-0"><b className="block truncate text-[11px] font-semibold text-ink-1">{title}</b><span className="block truncate text-[9px] text-ink-3">{detail}</span></span>
    </button>
  )
}

function GatewayPaletteItem({ disabled, onActivate }: { disabled: boolean; onActivate: () => void }) {
  const payload: FlowPalettePayload = { type: 'gateway' }
  return (
    <button
      type="button"
      draggable={!disabled}
      disabled={disabled}
      onClick={onActivate}
      onDragStart={event => {
        event.dataTransfer.setData('application/decision-workbench-flow', JSON.stringify(payload))
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className="flex min-h-[54px] w-full cursor-grab items-center gap-2 border-b border-[#e8e8e8] bg-white px-2.5 py-2 text-left hover:bg-[#fff8e1] active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-45"
      title={disabled ? '需要至少一个 BOM 输入字段和一个已发布规则、决策表或可执行规则包' : '点击或拖入画布：排他网关'}
    >
      <GitBranch size={15} className="text-[#b84600]" />
      <span className="min-w-0"><b className="block truncate text-[11px] font-semibold text-ink-1">排他网关</b><span className="block truncate text-[9px] text-ink-3">按业务条件选择一条执行路径</span></span>
    </button>
  )
}

export default function FlowEditor({ detail, fields, busy, onSave, onCompile, onPublish }: FlowEditorProps) {
  const source = detail.draft
  const [draft, setDraftState] = useState<FlowDraft>(() => normalizeFlowDraft(source))
  const undoStack = useRef<FlowDraft[]>([])
  const redoStack = useRef<FlowDraft[]>([])
  const previousDetailId = useRef(detail.id)
  const setDraft = useCallback((action: SetStateAction<FlowDraft>) => {
    setDraftState(current => {
      const next = typeof action === 'function' ? action(current) : action
      if (JSON.stringify(current) === JSON.stringify(next)) return current
      undoStack.current = [...undoStack.current.slice(-29), structuredClone(current)]
      redoStack.current = []
      return next
    })
  }, [])
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [paletteSearch, setPaletteSearch] = useState('')
  const graph = draft.graph
  const gateways = draft.gateways ?? []
  const dirty = JSON.stringify(draft) !== JSON.stringify(source)
  const definition = useMemo(() => flowDefinitionFromDetail(detail, draft), [detail, draft])
  const inputFields = fields.filter(field => field.direction === 'input')
  const duplicateOutputs = useMemo(() => {
    const steps = graph
      ? graph.nodes.filter(node => node.type === 'step').map(node => node.step)
      : [...draft.steps, ...gateways.flatMap(gateway => gateway.branches.flatMap(branch => branch.steps))]
    const writers = new Map<string, string[]>()
    for (const step of steps) {
      if (step.type === 'rule-group') {
        const entry = detail.availablePackages.find(item => item.name === step.selector?.packageName)
        for (const field of entry?.outputFields ?? []) writers.set(field, [...(writers.get(field) || []), entry?.label || step.selector?.packageName || '规则组'])
        continue
      }
      const asset = detail.availableAssets.find(item => item.id === step.id && item.type === step.type)
      for (const field of asset?.outputFields || []) writers.set(field, [...(writers.get(field) || []), asset?.name || step.id || '未命名资产'])
    }
    return [...writers].filter(([, names]) => names.length > 1).map(([field, names]) => ({ field, names }))
  }, [detail.availableAssets, detail.availablePackages, draft.steps, gateways, graph])

  useEffect(() => {
    const changedFlow = previousDetailId.current !== detail.id
    setDraftState(normalizeFlowDraft(source))
    undoStack.current = []
    redoStack.current = []
    if (changedFlow) setNotice(null)
    setSelectedNodeId(null)
    previousDetailId.current = detail.id
  }, [detail.id, detail.revision, source])

  const undo = () => {
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(structuredClone(draft))
    setDraftState(previous)
  }
  const redo = () => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(structuredClone(draft))
    setDraftState(next)
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const selectedStep = useMemo(() => {
    const graphNodeIndex = graph?.nodes.findIndex(node => node.type === 'step' && node.id === selectedNodeId) ?? -1
    if (graphNodeIndex >= 0 && graph?.nodes[graphNodeIndex]?.type === 'step') {
      return { step: graph.nodes[graphNodeIndex].step, commonIndex: -1, gatewayIndex: -1, branchIndex: -1, stepIndex: -1, graphNodeIndex }
    }
    const commonIndex = draft.steps.findIndex(step => step.nodeId === selectedNodeId)
    if (commonIndex >= 0) return { step: draft.steps[commonIndex], commonIndex, gatewayIndex: -1, branchIndex: -1, stepIndex: commonIndex, graphNodeIndex: -1 }
    for (const [gatewayIndex, gateway] of gateways.entries()) {
      for (const [branchIndex, branch] of gateway.branches.entries()) {
        const stepIndex = branch.steps.findIndex(step => step.nodeId === selectedNodeId)
        if (stepIndex >= 0) return { step: branch.steps[stepIndex], commonIndex: -1, gatewayIndex, branchIndex, stepIndex, graphNodeIndex: -1 }
      }
    }
    return null
  }, [draft.steps, gateways, graph, selectedNodeId])
  const selectedGatewayIndex = gateways.findIndex(gateway => gateway.id === selectedNodeId)
  const selectedGateway = selectedGatewayIndex >= 0 ? gateways[selectedGatewayIndex] : null
  const selectedGraphGatewayIndex = graph?.nodes.findIndex(node => node.type === 'gateway' && node.id === selectedNodeId) ?? -1
  const selectedGraphGateway = selectedGraphGatewayIndex >= 0 && graph?.nodes[selectedGraphGatewayIndex]?.type === 'gateway' ? graph.nodes[selectedGraphGatewayIndex] : null
  const selectedGraphParallelIndex = graph?.nodes.findIndex(node => node.type === 'parallel' && node.id === selectedNodeId) ?? -1
  const selectedGraphParallel = selectedGraphParallelIndex >= 0 && graph?.nodes[selectedGraphParallelIndex]?.type === 'parallel' ? graph.nodes[selectedGraphParallelIndex] : null
  const selectedGraphJoinIndex = graph?.nodes.findIndex(node => node.type === 'join' && node.id === selectedNodeId) ?? -1
  const selectedGraphJoin = selectedGraphJoinIndex >= 0 && graph?.nodes[selectedGraphJoinIndex]?.type === 'join' ? graph.nodes[selectedGraphJoinIndex] : null
  const gatewaySelected = Boolean(selectedGateway || selectedGraphGateway || selectedGraphParallel || selectedGraphJoin)
  const selectedPackage = useMemo(() => {
    if (selectedStep?.step.type !== 'rule-group' || !selectedStep.step.selector) return undefined
    const { packageName, includeChildren } = selectedStep.step.selector
    const base = detail.availablePackages.find(entry => entry.name === packageName)
    if (!base || !includeChildren) return base
    const entries = detail.availablePackages.filter(entry => entry.name === packageName || entry.name.startsWith(`${packageName}.`))
    return {
      ...base,
      publishedRuleCount: entries.reduce((total, entry) => total + entry.publishedRuleCount, 0),
      publishedTableCount: entries.reduce((total, entry) => total + entry.publishedTableCount, 0),
      excludedDraftCount: entries.reduce((total, entry) => total + entry.excludedDraftCount, 0),
      outputFields: [...new Set(entries.flatMap(entry => entry.outputFields))],
      members: entries.flatMap(entry => entry.members),
    }
  }, [detail.availablePackages, selectedStep])
  const palettePackages = detail.availablePackages.filter(entry => `${entry.label} ${entry.name}`.toLowerCase().includes(paletteSearch.toLowerCase()))
  const paletteAssets = detail.availableAssets.filter(asset => `${asset.name} ${asset.category}`.toLowerCase().includes(paletteSearch.toLowerCase()))
  const availableFlows = detail.availableFlows ?? []
  const paletteSubflows = availableFlows.filter(flow => flow.name.toLowerCase().includes(paletteSearch.toLowerCase()))
  const hasBranchStepSource = detail.availableAssets.length > 0 || detail.availablePackages.some(entry => entry.publishedRuleCount + entry.publishedTableCount > 0) || availableFlows.length > 0
  const totalStepCount = graph ? graph.nodes.filter(node => node.type === 'step').length : draft.steps.length + gateways.reduce((total, gateway) => total + gateway.branches.reduce((branchTotal, branch) => branchTotal + branch.steps.length, 0), 0)
  const canAddStep = hasBranchStepSource && totalStepCount < 20
  const canAddGateway = !graph && canAddStep && inputFields.length > 0 && gateways.length < 4 && gateways.length <= draft.steps.length
  const canAddConditionalBranch = Boolean(selectedGateway && canAddStep && inputFields.length > 0 && selectedGateway.branches.length < 8)

  const run = async (action: () => Promise<unknown>, success: string) => {
    setNotice(null)
    try {
      await action()
      setNotice({ error: false, text: success })
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : '操作失败' })
    }
  }
  const updateGateway = (gatewayIndex: number, updater: (gateway: NonNullable<FlowDraft['gateways']>[number]) => NonNullable<FlowDraft['gateways']>[number]) => setDraft(current => ({
    ...current,
    gateways: (current.gateways ?? []).map((gateway, position) => position === gatewayIndex ? updater(gateway) : gateway),
  }))
  const updateGatewayBranch = (gatewayIndex: number, branchIndex: number, updater: (branch: FlowBranchDraft) => FlowBranchDraft) => {
    updateGateway(gatewayIndex, gateway => ({ ...gateway, branches: gateway.branches.map((branch, position) => position === branchIndex ? updater(branch) : branch) }))
  }
  const updateBranch = (index: number, updater: (branch: FlowBranchDraft) => FlowBranchDraft) => {
    if (selectedGatewayIndex < 0) return
    updateGatewayBranch(selectedGatewayIndex, index, updater)
  }
  const deleteBranch = (index: number) => {
    if (selectedGatewayIndex < 0 || !selectedGateway || selectedGateway.branches.length <= 1) return
    updateGateway(selectedGatewayIndex, gateway => ({ ...gateway, branches: gateway.branches.filter((_, position) => position !== index) }))
  }
  const moveBranch = (index: number, direction: -1 | 1) => {
    if (selectedGatewayIndex < 0) return
    updateGateway(selectedGatewayIndex, gateway => {
    const branches = [...gateway.branches]
    const target = index + direction
    if (target < 0 || target >= branches.length) return gateway
    ;[branches[index], branches[target]] = [branches[target], branches[index]]
    return { ...gateway, branches }
    })
  }
  const addBranch = (isDefault: boolean, gatewayPosition?: { x: number; y: number }) => {
    if (!selectedGateway || selectedGatewayIndex < 0 || selectedGateway.branches.length >= 8 || (isDefault && selectedGateway.branches.some(branch => branch.default))) return
    addBranchToGateway(selectedGatewayIndex, isDefault, gatewayPosition)
  }
  const addBranchToGateway = (gatewayIndex: number, isDefault: boolean, gatewayPosition?: { x: number; y: number }) => {
    const gateway = gateways[gatewayIndex]
    if (!gateway || totalStepCount >= 20 || gateway.branches.length >= 8 || (isDefault && gateway.branches.some(branch => branch.default))) return
    const step = newStep(detail.availableAssets, detail.availablePackages, availableFlows)
    if (!step || (!isDefault && !inputFields.length)) {
      setNotice({ error: true, text: !inputFields.length ? '请先在 BOM 中定义输入字段' : '请先发布规则、决策表或包含可执行资产的规则包' })
      return
    }
    const firstInput = inputFields[0]
    const branch: FlowBranchDraft = {
      id: crypto.randomUUID(), name: isDefault ? '默认路径' : `条件路径 ${gateway.branches.length + 1}`,
      default: isDefault,
      condition: isDefault ? undefined : { field: firstInput?.key || '', operator: '==', value: '' },
      steps: [step],
    }
    updateGateway(gatewayIndex, current => ({ ...current, branches: [...current.branches, branch] }))
    if (gatewayPosition) moveNode(gateway.id, gatewayPosition)
    setSelectedNodeId(gateway.id)
  }
  const addOrSelectGateway = (position?: { x: number; y: number }) => {
    if (!canAddGateway || totalStepCount >= 20) return
    const step = newStep(detail.availableAssets, detail.availablePackages, availableFlows)
    if (!step) return
    const id = crypto.randomUUID()
    const firstInput = inputFields[0]
    const usedBoundaries = new Set(gateways.map(gateway => gateway.afterStep))
    const afterStep = Array.from({ length: draft.steps.length + 1 }, (_, index) => draft.steps.length - index).find(boundary => !usedBoundaries.has(boundary))
    if (afterStep == null) return
    const gateway = {
      id, name: `排他网关 ${gateways.length + 1}`, afterStep,
      branches: [{ id: crypto.randomUUID(), name: '条件路径 1', condition: { field: firstInput?.key || '', operator: '==', value: '' }, steps: [step] }],
    }
    setDraft(current => ({ ...current, gateways: [...(current.gateways ?? []), gateway], editor: position ? { ...current.editor, positions: { ...(current.editor?.positions ?? {}), [id]: position } } : current.editor }))
    setSelectedNodeId(id)
  }
  const upgradeToGraph = () => setDraft(current => ({
    ...current,
    graph: graphFromLinearFlow(current),
    steps: [],
    gateways: [],
    branches: undefined,
  }))
  const updateGraphNode = (nodeIndex: number, updater: (node: NonNullable<FlowDraft['graph']>['nodes'][number]) => NonNullable<FlowDraft['graph']>['nodes'][number]) => setDraft(current => current.graph ? ({
    ...current,
    graph: { ...current.graph, nodes: current.graph.nodes.map((node, index) => index === nodeIndex ? updater(node) : node) },
  }) : current)
  const addGraphStep = () => {
    const step = newStep(detail.availableAssets, detail.availablePackages, availableFlows)
    if (!step || !graph || totalStepCount >= 20) return
    const id = crypto.randomUUID()
    setDraft(current => current.graph ? ({ ...current, graph: { ...current.graph, nodes: [...current.graph.nodes, { id, type: 'step', step: { ...step, nodeId: id }, next: 'end' }] } }) : current)
  }
  const addGraphGateway = () => {
    if (!graph || !inputFields.length || graph.nodes.filter(node => node.type === 'gateway').length >= 8) return
    const id = crypto.randomUUID()
    setDraft(current => current.graph ? ({
      ...current,
      graph: { ...current.graph, nodes: [...current.graph.nodes, {
        id, type: 'gateway', name: `排他网关 ${current.graph.nodes.filter(node => node.type === 'gateway').length + 1}`,
        branches: [{ id: crypto.randomUUID(), name: '条件路径 1', condition: { field: inputFields[0].key, operator: '==', value: '' }, next: 'end' }],
      }] },
    }) : current)
  }
  const addGraphParallel = () => {
    if (!graph || totalStepCount > 18 || graph.nodes.filter(node => node.type === 'parallel').length >= 4) return
    const first = newStep(detail.availableAssets, detail.availablePackages, availableFlows)
    const second = newStep(detail.availableAssets, detail.availablePackages, availableFlows)
    if (!first || !second) return
    const parallelId = crypto.randomUUID()
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const joinId = crypto.randomUUID()
    setDraft(current => current.graph ? ({
      ...current,
      graph: { ...current.graph, nodes: [...current.graph.nodes,
        { id: parallelId, type: 'parallel', name: `并行网关 ${current.graph.nodes.filter(node => node.type === 'parallel').length + 1}`, join: joinId, branches: [
          { id: crypto.randomUUID(), name: '并行分支 1', next: firstId },
          { id: crypto.randomUUID(), name: '并行分支 2', next: secondId },
        ] },
        { id: firstId, type: 'step', step: { ...first, nodeId: firstId }, next: joinId },
        { id: secondId, type: 'step', step: { ...second, nodeId: secondId }, next: joinId },
        { id: joinId, type: 'join', name: '聚合节点', next: 'end' },
      ] },
    }) : current)
    setSelectedNodeId(parallelId)
  }
  const addGraphParallelBranch = (nodeIndex: number) => {
    const step = newStep(detail.availableAssets, detail.availablePackages, availableFlows)
    if (!step || totalStepCount >= 20) return
    const stepId = crypto.randomUUID()
    setDraft(current => {
      if (!current.graph) return current
      const parallel = current.graph.nodes[nodeIndex]
      if (parallel?.type !== 'parallel' || parallel.branches.length >= 8) return current
      return { ...current, graph: { ...current.graph, nodes: [
        ...current.graph.nodes.map((node, index) => index === nodeIndex && node.type === 'parallel'
          ? { ...node, branches: [...node.branches, { id: crypto.randomUUID(), name: `并行分支 ${node.branches.length + 1}`, next: stepId }] }
          : node),
        { id: stepId, type: 'step', step: { ...step, nodeId: stepId }, next: parallel.join },
      ] } }
    })
  }
  const deleteGraphNode = (nodeId: string) => setDraft(current => {
    if (!current.graph || current.graph.nodes.length <= 1) return current
    const remaining = current.graph.nodes.filter(node => node.id !== nodeId)
    const fallback = remaining[0]?.id || 'end'
    return {
      ...current,
      graph: {
        entry: current.graph.entry === nodeId ? fallback : current.graph.entry,
        nodes: remaining.map(node => node.type === 'step' || node.type === 'join'
          ? { ...node, next: node.next === nodeId ? 'end' : node.next }
          : { ...node, ...(node.type === 'parallel' && node.join === nodeId ? { join: '' } : {}), branches: node.branches.map(branch => ({ ...branch, next: branch.next === nodeId ? 'end' : branch.next })) }),
      },
    }
  })
  const updateSelectedStep = (next: FlowStepDraft) => {
    if (!selectedStep) return
    if (selectedStep.graphNodeIndex >= 0) {
      updateGraphNode(selectedStep.graphNodeIndex, node => node.type === 'step' ? { ...node, step: { ...next, nodeId: node.id } } : node)
      return
    }
    setDraft(current => selectedStep.commonIndex >= 0
      ? { ...current, steps: current.steps.map((step, index) => index === selectedStep.commonIndex ? next : step) }
      : {
          ...current,
          gateways: (current.gateways ?? []).map((gateway, gatewayIndex) => gatewayIndex === selectedStep.gatewayIndex
            ? { ...gateway, branches: gateway.branches.map((branch, branchIndex) => branchIndex === selectedStep.branchIndex
              ? { ...branch, steps: branch.steps.map((step, stepIndex) => stepIndex === selectedStep.stepIndex ? next : step) }
              : branch) }
            : gateway),
        })
  }
  const deleteCommonStep = (stepIndex: number) => {
    const occupiedBoundaries = new Set(gateways.map(gateway => gateway.afterStep))
    if (occupiedBoundaries.has(stepIndex) && occupiedBoundaries.has(stepIndex + 1)) {
      setNotice({ error: true, text: '该公共步骤两侧都有网关，请先调整其中一个网关的插入位置' })
      return false
    }
    setDraft(current => ({
      ...current,
      steps: current.steps.filter((_, index) => index !== stepIndex),
      gateways: (current.gateways ?? []).map(gateway => ({ ...gateway, afterStep: gateway.afterStep > stepIndex ? gateway.afterStep - 1 : gateway.afterStep })),
    }))
    return true
  }
  const deleteSelectedStep = () => {
    if (!selectedStep) return
    if (selectedStep.graphNodeIndex >= 0) {
      const nodeId = graph?.nodes[selectedStep.graphNodeIndex]?.id
      if (nodeId) deleteGraphNode(nodeId)
      setSelectedNodeId(null)
      return
    }
    if (selectedStep.commonIndex >= 0) {
      if (deleteCommonStep(selectedStep.commonIndex)) setSelectedNodeId(null)
      return
    }
    setDraft(current => ({
          ...current,
          gateways: (current.gateways ?? []).map((gateway, gatewayIndex) => gatewayIndex === selectedStep.gatewayIndex
            ? { ...gateway, branches: gateway.branches.map((branch, branchIndex) => branchIndex === selectedStep.branchIndex
              ? { ...branch, steps: branch.steps.filter((_, stepIndex) => stepIndex !== selectedStep.stepIndex) }
              : branch) }
            : gateway),
        }))
    setSelectedNodeId(null)
  }
  const moveNode = (nodeId: string, position: { x: number; y: number }) => setDraft(current => ({
    ...current,
    editor: { ...current.editor, positions: { ...(current.editor?.positions ?? {}), [nodeId]: position } },
  }))
  const dropItem = (item: FlowPalettePayload, position: { x: number; y: number }) => {
    if (graph) {
      setNotice({ error: true, text: '高级图编排首版请在“结构化备用编辑”中新增节点并设置后继连接' })
      return
    }
    if (item.type === 'gateway') {
      addOrSelectGateway(position)
      return
    }
    if (totalStepCount >= 20) {
      setNotice({ error: true, text: '规则集最多支持 20 个步骤' })
      return
    }
    const nodeId = crypto.randomUUID()
    const step: FlowStepDraft | null = item.type === 'rule-group' && item.packageName
      ? { nodeId, type: 'rule-group', selector: { packageName: item.packageName, includeChildren: false } }
      : item.id ? { nodeId, type: item.type as 'rule' | 'table' | 'subflow', id: item.id } : null
    if (!step) return
    const branchCandidates = definition.nodes.filter(node => node.stepType && node.branchId)
    const nearestBranchNode = branchCandidates.reduce<(typeof branchCandidates)[number] | null>((nearest, node) => (
      !nearest || Math.abs(node.position.y - position.y) < Math.abs(nearest.position.y - position.y) ? node : nearest
    ), null)
    const nearestGatewayX = nearestBranchNode?.gatewayId ? definition.nodes.find(node => node.id === nearestBranchNode.gatewayId)?.position.x : null
    const targetBranchId = nearestBranchNode && nearestGatewayX != null && position.x > nearestGatewayX + 60 && Math.abs(nearestBranchNode.position.y - position.y) <= 90 ? nearestBranchNode.branchId : null
    const commonNodes = definition.nodes.filter(node => node.stepType && node.branchId == null)
    const targetNodes = targetBranchId ? branchCandidates.filter(node => node.branchId === targetBranchId) : commonNodes
    const dropBefore = targetNodes.findIndex(node => position.x < node.position.x + 105)
    const targetLength = targetBranchId ? gateways.flatMap(gateway => gateway.branches).find(branch => branch.id === targetBranchId)?.steps.length ?? 0 : draft.steps.length
    const insertAt = dropBefore < 0 ? targetLength : dropBefore
    setDraft(current => ({
      ...current,
      steps: targetBranchId ? current.steps : [...current.steps.slice(0, insertAt), step, ...current.steps.slice(insertAt)],
      gateways: targetBranchId ? (current.gateways ?? []).map(gateway => ({ ...gateway, branches: gateway.branches.map(branch => branch.id === targetBranchId
        ? { ...branch, steps: [...branch.steps.slice(0, insertAt), step, ...branch.steps.slice(insertAt)] }
        : branch) })) : (current.gateways ?? []).map(gateway => ({ ...gateway, afterStep: insertAt < gateway.afterStep ? gateway.afterStep + 1 : gateway.afterStep })),
      editor: { ...current.editor, positions: { ...(current.editor?.positions ?? {}), [nodeId]: position } },
    }))
    setSelectedNodeId(nodeId)
  }

  return (
    <div className="space-y-[14px]">
      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
        <div className="flex min-h-[42px] flex-wrap items-center gap-2 border-b border-ink-border bg-[#fafafa] px-3 py-1.5">
          <span className="text-[11px] text-ink-3">修订 r{detail.revision} · {detail.status === 'published' ? `已发布 v${detail.version}` : '草稿'}</span>
          <button type="button" className="inline-flex size-7 items-center justify-center border border-ink-border bg-white text-ink-2 hover:bg-ink-bg disabled:opacity-35" disabled={!undoStack.current.length} onClick={undo} title="撤销"><Undo2 size={13} /></button>
          <button type="button" className="inline-flex size-7 items-center justify-center border border-ink-border bg-white text-ink-2 hover:bg-ink-bg disabled:opacity-35" disabled={!redoStack.current.length} onClick={redo} title="重做"><Redo2 size={13} /></button>
          <button type="button" className="inline-flex size-7 items-center justify-center border border-ink-border bg-white text-ink-2 hover:bg-ink-bg" onClick={() => setDraft(current => ({ ...current, editor: { positions: {} } }))} title="自动布局"><LayoutGrid size={13} /></button>
          <button type="button" className="inline-flex h-7 items-center gap-1 border border-[#e65100] bg-white px-2 text-[10px] text-[#b84600] hover:bg-[#fff8e1] disabled:opacity-35" disabled={!canAddGateway} onClick={() => addOrSelectGateway()} title="新增排他网关"><GitBranch size={12} />新增网关</button>
          {notice && <span className={`ml-auto max-w-[360px] truncate text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span>}
          <button type="button" className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy || !dirty} onClick={() => run(() => onSave(draft), '规则集草稿已保存')}><Save size={13} />保存</button>
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy} onClick={() => run(async () => { const result = await onCompile(draft); setNotice({ error: false, text: `Drools ${result.engineVersion} 校验通过 · ${result.stepCount} 步` }) }, 'Drools 校验通过')}><CheckCircle2 size={13} />校验</button>
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-brand-primary bg-brand-primary px-2 text-[11px] text-white hover:bg-brand-primary-d disabled:opacity-50" disabled={busy || dirty} onClick={() => run(onPublish, '规则集发布成功')} title={dirty ? '请先保存草稿' : '编译并发布当前规则集'}><Rocket size={13} />发布</button>
        </div>
        {detail.needsRepublish && <div className="flex items-start gap-2 border-b border-[#f3c65f] bg-[#fff8e1] px-4 py-2 text-[11px] text-[#734d00]"><AlertTriangle size={14} className="mt-px shrink-0" />依赖资产已有新发布版本，请重新校验并发布此规则集。</div>}
        {duplicateOutputs.length > 0 && <div className="flex items-start gap-2 border-b border-[#f3c65f] bg-[#fff8e1] px-4 py-2 text-[11px] text-[#734d00]"><AlertTriangle size={14} className="mt-px shrink-0" /><span>多个步骤会写入同一输出字段，后执行步骤将覆盖前值：{duplicateOutputs.map(item => `${fields.find(field => field.key === item.field)?.label || item.field}（${item.names.join(' → ')}）`).join('；')}</span></div>}
        <div className="grid grid-cols-[minmax(220px,1fr)_180px] gap-3 border-b border-ink-border px-4 py-3 max-sm:grid-cols-1">
          <label className="text-[10px] font-semibold text-ink-3">规则集名称<input className="control-input mt-1 h-8 text-xs" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="text-[10px] font-semibold text-ink-3">业务分类<input className="control-input mt-1 h-8 text-xs" value={draft.category ?? ''} onChange={event => setDraft({ ...draft, category: event.target.value })} /></label>
          <label className="col-span-full text-[10px] font-semibold text-ink-3">说明<textarea className="mt-1 min-h-16 w-full resize-y rounded-[3px] border border-ink-border px-[10px] py-2 text-xs font-normal text-ink-1 outline-none focus:border-brand-primary" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        </div>
        <div className="border-b border-ink-border bg-[#f5f8ff] px-4 py-2 text-[10px] text-ink-3">规则集变量由 Rule Project 属性统一维护。当前规则集中的规则可在条件和动作中读取、写入项目变量；旧规则集 variables 仅作兼容读取。</div>
        <div className="grid grid-cols-[220px_minmax(420px,1fr)_300px] max-xl:grid-cols-[minmax(420px,1fr)_280px] max-lg:grid-cols-1">
          <div className="col-span-2 hidden h-12 items-center gap-2 overflow-x-auto border-b border-ink-border bg-[#fafafa] px-2 max-xl:flex max-lg:col-span-1">
            <span className="shrink-0 text-[10px] font-semibold text-ink-3">节点</span>
            <button type="button" draggable={canAddGateway} disabled={!canAddGateway} onClick={() => addOrSelectGateway()} onDragStart={event => { event.dataTransfer.setData('application/decision-workbench-flow', JSON.stringify({ type: 'gateway' })); event.dataTransfer.effectAllowed = 'copy' }} className="inline-flex h-8 shrink-0 cursor-grab items-center gap-1.5 border border-[#e65100] bg-white px-2 text-[10px] text-[#b84600] hover:bg-[#fff8e1] disabled:cursor-not-allowed disabled:opacity-45"><GitBranch size={13} />排他网关</button>
            {detail.availablePackages.map(entry => <button key={entry.name} type="button" draggable onDragStart={event => { event.dataTransfer.setData('application/decision-workbench-flow', JSON.stringify({ type: 'rule-group', packageName: entry.name })); event.dataTransfer.effectAllowed = 'copy' }} className="inline-flex h-8 shrink-0 cursor-grab items-center gap-1.5 border border-ink-border bg-white px-2 text-[10px] text-ink-1 hover:border-brand-primary hover:bg-brand-primary-l" title={`拖入规则包：${entry.label}`}><Layers3 size={13} className="text-brand-primary" />{entry.label}</button>)}
            {availableFlows.map(flow => <button key={flow.id} type="button" draggable onDragStart={event => { event.dataTransfer.setData('application/decision-workbench-flow', JSON.stringify({ type: 'subflow', id: flow.id })); event.dataTransfer.effectAllowed = 'copy' }} className="inline-flex h-8 shrink-0 cursor-grab items-center gap-1.5 border border-[#00838f] bg-white px-2 text-[10px] text-[#006064] hover:bg-[#e0f7fa]"><Network size={13} />{flow.name}</button>)}
          </div>
          <aside className="border-r border-ink-border bg-[#fafafa] max-xl:hidden">
            <div className="border-b border-ink-border p-2">
              <label className="flex h-8 items-center gap-2 border border-ink-border bg-white px-2 text-ink-3"><Search size={13} /><input className="min-w-0 flex-1 bg-transparent text-[11px] text-ink-1 outline-none" value={paletteSearch} onChange={event => setPaletteSearch(event.target.value)} placeholder="搜索节点" /></label>
            </div>
            <div className="h-[518px] overflow-y-auto">
              <div className="border-b border-ink-border bg-[#f4f4f4] px-2.5 py-1.5 text-[10px] font-semibold text-ink-2">规则包</div>
              {palettePackages.map(entry => <PaletteItem key={entry.name} icon={Layers3} title={entry.label} detail={`${entry.name} · ${entry.publishedRuleCount} 规则 / ${entry.publishedTableCount} 表`} payload={{ type: 'rule-group', packageName: entry.name }} />)}
              {!palettePackages.length && <p className="px-3 py-3 text-[10px] text-ink-3">没有匹配的规则包</p>}
              <div className="border-y border-ink-border bg-[#f4f4f4] px-2.5 py-1.5 text-[10px] font-semibold text-ink-2">单个资产</div>
              {paletteAssets.map(asset => <PaletteItem key={`${asset.type}:${asset.id}`} icon={asset.type === 'table' ? Table2 : FileText} title={asset.name} detail={`${asset.assetKind === 'decision-tree' ? '决策树' : asset.assetKind === 'scorecard' ? '计分卡' : asset.assetKind === 'rule-template' ? '规则模板' : asset.category} · v${asset.version}`} payload={{ type: asset.type, id: asset.id }} />)}
              <div className="border-y border-ink-border bg-[#f4f4f4] px-2.5 py-1.5 text-[10px] font-semibold text-ink-2">子流程</div>
              {paletteSubflows.map(flow => <PaletteItem key={flow.id} icon={Network} title={flow.name} detail={`已发布 v${flow.version} · 发布时内联冻结`} payload={{ type: 'subflow', id: flow.id }} />)}
              {!paletteSubflows.length && <p className="px-3 py-3 text-[10px] text-ink-3">没有可引用的已发布子流程</p>}
              <div className="border-y border-ink-border bg-[#f4f4f4] px-2.5 py-1.5 text-[10px] font-semibold text-ink-2">流程控制</div>
              <GatewayPaletteItem disabled={!canAddGateway} onActivate={() => addOrSelectGateway()} />
            </div>
          </aside>
          <FlowCanvas
            flow={definition}
            compact
            editable
            selectedNodeId={selectedNodeId}
            onNodeSelect={setSelectedNodeId}
            onNodeMove={moveNode}
            onDropItem={dropItem}
            initialViewport={draft.editor?.viewport}
            onViewportChange={viewport => setDraft(current => ({ ...current, editor: { positions: current.editor?.positions ?? {}, viewport } }))}
          />
          <aside className="border-l border-ink-border bg-white max-lg:border-l-0 max-lg:border-t">
            <div className="flex h-10 items-center border-b border-ink-border bg-[#fafafa] px-3"><b className="text-[11px]">节点配置</b>{selectedStep && <button type="button" className="ml-auto inline-flex size-7 items-center justify-center text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={deleteSelectedStep} title="删除节点"><Trash2 size={14} /></button>}</div>
            {!selectedStep && !gatewaySelected && <div className="flex h-[518px] items-center justify-center px-5 text-center text-[11px] text-ink-3">未选择节点</div>}
            {selectedGraphGateway && <div className="h-[518px] overflow-y-auto">
              <div className="space-y-3 border-b border-ink-border p-3">
                <div className="flex items-center"><div><span className="text-[9px] font-semibold text-ink-3">节点类型</span><p className="text-xs font-semibold">高级图排他网关</p></div><span className="ml-auto text-[10px] text-ink-3">{selectedGraphGateway.branches.length} / 8 分支</span></div>
                <input className="control-input h-8 text-xs" value={selectedGraphGateway.name} onChange={event => updateGraphNode(selectedGraphGatewayIndex, node => node.type === 'gateway' ? { ...node, name: event.target.value } : node)} aria-label="网关名称" />
                <p className="text-[10px] leading-5 text-ink-3">分支条件与目标节点请在下方“结构化备用编辑”中配置。</p>
                <button type="button" className="h-7 w-full border border-[#ef9a9a] bg-white text-[10px] text-[#c62828]" onClick={() => { deleteGraphNode(selectedGraphGateway.id); setSelectedNodeId(null) }}>删除此网关</button>
              </div>
            </div>}
            {selectedGraphParallel && <div className="h-[518px] overflow-y-auto">
              <div className="space-y-3 border-b border-ink-border p-3"><div className="flex items-center"><div><span className="text-[9px] font-semibold text-ink-3">节点类型</span><p className="text-xs font-semibold">并行网关</p></div><span className="ml-auto text-[10px] text-ink-3">{selectedGraphParallel.branches.length} / 8 分支</span></div><input className="control-input h-8 text-xs" value={selectedGraphParallel.name} onChange={event => updateGraphNode(selectedGraphParallelIndex, node => node.type === 'parallel' ? { ...node, name: event.target.value } : node)} aria-label="并行网关名称" /><p className="text-[10px] leading-5 text-ink-3">每条分支使用入口事实的独立副本执行；聚合时不同字段或相同值自动合并，同一字段不同值会明确报错。</p><button type="button" className="h-7 w-full border border-[#ef9a9a] bg-white text-[10px] text-[#c62828]" onClick={() => { deleteGraphNode(selectedGraphParallel.id); setSelectedNodeId(null) }}>删除并行网关</button></div>
            </div>}
            {selectedGraphJoin && <div className="h-[518px] overflow-y-auto">
              <div className="space-y-3 border-b border-ink-border p-3"><div><span className="text-[9px] font-semibold text-ink-3">节点类型</span><p className="text-xs font-semibold">聚合节点</p></div><input className="control-input h-8 text-xs" value={selectedGraphJoin.name} onChange={event => updateGraphNode(selectedGraphJoinIndex, node => node.type === 'join' ? { ...node, name: event.target.value } : node)} aria-label="聚合节点名称" /><p className="text-[10px] leading-5 text-ink-3">聚合节点等待所属并行分支全部完成，再合并结果并进入后继节点。</p><button type="button" className="h-7 w-full border border-[#ef9a9a] bg-white text-[10px] text-[#c62828]" onClick={() => { deleteGraphNode(selectedGraphJoin.id); setSelectedNodeId(null) }}>删除聚合节点</button></div>
            </div>}
            {gatewaySelected && selectedGateway && <div className="h-[518px] overflow-y-auto">
              <div className="space-y-2 border-b border-ink-border p-3"><div className="flex items-center"><div><span className="text-[9px] font-semibold text-ink-3">节点类型</span><p className="text-xs font-semibold">排他网关</p></div><span className="ml-auto text-[10px] text-ink-3">{selectedGateway.branches.length} / 8 分支</span></div><input className="control-input h-7 text-[11px]" value={selectedGateway.name} onChange={event => updateGateway(selectedGatewayIndex, gateway => ({ ...gateway, name: event.target.value }))} aria-label="网关名称" /><label className="block text-[10px] font-semibold text-ink-3">插入位置<select className="control-input mt-1 h-7 text-[10px]" value={selectedGateway.afterStep} onChange={event => updateGateway(selectedGatewayIndex, gateway => ({ ...gateway, afterStep: Number(event.target.value) }))}>{Array.from({ length: draft.steps.length + 1 }, (_, index) => <option key={index} value={index} disabled={gateways.some((gateway, position) => position !== selectedGatewayIndex && gateway.afterStep === index)}>{index === 0 ? '开始后、首个公共步骤前' : index === draft.steps.length ? '所有公共步骤后' : `第 ${index} 个公共步骤后`}</option>)}</select></label><button type="button" className="h-7 w-full border border-[#ef9a9a] bg-white text-[10px] text-[#c62828]" onClick={() => { setDraft(current => ({ ...current, gateways: (current.gateways ?? []).filter((_, index) => index !== selectedGatewayIndex) })); setSelectedNodeId(null) }}>删除此网关</button></div>
              {selectedGateway.branches.map((branch, branchIndex) => <div key={branch.id} className="space-y-2 border-b border-ink-border p-3">
                <div className="flex items-center gap-1">
                  <input className="control-input h-7 min-w-0 flex-1 text-[11px]" value={branch.name} onChange={event => updateBranch(branchIndex, current => ({ ...current, name: event.target.value }))} aria-label={`第 ${branchIndex + 1} 个分支名称`} />
                  <button type="button" className="inline-flex size-6 items-center justify-center text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={branchIndex === 0} onClick={() => moveBranch(branchIndex, -1)} title="上移分支"><ChevronUp size={12} /></button>
                  <button type="button" className="inline-flex size-6 items-center justify-center text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={branchIndex === selectedGateway.branches.length - 1} onClick={() => moveBranch(branchIndex, 1)} title="下移分支"><ChevronDown size={12} /></button>
                  <button type="button" className="inline-flex size-6 items-center justify-center text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828] disabled:opacity-30" disabled={selectedGateway.branches.length <= 1} onClick={() => deleteBranch(branchIndex)} title={selectedGateway.branches.length <= 1 ? '至少保留一个分支；如不需要请删除网关' : '删除分支'}><Trash2 size={12} /></button>
                </div>
                {branch.default ? <p className="text-[10px] text-ink-3">默认分支</p> : <>
                  <select aria-label={`第 ${branchIndex + 1} 个分支条件字段`} className="control-input h-7 text-[10px]" value={branch.condition?.field ?? ''} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: event.target.value, operator: current.condition?.operator || '==', value: '' } }))}>{inputFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select>
                  <div className="grid grid-cols-[105px_minmax(0,1fr)] gap-2"><select aria-label={`第 ${branchIndex + 1} 个分支运算符`} className="control-input h-7 text-[10px]" value={branch.condition?.operator ?? '=='} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: event.target.value, value: current.condition?.value || '' } }))}>{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input aria-label={`第 ${branchIndex + 1} 个分支比较值`} className="control-input h-7 font-mono text-[10px]" value={branch.condition?.value ?? ''} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: current.condition?.operator || '==', value: event.target.value } }))} placeholder="比较值" /></div>
                </>}
              </div>)}
              <div className="flex gap-2 p-3"><button type="button" className="inline-flex h-7 items-center gap-1 bg-brand-primary px-2 text-[10px] text-white disabled:opacity-35" disabled={!canAddConditionalBranch} onClick={() => addBranch(false)}><Plus size={11} />条件分支</button><button type="button" className="inline-flex h-7 items-center gap-1 border border-ink-border bg-white px-2 text-[10px] text-ink-2 disabled:opacity-35" disabled={!canAddStep || selectedGateway.branches.some(branch => branch.default) || selectedGateway.branches.length >= 8} onClick={() => addBranch(true)}><Plus size={11} />默认分支</button></div>
            </div>}
            {selectedStep && <div className="h-[518px] overflow-y-auto">
              <div className="space-y-3 p-3">
                <div><span className="text-[9px] font-semibold text-ink-3">节点类型</span><p className="mt-1 text-xs font-semibold">{selectedStep.step.type === 'subflow' ? '子流程' : selectedStep.step.type === 'rule-group' ? 'Rule Group 规则组' : selectedStep.step.type === 'table' ? '决策表' : 'BAL 规则'}</p></div>
                {selectedStep.step.type === 'rule-group' ? <>
                  <label className="block text-[10px] font-semibold text-ink-3">规则包<select className="control-input mt-1 h-8 text-xs" value={selectedStep.step.selector?.packageName ?? ''} onChange={event => updateSelectedStep({ ...selectedStep.step, selector: { packageName: event.target.value, includeChildren: selectedStep.step.selector?.includeChildren === true } })}>{detail.availablePackages.map(entry => <option key={entry.name} value={entry.name}>{entry.label} · {entry.name}</option>)}</select></label>
                  <label className="flex items-center gap-2 text-[11px] text-ink-2"><input type="checkbox" checked={selectedStep.step.selector?.includeChildren === true} onChange={event => updateSelectedStep({ ...selectedStep.step, selector: { packageName: selectedStep.step.selector?.packageName ?? detail.availablePackages[0]?.name ?? '', includeChildren: event.target.checked } })} />包含子包</label>
                  <div className="border border-ink-border bg-[#fafafa] p-2 text-[10px] text-ink-2"><p><b>{selectedPackage?.publishedRuleCount ?? 0}</b> 条规则 · <b>{selectedPackage?.publishedTableCount ?? 0}</b> 张决策表</p>{Boolean(selectedPackage?.excludedDraftCount) && <p className="mt-1 text-[#8a5a00]">排除 {selectedPackage?.excludedDraftCount} 个未发布资产</p>}</div>
                  <div><p className="mb-1 text-[10px] font-semibold text-ink-3">成员预览</p><div className="max-h-36 overflow-y-auto border border-ink-border">{selectedPackage?.members.map(member => <div key={`${member.type}:${member.id}`} className="flex items-center gap-1 border-b border-[#ededed] px-2 py-1.5 text-[10px] last:border-0"><span className="truncate">{member.name}</span><span className="ml-auto shrink-0 text-ink-3">{member.type === 'table' ? '表' : '规则'} v{member.version}</span></div>)}{!selectedPackage?.members.length && <p className="p-2 text-[10px] text-[#a31515]">没有已发布成员，当前节点无法发布。</p>}</div></div>
                </> : selectedStep.step.type === 'subflow' ? <><label className="block text-[10px] font-semibold text-ink-3">已发布子流程<select className="control-input mt-1 h-8 text-xs" value={selectedStep.step.id ?? ''} onChange={event => updateSelectedStep({ nodeId: selectedStep.step.nodeId, type: 'subflow', id: event.target.value })}>{availableFlows.map(flow => <option key={flow.id} value={flow.id}>{flow.name} · v{flow.version}</option>)}</select></label><p className="border border-[#80cbc4] bg-[#e0f7fa] p-2 text-[10px] text-[#006064]">发布父规则集时冻结并内联子流程；子流程升版后需重新发布父规则集。</p></> : <div className="border border-ink-border bg-[#fafafa] p-2 text-[10px] text-ink-2">{detail.availableAssets.find(asset => asset.id === selectedStep.step.id)?.name ?? '引用资产不可用'}</div>}
              </div>
              {selectedStep.step.type !== 'subflow' && <><MappingEditor label="输入映射" mappings={selectedStep.step.inputMappings ?? []} sourceFields={fields} targetFields={fields.filter(field => field.direction === 'input')} onChange={inputMappings => updateSelectedStep({ ...selectedStep.step, inputMappings: inputMappings.length ? inputMappings : undefined })} /><MappingEditor label="输出映射" mappings={selectedStep.step.outputMappings ?? []} sourceFields={fields.filter(field => field.direction === 'output')} targetFields={fields} onChange={outputMappings => updateSelectedStep({ ...selectedStep.step, outputMappings: outputMappings.length ? outputMappings : undefined })} /></>}
            </div>}
          </aside>
        </div>
      </section>

      <details>
        <summary className="flex h-9 cursor-pointer list-none items-center gap-2 border-b border-ink-border px-1 text-[11px] font-semibold text-ink-2"><GitBranch size={13} />结构化备用编辑</summary>
        <div className="mt-3 space-y-[14px]">
      {graph ? <GraphEditor
        draft={draft}
        assets={detail.availableAssets}
        packages={detail.availablePackages}
        subflows={availableFlows}
        fields={fields}
        canAddStep={canAddStep}
        onEntryChange={entry => setDraft(current => current.graph ? ({ ...current, graph: { ...current.graph, entry } }) : current)}
        onNodeChange={updateGraphNode}
        onNodeDelete={deleteGraphNode}
        onAddStep={addGraphStep}
        onAddGateway={addGraphGateway}
        onAddParallel={addGraphParallel}
        onAddParallelBranch={addGraphParallelBranch}
      /> : <>
      <section className="flex items-center gap-3 rounded-[3px] border border-[#f3c65f] bg-[#fff8e1] px-4 py-3 text-[11px] text-[#734d00]"><GitBranch size={15} /><span>需要在分支内继续判断，或让多条路径汇入同一节点时，可升级为高级有向图编排。升级后不支持降级，但保存前可撤销。</span><button type="button" className="ml-auto h-8 shrink-0 border border-[#b84600] bg-white px-3 text-[11px] text-[#b84600]" onClick={upgradeToGraph}>升级高级图编排</button></section>
      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
        <div className="flex items-center border-b border-ink-border bg-[#fafafa] px-4 py-2.5">
          <h2 className="text-xs font-semibold">公共步骤</h2>
          <span className="ml-2 text-[10px] text-ink-3">进入网关前按顺序执行</span>
          <button type="button" className="ml-auto inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-40" disabled={!canAddStep} onClick={() => { const step = newStep(detail.availableAssets, detail.availablePackages, availableFlows); if (step) setDraft(current => ({ ...current, steps: [...current.steps, step] })) }}><Plus size={13} />添加步骤</button>
        </div>
        {draft.steps.length === 0 && <p className="px-4 py-4 text-[11px] text-ink-3">当前没有公共步骤，可直接从排他网关进入分支。</p>}
        {draft.steps.map((step, index) => <StepEditor key={step.nodeId} step={step} index={index} count={draft.steps.length} assets={detail.availableAssets} packages={detail.availablePackages} subflows={availableFlows} fields={fields} onChange={next => setDraft(current => ({ ...current, steps: current.steps.map((item, position) => position === index ? next : item) }))} onDelete={() => deleteCommonStep(index)} onMove={direction => setDraft(current => ({ ...current, steps: moveStep(current.steps, index, direction) }))} />)}
      </section>

      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-border bg-[#fafafa] px-4 py-2.5">
          <GitBranch size={14} className="text-brand-primary" />
          <h2 className="text-xs font-semibold">串行排他网关</h2>
          <span className="text-[10px] text-ink-3">分支执行后汇合，再继续后续公共步骤</span>
          <button type="button" className="ml-auto inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-40" disabled={!canAddGateway} onClick={() => addOrSelectGateway()}><Plus size={13} />新增网关</button>
        </div>
        {gateways.length === 0 && <p className="px-4 py-4 text-[11px] text-ink-3">未配置网关，公共步骤将按顺序执行。</p>}
        {gateways.map((gateway, gatewayIndex) => <div key={gateway.id} className="border-b border-ink-border last:border-b-0">
          <div className="flex flex-wrap items-end gap-2 bg-[#f7f7f7] px-3 py-2">
            <label className="min-w-48 flex-1 text-[10px] font-semibold text-ink-3">网关名称<input className="control-input mt-1 h-8 text-xs" value={gateway.name} onChange={event => updateGateway(gatewayIndex, current => ({ ...current, name: event.target.value }))} /></label>
            <label className="min-w-52 flex-1 text-[10px] font-semibold text-ink-3">插入位置<select className="control-input mt-1 h-8 text-xs" value={gateway.afterStep} onChange={event => updateGateway(gatewayIndex, current => ({ ...current, afterStep: Number(event.target.value) }))}>{Array.from({ length: draft.steps.length + 1 }, (_, boundary) => <option key={boundary} value={boundary} disabled={gateways.some((item, position) => position !== gatewayIndex && item.afterStep === boundary)}>{boundary === 0 ? '首个公共步骤前' : boundary === draft.steps.length ? '所有公共步骤后' : `第 ${boundary} 个公共步骤后`}</option>)}</select></label>
            <span className="pb-2 text-[10px] text-ink-3">{gateway.branches.length} / 8 分支</span>
            <button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center rounded-[2px] text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={() => setDraft(current => ({ ...current, gateways: (current.gateways ?? []).filter((_, position) => position !== gatewayIndex) }))} title="删除网关"><Trash2 size={14} /></button>
          </div>
          {gateway.branches.map((branch, branchIndex) => <div key={branch.id} className="border-t border-[#e8e8e8]">
            <div className="grid grid-cols-[minmax(130px,0.8fr)_minmax(150px,1fr)_110px_minmax(120px,1fr)_28px] items-end gap-2 bg-[#fcfcfc] px-3 py-2 max-lg:grid-cols-2">
              <label className="text-[10px] font-semibold text-ink-3">分支名称<input className="control-input mt-1 h-8 text-xs" value={branch.name} onChange={event => updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, name: event.target.value }))} /></label>
              {branch.default ? <span className="self-center text-[11px] text-ink-3">未命中其他条件时执行</span> : <>
                <label className="text-[10px] font-semibold text-ink-3">条件字段<select className="control-input mt-1 h-8 text-xs" value={branch.condition?.field ?? ''} onChange={event => updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, condition: { field: event.target.value, operator: current.condition?.operator || '==', value: '' } }))}>{inputFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select></label>
                <label className="text-[10px] font-semibold text-ink-3">运算符<select className="control-input mt-1 h-8 text-xs" value={branch.condition?.operator ?? '=='} onChange={event => updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: event.target.value, value: current.condition?.value || '' } }))}>{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="text-[10px] font-semibold text-ink-3">比较值<input className="control-input mt-1 h-8 font-mono text-xs" value={branch.condition?.value ?? ''} onChange={event => updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: current.condition?.operator || '==', value: event.target.value } }))} /></label>
              </>}
              <button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center rounded-[2px] text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828] disabled:opacity-30" disabled={gateway.branches.length <= 1} onClick={() => updateGateway(gatewayIndex, current => ({ ...current, branches: current.branches.filter((_, position) => position !== branchIndex) }))} title={gateway.branches.length <= 1 ? '至少保留一个分支；如不需要请删除网关' : '删除分支'}><Trash2 size={14} /></button>
            </div>
            <div className="flex items-center border-y border-[#e8e8e8] bg-white px-3 py-1.5"><span className="text-[10px] font-semibold text-ink-3">分支步骤</span><button type="button" className="ml-auto inline-flex h-6 items-center gap-1 rounded-[2px] px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-40" disabled={!canAddStep} onClick={() => { const step = newStep(detail.availableAssets, detail.availablePackages, availableFlows); if (step) updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, steps: [...current.steps, step] })) }}><Plus size={12} />添加</button></div>
            {branch.steps.map((step, stepIndex) => <StepEditor key={step.nodeId} step={step} index={stepIndex} count={branch.steps.length} assets={detail.availableAssets} packages={detail.availablePackages} subflows={availableFlows} fields={fields} onChange={next => updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, steps: current.steps.map((item, position) => position === stepIndex ? next : item) }))} onDelete={() => updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, steps: current.steps.filter((_, position) => position !== stepIndex) }))} onMove={direction => updateGatewayBranch(gatewayIndex, branchIndex, current => ({ ...current, steps: moveStep(current.steps, stepIndex, direction) }))} />)}
          </div>)}
          <div className="flex gap-2 bg-white px-3 py-2"><button type="button" className="inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-40" disabled={!canAddStep || !inputFields.length || gateway.branches.length >= 8} onClick={() => addBranchToGateway(gatewayIndex, false)}><Plus size={13} />条件分支</button><button type="button" className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-40" disabled={!canAddStep || gateway.branches.some(branch => branch.default) || gateway.branches.length >= 8} onClick={() => addBranchToGateway(gatewayIndex, true)}><Plus size={13} />默认分支</button></div>
        </div>)}
      </section>
      </>}
        </div>
      </details>
    </div>
  )
}
