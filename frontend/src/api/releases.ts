import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { AssetType, ReleaseDraft, ReleaseRecord, ReleaseWebhookConfig } from '../types'
import { http } from './client'

interface ServerRelease {
  id: string
  decisionService: string
  version: number
  displayVersion?: string
  name: string
  description: string
  checksum: string
  createdAt: string
  createdBy?: string
  target: { type: 'rule' | 'table' | 'flow' | 'event-stream'; id: string; assetVersion: number }
  engine?: { type: 'drools' | 'esper'; drools?: string; esper?: string }
  steps?: Array<{ name: string; type: 'rule' | 'table'; assetId: string; assetVersion: number }>
  statements?: Array<{ name: string }>
  deployments: Array<{ environment: string; deployedAt: string; status?: 'deployed' | 'active' | 'stopped'; activatedAt?: string; stoppedAt?: string }>
  latestForDecisionService?: boolean
  rollbackAvailable?: boolean
  webhook?: ReleaseWebhookConfig
}

export interface ReleaseTarget {
  id: string
  name: string
  type: AssetType
  decisionService?: string
}

export interface CepAlert {
  id: string
  releaseId: string
  statement: string
  eventType: string
  key: string
  correlationKey: string
  status: 'ACTIVE' | 'ACKED' | 'CLEARED'
  lastFiredAt: string
  ackedBy?: string
  ackedAt?: string
  clearedAt?: string
  detection?: { data?: Record<string, unknown> }
}

function transformRelease(release: ServerRelease, projectId: string): ReleaseRecord {
  const checksum = release.checksum.startsWith('sha256:')
    ? `${release.checksum.slice(0, 15)}…${release.checksum.slice(-8)}`
    : release.checksum
  const engine = release.engine?.type === 'esper' ? 'cep' : 'rules'
  const assetSummary = release.target.type === 'event-stream'
    ? `${release.name || release.target.id} v${release.target.assetVersion} · ${(release.statements || []).length} EPL`
    : (release.steps || []).map(step => step.assetVersion ? `${step.name} v${step.assetVersion}` : step.name).join(' · ')
  const deploymentStatuses = release.deployments.map(deployment => deployment.status || 'deployed')
  const state: ReleaseRecord['state'] = deploymentStatuses.includes('active')
    ? 'active'
    : deploymentStatuses.includes('deployed') ? 'deployed' : deploymentStatuses.includes('stopped') ? 'stopped' : 'built'
  const serviceParts = release.decisionService.split('/')
  const serviceKey = serviceParts[serviceParts.length - 1] || release.decisionService
  return {
    id: release.id,
    name: release.name,
    decisionService: release.decisionService,
    version: release.displayVersion || `${release.version}.0.0`,
    state,
    environments: release.deployments.map(deployment => deployment.environment === 'local' ? 'local' : deployment.environment).filter((environment): environment is ReleaseRecord['environments'][number] => ['local', 'dev', 'test', 'staging', 'production'].includes(environment)),
    shadow: false,
    assetSummary,
    assetCount: release.target.type === 'event-stream' ? 1 : (release.steps || []).length,
    checksum,
    author: release.createdBy || 'Team Server',
    createdAt: new Date(release.createdAt).toLocaleString('zh-CN', { hour12: false }),
    notes: release.description,
    latestForDecisionService: release.latestForDecisionService,
    rollbackAvailable: release.rollbackAvailable,
    stableEndpoint: engine === 'rules'
      ? `/services/${release.decisionService}/execute`
      : `/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceKey)}/execute`,
    engine,
    webhook: release.webhook,
    target: release.target,
  }
}

function requestError(error: unknown): Error {
  if (axios.isAxiosError<{ error?: string }>(error)) return new Error(error.response?.data?.error || error.message)
  return error instanceof Error ? error : new Error('Release 操作失败')
}

async function loadReleases(projectId: string): Promise<ReleaseRecord[]> {
  const { data } = await http.get<ServerRelease[]>(`/projects/${encodeURIComponent(projectId)}/releases`)
  return data.map(release => transformRelease(release, projectId))
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
    mutationFn: async ({ draft, target }: { draft: ReleaseDraft; assetSummary: string; target?: ReleaseTarget }) => {
      if (!projectId) throw new Error('项目不存在')
      if (!target) throw new Error('请选择一个发布目标')
      try {
        const { data } = await http.post<ServerRelease>(`/projects/${encodeURIComponent(projectId)}/releases`, {
          decisionService: target.decisionService || `${projectId}/${target.id.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`,
          version: draft.version,
          name: `v${draft.version} ${target.name}`,
          description: draft.notes,
          target: { type: ['decision-table', 'decision-tree', 'scorecard', 'rule-template'].includes(target.type) ? 'table' : target.type, id: target.id },
        })
        return transformRelease(data, projectId)
      } catch (error) {
        throw requestError(error)
      }
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
        return transformRelease(data, projectId)
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

function useReleaseOperation(projectId: string | undefined, action: 'activate' | 'rollback' | 'undeploy') {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (releaseId: string) => {
      if (!projectId) throw new Error('项目不存在')
      try {
        const { data } = await http.post<ServerRelease>(
          `/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/${action}`,
          { environment: 'local' },
        )
        return transformRelease(data, projectId)
      } catch (error) {
        throw requestError(error)
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'releases'] }),
  })
}

export function useActivateRelease(projectId: string | undefined) {
  return useReleaseOperation(projectId, 'activate')
}

export function useRollbackRelease(projectId: string | undefined) {
  return useReleaseOperation(projectId, 'rollback')
}

export function useUndeployRelease(projectId: string | undefined) {
  return useReleaseOperation(projectId, 'undeploy')
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
        return transformRelease(data, projectId)
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

export function useReleaseAlerts(projectId: string | undefined, releaseId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'releases', releaseId, 'alerts'],
    enabled: Boolean(projectId && releaseId),
    refetchInterval: 5_000,
    queryFn: async () => {
      try {
        return (await http.get<CepAlert[]>(`/projects/${encodeURIComponent(projectId ?? '')}/releases/${encodeURIComponent(releaseId ?? '')}/alerts`)).data
      } catch (error) { throw requestError(error) }
    },
  })
}

export function useAcknowledgeReleaseAlert(projectId: string | undefined, releaseId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (alertId: string) => {
      if (!projectId || !releaseId) throw new Error('缺少 CEP Release')
      try {
        return (await http.post<CepAlert>(`/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/alerts`, { alertId, action: 'ack' })).data
      } catch (error) { throw requestError(error) }
    },
    onSuccess: alert => queryClient.setQueryData<CepAlert[]>(
      ['projects', projectId, 'releases', releaseId, 'alerts'],
      (current = []) => current.map(item => item.id === alert.id ? alert : item),
    ),
  })
}
