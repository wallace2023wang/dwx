import axios from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AdminEnvironment,
  AdminOverview,
  AdminRole,
  AdminUser,
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
  { id: 'admin', label: '管理员', permissions: ['view', 'author', 'review', 'release', 'manage'] },
  { id: 'author', label: '规则作者', permissions: ['view', 'author'] },
  { id: 'reviewer', label: '发布审核', permissions: ['view', 'review'] },
  { id: 'release-manager', label: '发布与部署', permissions: ['view', 'release'] },
  { id: 'viewer', label: '只读', permissions: ['view'] },
]

const presetEnvironments: AdminEnvironment[] = [
  { id: 'dev', purpose: '规则作者调试，不承载业务流量', endpoint: '尚未注册', deploymentPolicy: '保存草稿后自动部署', currentRelease: '-', shadowMode: '-', status: 'unregistered', source: 'preset' },
  { id: 'test', purpose: 'CI 回归测试与发布门禁', endpoint: '尚未注册', deploymentPolicy: '构建后自动部署', currentRelease: '-', shadowMode: '-', status: 'unregistered', source: 'preset' },
  { id: 'staging', purpose: '生产前人工验证与影子对比', endpoint: '尚未注册', deploymentPolicy: '手动部署', currentRelease: '-', shadowMode: '支持对比 production', status: 'unregistered', source: 'preset' },
  { id: 'production', purpose: '生产业务流量', endpoint: '尚未注册', deploymentPolicy: '双人审批后部署', currentRelease: '-', shadowMode: '支持并行影子运行', status: 'unregistered', source: 'preset' },
]

function service(id: ServiceHealth['id'], name: string, result: PromiseSettledResult<unknown>, detail: string): ServiceHealth {
  return { id, name, status: result.status === 'fulfilled' ? 'online' : 'offline', detail: result.status === 'fulfilled' ? detail : '连接失败' }
}

async function loadActiveReleases() {
  const { data: projects } = await http.get<ProjectSummary[]>('/projects')
  const results = await Promise.allSettled(projects.map(project => http.get<TeamServerRelease[]>(`/projects/${encodeURIComponent(project.id)}/releases`)))
  return results.flatMap(result => result.status === 'fulfilled' ? result.value.data : [])
    .filter(release => release.deployments.some(deployment => deployment.environment === 'local' && deployment.status === 'active'))
}

async function loadAdminOverview(): Promise<AdminOverview> {
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
  const currentRelease = activeReleases.length === 1
    ? `${activeReleases[0].decisionService} v${activeReleases[0].version}`
    : activeReleases.length > 1 ? `${activeReleases.length} 个决策服务当前生效` : '-'

  const localEnvironment: AdminEnvironment = {
    id: 'local',
    purpose: '本机集成验证与端到端测试',
    endpoint: '127.0.0.1:8790',
    deploymentPolicy: 'Team Server 手动部署',
    currentRelease,
    shadowMode: '-',
    status: res ? 'online' : 'offline',
    source: 'server',
  }

  return {
    principal,
    storage,
    users,
    roles,
    environments: [localEnvironment, ...presetEnvironments],
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
    queryKey: ['admin', 'overview'],
    queryFn: loadAdminOverview,
    refetchInterval: 30_000,
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
