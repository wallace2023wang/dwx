import {
  AlertTriangle,
  Braces,
  FileText,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  Table2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { type ExploreItem, type ExploreKind, useExploreCatalog } from '../api/explore'

const kindMeta: Record<ExploreKind, { label: string; icon: typeof FileText; className: string }> = {
  rule: { label: 'BAL 规则', icon: FileText, className: 'bg-brand-primary-l text-brand-primary' },
  'decision-table': { label: '决策表', icon: Table2, className: 'bg-[#ede9fe] text-[#6d28d9]' },
  flow: { label: '规则流', icon: GitBranch, className: 'bg-[#e8f5e9] text-env-production' },
  'event-stream': { label: '事件流', icon: GitBranch, className: 'bg-[#e8f5e9] text-env-production' },
  bom: { label: 'BOM 字段', icon: Braces, className: 'bg-[#fff3e0] text-[#a15c00]' },
}

const statusMeta: Record<ExploreItem['status'], { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-[#fff3e0] text-env-staging' },
  'in-review': { label: '审核中', className: 'bg-brand-primary-l text-brand-primary' },
  rejected: { label: '已驳回', className: 'bg-[#fff1f1] text-[#c62828]' },
  published: { label: '已发布', className: 'bg-[#e8f5e9] text-env-production' },
  deprecated: { label: '已废弃', className: 'bg-[#fff3e0] text-[#8a5a00]' },
  archived: { label: '已归档', className: 'bg-[#eeeeee] text-ink-3' },
  model: { label: '模型字段', className: 'bg-[#eef1f4] text-ink-2' },
}

function includesQuery(item: ExploreItem, query: string) {
  const terms = query.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const searchable = item.searchText.toLocaleLowerCase('zh-CN')
  return terms.every(term => searchable.includes(term))
}

export default function Explore() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const appliedQuery = searchParams.get('q') || ''
  const kind = searchParams.get('type') || 'all'
  const status = searchParams.get('status') || 'all'
  const projectId = searchParams.get('project') || 'all'
  const [query, setQuery] = useState(appliedQuery)
  const catalog = useExploreCatalog()

  useEffect(() => setQuery(appliedQuery), [appliedQuery])

  const items = catalog.data?.items ?? []
  const warnings = catalog.data?.warnings ?? []
  const projects = useMemo(() => [...new Map(items.map(item => [item.projectId, {
    id: item.projectId,
    name: item.projectName,
    source: item.projectSource,
  }])).values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')), [items])
  const filtered = useMemo(() => items.filter(item =>
    includesQuery(item, appliedQuery)
    && (kind === 'all' || item.kind === kind)
    && (status === 'all' || item.status === status)
    && (projectId === 'all' || item.projectId === projectId),
  ).sort((left, right) => left.projectName.localeCompare(right.projectName, 'zh-CN') || left.name.localeCompare(right.name, 'zh-CN')), [appliedQuery, items, kind, projectId, status])

  const assets = items.filter(item => item.kind !== 'bom')
  const published = assets.filter(item => item.status === 'published').length
  const attention = assets.filter(item => item.bomInvalid || item.status === 'rejected' || item.status === 'in-review').length
  const updateParam = (key: string, value: string) => setSearchParams(current => {
    const next = new URLSearchParams(current)
    if (!value || value === 'all') next.delete(key)
    else next.set(key, value)
    return next
  }, { replace: true })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    updateParam('q', query.trim())
  }
  const clear = () => {
    setQuery('')
    setSearchParams({}, { replace: true })
  }

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
      <div className="mx-auto max-w-[1500px]">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-base font-medium">浏览与治理</h1>
            <p className="mt-0.5 text-[11px] text-ink-3">跨项目资产目录</p>
          </div>
          <button type="button" className="inline-flex size-8 items-center justify-center border border-ink-border bg-white text-ink-2 hover:border-brand-primary hover:text-brand-primary disabled:opacity-50" title="刷新目录" aria-label="刷新目录" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>
            <RefreshCw size={14} className={catalog.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>

        <section className="border border-ink-border bg-white" aria-label="全局资产搜索">
          <form className="flex items-center gap-2 border-b border-ink-border p-3 max-sm:flex-wrap" onSubmit={submit}>
            <label className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" size={15} />
              <input className="control-input pl-9 pr-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="规则名 / 业务术语 / BOM 字段" aria-label="搜索资产" />
              {query && <button type="button" className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center text-ink-3 hover:text-ink-1" title="清空搜索词" aria-label="清空搜索词" onClick={() => setQuery('')}><X size={13} /></button>}
            </label>
            <button className="primary-button h-9 px-5" type="submit"><Search size={14} />搜索</button>
          </form>
          <div className="grid grid-cols-[minmax(150px,1.3fr)_minmax(130px,1fr)_minmax(130px,1fr)_auto] gap-2 p-3 max-md:grid-cols-2 max-sm:grid-cols-1">
            <select className="control-input" aria-label="筛选项目" value={projectId} onChange={event => updateParam('project', event.target.value)}>
              <option value="all">全部项目</option>
              {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <select className="control-input" aria-label="筛选资产类型" value={kind} onChange={event => updateParam('type', event.target.value)}>
              <option value="all">全部类型</option>
              <option value="rule">BAL 规则</option>
              <option value="decision-table">决策表</option>
              <option value="flow">规则流</option>
              <option value="event-stream">事件流</option>
              <option value="bom">BOM 字段</option>
            </select>
            <select className="control-input" aria-label="筛选资产状态" value={status} onChange={event => updateParam('status', event.target.value)}>
              <option value="all">全部状态</option>
              <option value="draft">草稿</option>
              <option value="in-review">审核中</option>
              <option value="rejected">已驳回</option>
              <option value="published">已发布</option>
              <option value="model">模型字段</option>
            </select>
            <button type="button" className="inline-flex h-9 items-center justify-center gap-1 border border-ink-border bg-white px-3 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-40" disabled={!appliedQuery && kind === 'all' && status === 'all' && projectId === 'all'} onClick={clear}><X size={13} />清除筛选</button>
          </div>
        </section>

        {warnings.length > 0 && <div className="mt-3 flex items-start gap-2 border border-[#f3c65f] bg-[#fff8e1] px-3 py-2 text-[11px] text-[#734d00]" role="status"><AlertTriangle size={14} className="mt-px shrink-0" /><span>部分项目读取失败：{warnings.map(warning => `${warning.projectName}（${warning.message}）`).join('；')}</span></div>}

        <section className="mt-3 grid grid-cols-4 border border-ink-border bg-white max-md:grid-cols-2" aria-label="资产目录概览">
          {[
            { label: '项目', value: projects.length, tone: 'text-ink-1' },
            { label: '决策资产', value: assets.length, tone: 'text-brand-primary' },
            { label: '已发布', value: published, tone: 'text-env-production' },
            { label: '需要关注', value: attention, tone: attention ? 'text-[#c62828]' : 'text-ink-1' },
          ].map(metric => <div key={metric.label} className="border-r border-ink-border px-4 py-3 last:border-r-0 max-md:border-b max-md:[&:nth-child(2)]:border-r-0 max-md:[&:nth-child(n+3)]:border-b-0"><span className="text-[10px] text-ink-3">{metric.label}</span><b className={`mt-0.5 block font-mono text-lg font-medium ${metric.tone}`}>{metric.value}</b></div>)}
        </section>

        <section className="mt-3 overflow-hidden border border-ink-border bg-white" aria-label="搜索结果">
          <header className="flex min-h-10 items-center justify-between gap-3 border-b border-ink-border bg-[#fafafa] px-3">
            <h2 className="text-xs font-semibold">资产目录</h2>
            <span className="text-[10px] text-ink-3">{catalog.isPending ? '正在索引...' : `${filtered.length} / ${items.length} 项`}</span>
          </header>
          {catalog.isPending ? <div className="flex h-48 items-center justify-center gap-2 text-xs text-ink-3"><LoaderCircle size={15} className="animate-spin" />正在读取项目资产...</div>
            : catalog.isError ? <div className="flex h-48 flex-col items-center justify-center gap-3 text-xs text-[#c62828]"><AlertTriangle size={20} /><span>{catalog.error.message}</span><button className="border border-ink-border bg-white px-3 py-1.5 text-ink-1" onClick={() => void catalog.refetch()}>重新加载</button></div>
              : filtered.length === 0 ? <div className="flex h-48 flex-col items-center justify-center gap-2 text-xs text-ink-3"><Search size={20} /><span>没有匹配的资产或业务术语</span>{(appliedQuery || kind !== 'all' || status !== 'all' || projectId !== 'all') && <button className="text-brand-primary hover:underline" onClick={clear}>查看全部资产</button>}</div>
                : <div className="overflow-x-auto"><table className="w-full min-w-[940px] table-fixed border-collapse text-left text-xs"><thead className="bg-[#fafafa] text-[10px] text-ink-2"><tr><th className="w-[31%] border-b border-ink-border px-3 py-2 font-semibold">名称</th><th className="w-[19%] border-b border-ink-border px-3 py-2 font-semibold">项目</th><th className="w-[19%] border-b border-ink-border px-3 py-2 font-semibold">规则包 / 事实类型</th><th className="w-[11%] border-b border-ink-border px-3 py-2 font-semibold">状态</th><th className="w-[10%] border-b border-ink-border px-3 py-2 font-semibold">版本</th><th className="w-[10%] border-b border-ink-border px-3 py-2 font-semibold">修改者 / 引用</th></tr></thead><tbody>{filtered.map(item => {
                  const meta = kindMeta[item.kind]
                  const Icon = meta.icon
                  return <tr key={`${item.projectId}:${item.kind}:${item.id}`} tabIndex={0} className="cursor-pointer border-b border-[#e8e8e8] last:border-0 hover:bg-[#f0f6fc] focus:bg-[#f0f6fc] focus:outline-none" onClick={() => navigate(item.href)} onKeyDown={event => { if (event.key === 'Enter') navigate(item.href) }}><td className="px-3 py-2"><div className="flex min-w-0 items-center gap-2"><span className={`inline-flex size-6 shrink-0 items-center justify-center ${meta.className}`}><Icon size={13} /></span><span className="min-w-0"><span className="flex items-center gap-1.5"><b className="truncate font-medium text-brand-primary">{item.name}</b>{item.bomInvalid && <AlertTriangle size={12} className="shrink-0 text-[#c62828]" aria-label="BOM 引用失效" />}</span><span className="block truncate text-[10px] text-ink-3">{meta.label} · {item.detail}</span></span></div></td><td className="px-3 py-2"><span className="block truncate">{item.projectName}</span><span className="text-[9px] text-ink-3">服务端项目</span></td><td className="truncate px-3 py-2 font-mono text-[10px] text-ink-2">{item.packageName}</td><td className="px-3 py-2"><span className={`inline-flex rounded-[2px] px-1.5 py-px text-[9px] ${statusMeta[item.status].className}`}>{statusMeta[item.status].label}</span></td><td className="px-3 py-2 font-mono text-[10px] text-brand-primary">v{item.version}{item.dataType ? ` · ${item.dataType}` : ''}</td><td className="truncate px-3 py-2 text-[10px] text-ink-3">{item.kind === 'bom' ? `${item.references ?? 0} 处引用` : item.modifiedBy}</td></tr>
                })}</tbody></table></div>}
        </section>
      </div>
    </div>
  )
}
