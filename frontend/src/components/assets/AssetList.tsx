import { AlertTriangle, ArchiveRestore, Ban, Calculator, Copy, Download, FileText, GitFork, Import, LockKeyhole, MoveRight, Pencil, Plus, Search, Table2, Tags, TextCursorInput, Wand2, Trash2, UserRoundCog } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Asset, AssetStatus } from '../../types'

const statusMeta: Record<AssetStatus, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-[#fff3e0] text-env-staging' },
  'in-review': { label: '审核中', className: 'bg-brand-primary-l text-brand-primary' },
  rejected: { label: '已驳回', className: 'bg-[#fff1f1] text-[#c62828]' },
  published: { label: '已发布', className: 'bg-[#e8f5e9] text-env-production' },
  deprecated: { label: '已废弃', className: 'bg-[#fff3e0] text-[#8a5a00]' },
  archived: { label: '已归档', className: 'bg-[#eeeeee] text-ink-3' },
}

interface AssetListProps {
  title: string
  assets: Asset[]
  selectedId: string | null
  onSelect: (assetId: string) => void
  editable?: boolean
  onCreate?: () => void
  onImport?: () => void
  onExport?: () => void
  exportBusy?: boolean
  onDuplicate?: (asset: Asset) => void
  onRename?: (asset: Asset) => void
  onMove?: (asset: Asset) => void
  onDelete?: (asset: Asset) => void
  onDeprecate?: (asset: Asset) => void
  onReactivate?: (asset: Asset) => void
  selectionKey?: number
  onBatchMetadata?: (assets: Asset[]) => void
  onBatchMove?: (assets: Asset[]) => void
  onBatchOwner?: (assets: Asset[]) => void
  onBatchArchive?: (assets: Asset[]) => void
}

export default function AssetList({ title, assets, selectedId, onSelect, editable, onCreate, onImport, onExport, exportBusy = false, onDuplicate, onRename, onMove, onDelete, onDeprecate, onReactivate, selectionKey, onBatchMetadata, onBatchMove, onBatchOwner, onBatchArchive }: AssetListProps) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [status, setStatus] = useState('active')
  const [menu, setMenu] = useState<{ asset: Asset; x: number; y: number } | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const filtered = useMemo(() => assets.filter(asset => (!search.trim() || [asset.name, ...(asset.tags || [])].some(value => value.toLowerCase().includes(search.trim().toLowerCase()))) && (type === 'all' || asset.type === type) && (status === 'active' ? asset.status !== 'archived' : asset.status === status)), [assets, search, type, status])
  const selected = assets.filter(asset => checked.has(asset.id))
  const selectable = filtered.filter(asset => !['in-review', 'archived'].includes(asset.status))
  useEffect(() => setChecked(new Set()), [selectionKey])
  useEffect(() => setChecked(current => new Set([...current].filter(id => assets.some(asset => asset.id === id)))), [assets])
  const toggleAll = () => setChecked(current => selectable.every(asset => current.has(asset.id)) ? new Set() : new Set(selectable.map(asset => asset.id)))

  return (
    <section className="relative flex h-full w-[360px] shrink-0 flex-col border-r border-ink-border bg-white" aria-label="资产列表" onClick={() => setMenu(null)}>
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-ink-border bg-[#fafafa] px-3 text-[11px] font-semibold text-ink-2"><span className="max-w-[105px] truncate">{title}</span>{editable && <><button type="button" className="ml-auto inline-flex h-6 items-center gap-1 border border-ink-border bg-white px-2 text-[10px] text-ink-2" onClick={onImport}><Import size={12} />导入</button><button type="button" className="inline-flex h-6 items-center gap-1 border border-ink-border bg-white px-2 text-[10px] text-ink-2 disabled:cursor-wait disabled:opacity-50" disabled={exportBusy} onClick={onExport}><Download size={12} />{exportBusy ? '导出中…' : '导出'}</button><button type="button" className="inline-flex h-6 items-center gap-1 bg-brand-primary px-2 text-[10px] text-white" onClick={onCreate}><Plus size={12} />新建</button></>}</div>
      <div className="grid grid-cols-[1fr_92px_76px] gap-1 border-b border-ink-border p-2"><label className="relative"><Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" /><input className="h-7 w-full border border-ink-border pl-7 pr-2 text-[11px] outline-none focus:border-brand-primary" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称或标签" /></label><select className="h-7 border border-ink-border bg-white px-1 text-[10px]" value={type} onChange={event => setType(event.target.value)} aria-label="资产类型"><option value="all">所有类型</option><option value="rule">BAL 规则</option><option value="decision-table">决策表</option><option value="decision-tree">决策树</option><option value="scorecard">计分卡</option><option value="rule-template">规则模板</option></select><select className="h-7 border border-ink-border bg-white px-1 text-[10px]" value={status} onChange={event => setStatus(event.target.value)} aria-label="资产状态"><option value="active">活动资产</option><option value="draft">草稿</option><option value="in-review">审核中</option><option value="rejected">已驳回</option><option value="published">已发布</option><option value="deprecated">已废弃</option><option value="archived">已归档</option></select></div>
      {editable && selected.length > 0 && <div className="flex h-9 items-center gap-1 border-b border-[#9bbcf7] bg-brand-primary-l px-2 text-[10px] text-brand-primary"><b className="mr-auto">已选 {selected.length} 项</b><button className="inline-flex h-6 items-center gap-1 border border-current bg-white px-1.5" onClick={() => onBatchMetadata?.(selected)}><Tags size={11} />标签/有效期</button><button className="inline-flex h-6 items-center gap-1 border border-current bg-white px-1.5" onClick={() => onBatchOwner?.(selected)}><UserRoundCog size={11} />负责人</button><button className="inline-flex h-6 items-center gap-1 border border-current bg-white px-1.5" onClick={() => onBatchMove?.(selected)}><MoveRight size={11} />移动</button><button className="inline-flex h-6 items-center gap-1 border border-[#c62828] bg-white px-1.5 text-[#c62828]" onClick={() => onBatchArchive?.(selected)}><Trash2 size={11} />归档</button></div>}
      <div className="min-h-0 flex-1 overflow-auto"><table className="w-full table-fixed border-collapse text-xs"><thead className="sticky top-0 bg-[#fafafa] text-left text-[11px] font-semibold text-ink-2"><tr className="border-b border-ink-border"><th className="w-8 px-2 py-1.5"><input type="checkbox" aria-label="全选可操作资产" checked={selectable.length > 0 && selectable.every(asset => checked.has(asset.id))} onChange={toggleAll} /></th><th className="w-[48%] px-1 py-1.5 font-semibold">名称</th><th className="w-[25%] px-2 py-1.5 font-semibold">负责人</th><th className="w-[19%] px-2 py-1.5 font-semibold">状态</th></tr></thead><tbody>{filtered.map(asset => {
        const Icon = asset.type === 'decision-table' ? Table2 : asset.type === 'decision-tree' ? GitFork : asset.type === 'scorecard' ? Calculator : asset.type === 'rule-template' ? Wand2 : FileText
        const canCheck = !['in-review', 'archived'].includes(asset.status)
        return <tr key={asset.id} className={`cursor-pointer border-b border-[#e8e8e8] ${selectedId === asset.id ? 'bg-[#d6e6f7]' : 'hover:bg-[#f0f6fc]'}`} onClick={() => onSelect(asset.id)} onContextMenu={event => { if (!editable) return; event.preventDefault(); setMenu({ asset, x: event.clientX, y: event.clientY }) }}><td className="px-2 py-1.5"><input type="checkbox" aria-label={`选择 ${asset.name}`} disabled={!canCheck} checked={checked.has(asset.id)} onClick={event => event.stopPropagation()} onChange={event => setChecked(current => { const next = new Set(current); if (event.target.checked) next.add(asset.id); else next.delete(asset.id); return next })} /></td><td className="px-1 py-1.5" title={asset.name}><span className={`flex items-center gap-1.5 truncate ${asset.bomInvalid ? 'text-[#c62828]' : 'text-brand-primary'}`}>{asset.bomInvalid ? <AlertTriangle size={13} className="shrink-0" aria-label="BOM 引用失效" /> : <span className={`inline-flex size-5 shrink-0 items-center justify-center ${asset.type === 'decision-table' ? 'bg-[#ede9fe] text-[#7c3aed]' : asset.type === 'decision-tree' ? 'bg-[#e8f5e9] text-[#287a3d]' : asset.type === 'scorecard' ? 'bg-[#fff3e0] text-[#a15c00]' : asset.type === 'rule-template' ? 'bg-[#f3e5f5] text-[#7b1fa2]' : 'bg-brand-primary-l text-brand-primary'}`}><Icon size={12} /></span>}<span className="truncate" title={asset.bomIssue || asset.name}>{asset.name}</span>{asset.status === 'in-review' && <LockKeyhole size={11} className="shrink-0 text-brand-primary" aria-label="审核中只读" />}</span><span className="ml-[26px] block truncate text-[9px] text-ink-3">{asset.type === 'decision-table' ? '决策表' : asset.type === 'decision-tree' ? '决策树' : asset.type === 'scorecard' ? '计分卡' : asset.type === 'rule-template' ? '规则模板' : 'BAL 规则'} · v{asset.version}{asset.tags?.length ? ` · ${asset.tags.join(' / ')}` : ''}</span></td><td className="truncate px-2 py-1.5 text-[10px] text-ink-3" title={asset.owner?.name || '首次编辑时认领'}>{asset.owner?.name || '未认领'}</td><td className="px-2 py-1.5"><span className={`inline-flex rounded-[2px] px-1.5 py-px text-[9px] ${statusMeta[asset.status].className}`}>{statusMeta[asset.status].label}</span>{asset.effectiveStatus && asset.effectiveStatus !== 'effective' && <span className={`mt-0.5 block text-[9px] ${asset.effectiveStatus === 'expired' ? 'text-[#c62828]' : 'text-[#8a5a00]'}`}>{asset.effectiveStatus === 'expired' ? '已过期' : '待生效'}</span>}</td></tr>
      })}</tbody></table>{filtered.length === 0 && <p className="p-5 text-center text-[11px] text-ink-3">没有匹配的资产</p>}</div>
      {menu && <div className="fixed z-50 min-w-40 border border-ink-border bg-white py-1 text-[11px] shadow-menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { onSelect(menu.asset.id); setMenu(null) }}>{['in-review', 'deprecated', 'archived'].includes(menu.asset.status) ? <LockKeyhole size={12} /> : <Pencil size={12} />}{['in-review', 'deprecated', 'archived'].includes(menu.asset.status) ? '查看（只读）' : '编辑'}</button><button disabled={['in-review', 'deprecated', 'archived'].includes(menu.asset.status)} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg disabled:text-ink-3 disabled:hover:bg-white" onClick={() => { onRename?.(menu.asset); setMenu(null) }}><TextCursorInput size={12} />重命名</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { onDuplicate?.(menu.asset); setMenu(null) }}><Copy size={12} />复制</button><button disabled={['in-review', 'deprecated', 'archived'].includes(menu.asset.status)} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg disabled:text-ink-3 disabled:hover:bg-white" onClick={() => { onMove?.(menu.asset); setMenu(null) }}><MoveRight size={12} />移动到...</button>{menu.asset.status === 'deprecated' ? <button className="flex h-8 w-full items-center gap-2 px-3 text-left text-brand-primary hover:bg-brand-primary-l" onClick={() => { onReactivate?.(menu.asset); setMenu(null) }}><ArchiveRestore size={12} />恢复为草稿</button> : menu.asset.status !== 'archived' && <button disabled={menu.asset.status === 'in-review'} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[#8a5a00] hover:bg-[#fff8e1] disabled:text-ink-3 disabled:hover:bg-white" onClick={() => { onDeprecate?.(menu.asset); setMenu(null) }}><Ban size={12} />标记为废弃</button>}<button disabled={menu.asset.status === 'in-review' || menu.asset.status === 'archived'} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[#c62828] hover:bg-[#fff1f1] disabled:text-ink-3 disabled:hover:bg-white" onClick={() => { onDelete?.(menu.asset); setMenu(null) }}><Trash2 size={12} />归档</button></div>}
    </section>
  )
}
