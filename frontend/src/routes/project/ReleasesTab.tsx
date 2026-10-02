import { CheckCircle2, History, LoaderCircle, Plus, Rocket, Server } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useConfigureReleaseWebhook, useCreateRelease, useDeployRelease, useReleases } from '../../api/releases'
import { useRulesets } from '../../api/flows'
import { usePackages, useProject } from '../../api/projects'
import { useTestSuite } from '../../api/tests'
import { useEventStreams } from '../../api/eventStreams'
import ReleaseWizard from '../../components/releases/ReleaseWizard'
import type { ReleaseDraft, ReleaseEnvironment, ReleaseRecord, ReleaseWebhookConfig } from '../../types'

const environmentClasses: Record<ReleaseEnvironment, string> = {
  dev: 'bg-[#f3e5f5] text-env-dev',
  test: 'bg-brand-primary-l text-brand-primary',
  staging: 'bg-[#fff3e0] text-env-staging',
  production: 'bg-[#e8f5e9] text-env-production',
  local: 'bg-[#e8f5e9] text-env-production',
}

const stateLabels: Record<ReleaseRecord['state'], string> = {
  running: '运行中', built: '已构建', 'rolled-back': '已回退', archived: '已归档',
}

const demoProjectIds = new Set(['miniloan', 'grain-temperature'])

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
  const { data: project } = useProject(projectId)
  const isCepProject = project?.engine === 'cep'
  const { data: releases = [], isPending } = useReleases(projectId)
  const { data: packages = [] } = usePackages(projectId)
  const { data: rulesets = [] } = useRulesets(project && !isCepProject ? projectId : undefined)
  const { data: eventStreams = [] } = useEventStreams(isCepProject ? projectId : undefined)
  const { data: testSuite } = useTestSuite(projectId)
  const createRelease = useCreateRelease(projectId)
  const deployRelease = useDeployRelease(projectId)
  const configureWebhook = useConfigureReleaseWebhook(projectId)
  const [showWizard, setShowWizard] = useState(false)
  const [createdVersion, setCreatedVersion] = useState('')
  const [webhookReleaseId, setWebhookReleaseId] = useState('')
  const [webhookDraft, setWebhookDraft] = useState<ReleaseWebhookConfig>(defaultWebhookDraft)
  const serverProject = Boolean(projectId && !demoProjectIds.has(projectId))

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
    const publishedPackages = packages
      .map(packageNode => ({ ...packageNode, assets: packageNode.assets.filter(asset => asset.status === 'published') }))
      .filter(packageNode => packageNode.assets.length)
    const flows = rulesets.filter(ruleset => ruleset.status === 'published').map(ruleset => ({
      id: ruleset.id,
      name: ruleset.flowName,
      type: 'flow' as const,
      modifiedBy: 'Team Server',
      status: 'published' as const,
      version: String(ruleset.version || 1),
    }))
    return flows.length ? [...publishedPackages, { id: '__flows__', name: '规则流', label: '可执行流程', assets: flows }] : publishedPackages
  }, [eventStreams, isCepProject, packages, rulesets, serverProject])

  const build = async (draft: ReleaseDraft, assetSummary: string) => {
    const target = releasePackages.flatMap(packageNode => packageNode.assets).find(asset => asset.id === draft.assetIds[0])
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
          onCancel={() => { setShowWizard(false); createRelease.reset() }}
          onBuild={build}
        />
      </div>
    )
  }

  if (isPending) return <div className="p-6 text-xs text-ink-3">正在加载发布历史...</div>

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-base font-medium"><History size={17} />发布历史</h1>
          <p className="mt-0.5 text-[11px] text-ink-3">每次发布冻结 {isCepProject ? 'EPL、事件 schema、BOM' : 'DRL、BOM、规则流'} 和校验和，构建后不可修改</p>
        </div>
        <button type="button" className="primary-button" onClick={() => { setCreatedVersion(''); setShowWizard(true) }}><Plus size={14} />构建新 Release</button>
      </div>

      {createdVersion && <div className="mb-3 flex items-center gap-2 rounded-[3px] border border-[#c8e6c9] bg-[#f4fbf4] px-3 py-2 text-[11px] text-env-production"><CheckCircle2 size={14} />Release v{createdVersion} 构建成功，已加入发布历史。</div>}
      {deployRelease.error && <div className="mb-3 rounded-[3px] border border-[#ffcdd2] bg-[#fff5f5] px-3 py-2 text-[11px] text-[#c62828]">{deployRelease.error.message}</div>}

      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white" aria-label="Release 发布历史">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-left text-xs">
            <thead className="bg-[#fafafa] text-[11px] text-ink-2"><tr><th className="border-b border-ink-border px-[10px] py-2 font-semibold">版本</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">状态 / 环境</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">包含资产</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">校验和</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">作者</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">时间</th><th className="w-24 border-b border-ink-border px-[10px] py-2 font-semibold">操作</th></tr></thead>
            <tbody>{releases.map((release) => (
              <Fragment key={release.id}>
              <tr className="border-b border-[#e8e8e8] last:border-0 hover:bg-[#f0f6fc]">
                <td className="px-[10px] py-2"><span className="font-mono text-brand-primary">v{release.version}</span>{release.latestForDecisionService && <span className="ml-1.5 bg-brand-primary-l px-1.5 py-0.5 text-[9px] text-brand-primary">最新</span>}{release.name && <span className="mt-0.5 block text-[11px] text-ink-1">{release.name}</span>}{release.decisionService && <span className="block font-mono text-[9px] text-ink-3">{release.decisionService}</span>}</td>
                <td className="px-[10px] py-2"><div className="flex flex-wrap items-center gap-1">{release.environments.map((environment) => <span key={environment} className={`rounded-[2px] px-2 py-0.5 text-[10px] ${environmentClasses[environment]}`}>{environment}</span>)}{release.shadow && <span className="rounded-[2px] bg-[#f3e5f5] px-2 py-0.5 text-[10px] text-env-dev">Shadow</span>}<span className="ml-1 text-[11px] text-ink-2">{stateLabels[release.state]}</span></div></td>
                <td className="px-[10px] py-2">{release.engine === 'cep' && <span className="mr-1.5 bg-[#e8f5e9] px-1.5 py-0.5 text-[9px] text-env-production">CEP</span>}{release.assetSummary}</td>
                <td className="px-[10px] py-2 font-mono text-[10px] text-ink-3">{release.checksum}</td>
                <td className="px-[10px] py-2">{release.author}</td>
                <td className="whitespace-nowrap px-[10px] py-2 text-ink-3">{release.createdAt}</td>
                <td className="px-[10px] py-2">{serverProject ? <div className="flex flex-wrap gap-1.5">{release.state === 'built' && <button className="inline-flex h-7 items-center gap-1 rounded-[2px] border border-brand-primary px-2 text-[11px] text-brand-primary hover:bg-brand-primary-l disabled:opacity-50" disabled={deployRelease.isPending} onClick={() => deployRelease.mutate(release.id)}>{deployRelease.isPending ? <LoaderCircle size={12} className="animate-spin" /> : <Rocket size={12} />}部署</button>}{release.engine === 'cep' && <button type="button" className="inline-flex h-7 items-center rounded-[2px] border border-ink-border px-2 text-[11px] text-ink-2 hover:border-brand-primary hover:text-brand-primary" onClick={() => webhookReleaseId === release.id ? setWebhookReleaseId('') : openWebhook(release)}>{release.webhook?.enabled ? '回调已开' : '告警回调'}</button>}</div> : <span className="text-[10px] text-ink-3">-</span>}</td>
              </tr>
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

      <section className="mt-[14px] rounded-[3px] border border-ink-border bg-white px-4 py-3">
        <h2 className="flex items-center gap-2 text-xs font-semibold"><Server size={15} className="text-brand-primary" />{isCepProject ? 'CEP Runtime 部署目标' : 'RES 部署目标'}</h2>
        <p className="mt-2 text-[11px] text-ink-3">{serverProject ? `local 连接当前${isCepProject ? ' CEP adapter' : ' RES'} · 构建完成后手动部署 · 相同 Release 重复部署保持幂等` : 'production 连接 RES 集群 · Shadow 影子运行不写业务状态 · 部署必须由发布审核与部署角色共同批准'}</p>
      </section>
    </div>
  )
}
