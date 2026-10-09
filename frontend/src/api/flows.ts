import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FlowDefinition, FlowDetail, FlowDraft, FlowNodeKind, Ruleset } from '../types'
import { http } from './client'
import { requestError } from './errors'

export async function loadRulesets(projectId: string): Promise<Ruleset[]> {
  const { data } = await http.get<Ruleset[]>(`/projects/${encodeURIComponent(projectId)}/flows`)
  return data
}

export function useRulesets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'rulesets'],
    queryFn: async () => {
      return loadRulesets(projectId ?? '')
    },
    enabled: Boolean(projectId),
  })
}

export function useRuleFlow(projectId: string | undefined, rulesetId: string | undefined) {
  return useQuery<FlowDefinition | FlowDetail | null>({
    queryKey: ['projects', projectId, 'rulesets', rulesetId, 'flow'],
    queryFn: async () => {
      const { data } = await http.get<FlowDetail>(`/projects/${encodeURIComponent(projectId ?? '')}/flows/${encodeURIComponent(rulesetId ?? '')}`)
      return data
    },
    enabled: Boolean(projectId && rulesetId),
  })
}

export function useCreateFlow(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('项目不存在')
      try {
        const { data } = await http.post<FlowDetail>(`/projects/${encodeURIComponent(projectId)}/flows`)
        return data
      } catch (error) { throw requestError(error, '规则集操作失败') }
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'rulesets'] }),
  })
}

export function useSaveFlow(projectId: string | undefined, flowId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ revision, draft }: { revision: number; draft: FlowDraft }) => {
      if (!projectId || !flowId) throw new Error('规则集不存在')
      try {
        const { data } = await http.put<FlowDetail>(
          `/projects/${encodeURIComponent(projectId)}/flows/${encodeURIComponent(flowId)}`,
          { revision, draft },
        )
        return data
      } catch (error) { throw requestError(error) }
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(['projects', projectId, 'rulesets', flowId, 'flow'], detail)
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'rulesets'] })
    },
  })
}

export function useTransferFlowOwner(projectId: string | undefined, flowId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ revision, ownerId, ownerName }: { revision: number; ownerId: string; ownerName?: string }) => {
      if (!projectId || !flowId) throw new Error('规则集不存在')
      try {
        return (await http.post<FlowDetail>(`/projects/${encodeURIComponent(projectId)}/flows/${encodeURIComponent(flowId)}/transfer-owner`, { revision, ownerId, ownerName })).data
      } catch (error) { throw requestError(error) }
    },
    onSuccess: detail => {
      queryClient.setQueryData(['projects', projectId, 'rulesets', flowId, 'flow'], detail)
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'rulesets'] })
    },
  })
}

export function useCompileFlow(projectId: string | undefined, flowId: string | undefined) {
  return useMutation({
    mutationFn: async ({ revision, draft }: { revision: number; draft: FlowDraft }) => {
      if (!projectId || !flowId) throw new Error('规则集不存在')
      try {
        const { data } = await http.post<{ engineVersion: string; stepCount: number; branchCount: number; bomVersion: number }>(
          `/projects/${encodeURIComponent(projectId)}/flows/${encodeURIComponent(flowId)}/compile`,
          { revision, draft },
        )
        return data
      } catch (error) { throw requestError(error) }
    },
  })
}

export function usePublishFlow(projectId: string | undefined, flowId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (revision: number) => {
      if (!projectId || !flowId) throw new Error('规则集不存在')
      try {
        const { data } = await http.post<FlowDetail>(
          `/projects/${encodeURIComponent(projectId)}/flows/${encodeURIComponent(flowId)}/publish`,
          { revision },
        )
        return data
      } catch (error) { throw requestError(error) }
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(['projects', projectId, 'rulesets', flowId, 'flow'], detail)
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'rulesets'] })
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'releases'] })
    },
  })
}

export function flowDefinitionFromDetail(detail: FlowDetail, draft: FlowDraft = detail.draft): FlowDefinition {
  const assets = new Map(detail.availableAssets.map(asset => [asset.id, asset]))
  const packages = new Map((detail.availablePackages ?? []).map(entry => [entry.name, entry]))
  const subflows = new Map((detail.availableFlows ?? []).map(entry => [entry.id, entry]))
  const nodes: FlowDefinition['nodes'] = []
  const connections: FlowDefinition['connections'] = []
  const gateways = draft.gateways?.length ? draft.gateways : (draft.branches?.length ? [{ id: 'gateway', name: '排他网关', afterStep: draft.steps.length, branches: draft.branches }] : draft.gateways ?? [])
  const savedPositions = draft.editor?.positions ?? {}
  const maxBranches = Math.max(...gateways.map(gateway => gateway.branches.length), 1)
  const centerY = gateways.length ? Math.max(185, 70 + (maxBranches - 1) * 65) : 185
  const stepGap = 235
  let x = 25
  const position = (id: string, fallback: { x: number; y: number }) => savedPositions[id] ?? fallback
  const stepNode = (step: FlowDraft['steps'][number], id: string, fallback: { x: number; y: number }, detailText?: string) => {
    const asset = step.id ? assets.get(step.id) : undefined
    const pkg = step.selector ? packages.get(step.selector.packageName) : undefined
    const subflow = step.type === 'subflow' && step.id ? subflows.get(step.id) : undefined
    const kind: FlowNodeKind = step.type === 'subflow' ? 'subflow' : step.type === 'rule-group' ? 'ruleGroup' : step.type === 'table' ? 'tableTask' : 'ruleTask'
    const label = step.type === 'subflow' ? (subflow?.name || '未选择子流程') : step.type === 'rule-group' ? (pkg?.label || step.selector?.packageName || '未选择规则包') : (asset?.name || '未选择资产')
    const stepDetail = step.type === 'subflow' ? (subflow ? `子流程 · v${subflow.version}` : '子流程引用不可用') : step.type === 'rule-group' ? `${pkg?.publishedRuleCount ?? 0} 条规则 · ${pkg?.publishedTableCount ?? 0} 张决策表` : asset ? `${asset.type === 'table' ? '决策表' : '规则'} · v${asset.version}` : '引用不可用'
    return { id, kind, position: position(id, fallback), label, detail: detailText || stepDetail, active: step.type === 'subflow' ? Boolean(subflow) : step.type === 'rule-group' ? Boolean(pkg) : Boolean(asset), stepType: step.type }
  }
  if (draft.graph?.nodes.length) {
    const graphNodes = new Map(draft.graph.nodes.map(node => [node.id, node]))
    const depth = new Map<string, number>([[draft.graph.entry, 0]])
    const queue = [draft.graph.entry]
    for (let cursor = 0; cursor < queue.length && cursor < draft.graph.nodes.length * 4; cursor += 1) {
      const id = queue[cursor]
      const node = graphNodes.get(id)
      if (!node) continue
      const targets = node.type === 'step' || node.type === 'join' ? [node.next] : node.branches.map(branch => branch.next)
      for (const target of targets) {
        if (target === 'end') continue
        const nextDepth = (depth.get(id) ?? 0) + 1
        if (!depth.has(target)) {
          depth.set(target, nextDepth)
          queue.push(target)
        }
      }
    }
    const columns = new Map<number, string[]>()
    for (const node of draft.graph.nodes) {
      const column = depth.get(node.id) ?? 0
      columns.set(column, [...(columns.get(column) ?? []), node.id])
    }
    const maxDepth = Math.max(...depth.values(), 0)
    const graphCenterY = Math.max(185, Math.max(...[...columns.values()].map(column => column.length), 1) * 80)
    nodes.push({ id: 'start', kind: 'start', position: position('start', { x: 25, y: graphCenterY }), label: '开始', detail: 'RuleInput' })
    for (const node of draft.graph.nodes) {
      const column = depth.get(node.id) ?? 0
      const entries = columns.get(column) ?? [node.id]
      const row = entries.indexOf(node.id)
      const fallback = { x: 25 + stepGap * (column + 1), y: graphCenterY + (row - (entries.length - 1) / 2) * 150 }
      if (node.type === 'step') nodes.push({ ...stepNode(node.step, node.id, fallback), gatewayId: null, branchId: null })
      else nodes.push({ id: node.id, kind: node.type, position: position(node.id, fallback), label: node.name || (node.type === 'parallel' ? '并行网关' : node.type === 'join' ? '聚合节点' : '排他网关'), gatewayId: node.id })
    }
    nodes.push({ id: 'end', kind: 'end', position: position('end', { x: 25 + stepGap * (maxDepth + 2), y: graphCenterY }), label: '结束', detail: 'RuleInput' })
    connections.push({ id: `start-${draft.graph.entry}`, source: 'start', target: draft.graph.entry })
    for (const node of draft.graph.nodes) {
      if (node.type === 'step' || node.type === 'join') connections.push({ id: `${node.id}-${node.next}`, source: node.id, target: node.next })
      else node.branches.forEach((branch, branchIndex) => connections.push({
        id: `${node.id}-${branch.id}-${branch.next}`,
        source: node.id,
        sourceHandle: branchIndex === 0 ? 'no' : 'yes',
        target: branch.next,
        targetHandle: branch.next === 'end' && branchIndex === 0 ? 'top' : undefined,
        label: node.type === 'gateway' && 'default' in branch && branch.default ? `${branch.name}（默认）` : branch.name,
        labelTone: node.type === 'gateway' ? ('default' in branch && branch.default ? undefined : branchIndex === 0 ? 'negative' : 'positive') : undefined,
      }))
    }
    return { id: detail.id, name: draft.name, nodes, connections }
  }
  nodes.push({ id: 'start', kind: 'start', position: position('start', { x, y: centerY }), label: '开始', detail: 'RuleInput' })
  let previous = 'start'
  for (let boundary = 0; boundary <= draft.steps.length; boundary += 1) {
    const gateway = gateways.find(candidate => candidate.afterStep === boundary)
    if (gateway) {
      x += stepGap
      nodes.push({ id: gateway.id, kind: 'gateway', position: position(gateway.id, { x, y: centerY }), label: gateway.name || '排他网关', gatewayId: gateway.id })
      connections.push({ id: `${previous}-${gateway.id}`, source: previous, target: gateway.id })
      const maxSteps = Math.max(...gateway.branches.map(branch => branch.steps.length), 1)
      const mergeId = boundary < draft.steps.length ? (draft.steps[boundary].nodeId || `common:${boundary}`) : 'end'
      gateway.branches.forEach((branch, branchIndex) => {
        const rowY = 35 + branchIndex * 130
        let branchPrevious = gateway.id
        branch.steps.forEach((step, stepIndex) => {
          const id = step.nodeId || `branch:${branch.id}:${stepIndex}`
          nodes.push({ ...stepNode(step, id, { x: x + stepGap * (stepIndex + 1), y: rowY }, `${branch.name} · 分支步骤`), gatewayId: gateway.id, branchId: branch.id })
          connections.push({
            id: `${branchPrevious}-${id}-${branch.id}`,
            source: branchPrevious,
            sourceHandle: branchPrevious === gateway.id ? (branchIndex === 0 ? 'no' : 'yes') : undefined,
            target: id,
            label: branchPrevious === gateway.id ? (branch.default ? `${branch.name}（默认）` : branch.name) : undefined,
            labelTone: branch.default ? undefined : branchIndex === 0 ? 'negative' : 'positive',
          })
          branchPrevious = id
        })
        connections.push({ id: `${branchPrevious}-${mergeId}-${branch.id}`, source: branchPrevious, target: mergeId, targetHandle: branchIndex === 0 ? 'top' : undefined })
      })
      x += stepGap * maxSteps
      previous = gateway.id
    }
    if (boundary >= draft.steps.length) continue
    const step = draft.steps[boundary]
    x += stepGap
    const id = step.nodeId || `common:${boundary}`
    if (!nodes.some(node => node.id === id)) {
      const node = stepNode(step, id, { x, y: centerY + 6 })
      nodes.push({ ...node, label: `${boundary + 1}. ${node.label}`, gatewayId: null, branchId: null })
    }
    if (!gateway) connections.push({ id: `${previous}-${id}`, source: previous, target: id })
    previous = id
  }
  x += stepGap
  if (!nodes.some(node => node.id === 'end')) nodes.push({ id: 'end', kind: 'end', position: position('end', { x, y: centerY }), label: '结束', detail: 'RuleInput' })
  if (!gateways.some(gateway => gateway.afterStep === draft.steps.length)) connections.push({ id: `${previous}-end`, source: previous, target: 'end' })
  return { id: detail.id, name: draft.name, nodes, connections }
}
