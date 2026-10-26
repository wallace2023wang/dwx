import { CircleDot, LoaderCircle, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AdminTargetInput } from '../../api/admin'
import type { AdminEnvironment, DeploymentTarget } from '../../types'

interface EnvironmentRegistryProps {
  environments: AdminEnvironment[]
  targets: DeploymentTarget[]
  busy: boolean
  error: Error | null
  onCreate: (target: AdminTargetInput) => Promise<unknown>
  onToggle: (id: string, enabled: boolean) => Promise<unknown>
  onDelete: (id: string) => Promise<void>
  onReconcile: () => Promise<void>
}

const environmentTones: Record<string, string> = {
  local: 'bg-[#eef1f4] text-ink-2',
  dev: 'bg-[#f3e5f5] text-env-dev',
  test: 'bg-brand-primary-l text-env-test',
  staging: 'bg-[#fff3e0] text-env-staging',
  production: 'bg-[#e8f5e9] text-env-production',
}

const targetStatus: Record<DeploymentTarget['status'], { label: string; tone: string }> = {
  ready: { label: '在线', tone: 'text-env-production' },
  unreachable: { label: '不可达', tone: 'text-[#c62828]' },
  mismatch: { label: '代次偏移', tone: 'text-[#b26a00]' },
  unknown: { label: '未对账', tone: 'text-ink-3' },
}

function date(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

export default function EnvironmentRegistry({ environments, targets, busy, error, onCreate, onToggle, onDelete, onReconcile }: EnvironmentRegistryProps) {
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState<AdminTargetInput>({
    environmentId: environments.find(environment => environment.id === 'test')?.id || environments[0]?.id || 'local',
    name: '', endpoint: '', engine: 'drools',
  })

  const create = async () => {
    await onCreate({ ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim() })
    setDraft(current => ({ ...current, name: '', endpoint: '' }))
    setShowForm(false)
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-ink-3"><span>{environments.length} 个平台环境 · {targets.length} 个 RES Target</span><p className="mt-1">平台管理员统一维护；Rule Project 只能选择环境并使用已启用节点。</p></div>
        <div className="flex gap-1.5">
          <button type="button" className="inline-flex h-8 items-center gap-1 rounded-[2px] border border-ink-border bg-white px-3 text-[11px] text-ink-2 disabled:opacity-50" disabled={busy} onClick={() => void onReconcile()}>{busy ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />}对账全部</button>
          <button type="button" className="inline-flex h-8 items-center gap-1 rounded-[2px] border border-brand-primary bg-white px-3 text-[11px] text-brand-primary" onClick={() => setShowForm(value => !value)}><Plus size={12} />注册 RES</button>
        </div>
      </div>

      {showForm && <section className="mb-3 grid gap-2 rounded-[3px] border border-ink-border bg-white p-3 md:grid-cols-[140px_120px_180px_minmax(280px,1fr)_auto]">
        <select className="h-8 rounded-[2px] border border-ink-border bg-white px-2 text-[11px]" value={draft.environmentId} onChange={event => setDraft(current => ({ ...current, environmentId: event.target.value }))}>{environments.map(environment => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select>
        <select className="h-8 rounded-[2px] border border-ink-border bg-white px-2 text-[11px]" value={draft.engine} onChange={event => setDraft(current => ({ ...current, engine: event.target.value as 'drools' | 'esper' }))}><option value="drools">Drools</option><option value="esper">Esper</option></select>
        <input className="h-8 rounded-[2px] border border-ink-border px-2 text-[11px]" placeholder="节点名称" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
        <input className="h-8 rounded-[2px] border border-ink-border px-2 font-mono text-[11px]" placeholder="管理面地址，例如 http://res-node:8793" value={draft.endpoint} onChange={event => setDraft(current => ({ ...current, endpoint: event.target.value }))} />
        <div className="flex gap-1.5"><button type="button" className="primary-button disabled:opacity-50" disabled={busy || !draft.name.trim() || !draft.endpoint.trim()} onClick={() => void create()}>注册</button><button type="button" className="ghost-button" onClick={() => setShowForm(false)}>取消</button></div>
      </section>}

      {error && <div className="mb-3 rounded-[3px] border border-[#ffcdd2] bg-[#fff5f5] px-3 py-2 text-[11px] text-[#c62828]">{error.message}</div>}

      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white" aria-label="环境与 RES 注册表">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-left text-xs">
            <thead className="bg-[#fafafa] text-[11px] text-ink-2"><tr><th className="border-b border-ink-border px-[10px] py-2 font-semibold">环境</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">用途</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">RES Target</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">管理面 Endpoint</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">引擎</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">最近对账</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">状态</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">启用</th><th className="w-12 border-b border-ink-border px-[10px] py-2" /></tr></thead>
            <tbody>{environments.flatMap(environment => {
              const environmentTargets = targets.filter(target => target.environmentId === environment.id)
              if (!environmentTargets.length) return [<tr key={environment.id} className="border-b border-[#e8e8e8] last:border-0"><td className="px-[10px] py-2"><span className={`rounded-[2px] px-2 py-1 text-[10px] ${environmentTones[environment.id] ?? 'bg-[#eef1f4] text-ink-2'}`}>{environment.id}</span></td><td className="px-[10px] py-2">{environment.purpose}</td><td colSpan={6} className="px-[10px] py-2 text-ink-3">尚未注册 RES Target</td><td /></tr>]
              return environmentTargets.map((target) => {
                const status = targetStatus[target.status]
                return <tr key={target.id} className="border-b border-[#e8e8e8] last:border-0 hover:bg-[#f0f6fc]">
                  <td className="px-[10px] py-2"><span className={`rounded-[2px] px-2 py-1 text-[10px] ${environmentTones[environment.id] ?? 'bg-[#eef1f4] text-ink-2'}`}>{environment.id}</span></td>
                  <td className="px-[10px] py-2">{environment.purpose}</td>
                  <td className="px-[10px] py-2"><div className="font-semibold text-ink-1">{target.name}</div><div className="mt-0.5 font-mono text-[9px] text-ink-3">{target.nodeId || target.id}</div></td>
                  <td className="px-[10px] py-2 font-mono text-[10px] text-ink-2">{target.endpoint}</td>
                  <td className="px-[10px] py-2">{target.engine}{target.engineVersion ? ` ${target.engineVersion}` : ''}</td>
                  <td className="px-[10px] py-2 text-[10px] text-ink-3">{date(target.lastSeenAt)}</td>
                  <td className="px-[10px] py-2"><span className={`inline-flex items-center gap-1 ${status.tone}`}><CircleDot size={12} />{status.label}</span>{target.lastError && <div className="mt-1 max-w-[220px] truncate text-[9px] text-[#c62828]" title={target.lastError}>{target.lastError}</div>}</td>
                  <td className="px-[10px] py-2"><input type="checkbox" checked={target.enabled} disabled={busy} aria-label={`${target.enabled ? '禁用' : '启用'} ${target.name}`} onChange={event => void onToggle(target.id, event.target.checked)} /></td>
                  <td className="px-[10px] py-2"><button type="button" className="inline-flex size-7 items-center justify-center rounded-[2px] border border-ink-border text-ink-3 hover:border-[#c62828] hover:text-[#c62828] disabled:opacity-50" disabled={busy} title="删除 Target" onClick={() => { if (window.confirm(`确定删除 RES Target“${target.name}”？`)) void onDelete(target.id) }}><Trash2 size={12} /></button></td>
                </tr>
              })
            })}</tbody>
          </table>
        </div>
      </section>
      <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-ink-3"><Server size={13} />这里登记管理面 Endpoint；业务系统调用使用对应 RES 的执行面地址。</p>
    </div>
  )
}
