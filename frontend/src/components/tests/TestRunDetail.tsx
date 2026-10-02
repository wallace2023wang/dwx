import { AlertTriangle, CheckCircle2, Timer, Zap } from 'lucide-react'
import type { TestCase, TestColumn } from '../../types'

interface TestRunDetailProps {
  testCase: TestCase
  columns: TestColumn[]
}

export default function TestRunDetail({ testCase, columns }: TestRunDetailProps) {
  return (
    <section className="rounded-[3px] border border-ink-border bg-white" aria-labelledby="test-detail-title">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-border bg-[#fafafa] px-3 py-2">
        <h2 id="test-detail-title" className="text-xs font-semibold">场景详情：{testCase.name}</h2>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-3"><Timer size={13} />{testCase.durationMs} ms</span>
      </header>
      <div className="grid grid-cols-[minmax(260px,1fr)_minmax(260px,1fr)] gap-5 p-4 max-md:grid-cols-1">
        <div>
          <h3 className="mb-2 text-[11px] font-semibold text-ink-2">输入事实</h3>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-[11px]">
            {columns.map((column) => (
              <div key={column.key} className="flex min-w-0 justify-between gap-3 border-b border-[#e8e8e8] pb-1">
                <dt className="text-ink-3">{column.label}</dt>
                <dd className="font-mono">{String(testCase.inputs[column.key] ?? '-')}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-2"><Zap size={13} />命中规则</h3>
          {testCase.firedRules.length > 0
            ? <div className="flex flex-wrap gap-1.5">{testCase.firedRules.map((rule) => <span key={rule} className="rounded-[2px] bg-brand-primary-l px-2 py-1 text-[10px] text-[#1d365d]">{rule}</span>)}</div>
            : <p className="text-[11px] text-ink-3">没有规则命中</p>}
        </div>
      </div>
      {testCase.omittedInputs && testCase.omittedInputs.length > 0 && <div className="flex items-start gap-2 border-t border-[#f3c65f] bg-[#fff8e1] px-4 py-2 text-[11px] text-[#734d00]"><AlertTriangle size={14} className="mt-px shrink-0" /><p>未提供输入：{testCase.omittedInputs.join('、')}。这些字段未赋值；若业务上必须提供，请在 BOM 中标记为“执行时必填”。</p></div>}
      <div className={`flex items-start gap-2 border-t px-4 py-3 text-[11px] ${testCase.status === 'failed' ? 'border-[#ffcdd2] bg-[#fff5f5] text-[#9f1f1f]' : 'border-[#c8e6c9] bg-[#f4fbf4] text-env-production'}`}>
        {testCase.status === 'failed' ? <AlertTriangle size={15} className="mt-px shrink-0" /> : <CheckCircle2 size={15} className="mt-px shrink-0" />}
        <p>{testCase.status === 'failed' ? testCase.diagnostic : `期望“${testCase.expected}”，实际“${testCase.actual}”，所有断言均通过。`}</p>
      </div>
    </section>
  )
}
