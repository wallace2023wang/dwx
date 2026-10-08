import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { FlowDefinition, FlowDetail, FlowDraft, Ruleset } from '../types'
import { http } from './client'

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

function requestError(error: unknown): Error {
  if (axios.isAxiosError<{ error?: string }>(error)) return new Error(error.response?.data?.error || error.message)
  return error instanceof Error ? error : new Error('规则集操作失败')
}

export function useCreateFlow(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('项目不存在')
      try {
        const { data } = await http.post<FlowDetail>(`/projects/${encodeURIComponent(projectId)}/flows`)
        return data
      } catch (error) { throw requestError(error) }
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
  const nodes: FlowDefinition['nodes'] = []
  const connections: FlowDefinition['connections'] = []
  const branches = draft.branches ?? []
  const savedPositions = draft.editor?.positions ?? {}
  const centerY = branches.length ? Math.max(185, 70 + (branches.length - 1) * 65) : 185
  const stepGap = 235
  let x = 25
  const position = (id: string, fallback: { x: number; y: number }) => savedPositions[id] ?? fallback
  nodes.push({ id: 'start', kind: 'start', position: position('start', { x, y: centerY }), label: '开始', detail: 'RuleInput' })
  let previous = 'start'
  draft.steps.forEach((step, index) => {
    x += stepGap
    const asset = step.id ? assets.get(step.id) : undefined
    const pkg = step.selector ? packages.get(step.selector.packageName) : undefined
    const id = step.nodeId || `common:${index}`
    const kind = step.type === 'rule-group' ? 'ruleGroup' : step.type === 'table' ? 'tableTask' : 'ruleTask'
    const label = step.type === 'rule-group' ? (pkg?.label || step.selector?.packageName || '未选择规则包') : (asset?.name || '未选择资产')
    const detailText = step.type === 'rule-group'
      ? `${pkg?.publishedRuleCount ?? 0} 条规则 · ${pkg?.publishedTableCount ?? 0} 张决策表${step.selector?.includeChildren ? ' · 含子包' : ''}`
      : asset ? `${asset.type === 'table' ? '决策表' : '规则'} · v${asset.version}` : '引用不可用'
    nodes.push({ id, kind, position: position(id, { x, y: centerY + 6 }), label: `${index + 1}. ${label}`, detail: detailText, active: step.type === 'rule-group' ? Boolean(pkg) : Boolean(asset), branchId: null, stepType: step.type })
    connections.push({ id: `${previous}-${id}`, source: previous, target: id })
    previous = id
  })

  if (branches.length) {
    x += stepGap
    nodes.push({ id: 'gateway', kind: 'gateway', position: position('gateway', { x, y: centerY }), label: '排他网关' })
    connections.push({ id: `${previous}-gateway`, source: previous, target: 'gateway' })
    const maxSteps = Math.max(...branches.map(branch => branch.steps.length), 1)
    branches.forEach((branch, branchIndex) => {
      const rowY = 35 + branchIndex * 130
      let branchPrevious = 'gateway'
      branch.steps.forEach((step, stepIndex) => {
        const asset = step.id ? assets.get(step.id) : undefined
        const pkg = step.selector ? packages.get(step.selector.packageName) : undefined
        const id = step.nodeId || `branch:${branch.id}:${stepIndex}`
        const kind = step.type === 'rule-group' ? 'ruleGroup' : step.type === 'table' ? 'tableTask' : 'ruleTask'
        const label = step.type === 'rule-group' ? (pkg?.label || step.selector?.packageName || '未选择规则包') : (asset?.name || '未选择资产')
        const detailText = step.type === 'rule-group'
          ? `${branch.name} · ${(pkg?.publishedRuleCount ?? 0) + (pkg?.publishedTableCount ?? 0)} 个已发布资产`
          : asset ? `${branch.name} · ${asset.type === 'table' ? '决策表' : '规则'}` : branch.name
        nodes.push({ id, kind, position: position(id, { x: x + stepGap * (stepIndex + 1), y: rowY }), label, detail: detailText, active: step.type === 'rule-group' ? Boolean(pkg) : Boolean(asset), branchId: branch.id, stepType: step.type })
        connections.push({
          id: `${branchPrevious}-${id}-${branch.id}`,
          source: branchPrevious,
          sourceHandle: branchPrevious === 'gateway' ? (branchIndex === 0 ? 'no' : 'yes') : undefined,
          target: id,
          label: branchPrevious === 'gateway' ? (branch.default ? `${branch.name}（默认）` : branch.name) : undefined,
          labelTone: branch.default ? undefined : branchIndex === 0 ? 'negative' : 'positive',
        })
        branchPrevious = id
      })
      connections.push({ id: `${branchPrevious}-end-${branch.id}`, source: branchPrevious, target: 'end', targetHandle: branchIndex === 0 ? 'top' : undefined })
    })
    nodes.push({ id: 'end', kind: 'end', position: position('end', { x: x + stepGap * (maxSteps + 1), y: centerY }), label: '结束', detail: 'RuleInput' })
  } else {
    x += stepGap
    nodes.push({ id: 'end', kind: 'end', position: position('end', { x, y: centerY }), label: '结束', detail: 'RuleInput' })
    connections.push({ id: `${previous}-end`, source: previous, target: 'end' })
  }
  return { id: detail.id, name: draft.name, nodes, connections }
}
