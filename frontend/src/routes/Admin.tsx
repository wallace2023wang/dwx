import { Database, LoaderCircle, RefreshCw, ServerCog, Shield, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { useAdminOverview, useCreateAdminTarget, useCreateAdminUser, useDeleteAdminTarget, useDeleteAdminUser, useReconcileAdminTargets, useUpdateAdminTarget, useUpdateAdminUser } from '../api/admin'
import EnvironmentRegistry from '../components/admin/EnvironmentRegistry'
import RoleMatrix from '../components/admin/RoleMatrix'
import UserDirectory from '../components/admin/UserDirectory'

type AdminTab = 'users' | 'roles' | 'environments'

const tabs: Array<{ id: AdminTab; label: string; icon: typeof UsersRound }> = [
  { id: 'users', label: '用户', icon: UsersRound },
  { id: 'roles', label: '角色与权限', icon: Shield },
  { id: 'environments', label: '环境与 RES', icon: ServerCog },
]

export default function Admin() {
  const [activeTab, setActiveTab] = useState<AdminTab>('users')
  const { data, error, isPending, isFetching, refetch } = useAdminOverview()
  const createUser = useCreateAdminUser()
  const updateUser = useUpdateAdminUser()
  const deleteUser = useDeleteAdminUser()
  const createTarget = useCreateAdminTarget()
  const updateTarget = useUpdateAdminTarget()
  const deleteTarget = useDeleteAdminTarget()
  const reconcileTargets = useReconcileAdminTargets()
  const userBusy = createUser.isPending || updateUser.isPending || deleteUser.isPending

  if (isPending) return <div className="p-6 text-xs text-ink-3">正在连接管理服务...</div>
  if (error || !data) return <div className="m-6 rounded-[3px] border border-[#ffcdd2] bg-[#fff5f5] p-4 text-xs text-[#c62828]"><p>环境与 RES 注册表加载失败：{error instanceof Error ? error.message : '管理服务暂不可用'}</p><button type="button" className="mt-3 rounded-[2px] border border-[#c62828] bg-white px-3 py-1.5" onClick={() => void refetch()}>重新加载</button></div>

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
      <div className="mb-[14px] flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-lg font-medium">管理控制台</h1><p className="mt-0.5 text-[11px] text-ink-3">服务状态、身份权限与 RES 环境注册</p></div>
        <div className="flex items-center gap-2 text-[11px] text-ink-3"><span>更新于 {data.fetchedAt}</span><button type="button" className="flex size-8 items-center justify-center rounded-[2px] border border-ink-border bg-white text-ink-2 hover:bg-[#f0f6fc]" title="刷新状态" aria-label="刷新状态" onClick={() => void refetch()} disabled={isFetching}>{isFetching ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button></div>
      </div>

      <section className="mb-4 grid grid-cols-3 overflow-hidden rounded-[3px] border border-ink-border bg-white max-md:grid-cols-1" aria-label="平台服务状态">
        {data.services.map((service, index) => (
          <div key={service.id} className={`flex min-h-[70px] items-center gap-3 px-4 py-3 ${index < data.services.length - 1 ? 'border-r border-ink-border max-md:border-b max-md:border-r-0' : ''}`}>
            {service.id === 'team-server' ? <Database size={18} className="text-brand-primary" /> : <ServerCog size={18} className="text-brand-primary" />}
            <div><h2 className="text-xs font-semibold">{service.name}</h2><p className="mt-0.5 text-[10px] text-ink-3">{service.detail}</p></div>
            <span className={`ml-auto inline-flex items-center gap-1 text-[10px] ${service.status === 'online' ? 'text-env-production' : 'text-[#c62828]'}`}><span className={`size-1.5 rounded-full ${service.status === 'online' ? 'bg-env-production' : 'bg-[#c62828]'}`} />{service.status === 'online' ? '在线' : '离线'}</span>
          </div>
        ))}
      </section>

      <nav className="mb-4 flex overflow-x-auto border-b border-ink-border" role="tablist" aria-label="管理视图">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={`flex h-9 shrink-0 items-center gap-1.5 rounded-t-[3px] border px-4 text-xs ${activeTab === tab.id ? 'border-ink-border border-b-ink-bg bg-ink-bg font-medium text-ink-1' : 'border-transparent text-ink-2 hover:text-ink-1'}`} onClick={() => setActiveTab(tab.id)}><Icon size={14} />{tab.label}</button>
        })}
      </nav>

      {activeTab === 'users' && <UserDirectory users={data.users} roles={data.roles} principal={data.principal} busy={userBusy} onCreate={user => createUser.mutateAsync(user)} onUpdate={(id, user) => updateUser.mutateAsync({ id, user })} onDelete={id => deleteUser.mutateAsync(id)} />}
      {activeTab === 'roles' && <RoleMatrix roles={data.roles} />}
      {activeTab === 'environments' && <EnvironmentRegistry
        environments={data.environments}
        targets={data.targets}
        busy={createTarget.isPending || updateTarget.isPending || deleteTarget.isPending || reconcileTargets.isPending}
        error={createTarget.error || updateTarget.error || deleteTarget.error || reconcileTargets.error}
        onCreate={target => createTarget.mutateAsync(target)}
        onToggle={(id, enabled) => updateTarget.mutateAsync({ id, enabled })}
        onDelete={id => deleteTarget.mutateAsync(id).then(() => undefined)}
        onReconcile={() => reconcileTargets.mutateAsync().then(() => undefined)}
      />}
    </div>
  )
}
