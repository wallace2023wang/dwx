import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { Asset, AssetDetail, AssetDraft, DecisionTableAnalysis, DecisionTableDraft, PackageNode, Project, RuleDraft } from '../types'
import { http } from './client'

const demoProjects: Project[] = [
  {
    id: 'miniloan', name: '个人贷款审批',
    description: '个人小额贷款准入、风险评估与承保决策',
    packageCount: 3, assetCount: 8, version: 'v2.1', environmentCount: 2,
    updatedAt: '2026-09-28 16:42', updatedBy: '陈分析师', branch: 'main', icon: 'loan', engine: 'rules', source: 'demo',
  },
  {
    id: 'grain-temperature', name: '粮库温控决策',
    description: '仓储温湿度监测、异常告警与通风策略',
    packageCount: 2, assetCount: 5, version: 'v1.4', environmentCount: 1,
    updatedAt: '2026-09-27 11:20', updatedBy: '王工程师', branch: 'main', icon: 'warehouse', engine: 'rules', source: 'demo',
  },
]

const demoProjectIds = new Set(demoProjects.map(project => project.id))

const packagesByProject: Record<string, PackageNode[]> = {
  miniloan: [
    {
      id: 'validation', name: 'validation', label: '校验',
      assets: [
        { id: 'v1', name: '申请人年满 18 岁', type: 'rule', modifiedBy: '陈分析师', status: 'published', version: '2.1' },
        { id: 'v2', name: '贷款金额必须为正', type: 'rule', modifiedBy: '陈分析师', status: 'published', version: '2.0' },
        { id: 'v3', name: '贷款期限合理', type: 'rule', modifiedBy: 'wallace', status: 'draft', version: '0.4' },
      ],
    },
    {
      id: 'eligibility', name: 'eligibility', label: '准入',
      assets: [
        { id: 'e1', name: '贷款金额不超过年收入 3 倍', type: 'rule', modifiedBy: '陈分析师', status: 'published', version: '2.3' },
        { id: 'e2', name: '信用分达到准入线', type: 'decision-table', modifiedBy: '陈分析师', status: 'published', version: '1.8' },
        { id: 'e3', name: '历史逾期次数上限', type: 'rule', modifiedBy: 'wallace', status: 'draft', version: '0.9' },
      ],
    },
    {
      id: 'underwriting', name: 'underwriting', label: '承保',
      assets: [
        { id: 'u1', name: '风险等级评估', type: 'decision-table', modifiedBy: '陈分析师', status: 'published', version: '3.0' },
        { id: 'u2', name: '最终审批结果', type: 'rule', modifiedBy: '陈分析师', status: 'published', version: '2.2' },
      ],
    },
  ],
  'grain-temperature': [
    {
      id: 'monitoring', name: 'monitoring', label: '监测',
      assets: [
        { id: 'g1', name: '整仓均温超限告警', type: 'rule', modifiedBy: '王工程师', status: 'published', version: '1.4' },
        { id: 'g2', name: '温差梯度风险评估', type: 'decision-table', modifiedBy: '王工程师', status: 'published', version: '1.2' },
        { id: 'g3', name: '传感器离线判定', type: 'rule', modifiedBy: 'wallace', status: 'draft', version: '0.3' },
      ],
    },
    {
      id: 'ventilation', name: 'ventilation', label: '通风',
      assets: [
        { id: 'g4', name: '低温通风启动条件', type: 'rule', modifiedBy: '王工程师', status: 'published', version: '1.0' },
        { id: 'g5', name: '通风窗口选择', type: 'decision-table', modifiedBy: '王工程师', status: 'draft', version: '0.8' },
      ],
    },
  ],
}

const tableDefinition: AssetDetail['decisionTable'] = {
  hitPolicy: 'COLLECT',
  columns: [
    { id: 'creditScore', label: '信用分', kind: 'condition' },
    { id: 'annualIncome', label: '年收入', kind: 'condition' },
    { id: 'overdueCount', label: '逾期次数', kind: 'condition' },
    { id: 'riskLevel', label: '风险等级', kind: 'action' },
    { id: 'limitFactor', label: '审批额度系数', kind: 'action' },
  ],
  rows: [
    { creditScore: '< 600', annualIncome: '任意', overdueCount: '任意', riskLevel: 'HIGH', limitFactor: '0' },
    { creditScore: '600..700', annualIncome: '< 100000', overdueCount: '0', riskLevel: 'MEDIUM', limitFactor: '0.5' },
    { creditScore: '600..700', annualIncome: '>= 100000', overdueCount: '0', riskLevel: 'LOW', limitFactor: '0.8' },
    { creditScore: '>= 700', annualIncome: '任意', overdueCount: '0', riskLevel: 'LOW', limitFactor: '1.0' },
    { creditScore: '任意', annualIncome: '任意', overdueCount: '>= 3', riskLevel: 'HIGH', limitFactor: '0' },
  ],
}

function packageForAsset(projectId: string, assetId: string): { entry: PackageNode; asset: Asset } | null {
  for (const entry of packagesByProject[projectId] ?? []) {
    const asset = entry.assets.find((candidate) => candidate.id === assetId)
    if (asset) return { entry, asset }
  }
  return null
}

function ruleContent(asset: Asset, packageName: string): string {
  const conditions: Record<string, string> = {
    v1: '    $request : LoanRequest( applicantAge < 18 )',
    v2: '    $request : LoanRequest( amount <= 0 )',
    v3: '    $request : LoanRequest( termMonths < 1 || termMonths > 60 )',
    e1: '    $request : LoanRequest( amount > annualIncome * 3 )',
    e3: '    $request : LoanRequest( overdueCount >= 3 )',
    u2: '    $request : LoanRequest( riskLevel == "LOW" )',
    g1: '    $grain : GrainStore( averageTemperature > 25 )',
    g3: '    $sensor : TemperatureSensor( online == false )',
    g4: '    $grain : GrainStore( outsideTemperature < insideTemperature - 8 )',
  }
  const actions: Record<string, string> = {
    v1: '    modify($request) { setApproved(false), setReason("申请人未成年") };',
    v2: '    modify($request) { setApproved(false), setReason("贷款金额必须为正") };',
    v3: '    modify($request) { setApproved(false), setReason("贷款期限不合理") };',
    e1: '    modify($request) { setApproved(false), setReason("贷款金额超出收入上限") };',
    e3: '    modify($request) { setRiskLevel("HIGH"), setApproved(false) };',
    u2: '    modify($request) { setApproved(true), setReason("自动审批通过") };',
    g1: '    modify($grain) { setAlertLevel("HIGH"), setVentilationRequired(true) };',
    g3: '    modify($sensor) { setAlertLevel("WARNING") };',
    g4: '    modify($grain) { setVentilationRequired(true) };',
  }
  return `package decisions.${packageName}\n\nrule "${asset.name}"\n    salience 0\nwhen\n${conditions[asset.id] ?? '    $request : LoanRequest()'}\nthen\n${actions[asset.id] ?? '    // no action'}\nend`
}

function mockRuleDraft(projectId: string, asset: Asset, category: string): RuleDraft {
  const definitions: Record<string, Pick<RuleDraft, 'conditions' | 'actions' | 'description'>> = {
    v1: {
      conditions: [{ field: 'age', operator: '<', value: '18' }],
      actions: [{ field: 'approved', value: 'false' }, { field: 'reasons', value: '申请人未成年' }],
      description: '未满 18 周岁的申请人不能进入自动审批。',
    },
    v2: {
      conditions: [{ field: 'amount', operator: '<=', value: '0' }],
      actions: [{ field: 'approved', value: 'false' }, { field: 'reasons', value: '贷款金额必须为正' }],
      description: '申请金额必须大于零。',
    },
    v3: {
      conditions: [{ field: 'durationMonths', operator: '<', value: '1' }],
      actions: [{ field: 'approved', value: 'false' }, { field: 'reasons', value: '贷款期限不合理' }],
      description: '贷款期限必须处于产品允许范围。',
    },
    e1: {
      conditions: [{ field: 'amount', operator: '>', value: '180000' }],
      actions: [{ field: 'approved', value: 'false' }, { field: 'reasons', value: '贷款金额超出收入上限' }],
      description: '贷款申请金额超过收入承受能力时拒绝。',
    },
    e3: {
      conditions: [{ field: 'delinquencies', operator: '>=', value: '3' }],
      actions: [{ field: 'riskLevel', value: '高' }, { field: 'approved', value: 'false' }],
      description: '历史逾期次数达到上限时标记为高风险。',
    },
    u2: {
      conditions: [{ field: 'creditScore', operator: '>=', value: '700' }],
      actions: [{ field: 'approved', value: 'true' }, { field: 'reasons', value: '自动审批通过' }],
      description: '低风险客户通过自动审批。',
    },
    g1: {
      conditions: [{ field: 'averageTemperature', operator: '>', value: '25' }],
      actions: [{ field: 'alertLevel', value: '高' }, { field: 'ventilationRequired', value: 'true' }],
      description: '整仓均温超过阈值时告警并启动通风。',
    },
    g3: {
      conditions: [{ field: 'humidity', operator: '>', value: '80' }],
      actions: [{ field: 'alertLevel', value: '警告' }],
      description: '监测数据异常时产生设备检查告警。',
    },
    g4: {
      conditions: [{ field: 'outsideTemperature', operator: '<', value: '10' }],
      actions: [{ field: 'ventilationRequired', value: 'true' }, { field: 'reason', value: '满足低温通风条件' }],
      description: '仓外温度满足条件时启动低温通风。',
    },
  }
  const fallback = projectId === 'grain-temperature'
    ? { conditions: [{ field: 'averageTemperature', operator: '>', value: '25' }], actions: [{ field: 'alertLevel', value: '警告' }], description: '' }
    : { conditions: [{ field: 'age', operator: '>=', value: '18' }], actions: [{ field: 'approved', value: 'true' }], description: '' }
  return {
    name: asset.name,
    category,
    priority: 0,
    ...(definitions[asset.id] ?? fallback),
  }
}

function detailFor(projectId: string, assetId: string): AssetDetail | null {
  const found = packageForAsset(projectId, assetId)
  if (!found) return null
  const { entry, asset } = found
  return {
    ...asset,
    packageId: entry.id,
    packageName: `${entry.name} ${entry.label}`,
    updatedAt: '2026-09-28',
    attributes: {
      priority: 0,
      hitPolicy: asset.type === 'decision-table' ? 'COLLECT' : 'FIRST',
      effectiveDate: '始终',
      createdBy: asset.modifiedBy,
      reviewedAt: asset.status === 'published' ? '2026-09-20' : '尚未审核',
    },
    ...(asset.type === 'decision-table'
      ? { decisionTable: tableDefinition }
      : { content: ruleContent(asset, entry.name), draft: mockRuleDraft(projectId, asset, entry.name) }),
  }
}

async function mockResult<T>(value: T): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 120))
  return value
}

function normalizeServerProject(project: Project): Project {
  const parsed = new Date(project.updatedAt)
  return {
    ...project,
    engine: project.engine || 'rules',
    updatedAt: Number.isNaN(parsed.valueOf()) ? project.updatedAt : parsed.toLocaleString('zh-CN', { hour12: false }),
    source: 'server',
  }
}

export async function loadProjects(includeArchived = false): Promise<Project[]> {
  try {
    const { data } = await http.get<Project[]>('/projects', { params: includeArchived ? { archived: 'true' } : undefined })
    return [...data.map(normalizeServerProject), ...demoProjects]
  } catch {
    return demoProjects
  }
}

async function loadProject(projectId: string): Promise<Project | null> {
  const demo = demoProjects.find((project) => project.id === projectId)
  if (demo) return mockResult(demo)
  if (demoProjectIds.has(projectId)) return null
  try {
    const { data } = await http.get<Project>(`/projects/${encodeURIComponent(projectId)}`)
    return normalizeServerProject(data)
  } catch {
    return null
  }
}

export async function loadPackages(projectId: string): Promise<PackageNode[]> {
  if (demoProjectIds.has(projectId)) return mockResult(packagesByProject[projectId] ?? [])
  const { data } = await http.get<PackageNode[]>(`/projects/${encodeURIComponent(projectId)}/packages`)
  return data
}

async function loadAssetDetail(projectId: string, assetId: string): Promise<AssetDetail | null> {
  if (demoProjectIds.has(projectId)) return mockResult(detailFor(projectId, assetId))
  const { data } = await http.get<AssetDetail>(`/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}`)
  return data
}

function requestError(error: unknown): Error {
  if (axios.isAxiosError<{ error?: string }>(error)) {
    return new Error(error.response?.data?.error || error.message)
  }
  return error instanceof Error ? error : new Error('操作失败')
}

async function saveAsset(projectId: string, assetId: string, revision: number, draft: AssetDraft): Promise<AssetDetail> {
  try {
    const { data } = await http.put<AssetDetail>(
      `/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}`,
      { revision, draft },
    )
    return data
  } catch (error) {
    throw requestError(error)
  }
}

async function compileAsset(projectId: string, assetId: string, revision: number, draft: AssetDraft): Promise<{ engineVersion: string; drl: string }> {
  try {
    const { data } = await http.post<{ engineVersion: string; drl: string }>(
      `/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}/compile`,
      { revision, draft },
    )
    return data
  } catch (error) {
    throw requestError(error)
  }
}

async function submitAsset(projectId: string, assetId: string, revision: number): Promise<AssetDetail> {
  try {
    const { data } = await http.post<AssetDetail>(
      `/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}/submit`,
      { revision },
    )
    return data
  } catch (error) {
    throw requestError(error)
  }
}

async function createAsset(projectId: string, payload: { type: 'rule' | 'decision-table'; name?: string; category?: string; conditionFields?: string[]; actionFields?: string[]; hitPolicy?: string }): Promise<AssetDetail> {
  try {
    const { data } = await http.post<AssetDetail>(`/projects/${encodeURIComponent(projectId)}/rules`, payload)
    return data
  } catch (error) {
    throw requestError(error)
  }
}

async function analyzeDecisionTable(projectId: string, assetId: string, revision: number, draft: DecisionTableDraft): Promise<DecisionTableAnalysis> {
  try {
    const { data } = await http.post<DecisionTableAnalysis>(
      `/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}/analyze`,
      { revision, draft },
    )
    return data
  } catch (error) {
    throw requestError(error)
  }
}

export function useProjects(includeArchived = false) {
  return useQuery({ queryKey: ['projects', { includeArchived }], queryFn: () => loadProjects(includeArchived) })
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId],
    queryFn: () => loadProject(projectId ?? ''),
    enabled: Boolean(projectId),
  })
}

export function usePackages(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'packages'],
    queryFn: () => loadPackages(projectId ?? ''),
    enabled: Boolean(projectId),
  })
}

export function useAssetDetail(projectId: string | undefined, assetId: string | null) {
  return useQuery({
    queryKey: ['projects', projectId, 'assets', assetId],
    queryFn: () => projectId && assetId ? loadAssetDetail(projectId, assetId) : null,
    enabled: Boolean(projectId && assetId),
  })
}

export function useCreateAsset(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: { type: 'rule' | 'decision-table'; name?: string; category?: string; conditionFields?: string[]; actionFields?: string[]; hitPolicy?: string }) => {
      if (!projectId) throw new Error('项目不存在')
      if (demoProjectIds.has(projectId)) throw new Error('演示项目不能创建资产')
      return createAsset(projectId, payload)
    },
    onSuccess: async detail => {
      queryClient.setQueryData(['projects', projectId, 'assets', detail.id], detail)
      await queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] })
    },
  })
}

export function useRenameAsset(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ assetId, newName }: { assetId: string; newName: string }) => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能修改')
      const detail = await loadAssetDetail(projectId, assetId)
      if (!detail?.revision) throw new Error('资产不存在或修订号缺失')
      try {
        return (await http.post<AssetDetail>(
          `/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}/rename`,
          { revision: detail.revision, newName: newName.trim() },
        )).data
      } catch (error) { throw requestError(error) }
    },
    onSuccess: async detail => {
      queryClient.setQueryData(['projects', projectId, 'assets', detail.id], detail)
      await queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] })
    },
  })
}

export interface CreateProjectInput {
  name: string
  description: string
  icon: Project['icon']
  engine?: Project['engine']
  bomTemplate: 'blank' | 'loan' | 'risk' | 'grain' | 'copy'
  copyProjectId?: string
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreateProjectInput) => {
      try { return (await http.post<Project>('/projects', payload)).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useUpdateProject(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: Pick<Project, 'name' | 'description' | 'icon'> & { defaultEnvironment?: string }) => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能修改')
      try { return (await http.put<Project>(`/projects/${encodeURIComponent(projectId)}`, payload)).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: project => {
      queryClient.setQueryData(['projects', projectId], normalizeServerProject(project))
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useArchiveProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (projectId: string) => {
      try { return (await http.post<Project>(`/projects/${encodeURIComponent(projectId)}/archive`)).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (projectId: string) => {
      try { await http.delete(`/projects/${encodeURIComponent(projectId)}`) }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useCreatePackage(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: { name: string; label: string; parentId: string | null }) => {
      if (!projectId || demoProjectIds.has(projectId)) throw new Error('演示项目不能修改')
      try { return (await http.post<PackageNode>(`/projects/${encodeURIComponent(projectId)}/packages`, payload)).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
  })
}

export function useUpdatePackage(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ currentName, ...payload }: { currentName: string; name: string; label: string; parentId: string | null }) => {
      if (!projectId) throw new Error('项目不存在')
      try { return (await http.put<PackageNode>(`/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(currentName)}`, payload)).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
  })
}

export function useDeletePackage(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, moveRulesTo, deleteAssets }: { name: string; moveRulesTo?: string; deleteAssets?: boolean }) => {
      if (!projectId) throw new Error('项目不存在')
      try { await http.delete(`/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(name)}`, { data: { moveRulesTo, deleteAssets } }) }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
  })
}

function assetAction(projectId: string, assetId: string, action: string, payload?: unknown) {
  return http.post<AssetDetail>(`/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}/${action}`, payload).then(response => response.data).catch(error => { throw requestError(error) })
}

export function useDuplicateAsset(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ assetId, newName }: { assetId: string; newName: string }) => {
      if (!projectId) throw new Error('项目不存在')
      return assetAction(projectId, assetId, 'duplicate', { newName })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
  })
}

export function useMoveAsset(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ assetId, targetPackage }: { assetId: string; targetPackage: string }) => {
      if (!projectId) throw new Error('项目不存在')
      return assetAction(projectId, assetId, 'move', { targetPackage })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
  })
}

export function useDeleteAsset(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (assetId: string) => {
      if (!projectId) throw new Error('项目不存在')
      try { return (await http.delete<AssetDetail>(`/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(assetId)}`)).data }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
  })
}

export function useAnalyzeDecisionTable(projectId: string | undefined, assetId: string | null) {
  return useMutation({
    mutationFn: ({ revision, draft }: { revision: number; draft: DecisionTableDraft }) => {
      if (!projectId || !assetId) throw new Error('决策表不存在')
      return analyzeDecisionTable(projectId, assetId, revision, draft)
    },
  })
}

function useAssetResult(projectId: string | undefined, assetId: string | null) {
  const queryClient = useQueryClient()
  return async (detail: AssetDetail) => {
    queryClient.setQueryData(['projects', projectId, 'assets', assetId], detail)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] }),
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'bom'] }),
    ])
  }
}

export function useSaveAsset(projectId: string | undefined, assetId: string | null) {
  const applyResult = useAssetResult(projectId, assetId)
  return useMutation({
    mutationFn: ({ revision, draft }: { revision: number; draft: AssetDraft }) => {
      if (!projectId || !assetId) throw new Error('资产不存在')
      return saveAsset(projectId, assetId, revision, draft)
    },
    onSuccess: applyResult,
  })
}

export function useCompileAsset(projectId: string | undefined, assetId: string | null) {
  return useMutation({
    mutationFn: ({ revision, draft }: { revision: number; draft: AssetDraft }) => {
      if (!projectId || !assetId) throw new Error('资产不存在')
      return compileAsset(projectId, assetId, revision, draft)
    },
  })
}

export function useSubmitAsset(projectId: string | undefined, assetId: string | null) {
  const applyResult = useAssetResult(projectId, assetId)
  return useMutation({
    mutationFn: (revision: number) => {
      if (!projectId || !assetId) throw new Error('资产不存在')
      return submitAsset(projectId, assetId, revision)
    },
    onSuccess: applyResult,
  })
}
