import { lazy, Suspense, useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, FileCode2, Languages, Rocket, Save } from 'lucide-react'
import type { AssetDetail, BomField, RuleDraft, RuleSetVariable } from '../../types'
import BalRuleView, { normalizeBalDraft, validateBalDraft } from './BalRuleView'
import BomVersionNotice from './BomVersionNotice'

const MonacoTextEditor = lazy(() => import('./MonacoTextEditor'))

interface RuleFormEditorProps {
  detail: AssetDetail
  fields: BomField[]
  projectVariables?: RuleSetVariable[]
  busy: boolean
  onSave: (draft: RuleDraft) => Promise<void>
  onCompile: (draft: RuleDraft) => Promise<{ engineVersion: string; drl: string }>
  onSubmit: () => Promise<void>
  onOpenBom?: (fieldKey: string) => void
}

function closeMenu(target: HTMLElement) {
  target.closest('details')?.removeAttribute('open')
}

const statusMeta = {
  draft: ['草稿', 'bg-[#fff3e0] text-env-staging'],
  'in-review': ['审核中', 'bg-brand-primary-l text-brand-primary'],
  rejected: ['已驳回', 'bg-[#fff1f1] text-[#c62828]'],
  published: ['已发布', 'bg-[#e8f5e9] text-env-production'],
  deprecated: ['已废弃', 'bg-[#fff3e0] text-[#8a5a00]'],
  archived: ['已归档', 'bg-[#eeeeee] text-ink-3'],
} as const

export default function RuleFormEditor({ detail, fields, projectVariables, busy, onSave, onCompile, onSubmit, onOpenBom }: RuleFormEditorProps) {
  const source = detail.draft as RuleDraft
  const [draft, setDraft] = useState<RuleDraft>(() => structuredClone(source))
  const [view, setView] = useState<'bal' | 'drl'>('bal')
  const [drl, setDrl] = useState(detail.content ?? '')
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(source)
  const issues = validateBalDraft(draft, fields, projectVariables)
  const invalid = issues.length > 0

  useEffect(() => {
    setDraft(structuredClone(source))
    setDrl(detail.content ?? '')
    setView('bal')
    setNotice(null)
  }, [detail.id, detail.revision])

  const run = async (action: () => Promise<unknown>, success: string) => {
    setNotice(null)
    try {
      await action()
      setNotice({ error: false, text: success })
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : '操作失败' })
    }
  }

  const compile = async () => {
    const result = await onCompile(normalizeBalDraft(draft, fields))
    setDrl(result.drl)
  }

  const selectView = (next: 'bal' | 'drl', target: HTMLElement) => {
    setView(next)
    closeMenu(target)
  }

  return (
    <section className="flex h-full min-w-[500px] flex-1 flex-col overflow-hidden bg-white" aria-label="BAL 规则编辑器">
      <header className="shrink-0 border-b border-ink-border bg-white px-4 pb-3 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <input className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] font-semibold text-ink-1 outline-none focus:border-b focus:border-brand-primary" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} aria-label="规则名称" />
          <span className={`shrink-0 rounded-[2px] px-1.5 py-px text-[10px] ${statusMeta[detail.status][1]}`}>{statusMeta[detail.status][0]}</span>
          <span className="shrink-0 text-[11px] text-ink-3">v{detail.version} · r{detail.revision}</span>
          {view === 'drl' && <span className="shrink-0 rounded-[2px] border border-ink-border bg-[#f1f1f1] px-1.5 py-px text-[10px] text-ink-2">DRL 只读</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
          <span>作者: <b className="font-medium text-ink-1">{detail.modifiedBy}</b></span>
          <span>最后修改: {detail.updatedAt}</span>
          <label className="inline-flex items-center gap-1">包:<input className="h-6 w-28 border-0 border-b border-dashed border-ink-border bg-transparent px-1 font-medium text-ink-1 outline-none focus:border-brand-primary" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} aria-label="规则包" /></label>
        </div>
      </header>
      <BomVersionNotice detail={detail} />

      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'bal'
          ? <>
              {invalid && <div className="border-b border-[#ef9a9a] bg-[#fff1f1] px-4 py-2 text-[11px] text-[#a31515]" role="alert">{issues[0]}{issues.length > 1 ? `，另有 ${issues.length - 1} 项问题` : ''}。修复后才能保存或编译。</div>}
              <BalRuleView draft={draft} fields={fields} projectVariables={projectVariables} editable onChange={setDraft} onOpenBom={onOpenBom} />
              <div className="grid grid-cols-[100px_150px_minmax(150px,1fr)] gap-3 border-t border-ink-border bg-[#fafafa] px-5 py-3">
                <label className="text-[10px] font-semibold text-ink-3">优先级<input className="control-input mt-1 h-8 bg-white text-xs" type="number" min={-1000} max={1000} value={draft.priority} onChange={event => setDraft({ ...draft, priority: Number(event.target.value) })} /></label>
                <label className="text-[10px] font-semibold text-ink-3">命中策略<input className="control-input mt-1 h-8 bg-[#f1f1f1] text-xs" value={detail.attributes.hitPolicy} readOnly /></label>
                <label className="text-[10px] font-semibold text-ink-3">有效日期<input className="control-input mt-1 h-8 bg-[#f1f1f1] text-xs" value={detail.attributes.effectiveDate} readOnly /></label>
              </div>
              <label className="block border-t border-ink-border px-5 py-3 text-[10px] font-semibold text-ink-3">业务说明<textarea className="mt-1 min-h-20 w-full resize-y rounded-[3px] border border-ink-border bg-white px-[10px] py-2 text-xs font-normal text-ink-1 outline-none focus:border-brand-primary" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
            </>
          : <div className="h-full min-h-[420px]">
              <div className="border-b border-ink-border bg-[#fff8e1] px-4 py-2 text-[10px] text-[#734d00]">DRL 由当前 BAL 和 BOM 在后端生成，仅供开发排障，不能直接编辑。</div>
              <div className="h-[calc(100%-33px)]">
                <Suspense fallback={<div className="p-5 text-[11px] text-ink-3">正在加载 DRL 只读视图...</div>}>
                  <MonacoTextEditor value={drl} />
                </Suspense>
              </div>
            </div>}
      </div>

      <footer className="relative flex min-h-[48px] shrink-0 items-center gap-2 border-t border-ink-border bg-[#fafafa] px-3 py-2">
        {notice && <span className={`mr-auto max-w-[250px] truncate text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span>}
        {!notice && <span className="mr-auto text-[10px] text-ink-3">{dirty ? '有未保存的 BAL 修改' : 'BAL 草稿已同步'}</span>}
        <button className="inline-flex h-8 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2.5 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy || !dirty || invalid} onClick={() => run(() => onSave(normalizeBalDraft(draft, fields)), 'BAL 草稿已保存')} title={invalid ? issues[0] : '保存结构化 BAL 草稿'}><Save size={13} />保存草稿</button>
        <button className="inline-flex h-8 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-2.5 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" disabled={busy || invalid} onClick={() => run(compile, 'Drools 编译通过')} title={invalid ? issues[0] : '在后端生成 DRL 并使用 Drools 编译'}><CheckCircle2 size={13} />编译</button>
        <button className="inline-flex h-8 items-center gap-1.5 rounded-[2px] border border-brand-primary bg-brand-primary px-2.5 text-[11px] text-white hover:bg-brand-primary-d disabled:opacity-50" disabled={busy || dirty || invalid} onClick={() => run(onSubmit, '已提交审核')} title={invalid ? issues[0] : dirty ? '请先保存 BAL 草稿' : '编译并提交审核'}><Rocket size={13} />提交审核</button>
        <details className="group relative">
          <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1 rounded-[2px] border border-ink-border bg-white px-2.5 text-[11px] text-ink-2 hover:bg-ink-bg"><span>高级</span><ChevronDown size={13} className="transition-transform group-open:rotate-180" /></summary>
          <div className="absolute bottom-10 right-0 z-20 w-36 border border-ink-border bg-white py-1 shadow-lg">
            <button type="button" className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[11px] hover:bg-ink-bg ${view === 'bal' ? 'text-brand-primary' : 'text-ink-2'}`} onClick={event => selectView('bal', event.currentTarget)}><Languages size={13} />BAL 编辑</button>
            <button type="button" className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[11px] hover:bg-ink-bg ${view === 'drl' ? 'text-brand-primary' : 'text-ink-2'}`} onClick={event => selectView('drl', event.currentTarget)}><FileCode2 size={13} />查看 DRL</button>
          </div>
        </details>
      </footer>
    </section>
  )
}
