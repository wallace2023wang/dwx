import { CircleDollarSign, Database, Send, Thermometer } from 'lucide-react'
import type { BomFactType } from '../../types'

interface FactTypeListProps {
  factTypes: BomFactType[]
  relationships: string[]
  activeFieldKey?: string
}

const icons = [Database, CircleDollarSign, Send, Thermometer]

export default function FactTypeList({ factTypes, relationships, activeFieldKey }: FactTypeListProps) {
  return (
    <div className="space-y-3">
      {factTypes.map((fact, index) => {
        const Icon = icons[index % icons.length]
        return (
          <section key={fact.name} className="rounded-[3px] border border-ink-border bg-white">
            <header className="flex min-h-9 items-center gap-2 border-b border-ink-border bg-[#fafafa] px-3 py-2">
              <Icon size={15} className={fact.direction === 'output' ? 'text-env-production' : 'text-[#1d365d]'} />
              <h2 className="text-xs font-semibold"><span className="font-mono">{fact.name}</span> {fact.label}</h2>
              <span className="ml-auto text-[10px] font-normal text-ink-3">{fact.direction === 'mixed' ? '输入/输出事实' : fact.direction === 'output' ? '输出事实' : '输入事实'}</span>
            </header>
            <div>
              {fact.fields.map((field) => (
                <div id={`bom-field-${field.key}`} key={field.key} className={`flex min-h-[31px] items-center justify-between border-b border-[#e8e8e8] px-3 text-[11px] last:border-0 ${activeFieldKey === field.key ? 'bg-brand-primary-l ring-1 ring-inset ring-brand-primary' : ''}`}>
                  <span className="min-w-0 truncate"><code className="font-mono text-ink-1">{field.key}</code> <span className="ml-1 text-[10px] text-ink-3">{field.type}</span></span>
                  <span className="ml-2 shrink-0 text-[10px] text-ink-3">{field.direction === 'output' ? '输出' : '输入'}</span>
                </div>
              ))}
            </div>
          </section>
        )
      })}

      <section className="rounded-[3px] border border-ink-border bg-white">
        <header className="border-b border-ink-border bg-[#fafafa] px-3 py-2 text-xs font-semibold">对象关系</header>
        <div className="space-y-1 px-3 py-[10px] text-[11px]">
          {relationships.map((relationship) => <p key={relationship}>{relationship}</p>)}
        </div>
      </section>
    </div>
  )
}
