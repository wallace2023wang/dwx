import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { FlowDefinition, FlowDetail, FlowDraft, Ruleset } from '../types'
import { http } from './client'

const rulesetsByProject: Record<string, Ruleset[]> = {
  miniloan: [
    {
      id: 'miniloan-decision',
      name: '个人贷款决策服务',
      flowId: 'loan-approval',
      flowName: '贷款审批主流程',
      hitPolicy: 'COLLECT',
      maxFirings: 100,
      inputs: ['Borrower', 'Loan'],
      outputs: ['LoanDecision'],
      packages: ['validation', 'eligibility', 'underwriting'],
      sequential: true,
    },
  ],
  'grain-temperature': [
    {
      id: 'grain-control',
      name: 'grain-control',
      flowId: 'temperature-control',
      flowName: '粮温调控主流程',
      hitPolicy: 'PRIORITY',
      maxFirings: 50,
      inputs: ['GrainStore'],
      outputs: ['ControlDecision'],
      packages: ['monitoring', 'ventilation'],
      sequential: true,
    },
  ],
}

const demoProjectIds = new Set(['miniloan', 'grain-temperature'])

const flowsByProject: Record<string, Record<string, FlowDefinition>> = {
  miniloan: {
    'miniloan-decision': {
      id: 'loan-approval',
      name: '贷款审批主流程',
      nodes: [
        { id: 'start', kind: 'start', position: { x: 20, y: 185 }, label: '开始', detail: 'Borrower + Loan' },
        { id: 'validation-gateway', kind: 'gateway', position: { x: 165, y: 180 }, label: '通过校验?' },
        { id: 'validation', kind: 'ruleTask', position: { x: 360, y: 36 }, label: 'Task 1: validation', detail: '校验包 · 3 条规则' },
        { id: 'rejection', kind: 'ruleTask', position: { x: 650, y: 36 }, label: 'Task 4: 拒绝理由', detail: '直接返回拒绝', active: false },
        { id: 'eligibility', kind: 'ruleTask', position: { x: 390, y: 190 }, label: 'Task 2: eligibility', detail: '准入包 · 3 条规则' },
        { id: 'underwriting', kind: 'ruleTask', position: { x: 690, y: 190 }, label: 'Task 3: underwriting', detail: '承保包 · 2 条规则' },
        { id: 'end', kind: 'end', position: { x: 980, y: 185 }, label: '结束', detail: 'LoanDecision' },
      ],
      connections: [
        { id: 'start-gateway', source: 'start', target: 'validation-gateway' },
        { id: 'gateway-validation', source: 'validation-gateway', sourceHandle: 'no', target: 'validation', label: '否', labelTone: 'negative' },
        { id: 'validation-rejection', source: 'validation', target: 'rejection' },
        { id: 'rejection-end', source: 'rejection', target: 'end', targetHandle: 'top' },
        { id: 'gateway-eligibility', source: 'validation-gateway', sourceHandle: 'yes', target: 'eligibility', label: '是', labelTone: 'positive' },
        { id: 'eligibility-underwriting', source: 'eligibility', target: 'underwriting' },
        { id: 'underwriting-end', source: 'underwriting', target: 'end' },
      ],
    },
  },
  'grain-temperature': {
    'grain-control': {
      id: 'temperature-control',
      name: '粮温调控主流程',
      nodes: [
        { id: 'start', kind: 'start', position: { x: 30, y: 185 }, label: '开始', detail: 'GrainStore' },
        { id: 'risk-gateway', kind: 'gateway', position: { x: 190, y: 180 }, label: '温度异常?' },
        { id: 'monitoring', kind: 'ruleTask', position: { x: 410, y: 70 }, label: 'Task 1: monitoring', detail: '监测包 · 3 条规则' },
        { id: 'ventilation', kind: 'ruleTask', position: { x: 690, y: 70 }, label: 'Task 2: ventilation', detail: '通风包 · 2 条规则' },
        { id: 'normal', kind: 'ruleTask', position: { x: 470, y: 240 }, label: 'Task 3: 正常记录', detail: '无需执行调控', active: false },
        { id: 'end', kind: 'end', position: { x: 980, y: 185 }, label: '结束', detail: 'ControlDecision' },
      ],
      connections: [
        { id: 'start-gateway', source: 'start', target: 'risk-gateway' },
        { id: 'gateway-monitoring', source: 'risk-gateway', sourceHandle: 'no', target: 'monitoring', label: '是', labelTone: 'negative' },
        { id: 'monitoring-ventilation', source: 'monitoring', target: 'ventilation' },
        { id: 'ventilation-end', source: 'ventilation', target: 'end', targetHandle: 'top' },
        { id: 'gateway-normal', source: 'risk-gateway', sourceHandle: 'yes', target: 'normal', label: '否', labelTone: 'positive' },
        { id: 'normal-end', source: 'normal', target: 'end' },
      ],
    },
  },
}

async function mockResult<T>(value: T): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 140))
  return value
}

export async function loadRulesets(projectId: string): Promise<Ruleset[]> {
  if (demoProjectIds.has(projectId)) return mockResult(rulesetsByProject[projectId] ?? [])
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
      if (projectId && demoProjectIds.has(projectId)) return mockResult(flowsByProject[projectId]?.[rulesetId ?? ''] ?? null)
      const { data } = await http.get<FlowDetail>(`/projects/${encodeURIComponent(projectId ?? '')}/flows/${encodeURIComponent(rulesetId ?? '')}`)
      return data
    },
    enabled: Boolean(projectId && rulesetId),
  })
}

function requestError(error: unknown): Error {
  if (axios.isAxiosError<{ error?: string }>(error)) return new Error(error.response?.data?.error || error.message)
  return error instanceof Error ? error : new Error('规则流操作失败')
}

export function useCreateFlow(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('项目不存在')
      if (demoProjectIds.has(projectId)) throw new Error('演示项目不支持创建规则流')
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
      if (!projectId || !flowId) throw new Error('规则流不存在')
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
      if (!projectId || !flowId) throw new Error('规则流不存在')
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
      if (!projectId || !flowId) throw new Error('规则流不存在')
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
