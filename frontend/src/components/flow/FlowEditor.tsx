import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileText, GitBranch, LayoutGrid, Layers3, Plus, Redo2, Rocket, Save, Search, Table2, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { flowDefinitionFromDetail } from '../../api/flows'
import type { BomField, FlowAssetOption, FlowBranchDraft, FlowDetail, FlowDraft, FlowMapping, FlowPackageOption, FlowStepDraft } from '../../types'
import FlowCanvas from './FlowCanvas'

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

function StepEditor({ step, index, count, assets, packages, fields, onChange, onDelete, onMove }: {
  step: FlowStepDraft
  index: number
  count: number
  assets: FlowAssetOption[]
  packages: FlowPackageOption[]
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
          const asset = assets.find(item => `${item.type}:${item.id}` === event.target.value)
          if (asset) onChange({ nodeId: step.nodeId, id: asset.id, type: asset.type, inputMappings: step.inputMappings, outputMappings: step.outputMappings })
        }}>
          <optgroup label="规则包">
            {packages.map(entry => <option key={`group:${entry.name}`} value={`rule-group:${entry.name}`}>{entry.label} · {entry.publishedRuleCount + entry.publishedTableCount} 个已发布资产</option>)}
          </optgroup>
          <optgroup label="单个资产">
          {assets.map(asset => <option key={`${asset.type}:${asset.id}`} value={`${asset.type}:${asset.id}`}>{asset.name} · {asset.type === 'table' ? '决策表' : '规则'} v{asset.version}</option>)}
          </optgroup>
        </select>
        <span className="text-[10px] text-ink-3">{step.type === 'rule-group' ? '规则组' : step.type === 'table' ? '决策表' : '规则'}</span>
        <button type="button" className="inline-flex size-6 items-center justify-center rounded-[2px] text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={onDelete} title="删除步骤"><Trash2 size={13} /></button>
      </div>
      <div className="flex gap-1 border-t border-[#f2f2f2] px-3 py-1">
        <button type="button" className="inline-flex size-6 items-center justify-center rounded-[2px] text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} title="上移"><ChevronUp size={13} /></button>
        <button type="button" className="inline-flex size-6 items-center justify-center rounded-[2px] text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={index === count - 1} onClick={() => onMove(1)} title="下移"><ChevronDown size={13} /></button>
        <span className="ml-auto self-center text-[10px] text-ink-3">字段映射</span>
      </div>
      <MappingEditor label="输入映射" mappings={step.inputMappings ?? []} sourceFields={fields} targetFields={inputFields} onChange={inputMappings => onChange({ ...step, inputMappings: inputMappings.length ? inputMappings : undefined })} />
      <MappingEditor label="输出映射" mappings={step.outputMappings ?? []} sourceFields={outputFields} targetFields={fields} onChange={outputMappings => onChange({ ...step, outputMappings: outputMappings.length ? outputMappings : undefined })} />
    </div>
  )
}

function newStep(assets: FlowAssetOption[]): FlowStepDraft | null {
  const asset = assets[0]
  return asset ? { nodeId: crypto.randomUUID(), type: asset.type, id: asset.id } : null
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
  draft.steps = draft.steps.map((step, index) => {
    if (step.nodeId) return step
    const nodeId = crypto.randomUUID()
    const legacy = `common:${index}`
    if (positions[legacy]) positions[nodeId] = positions[legacy]
    return { ...step, nodeId }
  })
  draft.branches = (draft.branches ?? []).map(branch => ({
    ...branch,
    steps: branch.steps.map((step, index) => {
      if (step.nodeId) return step
      const nodeId = crypto.randomUUID()
      const legacy = `branch:${branch.id}:${index}`
      if (positions[legacy]) positions[nodeId] = positions[legacy]
      return { ...step, nodeId }
    }),
  }))
  draft.editor = { ...draft.editor, positions }
  return draft
}

function PaletteItem({ icon: Icon, title, detail, payload }: {
  icon: typeof Layers3
  title: string
  detail: string
  payload: { type: 'rule-group' | 'rule' | 'table'; id?: string; packageName?: string }
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

export default function FlowEditor({ detail, fields, busy, onSave, onCompile, onPublish }: FlowEditorProps) {
  const source = detail.draft
  const [draft, setDraftState] = useState<FlowDraft>(() => normalizeFlowDraft(source))
  const undoStack = useRef<FlowDraft[]>([])
  const redoStack = useRef<FlowDraft[]>([])
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(source)
  const definition = useMemo(() => flowDefinitionFromDetail(detail, draft), [detail, draft])
  const inputFields = fields.filter(field => field.direction === 'input')
  const duplicateOutputs = useMemo(() => {
    const steps = [...draft.steps, ...(draft.branches || []).flatMap(branch => branch.steps)]
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
  }, [detail.availableAssets, detail.availablePackages, draft])

  useEffect(() => {
    setDraftState(normalizeFlowDraft(source))
    undoStack.current = []
    redoStack.current = []
    setNotice(null)
    setSelectedNodeId(null)
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
    const commonIndex = draft.steps.findIndex(step => step.nodeId === selectedNodeId)
    if (commonIndex >= 0) return { step: draft.steps[commonIndex], commonIndex, branchIndex: -1, stepIndex: commonIndex }
    for (const [branchIndex, branch] of (draft.branches ?? []).entries()) {
      const stepIndex = branch.steps.findIndex(step => step.nodeId === selectedNodeId)
      if (stepIndex >= 0) return { step: branch.steps[stepIndex], commonIndex: -1, branchIndex, stepIndex }
    }
    return null
  }, [draft.branches, draft.steps, selectedNodeId])
  const gatewaySelected = selectedNodeId === 'gateway'
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

  const run = async (action: () => Promise<unknown>, success: string) => {
    setNotice(null)
    try {
      await action()
      setNotice({ error: false, text: success })
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : '操作失败' })
    }
  }
  const updateBranch = (index: number, updater: (branch: FlowBranchDraft) => FlowBranchDraft) => setDraft(current => ({
    ...current,
    branches: (current.branches ?? []).map((branch, position) => position === index ? updater(branch) : branch),
  }))
  const deleteBranch = (index: number) => {
    setDraft(current => ({ ...current, branches: (current.branches ?? []).filter((_, position) => position !== index) }))
    if ((draft.branches?.length ?? 0) === 1) setSelectedNodeId(null)
  }
  const moveBranch = (index: number, direction: -1 | 1) => setDraft(current => {
    const branches = [...(current.branches ?? [])]
    const target = index + direction
    if (target < 0 || target >= branches.length) return current
    ;[branches[index], branches[target]] = [branches[target], branches[index]]
    return { ...current, branches }
  })
  const addBranch = (isDefault: boolean) => {
    if ((draft.branches?.length ?? 0) >= 8 || (isDefault && (draft.branches ?? []).some(branch => branch.default))) return
    const step = newStep(detail.availableAssets)
    if (!step) return
    const firstInput = inputFields[0]
    const branch: FlowBranchDraft = {
      id: crypto.randomUUID(), name: isDefault ? '默认路径' : `条件路径 ${(draft.branches?.length ?? 0) + 1}`,
      default: isDefault,
      condition: isDefault ? undefined : { field: firstInput?.key || '', operator: '==', value: '' },
      steps: [step],
    }
    setDraft(current => ({ ...current, branches: [...(current.branches ?? []), branch] }))
    setSelectedNodeId('gateway')
  }
  const updateSelectedStep = (next: FlowStepDraft) => {
    if (!selectedStep) return
    setDraft(current => selectedStep.commonIndex >= 0
      ? { ...current, steps: current.steps.map((step, index) => index === selectedStep.commonIndex ? next : step) }
      : {
          ...current,
          branches: (current.branches ?? []).map((branch, branchIndex) => branchIndex === selectedStep.branchIndex
            ? { ...branch, steps: branch.steps.map((step, stepIndex) => stepIndex === selectedStep.stepIndex ? next : step) }
            : branch),
        })
  }
  const deleteSelectedStep = () => {
    if (!selectedStep) return
    setDraft(current => selectedStep.commonIndex >= 0
      ? { ...current, steps: current.steps.filter((_, index) => index !== selectedStep.commonIndex) }
      : {
          ...current,
          branches: (current.branches ?? []).map((branch, branchIndex) => branchIndex === selectedStep.branchIndex
            ? { ...branch, steps: branch.steps.filter((_, stepIndex) => stepIndex !== selectedStep.stepIndex) }
            : branch),
        })
    setSelectedNodeId(null)
  }
  const moveNode = (nodeId: string, position: { x: number; y: number }) => setDraft(current => ({
    ...current,
    editor: { ...current.editor, positions: { ...(current.editor?.positions ?? {}), [nodeId]: position } },
  }))
  const dropItem = (item: { type: 'rule-group' | 'rule' | 'table'; id?: string; packageName?: string }, position: { x: number; y: number }) => {
    if (draft.steps.length + (draft.branches ?? []).reduce((total, branch) => total + branch.steps.length, 0) >= 20) {
      setNotice({ error: true, text: '规则流最多支持 20 个步骤' })
      return
    }
    const nodeId = crypto.randomUUID()
    const step: FlowStepDraft | null = item.type === 'rule-group' && item.packageName
      ? { nodeId, type: 'rule-group', selector: { packageName: item.packageName, includeChildren: false } }
      : item.id ? { nodeId, type: item.type as 'rule' | 'table', id: item.id } : null
    if (!step) return
    const branchCandidates = definition.nodes.filter(node => node.stepType && node.branchId)
    const nearestBranchNode = branchCandidates.reduce<(typeof branchCandidates)[number] | null>((nearest, node) => (
      !nearest || Math.abs(node.position.y - position.y) < Math.abs(nearest.position.y - position.y) ? node : nearest
    ), null)
    const gatewayX = definition.nodes.find(node => node.kind === 'gateway')?.position.x
    const targetBranchId = nearestBranchNode && gatewayX != null && position.x > gatewayX + 60 && Math.abs(nearestBranchNode.position.y - position.y) <= 90 ? nearestBranchNode.branchId : null
    const commonNodes = definition.nodes.filter(node => node.stepType && node.branchId == null)
    const targetNodes = targetBranchId ? branchCandidates.filter(node => node.branchId === targetBranchId) : commonNodes
    const dropBefore = targetNodes.findIndex(node => position.x < node.position.x + 105)
    const targetLength = targetBranchId ? (draft.branches ?? []).find(branch => branch.id === targetBranchId)?.steps.length ?? 0 : draft.steps.length
    const insertAt = dropBefore < 0 ? targetLength : dropBefore
    setDraft(current => ({
      ...current,
      steps: targetBranchId ? current.steps : [...current.steps.slice(0, insertAt), step, ...current.steps.slice(insertAt)],
      branches: targetBranchId ? (current.branches ?? []).map(branch => branch.id === targetBranchId
        ? { ...branch, steps: [...branch.steps.slice(0, insertAt), step, ...branch.steps.slice(insertAt)] }
        : branch) : current.branches,
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
          <button type="button" className="inline-flex h-7 items-center gap-1 border border-ink-border bg-white px-2 text-[10px] text-ink-2 hover:bg-ink-bg disabled:opacity-35" disabled={!detail.availableAssets.length || (draft.branches?.length ?? 0) >= 8} onClick={() => addBranch(false)} title="添加条件分支"><GitBranch size={12} />分支</button>
          {notice && <span className={`ml-auto max-w-[360px] truncate text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span>}
          <button type="button" className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy || !dirty} onClick={() => run(() => onSave(draft), '规则流草稿已保存')}><Save size={13} />保存</button>
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy} onClick={() => run(async () => { const result = await onCompile(draft); setNotice({ error: false, text: `Drools ${result.engineVersion} 校验通过 · ${result.stepCount} 步` }) }, 'Drools 校验通过')}><CheckCircle2 size={13} />校验</button>
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-[2px] border border-brand-primary bg-brand-primary px-2 text-[11px] text-white hover:bg-brand-primary-d disabled:opacity-50" disabled={busy || dirty} onClick={() => run(onPublish, '规则流发布成功')} title={dirty ? '请先保存草稿' : '编译并发布当前规则流'}><Rocket size={13} />发布</button>
        </div>
        {detail.needsRepublish && <div className="flex items-start gap-2 border-b border-[#f3c65f] bg-[#fff8e1] px-4 py-2 text-[11px] text-[#734d00]"><AlertTriangle size={14} className="mt-px shrink-0" />依赖资产已有新发布版本，请重新校验并发布此规则流。</div>}
        {duplicateOutputs.length > 0 && <div className="flex items-start gap-2 border-b border-[#f3c65f] bg-[#fff8e1] px-4 py-2 text-[11px] text-[#734d00]"><AlertTriangle size={14} className="mt-px shrink-0" /><span>多个步骤会写入同一输出字段，后执行步骤将覆盖前值：{duplicateOutputs.map(item => `${fields.find(field => field.key === item.field)?.label || item.field}（${item.names.join(' → ')}）`).join('；')}</span></div>}
        <div className="grid grid-cols-[minmax(220px,1fr)_180px] gap-3 border-b border-ink-border px-4 py-3 max-sm:grid-cols-1">
          <label className="text-[10px] font-semibold text-ink-3">规则流名称<input className="control-input mt-1 h-8 text-xs" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="text-[10px] font-semibold text-ink-3">业务分类<input className="control-input mt-1 h-8 text-xs" value={draft.category ?? ''} onChange={event => setDraft({ ...draft, category: event.target.value })} /></label>
          <label className="col-span-full text-[10px] font-semibold text-ink-3">说明<textarea className="mt-1 min-h-16 w-full resize-y rounded-[3px] border border-ink-border px-[10px] py-2 text-xs font-normal text-ink-1 outline-none focus:border-brand-primary" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        </div>
        <div className="grid grid-cols-[220px_minmax(420px,1fr)_300px] max-xl:grid-cols-[minmax(420px,1fr)_280px] max-lg:grid-cols-1">
          <div className="col-span-2 hidden h-12 items-center gap-2 overflow-x-auto border-b border-ink-border bg-[#fafafa] px-2 max-xl:flex max-lg:col-span-1">
            <span className="shrink-0 text-[10px] font-semibold text-ink-3">节点</span>
            {detail.availablePackages.map(entry => <button key={entry.name} type="button" draggable onDragStart={event => { event.dataTransfer.setData('application/decision-workbench-flow', JSON.stringify({ type: 'rule-group', packageName: entry.name })); event.dataTransfer.effectAllowed = 'copy' }} className="inline-flex h-8 shrink-0 cursor-grab items-center gap-1.5 border border-ink-border bg-white px-2 text-[10px] text-ink-1 hover:border-brand-primary hover:bg-brand-primary-l" title={`拖入规则包：${entry.label}`}><Layers3 size={13} className="text-brand-primary" />{entry.label}</button>)}
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
              {paletteAssets.map(asset => <PaletteItem key={`${asset.type}:${asset.id}`} icon={asset.type === 'table' ? Table2 : FileText} title={asset.name} detail={`${asset.category} · v${asset.version}`} payload={{ type: asset.type, id: asset.id }} />)}
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
            {gatewaySelected && <div className="h-[518px] overflow-y-auto">
              <div className="flex items-center border-b border-ink-border px-3 py-2"><div><span className="text-[9px] font-semibold text-ink-3">节点类型</span><p className="text-xs font-semibold">排他网关</p></div><span className="ml-auto text-[10px] text-ink-3">{draft.branches?.length ?? 0} / 8 分支</span></div>
              {(draft.branches ?? []).map((branch, branchIndex) => <div key={branch.id} className="space-y-2 border-b border-ink-border p-3">
                <div className="flex items-center gap-1">
                  <input className="control-input h-7 min-w-0 flex-1 text-[11px]" value={branch.name} onChange={event => updateBranch(branchIndex, current => ({ ...current, name: event.target.value }))} aria-label={`第 ${branchIndex + 1} 个分支名称`} />
                  <button type="button" className="inline-flex size-6 items-center justify-center text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={branchIndex === 0} onClick={() => moveBranch(branchIndex, -1)} title="上移分支"><ChevronUp size={12} /></button>
                  <button type="button" className="inline-flex size-6 items-center justify-center text-ink-3 hover:bg-ink-bg disabled:opacity-30" disabled={branchIndex === (draft.branches?.length ?? 0) - 1} onClick={() => moveBranch(branchIndex, 1)} title="下移分支"><ChevronDown size={12} /></button>
                  <button type="button" className="inline-flex size-6 items-center justify-center text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={() => deleteBranch(branchIndex)} title="删除分支"><Trash2 size={12} /></button>
                </div>
                {branch.default ? <p className="text-[10px] text-ink-3">默认分支</p> : <>
                  <select className="control-input h-7 text-[10px]" value={branch.condition?.field ?? ''} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: event.target.value, operator: current.condition?.operator || '==', value: '' } }))}>{inputFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select>
                  <div className="grid grid-cols-[105px_minmax(0,1fr)] gap-2"><select className="control-input h-7 text-[10px]" value={branch.condition?.operator ?? '=='} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: event.target.value, value: current.condition?.value || '' } }))}>{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input className="control-input h-7 font-mono text-[10px]" value={branch.condition?.value ?? ''} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: current.condition?.operator || '==', value: event.target.value } }))} placeholder="比较值" /></div>
                </>}
              </div>)}
              <div className="flex gap-2 p-3"><button type="button" className="inline-flex h-7 items-center gap-1 bg-brand-primary px-2 text-[10px] text-white disabled:opacity-35" disabled={!detail.availableAssets.length || (draft.branches?.length ?? 0) >= 8} onClick={() => addBranch(false)}><Plus size={11} />条件分支</button><button type="button" className="inline-flex h-7 items-center gap-1 border border-ink-border bg-white px-2 text-[10px] text-ink-2 disabled:opacity-35" disabled={!detail.availableAssets.length || (draft.branches ?? []).some(branch => branch.default) || (draft.branches?.length ?? 0) >= 8} onClick={() => addBranch(true)}><Plus size={11} />默认分支</button></div>
            </div>}
            {selectedStep && <div className="h-[518px] overflow-y-auto">
              <div className="space-y-3 p-3">
                <div><span className="text-[9px] font-semibold text-ink-3">节点类型</span><p className="mt-1 text-xs font-semibold">{selectedStep.step.type === 'rule-group' ? 'Rule Group 规则组' : selectedStep.step.type === 'table' ? '决策表' : 'BAL 规则'}</p></div>
                {selectedStep.step.type === 'rule-group' ? <>
                  <label className="block text-[10px] font-semibold text-ink-3">规则包<select className="control-input mt-1 h-8 text-xs" value={selectedStep.step.selector?.packageName ?? ''} onChange={event => updateSelectedStep({ ...selectedStep.step, selector: { packageName: event.target.value, includeChildren: selectedStep.step.selector?.includeChildren === true } })}>{detail.availablePackages.map(entry => <option key={entry.name} value={entry.name}>{entry.label} · {entry.name}</option>)}</select></label>
                  <label className="flex items-center gap-2 text-[11px] text-ink-2"><input type="checkbox" checked={selectedStep.step.selector?.includeChildren === true} onChange={event => updateSelectedStep({ ...selectedStep.step, selector: { packageName: selectedStep.step.selector?.packageName ?? detail.availablePackages[0]?.name ?? '', includeChildren: event.target.checked } })} />包含子包</label>
                  <div className="border border-ink-border bg-[#fafafa] p-2 text-[10px] text-ink-2"><p><b>{selectedPackage?.publishedRuleCount ?? 0}</b> 条规则 · <b>{selectedPackage?.publishedTableCount ?? 0}</b> 张决策表</p>{Boolean(selectedPackage?.excludedDraftCount) && <p className="mt-1 text-[#8a5a00]">排除 {selectedPackage?.excludedDraftCount} 个未发布资产</p>}</div>
                  <div><p className="mb-1 text-[10px] font-semibold text-ink-3">成员预览</p><div className="max-h-36 overflow-y-auto border border-ink-border">{selectedPackage?.members.map(member => <div key={`${member.type}:${member.id}`} className="flex items-center gap-1 border-b border-[#ededed] px-2 py-1.5 text-[10px] last:border-0"><span className="truncate">{member.name}</span><span className="ml-auto shrink-0 text-ink-3">{member.type === 'table' ? '表' : '规则'} v{member.version}</span></div>)}{!selectedPackage?.members.length && <p className="p-2 text-[10px] text-[#a31515]">没有已发布成员，当前节点无法发布。</p>}</div></div>
                </> : <div className="border border-ink-border bg-[#fafafa] p-2 text-[10px] text-ink-2">{detail.availableAssets.find(asset => asset.id === selectedStep.step.id)?.name ?? '引用资产不可用'}</div>}
              </div>
              <MappingEditor label="输入映射" mappings={selectedStep.step.inputMappings ?? []} sourceFields={fields} targetFields={fields.filter(field => field.direction === 'input')} onChange={inputMappings => updateSelectedStep({ ...selectedStep.step, inputMappings: inputMappings.length ? inputMappings : undefined })} />
              <MappingEditor label="输出映射" mappings={selectedStep.step.outputMappings ?? []} sourceFields={fields.filter(field => field.direction === 'output')} targetFields={fields} onChange={outputMappings => updateSelectedStep({ ...selectedStep.step, outputMappings: outputMappings.length ? outputMappings : undefined })} />
            </div>}
          </aside>
        </div>
      </section>

      <details>
        <summary className="flex h-9 cursor-pointer list-none items-center gap-2 border-b border-ink-border px-1 text-[11px] font-semibold text-ink-2"><GitBranch size={13} />结构化备用编辑</summary>
        <div className="mt-3 space-y-[14px]">
      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
        <div className="flex items-center border-b border-ink-border bg-[#fafafa] px-4 py-2.5">
          <h2 className="text-xs font-semibold">公共步骤</h2>
          <span className="ml-2 text-[10px] text-ink-3">进入网关前按顺序执行</span>
          <button type="button" className="ml-auto inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-40" disabled={!detail.availableAssets.length} onClick={() => { const step = newStep(detail.availableAssets); if (step) setDraft(current => ({ ...current, steps: [...current.steps, step] })) }}><Plus size={13} />添加步骤</button>
        </div>
        {draft.steps.length === 0 && <p className="px-4 py-4 text-[11px] text-ink-3">当前没有公共步骤，可直接从排他网关进入分支。</p>}
        {draft.steps.map((step, index) => <StepEditor key={step.nodeId} step={step} index={index} count={draft.steps.length} assets={detail.availableAssets} packages={detail.availablePackages} fields={fields} onChange={next => setDraft(current => ({ ...current, steps: current.steps.map((item, position) => position === index ? next : item) }))} onDelete={() => setDraft(current => ({ ...current, steps: current.steps.filter((_, position) => position !== index) }))} onMove={direction => setDraft(current => ({ ...current, steps: moveStep(current.steps, index, direction) }))} />)}
      </section>

      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-border bg-[#fafafa] px-4 py-2.5">
          <GitBranch size={14} className="text-brand-primary" />
          <h2 className="text-xs font-semibold">排他分支</h2>
          <button type="button" className="ml-auto inline-flex h-7 items-center gap-1 rounded-[2px] px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-40" disabled={!detail.availableAssets.length} onClick={() => addBranch(false)}><Plus size={13} />条件分支</button>
          <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-ink-border bg-white px-2 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-40" disabled={!detail.availableAssets.length || (draft.branches ?? []).some(branch => branch.default)} onClick={() => addBranch(true)}><Plus size={13} />默认分支</button>
        </div>
        {(draft.branches ?? []).length === 0 && <p className="px-4 py-4 text-[11px] text-ink-3">未配置分支，公共步骤执行后直接结束。</p>}
        {(draft.branches ?? []).map((branch, branchIndex) => (
          <div key={branch.id} className="border-b border-ink-border last:border-b-0">
            <div className="grid grid-cols-[minmax(130px,0.8fr)_minmax(150px,1fr)_110px_minmax(120px,1fr)_28px] items-end gap-2 bg-[#fcfcfc] px-3 py-2 max-lg:grid-cols-2">
              <label className="text-[10px] font-semibold text-ink-3">分支名称<input className="control-input mt-1 h-8 text-xs" value={branch.name} onChange={event => updateBranch(branchIndex, current => ({ ...current, name: event.target.value }))} /></label>
              {branch.default
                ? <span className="self-center text-[11px] text-ink-3">未命中其他条件时执行</span>
                : <>
                    <label className="text-[10px] font-semibold text-ink-3">条件字段<select className="control-input mt-1 h-8 text-xs" value={branch.condition?.field ?? ''} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: event.target.value, operator: current.condition?.operator || '==', value: '' } }))}>{inputFields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select></label>
                    <label className="text-[10px] font-semibold text-ink-3">运算符<select className="control-input mt-1 h-8 text-xs" value={branch.condition?.operator ?? '=='} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: event.target.value, value: current.condition?.value || '' } }))}>{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="text-[10px] font-semibold text-ink-3">比较值<input className="control-input mt-1 h-8 font-mono text-xs" value={branch.condition?.value ?? ''} onChange={event => updateBranch(branchIndex, current => ({ ...current, condition: { field: current.condition?.field || inputFields[0]?.key || '', operator: current.condition?.operator || '==', value: event.target.value } }))} /></label>
                  </>}
              <button type="button" className="mb-0.5 inline-flex size-7 items-center justify-center rounded-[2px] text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={() => setDraft(current => ({ ...current, branches: (current.branches ?? []).filter((_, position) => position !== branchIndex) }))} title="删除分支"><Trash2 size={14} /></button>
            </div>
            <div className="flex items-center border-y border-[#e8e8e8] bg-white px-3 py-1.5"><span className="text-[10px] font-semibold text-ink-3">分支步骤</span><button type="button" className="ml-auto inline-flex h-6 items-center gap-1 rounded-[2px] px-2 text-[10px] text-brand-primary hover:bg-brand-primary-l" onClick={() => { const step = newStep(detail.availableAssets); if (step) updateBranch(branchIndex, current => ({ ...current, steps: [...current.steps, step] })) }}><Plus size={12} />添加</button></div>
            {branch.steps.map((step, stepIndex) => <StepEditor key={step.nodeId} step={step} index={stepIndex} count={branch.steps.length} assets={detail.availableAssets} packages={detail.availablePackages} fields={fields} onChange={next => updateBranch(branchIndex, current => ({ ...current, steps: current.steps.map((item, position) => position === stepIndex ? next : item) }))} onDelete={() => updateBranch(branchIndex, current => ({ ...current, steps: current.steps.filter((_, position) => position !== stepIndex) }))} onMove={direction => updateBranch(branchIndex, current => ({ ...current, steps: moveStep(current.steps, stepIndex, direction) }))} />)}
          </div>
        ))}
      </section>
        </div>
      </details>
    </div>
  )
}
