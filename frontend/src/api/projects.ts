import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { AssetDetail, AssetDraft, DecisionTableAnalysis, DecisionTableDraft, PackageNode, Project } from '../types'
import { http } from './client'

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
  const { data } = await http.get<Project[]>('/projects', { params: includeArchived ? { archived: 'true' } : undefined })
  return data.map(normalizeServerProject)
}

async function loadProject(projectId: string): Promise<Project | null> {
  try {
    const { data } = await http.get<Project>(`/projects/${encodeURIComponent(projectId)}`)
    return normalizeServerProject(data)
  } catch {
    return null
  }
}

export async function loadPackages(projectId: string, includeArchived = false): Promise<PackageNode[]> {
  const { data } = await http.get<PackageNode[]>(`/projects/${encodeURIComponent(projectId)}/packages`, { params: includeArchived ? { includeArchived: 'true' } : undefined })
  return data
}

async function loadAssetDetail(projectId: string, assetId: string): Promise<AssetDetail | null> {
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

export function usePackages(projectId: string | undefined, includeArchived = false) {
  return useQuery({
    queryKey: ['projects', projectId, 'packages', { includeArchived }],
    queryFn: () => loadPackages(projectId ?? '', includeArchived),
    enabled: Boolean(projectId),
  })
}

export function useDeprecateAsset(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ assetId, reason, replacedByAssetId }: { assetId: string; reason: string; replacedByAssetId?: string }) => {
      if (!projectId) throw new Error('项目不存在')
      const detail = await loadAssetDetail(projectId, assetId)
      if (!detail?.revision) throw new Error('资产不存在或修订号缺失')
      return assetAction(projectId, assetId, 'deprecate', { revision: detail.revision, reason, replacedByAssetId: replacedByAssetId || null })
    },
    onSuccess: async detail => {
      queryClient.setQueryData(['projects', projectId, 'assets', detail.id], detail)
      await queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] })
    },
  })
}

export function useReactivateAsset(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ assetId }: { assetId: string }) => {
      if (!projectId) throw new Error('项目不存在')
      const detail = await loadAssetDetail(projectId, assetId)
      if (!detail?.revision) throw new Error('资产不存在或修订号缺失')
      return assetAction(projectId, assetId, 'reactivate', { revision: detail.revision })
    },
    onSuccess: async detail => {
      queryClient.setQueryData(['projects', projectId, 'assets', detail.id], detail)
      await queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'packages'] })
    },
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
      if (!projectId) throw new Error('项目不存在')
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
      if (!projectId) throw new Error('项目不存在')
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
      if (!projectId) throw new Error('项目不存在')
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
