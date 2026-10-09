import { ArrowLeft, Download, Printer } from 'lucide-react'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useBom } from '../../api/bom'
import { usePackages, useProject, useAssetDetail } from '../../api/projects'
import { downloadProjectReport } from '../../api/report'
import { useReleases } from '../../api/releases'
import { useRulesets } from '../../api/flows'
import { useTestSuites } from '../../api/tests'
import type { BomModel, PackageNode, ReleaseRecord } from '../../types'

function date(valueToFormat?: string) {
  if (!valueToFormat) return '—'
  const parsed = new Date(valueToFormat)
  return Number.isNaN(parsed.valueOf()) ? valueToFormat : parsed.toLocaleString('zh-CN', { hour12: false })
}

function Section({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return <section className="report-section"><h2><span>{number}</span>{title}</h2>{children}</section>
}

function Kpi({ label, value: content }: { label: string; value: string | number }) {
  return <div className="report-kpi"><strong>{content}</strong><span>{label}</span></div>
}

function BomSection({ bom }: { bom: BomModel }) {
  const fields = bom.factTypes.flatMap(fact => fact.fields)
  const types = [...fields.reduce((map, field) => map.set(field.type, (map.get(field.type) || 0) + 1), new Map<string, number>())]
  return <>
    <table className="report-table"><thead><tr><th>事实类型</th><th>业务名称</th><th>方向</th><th>字段数</th></tr></thead><tbody>
      {bom.factTypes.length ? bom.factTypes.map(fact => <tr key={fact.name}><td>{fact.name}</td><td>{fact.label}</td><td>{fact.direction}</td><td>{fact.fields.length}</td></tr>) : <tr><td colSpan={4} className="report-empty">暂无事实类型</td></tr>}
    </tbody></table>
    <div className="report-stat-row">{types.length ? types.map(([type, count]) => <span className="report-stat" key={type}><b>{count}</b>{type}</span>) : <span className="report-muted">暂无字段</span>}</div>
  </>
}

function AssetDescription({ projectId, assetId }: { projectId: string; assetId: string }) {
  const { data: detail, isLoading } = useAssetDetail(projectId, assetId)
  if (isLoading) return <span className="report-muted">加载中…</span>
  return <>{detail?.draft?.description || '—'}</>
}

function DecisionTableDetail({ projectId, assetId }: { projectId: string; assetId: string }) {
  const { data: detail, isLoading } = useAssetDetail(projectId, assetId)
  if (isLoading) return null
  const table = detail?.decisionTable
  if (!table) return null
  const conditionColumns = table.columns.filter(column => column.kind === 'condition')
  const actionColumns = table.columns.filter(column => column.kind === 'action')
  const hitPolicyLabel: Record<string, string> = { FIRST: '首个命中', PRIORITY: '按优先级', COLLECT: '收集全部命中', ALL: '全部命中' }
  return (
    <tr className="report-dt-row"><td colSpan={6} className="report-dt-cell">
      <div className="report-dt">
        <div className="report-dt-head"><b>决策表内容</b><span>命中策略：{hitPolicyLabel[table.hitPolicy] || table.hitPolicy}</span></div>
        <p className="report-dt-cols">条件列：{conditionColumns.map(column => column.label).join('、')}　·　动作列：{actionColumns.map(column => column.label).join('、')}</p>
        <table className="report-dt-table">
          <thead><tr><th className="report-dt-no">#</th><th>条件</th><th>动作</th></tr></thead>
          <tbody>
            {table.rows.map((row, index) => {
              const conditionText = conditionColumns.map(column => { const value = formatTableValue(row[column.id]); return value ? `${column.label} ${value}` : '' }).filter(Boolean).join('；') || '—'
              const actionText = actionColumns.map(column => { const value = formatTableValue(row[column.id]); return value ? `${column.label} = ${value}` : '' }).filter(Boolean).join('；') || '—'
              return <tr key={index}><td className="report-dt-no">{index + 1}</td><td className="report-dt-cond">{conditionText}</td><td className="report-dt-action">{actionText}</td></tr>
            })}
          </tbody>
        </table>
      </div>
    </td></tr>
  )
}

function formatTableValue(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  const text = String(value).trim()
  if (!text) return ''
  if (text === 'true') return '是'
  if (text === 'false') return '否'
  const op = text.match(/^(>=|<=|!=|==|>|<)/)
  if (op) {
    const labels: Record<string, string> = { '>=': '大于等于', '<=': '小于等于', '!=': '不等于', '==': '等于', '>': '大于', '<': '小于' }
    return `${labels[op[1]]} ${text.slice(op[1].length).trim()}`
  }
  const closed = text.match(/^([\d.]+)\.\.([\d.]+)$/)
  if (closed) return `${closed[1]} 至 ${closed[2]}`
  const openStart = text.match(/^([\d.]+)\.\.$/)
  if (openStart) return `${openStart[1]} 及以上`
  const openEnd = text.match(/^\.\.([\d.]+)$/)
  if (openEnd) return `${openEnd[1]} 及以下`
  return text
}

function AssetSections({ projectId, packages }: { projectId: string; packages: PackageNode[] }) {
  return <div>{packages.length ? packages.map(pkg => <div className="report-asset-group" key={pkg.id}><h3>{pkg.label} <small>{pkg.name}</small></h3>{pkg.assets.length ? <table className="report-table"><thead><tr><th>资产名称</th><th>类型</th><th>状态</th><th>版本</th><th>中文描述</th><th>BOM</th></tr></thead><tbody>{pkg.assets.flatMap(asset => {
    const summary = <tr key={`${asset.id}-s`}><td className="report-col-name">{asset.name}</td><td>{assetTypeLabel(asset.type)}</td><td><span className={`report-status ${asset.status}`}>{({ draft: '草稿', 'in-review': '审核中', rejected: '已驳回', published: '已发布', deprecated: '已废弃', archived: '已归档' } as Record<string, string>)[asset.status] || asset.status}</span></td><td>{asset.version}</td><td className="report-col-desc"><AssetDescription projectId={projectId} assetId={asset.id} /></td><td>{asset.bomInvalid ? <span className="report-warning">BOM 失效</span> : '正常'}</td></tr>
    return asset.type === 'decision-table' ? [summary, <DecisionTableDetail key={`${asset.id}-d`} projectId={projectId} assetId={asset.id} />] : [summary]
  })}</tbody></table> : <p className="report-empty">（空）</p>}</div>) : <p className="report-empty">暂无规则资产</p>}</div>
}

function assetTypeLabel(type: PackageNode['assets'][number]['type']) {
  if (type === 'decision-table') return '决策表'
  if (type === 'decision-tree') return '决策树'
  if (type === 'scorecard') return '计分卡'
  return '规则'
}

export default function Report() {
  const { projectId } = useParams()
  const { data: project, isPending: projectPending } = useProject(projectId)
  const { data: bom, isPending: bomPending } = useBom(projectId)
  const { data: packages = [], isPending: packagesPending } = usePackages(projectId)
  const { data: rulesets = [] } = useRulesets(projectId)
  const { data: suites = [] } = useTestSuites(projectId)
  const { data: releases = [] } = useReleases(projectId)
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const assets = packages.flatMap(pkg => pkg.assets)
  const rules = assets.filter(asset => asset.type === 'rule')
  const tables = assets.filter(asset => asset.type === 'decision-table')
  const latestRelease = useMemo(() => releases.reduce<ReleaseRecord | null>((latest, release) => !latest || Number.parseFloat(release.version) > Number.parseFloat(latest.version) ? release : latest, null), [releases])
  const passedSuites = suites.filter(suite => suite.definition?.lastRun).filter(suite => suite.definition?.lastRun?.passed).length
  const testRate = suites.length ? `${Math.round((passedSuites / suites.length) * 1000) / 10}%` : '—'

  if (projectPending || bomPending || packagesPending) return <div className="p-6 text-xs text-ink-3">正在生成项目报告...</div>
  if (!project || !bom) return <div className="p-6 text-xs text-[#c62828]">项目报告数据不可用。</div>

  return <div className="report-page">
    <div className="report-toolbar print:hidden"><Link to={`/projects/${project.id}/assets`} className="report-tool-button"><ArrowLeft size={14} />返回项目</Link><div className="flex items-center gap-2"><button type="button" className="report-tool-button" onClick={() => void downloadProjectReport(project.id, project.name)}><Download size={14} />下载 HTML</button><button type="button" className="report-tool-button" onClick={() => window.print()}><Printer size={14} />下载 PDF</button></div></div>
    <main className="report-document">
      <header className="report-brand"><div className="flex items-center font-semibold"><span className="report-logo">DW</span>Decision Workbench</div><div className="text-right text-[11px]"><strong className="block text-sm">项目知识资产报告</strong>生成于 {generatedAt}</div></header>
      <div className="report-intro"><h1>{project.name}</h1><p>{project.description || '暂无项目描述'}</p><p>决策服务：{latestRelease?.decisionService || `${project.id}/未发布`} · 数据版本：BOM v{bom.version} / Release {latestRelease ? `v${latestRelease.version}` : '—'} · 生成人：{project.updatedBy || 'Team Server'}</p></div>
      <div className="report-kpis"><Kpi label="资产总数" value={assets.length} /><Kpi label="规则" value={rules.length} /><Kpi label="决策表" value={tables.length} /><Kpi label="测试套件通过率" value={testRate} /><Kpi label="最新发布" value={latestRelease ? `v${latestRelease.version}` : '—'} /><Kpi label="部署环境" value={new Set(releases.flatMap(release => release.environments)).size} /></div>
      <Section number="01" title="项目概览"><p className="report-meta-line">最近更新：{date(project.updatedAt)} · {project.updatedBy || '—'}　部署环境：{[...new Set(releases.flatMap(release => release.environments))].join('、') || '暂无'}</p></Section>
      <Section number="02" title="BOM 资产总览"><BomSection bom={bom} /></Section>
      <Section number="03" title="规则资产清单"><AssetSections projectId={project.id} packages={packages} /></Section>
      <Section number="04" title="规则集执行拓扑">{rulesets.length ? rulesets.map(flow => <div className="report-flow" key={flow.id}><div className="flex flex-wrap justify-between gap-2"><b>{flow.flowName}</b><span>{flow.status === 'published' ? '已发布' : '草稿'} · v{flow.version || '—'} · {flow.stepCount ?? flow.packages.length} 步骤 · {flow.branchCount ?? 0} 分支</span></div><ol>{(flow.steps?.length ? flow.steps : flow.packages.map((pkg, index) => ({ order: index + 1, name: pkg, id: pkg, type: 'rule' as const, version: 0, branchName: null }))).map(step => <li key={`${flow.id}-${step.order}-${step.id ?? step.name}`}><b>{step.order}.</b> {step.name} <span>{step.type === 'rule-group' ? '规则组' : step.type === 'table' ? '决策表' : '规则'}{step.id ? ` · ${step.id}` : ''}{step.version ? ` · v${step.version}` : ''}{step.branchName ? ` · 分支：${step.branchName}` : ''}</span></li>)}</ol></div>) : <p className="report-empty">暂无规则集</p>}</Section>
      <Section number="05" title="测试矩阵"><table className="report-table"><thead><tr><th>套件名</th><th>目标</th><th>门禁</th><th>用例 / 通过 / 失败</th><th>通过率</th><th>覆盖率</th><th>最近运行</th></tr></thead><tbody>{suites.length ? suites.map(suite => { const run = suite.definition?.lastRun; const total = run?.total || run?.cases.length || 0; const passed = run?.passedCount || 0; const failed = run?.failedCount || 0; return <tr key={suite.id}><td>{suite.name}</td><td>{suite.target}</td><td>{suite.required ? '是' : '否'}</td><td>{total ? `${total} / ${passed} / ${failed}` : '未运行'}</td><td>{total ? `${Math.round((passed / total) * 1000) / 10}%` : '—'}</td><td>{run?.coverage ? `${run.coverage.percentage}%` : '—'}</td><td>{date(run?.runAt)}</td></tr> }) : <tr><td colSpan={7} className="report-empty">暂无测试套件</td></tr>}</tbody></table></Section>
      <Section number="06" title="发布与部署历史"><table className="report-table"><thead><tr><th>版本</th><th>名称</th><th>决策服务</th><th>质量门禁</th><th>创建人 / 时间</th><th>部署</th><th>checksum</th></tr></thead><tbody>{releases.length ? releases.map(release => <tr key={release.id}><td>v{release.version}</td><td>{release.name || '—'}</td><td>{release.decisionService || '—'}</td><td>{release.state === 'running' ? '通过' : '—'}</td><td>{release.author} · {release.createdAt}</td><td>{release.environments.join('、') || '未部署'}</td><td className="font-mono text-[10px]">{release.checksum}</td></tr>) : <tr><td colSpan={7} className="report-empty">暂无发布</td></tr>}</tbody></table></Section>
      <footer className="report-footer">Decision Workbench · 项目知识资产报告 · 生成时间 {generatedAt}</footer>
    </main>
  </div>
}
