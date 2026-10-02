import { CircleUserRound, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AdminRole, AdminUser, ServerPrincipal } from '../../types'
import type { AdminUserInput } from '../../api/admin'

interface UserDirectoryProps {
  users: AdminUser[]
  roles: AdminRole[]
  principal: ServerPrincipal | null
  busy?: boolean
  onCreate: (user: AdminUserInput) => Promise<unknown>
  onUpdate: (id: string, user: Partial<AdminUserInput>) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
}

const blankUser: AdminUserInput = {
  username: '',
  displayName: '',
  email: '',
  role: 'viewer',
  status: 'active',
}

function userInput(user: AdminUser): AdminUserInput {
  return {
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    status: user.status,
  }
}

export default function UserDirectory({ users, roles, principal, busy = false, onCreate, onUpdate, onDelete }: UserDirectoryProps) {
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<AdminUserInput>(blankUser)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const roleLabels = useMemo(() => Object.fromEntries(roles.map((role) => [role.id, role.label])), [roles])
  const activeCount = users.filter((user) => user.status === 'active').length
  const canManage = Boolean(principal?.permissions.includes('*') || principal?.permissions.includes('manage'))

  const beginCreate = () => { setCreating(true); setEditing(null); setForm(blankUser); setMessage(null) }
  const beginEdit = (user: AdminUser) => { setEditing(user); setCreating(false); setForm(userInput(user)); setMessage(null) }
  const cancel = () => { setCreating(false); setEditing(null); setForm(blankUser); setMessage(null) }
  const submit = async () => {
    setMessage(null)
    try {
      if (creating) await onCreate(form)
      else if (editing) await onUpdate(editing.id, form)
      setMessage({ error: false, text: creating ? '用户已创建' : '用户已更新' })
      setCreating(false); setEditing(null); setForm(blankUser)
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : '操作失败' })
    }
  }
  const remove = async (user: AdminUser) => {
    if (!window.confirm(`确认删除用户 ${user.username}？`)) return
    setMessage(null)
    try { await onDelete(user.id); setMessage({ error: false, text: '用户已删除' }) }
    catch (error) { setMessage({ error: true, text: error instanceof Error ? error.message : '删除失败' }) }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
        <span>共 {users.length} 个目录用户 · {activeCount} 个启用</span>
        <div className="flex items-center gap-2">
          <span>身份来源：{principal?.mode === 'oidc' ? 'OIDC + 本地授权目录' : '本地开发目录'}</span>
          <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-ink-border bg-white px-2 text-brand-primary hover:bg-brand-primary-l disabled:opacity-50" disabled={!canManage || busy} onClick={beginCreate}><Plus size={13} />新增用户</button>
        </div>
      </div>
      {message && <p className={`mb-3 border px-3 py-2 text-[11px] ${message.error ? 'border-[#ef9a9a] bg-[#fff5f5] text-[#c62828]' : 'border-[#81c784] bg-[#edf7ed] text-[#1b5e20]'}`}>{message.text}</p>}
      {(creating || editing) && (
        <section className="mb-3 rounded-[3px] border border-ink-border bg-white p-3" aria-label={creating ? '新增用户' : '编辑用户'}>
          <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold">{creating ? '新增用户' : `编辑 ${editing?.username}`}</h3><button className="icon-button" type="button" onClick={cancel} aria-label="关闭"><X size={14} /></button></div>
          <div className="grid grid-cols-5 gap-2 max-lg:grid-cols-2">
            <label className="text-[10px] font-semibold text-ink-3">用户名<input className="control-input mt-1 h-8 text-xs" disabled={!creating} value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} /></label>
            <label className="text-[10px] font-semibold text-ink-3">姓名<input className="control-input mt-1 h-8 text-xs" value={form.displayName} onChange={event => setForm({ ...form, displayName: event.target.value })} /></label>
            <label className="text-[10px] font-semibold text-ink-3">邮箱<input className="control-input mt-1 h-8 text-xs" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></label>
            <label className="text-[10px] font-semibold text-ink-3">角色<select className="control-input mt-1 h-8 text-xs" value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}>{roles.map(role => <option key={role.id} value={role.id}>{role.label}</option>)}</select></label>
            <label className="text-[10px] font-semibold text-ink-3">状态<select className="control-input mt-1 h-8 text-xs" value={form.status} onChange={event => setForm({ ...form, status: event.target.value as AdminUserInput['status'] })}><option value="active">启用</option><option value="disabled">禁用</option></select></label>
          </div>
          <div className="mt-3 flex justify-end gap-2"><button type="button" className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={cancel}>取消</button><button type="button" className="primary-button h-8" disabled={busy} onClick={() => void submit()}><Save size={13} />保存用户</button></div>
        </section>
      )}
      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white" aria-label="用户目录">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left text-xs">
            <thead className="bg-[#fafafa] text-[11px] text-ink-2">
              <tr><th className="border-b border-ink-border px-[10px] py-2 font-semibold">用户</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">姓名</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">邮箱</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">角色</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">最近登录</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">状态</th><th className="w-28 border-b border-ink-border px-[10px] py-2 text-right font-semibold">操作</th></tr>
            </thead>
            <tbody>{users.map((user) => (
              <tr key={user.id} className={`border-b border-[#e8e8e8] last:border-0 ${user.current ? 'bg-[#f0f6fc]' : ''}`}>
                <td className="px-[10px] py-2"><span className="inline-flex items-center gap-2 font-medium"><CircleUserRound size={15} className={user.current ? 'text-brand-primary' : 'text-ink-3'} />{user.username}{user.current && <span className="rounded-[2px] bg-brand-primary-l px-1.5 py-px text-[9px] font-normal text-brand-primary">当前</span>}</span></td>
                <td className="px-[10px] py-2">{user.displayName}</td>
                <td className="px-[10px] py-2 text-ink-3">{user.email}</td>
                <td className="px-[10px] py-2"><span className="rounded-[2px] bg-[#eef1f4] px-2 py-1 text-[10px] text-ink-2">{roleLabels[user.role] ?? user.role}</span></td>
                <td className="whitespace-nowrap px-[10px] py-2 text-ink-3">{user.lastLogin}</td>
                <td className="px-[10px] py-2"><span className={`inline-flex items-center gap-1 ${user.status === 'active' ? 'text-env-production' : 'text-ink-3'}`}><span className={`size-1.5 rounded-full ${user.status === 'active' ? 'bg-env-production' : 'bg-ink-3'}`} />{user.status === 'active' ? '已启用' : '已禁用'}</span></td>
                <td className="px-[10px] py-2 text-right"><button className="icon-button" type="button" title="编辑用户" disabled={!canManage || busy} onClick={() => beginEdit(user)}><Pencil size={13} /></button><button className="icon-button text-[#c62828]" type="button" title="删除用户" disabled={!canManage || busy || user.current} onClick={() => void remove(user)}><Trash2 size={13} /></button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <p className="mt-3 text-[11px] text-ink-3">用户目录用于维护 Workbench 授权资料；OIDC 模式下登录认证仍由身份提供方完成。</p>
    </div>
  )
}
