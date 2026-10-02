import { AlertTriangle, Copy, FileText, LockKeyhole, MoveRight, Pencil, Plus, Search, Table2, TextCursorInput, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Asset, AssetStatus } from '../../types'

const statusMeta: Record<AssetStatus, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-[#fff3e0] text-env-staging' },
  'in-review': { label: '审核中', className: 'bg-brand-primary-l text-brand-primary' },
  rejected: { label: '已驳回', className: 'bg-[#fff1f1] text-[#c62828]' },
  published: { label: '已发布', className: 'bg-[#e8f5e9] text-env-production' },
  archived: { label: '已归档', className: 'bg-[#eeeeee] text-ink-3' },
}

interface AssetListProps {
  title: string
  assets: Asset[]
  selectedId: string | null
  onSelect: (assetId: string) => void
  editable?: boolean
  onCreate?: () => void
  onDuplicate?: (asset: Asset) => void
  onRename?: (asset: Asset) => void
  onMove?: (asset: Asset) => void
  onDelete?: (asset: Asset) => void
}

export default function AssetList({ title, assets, selectedId, onSelect, editable, onCreate, onDuplicate, onRename, onMove, onDelete }: AssetListProps) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [status, setStatus] = useState('all')
  const [menu, setMenu] = useState<{ asset: Asset; x: number; y: number } | null>(null)
  const filtered = useMemo(() => assets.filter(asset => (!search.trim() || asset.name.toLowerCase().includes(search.trim().toLowerCase())) && (type === 'all' || asset.type === type) && (status === 'all' || asset.status === status)), [assets, search, type, status])

  return (
    <section className="relative flex h-full w-[360px] shrink-0 flex-col border-r border-ink-border bg-white" aria-label="资产列表" onClick={() => setMenu(null)}>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-ink-border bg-[#fafafa] px-3 text-[11px] font-semibold text-ink-2"><span className="max-w-[150px] truncate">{title}</span>{editable && <button className="ml-auto inline-flex h-6 items-center gap-1 bg-brand-primary px-2 text-[10px] text-white" onClick={onCreate}><Plus size={12} />新建规则</button>}</div>
      <div className="grid grid-cols-[1fr_92px_76px] gap-1 border-b border-ink-border p-2"><label className="relative"><Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" /><input className="h-7 w-full border border-ink-border pl-7 pr-2 text-[11px] outline-none focus:border-brand-primary" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索规则" /></label><select className="h-7 border border-ink-border bg-white px-1 text-[10px]" value={type} onChange={event => setType(event.target.value)} aria-label="资产类型"><option value="all">所有类型</option><option value="rule">BAL 规则</option><option value="decision-table">决策表</option></select><select className="h-7 border border-ink-border bg-white px-1 text-[10px]" value={status} onChange={event => setStatus(event.target.value)} aria-label="资产状态"><option value="all">全部状态</option><option value="draft">草稿</option><option value="in-review">审核中</option><option value="rejected">已驳回</option><option value="published">已发布</option></select></div>
      <div className="min-h-0 flex-1 overflow-auto"><table className="w-full table-fixed border-collapse text-xs"><thead className="sticky top-0 bg-[#fafafa] text-left text-[11px] font-semibold text-ink-2"><tr className="border-b border-ink-border"><th className="w-[55%] px-[10px] py-1.5 font-semibold">名称</th><th className="w-[24%] px-2 py-1.5 font-semibold">修改者</th><th className="w-[21%] px-2 py-1.5 font-semibold">状态</th></tr></thead><tbody>{filtered.map(asset => {
        const Icon = asset.type === 'decision-table' ? Table2 : FileText
        return <tr key={asset.id} className={`cursor-pointer border-b border-[#e8e8e8] ${selectedId === asset.id ? 'bg-[#d6e6f7]' : 'hover:bg-[#f0f6fc]'}`} onClick={() => onSelect(asset.id)} onContextMenu={event => { if (!editable) return; event.preventDefault(); setMenu({ asset, x: event.clientX, y: event.clientY }) }}><td className="px-[10px] py-1.5" title={asset.name}><span className={`flex items-center gap-1.5 truncate ${asset.bomInvalid ? 'text-[#c62828]' : 'text-brand-primary'}`}>{asset.bomInvalid ? <AlertTriangle size={13} className="shrink-0" aria-label="BOM 引用失效" /> : <span className={`inline-flex size-5 shrink-0 items-center justify-center ${asset.type === 'decision-table' ? 'bg-[#ede9fe] text-[#7c3aed]' : 'bg-brand-primary-l text-brand-primary'}`}><Icon size={12} /></span>}<span className="truncate" title={asset.bomIssue || asset.name}>{asset.name}</span>{asset.status === 'in-review' && <LockKeyhole size={11} className="shrink-0 text-brand-primary" aria-label="审核中只读" />}</span><span className="ml-[26px] block text-[9px] text-ink-3">{asset.type === 'decision-table' ? '决策表' : 'BAL 规则'} · v{asset.version}</span></td><td className="truncate px-2 py-1.5 text-[10px] text-ink-3">{asset.modifiedBy}</td><td className="px-2 py-1.5"><span className={`inline-flex rounded-[2px] px-1.5 py-px text-[9px] ${statusMeta[asset.status].className}`}>{statusMeta[asset.status].label}</span></td></tr>
      })}</tbody></table>{filtered.length === 0 && <p className="p-5 text-center text-[11px] text-ink-3">没有匹配的资产</p>}</div>
      {menu && <div className="fixed z-50 min-w-40 border border-ink-border bg-white py-1 text-[11px] shadow-menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { onSelect(menu.asset.id); setMenu(null) }}>{menu.asset.status === 'in-review' ? <LockKeyhole size={12} /> : <Pencil size={12} />}{menu.asset.status === 'in-review' ? '查看（审核中）' : '编辑'}</button><button disabled={menu.asset.status === 'in-review'} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg disabled:text-ink-3 disabled:hover:bg-white" onClick={() => { onRename?.(menu.asset); setMenu(null) }}><TextCursorInput size={12} />重命名</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { onDuplicate?.(menu.asset); setMenu(null) }}><Copy size={12} />复制</button><button disabled={menu.asset.status === 'in-review'} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg disabled:text-ink-3 disabled:hover:bg-white" onClick={() => { onMove?.(menu.asset); setMenu(null) }}><MoveRight size={12} />移动到...</button><button disabled={menu.asset.status === 'in-review'} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[#c62828] hover:bg-[#fff1f1] disabled:text-ink-3 disabled:hover:bg-white" onClick={() => { onDelete?.(menu.asset); setMenu(null) }}><Trash2 size={12} />删除</button></div>}
    </section>
  )
}
