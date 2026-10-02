import { CircleDot, Server } from 'lucide-react'
import type { AdminEnvironment } from '../../types'

interface EnvironmentRegistryProps {
  environments: AdminEnvironment[]
}

const environmentTones: Record<string, string> = {
  local: 'bg-[#eef1f4] text-ink-2',
  dev: 'bg-[#f3e5f5] text-env-dev',
  test: 'bg-brand-primary-l text-env-test',
  staging: 'bg-[#fff3e0] text-env-staging',
  production: 'bg-[#e8f5e9] text-env-production',
}

const statusLabels: Record<AdminEnvironment['status'], string> = {
  online: '在线', offline: '离线', unregistered: '未注册',
}

export default function EnvironmentRegistry({ environments }: EnvironmentRegistryProps) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
        <span>{environments.filter((environment) => environment.source === 'server').length} 个已注册环境 · {environments.filter((environment) => environment.source === 'preset').length} 个预置环境</span>
        <span className="inline-flex items-center gap-1.5"><Server size={13} />RES 注册表</span>
      </div>
      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white" aria-label="环境与 RES 注册表">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] border-collapse text-left text-xs">
            <thead className="bg-[#fafafa] text-[11px] text-ink-2"><tr><th className="border-b border-ink-border px-[10px] py-2 font-semibold">环境</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">用途</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">RES 端点</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">部署策略</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">当前 Release</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">Shadow 模式</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">状态</th></tr></thead>
            <tbody>{environments.map((environment) => (
              <tr key={environment.id} className="border-b border-[#e8e8e8] last:border-0 hover:bg-[#f0f6fc]">
                <td className="px-[10px] py-2"><span className={`rounded-[2px] px-2 py-1 text-[10px] ${environmentTones[environment.id] ?? 'bg-[#eef1f4] text-ink-2'}`}>{environment.id}</span></td>
                <td className="px-[10px] py-2">{environment.purpose}</td>
                <td className="px-[10px] py-2 font-mono text-[10px] text-ink-2">{environment.endpoint}</td>
                <td className="px-[10px] py-2">{environment.deploymentPolicy}</td>
                <td className="px-[10px] py-2 font-mono text-[10px] text-brand-primary">{environment.currentRelease}</td>
                <td className="px-[10px] py-2 text-ink-3">{environment.shadowMode}</td>
                <td className="px-[10px] py-2"><span className={`inline-flex items-center gap-1 ${environment.status === 'online' ? 'text-env-production' : environment.status === 'offline' ? 'text-[#c62828]' : 'text-ink-3'}`}><CircleDot size={12} />{statusLabels[environment.status]}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <p className="mt-3 text-[11px] text-ink-3">Team Server 当前只允许部署到 <span className="font-mono">local</span>；其余环境完成端点注册、凭据配置和审批策略后方可启用。</p>
    </div>
  )
}
