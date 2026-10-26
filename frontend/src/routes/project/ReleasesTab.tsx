import { Activity, AlertTriangle, ArrowRight, BellRing, CheckCircle2, ChevronDown, ChevronRight, CircleStop, History, LoaderCircle, PackageCheck, Plus, Power, Rocket, RotateCcw, Server, ShieldCheck } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAcknowledgeReleaseAlert, useActivateRelease, useActivationGenerations, useAppendApplicationManifest, useApplicationPackages, useConfigureReleaseWebhook, useCreateApplicationPackage, useCreateRelease, useDeployApplicationPackage, useDeployRelease, useDeploymentEnvironments, useDeployments, useDeploymentTargets, useReleaseAlerts, useReleases, useRollbackApplicationPackage, useRollbackRelease, useUndeployRelease } from '../../api/releases'
import { useRulesets } from '../../api/flows'
import { usePackages, useProject } from '../../api/projects'
import { useTestSuite } from '../../api/tests'
import { useEventStreams } from '../../api/eventStreams'
import ReleaseWizard from '../../components/releases/ReleaseWizard'
import type { DeploymentEnvironment, DeploymentEvent, DeploymentRecord, ReleaseDraft, ReleaseEnvironment, ReleaseRecord, ReleaseWebhookConfig } from '../../types'

const environmentClasses: Record<ReleaseEnvironment, string> = {
  dev: 'bg-[#f3e5f5] text-env-dev',
  test: 'bg-brand-primary-l text-brand-primary',
  staging: 'bg-[#fff3e0] text-env-staging',
  production: 'bg-[#e8f5e9] text-env-production',
  local: 'bg-[#e8f5e9] text-env-production',
}

const stateLabels: Record<ReleaseRecord['state'], string> = {
  active: '当前生效', deployed: '已部署', built: '已构建', stopped: '已停用',
  running: '运行中', 'rolled-back': '已回退', archived: '已归档',
}

const deploymentStateLabels: Record<DeploymentRecord['status'], string> = {
  pending: '等待部署', parsing: '解析中', ready: '已就绪', active: '当前生效', draining: '流量排空中', stopped: '已停用', failed: '失败',
}

const deploymentEventLabels: Record<DeploymentEvent['type'], string> = {
  created: '创建部署', ready: '部署就绪', activated: '激活版本', deactivated: '退出生效', stopped: '停止部署', failed: '部署失败',
}

const environmentOrder: Record<DeploymentEnvironment['kind'], number> = { dev: 0, test: 1, staging: 2, prod: 3 }

function environmentTone(environment: DeploymentEnvironment) {
  if (environment.kind === 'prod') return { badge: 'bg-[#e8f5e9] text-[#198038]', edge: 'border-[#b8dfc0]', dot: 'bg-[#198038]' }
  if (environment.kind === 'test') return { badge: 'bg-brand-primary-l text-brand-primary', edge: 'border-[#b8c9f5]', dot: 'bg-brand-primary' }
  return { badge: 'bg-[#f3e5f5] text-env-dev', edge: 'border-[#d8c2e2]', dot: 'bg-env-dev' }
}

function formatDate(value: string | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

const defaultWebhookDraft: ReleaseWebhookConfig = {
  enabled: true,
  callbackUrl: '',
  secret: '',
  clearedAfterMs: 60000,
  maxRetries: 1,
  minIntervalMs: 5000,
}

function suggestedVersion(releases: ReleaseRecord[]) {
  const latest = releases
    .map((release) => release.version.split('.').map(Number))
    .filter((parts) => parts.length === 3 && parts.every(Number.isFinite))
    .sort((left, right) => right[0] - left[0] || right[1] - left[1] || right[2] - left[2])[0]
  return latest ? `${latest[0]}.${latest[1] + 1}.0` : '1.0.0'
}

export default function ReleasesTab() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const { data: project } = useProject(projectId)
  const isCepProject = project?.engine === 'cep'
  const { data: releases = [], isPending } = useReleases(projectId)
  const { data: deployments = [], isPending: deploymentsPending, error: deploymentsError } = useDeployments(projectId)
  const { data: applicationPackages = [], isPending: applicationPackagesPending, error: applicationPackagesError } = useApplicationPackages(projectId)
  const { data: deploymentEnvironments = [], isPending: deploymentEnvironmentsPending, error: deploymentEnvironmentsError } = useDeploymentEnvironments(projectId)
  const { data: deploymentTargets = [], isPending: targetsPending } = useDeploymentTargets(projectId)
  const { data: activationGenerations = [], isPending: generationsPending } = useActivationGenerations(projectId)
  const { data: packages = [] } = usePackages(projectId)
  const { data: rulesets = [] } = useRulesets(project && !isCepProject ? projectId : undefined)
  const { data: eventStreams = [] } = useEventStreams(isCepProject ? projectId : undefined)
  const { data: testSuite } = useTestSuite(projectId)
  const createRelease = useCreateRelease(projectId)
  const deployRelease = useDeployRelease(projectId)
  const activateRelease = useActivateRelease(projectId)
  const rollbackRelease = useRollbackRelease(projectId)
  const undeployRelease = useUndeployRelease(projectId)
  const createApplicationPackage = useCreateApplicationPackage(projectId)
  const appendApplicationManifest = useAppendApplicationManifest(projectId)
  const deployApplicationPackage = useDeployApplicationPackage(projectId)
  const rollbackApplicationPackage = useRollbackApplicationPackage(projectId)
  const configureWebhook = useConfigureReleaseWebhook(projectId)
  const [showWizard, setShowWizard] = useState(false)
  const [createdVersion, setCreatedVersion] = useState('')
  const [webhookReleaseId, setWebhookReleaseId] = useState('')
  const [webhookDraft, setWebhookDraft] = useState<ReleaseWebhookConfig>(defaultWebhookDraft)
  const [alertsReleaseId, setAlertsReleaseId] = useState('')
  const [expandedDeploymentId, setExpandedDeploymentId] = useState('')
  const [selectedEnvironment, setSelectedEnvironment] = useState('test')
  const alerts = useReleaseAlerts(projectId, alertsReleaseId || undefined)
  const acknowledgeAlert = useAcknowledgeReleaseAlert(projectId, alertsReleaseId || undefined)
  const serverProject = Boolean(projectId)
  const activeReleases = releases.filter(release => release.state === 'active')
  const releaseOperationPending = deployRelease.isPending || activateRelease.isPending || rollbackRelease.isPending || undeployRelease.isPending
  const applicationPackageOperationPending = createApplicationPackage.isPending || appendApplicationManifest.isPending || deployApplicationPackage.isPending || rollbackApplicationPackage.isPending
  const releaseOperationError = deployRelease.error || activateRelease.error || rollbackRelease.error || undeployRelease.error
    || createApplicationPackage.error || appendApplicationManifest.error || deployApplicationPackage.error || rollbackApplicationPackage.error
  const releasesById = useMemo(() => new Map(releases.map(release => [release.id, release])), [releases])
  const targetsById = useMemo(() => new Map(deploymentTargets.map(target => [target.id, target])), [deploymentTargets])
  const selectedEnvironmentRecord = deploymentEnvironments.find(environment => environment.id === selectedEnvironment)
  const enabledTargets = deploymentTargets.filter(target => target.enabled)
  const readyTargets = enabledTargets.filter(target => target.status === 'ready')
  const activePackageCount = applicationPackages.filter(applicationPackage => applicationPackage.activeManifestIds[selectedEnvironment]).length
  const latestRelease = releases[0]
  const orderedEnvironments = useMemo(() => [...deploymentEnvironments].sort((left, right) => environmentOrder[left.kind] - environmentOrder[right.kind]), [deploymentEnvironments])
  const deployableReleases = useMemo(() => releases.filter(release => ['flow', 'event-stream'].includes(release.target?.type || '')), [releases])
  const latestDeployableRelease = deployableReleases[0]

  const environmentSnapshots = useMemo(() => orderedEnvironments.map(environment => {
    const activeManifests = applicationPackages
      .map(applicationPackage => ({ applicationPackage, manifest: applicationPackage.manifests.find(manifest => manifest.id === applicationPackage.activeManifestIds[environment.id]) }))
      .filter(item => item.manifest)
    const activeDeployments = deployments.filter(item => item.environmentId === environment.id && item.status === 'active')
    const installed = activeManifests.length
      ? activeManifests.map(item => ({ name: item.applicationPackage.name, version: item.manifest!.releaseDisplayVersion, releaseId: item.manifest!.releaseId }))
      : activeDeployments.map(item => ({ name: item.decisionService.split('/').slice(-1)[0] || item.decisionService, version: releasesById.get(item.releaseId)?.version || '未知', releaseId: item.releaseId }))
    const latestAvailable = applicationPackages.reduce((latest, applicationPackage) => {
      const manifest = applicationPackage.manifests[0]
      if (!manifest || !latest || Number(manifest.version) > Number(latest.version)) return manifest ? { version: manifest.version, displayVersion: manifest.releaseDisplayVersion } : latest
      return latest
    }, null as { version: number; displayVersion: string } | null)
    return { environment, installed, latestAvailable, hasDeployment: installed.length > 0 }
  }), [applicationPackages, deployments, orderedEnvironments, releasesById])

  useEffect(() => {
    if (!deploymentEnvironments.length || deploymentEnvironments.some(environment => environment.id === selectedEnvironment)) return
    setSelectedEnvironment(deploymentEnvironments.find(environment => environment.isDefault)?.id || deploymentEnvironments[0].id)
  }, [deploymentEnvironments, selectedEnvironment])

  const failedTests = testSuite?.cases.filter((testCase) => testCase.status === 'failed').length ?? 0
  const releasePackages = useMemo(() => {
    if (!serverProject) return packages
    if (isCepProject) {
      const assets = eventStreams
        .filter(stream => stream.status === 'published')
        .map(stream => ({
          id: stream.id,
          name: stream.name,
          type: 'event-stream' as const,
          modifiedBy: stream.modifiedBy || 'Team Server',
          status: 'published' as const,
          version: String(stream.version || 1),
        }))
      return assets.length ? [{ id: '__event_streams__', name: '事件流', label: '可发布事件流', assets }] : []
    }
    const flows = rulesets.filter(ruleset => (ruleset.version || 0) > 0).map(ruleset => ({
      id: ruleset.id,
      name: ruleset.flowName,
      type: 'flow' as const,
      modifiedBy: 'Team Server',
      status: 'published' as const,
      version: String(ruleset.version || 1),
      needsRepublish: ruleset.needsRepublish,
      outdatedDependencies: ruleset.outdatedDependencies,
    }))
    return [{ id: '__flows__', name: '规则集', label: '最小发布与执行单元', assets: flows }]
  }, [eventStreams, isCepProject, packages, rulesets, serverProject])

  const build = async (draft: ReleaseDraft, assetSummary: string) => {
    const selected = releasePackages.flatMap(packageNode => packageNode.assets).find(asset => asset.id === draft.assetIds[0])
    const targetType = selected && ['decision-table', 'decision-tree', 'scorecard', 'rule-template'].includes(selected.type) ? 'table' : selected?.type
    const previous = releases.find(release => release.target?.id === selected?.id && release.target?.type === targetType)
    const target = selected ? { ...selected, decisionService: previous?.decisionService } : undefined
    const release = await createRelease.mutateAsync({ draft, assetSummary, target })
    setCreatedVersion(release.version)
    setShowWizard(false)
  }

  const openWebhook = (release: ReleaseRecord) => {
    setWebhookReleaseId(release.id)
    setWebhookDraft({ ...defaultWebhookDraft, ...(release.webhook || {}) })
    configureWebhook.reset()
  }

  const updateWebhookDraft = (patch: Partial<ReleaseWebhookConfig>) => setWebhookDraft(current => ({ ...current, ...patch }))

  const saveWebhook = async () => {
    if (!webhookReleaseId) return
    await configureWebhook.mutateAsync({ releaseId: webhookReleaseId, webhook: webhookDraft })
    setWebhookReleaseId('')
  }

  const registerReleaseManifest = (release: ReleaseRecord) => {
    const applicationPackage = applicationPackages.find(item => item.decisionService === release.decisionService)
    if (applicationPackage) appendApplicationManifest.mutate({ packageId: applicationPackage.id, releaseId: release.id })
    else createApplicationPackage.mutate({ releaseId: release.id })
  }

  if (showWizard) {
    return (
      <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
        <ReleaseWizard
          key={projectId}
          packages={releasePackages}
          suggestedVersion={suggestedVersion(releases)}
          failedTests={failedTests}
          isBuilding={createRelease.isPending}
          buildError={createRelease.error?.message}
          singleTarget={serverProject}
          onRepublishTarget={targetId => navigate(`/projects/${encodeURIComponent(projectId ?? '')}/flow?flow=${encodeURIComponent(targetId)}`)}
          onCancel={() => { setShowWizard(false); createRelease.reset() }}
          onBuild={build}
        />
      </div>
    )
  }

  if (isPending) return <div className="p-6 text-xs text-ink-3">正在加载发布历史...</div>

  return (
    <div className="h-full overflow-auto bg-[#f7f8fa] px-6 py-5 max-sm:px-3">
      <header className="mx-auto mb-5 flex max-w-[1440px] flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-primary">Release workspace</div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-1"><History size={20} />发布中心</h1>
          <p className="mt-1 text-[11px] text-ink-3">构建不可变 Release，并将验证过的版本安全地交付到目标环境</p>
        </div>
        <button type="button" className="primary-button h-10 px-5 shadow-sm" onClick={() => { setCreatedVersion(''); setShowWizard(true) }}><Plus size={15} />构建新 Release</button>
      </header>

      <div className="mx-auto max-w-[1440px]">
      {createdVersion && <div className="mb-4 flex items-start gap-2 rounded-md border border-[#b8dfc0] bg-[#f2fbf4] px-4 py-3 text-[11px] text-[#236b2b]"><CheckCircle2 size={15} className="mt-px shrink-0" /><span><b>Release v{createdVersion} 已构建。</b> 当前运行流量未改变；请先生成 manifest，再选择环境部署。</span></div>}
      {releaseOperationError && <div className="mb-4 rounded-md border border-[#ffcdd2] bg-[#fff5f5] px-4 py-3 text-[11px] text-[#c62828]">{releaseOperationError.message}</div>}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="发布概览">
        <div className="rounded-md border border-ink-border bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-[10px] font-semibold text-ink-3">当前操作环境</div>
          <select aria-label="操作环境" aria-invalid={Boolean(deploymentEnvironmentsError)} disabled={deploymentEnvironmentsPending || Boolean(deploymentEnvironmentsError) || deploymentEnvironments.length === 0} className={`mt-2 h-9 w-full rounded-[3px] border bg-white px-2 text-xs font-semibold outline-none focus:border-brand-primary disabled:cursor-not-allowed disabled:bg-[#f6f7f8] ${deploymentEnvironmentsError ? 'border-[#e6a4a4] text-[#a31515]' : 'border-ink-border text-ink-1'}`} value={selectedEnvironmentRecord ? selectedEnvironment : ''} onChange={event => setSelectedEnvironment(event.target.value)}><option value="" disabled>{deploymentEnvironmentsPending ? '正在加载环境…' : deploymentEnvironmentsError ? '环境服务不可用' : '未配置部署环境'}</option>{deploymentEnvironments.map(environment => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select>
          <div className={`mt-2 text-[10px] ${deploymentEnvironmentsError ? 'text-[#a31515]' : 'text-ink-3'}`}>{deploymentEnvironmentsError ? '请重启或更新 Team Server' : selectedEnvironmentRecord ? `${selectedEnvironmentRecord.kind}${selectedEnvironmentRecord.isDefault ? ' · 默认环境' : ''}` : deploymentEnvironmentsPending ? '正在读取平台配置' : '请前往管理控制台配置环境'}</div>
        </div>
        <div className="rounded-md border border-ink-border bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-[10px] font-semibold text-ink-3">已生效应用</div>
          <div className="mt-2 flex items-end gap-1.5"><strong className="font-mono text-2xl font-semibold text-ink-1">{activePackageCount}</strong><span className="mb-1 text-[11px] text-ink-3">/ {applicationPackages.length}</span></div>
          <div className="mt-1 text-[10px] text-ink-3">{activePackageCount === applicationPackages.length && applicationPackages.length ? '当前环境全部已部署' : `${applicationPackages.length - activePackageCount} 个应用待部署`}</div>
        </div>
        <div className="rounded-md border border-ink-border bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-[10px] font-semibold text-ink-3">运行节点</div>
          <div className="mt-2 flex items-end gap-1.5"><strong className={`font-mono text-2xl font-semibold ${readyTargets.length === enabledTargets.length ? 'text-[#198038]' : 'text-[#b26a00]'}`}>{readyTargets.length}</strong><span className="mb-1 text-[11px] text-ink-3">/ {enabledTargets.length} 正常</span></div>
          <div className="mt-1 text-[10px] text-ink-3">{isCepProject ? 'Esper' : 'Drools'} · 平台自动对账</div>
        </div>
        <div className="rounded-md border border-ink-border bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-[10px] font-semibold text-ink-3">最近构建</div>
          <div className="mt-2 truncate font-mono text-lg font-semibold text-brand-primary">{latestRelease ? `v${latestRelease.version}` : '—'}</div>
          <div className="mt-1 truncate text-[10px] text-ink-3">{latestRelease ? `${latestRelease.author} · ${latestRelease.createdAt}` : '尚无 Release'}</div>
        </div>
      </section>

      <section className="mb-4 overflow-hidden rounded-md border border-ink-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]" aria-label="环境版本总览">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-border px-5 py-4">
          <div><h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-brand-primary" />环境版本总览</h2><p className="mt-1 text-[10px] text-ink-3">查看每个环境当前运行的版本；推荐按 本地 → 测试 → 生产 推进，也支持按需直接发布。</p></div>
          <span className="rounded-full bg-[#f4f4f4] px-2.5 py-1 text-[10px] text-ink-2">{orderedEnvironments.length} 个环境</span>
        </div>
        <div className="grid gap-3 p-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {environmentSnapshots.map((snapshot, index) => {
            const tone = environmentTone(snapshot.environment)
            const isSelected = selectedEnvironment === snapshot.environment.id
            return <Fragment key={snapshot.environment.id}>
              <button type="button" className={`group min-w-0 rounded-md border p-3 text-left transition-colors ${isSelected ? `${tone.edge} bg-[#fbfcff] shadow-sm` : 'border-ink-border hover:border-brand-primary'}`} onClick={() => { setSelectedEnvironment(snapshot.environment.id); document.getElementById('environment-deploy')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
                <div className="flex items-center justify-between gap-2"><span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-semibold ${tone.badge}`}><span className={`size-1.5 rounded-full ${tone.dot}`} />{snapshot.environment.name}</span><span className="text-[10px] text-ink-3">{snapshot.environment.kind === 'prod' ? '生产' : snapshot.environment.kind === 'test' ? '验证' : '开发'}</span></div>
                {snapshot.installed.length ? <div className="mt-3 space-y-1.5">{snapshot.installed.slice(0, 2).map(item => <div key={`${item.name}:${item.releaseId}`} className="flex min-w-0 items-center justify-between gap-2"><span className="truncate text-[11px] font-medium text-ink-1" title={item.name}>{item.name}</span><span className="shrink-0 font-mono text-[12px] font-semibold text-brand-primary">v{item.version}</span></div>)}{snapshot.installed.length > 2 && <div className="text-[10px] text-ink-3">另有 {snapshot.installed.length - 2} 个应用</div>}</div> : <div className="mt-3 text-[11px] text-ink-3">尚未安装应用版本</div>}
                <div className="mt-3 flex items-center justify-between border-t border-[#eeeeee] pt-2 text-[10px]"><span className={snapshot.hasDeployment ? 'font-semibold text-[#198038]' : 'text-ink-3'}>{snapshot.hasDeployment ? `${snapshot.installed.length} 个应用运行中` : '等待部署'}</span><span className="text-brand-primary group-hover:underline">管理环境</span></div>
                {snapshot.latestAvailable && <div className="mt-1 text-[10px] text-ink-3">最新可发布：<b className="font-mono font-medium text-ink-2">v{snapshot.latestAvailable.displayVersion}</b></div>}
              </button>
              {index < environmentSnapshots.length - 1 && <div className="hidden items-center justify-center text-ink-3 lg:flex" aria-hidden="true"><ArrowRight size={16} /></div>}
            </Fragment>
          })}
        </div>
        {!orderedEnvironments.length && <p className="px-5 py-6 text-center text-[11px] text-ink-3">尚未配置部署环境，请先在管理中心添加环境。</p>}
      </section>

      <section id="environment-deploy" className="mb-4 scroll-mt-4 overflow-hidden rounded-md border border-ink-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]" aria-label="环境部署">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-border px-5 py-4">
          <div><h2 className="flex items-center gap-2 text-sm font-semibold"><PackageCheck size={16} className="text-brand-primary" />环境部署</h2><p className="mt-1 text-[10px] text-ink-3">管理 <b className="font-semibold text-ink-2">{selectedEnvironmentRecord?.name || selectedEnvironment}</b> 的安装版本，可独立部署、回退，不影响其他环境</p></div>
          <span className="rounded-full bg-[#eef4ff] px-2.5 py-1 text-[10px] font-semibold text-brand-primary">{applicationPackages.length} 个应用包</span>
        </div>
        {applicationPackagesPending ? <p className="px-5 py-6 text-[11px] text-ink-3">正在加载应用包...</p> : applicationPackagesError ? <div className="px-5 py-7 text-center"><AlertTriangle size={22} className="mx-auto text-[#c62828]" /><p className="mt-2 text-xs font-semibold text-ink-1">应用发布数据加载失败</p><p className="mt-1 text-[10px] text-ink-3">请确认 Team Server 已更新并重新加载页面。</p></div> : applicationPackages.length ? <div className="divide-y divide-[#eeeeee]">{applicationPackages.map(applicationPackage => {
          const latest = applicationPackage.manifests[0]
          const active = applicationPackage.manifests.find(manifest => manifest.id === applicationPackage.activeManifestIds[selectedEnvironment])
          const rollbackAvailable = Boolean(active && applicationPackage.manifests.some(manifest => manifest.version < active.version && manifest.deployments.some(deployment => deployment.environmentId === selectedEnvironment && deployment.status === 'ready')))
          const isCurrent = latest?.id === active?.id
          return <article key={applicationPackage.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(240px,1.15fr)_minmax(360px,1.6fr)_auto] lg:items-center">
            <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-xs font-semibold text-ink-1">{applicationPackage.name}</h3><span className="rounded bg-[#f1f2f4] px-1.5 py-0.5 text-[9px] uppercase text-ink-2">{applicationPackage.engine}</span></div><div className="mt-1 truncate font-mono text-[9px] text-ink-3" title={applicationPackage.decisionService}>{applicationPackage.decisionService}</div></div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="min-w-0"><div className="text-[9px] font-semibold text-ink-3">当前生效</div>{active ? <div className="mt-1 truncate text-[11px] font-semibold text-[#198038]">Manifest v{active.version}</div> : <div className="mt-1 text-[11px] text-ink-3">尚未部署</div>}</div>
              <ChevronRight size={14} className="text-ink-3" />
              <div className="min-w-0"><div className="text-[9px] font-semibold text-ink-3">最新可用</div>{latest ? <><div className="mt-1 truncate text-[11px] font-semibold text-ink-1">Manifest v{latest.version} · Release v{latest.releaseDisplayVersion}</div><code className="block truncate text-[9px] text-ink-3">{latest.checksum.slice(0, 18)}…</code></> : <div className="mt-1 text-[11px] text-ink-3">暂无 manifest</div>}</div>
            </div>
            <div className="flex items-center justify-end gap-2 lg:min-w-[172px]"><button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-brand-primary bg-white px-3 text-[10px] font-semibold text-brand-primary hover:bg-brand-primary-l disabled:cursor-not-allowed disabled:border-ink-border disabled:text-ink-3 disabled:opacity-70" disabled={!latest || !selectedEnvironmentRecord || applicationPackageOperationPending || isCurrent} onClick={() => deployApplicationPackage.mutate({ packageId: applicationPackage.id, manifestId: latest?.id, environment: selectedEnvironment })}><Rocket size={12} />{isCurrent ? '已是最新' : '部署最新'}</button><button type="button" className="inline-flex h-8 items-center gap-1 rounded-[3px] border border-ink-border px-2.5 text-[10px] text-ink-2 hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-40" disabled={!selectedEnvironmentRecord || !rollbackAvailable || applicationPackageOperationPending} onClick={() => rollbackApplicationPackage.mutate({ packageId: applicationPackage.id, environment: selectedEnvironment })}><RotateCcw size={11} />回退</button></div>
          </article>
        })}</div> : <div className="px-5 py-8 text-center"><PackageCheck size={24} className="mx-auto text-ink-3" /><p className="mt-2 text-xs font-semibold text-ink-2">{latestDeployableRelease ? '还没有应用包' : '暂无可部署 Release'}</p><p className="mt-1 text-[10px] text-ink-3">{latestDeployableRelease ? '应用包是跨环境复用的部署边界，先从最新 Release 创建一个应用包。' : '请先构建规则集或事件流 Release，完成验证后再部署。'}</p>{latestDeployableRelease && <button type="button" className="primary-button mt-3 h-8 px-3 text-[10px]" disabled={applicationPackageOperationPending} onClick={() => registerReleaseManifest(latestDeployableRelease)}><PackageCheck size={12} />从 v{latestDeployableRelease.version} 创建应用包</button>}</div>}
      </section>

      <section className="mb-4 overflow-hidden rounded-md border border-ink-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]" aria-label="Release 发布历史">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-border px-5 py-4">
          <div><h2 className="flex items-center gap-2 text-sm font-semibold"><History size={16} className="text-brand-primary" />Release 版本库</h2><p className="mt-1 text-[10px] text-ink-3">Release 构建后不可修改；从这里选择版本创建应用包，再发布到任意环境</p></div>
          <span className="text-[10px] text-ink-3">共 {releases.length} 个版本</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left text-[11px]">
            <thead className="bg-[#fafafa] text-[11px] text-ink-2"><tr><th className="border-b border-ink-border px-[10px] py-2 font-semibold">版本</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">状态 / 环境</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">包含资产</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">校验和</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">作者</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">时间</th><th className="w-24 border-b border-ink-border px-[10px] py-2 font-semibold">操作</th></tr></thead>
            <tbody>{releases.map((release) => (
              <Fragment key={release.id}>
              <tr className="border-b border-[#eeeeee] last:border-0 hover:bg-[#f8fbff]">
                <td className="px-[10px] py-3"><span className="font-mono font-semibold text-brand-primary">v{release.version}</span>{release.latestForDecisionService && <span className="ml-1.5 rounded bg-brand-primary-l px-1.5 py-0.5 text-[9px] text-brand-primary">最新</span>}{release.target?.type && <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[9px] ${release.target.type === 'flow' ? 'bg-[#e8f5e9] text-env-production' : 'bg-[#fff3e0] text-[#b26a00]'}`}>{release.target.type === 'flow' ? '规则集服务' : release.target.type === 'event-stream' ? '事件流服务' : '独立资产服务'}</span>}{release.name && <span className="mt-1 block text-[11px] font-medium text-ink-1">{release.name}</span>}{release.decisionService && <span className="block max-w-[220px] truncate font-mono text-[9px] text-ink-3" title={release.decisionService}>{release.decisionService}</span>}</td>
                <td className="px-[10px] py-2"><div className="flex flex-wrap items-center gap-1">{release.environments.map((environment) => <span key={environment} className={`rounded-[2px] px-2 py-0.5 text-[10px] ${release.state === 'stopped' ? 'bg-[#eeeeee] text-ink-3' : environmentClasses[environment]}`}>{environment}</span>)}{release.shadow && <span className="rounded-[2px] bg-[#f3e5f5] px-2 py-0.5 text-[10px] text-env-dev">Shadow</span>}<span className={`ml-1 text-[11px] ${release.state === 'active' ? 'font-semibold text-env-production' : 'text-ink-2'}`}>{stateLabels[release.state]}</span></div></td>
                <td className="px-[10px] py-2">{release.engine === 'cep' && <span className="mr-1.5 bg-[#e8f5e9] px-1.5 py-0.5 text-[9px] text-env-production">CEP</span>}{release.assetSummary}</td>
                <td className="px-[10px] py-2 font-mono text-[10px] text-ink-3"><span className="block max-w-[120px] truncate" title={release.checksum}>{release.checksum}</span></td>
                <td className="px-[10px] py-2">{release.author}</td>
                <td className="whitespace-nowrap px-[10px] py-2 text-ink-3">{release.createdAt}</td>
                <td className="px-[10px] py-2">{serverProject ? <div className="flex flex-wrap gap-1.5">
                  {(() => { const applicationPackage = applicationPackages.find(item => item.decisionService === release.decisionService); const manifest = applicationPackage?.manifests.find(item => item.releaseId === release.id); return manifest ? <span className="inline-flex h-7 items-center whitespace-nowrap rounded-[2px] bg-[#f4f4f4] px-2 text-[10px] text-ink-2">Manifest v{manifest.version}</span> : <button type="button" className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[2px] border border-ink-border px-2 text-[10px] text-ink-2 hover:border-brand-primary hover:text-brand-primary disabled:opacity-50" disabled={applicationPackageOperationPending} onClick={() => registerReleaseManifest(release)}><PackageCheck size={11} />{applicationPackage ? '追加 manifest' : '创建应用包'}</button> })()}
                  {(release.state === 'built' || release.state === 'stopped') && <button className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-brand-primary px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-50" disabled={releaseOperationPending} title="旧单机 local 环境部署" onClick={() => deployRelease.mutate(release.id)}>{deployRelease.isPending ? <LoaderCircle size={12} className="animate-spin" /> : <Rocket size={12} />}{release.state === 'stopped' ? '重新部署 local' : '部署 local'}</button>}
                  {release.state === 'deployed' && <button className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-brand-primary px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-50" disabled={releaseOperationPending} onClick={() => activateRelease.mutate(release.id)}><Power size={12} />激活</button>}
                  {release.state === 'active' && release.rollbackAvailable && <button className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-ink-border px-2 text-[11px] text-ink-2 hover:border-brand-primary hover:text-brand-primary disabled:opacity-50" disabled={releaseOperationPending} onClick={() => rollbackRelease.mutate(release.id)}><RotateCcw size={12} />回退</button>}
                  {release.state === 'deployed' && <button className="inline-flex size-7 items-center justify-center rounded-[2px] border border-ink-border text-ink-3 hover:border-[#c62828] hover:text-[#c62828] disabled:opacity-50" title="卸载该版本" aria-label={`卸载 v${release.version}`} disabled={releaseOperationPending} onClick={() => { if (window.confirm(`确定从 local RES 卸载 v${release.version}？历史 Release 仍会保留。`)) undeployRelease.mutate(release.id) }}><CircleStop size={13} /></button>}
                  {release.engine === 'cep' && release.state !== 'stopped' && <button type="button" className="inline-flex h-7 items-center rounded-[2px] border border-ink-border px-2 text-[11px] text-ink-2 hover:border-brand-primary hover:text-brand-primary" onClick={() => webhookReleaseId === release.id ? setWebhookReleaseId('') : openWebhook(release)}>{release.webhook?.enabled ? '回调已开' : '告警回调'}</button>}
                  {release.engine === 'cep' && ['active', 'deployed'].includes(release.state) && <button type="button" className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-ink-border px-2 text-[11px] text-ink-2 hover:border-brand-primary hover:text-brand-primary" onClick={() => { setAlertsReleaseId(current => current === release.id ? '' : release.id); acknowledgeAlert.reset() }}><BellRing size={12} />告警</button>}
                </div> : <span className="text-[10px] text-ink-3">-</span>}</td>
              </tr>
              {alertsReleaseId === release.id && (
                <tr className="border-b border-[#e8e8e8] bg-[#f8fafc]">
                  <td colSpan={7} className="px-[10px] py-3">
                    <div className="rounded-[3px] border border-ink-border bg-white p-3">
                      <div className="mb-2 flex items-center justify-between"><div><h3 className="text-xs font-semibold">CEP 告警实例</h3><p className="mt-0.5 text-[10px] text-ink-3">命中后进入活动，人工确认后保持监控，超过消退窗口自动清除。</p></div><button className="h-7 border border-ink-border px-2 text-[10px]" onClick={() => void alerts.refetch()}>刷新</button></div>
                      {alerts.isPending ? <p className="py-3 text-[11px] text-ink-3">加载告警中...</p> : alerts.error ? <p className="py-2 text-[11px] text-[#c62828]">{alerts.error.message}</p> : alerts.data?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-[11px]"><thead className="bg-[#fafafa] text-ink-3"><tr><th className="px-2 py-1.5 text-left">状态</th><th className="px-2 py-1.5 text-left">语句 / 输出</th><th className="px-2 py-1.5 text-left">关联键</th><th className="px-2 py-1.5 text-left">最近命中</th><th className="px-2 py-1.5 text-left">确认</th><th className="px-2 py-1.5 text-right">操作</th></tr></thead><tbody>{alerts.data.map(alert => <tr key={alert.id} className="border-t border-ink-border"><td className="px-2 py-2"><span className={`px-1.5 py-0.5 text-[10px] ${alert.status === 'ACTIVE' ? 'bg-[#fff1f1] text-[#c62828]' : alert.status === 'ACKED' ? 'bg-[#fff3e0] text-[#8a5a00]' : 'bg-[#e8f5e9] text-[#198038]'}`}>{alert.status === 'ACTIVE' ? '活动' : alert.status === 'ACKED' ? '已确认' : '已清除'}</span></td><td className="px-2 py-2"><div className="font-mono">{alert.statement}</div><div className="text-[10px] text-ink-3">{alert.eventType}</div></td><td className="px-2 py-2 font-mono">{alert.correlationKey}</td><td className="px-2 py-2 whitespace-nowrap">{new Date(alert.lastFiredAt).toLocaleString('zh-CN', { hour12: false })}</td><td className="px-2 py-2">{alert.ackedBy ? <><div>{alert.ackedBy}</div><div className="text-[10px] text-ink-3">{alert.ackedAt ? new Date(alert.ackedAt).toLocaleString('zh-CN', { hour12: false }) : ''}</div></> : '-'}</td><td className="px-2 py-2 text-right">{alert.status === 'ACTIVE' && <button type="button" className="h-7 border border-brand-primary px-2 text-[10px] text-brand-primary disabled:opacity-50" disabled={acknowledgeAlert.isPending} onClick={() => acknowledgeAlert.mutate(alert.id)}>确认</button>}</td></tr>)}</tbody></table></div> : <p className="py-3 text-[11px] text-ink-3">该 Release 暂无告警实例。</p>}
                      {acknowledgeAlert.error && <p className="mt-2 text-[10px] text-[#c62828]">{acknowledgeAlert.error.message}</p>}
                    </div>
                  </td>
                </tr>
              )}
              {webhookReleaseId === release.id && (
                <tr className="border-b border-[#e8e8e8] bg-[#fbfcf8]">
                  <td colSpan={7} className="px-[10px] py-3">
                    <div className="rounded-[3px] border border-[#dfe8d8] bg-white p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="text-xs font-semibold text-ink-1">CEP 告警回调</h3>
                          <p className="mt-0.5 text-[10px] text-ink-3">运行时命中后推送 alert.fired；超过消退窗口未再次命中后推送 alert.cleared。</p>
                        </div>
                        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
                          <input type="checkbox" checked={webhookDraft.enabled} onChange={event => updateWebhookDraft({ enabled: event.target.checked })} />
                          启用
                        </label>
                      </div>
                      <div className="grid gap-2 md:grid-cols-[minmax(240px,2fr)_minmax(160px,1fr)_repeat(3,minmax(92px,0.7fr))]">
                        <label className="text-[10px] font-semibold text-ink-3">Callback URL<input className="mt-1 h-8 w-full rounded-[2px] border border-ink-border px-2 text-[11px] font-normal text-ink-1" placeholder="https://ops.example.com/cep-alerts" value={webhookDraft.callbackUrl} onChange={event => updateWebhookDraft({ callbackUrl: event.target.value })} /></label>
                        <label className="text-[10px] font-semibold text-ink-3">Secret<input className="mt-1 h-8 w-full rounded-[2px] border border-ink-border px-2 text-[11px] font-normal text-ink-1" placeholder="HMAC secret" value={webhookDraft.secret || ''} onChange={event => updateWebhookDraft({ secret: event.target.value })} /></label>
                        <label className="text-[10px] font-semibold text-ink-3">消退 ms<input type="number" min={0} className="mt-1 h-8 w-full rounded-[2px] border border-ink-border px-2 text-[11px] font-normal text-ink-1" value={webhookDraft.clearedAfterMs ?? 0} onChange={event => updateWebhookDraft({ clearedAfterMs: Number(event.target.value) })} /></label>
                        <label className="text-[10px] font-semibold text-ink-3">重试<input type="number" min={0} max={5} className="mt-1 h-8 w-full rounded-[2px] border border-ink-border px-2 text-[11px] font-normal text-ink-1" value={webhookDraft.maxRetries ?? 0} onChange={event => updateWebhookDraft({ maxRetries: Number(event.target.value) })} /></label>
                        <label className="text-[10px] font-semibold text-ink-3">去抖 ms<input type="number" min={0} className="mt-1 h-8 w-full rounded-[2px] border border-ink-border px-2 text-[11px] font-normal text-ink-1" value={webhookDraft.minIntervalMs ?? 0} onChange={event => updateWebhookDraft({ minIntervalMs: Number(event.target.value) })} /></label>
                      </div>
                      {configureWebhook.error && <div className="mt-2 rounded-[2px] border border-[#ffcdd2] bg-[#fff5f5] px-2 py-1 text-[10px] text-[#c62828]">{configureWebhook.error.message}</div>}
                      <div className="mt-3 flex justify-end gap-2">
                        <button type="button" className="ghost-button" onClick={() => setWebhookReleaseId('')}>取消</button>
                        <button type="button" className="primary-button disabled:opacity-50" disabled={configureWebhook.isPending || (webhookDraft.enabled && !webhookDraft.callbackUrl.trim())} onClick={saveWebhook}>{configureWebhook.isPending ? '保存中...' : '保存回调'}</button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="mb-4 grid gap-3 lg:grid-cols-2" aria-label="运行与部署详情">
        <details className="group overflow-hidden rounded-md border border-ink-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 hover:bg-[#f8fbff] focus:outline-none">
            <span className="flex min-w-0 items-center gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[#eef4ff] text-brand-primary"><Server size={16} /></span><span className="min-w-0"><b className="block text-xs font-semibold text-ink-1">部署账本</b><span className="mt-0.5 block truncate text-[10px] text-ink-3">{deployments.length} 条部署记录 · 查看状态流转与操作人</span></span></span>
            <ChevronRight size={15} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
          </summary>
          <div className="border-t border-ink-border">
            {deploymentsPending ? <p className="px-5 py-5 text-[11px] text-ink-3">正在加载部署账本...</p> : deploymentsError ? <p className="px-5 py-5 text-[11px] text-[#c62828]">{deploymentsError.message}</p> : deployments.length ? <div className="max-h-[440px] overflow-auto"><table className="w-full min-w-[760px] border-collapse text-left text-[10px]"><thead className="sticky top-0 bg-[#fafafa] text-ink-3"><tr><th className="border-b border-ink-border px-3 py-2 font-semibold">状态</th><th className="border-b border-ink-border px-3 py-2 font-semibold">环境</th><th className="border-b border-ink-border px-3 py-2 font-semibold">决策服务 / 版本</th><th className="border-b border-ink-border px-3 py-2 font-semibold">最近变更</th><th className="w-14 border-b border-ink-border px-3 py-2 font-semibold">历史</th></tr></thead><tbody>{deployments.map(deployment => {
              const release = releasesById.get(deployment.releaseId)
              const expanded = expandedDeploymentId === deployment.id
              const stateClass = deployment.status === 'active' ? 'bg-[#e8f5e9] text-env-production' : deployment.status === 'ready' ? 'bg-brand-primary-l text-brand-primary' : deployment.status === 'failed' ? 'bg-[#fff1f1] text-[#c62828]' : 'bg-[#eeeeee] text-ink-3'
              return <Fragment key={deployment.id}><tr className="border-b border-[#eeeeee] hover:bg-[#f8fbff]"><td className="px-3 py-2"><span className={`rounded px-2 py-1 font-semibold ${stateClass}`}>{deploymentStateLabels[deployment.status]}</span></td><td className="px-3 py-2 font-mono">{deployment.environmentId}</td><td className="px-3 py-2"><div className="max-w-[220px] truncate font-mono text-ink-1" title={deployment.decisionService}>{deployment.decisionService}</div><div className="mt-0.5 text-ink-3">{release ? `Release v${release.version}` : deployment.releaseId}</div></td><td className="whitespace-nowrap px-3 py-2"><div>{formatDate(deployment.updatedAt)}</div><div className="mt-0.5 text-ink-3">{deployment.status === 'active' ? `激活人：${deployment.activatedBy || '—'}` : `部署于 ${formatDate(deployment.createdAt)}`}</div></td><td className="px-3 py-2"><button type="button" className="inline-flex size-7 items-center justify-center rounded border border-ink-border text-ink-2 hover:border-brand-primary hover:text-brand-primary" aria-label={`${expanded ? '收起' : '展开'}部署历史`} onClick={() => setExpandedDeploymentId(expanded ? '' : deployment.id)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button></td></tr>{expanded && <tr className="border-b border-[#eeeeee] bg-[#fbfcfe]"><td colSpan={5} className="px-4 py-3"><div className="grid gap-3 md:grid-cols-[180px_1fr]"><div><div className="font-semibold text-ink-3">Deployment ID</div><code className="mt-1 block break-all text-ink-2">{deployment.id}</code><div className="mt-2 font-semibold text-ink-3">Release checksum</div><code className="mt-1 block break-all text-ink-2">{deployment.checksum}</code></div><ol className="space-y-2 border-l border-ink-border pl-4">{deployment.events.length ? deployment.events.map(event => <li key={event.id} className="relative"><span className="absolute -left-[19px] top-1 size-2 rounded-full bg-brand-primary" /><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-ink-1">{deploymentEventLabels[event.type]}</span><span className="text-ink-3">{formatDate(event.occurredAt)} · {event.actor}</span></div></li>) : <li className="text-ink-3">暂无状态事件</li>}</ol></div></td></tr>}</Fragment>
            })}</tbody></table></div> : <p className="px-5 py-5 text-[11px] text-ink-3">暂无部署记录。</p>}
          </div>
        </details>

        <details className="group overflow-hidden rounded-md border border-ink-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 hover:bg-[#f8fbff] focus:outline-none">
            <span className="flex min-w-0 items-center gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[#eef9ef] text-[#198038]"><Activity size={16} /></span><span className="min-w-0"><b className="block text-xs font-semibold text-ink-1">运行节点与激活代次</b><span className="mt-0.5 block truncate text-[10px] text-ink-3">{readyTargets.length}/{enabledTargets.length} 节点正常 · {activationGenerations.length} 条 generation</span></span></span>
            <ChevronRight size={15} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
          </summary>
          <div className="max-h-[520px] overflow-auto border-t border-ink-border">
            <div className="border-b border-ink-border bg-[#fafafa] px-4 py-2 text-[9px] font-semibold uppercase tracking-wide text-ink-3">平台注册节点</div>
            {targetsPending ? <p className="px-4 py-4 text-[10px] text-ink-3">正在加载节点...</p> : deploymentTargets.length ? <div className="divide-y divide-[#eeeeee]">{deploymentTargets.map(target => {
              const statusClass = target.status === 'ready' ? 'bg-[#e8f5e9] text-env-production' : target.status === 'mismatch' ? 'bg-[#fff3e0] text-[#8a5a00]' : target.status === 'unreachable' ? 'bg-[#fff1f1] text-[#c62828]' : 'bg-[#eeeeee] text-ink-3'
              const statusLabel = target.status === 'ready' ? '一致' : target.status === 'mismatch' ? '代次偏移' : target.status === 'unreachable' ? '不可达' : '未对账'
              return <div key={target.id} className="grid gap-2 px-4 py-3 text-[10px] sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><div className="flex items-center gap-2"><b className="truncate text-[11px] text-ink-1">{target.name}</b><span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${statusClass}`}>{statusLabel}</span></div><div className="mt-1 truncate font-mono text-ink-3" title={target.endpoint}>{target.environmentId} · {target.endpoint}</div></div><div className="text-ink-3 sm:text-right"><div>{target.engine}{target.engineVersion ? ` ${target.engineVersion}` : ''}</div><div>{formatDate(target.lastSeenAt || undefined)}</div></div></div>
            })}</div> : <p className="px-4 py-4 text-[10px] text-ink-3">暂无注册节点。</p>}
            <div className="border-y border-ink-border bg-[#fafafa] px-4 py-2 text-[9px] font-semibold uppercase tracking-wide text-ink-3">Activation generations</div>
            {generationsPending ? <p className="px-4 py-4 text-[10px] text-ink-3">正在加载 generation...</p> : activationGenerations.length ? <div className="divide-y divide-[#eeeeee]">{activationGenerations.slice(0, 12).map(generation => <div key={generation.id} className="grid gap-2 px-4 py-3 text-[10px] sm:grid-cols-[100px_1fr_auto] sm:items-center"><div><b className="font-mono text-ink-1">{generation.environmentId} · g{generation.generation}</b><div className="text-[9px] text-ink-3">expected g{generation.expectedGeneration}</div></div><div className="min-w-0"><div className="truncate font-mono text-ink-2" title={generation.decisionService}>{generation.decisionService}</div><div className="mt-1 flex flex-wrap gap-1">{generation.targets.map(state => <span key={state.targetId} className={`rounded px-1.5 py-0.5 text-[9px] ${state.status === 'active' || state.status === 'ready' ? 'bg-[#e8f5e9] text-env-production' : state.status === 'failed' ? 'bg-[#fff1f1] text-[#c62828]' : 'bg-[#eeeeee] text-ink-3'}`} title={state.error || undefined}>{targetsById.get(state.targetId)?.name || state.targetId}: {state.status}</span>)}</div></div><div className="sm:text-right"><span className={`rounded px-2 py-1 text-[9px] font-semibold ${generation.status === 'active' ? 'bg-[#e8f5e9] text-env-production' : generation.status === 'failed' ? 'bg-[#fff1f1] text-[#c62828]' : generation.status === 'draining' ? 'bg-[#fff3e0] text-[#8a5a00]' : 'bg-brand-primary-l text-brand-primary'}`}>{generation.status}</span><div className="mt-1 whitespace-nowrap text-[9px] text-ink-3">{formatDate(generation.updatedAt)}</div></div></div>)}</div> : <p className="px-4 py-4 text-[10px] text-ink-3">暂无 generation 记录。</p>}
          </div>
        </details>
      </section>

      <section className="rounded-md border border-ink-border bg-white px-5 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <h2 className="flex items-center gap-2 text-xs font-semibold"><Server size={15} className="text-brand-primary" />{isCepProject ? 'CEP Runtime 部署目标' : 'RES 部署目标'}</h2>
        <p className="mt-2 text-[11px] text-ink-3">{serverProject ? `local 连接当前${isCepProject ? ' CEP adapter' : ' RES'} · 构建完成后手动部署 · 相同 Release 重复部署保持幂等` : 'production 连接 RES 集群 · Shadow 影子运行不写业务状态 · 部署必须由发布审核与部署角色共同批准'}</p>
        {serverProject && activeReleases.length > 0 && <div className="mt-2 border-t border-ink-border pt-2 text-[11px]"><span className="font-semibold text-ink-2">稳定执行入口</span><div className="mt-1.5 space-y-1.5">{activeReleases.map(release => <div key={release.id} className="flex flex-wrap items-center gap-2"><code className="bg-[#f4f4f4] px-2 py-1 font-mono text-[10px] text-ink-1">POST {release.stableEndpoint}</code><span className="text-ink-3">{release.engine === 'rules' ? '生产应用直连 RES' : '通过项目服务入口调用'}，当前路由至 v{release.version}</span></div>)}</div></div>}
      </section>
      </div>
    </div>
  )
}
