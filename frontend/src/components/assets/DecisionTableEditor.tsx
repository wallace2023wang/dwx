import { TableProperties } from 'lucide-react'
import type { AssetDetail } from '../../types'
import AssetProperties from './AssetProperties'

interface DecisionTableEditorProps {
  detail: AssetDetail
}

const statusMeta = {
  draft: ['草稿', 'bg-[#fff3e0] text-env-staging'],
  'in-review': ['审核中', 'bg-brand-primary-l text-brand-primary'],
  rejected: ['已驳回', 'bg-[#fff1f1] text-[#c62828]'],
  published: ['已发布', 'bg-[#e8f5e9] text-env-production'],
  archived: ['已归档', 'bg-[#eeeeee] text-ink-3'],
} as const

export default function DecisionTableEditor({ detail }: DecisionTableEditorProps) {
  const table = detail.decisionTable
  if (!table) return null

  return (
    <section className="flex h-full min-w-[360px] flex-1 flex-col overflow-hidden bg-white" aria-label="决策表编辑器">
      <div className="flex min-h-[41px] shrink-0 items-center gap-2 border-b border-ink-border bg-[#fafafa] px-4">
        <span className="min-w-0 truncate text-[11px] text-ink-3">{detail.name}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2 py-1 text-[11px] text-ink-2">
          <TableProperties size={13} />决策表只读
        </span>
      </div>
      <div className="shrink-0 px-5 pb-2 pt-[14px]">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-medium">{detail.name}</h2>
          <span className={`rounded-[2px] px-1.5 py-px text-[10px] ${statusMeta[detail.status][1]}`}>{statusMeta[detail.status][0]}</span>
          <span className="text-[11px] text-ink-3">v{detail.version} · 决策表</span>
        </div>
      </div>
      <div className="mx-5 flex shrink-0 gap-4 border-b border-[#e8e8e8] pb-[10px] text-[11px] text-ink-3">
        <span>作者: <b className="font-medium text-ink-1">{detail.modifiedBy}</b></span>
        <span>最后修改: {detail.updatedAt}</span>
        <span>包: <b className="font-medium text-ink-1">{detail.packageId}</b></span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="min-w-[700px] border border-ink-border">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="bg-[#f0f0f0] text-left text-[11px] font-semibold">
                <th className="w-9 border-r border-ink-border px-2 py-1.5 text-center">#</th>
                {table.columns.map((column) => (
                  <th key={column.id} className="border-r border-ink-border px-2 py-1.5 last:border-r-0">
                    <span className="block">{column.label}</span>
                    <span className={`mt-0.5 block text-[9px] font-normal ${column.kind === 'condition' ? 'text-brand-primary' : 'text-env-production'}`}>{column.kind === 'condition' ? '条件' : '结果'}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-ink-border hover:bg-[#f0f6fc]">
                  <td className="border-r border-ink-border px-2 py-2 text-center text-[11px] text-ink-3">{rowIndex + 1}</td>
                  {table.columns.map((column) => <td key={column.id} className="border-r border-ink-border px-2 py-2 font-mono text-[11px] last:border-r-0">{row[column.id]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">空单元格 = 通配 · 区间支持 [a,b)、a..b · 默认行在最下方 · 命中策略: {table.hitPolicy}</p>
      </div>
      <AssetProperties attributes={detail.attributes} />
    </section>
  )
}
