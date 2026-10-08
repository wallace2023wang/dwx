import { FileText, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router-dom'
import { useProject, useUpdateProject } from '../../api/projects'
import Modal from '../../components/Modal'
import RulesetVariablesEditor from '../../components/project/RulesetVariablesEditor'
import ProjectTabs from '../../components/layout/ProjectTabs'
import type { ApprovalPolicy, RuleSetVariable } from '../../types'
import { useProjectStore } from '../../store/project'

export default function ProjectShell() {
  const { projectId } = useParams()
  const location = useLocation()
  const reportMode = location.pathname.endsWith('/report')
  const { data: project, isPending } = useProject(projectId)
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject)
  const updateProject = useUpdateProject(projectId)
  const [settings, setSettings] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', icon: 'shield' as 'loan' | 'warehouse' | 'shield', defaultEnvironment: 'local', variables: [] as RuleSetVariable[], approvalPolicy: { requiredApprovals: 1, requireComment: false, preventSelfApproval: true, allowedReviewerRoles: ['reviewer', 'admin'] } as ApprovalPolicy })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (projectId) setCurrentProject(projectId)
  }, [projectId, setCurrentProject])

  if (isPending) return <div className="p-6 text-xs text-ink-3">正在加载项目...</div>
  if (!project) return <Navigate to="/library" replace />

  const openSettings = () => {
    setForm({ name: project.name, description: project.description, icon: project.icon, defaultEnvironment: project.defaultEnvironment || 'local', variables: structuredClone(project.variables || []), approvalPolicy: structuredClone(project.approvalPolicy || { requiredApprovals: 1, requireComment: false, preventSelfApproval: true, allowedReviewerRoles: ['reviewer', 'admin'] }) })
    setError(null)
    setSettings(true)
  }

  const saveSettings = async () => {
    setError(null)
    try {
      const saved = await updateProject.mutateAsync(form)
      const expected = form.variables.map(variable => variable.name).join('\n')
      const actual = (saved.variables || []).map(variable => variable.name).join('\n')
      if (expected !== actual) throw new Error('后端未保存 Rule Project 变量，请确认 Team Server 已重启并完成数据库迁移')
      setSettings(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败'
      setError(message)
      window.alert(message)
    }
  }

  return (
    <div className={reportMode ? 'min-w-0' : 'flex h-full min-w-0 flex-col overflow-hidden'}>
      <header className="project-shell-header shrink-0 border-b border-ink-border bg-white px-5 pt-4">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-medium">{project.name}</h1>
          <span className="rounded-[2px] bg-[#f3e5f5] px-2 py-px text-[10px] text-env-dev">分支: {project.branch}</span>
          <div className="ml-auto flex items-center gap-1">{project.source === 'server' && <button className="inline-flex size-8 items-center justify-center text-ink-3 hover:bg-ink-bg hover:text-brand-primary" onClick={openSettings} title="项目设置"><Settings size={15} /></button>}<Link to={`/projects/${project.id}/report`} className="inline-flex h-8 items-center gap-1.5 border border-ink-border bg-white px-2.5 text-[11px] text-ink-2 hover:border-brand-primary hover:text-brand-primary" title="查看项目知识资产报告"><FileText size={14} />报告</Link></div>
        </div>
        <p className="mt-0.5 text-[11px] text-ink-3">最近修改: {project.updatedAt} · {project.updatedBy} · 基线 {project.version}</p>
        <ProjectTabs />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
      {settings && <Modal title="项目设置" onClose={() => setSettings(false)}><div className="max-h-[75vh] space-y-4 overflow-y-auto p-4"><label className="block text-[11px] font-semibold text-ink-2">项目 ID<input className="control-input mt-1 bg-ink-bg font-mono" value={project.id} disabled /></label><label className="block text-[11px] font-semibold text-ink-2">名称<input className="control-input mt-1" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label className="block text-[11px] font-semibold text-ink-2">描述<textarea className="mt-1 min-h-20 w-full border border-ink-border p-2 text-xs outline-none focus:border-brand-primary" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><div className="grid grid-cols-2 gap-3"><label className="text-[11px] font-semibold text-ink-2">图标<select className="control-input mt-1" value={form.icon} onChange={event => setForm({ ...form, icon: event.target.value as typeof form.icon })}><option value="loan">贷款</option><option value="warehouse">仓储</option><option value="shield">风控</option></select></label><label className="text-[11px] font-semibold text-ink-2">默认环境<select className="control-input mt-1" value={form.defaultEnvironment} onChange={event => setForm({ ...form, defaultEnvironment: event.target.value })}><option value="local">local</option><option value="test">test</option><option value="staging">staging</option><option value="production">production</option></select></label></div><section className="space-y-3 rounded-[3px] border border-[#b8c9f5] bg-[#f5f8ff] p-3"><div><h3 className="text-[11px] font-semibold text-ink-2">审核与职责分离</h3><p className="mt-1 text-[10px] text-ink-3">策略在提交审核时冻结；多人审核全部通过后才发布。</p></div><label className="block text-[11px] font-semibold text-ink-2">所需批准人数<select className="control-input mt-1" value={form.approvalPolicy.requiredApprovals} onChange={event => setForm({ ...form, approvalPolicy: { ...form.approvalPolicy, requiredApprovals: Number(event.target.value) as 1 | 2 } })}><option value={1}>1 人</option><option value={2}>2 人（不同审核人）</option></select></label><div className="grid gap-2 text-[11px] text-ink-2"><label className="flex items-center gap-2"><input type="checkbox" checked={form.approvalPolicy.preventSelfApproval} onChange={event => setForm({ ...form, approvalPolicy: { ...form.approvalPolicy, preventSelfApproval: event.target.checked } })} />禁止提交人审核自己的变更</label><label className="flex items-center gap-2"><input type="checkbox" checked={form.approvalPolicy.requireComment} onChange={event => setForm({ ...form, approvalPolicy: { ...form.approvalPolicy, requireComment: event.target.checked } })} />批准时必须填写意见</label></div><div><span className="text-[11px] font-semibold text-ink-2">允许审核角色</span><div className="mt-2 flex gap-4 text-[11px] text-ink-2">{(['reviewer', 'admin'] as const).map(role => <label key={role} className="flex items-center gap-2"><input type="checkbox" checked={form.approvalPolicy.allowedReviewerRoles.includes(role)} onChange={event => setForm({ ...form, approvalPolicy: { ...form.approvalPolicy, allowedReviewerRoles: event.target.checked ? [...form.approvalPolicy.allowedReviewerRoles, role] : form.approvalPolicy.allowedReviewerRoles.filter(item => item !== role) } })} />{role}</label>)}</div></div></section><RulesetVariablesEditor variables={form.variables} onChange={variables => setForm({ ...form, variables })} title="Rule Project 变量" description="项目级规则执行上下文变量；不进入 BOM，不由 facts 传入。所有规则编辑器和规则集共享此定义。" emptyText="暂无项目变量。可在这里添加，之后所有规则编辑器都能选择这些变量。" className="rounded-[3px] border border-[#b8c9f5] bg-[#f5f8ff] p-3" />{error && <p className="text-[11px] text-[#c62828]">{error}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setSettings(false)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-50" disabled={updateProject.isPending || form.approvalPolicy.allowedReviewerRoles.length === 0} onClick={() => void saveSettings()}>{updateProject.isPending ? '保存中...' : '保存设置'}</button></footer></Modal>}
    </div>
  )
}
