import { lazy, Suspense, useEffect, useState } from 'react'
import { ChevronDown, FileCode2, FileText, Languages } from 'lucide-react'
import type { AssetDetail, BomField, RuleDraft, RuleSetVariable } from '../../types'
import AssetProperties from './AssetProperties'
import BalRuleView from './BalRuleView'
import BomVersionNotice from './BomVersionNotice'

const MonacoTextEditor = lazy(() => import('./MonacoTextEditor'))

const statusMeta = {
  draft: ['草稿', 'bg-[#fff3e0] text-env-staging'],
  'in-review': ['审核中', 'bg-brand-primary-l text-brand-primary'],
  rejected: ['已驳回', 'bg-[#fff1f1] text-[#c62828]'],
  published: ['已发布', 'bg-[#e8f5e9] text-env-production'],
  deprecated: ['已废弃', 'bg-[#fff3e0] text-[#8a5a00]'],
  archived: ['已归档', 'bg-[#eeeeee] text-ink-3'],
} as const

interface BalEditorProps {
  detail: AssetDetail | null | undefined
  fields: BomField[]
  projectVariables?: RuleSetVariable[]
  loading?: boolean
  onOpenBom?: (fieldKey: string) => void
}

function EmptyEditor({ loading }: { loading?: boolean }) {
  return (
    <section className="flex h-full min-w-[360px] flex-1 items-center justify-center bg-white text-ink-3" aria-label="资产编辑器">
      <div className="text-center"><FileText className="mx-auto mb-2" size={26} strokeWidth={1.5} /><p>{loading ? '正在加载资产...' : '从左侧选择一个规则或决策表'}</p></div>
    </section>
  )
}

export default function BalEditor({ detail, fields, projectVariables, loading, onOpenBom }: BalEditorProps) {
  const [view, setView] = useState<'bal' | 'drl'>('bal')

  useEffect(() => setView('bal'), [detail?.id])

  if (!detail) return <EmptyEditor loading={loading} />
  const draft = detail.draft as RuleDraft | undefined

  return (
    <section className="flex h-full min-w-[360px] flex-1 flex-col overflow-hidden bg-white" aria-label="BAL 编辑器">
      <div className="shrink-0 px-5 pb-2 pt-[14px]">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-medium">{detail.name}</h2>
          <span className={`rounded-[2px] px-1.5 py-px text-[10px] ${statusMeta[detail.status][1]}`}>{statusMeta[detail.status][0]}</span>
          <span className="text-[11px] text-ink-3">v{detail.version} · 规则</span>
        </div>
      </div>
      <div className="mx-5 flex shrink-0 gap-4 border-b border-[#e8e8e8] pb-[10px] text-[11px] text-ink-3">
        <span>作者: <b className="font-medium text-ink-1">{detail.modifiedBy}</b></span>
        <span>最后修改: {detail.updatedAt}</span>
        <span>包: <b className="font-medium text-ink-1">{detail.packageId}</b></span>
      </div>
      <BomVersionNotice detail={detail} />
      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'bal'
          ? draft
            ? <>
                <BalRuleView draft={draft} fields={fields} projectVariables={projectVariables} methods={detail.bomMethods || []} onOpenBom={onOpenBom} />
                <AssetProperties attributes={detail.attributes} />
              </>
            : <div className="p-5 text-[11px] text-[#c62828]">该演示规则缺少结构化 BAL 定义。</div>
          : <div className="h-full min-h-[320px]">
              <div className="border-b border-ink-border bg-[#fff8e1] px-4 py-2 text-[10px] text-[#734d00]">DRL 由 BAL 和 BOM 自动生成，仅供查看，不能直接编辑。</div>
              <div className="h-[calc(100%-33px)]">
                <Suspense fallback={<div className="p-5 text-[11px] text-ink-3">正在加载 DRL 只读视图...</div>}>
                  <MonacoTextEditor value={detail.content ?? ''} />
                </Suspense>
              </div>
            </div>}
      </div>
      <footer className="relative flex min-h-[44px] shrink-0 items-center border-t border-ink-border bg-[#fafafa] px-3 py-1.5">
        <span className="mr-auto text-[10px] text-ink-3">{detail.status === 'in-review' ? '审核中只读' : '资产只读'}</span>
        <details className="group relative">
          <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1 rounded-[2px] border border-ink-border bg-white px-2.5 text-[11px] text-ink-2 hover:bg-ink-bg">高级<ChevronDown size={13} className="transition-transform group-open:rotate-180" /></summary>
          <div className="absolute bottom-10 right-0 z-20 w-36 border border-ink-border bg-white py-1 shadow-lg">
            <button type="button" className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[11px] hover:bg-ink-bg ${view === 'bal' ? 'text-brand-primary' : 'text-ink-2'}`} onClick={event => { setView('bal'); event.currentTarget.closest('details')?.removeAttribute('open') }}><Languages size={13} />BAL 预览</button>
            <button type="button" className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[11px] hover:bg-ink-bg ${view === 'drl' ? 'text-brand-primary' : 'text-ink-2'}`} onClick={event => { setView('drl'); event.currentTarget.closest('details')?.removeAttribute('open') }}><FileCode2 size={13} />查看 DRL</button>
          </div>
        </details>
      </footer>
    </section>
  )
}
