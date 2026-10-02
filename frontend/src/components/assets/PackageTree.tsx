import { ChevronDown, Folder, FolderPlus, Layers3, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { PackageNode } from '../../types'

interface PackageTreeProps {
  packages: PackageNode[]
  selectedId: string | null
  onSelect: (packageId: string | null) => void
  editable?: boolean
  onCreate?: (parentId: string | null) => void
  onRename?: (entry: PackageNode) => void
  onDelete?: (entry: PackageNode) => void
}

export default function PackageTree({ packages, selectedId, onSelect, editable, onCreate, onRename, onDelete }: PackageTreeProps) {
  const activeCount = (entry: PackageNode) => entry.assets.filter(asset => asset.status !== 'archived').length
  const total = packages.reduce((count, entry) => count + activeCount(entry), 0)
  const [menu, setMenu] = useState<{ entry: PackageNode; x: number; y: number } | null>(null)

  return (
    <section className="relative flex h-full w-[260px] shrink-0 flex-col border-r border-ink-border bg-white" aria-label="规则包树" onClick={() => setMenu(null)}>
      <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-ink-border bg-[#fafafa] px-3 text-[11px] font-semibold text-ink-2"><span>决策资产</span><span className="font-normal text-ink-3">{total}</span>{editable && <button className="inline-flex size-6 items-center justify-center text-brand-primary hover:bg-brand-primary-l" onClick={event => { event.stopPropagation(); onCreate?.(null) }} title="新建包"><Plus size={13} /></button>}</div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        <button className={`flex h-[28px] w-full items-center gap-[5px] border-r-2 px-[10px] text-left text-xs ${selectedId === null ? 'border-brand-primary bg-[#d6e6f7]' : 'border-transparent hover:bg-[#eaf2fb]'}`} onClick={() => onSelect(null)}><ChevronDown size={11} className="text-ink-3" /><Layers3 size={14} className="text-ink-3" /><span>全部资产</span><span className="ml-auto text-[10px] text-ink-3">{total}</span></button>
        {packages.map(entry => {
          const depth = Math.min(entry.name.split('.').length - 1, 2)
          return <button key={entry.id} className={`group flex h-[28px] w-full items-center gap-[5px] border-r-2 pr-[8px] text-left text-xs ${selectedId === entry.id ? 'border-brand-primary bg-[#d6e6f7]' : 'border-transparent hover:bg-[#eaf2fb]'}`} style={{ paddingLeft: 26 + depth * 16 }} onClick={() => onSelect(entry.id)} onDoubleClick={() => editable && onRename?.(entry)} onContextMenu={event => { if (!editable) return; event.preventDefault(); setMenu({ entry, x: event.clientX, y: event.clientY }) }}><Folder size={14} className="shrink-0 text-ink-3" /><span className="min-w-0 truncate"><b className="font-medium">{entry.name.split('.').slice(-1)[0]}</b> {entry.label}</span><span className="ml-auto text-[10px] text-ink-3">{activeCount(entry)}</span>{editable && <MoreVertical size={12} className="opacity-0 group-hover:opacity-100" />}</button>
        })}
      </div>
      {editable && <button className="m-2 inline-flex h-8 items-center justify-center gap-1 border border-dashed border-brand-primary text-[11px] text-brand-primary hover:bg-brand-primary-l" onClick={() => onCreate?.(null)}><Plus size={13} />新建包</button>}
      {menu && <div className="fixed z-50 min-w-36 border border-ink-border bg-white py-1 text-[11px] shadow-menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { onCreate?.(menu.entry.name); setMenu(null) }} disabled={menu.entry.name.split('.').length >= 3}><FolderPlus size={12} />新建子包</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-ink-bg" onClick={() => { onRename?.(menu.entry); setMenu(null) }}><Pencil size={12} />重命名</button><button className="flex h-8 w-full items-center gap-2 px-3 text-left text-[#c62828] hover:bg-[#fff1f1]" onClick={() => { onDelete?.(menu.entry); setMenu(null) }}><Trash2 size={12} />删除</button></div>}
    </section>
  )
}
