import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { ActivationGeneration, ApplicationPackageRecord, AssetType, DeploymentEnvironment, DeploymentRecord, DeploymentTarget, ReleaseDraft, ReleaseRecord, ReleaseWebhookConfig } from '../types'
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

export function useDeployments(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'deployments'],
    queryFn: async () => {
      try {
        return (await http.get<DeploymentRecord[]>(`/projects/${encodeURIComponent(projectId ?? '')}/deployments`)).data
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          throw new Error('当前 Team Server 尚未提供部署账本接口，请重启或更新后端服务。')
        }
        throw requestError(error)
      }
    },
    enabled: Boolean(projectId),
  })
}

export function useDeploymentEnvironments(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'environments'],
    queryFn: async () => {
      try {
        return (await http.get<DeploymentEnvironment[]>(`/projects/${encodeURIComponent(projectId ?? '')}/environments`)).data
      } catch (error) { throw requestError(error) }
    },
    enabled: Boolean(projectId),
  })
}

export function useApplicationPackages(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'application-packages'],
    queryFn: async () => {
      try {
        return (await http.get<ApplicationPackageRecord[]>(`/projects/${encodeURIComponent(projectId ?? '')}/application-packages`)).data
      } catch (error) { throw requestError(error) }
    },
    enabled: Boolean(projectId),
  })
}

export function useDeploymentTargets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'targets'],
    queryFn: async () => (await http.get<DeploymentTarget[]>(`/projects/${encodeURIComponent(projectId ?? '')}/targets`)).data,
    enabled: Boolean(projectId),
  })
}

export function useActivationGenerations(projectId: string | undefined) {
  return useQuery({
    queryKey: ['projects', projectId, 'activation-generations'],
    queryFn: async () => (await http.get<ActivationGeneration[]>(`/projects/${encodeURIComponent(projectId ?? '')}/activation-generations`)).data,
    enabled: Boolean(projectId),
  })
}

function useApplicationPackageMutation<TVariables>(
  projectId: string | undefined,
  request: (projectId: string, variables: TVariables) => Promise<ApplicationPackageRecord>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (variables: TVariables) => {
      if (!projectId) throw new Error('项目不存在')
      try { return await request(projectId, variables) }
      catch (error) { throw requestError(error) }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'application-packages'] })
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'releases'] })
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'deployments'] })
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'activation-generations'] })
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'targets'] })
    },
  })
}

export function useCreateApplicationPackage(projectId: string | undefined) {
  return useApplicationPackageMutation(projectId, async (id, input: { releaseId: string; name?: string }) => (
    await http.post<ApplicationPackageRecord>(`/projects/${encodeURIComponent(id)}/application-packages`, input)
  ).data)
}

export function useAppendApplicationManifest(projectId: string | undefined) {
  return useApplicationPackageMutation(projectId, async (id, input: { packageId: string; releaseId: string }) => (
    await http.post<ApplicationPackageRecord>(`/projects/${encodeURIComponent(id)}/application-packages/${encodeURIComponent(input.packageId)}/manifests`, { releaseId: input.releaseId })
  ).data)
}

export function useDeployApplicationPackage(projectId: string | undefined) {
  return useApplicationPackageMutation(projectId, async (id, input: { packageId: string; manifestId?: string; environment: string }) => (
    await http.post<ApplicationPackageRecord>(`/projects/${encodeURIComponent(id)}/application-packages/${encodeURIComponent(input.packageId)}/deploy`, { environment: input.environment, manifestId: input.manifestId })
  ).data)
}

export function useRollbackApplicationPackage(projectId: string | undefined) {
  return useApplicationPackageMutation(projectId, async (id, input: { packageId: string; environment: string }) => (
    await http.post<ApplicationPackageRecord>(`/projects/${encodeURIComponent(id)}/application-packages/${encodeURIComponent(input.packageId)}/rollback`, { environment: input.environment })
  ).data)
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
    onSuccess: release => {
      queryClient.setQueryData<ReleaseRecord[]>(
        ['projects', projectId, 'releases'],
        (current = []) => current.map(item => item.id === release.id ? release : item),
      )
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'deployments'] })
    },
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'releases'] })
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'deployments'] })
    },
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
