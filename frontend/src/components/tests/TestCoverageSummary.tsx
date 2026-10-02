import { CheckCircle2, CircleDashed } from 'lucide-react'
import type { ServerCoverage } from '../../api/tests'

const kindLabel = { rule: '规则', 'table-row': '决策表行', 'flow-path': '规则流路径' }

export default function TestCoverageSummary({ coverage }: { coverage?: ServerCoverage }) {
  if (!coverage) return null
  const missed = coverage.items.filter(item => !item.hit)
  return (
    <section className="border border-ink-border bg-white px-3 py-2.5" aria-label="测试覆盖率">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold"><CheckCircle2 size={14} className="text-env-production" />{kindLabel[coverage.kind]}覆盖率</h2>
        <strong className="font-mono text-base font-semibold text-brand-primary">{coverage.percentage}%</strong>
        <span className="text-[11px] text-ink-3">已覆盖 {coverage.hit} / {coverage.total}</span>
        <div className="h-1.5 min-w-32 flex-1 overflow-hidden bg-[#e8e8e8]" aria-hidden="true"><div className="h-full bg-env-production" style={{ width: `${coverage.percentage}%` }} /></div>
      </div>
      {missed.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3"><span className="inline-flex items-center gap-1 font-semibold text-ink-2"><CircleDashed size={12} />未覆盖</span>{missed.map(item => <span key={item.id} className="border border-ink-border bg-[#fafafa] px-1.5 py-0.5">{item.label}</span>)}</div>}
    </section>
  )
}
