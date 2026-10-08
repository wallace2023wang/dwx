import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Circle, Code2, FileClock, GripVertical, LoaderCircle, Plus, RadioTower, Save, Send, Sparkles, Trash2, Wand2, XCircle, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useBom } from '../../api/bom'
import Modal from '../../components/Modal'
import { useCompileEventStream, useCreateEventStream, useDeleteEventStream, useEventStream, useEventStreams, usePublishEventStream, useSaveEventStream, type EplStatement, type EventStreamDraft } from '../../api/eventStreams'
import { useCreateTestSuite } from '../../api/tests'
import { buildCepTemplate, CEP_TEMPLATES, defaultCepParams, describeCepTemplate, fieldsForEventType, numericFields, type CepOutputField, type CepTemplateId, type CepTemplateParams } from '../../lib/cepTemplates'
import { buildCepTestSkeleton } from '../../lib/cepTemplates'
import type { BomModel } from '../../types'

type EditorOperation = 'save' | 'compile' | 'test' | 'publish'

function draftFingerprint(draft: EventStreamDraft | null | undefined) {
  return draft ? JSON.stringify(draft) : ''
}

function runtimeFingerprint(draft: EventStreamDraft | null | undefined) {
  return draft ? JSON.stringify(draft.statements.map(statement => ({
    name: statement.name,
    epl: statement.epl,
    enabled: statement.enabled !== false,
  }))) : ''
}

function statementGroup(statement: EplStatement) {
  return statement.group?.trim() || '未分组'
}

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
    enabled: true,
    mode: 'guided',
    template: id,
    params: { ...params },
    epl,
  }
}

function statementSummary(statement: EplStatement | null) {
  if (!statement?.template || !statement.params) return ''
  try {
    return describeCepTemplate(statement.template as CepTemplateId, {
      ...statement.params,
      statementName: statement.name,
      label: statement.label || statement.name,
    } as unknown as CepTemplateParams)
  } catch {
    return ''
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
  const [descriptionOverwriteIndex, setDescriptionOverwriteIndex] = useState<number | null>(null)
  const [deleteAssetOpen, setDeleteAssetOpen] = useState(false)
  const [deleteStatementIndex, setDeleteStatementIndex] = useState<number | null>(null)
  const [activeOperation, setActiveOperation] = useState<EditorOperation | null>(null)
  const [draggedStatement, setDraggedStatement] = useState<number | null>(null)
  const [compiledFingerprint, setCompiledFingerprint] = useState('')
  const [failedFingerprint, setFailedFingerprint] = useState('')
  const currentDraft = draft || detail?.draft || null
  const currentStatement = currentDraft?.statements[selectedStatement] || currentDraft?.statements[0] || null
  const busy = activeOperation !== null || deleteStream.isPending || createStream.isPending
  const notice = localNotice
  const currentFingerprint = draftFingerprint(currentDraft)
  const currentRuntimeFingerprint = runtimeFingerprint(currentDraft)
  const isDirty = Boolean(draft && currentFingerprint !== draftFingerprint(detail?.draft))
  const runtimeChanged = currentRuntimeFingerprint !== runtimeFingerprint(detail?.draft)
  const descriptionError = (currentDraft?.description?.length || 0) > 500 || Boolean(currentDraft?.statements.some(statement => (statement.description?.length || 0) > 500))
  const compileState = activeOperation === 'compile'
    ? 'checking'
    : compiledFingerprint === currentRuntimeFingerprint && currentRuntimeFingerprint
      ? 'passed'
      : failedFingerprint === currentRuntimeFingerprint && currentRuntimeFingerprint
        ? 'failed'
        : 'idle'
  const currentSummary = statementSummary(currentStatement)
  const knownGroups = [...new Set((currentDraft?.statements || []).map(statementGroup).filter(group => group !== '未分组'))]
  const firstEventType = useMemo(() => bom?.eventTypes?.[0]?.name || bom?.factTypes?.find(fact => fact.direction !== 'output')?.name || 'DefaultEvent', [bom])

  const create = async () => {
    const created = await createStream.mutateAsync(defaultDraft(bom))
    setSearchParams({ stream: created.id })
    setDraft(created.draft)
    setSelectedStatement(0)
    setCompiledFingerprint('')
    setFailedFingerprint('')
  }

  const removeAsset = async () => {
    if (!detail) return
    await deleteStream.mutateAsync(detail.revision)
    const next = streams.find(stream => stream.id !== detail.id)
    setSearchParams(next ? { stream: next.id } : {})
    setDraft(null)
    setSelectedStatement(0)
    setCompiledFingerprint('')
    setFailedFingerprint('')
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

  const saveDraft = async (forceCompile = false) => {
    if (!detail || !currentDraft) return null
    if (openTemplateConflict(currentDraft)) return null
    const shouldCompile = forceCompile || runtimeChanged
    if (shouldCompile) {
      try {
        await compileStream.mutateAsync({ revision: detail.revision, draft: currentDraft })
        setCompiledFingerprint(currentRuntimeFingerprint)
        setFailedFingerprint('')
      } catch (error) {
        setFailedFingerprint(currentRuntimeFingerprint)
        setCompiledFingerprint('')
        throw error
      }
    }
    const saved = await saveStream.mutateAsync({ revision: detail.revision, draft: currentDraft })
    setDraft(saved.draft)
    if (shouldCompile) setCompiledFingerprint(runtimeFingerprint(saved.draft))
    return { ...saved, compiled: shouldCompile }
  }

  const save = async () => {
    clearFeedback()
    setActiveOperation('save')
    try {
      const saved = await saveDraft()
      if (saved) setLocalNotice(`保存成功，当前修订 r${saved.revision}。${saved.compiled ? '' : ' 本次仅修改作者信息，未重复编译 EPL。'}`)
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
      setCompiledFingerprint(currentRuntimeFingerprint)
      setFailedFingerprint('')
      setLocalNotice('编译通过，当前草稿可以保存或发布。')
    } catch {
      setFailedFingerprint(currentRuntimeFingerprint)
      setCompiledFingerprint('')
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
      const saved = await saveDraft(true)
      if (!saved) return
      const published = await publishStream.mutateAsync(saved.revision)
      setDraft(published.draft)
      setCompiledFingerprint(runtimeFingerprint(published.draft))
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

  const moveStatement = (from: number, to: number) => {
    if (!currentDraft || from === to || from < 0 || to < 0 || from >= currentDraft.statements.length || to >= currentDraft.statements.length) return
    updateStatements(statements => {
      const next = [...statements]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    if (selectedStatement === from) setSelectedStatement(to)
    else if (from < selectedStatement && to >= selectedStatement) setSelectedStatement(selectedStatement - 1)
    else if (from > selectedStatement && to <= selectedStatement) setSelectedStatement(selectedStatement + 1)
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
      setLocalNotice(error instanceof Error ? error.message : '模板参数无效')
      setTemplateConflict(null)
    }
  }

  const generateDescription = (index: number) => {
    const statement = currentDraft?.statements[index]
    const summary = statementSummary(statement || null)
    if (!statement || !summary) return
    if (statement.description?.trim()) {
      setDescriptionOverwriteIndex(index)
      return
    }
    patchStatement(index, { description: summary })
  }

  const overwriteDescription = () => {
    if (descriptionOverwriteIndex == null) return
    const statement = currentDraft?.statements[descriptionOverwriteIndex]
    const summary = statementSummary(statement || null)
    if (statement && summary) patchStatement(descriptionOverwriteIndex, { description: summary })
    setDescriptionOverwriteIndex(null)
  }

  const keepAdvancedEpl = (index: number) => {
    patchStatement(index, { mode: 'advanced', template: undefined, params: undefined })
    setTemplateConflict(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white lg:flex-row">
      <aside className="max-h-64 w-full shrink-0 overflow-auto border-b border-ink-border p-3 lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold">事件流资产</h2><button className="primary-button h-8" onClick={() => void create()} disabled={createStream.isPending || bomPending}>{createStream.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />}新建</button></div>
        {isPending ? <p className="text-xs text-ink-3">加载中...</p> : streams.length ? streams.map(stream => {
          const selected = active?.id === stream.id
          const locallyDirty = selected && isDirty
          const draftChanged = stream.hasDraftChanges || locallyDirty
          return <button key={stream.id} className={`mb-2 w-full border p-2 text-left text-xs ${selected ? 'border-brand-primary bg-brand-primary-l' : 'border-ink-border bg-white hover:border-brand-primary'}`} onClick={() => { setSearchParams({ stream: stream.id }); setDraft(null); setSelectedStatement(0); setCompiledFingerprint(''); setFailedFingerprint('') }}>
            <span className="flex items-center gap-2"><RadioTower size={14} className={selected ? 'text-brand-primary' : 'text-ink-3'} /><span className="min-w-0 flex-1 truncate">{stream.name}</span>{draftChanged && <span className="size-2 shrink-0 rounded-full bg-[#f1a10d]" title={locallyDirty ? '有未保存修改' : '已发布版本后有草稿修改'} />}</span>
            <span className="mt-1.5 flex items-center justify-between pl-[22px]"><span className={`inline-flex items-center gap-1 text-[10px] ${stream.status === 'published' ? 'text-[#198038]' : 'text-[#a15c00]'}`}><span className={`size-1.5 rounded-full ${stream.status === 'published' ? 'bg-[#24a148]' : 'bg-[#f1a10d]'}`} />{stream.status === 'published' ? '已发布' : '草稿'}</span><span className="text-[10px] text-ink-3">{stream.version > 0 ? `v${stream.version}` : `r${stream.revision}`}</span></span>
          </button>
        }) : <p className="text-xs text-ink-3">暂无事件流，点击新建开始。</p>}
      </aside>
      <section className="min-w-0 flex-1 overflow-auto p-4">
        {!currentDraft ? <p className="text-xs text-ink-3">请选择或新建事件流。</p> : <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-[240px] flex-1"><input className="control-input max-w-xl text-sm font-semibold" value={currentDraft.name} onChange={event => setDraft({ ...currentDraft, name: event.target.value })} /><div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]"><span className={`inline-flex items-center gap-1 ${active?.status === 'published' ? 'text-[#198038]' : 'text-[#a15c00]'}`}><Circle size={7} fill="currentColor" />{active?.status === 'published' ? `已发布 v${active.version}` : '草稿'}</span><span className="text-ink-3">修订 r{detail?.revision ?? active?.revision ?? '-'}</span>{active?.hasDraftChanges && <span className="inline-flex items-center gap-1 bg-[#fff3e0] px-1.5 py-0.5 text-[#a15c00]"><Circle size={6} fill="currentColor" />草稿有修改</span>}{isDirty && <span className="inline-flex items-center gap-1 bg-[#fff3e0] px-1.5 py-0.5 text-[#a15c00]"><Circle size={6} fill="currentColor" />未保存</span>}{compileState === 'passed' && <span className="inline-flex items-center gap-1 bg-[#e8f5e9] px-1.5 py-0.5 text-[#198038]"><CheckCircle2 size={11} />编译通过</span>}{compileState === 'failed' && <span className="inline-flex items-center gap-1 bg-[#fff1f1] px-1.5 py-0.5 text-[#da1e28]"><XCircle size={11} />编译失败</span>}{compileState === 'idle' && <span className="text-ink-3">未校验</span>}</div>
            </div>
            <div className="flex flex-wrap justify-end gap-2"><button className="h-8 border border-ink-border px-3 text-[11px]" disabled={busy || !isDirty || descriptionError} onClick={() => void save()}>{activeOperation === 'save' ? <LoaderCircle size={13} className="animate-spin" /> : <Save size={13} />}{activeOperation === 'save' ? '保存中...' : '保存'}</button><button className="h-8 border border-brand-primary px-3 text-[11px] text-brand-primary" disabled={busy || descriptionError} onClick={() => void compileCurrent()}>{activeOperation === 'compile' ? <LoaderCircle size={13} className="animate-spin" /> : <Zap size={13} />}{activeOperation === 'compile' ? '编译中...' : '编译'}</button><button className="h-8 border border-ink-border px-3 text-[11px]" disabled={busy || !detail || !currentStatement || descriptionError} onClick={() => void saveAndCreateTest()}>{activeOperation === 'test' && <LoaderCircle size={13} className="animate-spin" />}{activeOperation === 'test' ? '处理中...' : '保存并新建测试'}</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white" disabled={busy || !detail || descriptionError} onClick={() => void publish()}>{activeOperation === 'publish' ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}{activeOperation === 'publish' ? '发布中...' : '保存并发布'}</button><button type="button" className="inline-flex size-8 items-center justify-center border border-[#da1e28] text-[#da1e28] hover:bg-[#fff1f1]" disabled={busy || !detail} onClick={() => setDeleteAssetOpen(true)} title="删除事件流"><Trash2 size={14} /></button></div>
          </div>
          <label className="block text-xs"><span className="mb-1 flex items-center justify-between text-[11px] text-ink-3"><span>事件流说明</span><span className={(currentDraft.description?.length || 0) > 500 ? 'text-[#da1e28]' : ''}>{currentDraft.description?.length || 0} / 500</span></span><textarea aria-label="事件流说明" className={`min-h-16 w-full resize-y border p-2 text-xs outline-none ${(currentDraft.description?.length || 0) > 500 ? 'border-[#da1e28]' : 'border-ink-border focus:border-brand-primary'}`} placeholder="说明整个事件流的业务目标、输入和输出范围" value={currentDraft.description || ''} onChange={event => setDraft({ ...currentDraft, description: event.target.value })} />{(currentDraft.description?.length || 0) > 500 && <span className="mt-1 block text-[10px] text-[#da1e28]">事件流说明不能超过 500 字</span>}</label>
          <div className="grid gap-4 xl:grid-cols-[280px_minmax(360px,1fr)_420px]">
            <div className="border border-ink-border p-3 text-xs">
              <div className="mb-2 flex gap-2"><button className="h-8 flex-1 border border-brand-primary text-brand-primary" onClick={() => setTemplatePickerOpen(!templatePickerOpen)}><Wand2 size={13} />从向导新建</button><button className="inline-flex size-8 items-center justify-center border border-ink-border" onClick={addAdvancedStatement} title="新建高级 EPL 语句"><Code2 size={13} /></button></div>
              {currentStatement && <div className="mb-3 flex h-8 items-center border border-ink-border bg-[#fafafa] px-2"><label className="flex items-center gap-1.5 text-[10px] text-ink-2"><input type="checkbox" checked={currentStatement.enabled !== false} onChange={event => patchStatement(selectedStatement, { enabled: event.target.checked })} />启用当前语句</label></div>}
              {templatePickerOpen && <div className="mb-3 space-y-2">{CEP_TEMPLATES.map(template => <button key={template.id} className="w-full border border-ink-border p-2 text-left hover:border-brand-primary" onClick={() => addTemplateStatement(template.id)}><div className="font-semibold">{template.name}</div><div className="mt-1 text-[11px] text-ink-3">{template.summary}</div></button>)}</div>}
              <datalist id="event-stream-groups">{knownGroups.map(group => <option key={group} value={group} />)}</datalist>
              <div className="space-y-1">{currentDraft.statements.map((statement, index) => {
                const groupName = statementGroup(statement)
                const showGroup = index === 0 || groupName !== statementGroup(currentDraft.statements[index - 1])
                return <div key={`${statement.name}-${index}`}>
                  {showGroup && <div className="mb-1 mt-3 flex items-center gap-2 text-[10px] font-semibold text-ink-3 first:mt-0"><span className="h-px flex-1 bg-ink-border" /><span className="max-w-[180px] truncate">{groupName}</span><span className="h-px flex-1 bg-ink-border" /></div>}
                  <div draggable onDragStart={() => setDraggedStatement(index)} onDragEnd={() => setDraggedStatement(null)} onDragOver={event => event.preventDefault()} onDrop={() => { if (draggedStatement != null) moveStatement(draggedStatement, index); setDraggedStatement(null) }} className={`group flex w-full border ${draggedStatement === index ? 'opacity-50' : ''} ${selectedStatement === index ? 'border-brand-primary bg-brand-primary-l' : 'border-ink-border bg-white hover:border-brand-primary'}`}>
                    <span className="inline-flex w-6 shrink-0 cursor-grab items-center justify-center text-ink-3" title="拖动排序"><GripVertical size={13} /></span>
                    <button type="button" className="min-w-0 flex-1 py-2 text-left" onClick={() => setSelectedStatement(index)}><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{labelOf(statement)}</span><span className="bg-ink-bg px-1.5 py-0.5 text-[10px] text-ink-3">{statement.mode === 'guided' ? '引导' : 'EPL'}</span></div><div className="mt-1 truncate font-mono text-[10px] text-ink-3">{statement.name}</div>{statement.description?.trim() && <div className="mt-1 truncate text-[10px] text-ink-2">{statement.description}</div>}</button>
                    <span className={`flex shrink-0 items-stretch ${selectedStatement === index ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}><button type="button" className="inline-flex w-6 items-center justify-center text-ink-3 hover:bg-white hover:text-brand-primary disabled:opacity-30" disabled={index === 0} onClick={() => moveStatement(index, index - 1)} title="上移语句" aria-label={`上移：${labelOf(statement)}`}><ArrowUp size={12} /></button><button type="button" className="inline-flex w-6 items-center justify-center text-ink-3 hover:bg-white hover:text-brand-primary disabled:opacity-30" disabled={index === currentDraft.statements.length - 1} onClick={() => moveStatement(index, index + 1)} title="下移语句" aria-label={`下移：${labelOf(statement)}`}><ArrowDown size={12} /></button><button type="button" className="inline-flex w-7 items-center justify-center text-[#da1e28] hover:bg-[#fff1f1] disabled:cursor-not-allowed disabled:text-ink-3" disabled={currentDraft.statements.length === 1} onClick={() => requestDeleteStatement(index)} title={currentDraft.statements.length === 1 ? '事件流至少需要一条语句' : `删除检测语句：${labelOf(statement)}`} aria-label={`删除检测语句：${labelOf(statement)}`}><Trash2 size={12} /></button></span>
                  </div>
                </div>
              })}</div>
            </div>
            <div className="border border-ink-border p-3 text-xs">
              {currentStatement ? <div className="space-y-3"><label className="block"><span className="mb-1 block text-[11px] text-ink-3">语句分组</span><input className="control-input" list="event-stream-groups" maxLength={80} placeholder="未分组" value={currentStatement.group || ''} onChange={event => patchStatement(selectedStatement, { group: event.target.value || undefined })} /></label><label className="block"><span className="mb-1 flex items-center justify-between text-[11px] text-ink-3"><span>业务说明</span><span className={(currentStatement.description?.length || 0) > 500 ? 'text-[#da1e28]' : ''}>{currentStatement.description?.length || 0} / 500</span></span><textarea aria-label="业务说明" className={`min-h-20 w-full resize-y border p-2 text-xs outline-none ${(currentStatement.description?.length || 0) > 500 ? 'border-[#da1e28]' : 'border-ink-border focus:border-brand-primary'}`} placeholder="说明该语句检测什么、适用场景以及命中后的业务结果" value={currentStatement.description || ''} onChange={event => patchStatement(selectedStatement, { description: event.target.value })} />{(currentStatement.description?.length || 0) > 500 && <span className="mt-1 block text-[10px] text-[#da1e28]">业务说明不能超过 500 字</span>} {!currentStatement.description?.trim() && <span className="mt-1 block text-[10px] text-[#a15c00]">建议补充业务说明，便于评审和运维理解。</span>}{currentSummary && <button type="button" className="mt-2 h-7 border border-ink-border px-2 text-[10px]" onClick={() => generateDescription(selectedStatement)}>按当前配置生成说明</button>}</label>{currentStatement.mode === 'guided' && currentStatement.template ? <GuidedForm statement={currentStatement} bom={bom} onChange={statement => patchStatement(selectedStatement, statement)} onAdvanced={switchToAdvanced} /> : <AdvancedEditor statement={currentStatement} onChange={statement => patchStatement(selectedStatement, statement)} onRegenerate={currentStatement.template ? regenerateGuided : undefined} />}</div> : <p className="text-ink-3">请选择语句。</p>}
            </div>
            <div className="border border-ink-border p-3 text-xs">
              <div className="mb-2 flex items-center justify-between"><span className="font-semibold">EPL 预览</span>{currentStatement?.mode === 'guided' && <span className="rounded bg-brand-primary-l px-2 py-1 text-[10px] text-brand-primary"><Sparkles size={12} />引导生成</span>}</div>
              <pre className="min-h-56 overflow-auto whitespace-pre-wrap border border-ink-border bg-[#0f172a] p-3 font-mono text-[11px] leading-5 text-[#dbeafe]">{currentStatement?.epl || ''}</pre>
              <div className="mt-3 rounded border border-ink-border bg-ink-bg p-2 leading-5"><div className="mb-1 text-[10px] font-semibold text-ink-3">自动语义摘要</div>{currentSummary || <span className="text-ink-3">高级 EPL 暂无自动摘要，请在业务说明中描述用途。</span>}</div>
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
      {descriptionOverwriteIndex != null && currentDraft?.statements[descriptionOverwriteIndex] && <Modal title="覆盖业务说明" onClose={() => setDescriptionOverwriteIndex(null)}>
        <div className="space-y-3 p-4 text-xs leading-5"><p>当前语句已有人工维护的业务说明。是否使用当前模板配置生成的摘要覆盖它？</p><div className="rounded border border-ink-border bg-ink-bg p-2"><div className="mb-1 font-semibold">将覆盖为</div>{statementSummary(currentDraft.statements[descriptionOverwriteIndex])}</div></div>
        <footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDescriptionOverwriteIndex(null)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white" onClick={overwriteDescription}>确认覆盖</button></footer>
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
    } catch {
      onChange({ params: merged as unknown as Record<string, unknown> })
    }
  }
  const needsField = templateId !== 'event-count'
  const needsWindow = templateId !== 'single-threshold'
  return <div className="space-y-3">
    <div className="flex items-center justify-between"><div><div className="font-semibold">{CEP_TEMPLATES.find(template => template.id === templateId)?.name}</div><div className="mt-1 text-[11px] text-ink-3">模板参数表单</div></div><button className="h-8 border border-ink-border px-3 text-[11px]" onClick={onAdvanced}>切换高级模式</button></div>
    <label className="block"><span className="mb-1 block text-[11px] text-ink-3">中文检测名</span><input className="control-input" value={params.label || ''} onChange={event => update({ label: event.target.value })} /></label>
    <label className="block"><span className="mb-1 block text-[11px] text-ink-3">语句 ID</span><input className="control-input" value={params.statementName || ''} onChange={event => update({ statementName: event.target.value })} /></label>
    <label className="block"><span className="mb-1 block text-[11px] text-ink-3">事件源</span><select className="control-input" value={params.eventType || ''} onChange={event => update({ eventType: event.target.value, field: undefined, groupField: undefined, outputFields: undefined })}>{bom?.eventTypes?.map(eventType => <option key={eventType.name} value={eventType.name}>{eventType.label || eventType.name}</option>)}</select></label>
    {needsWindow && <div className="grid grid-cols-3 gap-2"><label><span className="mb-1 block text-[11px] text-ink-3">窗口类型</span><select className="control-input" value={params.windowType || 'sliding'} onChange={event => update({ windowType: event.target.value as CepTemplateParams['windowType'] })}><option value="sliding">滑动</option><option value="tumbling">跳跃</option></select></label><label><span className="mb-1 block text-[11px] text-ink-3">窗口时长</span><input className="control-input" type="number" min={1} value={params.windowSize || 3} onChange={event => update({ windowSize: Number(event.target.value) })} /></label><label><span className="mb-1 block text-[11px] text-ink-3">单位</span><select className="control-input" value={params.windowUnit || 'minutes'} onChange={event => update({ windowUnit: event.target.value as CepTemplateParams['windowUnit'] })}><option value="seconds">秒</option><option value="minutes">分钟</option><option value="hours">小时</option></select></label></div>}
    {needsWindow && <label className="block"><span className="mb-1 block text-[11px] text-ink-3">分组字段</span><select className="control-input" value={params.groupField || ''} onChange={event => update({ groupField: event.target.value })}>{fields.map(field => <option key={field.key} value={field.key}>{field.group === '信封字段' ? '信封 · ' : ''}{field.label || field.key}</option>)}</select></label>}
    {needsField && <label className="block"><span className="mb-1 block text-[11px] text-ink-3">检测字段</span><select className="control-input" value={params.field || ''} onChange={event => update({ field: event.target.value })}>{(templateId === 'single-threshold' ? fields : numeric).map(field => <option key={field.key} value={field.key}>{field.label || field.key} · {field.type}</option>)}</select></label>}
    {['single-threshold', 'window-average'].includes(templateId) && <label className="block"><span className="mb-1 block text-[11px] text-ink-3">操作符</span><select className="control-input" value={params.operator || '>='} onChange={event => update({ operator: event.target.value })}><option value=">=">≥</option><option value=">">&gt;</option><option value="<=">≤</option><option value="<">&lt;</option><option value="=">=</option><option value="!=">≠</option></select></label>}
    <label className="block"><span className="mb-1 block text-[11px] text-ink-3">阈值</span><input className="control-input" value={String(params.delta ?? params.count ?? params.value ?? '')} onChange={event => templateId === 'window-fluctuation' ? update({ delta: event.target.value }) : templateId === 'event-count' ? update({ count: event.target.value }) : update({ value: event.target.value })} /></label>
    {templateId === 'single-threshold' && <OutputFieldsEditor fields={fields} value={params.outputFields || []} onChange={outputFields => update({ outputFields: outputFields.length ? outputFields : undefined })} />}
  </div>
}

function OutputFieldsEditor({ fields, value, onChange }: { fields: ReturnType<typeof fieldsForEventType>; value: CepOutputField[]; onChange: (value: CepOutputField[]) => void }) {
  const patch = (index: number, next: CepOutputField) => onChange(value.map((item, itemIndex) => itemIndex === index ? next : item))
  const addField = () => {
    const field = fields[0]?.key || 'eventKey'
    onChange([...value, { alias: field, source: 'field', field }])
  }
  const addConstant = () => onChange([...value, { alias: `output${value.length + 1}`, source: 'constant', value: '' }])
  return <section className="border-t border-ink-border pt-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><div className="font-semibold">派生输出字段</div><div className="mt-1 text-[10px] text-ink-3">为空时输出原事件全部字段</div></div><div className="flex gap-1"><button type="button" className="h-7 border border-ink-border px-2 text-[10px] disabled:opacity-40" disabled={value.length >= 50} onClick={addField}><Plus size={11} />源字段</button><button type="button" className="h-7 border border-ink-border px-2 text-[10px] disabled:opacity-40" disabled={value.length >= 50} onClick={addConstant}><Plus size={11} />固定值</button></div></div>
    <div className="space-y-2">{value.map((output, index) => {
      const constantType = output.source === 'constant' ? typeof output.value : 'string'
      return <div key={index} className="border border-ink-border bg-[#fafafa] p-2">
        <div className="grid grid-cols-[96px_minmax(0,1fr)_28px] gap-2">
          <select className="control-input h-8" aria-label={`输出 ${index + 1} 来源`} value={output.source} onChange={event => event.target.value === 'field' ? patch(index, { alias: output.alias, source: 'field', field: fields[0]?.key || 'eventKey' }) : patch(index, { alias: output.alias, source: 'constant', value: '' })}><option value="field">业务字段</option><option value="constant">固定值</option></select>
          {output.source === 'field' ? <select className="control-input h-8" aria-label={`输出 ${index + 1} 源字段`} value={output.field} onChange={event => patch(index, { ...output, field: event.target.value })}>{fields.map(field => <option key={field.key} value={field.key}>{field.label || field.key} · {field.key}</option>)}</select> : <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-1"><select className="control-input h-8" aria-label={`输出 ${index + 1} 固定值类型`} value={constantType} onChange={event => patch(index, { ...output, value: event.target.value === 'number' ? 0 : event.target.value === 'boolean' ? false : '' })}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔</option></select>{constantType === 'boolean' ? <select className="control-input h-8" aria-label={`输出 ${index + 1} 固定值`} value={String(output.value)} onChange={event => patch(index, { ...output, value: event.target.value === 'true' })}><option value="true">true</option><option value="false">false</option></select> : <input className="control-input h-8" type={constantType === 'number' ? 'number' : 'text'} aria-label={`输出 ${index + 1} 固定值`} value={String(output.value)} onChange={event => patch(index, { ...output, value: constantType === 'number' ? Number(event.target.value) : event.target.value })} />}</div>}
          <button type="button" className="inline-flex size-7 items-center justify-center text-[#da1e28] hover:bg-[#fff1f1]" onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))} title="删除输出字段" aria-label={`删除输出字段 ${index + 1}`}><Trash2 size={12} /></button>
        </div>
        <label className="mt-2 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2"><span className="text-[10px] text-ink-3">输出别名</span><input className="control-input h-8 font-mono" value={output.alias} maxLength={64} onChange={event => patch(index, { ...output, alias: event.target.value })} /></label>
      </div>
    })}</div>
  </section>
}
