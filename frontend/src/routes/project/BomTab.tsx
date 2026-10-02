import { Braces } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useBom, useSaveBom, type SaveBomResult } from '../../api/bom'
import BomEditor from '../../components/bom/BomEditor'
import DrlPreview from '../../components/bom/DrlPreview'
import FactTypeList from '../../components/bom/FactTypeList'
import VocabularyTable from '../../components/bom/VocabularyTable'

export default function BomTab() {
  const { projectId } = useParams()
  const [searchParams] = useSearchParams()
  const { data: bom, isPending } = useBom(projectId)
  const saveBom = useSaveBom(projectId)
  const activeFieldKey = searchParams.get('field') || undefined
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!activeFieldKey || !bom) return
    const frame = window.requestAnimationFrame(() => document.getElementById(`bom-field-${activeFieldKey}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    return () => window.cancelAnimationFrame(frame)
  }, [activeFieldKey, bom])

  if (isPending || !bom) return <div className="p-6 text-xs text-ink-3">正在加载 BOM...</div>

  const fieldCount = bom.factTypes.reduce((count, fact) => count + fact.fields.length, 0)

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-base font-medium"><Braces size={17} />BOM 业务对象模型</h1>
          <p className="mt-0.5 text-[11px] text-ink-3">版本 v{bom.version} · {bom.factTypes.length} 个事实类型 · {fieldCount} 个字段 · 修改者 {bom.updatedBy}</p>
        </div>
        {!editing && <button type="button" className="shrink-0 border border-brand-primary bg-white px-3 py-1.5 text-[11px] font-medium text-brand-primary hover:bg-brand-primary-l" onClick={() => { setEditing(true); setToast(null) }}>编辑模型</button>}
      </div>

      {editing
        ? <BomEditor
            model={bom}
            projectId={projectId}
            saving={saveBom.isPending}
            onCancel={() => setEditing(false)}
            onSave={(model, acknowledgeImpact) => saveBom.mutateAsync({ model, acknowledgeImpact })}
            onSaved={(result: SaveBomResult) => { setEditing(false); setToast(`BOM v${result.bom.version} 已保存`) }}
          />
        : <div className="grid grid-cols-[280px_minmax(560px,1fr)] gap-[14px] max-lg:grid-cols-1">
            <FactTypeList factTypes={bom.factTypes} relationships={bom.relationships} activeFieldKey={activeFieldKey} />
            <div className="min-w-0 space-y-[14px]">
              <VocabularyTable terms={bom.vocabulary} activeFieldKey={activeFieldKey} />
              <DrlPreview drl={bom.drl} />
            </div>
          </div>}

      {toast && (
        <div className="fixed bottom-5 right-5 z-40 flex min-h-10 items-center border border-[#81c784] bg-[#edf7ed] px-4 text-xs text-[#1b5e20] shadow-lg" role="status">
          {toast}
          <button type="button" className="ml-4 text-[11px]" onClick={() => setToast(null)}>关闭</button>
        </div>
      )}
    </div>
  )
}
