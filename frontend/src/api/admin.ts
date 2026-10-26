import axios from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AdminEnvironment,
  AdminOverview,
  AdminRole,
  AdminUser,
  DeploymentEnvironment,
  DeploymentTarget,
  ServerPrincipal,
  ServiceHealth,
  StorageStatus,
} from '../types'
import { http } from './client'

interface EngineHealth {
  engine: string
  version: string
}

interface ResHealth extends EngineHealth {
  service: string
  deployments: number
}

interface ProjectSummary {
  id: string
}

interface TeamServerRelease {
  decisionService: string
  version: number
  deployments: Array<{ environment: string; status?: 'deployed' | 'active' | 'stopped' }>
}

const buildHttp = axios.create({ baseURL: '/build-api', timeout: 5_000 })
const resHttp = axios.create({ baseURL: '/res-api', timeout: 5_000 })

const roles: AdminRole[] = [
  { id: 'admin', label: '管理员', permissions: ['view', 'author', 'advanced-epl', 'review', 'release', 'manage'] },
  { id: 'author', label: '规则作者', permissions: ['view', 'author'] },
  { id: 'cep-developer', label: 'CEP 开发人员', permissions: ['view', 'author', 'advanced-epl'] },
  { id: 'reviewer', label: '发布审核', permissions: ['view', 'review'] },
  { id: 'release-manager', label: '发布与部署', permissions: ['view', 'release'] },
  { id: 'viewer', label: '只读', permissions: ['view'] },
]

const environmentMetadata: Record<string, Pick<AdminEnvironment, 'purpose' | 'deploymentPolicy' | 'shadowMode'>> = {
  local: { purpose: '本机集成验证与端到端测试', deploymentPolicy: '手动部署', shadowMode: '-' },
  dev: { purpose: '规则作者调试，不承载业务流量', deploymentPolicy: '保存草稿后自动部署', shadowMode: '-' },
  test: { purpose: 'CI 回归测试与发布门禁', deploymentPolicy: '构建后部署', shadowMode: '-' },
  staging: { purpose: '生产前人工验证与影子对比', deploymentPolicy: '手动部署', shadowMode: '支持对比 production' },
  production: { purpose: '生产业务流量', deploymentPolicy: '审批后部署', shadowMode: '支持并行影子运行' },
}

function service(id: ServiceHealth['id'], name: string, result: PromiseSettledResult<unknown>, detail: string): ServiceHealth {
  return { id, name, status: result.status === 'fulfilled' ? 'online' : 'offline', detail: result.status === 'fulfilled' ? detail : '连接失败' }
}

async function loadActiveReleases() {
  const { data: projects } = await http.get<ProjectSummary[]>('/projects')
  const results = await Promise.allSettled(projects.map(project => http.get<TeamServerRelease[]>(`/projects/${encodeURIComponent(project.id)}/releases`)))
  return results.flatMap(result => result.status === 'fulfilled' ? result.value.data : [])
}

async function loadAdminOverview(): Promise<AdminOverview> {
  // The platform environment registry is authoritative configuration, so a
  // failed request must not be rendered as an empty registry. Keep the less
  // critical status cards best-effort, but let registry failures reach React
  // Query so the page can show an error and retry.
  const [environmentResponse, targetResponse] = await Promise.all([
    http.get<DeploymentEnvironment[]>('/admin/environments'),
    http.get<DeploymentTarget[]>('/admin/targets'),
  ])
  const [principalResult, storageResult, usersResult, engineResult, resResult, activeReleasesResult] = await Promise.allSettled([
    http.get<ServerPrincipal>('/session'),
    http.get<StorageStatus>('/system/storage'),
    http.get<AdminUser[]>('/admin/users'),
    buildHttp.get<EngineHealth>('/health'),
    resHttp.get<ResHealth>('/health'),
    loadActiveReleases(),
  ])

  const principal = principalResult.status === 'fulfilled' ? principalResult.value.data : null
  const storage = storageResult.status === 'fulfilled' ? storageResult.value.data : null
  const users = usersResult.status === 'fulfilled' ? usersResult.value.data : []
  const engine = engineResult.status === 'fulfilled' ? engineResult.value.data : null
  const res = resResult.status === 'fulfilled' ? resResult.value.data : null
  const activeReleases = activeReleasesResult.status === 'fulfilled' ? activeReleasesResult.value : []
  const deploymentEnvironments = environmentResponse.data
  const targets = targetResponse.data
  const environments: AdminEnvironment[] = deploymentEnvironments.map(environment => {
    const environmentTargets = targets.filter(target => target.environmentId === environment.id)
    const active = activeReleases.filter(release => release.deployments.some(deployment => deployment.environment === environment.id && deployment.status === 'active'))
    const metadata = environmentMetadata[environment.id] || { purpose: '平台部署环境', deploymentPolicy: '手动部署', shadowMode: '-' }
    return {
      id: environment.id,
      name: environment.name,
      kind: environment.kind,
      ...metadata,
      endpoint: environmentTargets.length ? environmentTargets.map(target => target.endpoint).join('、') : '尚未注册',
      currentRelease: active.length === 1 ? `${active[0].decisionService} v${active[0].version}` : active.length ? `${active.length} 个决策服务当前生效` : '-',
      status: !environmentTargets.length ? 'unregistered' : environmentTargets.every(target => target.status === 'ready') ? 'online' : 'offline',
      source: 'server',
    }
  })

  return {
    principal,
    storage,
    users,
    roles,
    environments,
    targets,
    services: [
      service('team-server', 'Team Server', principalResult, storage ? `${storage.mode} · ${storage.authMode}` : ''),
      service('build-service', 'Build Service', engineResult, engine ? `${engine.engine} ${engine.version}` : ''),
      service('res', 'Rule Execution Server', resResult, res ? `${res.engine} ${res.version} · ${res.deployments} 个部署` : ''),
    ],
    fetchedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  }
}

export function useAdminOverview() {
  return useQuery({
    queryKey: ['admin', 'overview', 'platform-registry'],
    queryFn: loadAdminOverview,
    refetchInterval: 30_000,
    retry: 3,
  })
}


export type AdminUserInput = Pick<AdminUser, 'username' | 'displayName' | 'email' | 'role' | 'status'>

function invalidateAdmin(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] })
}

export function useCreateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (user: AdminUserInput) => {
      const { data } = await http.post<AdminUser>('/admin/users', user)
      return data
    },
    onSuccess: () => invalidateAdmin(queryClient),
  })
}

export function useUpdateAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, user }: { id: string; user: Partial<AdminUserInput> }) => {
      const { data } = await http.put<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, user)
      return data
    },
    onSuccess: () => invalidateAdmin(queryClient),
  })
}

export function useDeleteAdminUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await http.delete(`/admin/users/${encodeURIComponent(id)}`)
    },
    onSuccess: () => invalidateAdmin(queryClient),
  })
}

export interface AdminTargetInput {
  name: string
  environmentId: string
  engine: 'drools' | 'esper'
  endpoint: string
}

export function useCreateAdminTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (target: AdminTargetInput) => (await http.post<DeploymentTarget>('/admin/targets', target)).data,
    onSuccess: () => invalidateAdmin(queryClient),
  })
}

export function useUpdateAdminTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => (
      await http.patch<DeploymentTarget>(`/admin/targets/${encodeURIComponent(id)}`, { enabled })
    ).data,
    onSuccess: () => invalidateAdmin(queryClient),
  })
}

export function useDeleteAdminTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => http.delete(`/admin/targets/${encodeURIComponent(id)}`),
    onSuccess: () => invalidateAdmin(queryClient),
  })
}

export function useReconcileAdminTargets() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => (await http.post<DeploymentTarget[]>('/admin/targets/reconcile')).data,
    onSuccess: () => invalidateAdmin(queryClient),
  })
}
