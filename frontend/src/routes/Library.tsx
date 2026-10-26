import { AlertTriangle, Archive, BriefcaseBusiness, Plus, RefreshCw, Server, ShieldCheck, Trash2, Warehouse } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useArchiveProject, useCreateProject, useDeleteProject, useProjects } from '../api/projects'
import Modal from '../components/Modal'
import type { Project } from '../types'

function ProjectIcon({ icon }: { icon: Project['icon'] }) {
  const Icon = icon === 'loan' ? BriefcaseBusiness : icon === 'warehouse' ? Warehouse : ShieldCheck
  return <Icon size={17} strokeWidth={1.8} />
}

function ProjectCard({ project, onArchive, onDelete }: { project: Project; onArchive: () => void; onDelete: () => void }) {
  const navigate = useNavigate()
  return (
    <article className={`relative min-h-[172px] rounded-[3px] border border-ink-border bg-white transition hover:border-brand-primary hover:shadow-card ${project.archived ? 'opacity-60 grayscale' : ''}`}>
      <button className="h-full w-full p-[14px] text-left" onClick={() => navigate(`/projects/${project.id}/${project.engine === 'cep' ? 'event-streams' : 'assets'}`)} disabled={project.archived}>
        <span className="mb-2 flex size-8 items-center justify-center rounded-[3px] bg-brand-primary-l text-[#1d365d]"><ProjectIcon icon={project.icon} /></span>
        <span className="flex items-center justify-between gap-2 pr-14"><h2 className="mb-1 min-w-0 truncate text-[13px] font-medium">{project.name}</h2><span className={`shrink-0 rounded-[2px] px-1.5 py-px text-[9px] ${project.source === 'server' ? 'bg-[#e8f5e9] text-env-production' : 'bg-[#eef1f4] text-ink-3'}`}>{project.archived ? '已归档' : project.source === 'server' ? '真实服务' : '演示'} · {project.engine === 'cep' ? 'CEP' : 'Rules'}</span></span>
        <p className="truncate text-[11px] text-ink-3">{project.description || `${project.packageCount} 个规则包 · ${project.assetCount} 个资产`}</p>
        <div className="mt-[10px] flex gap-[22px] border-t border-[#e8e8e8] pt-[10px]"><span className="text-[10px] text-ink-3"><b className="block text-sm font-medium text-ink-1">{project.version}</b>当前</span><span className="text-[10px] text-ink-3"><b className="block text-sm font-medium text-ink-1">{project.packageCount}</b>包</span><span className="text-[10px] text-ink-3"><b className="block text-sm font-medium text-ink-1">{project.environmentCount}</b>环境</span></div>
      </button>
      {project.source === 'server' && project.id !== 'default' && <div className="absolute right-2 top-2 flex gap-1"><button className="inline-flex size-7 items-center justify-center text-ink-3 hover:bg-ink-bg hover:text-brand-primary" onClick={onArchive} title="归档项目"><Archive size={14} /></button>{project.archived && <button className="inline-flex size-7 items-center justify-center text-ink-3 hover:bg-[#fff1f1] hover:text-[#c62828]" onClick={onDelete} title="删除项目"><Trash2 size={14} /></button>}</div>}
    </article>
  )
}

export default function Library() {
  const navigate = useNavigate()
  const [showArchived, setShowArchived] = useState(false)
  const { data: projects = [], isPending, isFetching, error: projectsError, refetch } = useProjects(showArchived)
  const createProject = useCreateProject()
  const archiveProject = useArchiveProject()
  const deleteProject = useDeleteProject()
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [form, setForm] = useState({ name: '', description: '', icon: 'shield' as Project['icon'], engine: 'rules' as Project['engine'], bomTemplate: 'risk' as 'blank' | 'loan' | 'risk' | 'copy', copyProjectId: '' })
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setError(null)
    try {
      const project = await createProject.mutateAsync({ ...form, copyProjectId: form.bomTemplate === 'copy' ? form.copyProjectId : undefined })
      setCreating(false)
      navigate(`/projects/${project.id}/${project.engine === 'cep' ? 'event-streams' : 'assets'}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败') }
  }

  return (
    <div className="h-full overflow-auto px-6 py-5">
      <div className="flex items-center justify-between gap-4"><div><h1 className="text-lg font-medium">决策服务库</h1><p className="mt-1 text-[11px] text-ink-3">管理规则项目、版本与部署环境</p></div><div className="flex items-center gap-3"><label className="flex items-center gap-1.5 text-[11px] text-ink-2"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示已归档</label><span className="flex items-center gap-1 text-[11px] text-ink-3"><Server size={14} />2 个服务在线</span><button className="primary-button" onClick={() => { setCreating(true); setError(null) }}><Plus size={14} />新建决策服务</button></div></div>
      {projectsError ? (
        <section className="mt-[14px] flex min-h-44 items-center justify-center rounded-[4px] border border-[#f0c3c3] bg-[#fff8f8] px-6 py-8 text-center" role="alert">
          <div>
            <AlertTriangle size={24} className="mx-auto text-[#c62828]" />
            <h2 className="mt-3 text-sm font-semibold text-ink-1">决策服务加载失败</h2>
            <p className="mt-1 text-[11px] text-ink-3">无法连接 Team Server，请确认本地服务已启动后重试。</p>
            <p className="mt-1 max-w-[520px] truncate font-mono text-[9px] text-[#a31515]" title={projectsError instanceof Error ? projectsError.message : '请求失败'}>{projectsError instanceof Error ? projectsError.message : '请求失败'}</p>
            <button type="button" className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-brand-primary bg-white px-3 text-[11px] font-medium text-brand-primary hover:bg-brand-primary-l disabled:opacity-50" disabled={isFetching} onClick={() => void refetch()}><RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />{isFetching ? '正在重试' : '重新加载'}</button>
          </div>
        </section>
      ) : (
        <div className="mt-[14px] grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[14px]">
          {projects.map(project => <ProjectCard key={project.id} project={project} onArchive={() => void archiveProject.mutateAsync(project.id)} onDelete={() => { setDeleteTarget(project); setDeleteConfirm('') }} />)}
          {!isPending && projects.length === 0 && <section className="col-span-full flex min-h-44 items-center justify-center rounded-[4px] border border-dashed border-ink-border bg-white px-6 py-8 text-center"><div><ShieldCheck size={24} className="mx-auto text-ink-3" /><h2 className="mt-3 text-sm font-semibold text-ink-2">还没有决策服务</h2><p className="mt-1 text-[11px] text-ink-3">创建第一个服务，开始编排规则与发布版本。</p><button type="button" className="primary-button mt-4" onClick={() => { setCreating(true); setError(null) }}><Plus size={14} />新建决策服务</button></div></section>}
        </div>
      )}

      {creating && <Modal title="新建决策服务" onClose={() => setCreating(false)} width="max-w-xl"><div className="grid grid-cols-2 gap-4 p-4"><label className="col-span-2 text-[11px] font-semibold text-ink-2">项目名称<input className="control-input mt-1" autoFocus value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="小微企业贷款审批" /></label><label className="col-span-2 text-[11px] font-semibold text-ink-2">项目描述<textarea className="mt-1 min-h-20 w-full border border-ink-border p-2 text-xs outline-none focus:border-brand-primary" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label><fieldset><legend className="mb-1 text-[11px] font-semibold text-ink-2">图标</legend><div className="flex gap-2">{(['loan', 'warehouse', 'shield'] as const).map(icon => <button key={icon} type="button" className={`inline-flex size-9 items-center justify-center border ${form.icon === icon ? 'border-brand-primary bg-brand-primary-l text-brand-primary' : 'border-ink-border'}`} onClick={() => setForm({ ...form, icon })} title={icon}><ProjectIcon icon={icon} /></button>)}</div></fieldset><label className="text-[11px] font-semibold text-ink-2">引擎类型<select className="control-input mt-1" value={form.engine} onChange={event => setForm({ ...form, engine: event.target.value as Project['engine'] })}><option value="rules">规则引擎（Drools）</option><option value="cep">事件引擎（CEP，后续开放资产链路）</option></select></label><label className="text-[11px] font-semibold text-ink-2">基线 BOM<select className="control-input mt-1" value={form.bomTemplate} onChange={event => setForm({ ...form, bomTemplate: event.target.value as typeof form.bomTemplate })}><option value="blank">空白起步</option><option value="loan">贷款审批模板</option><option value="risk">风控模板</option><option value="copy">从现有项目复制</option></select></label>{form.bomTemplate === 'copy' && <label className="col-span-2 text-[11px] font-semibold text-ink-2">复制来源<select className="control-input mt-1" value={form.copyProjectId} onChange={event => setForm({ ...form, copyProjectId: event.target.value })}><option value="">请选择项目</option>{projects.filter(project => project.source === 'server' && !project.archived).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}{error && <p className="col-span-2 text-[11px] text-[#c62828]">{error}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setCreating(false)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={!form.name.trim() || createProject.isPending || (form.bomTemplate === 'copy' && !form.copyProjectId)} onClick={() => void create()}>{createProject.isPending ? '创建中...' : '创建并进入'}</button></footer></Modal>}
      {deleteTarget && <Modal title="永久删除项目" onClose={() => setDeleteTarget(null)}><div className="space-y-3 p-4 text-xs"><p className="text-[#a31515]">将永久删除 {deleteTarget.packageCount} 个规则包、{deleteTarget.assetCount} 个资产及关联 Release。此操作不可恢复。</p><p>第二次确认：请输入项目名称 <b>{deleteTarget.name}</b></p><input className="control-input" value={deleteConfirm} onChange={event => setDeleteConfirm(event.target.value)} /></div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDeleteTarget(null)}>取消</button><button className="h-8 bg-[#c62828] px-3 text-[11px] text-white disabled:opacity-40" disabled={deleteConfirm !== deleteTarget.name || deleteProject.isPending} onClick={() => void deleteProject.mutateAsync(deleteTarget.id).then(() => setDeleteTarget(null))}>永久删除</button></footer></Modal>}
    </div>
  )
}
