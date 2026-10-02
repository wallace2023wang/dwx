import { FileText, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router-dom'
import { useProject, useUpdateProject } from '../../api/projects'
import Modal from '../../components/Modal'
import ProjectTabs from '../../components/layout/ProjectTabs'
import { useProjectStore } from '../../store/project'

export default function ProjectShell() {
  const { projectId } = useParams()
  const location = useLocation()
  const reportMode = location.pathname.endsWith('/report')
  const { data: project, isPending } = useProject(projectId)
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject)
  const updateProject = useUpdateProject(projectId)
  const [settings, setSettings] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', icon: 'shield' as 'loan' | 'warehouse' | 'shield', defaultEnvironment: 'local' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (projectId) setCurrentProject(projectId)
  }, [projectId, setCurrentProject])

  if (isPending) return <div className="p-6 text-xs text-ink-3">正在加载项目...</div>
  if (!project) return <Navigate to="/library" replace />

  const openSettings = () => {
    setForm({ name: project.name, description: project.description, icon: project.icon, defaultEnvironment: project.defaultEnvironment || 'local' })
    setError(null)
    setSettings(true)
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
      {settings && <Modal title="项目设置" onClose={() => setSettings(false)}><div className="space-y-4 p-4"><label className="block text-[11px] font-semibold text-ink-2">项目 ID<input className="control-input mt-1 bg-ink-bg font-mono" value={project.id} disabled /></label><label className="block text-[11px] font-semibold text-ink-2">名称<input className="control-input mt-1" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label className="block text-[11px] font-semibold text-ink-2">描述<textarea className="mt-1 min-h-20 w-full border border-ink-border p-2 text-xs outline-none focus:border-brand-primary" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><div className="grid grid-cols-2 gap-3"><label className="text-[11px] font-semibold text-ink-2">图标<select className="control-input mt-1" value={form.icon} onChange={event => setForm({ ...form, icon: event.target.value as typeof form.icon })}><option value="loan">贷款</option><option value="warehouse">仓储</option><option value="shield">风控</option></select></label><label className="text-[11px] font-semibold text-ink-2">默认环境<select className="control-input mt-1" value={form.defaultEnvironment} onChange={event => setForm({ ...form, defaultEnvironment: event.target.value })}><option value="local">local</option><option value="test">test</option><option value="staging">staging</option><option value="production">production</option></select></label></div>{error && <p className="text-[11px] text-[#c62828]">{error}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setSettings(false)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white" onClick={() => void updateProject.mutateAsync(form).then(() => setSettings(false)).catch(cause => setError(cause instanceof Error ? cause.message : '保存失败'))}>保存设置</button></footer></Modal>}
    </div>
  )
}
