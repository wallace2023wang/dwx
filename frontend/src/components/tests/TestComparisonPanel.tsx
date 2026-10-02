import { GitCompareArrows, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useCompareTestSuite } from '../../api/tests'
import type { ServerComparisonReport, ServerSuite } from '../../api/tests'

const classification = {
  unchanged: { label: '未变化', className: 'text-ink-2' },
  changed: { label: '有变化', className: 'text-[#8a5a00]' },
  improved: { label: '已改善', className: 'text-env-production' },
  regressed: { label: '有回归', className: 'text-[#c62828]' },
}

function behaviorText(result: ServerComparisonReport['cases'][number]['candidate']) {
  if (result.error) return result.error
  const outputs = Object.entries(result.outputs || {}).map(([key, value]) => `${key}=${String(value)}`)
  if (result.fired?.length) outputs.push(`命中 ${result.fired.join('、')}`)
  if (result.path) outputs.push(`路径 ${result.path}`)
  return outputs.join(' · ') || '无输出'
}

export default function TestComparisonPanel({ projectId, suite }: { projectId: string; suite: ServerSuite }) {
  const compare = useCompareTestSuite(projectId)
  const versions = useMemo(() => [...(suite.targetVersions || [])].sort((a, b) => a - b), [suite.targetVersions])
  const latest = versions[versions.length - 1] || 1
  const [candidateVersion, setCandidateVersion] = useState(latest)
  const [baseVersion, setBaseVersion] = useState(versions[versions.length - 2] || latest)
  const savedReport = [...(suite.runs || [])].find((run): run is ServerComparisonReport => run.kind === 'comparison')
  const report = compare.data || savedReport

  useEffect(() => {
    setCandidateVersion(latest)
    setBaseVersion(versions[versions.length - 2] || latest)
    compare.reset()
  }, [suite.id, latest]) // eslint-disable-line react-hooks/exhaustive-deps

  if (versions.length < 2) return null
  return (
    <section className="border border-ink-border bg-white" aria-labelledby="comparison-title">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-border bg-[#fafafa] px-3 py-2">
        <h2 id="comparison-title" className="flex items-center gap-1.5 text-xs font-semibold"><GitCompareArrows size={14} />版本对比</h2>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-2">基线<select className="h-7 border border-ink-border bg-white px-2" value={baseVersion} onChange={event => setBaseVersion(Number(event.target.value))}>{versions.map(version => <option key={version} value={version}>v{version}</option>)}</select></label>
        <span className="text-ink-3">→</span>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-2">候选<select className="h-7 border border-ink-border bg-white px-2" value={candidateVersion} onChange={event => setCandidateVersion(Number(event.target.value))}>{versions.map(version => <option key={version} value={version}>v{version}</option>)}</select></label>
        <button type="button" className="inline-flex h-7 items-center gap-1 bg-brand-primary px-2.5 text-[11px] text-white disabled:opacity-40" disabled={baseVersion === candidateVersion || compare.isPending} onClick={() => compare.mutate({ suiteId: suite.id, baseVersion, candidateVersion })}>{compare.isPending ? <LoaderCircle size={12} className="animate-spin" /> : <GitCompareArrows size={12} />}开始对比</button>
      </header>
      {compare.error && <p className="px-3 py-2 text-[11px] text-[#c62828]">{compare.error.message}</p>}
      {!report ? <p className="px-3 py-5 text-center text-[11px] text-ink-3">选择两个已发布版本查看行为差异。</p> : <>
        <div className="grid grid-cols-5 border-b border-ink-border max-sm:grid-cols-2">
          {[
            ['待确认', report.summary.reviewRequired, 'text-brand-primary'],
            ['未变化', report.summary.unchanged, 'text-ink-2'],
            ['有变化', report.summary.changed, 'text-[#8a5a00]'],
            ['已改善', report.summary.improved, 'text-env-production'],
            ['有回归', report.summary.regressed, 'text-[#c62828]'],
          ].map(([label, value, className]) => <div key={String(label)} className="border-r border-ink-border px-3 py-2 last:border-r-0 max-sm:border-b"><div className="text-[10px] text-ink-3">{label}</div><strong className={`font-mono text-base ${className}`}>{value}</strong></div>)}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-ink-border px-3 py-2 text-[10px] text-ink-3"><span>v{report.baseVersion} 覆盖率 <b className="text-ink-1">{report.coverage.base.percentage}%</b></span><span>v{report.candidateVersion} 覆盖率 <b className="text-ink-1">{report.coverage.candidate.percentage}%</b></span></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[11px]"><thead className="bg-[#fafafa] text-ink-2"><tr><th className="px-3 py-2">场景 / 参数</th><th className="px-3 py-2">分类</th><th className="px-3 py-2">v{report.baseVersion}</th><th className="px-3 py-2">v{report.candidateVersion}</th></tr></thead><tbody>{report.cases.map(testCase => <tr key={testCase.id} className="border-t border-[#e8e8e8]"><td className="px-3 py-2 font-medium">{testCase.name}</td><td className={`px-3 py-2 font-semibold ${classification[testCase.classification].className}`}>{classification[testCase.classification].label}</td><td className="px-3 py-2">{testCase.base ? behaviorText(testCase.base) : '-'}</td><td className="px-3 py-2">{behaviorText(testCase.candidate)}</td></tr>)}</tbody></table></div>
      </>}
    </section>
  )
}
