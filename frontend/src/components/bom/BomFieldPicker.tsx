import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { BomDataType, BomField } from '../../types'

export interface BomFieldPickerOption {
  id: string
  field: BomField
  sourceLabel?: string
}

interface BomFieldPickerProps {
  options: BomFieldPickerOption[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  emptyText?: string
}

const typeLabels: Record<BomDataType, string> = {
  Integer: '整数',
  Decimal: '小数',
  Boolean: '布尔',
  String: '文本',
  Enum: '枚举',
  Date: '日期',
  'List<String>': '文本列表',
}

export default function BomFieldPicker({ options, selectedIds, onChange, emptyText = '没有可选字段' }: BomFieldPickerProps) {
  const initialFact = options.length > 100 ? options[0]?.field.factName || 'Ungrouped' : 'all'
  const [activeFact, setActiveFact] = useState(initialFact)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<BomDataType | 'all'>('all')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const optionMap = useMemo(() => new Map(options.map(option => [option.id, option])), [options])
  const facts = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; label: string; count: number }>()
    for (const option of options) {
      const key = option.field.factName || 'Ungrouped'
      const group = groups.get(key) || { key, name: key, label: option.field.factLabel || '未分组字段', count: 0 }
      group.count += 1
      groups.set(key, group)
    }
    return [...groups.values()]
  }, [options])
  const normalizedQuery = query.trim().toLowerCase()

  useEffect(() => {
    const availableFacts = new Set(facts.map(fact => fact.key))
    if (activeFact !== 'all' && !availableFacts.has(activeFact)) setActiveFact(options.length > 100 ? facts[0]?.key || 'all' : 'all')
    else if (activeFact === 'all' && options.length > 100) setActiveFact(facts[0]?.key || 'all')
  }, [activeFact, facts, options.length])

  const visibleOptions = useMemo(() => options.filter(option => {
    const field = option.field
    if (!normalizedQuery && activeFact !== 'all' && (field.factName || 'Ungrouped') !== activeFact) return false
    if (type !== 'all' && field.type !== type) return false
    if (selectedOnly && !selected.has(option.id)) return false
    if (!normalizedQuery) return true
    return [field.label, field.key, field.factLabel, field.factName, field.description, option.sourceLabel]
      .some(value => value?.toLowerCase().includes(normalizedQuery))
  }), [activeFact, normalizedQuery, options, selected, selectedOnly, type])
  const selectedOptions = selectedIds.map(id => optionMap.get(id)).filter((option): option is BomFieldPickerOption => Boolean(option))

  const toggle = (id: string) => onChange(selected.has(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id])
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= selectedIds.length) return
    const next = [...selectedIds]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  const allVisibleSelected = visibleOptions.length > 0 && visibleOptions.every(option => selected.has(option.id))
  const toggleVisible = () => {
    const visible = new Set(visibleOptions.map(option => option.id))
    onChange(allVisibleSelected
      ? selectedIds.filter(id => !visible.has(id))
      : [...selectedIds, ...visibleOptions.map(option => option.id).filter(id => !selected.has(id))])
  }

  return (
    <section className="overflow-hidden border border-ink-border bg-white" aria-label="BOM 字段选择器">
      <div className="grid grid-cols-[minmax(220px,1fr)_150px_auto] items-center gap-2 border-b border-ink-border bg-[#fafafa] p-2 max-md:grid-cols-1">
        <label className="flex h-8 items-center gap-2 border border-ink-border bg-white px-2 text-ink-3"><Search size={13} /><input className="min-w-0 flex-1 bg-transparent text-[11px] text-ink-1 outline-none" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索业务名、字段 key 或 Fact" aria-label="搜索 BOM 字段" /></label>
        <select className="control-input h-8 text-[11px]" value={type} onChange={event => setType(event.target.value as BomDataType | 'all')} aria-label="字段类型筛选"><option value="all">全部类型</option>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <label className="flex h-8 items-center gap-2 whitespace-nowrap px-1 text-[11px] text-ink-2"><input type="checkbox" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)} />仅显示已选</label>
      </div>
      <div className="grid h-[360px] min-h-0 grid-cols-[180px_minmax(280px,1fr)_240px] max-md:h-auto max-md:grid-cols-1">
        <nav className="min-h-0 overflow-y-auto border-r border-ink-border bg-[#fafafa] max-md:max-h-44 max-md:border-b max-md:border-r-0" aria-label="Fact 类型">
          <button type="button" className={`flex h-9 w-full items-center justify-between px-3 text-left text-[11px] ${activeFact === 'all' ? 'bg-brand-primary-l font-semibold text-brand-primary' : 'text-ink-2 hover:bg-white'}`} onClick={() => setActiveFact('all')}><span>全部字段</span><span>{options.length}</span></button>
          {facts.map(fact => {
            const selectedCount = options.filter(option => (option.field.factName || 'Ungrouped') === fact.key && selected.has(option.id)).length
            return <button key={fact.key} type="button" className={`w-full border-t border-[#e8e8e8] px-3 py-2 text-left ${activeFact === fact.key ? 'bg-brand-primary-l text-brand-primary' : 'text-ink-2 hover:bg-white'}`} onClick={() => { setActiveFact(fact.key); setQuery('') }}><span className="block truncate text-[11px] font-semibold" title={fact.label}>{fact.label}</span><span className="mt-0.5 flex justify-between font-mono text-[9px] text-ink-3"><span className="truncate" title={fact.name}>{fact.name}</span><span>{selectedCount}/{fact.count}</span></span></button>
          })}
        </nav>

        <div className="flex min-h-0 flex-col border-r border-ink-border max-md:h-80 max-md:border-b max-md:border-r-0">
          <div className="flex h-9 shrink-0 items-center border-b border-ink-border px-3 text-[10px] text-ink-3"><span>{normalizedQuery ? `全局搜索结果 ${visibleOptions.length}` : `可选字段 ${visibleOptions.length}`}</span><button type="button" className="ml-auto text-brand-primary hover:underline disabled:text-ink-3 disabled:no-underline" disabled={!visibleOptions.length} onClick={toggleVisible}>{allVisibleSelected ? '取消当前结果' : '选择当前结果'}</button></div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleOptions.map(option => {
              const field = option.field
              return <label key={option.id} className="grid min-h-[48px] cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#ededed] px-3 py-1.5 hover:bg-brand-primary-l"><input type="checkbox" checked={selected.has(option.id)} onChange={() => toggle(option.id)} /><span className="min-w-0"><b className="block truncate text-[11px] font-medium text-ink-1">{field.label}</b><span className="block truncate font-mono text-[9px] text-ink-3">{field.factLabel} / {field.key}</span></span><span className="text-right"><code className="block text-[9px] text-ink-3">{typeLabels[field.type]}</code>{option.sourceLabel && <span className="block text-[9px] text-brand-primary">{option.sourceLabel}</span>}</span></label>
            })}
            {!visibleOptions.length && <p className="p-6 text-center text-[11px] text-ink-3">{emptyText}</p>}
          </div>
        </div>

        <aside className="flex min-h-0 flex-col bg-white max-md:h-72" aria-label="已选字段">
          <div className="flex h-9 shrink-0 items-center border-b border-ink-border bg-[#fafafa] px-3 text-[10px] font-semibold text-ink-2"><span>已选列</span><span className="ml-auto font-mono text-ink-3">{selectedIds.length}</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {selectedOptions.map((option, index) => <div key={option.id} className="grid min-h-[46px] grid-cols-[22px_minmax(0,1fr)_66px] items-center gap-1 border-b border-[#ededed] px-2 py-1"><span className="flex size-5 items-center justify-center rounded-full bg-brand-primary-l font-mono text-[9px] font-semibold text-brand-primary">{index + 1}</span><span className="min-w-0"><b className="block truncate text-[10px] font-medium text-ink-1">{option.field.label}</b><span className="block truncate text-[9px] text-ink-3">{option.field.factLabel}</span></span><span className="flex justify-end"><button type="button" className="inline-flex size-5 items-center justify-center text-ink-3 hover:bg-ink-bg disabled:opacity-25" disabled={index === 0} onClick={() => move(index, -1)} title="上移"><ChevronUp size={11} /></button><button type="button" className="inline-flex size-5 items-center justify-center text-ink-3 hover:bg-ink-bg disabled:opacity-25" disabled={index === selectedOptions.length - 1} onClick={() => move(index, 1)} title="下移"><ChevronDown size={11} /></button><button type="button" className="inline-flex size-5 items-center justify-center text-ink-3 hover:bg-[#ffebee] hover:text-[#c62828]" onClick={() => toggle(option.id)} title="移除"><X size={11} /></button></span></div>)}
            {!selectedOptions.length && <p className="p-6 text-center text-[11px] text-ink-3">尚未选择字段</p>}
          </div>
          {selectedIds.length > 20 && <p className="shrink-0 border-t border-[#f3c65f] bg-[#fff8e1] p-2 text-[10px] text-[#734d00]">列数较多，建议按业务阶段拆分决策表。</p>}
        </aside>
      </div>
    </section>
  )
}
