import { CheckCircle2, Clock3, XCircle } from 'lucide-react'
import type { TestCase, TestColumn } from '../../types'

interface TestResultTableProps {
  columns: TestColumn[]
  cases: TestCase[]
  selectedId: string | null
  onSelect: (testCase: TestCase) => void
}

function Status({ testCase }: { testCase: TestCase }) {
  if (testCase.status === 'failed') {
    return <span className="inline-flex items-center gap-1 font-medium text-[#c62828]"><XCircle size={13} />失败</span>
  }
  if (testCase.status === 'passed') {
    return <span className="inline-flex items-center gap-1 font-medium text-env-production"><CheckCircle2 size={13} />通过</span>
  }
  return <span className="inline-flex items-center gap-1 text-ink-3"><Clock3 size={13} />未运行</span>
}

function displayValue(value: string | number | boolean | undefined) {
  if (typeof value === 'number') return value.toLocaleString('zh-CN')
  if (typeof value === 'boolean') return value ? '是' : '否'
  return value ?? '-'
}

export default function TestResultTable({ columns, cases, selectedId, onSelect }: TestResultTableProps) {
  return (
    <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white" aria-label="测试场景结果">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-left text-xs">
          <thead className="bg-[#fafafa] text-[11px] text-ink-2">
            <tr>
              <th className="w-10 border-b border-ink-border px-[10px] py-2 font-semibold">#</th>
              <th className="min-w-40 border-b border-ink-border px-[10px] py-2 font-semibold">场景名</th>
              {columns.map((column) => <th key={column.key} className="border-b border-ink-border px-[10px] py-2 font-semibold">{column.label}</th>)}
              <th className="min-w-28 border-b border-ink-border px-[10px] py-2 font-semibold">期望结果</th>
              <th className="min-w-28 border-b border-ink-border px-[10px] py-2 font-semibold">实际结果</th>
              <th className="w-20 border-b border-ink-border px-[10px] py-2 font-semibold">状态</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((testCase, index) => (
              <tr
                key={testCase.id}
                className={`cursor-pointer border-b border-[#e8e8e8] last:border-0 ${selectedId === testCase.id ? 'bg-[#dbeaff]' : 'hover:bg-[#f0f6fc]'}`}
                onClick={() => onSelect(testCase)}
                aria-selected={selectedId === testCase.id}
              >
                <td className="px-[10px] py-2 text-ink-3">{index + 1}</td>
                <td className="px-[10px] py-2 font-medium">{testCase.name}</td>
                {columns.map((column) => <td key={column.key} className="px-[10px] py-2 font-mono text-[11px]">{displayValue(testCase.inputs[column.key])}</td>)}
                <td className="px-[10px] py-2">{testCase.expected}</td>
                <td className={`px-[10px] py-2 ${testCase.status === 'failed' ? 'font-medium text-[#c62828]' : ''}`}>{testCase.actual}</td>
                <td className="px-[10px] py-2"><Status testCase={testCase} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
