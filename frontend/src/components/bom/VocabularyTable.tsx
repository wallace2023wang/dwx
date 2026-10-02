import type { VocabularyTerm } from '../../types'

interface VocabularyTableProps {
  terms: VocabularyTerm[]
  activeFieldKey?: string
}

export default function VocabularyTable({ terms, activeFieldKey }: VocabularyTableProps) {
  return (
    <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
      <header className="border-b border-ink-border bg-[#fafafa] px-3 py-2 text-xs font-semibold">业务词汇表</header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[590px] border-collapse text-left text-xs">
          <thead className="bg-[#fafafa] text-[11px] text-ink-2">
            <tr>
              <th className="border-b border-ink-border px-[10px] py-1.5 font-semibold">BOM 属性</th>
              <th className="border-b border-ink-border px-[10px] py-1.5 font-semibold">业务说法</th>
              <th className="border-b border-ink-border px-[10px] py-1.5 font-semibold">类型</th>
              <th className="w-14 border-b border-ink-border px-[10px] py-1.5 text-right font-semibold">引用</th>
            </tr>
          </thead>
          <tbody>
            {terms.map((term) => (
              <tr key={term.property} className={`border-b border-[#e8e8e8] last:border-0 hover:bg-[#f0f6fc] ${term.property.endsWith(`.${activeFieldKey}`) ? 'bg-brand-primary-l' : ''}`}>
                <td className="px-[10px] py-1.5 font-mono text-[11px]">{term.property}</td>
                <td className="px-[10px] py-1.5">{term.label}</td>
                <td className="px-[10px] py-1.5 text-[11px] text-ink-3">{term.type}</td>
                <td className="px-[10px] py-1.5 text-right text-[11px] text-ink-3">{term.references}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
