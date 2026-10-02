import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { AssetType, ReleaseDraft, ReleaseRecord, ReleaseWebhookConfig } from '../types'
import { http } from './client'

const releasesByProject: Record<string, ReleaseRecord[]> = {
  miniloan: [
    { id: 'miniloan-2.1.0', version: '2.1.0', state: 'running', environments: ['production'], shadow: true, assetSummary: 'validation 3 · eligibility 3 · underwriting 2', assetCount: 8, checksum: 'a3f9…e21c', author: '陈分析师', createdAt: '2026-09-28 14:20', notes: '风险等级与贷款期限规则更新' },
    { id: 'miniloan-2.0.5', version: '2.0.5', state: 'rolled-back', environments: ['test'], shadow: false, assetSummary: '新增贷款期限合理规则', assetCount: 7, checksum: 'b7c1…90aa', author: 'wallace', createdAt: '2026-09-25 11:08', notes: '候选补丁，已回退' },
    { id: 'miniloan-2.0.0', version: '2.0.0', state: 'archived', environments: ['production'], shadow: false, assetSummary: 'validation 2 · eligibility 2 · underwriting 2', assetCount: 6, checksum: '90de…f031', author: '陈分析师', createdAt: '2026-09-10 09:15', notes: '第二版基线' },
    { id: 'miniloan-1.9.0', version: '1.9.0', state: 'archived', environments: [], shadow: false, assetSummary: '初版上线', assetCount: 5, checksum: 'c2a4…77bd', author: '陈分析师', createdAt: '2026-08-20 16:40', notes: '首个生产版本' },
  ],
  'grain-temperature': [
    { id: 'grain-1.4.0', version: '1.4.0', state: 'running', environments: ['production'], shadow: false, assetSummary: 'monitoring 3 · ventilation 2', assetCount: 5, checksum: '6ca1…d493', author: '王工程师', createdAt: '2026-09-27 11:20', notes: '增加温差梯度风险评估' },
    { id: 'grain-1.3.0', version: '1.3.0', state: 'archived', environments: ['test'], shadow: false, assetSummary: 'monitoring 2 · ventilation 2', assetCount: 4, checksum: '19b0…7f22', author: '王工程师', createdAt: '2026-09-12 09:42', notes: '通风策略基线' },
  ],
}

const demoProjectIds = new Set(['miniloan', 'grain-temperature'])

async function mockResult<T>(value: T): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 140))
  return value
}

interface ServerRelease {
  id: string
  decisionService: string
  version: number
  name: string
  description: string
  checksum: string
  createdAt: string
  createdBy?: string
  target: { type: 'rule' | 'table' | 'flow' | 'event-stream'; id: string; assetVersion: number }
  engine?: { type: 'drools' | 'esper'; drools?: string; esper?: string }
  steps?: Array<{ name: string; type: 'rule' | 'table'; assetId: string; assetVersion: number }>
  statements?: Array<{ name: string }>
  deployments: Array<{ environment: string; deployedAt: string }>
  latestForDecisionService?: boolean
  webhook?: ReleaseWebhookConfig
}

export interface ReleaseTarget {
  id: string
  name: string
  type: AssetType
}

function transformRelease(release: ServerRelease): ReleaseRecord {
  const checksum = release.checksum.startsWith('sha256:')
    ? `${release.checksum.slice(0, 15)}…${release.checksum.slice(-8)}`
    : release.checksum
  const engine = release.engine?.type === 'esper' ? 'cep' : 'rules'
  const assetSummary = release.target.type === 'event-stream'
    ? `${release.name || release.target.id} v${release.target.assetVersion} · ${(release.statements || []).length} EPL`
    : (release.steps || []).map(step => `${step.name} v${step.assetVersion}`).join(' · ')
  return {
    id: release.id,
    name: release.name,
    decisionService: release.decisionService,
    version: `${release.version}.0.0`,
    state: release.deployments.length ? 'running' : 'built',
    environments: release.deployments.map(deployment => deployment.environment === 'local' ? 'local' : deployment.environment).filter((environment): environment is ReleaseRecord['environments'][number] => ['local', 'dev', 'test', 'staging', 'production'].includes(environment)),
    shadow: false,
    assetSummary,
    assetCount: release.target.type === 'event-stream' ? 1 : (release.steps || []).length,
    checksum,
    author: release.createdBy || 'Team Server',
    createdAt: new Date(release.createdAt).toLocaleString('zh-CN', { hour12: false }),
    notes: release.description,
    latestForDecisionService: release.latestForDecisionService,
    engine,
    webhook: release.webhook,
  }
}

function requestError(error: unknown): Error {
  if (axios.isAxiosError<{ error?: string }>(error)) return new Error(error.response?.data?.error || error.message)
  return error instanceof Error ? error : new Error('Release 操作失败')
}

async function loadReleases(projectId: string): Promise<ReleaseRecord[]> {
  if (demoProjectIds.has(projectId)) return mockResult(releasesByProject[projectId] ?? [])
  const { data } = await http.get<ServerRelease[]>(`/projects/${encodeURIComponent(projectId)}/releases`)
  return data.map(transformRelease)
}

export function useReleases(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'releases'],
    queryFn: () => loadReleases(projectId ?? ''),
    enabled: Boolean(projectId),
  })
}

export function useCreateRelease(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ draft, assetSummary, target }: { draft: ReleaseDraft; assetSummary: string; target?: ReleaseTarget }) => {
      if (!projectId) throw new Error('项目不存在')
      if (!demoProjectIds.has(projectId)) {
        if (!target) throw new Error('请选择一个发布目标')
        try {
          const { data } = await http.post<ServerRelease>(`/projects/${encodeURIComponent(projectId)}/releases`, {
            decisionService: `${projectId}/${target.id.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`,
            name: `v${draft.version} ${target.name}`,
            description: draft.notes,
            target: { type: target.type === 'decision-table' ? 'table' : target.type, id: target.id },
          })
          return transformRelease(data)
        } catch (error) {
          throw requestError(error)
        }
      }
      if ((releasesByProject[projectId] ?? []).some((release) => release.version === draft.version)) {
        throw new Error(`Release v${draft.version} 已存在，发布版本不可覆盖。`)
      }
      await new Promise((resolve) => window.setTimeout(resolve, 900))
      const record: ReleaseRecord = {
        id: `${projectId}-${draft.version}`,
        version: draft.version,
        state: 'built',
        environments: draft.targetEnvironments,
        shadow: draft.targetEnvironments.includes('staging') || draft.targetEnvironments.includes('production'),
        assetSummary,
        assetCount: draft.assetIds.length,
        checksum: `d91e…${draft.version.replace(/\./g, '')}`,
        author: 'wallace',
        createdAt: '2026-09-29 13:24',
        notes: draft.notes,
      }
      releasesByProject[projectId] = [record, ...(releasesByProject[projectId] ?? [])]
      return record
    },
    onSuccess: (record) => queryClient.setQueryData<ReleaseRecord[]>(
      ['projects', projectId, 'releases'],
      (current = []) => current.some((item) => item.id === record.id) ? current : [record, ...current],
    ),
  })
}

export function useDeployRelease(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (releaseId: string) => {
      if (!projectId) throw new Error('项目不存在')
      try {
        const { data } = await http.post<ServerRelease>(
          `/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/deploy`,
          { environment: 'local' },
        )
        return transformRelease(data)
      } catch (error) {
        throw requestError(error)
      }
    },
    onSuccess: release => queryClient.setQueryData<ReleaseRecord[]>(
      ['projects', projectId, 'releases'],
      (current = []) => current.map(item => item.id === release.id ? release : item),
    ),
  })
}

export function useConfigureReleaseWebhook(projectId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ releaseId, webhook }: { releaseId: string; webhook: ReleaseWebhookConfig }) => {
      if (!projectId) throw new Error('项目不存在')
      try {
        const { data } = await http.post<ServerRelease>(
          `/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/webhook`,
          { webhook },
        )
        return transformRelease(data)
      } catch (error) {
        throw requestError(error)
      }
    },
    onSuccess: release => queryClient.setQueryData<ReleaseRecord[]>(
      ['projects', projectId, 'releases'],
      (current = []) => current.map(item => item.id === release.id ? release : item),
    ),
  })
}
