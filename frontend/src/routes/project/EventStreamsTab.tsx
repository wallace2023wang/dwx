import { AlertTriangle, Code2, FileClock, LoaderCircle, Plus, RadioTower, Save, Send, Sparkles, Trash2, Wand2, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useBom } from '../../api/bom'
import Modal from '../../components/Modal'
import { useCompileEventStream, useCreateEventStream, useDeleteEventStream, useEventStream, useEventStreams, usePublishEventStream, useSaveEventStream, type EplStatement, type EventStreamDraft } from '../../api/eventStreams'
import { useCreateTestSuite } from '../../api/tests'
import { buildCepTemplate, CEP_TEMPLATES, defaultCepParams, describeCepTemplate, fieldsForEventType, numericFields, type CepTemplateId, type CepTemplateParams } from '../../lib/cepTemplates'
import { buildCepTestSkeleton } from '../../lib/cepTemplates'
import type { BomModel } from '../../types'

type EditorOperation = 'save' | 'compile' | 'test' | 'publish'

function defaultDraft(bom: BomModel | undefined, name = '传感器异常检测'): EventStreamDraft {
  const params = defaultCepParams('single-threshold', bom, 1)
  return { name, description: '', statements: [applyTemplate('single-threshold', params)] }
}

function labelOf(statement: EplStatement) {
  return statement.label || statement.name
}

function applyTemplate(id: CepTemplateId, params: CepTemplateParams): EplStatement {
  const epl = buildCepTemplate(id, params)
  return {
    name: params.statementName,
    label: params.label,
    description: describeCepTemplate(id, params),
    enabled: true,
    mode: 'guided',
    template: id,
    params: { ...params },
    epl,
  }
}

export default function EventStreamsTab() {
  const { projectId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('stream') || undefined
  const { data: streams = [], isPending } = useEventStreams(projectId)
  const { data: bom, isPending: bomPending } = useBom(projectId)
  const active = streams.find(stream => stream.id === selectedId) || streams[0]
  const { data: detail } = useEventStream(projectId, active?.id)
  const createStream = useCreateEventStream(projectId)
  const saveStream = useSaveEventStream(projectId, detail?.id)
  const deleteStream = useDeleteEventStream(projectId, detail?.id)
  const compileStream = useCompileEventStream(projectId, detail?.id)
  const publishStream = usePublishEventStream(projectId, detail?.id)
  const createTestSuite = useCreateTestSuite(projectId)
  const [draft, setDraft] = useState<EventStreamDraft | null>(null)
  const [selectedStatement, setSelectedStatement] = useState(0)
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [localNotice, setLocalNotice] = useState<string | null>(null)
  const [templateConflict, setTemplateConflict] = useState<{ index: number; generatedEpl: string } | null>(null)
  const [deleteAssetOpen, setDeleteAssetOpen] = useState(false)
  const [deleteStatementIndex, setDeleteStatementIndex] = useState<number | null>(null)
  const [activeOperation, setActiveOperation] = useState<EditorOperation | null>(null)
  const currentDraft = draft || detail?.draft || null
  const currentStatement = currentDraft?.statements[selectedStatement] || currentDraft?.statements[0] || null
  const busy = activeOperation !== null || deleteStream.isPending || createStream.isPending
  const notice = localNotice
  const firstEventType = useMemo(() => bom?.eventTypes?.[0]?.name || bom?.factTypes?.find(fact => fact.direction !== 'output')?.name || 'DefaultEvent', [bom])

  const create = async () => {
    const created = await createStream.mutateAsync(defaultDraft(bom))
    setSearchParams({ stream: created.id })
    setDraft(created.draft)
    setSelectedStatement(0)
  }

  const removeAsset = async () => {
    if (!detail) return
    await deleteStream.mutateAsync(detail.revision)
    const next = streams.find(stream => stream.id !== detail.id)
    setSearchParams(next ? { stream: next.id } : {})
    setDraft(null)
    setSelectedStatement(0)
    setDeleteAssetOpen(false)
  }

  const clearFeedback = () => {
    setLocalNotice(null)
    compileStream.reset()
    saveStream.reset()
    publishStream.reset()
    createTestSuite.reset()
    deleteStream.reset()
  }

  const saveDraft = async () => {
    if (!detail || !currentDraft) return null
    if (openTemplateConflict(currentDraft)) return null
    await compileStream.mutateAsync({ revision: detail.revision, draft: currentDraft })
    const saved = await saveStream.mutateAsync({ revision: detail.revision, draft: currentDraft })
    setDraft(saved.draft)
    return saved
  }

  const save = async () => {
    clearFeedback()
    setActiveOperation('save')
    try {
      const saved = await saveDraft()
      if (saved) setLocalNotice(`保存成功，当前修订 r${saved.revision}。`)
    } catch {
      // Mutation state renders the actionable API error below the editor.
    } finally {
      setActiveOperation(null)
    }
  }

  const compileCurrent = async () => {
    if (!detail || !currentDraft) return
    clearFeedback()
    setActiveOperation('compile')
    try {
      if (openTemplateConflict(currentDraft)) return
      await compileStream.mutateAsync({ revision: detail.revision, draft: currentDraft })
      setLocalNotice('编译通过，当前草稿可以保存或发布。')
    } catch {
      // Mutation state renders the actionable API error below the editor.
    } finally {
      setActiveOperation(null)
    }
  }

  const publish = async () => {
    if (!detail || !currentDraft) return
    clearFeedback()
    setActiveOperation('publish')
    try {
      const saved = await saveDraft()
      if (!saved) return
      const published = await publishStream.mutateAsync(saved.revision)
      setDraft(published.draft)
      setLocalNotice(`发布成功，事件流版本为 v${published.version}。`)
    } catch {
      // Mutation state renders the actionable API error below the editor.
    } finally {
      setActiveOperation(null)
    }
  }

  const saveAndCreateTest = async () => {
    if (!detail || !currentDraft || !currentStatement) return
    clearFeedback()
    setActiveOperation('test')
    try {
      const saved = await saveDraft()
      if (!saved) return
      const latestStatement = saved.draft.statements[selectedStatement] || currentStatement
      const skeleton = buildCepTestSkeleton(latestStatement, bom)
      await createTestSuite.mutateAsync({
        name: `${latestStatement.label || latestStatement.name} 自动骨架`,
        description: '由 CEP 引导式编辑器生成，请补充/确认事件样例后纳入发布门禁。',
        target: { type: 'event-stream', id: detail.id },
        required: false,
        cases: [skeleton],
      })
      setLocalNotice(`保存成功，测试套件骨架已创建。${detail.version > 0 ? '可到“测试套件”页补充样例并运行。' : '请先发布事件流，再到“测试套件”页运行。'}`)
    } catch {
      // Mutation state renders the actionable API error below the editor.
    } finally {
      setActiveOperation(null)
    }
  }

  const updateStatements = (updater: (statements: EplStatement[]) => EplStatement[]) => {
    if (!currentDraft) return
    const statements = updater(currentDraft.statements)
    setDraft({ ...currentDraft, statements })
    if (selectedStatement >= statements.length) setSelectedStatement(Math.max(0, statements.length - 1))
  }

  const patchStatement = (index: number, patch: Partial<EplStatement>) => {
    updateStatements(statements => statements.map((statement, idx) => idx === index ? { ...statement, ...patch } : statement))
  }

  const addTemplateStatement = (id: CepTemplateId) => {
    if (!currentDraft) return
    const params = defaultCepParams(id, bom, currentDraft.statements.length + 1)
    const statement = applyTemplate(id, params)
    updateStatements(statements => [...statements, statement])
    setSelectedStatement(currentDraft.statements.length)
    setTemplatePickerOpen(false)
  }

  const addAdvancedStatement = () => {
    if (!currentDraft) return
    updateStatements(statements => [...statements, { name: `Statement${statements.length + 1}`, enabled: true, mode: 'advanced', epl: `select * from ${firstEventType}` }])
    setSelectedStatement(currentDraft.statements.length)
  }

  const requestDeleteStatement = (index: number) => {
    if (!currentDraft || !currentDraft.statements[index]) return
    if (currentDraft.statements.length === 1) {
      setLocalNotice('事件流至少需要一条语句，不能删除最后一条。')
      return
    }
    setSelectedStatement(index)
    setDeleteStatementIndex(index)
  }

  const removeStatement = () => {
    if (deleteStatementIndex == null) return
    updateStatements(statements => statements.filter((_, index) => index !== deleteStatementIndex))
    setSelectedStatement(Math.max(0, deleteStatementIndex - 1))
    setDeleteStatementIndex(null)
  }


  const generatedEplForStatement = (statement: EplStatement) => {
    if (!statement.template || !statement.params) return null
    try {
      return buildCepTemplate(statement.template as CepTemplateId, {
        ...statement.params,
        statementName: statement.name,
        label: statement.label || statement.name,
      } as unknown as CepTemplateParams)
    } catch {
      return null
    }
  }

  const openTemplateConflict = (targetDraft: EventStreamDraft) => {
    const index = targetDraft.statements.findIndex(statement => {
      if (!statement.template || !statement.params) return false
      const generatedEpl = generatedEplForStatement(statement)
      return Boolean(generatedEpl && generatedEpl.trim() !== statement.epl.trim())
    })
    if (index < 0) return false
    const generatedEpl = generatedEplForStatement(targetDraft.statements[index])
    if (!generatedEpl) return false
    setSelectedStatement(index)
    setTemplateConflict({ index, generatedEpl })
    return true
  }

  const switchToAdvanced = () => {
    if (!currentStatement) return
    const generatedEpl = generatedEplForStatement(currentStatement)
    if (generatedEpl && currentStatement.epl.trim() !== generatedEpl.trim()) {
      setTemplateConflict({ index: selectedStatement, generatedEpl })
      return
    }
    patchStatement(selectedStatement, { mode: 'advanced' })
  }

  const regenerateGuided = () => {
    if (!currentStatement?.template) return
    const generatedEpl = generatedEplForStatement(currentStatement)
    if (generatedEpl && currentStatement.epl.trim() !== generatedEpl.trim()) {
      setTemplateConflict({ index: selectedStatement, generatedEpl })
      return
    }
    applyGuidedRegeneration(selectedStatement)
  }

  const applyGuidedRegeneration = (index: number) => {
    const statement = currentDraft?.statements[index]
    if (!statement?.template) return
    try {
      const params = ({ ...(statement.params || {}), statementName: statement.name, label: statement.label || statement.name } as unknown) as CepTemplateParams
      patchStatement(index, applyTemplate(statement.template as CepTemplateId, params))
      setTemplateConflict(null)
    } catch (error) {
      patchStatement(index, { description: error instanceof Error ? error.message : '模板参数无效' })
      setTemplateConflict(null)
    }
  }

  const keepAdvancedEpl = (index: number) => {
    patchStatement(index, { mode: 'advanced', template: undefined, params: undefined })
    setTemplateConflict(null)
  }

  return (
    <div className="flex h-full min-h-0 bg-white">
      <aside className="w-72 shrink-0 border-r border-ink-border p-3">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold">事件流资产</h2><button className="primary-button h-8" onClick={() => void create()} disabled={createStream.isPending || bomPending}>{createStream.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />}新建</button></div>
        {isPending ? <p className="text-xs text-ink-3">加载中...</p> : streams.length ? streams.map(stream => <button key={stream.id} className={`mb-2 flex w-full items-center gap-2 border p-2 text-left text-xs ${active?.id === stream.id ? 'border-brand-primary bg-brand-primary-l' : 'border-ink-border'}`} onClick={() => { setSearchParams({ stream: stream.id }); setDraft(null); setSelectedStatement(0) }}><RadioTower size={14} /><span className="min-w-0 flex-1 truncate">{stream.name}</span><span className="text-[10px] text-ink-3">v{stream.version}</span></button>) : <p className="text-xs text-ink-3">暂无事件流，点击新建开始。</p>}
      </aside>
      <section className="min-w-0 flex-1 overflow-auto p-4">
        {!currentDraft ? <p className="text-xs text-ink-3">请选择或新建事件流。</p> : <div className="space-y-4">
          <div className="flex items-center justify-between gap-3"><div><input className="control-input text-sm font-semibold" value={currentDraft.name} onChange={event => setDraft({ ...currentDraft, name: event.target.value })} /><p className="mt-1 text-[11px] text-ink-3">事件检测语句集 · 默认引导式编辑</p></div><div className="flex flex-wrap gap-2"><button className="h-8 border border-ink-border px-3 text-[11px]" disabled={busy} onClick={() => void save()}>{activeOperation === 'save' ? <LoaderCircle size={13} className="animate-spin" /> : <Save size={13} />}{activeOperation === 'save' ? '保存中...' : '保存'}</button><button className="h-8 border border-brand-primary px-3 text-[11px] text-brand-primary" disabled={busy} onClick={() => void compileCurrent()}>{activeOperation === 'compile' ? <LoaderCircle size={13} className="animate-spin" /> : <Zap size={13} />}{activeOperation === 'compile' ? '编译中...' : '编译'}</button><button className="h-8 border border-ink-border px-3 text-[11px]" disabled={busy || !detail || !currentStatement} onClick={() => void saveAndCreateTest()}>{activeOperation === 'test' && <LoaderCircle size={13} className="animate-spin" />}{activeOperation === 'test' ? '处理中...' : '保存并新建测试'}</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white" disabled={busy || !detail} onClick={() => void publish()}>{activeOperation === 'publish' ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}{activeOperation === 'publish' ? '发布中...' : '保存并发布'}</button><button type="button" className="inline-flex size-8 items-center justify-center border border-[#da1e28] text-[#da1e28] hover:bg-[#fff1f1]" disabled={busy || !detail} onClick={() => setDeleteAssetOpen(true)} title="删除事件流"><Trash2 size={14} /></button></div></div>
          <textarea className="min-h-16 w-full border border-ink-border p-2 text-xs outline-none" placeholder="说明" value={currentDraft.description || ''} onChange={event => setDraft({ ...currentDraft, description: event.target.value })} />
          <div className="grid gap-4 xl:grid-cols-[280px_minmax(360px,1fr)_420px]">
            <div className="border border-ink-border p-3 text-xs">
              <div className="mb-2 flex gap-2"><button className="h-8 flex-1 border border-brand-primary text-brand-primary" onClick={() => setTemplatePickerOpen(!templatePickerOpen)}><Wand2 size={13} />从向导新建</button><button className="inline-flex size-8 items-center justify-center border border-ink-border" onClick={addAdvancedStatement} title="新建高级 EPL 语句"><Code2 size={13} /></button></div>
              {currentStatement && <div className="mb-3 flex h-8 items-center border border-ink-border bg-[#fafafa] px-2"><label className="flex items-center gap-1.5 text-[10px] text-ink-2"><input type="checkbox" checked={currentStatement.enabled !== false} onChange={event => patchStatement(selectedStatement, { enabled: event.target.checked })} />启用当前语句</label></div>}
              {templatePickerOpen && <div className="mb-3 space-y-2">{CEP_TEMPLATES.map(template => <button key={template.id} className="w-full border border-ink-border p-2 text-left hover:border-brand-primary" onClick={() => addTemplateStatement(template.id)}><div className="font-semibold">{template.name}</div><div className="mt-1 text-[11px] text-ink-3">{template.summary}</div></button>)}</div>}
              <div className="space-y-2">{currentDraft.statements.map((statement, index) => <div key={`${statement.name}-${index}`} className={`group flex w-full border ${selectedStatement === index ? 'border-brand-primary bg-brand-primary-l' : 'border-ink-border bg-white hover:border-brand-primary'}`}><button type="button" className="min-w-0 flex-1 p-2 text-left" onClick={() => setSelectedStatement(index)}><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{labelOf(statement)}</span><span className="rounded bg-ink-bg px-2 py-0.5 text-[10px] text-ink-3">{statement.mode === 'guided' ? '引导' : 'EPL'}</span></div><div className="mt-1 truncate font-mono text-[10px] text-ink-3">{statement.name}</div></button><button type="button" className={`inline-flex w-8 shrink-0 items-center justify-center border-l border-transparent text-[#da1e28] hover:border-[#ffd7d9] hover:bg-[#fff1f1] disabled:cursor-not-allowed disabled:text-ink-3 ${selectedStatement === index ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`} disabled={currentDraft.statements.length === 1} onClick={() => requestDeleteStatement(index)} title={currentDraft.statements.length === 1 ? '事件流至少需要一条语句' : `删除检测语句：${labelOf(statement)}`} aria-label={`删除检测语句：${labelOf(statement)}`}><Trash2 size={13} /></button></div>)}</div>
            </div>
            <div className="border border-ink-border p-3 text-xs">
              {currentStatement ? currentStatement.mode === 'guided' && currentStatement.template ? <GuidedForm statement={currentStatement} bom={bom} onChange={statement => patchStatement(selectedStatement, statement)} onAdvanced={switchToAdvanced} /> : <AdvancedEditor statement={currentStatement} onChange={statement => patchStatement(selectedStatement, statement)} onRegenerate={currentStatement.template ? regenerateGuided : undefined} /> : <p className="text-ink-3">请选择语句。</p>}
            </div>
            <div className="border border-ink-border p-3 text-xs">
              <div className="mb-2 flex items-center justify-between"><span className="font-semibold">EPL 预览</span>{currentStatement?.mode === 'guided' && <span className="rounded bg-brand-primary-l px-2 py-1 text-[10px] text-brand-primary"><Sparkles size={12} />引导生成</span>}</div>
              <pre className="min-h-56 overflow-auto whitespace-pre-wrap border border-ink-border bg-[#0f172a] p-3 font-mono text-[11px] leading-5 text-[#dbeafe]">{currentStatement?.epl || ''}</pre>
              {currentStatement?.description && <div className="mt-3 rounded border border-ink-border bg-ink-bg p-2 leading-5">{currentStatement.description}</div>}
              <div className="mt-3 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800"><AlertTriangle size={14} />当前 #time 窗口与 timer 使用 Esper 处理时间，不按 eventTime 回放；部署运行时的 timer 输出可由 webhook 异步接收。</div>
            </div>
          </div>
          {detail?.versions?.length ? <div className="border border-ink-border p-3 text-xs"><div className="mb-2 flex items-center gap-2 font-semibold"><FileClock size={14} />版本历史</div><div className="space-y-2">{detail.versions.slice().reverse().map(version => <div key={version.number} className="flex items-center justify-between border border-ink-border bg-[#fafafa] px-2 py-1"><span>v{version.number} · rev {version.assetRevision || '-'}</span><span className="text-ink-3">{version.createdBy || 'Team Server'} · {version.createdAt ? new Date(version.createdAt).toLocaleString() : '-'}</span></div>)}</div></div> : null}
          {(notice || compileStream.error || saveStream.error || deleteStream.error || publishStream.error || createTestSuite.error || detail?.validationError) && <div className="rounded border border-ink-border bg-ink-bg p-2 text-xs">{notice || compileStream.error?.message || saveStream.error?.message || deleteStream.error?.message || publishStream.error?.message || createTestSuite.error?.message || detail?.validationError}</div>}
        </div>}
      </section>
      {templateConflict && <Modal title="模板与高级 EPL 不一致" onClose={() => setTemplateConflict(null)}>
        <div className="space-y-3 p-4 text-xs leading-5">
          <p>当前语句的 EPL 已经偏离模板参数。请选择继续使用哪一份，避免静默覆盖。</p>
          <div className="rounded border border-ink-border bg-ink-bg p-2">
            <div className="mb-1 font-semibold">模板将生成</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{templateConflict.generatedEpl}</pre>
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3">
          <button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setTemplateConflict(null)}>取消</button>
          <button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => keepAdvancedEpl(templateConflict.index)}>保留高级 EPL</button>
          <button className="h-8 bg-brand-primary px-3 text-[11px] text-white" onClick={() => applyGuidedRegeneration(templateConflict.index)}>覆盖为模板生成</button>
        </footer>
      </Modal>}
      {deleteAssetOpen && detail && <Modal title="删除事件流" onClose={() => setDeleteAssetOpen(false)}>
        <div className="space-y-2 p-4 text-xs leading-5"><p>确定删除事件流“{detail.name}”吗？该操作会归档当前资产，未保存的修改将丢失。</p>{detail.version > 0 && <p className="text-[#a15c00]">该事件流已发布到 v{detail.version}。历史版本和既有 Release 保持不变，后续不能再用此资产创建新 Release。</p>}</div>
        <footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDeleteAssetOpen(false)}>取消</button><button className="h-8 bg-[#da1e28] px-3 text-[11px] text-white" disabled={deleteStream.isPending} onClick={() => void removeAsset()}>{deleteStream.isPending ? '删除中...' : '确认删除'}</button></footer>
      </Modal>}
      {deleteStatementIndex != null && currentDraft?.statements[deleteStatementIndex] && <Modal title="删除检测语句" onClose={() => setDeleteStatementIndex(null)}>
        <div className="p-4 text-xs leading-5">确定删除“{labelOf(currentDraft.statements[deleteStatementIndex])}”吗？保存事件流后该修改才会生效。</div>
        <footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDeleteStatementIndex(null)}>取消</button><button className="h-8 bg-[#da1e28] px-3 text-[11px] text-white" onClick={removeStatement}>确认删除</button></footer>
      </Modal>}
    </div>
  )
}

function AdvancedEditor({ statement, onChange, onRegenerate }: { statement: EplStatement; onChange: (patch: Partial<EplStatement>) => void; onRegenerate?: () => void }) {
  return <div className="space-y-3"><div className="flex items-center justify-between"><div><div className="font-semibold">高级 EPL</div>{statement.template && <div className="mt-1 text-[11px] text-amber-700">已从模板分叉，重新生成前会要求确认。</div>}</div>{onRegenerate && <button className="h-8 border border-ink-border px-3 text-[11px]" onClick={onRegenerate}>用模板重新生成</button>}</div><input className="control-input" value={statement.name} onChange={event => onChange({ name: event.target.value })} /><textarea className="min-h-80 w-full border border-ink-border p-3 font-mono text-xs outline-none" value={statement.epl} onChange={event => onChange({ epl: event.target.value, mode: 'advanced' })} /></div>
}

function GuidedForm({ statement, bom, onChange, onAdvanced }: { statement: EplStatement; bom: ReturnType<typeof useBom>['data']; onChange: (patch: Partial<EplStatement>) => void; onAdvanced: () => void }) {
  const templateId = statement.template as CepTemplateId
  const params = { ...((statement.params as unknown as Partial<CepTemplateParams>) || {}), statementName: statement.name, label: statement.label || '' } as CepTemplateParams
  const fields = fieldsForEventType(bom, params.eventType || '')
  const numeric = numericFields(fields)
  const update = (next: Partial<CepTemplateParams>) => {
    const merged = { ...params, ...next }
    try {
      const epl = buildCepTemplate(templateId, merged)
      onChange({ ...applyTemplate(templateId, merged), epl })
    } catch (error) {
      onChange({ params: merged as Record<string, unknown>, description: error instanceof Error ? error.message : '模板参数无效' })
    }
  }
  const needsField = templateId !== 'event-count'
  const needsWindow = templateId !== 'single-threshold'
  return <div className="space-y-3"><div className="flex items-center justify-between"><div><div className="font-semibold">{CEP_TEMPLATES.find(template => template.id === templateId)?.name}</div><div className="mt-1 text-[11px] text-ink-3">模板参数表单</div></div><button className="h-8 border border-ink-border px-3 text-[11px]" onClick={onAdvanced}>切换高级模式</button></div><label className="block"><span className="mb-1 block text-[11px] text-ink-3">中文检测名</span><input className="control-input" value={params.label || ''} onChange={event => update({ label: event.target.value })} /></label><label className="block"><span className="mb-1 block text-[11px] text-ink-3">语句 ID</span><input className="control-input" value={params.statementName || ''} onChange={event => update({ statementName: event.target.value })} /></label><label className="block"><span className="mb-1 block text-[11px] text-ink-3">事件源</span><select className="control-input" value={params.eventType || ''} onChange={event => update({ eventType: event.target.value, field: undefined, groupField: undefined })}>{bom?.eventTypes?.map(eventType => <option key={eventType.name} value={eventType.name}>{eventType.label || eventType.name}</option>)}</select></label>{needsWindow && <div className="grid grid-cols-3 gap-2"><label><span className="mb-1 block text-[11px] text-ink-3">窗口类型</span><select className="control-input" value={params.windowType || 'sliding'} onChange={event => update({ windowType: event.target.value as CepTemplateParams['windowType'] })}><option value="sliding">滑动</option><option value="tumbling">跳跃</option></select></label><label><span className="mb-1 block text-[11px] text-ink-3">窗口时长</span><input className="control-input" type="number" min={1} value={params.windowSize || 3} onChange={event => update({ windowSize: Number(event.target.value) })} /></label><label><span className="mb-1 block text-[11px] text-ink-3">单位</span><select className="control-input" value={params.windowUnit || 'minutes'} onChange={event => update({ windowUnit: event.target.value as CepTemplateParams['windowUnit'] })}><option value="seconds">秒</option><option value="minutes">分钟</option><option value="hours">小时</option></select></label></div>}{needsWindow && <label className="block"><span className="mb-1 block text-[11px] text-ink-3">分组字段</span><select className="control-input" value={params.groupField || ''} onChange={event => update({ groupField: event.target.value })}>{fields.map(field => <option key={field.key} value={field.key}>{field.group === '信封字段' ? '信封 · ' : ''}{field.label || field.key}</option>)}</select></label>}{needsField && <label className="block"><span className="mb-1 block text-[11px] text-ink-3">检测字段</span><select className="control-input" value={params.field || ''} onChange={event => update({ field: event.target.value })}>{(templateId === 'single-threshold' ? fields : numeric).map(field => <option key={field.key} value={field.key}>{field.label || field.key} · {field.type}</option>)}</select></label>}{['single-threshold', 'window-average'].includes(templateId) && <label className="block"><span className="mb-1 block text-[11px] text-ink-3">操作符</span><select className="control-input" value={params.operator || '>='} onChange={event => update({ operator: event.target.value })}><option value=">=">≥</option><option value=">">&gt;</option><option value="<=">≤</option><option value="<">&lt;</option><option value="=">=</option><option value="!=">≠</option></select></label>}<label className="block"><span className="mb-1 block text-[11px] text-ink-3">阈值</span><input className="control-input" value={String(params.delta ?? params.count ?? params.value ?? '')} onChange={event => templateId === 'window-fluctuation' ? update({ delta: event.target.value }) : templateId === 'event-count' ? update({ count: event.target.value }) : update({ value: event.target.value })} /></label></div>
}
