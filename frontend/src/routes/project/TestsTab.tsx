import { Archive, FlaskConical, LoaderCircle, Pencil, Play, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useBom } from '../../api/bom'
import { useRulesets } from '../../api/flows'
import { usePackages } from '../../api/projects'
import {
  useArchiveTestSuite, useCreateTestSuite, useRunAllTestSuites, useRunTestSuite,
  useTestSuites, useUpdateTestSuite,
} from '../../api/tests'
import type { ServerSuite, TestSuitePayload } from '../../api/tests'
import Modal from '../../components/Modal'
import TestComparisonPanel from '../../components/tests/TestComparisonPanel'
import TestCoverageSummary from '../../components/tests/TestCoverageSummary'
import TestResultTable from '../../components/tests/TestResultTable'
import TestRunDetail from '../../components/tests/TestRunDetail'
import TestSuiteDialog from '../../components/tests/TestSuiteDialog'
import type { TestTargetOption } from '../../components/tests/TestSuiteDialog'
import type { TestCase } from '../../types'

export default function TestsTab() {
  const { projectId } = useParams()
  const editable = Boolean(projectId)
  const { data: suites = [], isPending } = useTestSuites(projectId)
  const { data: bom } = useBom(projectId)
  const { data: packages = [] } = usePackages(projectId)
  const { data: rulesets = [] } = useRulesets(projectId)
  const runSuite = useRunTestSuite(projectId)
  const runAll = useRunAllTestSuites(projectId)
  const createSuite = useCreateTestSuite(projectId)
  const updateSuite = useUpdateTestSuite(projectId)
  const archiveSuite = useArchiveTestSuite(projectId)
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ initial?: ServerSuite } | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<ServerSuite | null>(null)
  const suite = suites.find(item => item.id === selectedSuiteId) ?? suites[0]

  const targets = useMemo<TestTargetOption[]>(() => [
    ...packages.flatMap(packageNode => packageNode.assets)
      .filter(asset => asset.status === 'published' && asset.type !== 'flow')
      .map(asset => ({
        id: asset.id, name: asset.name,
        type: ['decision-table', 'decision-tree', 'scorecard'].includes(asset.type) ? 'table' as const : 'rule' as const,
        version: asset.version,
      })),
    ...rulesets.filter(ruleset => ruleset.status === 'published').map(ruleset => ({
      id: ruleset.id, name: ruleset.flowName, type: 'flow' as const, version: String(ruleset.version || 1),
    })),
  ], [packages, rulesets])

  const failedCount = suite?.cases.filter(testCase => testCase.status === 'failed').length ?? 0
  const passedCount = suite?.cases.filter(testCase => testCase.status === 'passed').length ?? 0
  const targetPublished = !suite?.definition || Boolean(suite.definition.targetVersions?.length)
  const selectedCase = useMemo(() => suite?.cases.find(testCase => testCase.id === selectedId)
    ?? suite?.cases.find(testCase => testCase.status === 'failed')
    ?? suite?.cases[0], [selectedId, suite])
  const operationError = createSuite.error || updateSuite.error || archiveSuite.error || runSuite.error || runAll.error

  useEffect(() => {
    setSelectedSuiteId(null)
    setSelectedId(null)
    setDialog(null)
    setArchiveTarget(null)
  }, [projectId])

  useEffect(() => { setSelectedId(null) }, [suite?.id])

  const saveSuite = async (payload: TestSuitePayload) => {
    try {
      if (dialog?.initial) {
        const updated = await updateSuite.mutateAsync({ id: dialog.initial.id, revision: dialog.initial.revision, payload })
        setSelectedSuiteId(updated.id)
      } else {
        const created = await createSuite.mutateAsync(payload)
        setSelectedSuiteId(created.id)
      }
      setDialog(null)
    } catch {
      // React Query exposes the operation error inside the open dialog.
    }
  }

  const selectCase = (testCase: TestCase) => setSelectedId(testCase.id)

  if (isPending) return <div className="p-6 text-xs text-ink-3">正在加载测试套件...</div>

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="flex items-center gap-2 text-base font-medium"><FlaskConical size={17} />测试套件</h1>
            {suite && <select className="h-8 min-w-48 rounded-[2px] border border-ink-border bg-white px-2 text-xs" aria-label="选择测试套件" value={suite.id} onChange={event => setSelectedSuiteId(event.target.value)}>{suites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
            {suite?.required && <span className="rounded-[2px] bg-[#fff3e0] px-1.5 py-px text-[10px] text-env-staging">发布门禁</span>}
          </div>
          {suite ? <p className="mt-0.5 text-[11px] text-ink-3">{suites.length} 个套件 · 当前 {suite.cases.length} 个场景 · 目标 <span>{suite.target}</span> {suite.targetVersion} · 上次运行 {suite.lastRunAt} · <span className="font-medium text-env-production">{passedCount} 通过</span> / <span className="font-medium text-[#c62828]">{failedCount} 失败</span></p> : <p className="mt-0.5 text-[11px] text-ink-3">用业务场景持续验证已发布资产，并可作为 Release 门禁。</p>}
          {operationError && <p className="mt-1 text-[11px] text-[#c62828]">{operationError.message}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editable && suites.length > 0 && <button className="inline-flex h-9 items-center gap-1.5 border border-ink-border bg-white px-3 text-xs hover:border-brand-primary hover:text-brand-primary disabled:opacity-50" type="button" onClick={() => runAll.mutate()} disabled={runAll.isPending || runSuite.isPending}>{runAll.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}全量运行</button>}
          {editable && <button className="primary-button" type="button" onClick={() => { createSuite.reset(); updateSuite.reset(); setDialog({}) }}><Plus size={14} />新建套件</button>}
          {suite?.definition && editable && <><button type="button" className="inline-flex size-9 items-center justify-center border border-ink-border bg-white text-ink-2 hover:border-brand-primary hover:text-brand-primary" title="编辑测试套件" onClick={() => { createSuite.reset(); updateSuite.reset(); setDialog({ initial: suite.definition }) }}><Pencil size={14} /></button><button type="button" className="inline-flex size-9 items-center justify-center border border-ink-border bg-white text-ink-2 hover:border-[#c62828] hover:text-[#c62828]" title="归档测试套件" onClick={() => setArchiveTarget(suite.definition || null)}><Archive size={14} /></button></>}
          {suite && <button className="primary-button" type="button" onClick={() => runSuite.mutate(suite.id)} disabled={!targetPublished || runSuite.isPending || runAll.isPending} title={targetPublished ? '运行测试套件' : '测试目标发布后才能运行'}>{runSuite.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}{runSuite.isPending ? '运行中...' : targetPublished ? '运行套件' : '待目标发布'}</button>}
        </div>
      </div>

      {!suite ? <section className="flex min-h-64 flex-col items-center justify-center border border-dashed border-ink-border bg-white px-6 text-center"><FlaskConical size={28} className="text-ink-3" /><h2 className="mt-3 text-sm font-semibold">当前项目没有测试套件</h2><p className="mt-1 text-[11px] text-ink-3">可以提前为草稿准备测试场景；运行测试和发布门禁需要目标资产已发布。</p>{editable && <button className="primary-button mt-4" type="button" onClick={() => setDialog({})}><Plus size={14} />新建测试套件</button>}</section> : <div className="space-y-[14px]"><TestCoverageSummary coverage={suite.coverage} />{projectId && suite.definition && editable && <TestComparisonPanel key={suite.id} projectId={projectId} suite={suite.definition} />}<TestResultTable columns={suite.columns} cases={suite.cases} selectedId={selectedCase?.id ?? null} onSelect={selectCase} />{selectedCase && <TestRunDetail testCase={selectedCase} columns={suite.columns} />}</div>}

      {dialog && projectId && bom && <TestSuiteDialog key={`${dialog.initial?.id || 'new'}:${dialog.initial?.revision || 0}`} projectId={projectId} bom={bom} targets={targets} initial={dialog.initial} saving={createSuite.isPending || updateSuite.isPending} error={(createSuite.error || updateSuite.error)?.message} onClose={() => setDialog(null)} onSave={payload => void saveSuite(payload)} />}
      {archiveTarget && <Modal title="归档测试套件" onClose={() => setArchiveTarget(null)}><div className="p-4 text-xs">确定归档 <b>{archiveTarget.name}</b>？归档后该套件不再参与全量回归和 Release 门禁。</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button type="button" className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setArchiveTarget(null)}>取消</button><button type="button" className="h-8 bg-[#c62828] px-3 text-[11px] text-white disabled:opacity-50" disabled={archiveSuite.isPending} onClick={() => void archiveSuite.mutateAsync({ id: archiveTarget.id, revision: archiveTarget.revision }).then(() => { setArchiveTarget(null); setSelectedSuiteId(null) }).catch(() => {})}>确认归档</button></footer></Modal>}
    </div>
  )
}
