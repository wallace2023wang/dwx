import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Code2,
  LoaderCircle,
  PackageCheck,
  Rocket,
  ShieldCheck,
  TestTube2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PackageNode, ReleaseDraft, ReleaseEnvironment, ReleaseType } from '../../types'

interface ReleaseWizardProps {
  packages: PackageNode[]
  suggestedVersion: string
  failedTests: number
  isBuilding: boolean
  buildError?: string
  singleTarget?: boolean
  onRepublishTarget?: (targetId: string) => void
  onCancel: () => void
  onBuild: (draft: ReleaseDraft, assetSummary: string) => Promise<void>
}

const steps = ['选择资产', '版本信息', '编译验证', '部署目标', '确认构建']

const environments: Array<{
  id: ReleaseEnvironment
  label: string
  strategy: string
  shadow: string
  tone: string
}> = [
  { id: 'dev', label: 'dev', strategy: '自动部署', shadow: '-', tone: 'bg-[#f3e5f5] text-env-dev' },
  { id: 'test', label: 'test', strategy: '自动部署并运行测试', shadow: '-', tone: 'bg-brand-primary-l text-brand-primary' },
  { id: 'staging', label: 'staging', strategy: '手动部署', shadow: '对比当前 production', tone: 'bg-[#fff3e0] text-env-staging' },
  { id: 'production', label: 'production', strategy: '双人审批后部署', shadow: '并行影子运行', tone: 'bg-[#e8f5e9] text-env-production' },
]

const localEnvironment = { id: 'local' as const, label: 'local', strategy: '手动部署到本机 RES', shadow: '-', tone: 'bg-[#e8f5e9] text-env-production' }

const releaseTypes: Array<{ id: ReleaseType; label: string; detail: string }> = [
  { id: 'patch', label: '补丁版本', detail: '规则修复' },
  { id: 'minor', label: '次版本', detail: '新增规则' },
  { id: 'major', label: '主版本', detail: 'BOM 变更' },
]

function StepIndicator({ current }: { current: number }) {
  return (
    <nav className="overflow-x-auto rounded-[3px] border border-ink-border bg-white" aria-label="Release 构建步骤">
      <ol className="flex min-w-[660px] px-5 py-3">
        {steps.map((label, index) => {
          const step = index + 1
          const complete = step < current
          const active = step === current
          return (
            <li key={label} className="flex flex-1 items-center last:flex-none">
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${step <= current ? 'bg-brand-primary text-white' : 'bg-[#e0e0e0] text-ink-2'}`}>
                {complete ? <Check size={13} strokeWidth={3} /> : step}
              </span>
              <span className={`ml-2 whitespace-nowrap text-[11px] ${active ? 'font-semibold text-ink-1' : step < current ? 'text-ink-1' : 'text-ink-3'}`}>{label}</span>
              {index < steps.length - 1 && <span className={`mx-4 h-px min-w-5 flex-1 ${step < current ? 'bg-brand-primary' : 'bg-ink-border'}`} />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function ValidationRow({ icon: Icon, label, result, state, detail }: {
  icon: typeof Code2
  label: string
  result: string
  state: 'passed' | 'warning'
  detail?: string
}) {
  return (
    <div className={`border-b border-[#e8e8e8] px-4 py-3 last:border-0 ${state === 'warning' ? 'bg-[#fffaf0]' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2"><Icon size={15} className={state === 'warning' ? 'text-env-staging' : 'text-env-production'} />{label}</span>
        <span className={`font-medium ${state === 'warning' ? 'text-[#c62828]' : 'text-env-production'}`}>{result}</span>
      </div>
      {detail && <p className="mt-2 pl-[23px] text-[11px] text-[#9f1f1f]">{detail}</p>}
    </div>
  )
}

export default function ReleaseWizard({ packages, suggestedVersion, failedTests, isBuilding, buildError, singleTarget = false, onRepublishTarget, onCancel, onBuild }: ReleaseWizardProps) {
  const assets = useMemo(() => packages.flatMap((packageNode) => packageNode.assets.map((asset) => ({ ...asset, packageName: packageNode.name }))), [packages])
  const defaultTargetId = useMemo(() => {
    const available = assets.filter(asset => !asset.needsRepublish)
    return (available.find(asset => asset.type === 'flow') || available[0] || assets.find(asset => asset.type === 'flow') || assets[0])?.id
  }, [assets])
  const [step, setStep] = useState(1)
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState<ReleaseDraft>({
    version: suggestedVersion,
    type: 'patch',
    notes: '',
    assetIds: singleTarget ? (defaultTargetId ? [defaultTargetId] : []) : assets.filter(asset => !asset.needsRepublish).map((asset) => asset.id),
    targetEnvironments: singleTarget ? ['local'] : ['dev', 'test'],
    knownIssueAccepted: false,
    approver: '',
  })

  const selectedAssets = assets.filter((asset) => draft.assetIds.includes(asset.id))
  const selectedTarget = selectedAssets[0]
  const assetSummary = packages
    .map((packageNode) => `${packageNode.name} ${packageNode.assets.filter((asset) => draft.assetIds.includes(asset.id)).length}`)
    .filter((summary) => !summary.endsWith(' 0'))
    .join(' · ')

  const updateDraft = <K extends keyof ReleaseDraft>(key: K, value: ReleaseDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setMessage('')
  }

  const toggleAsset = (assetId: string) => {
    updateDraft('assetIds', singleTarget
      ? [assetId]
      : draft.assetIds.includes(assetId) ? draft.assetIds.filter((id) => id !== assetId) : [...draft.assetIds, assetId])
  }

  const toggleEnvironment = (environment: ReleaseEnvironment) => updateDraft(
    'targetEnvironments',
    draft.targetEnvironments.includes(environment)
      ? draft.targetEnvironments.filter((item) => item !== environment)
      : [...draft.targetEnvironments, environment],
  )

  const validateStep = () => {
    if (step === 1 && draft.assetIds.length === 0) return '至少选择一个资产。'
    if (step === 1 && selectedTarget?.needsRepublish) return '该规则集依赖已有新发布版本，请先重新发布规则集。'
    if (step === 2 && !/^\d+\.\d+\.\d+$/.test(draft.version)) return '版本号必须使用 SemVer 格式，例如 2.2.0。'
    if (step === 2 && !draft.notes.trim()) return '请填写本次发布说明。'
    if (step === 3 && failedTests > 0 && !draft.knownIssueAccepted) return '测试存在失败场景，需要负责人确认后才能继续。'
    if (step === 4 && draft.targetEnvironments.length === 0) return '至少选择一个部署目标。'
    if (step === 4 && draft.targetEnvironments.includes('production') && !draft.approver) return '部署到 production 必须指定第二位审批人。'
    return ''
  }

  const next = async () => {
    const error = validateStep()
    if (error) {
      setMessage(error)
      return
    }
    if (step < 5) {
      setStep((current) => current + 1)
      setMessage('')
      return
    }
    await onBuild(draft, assetSummary)
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-medium">构建新 Release</h1>
          <p className="mt-0.5 text-[11px] text-ink-3">冻结规则资产、BOM、流程定义和校验和</p>
        </div>
        <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-3 text-xs hover:bg-[#f0f6fc]" onClick={onCancel}>
          <ArrowLeft size={14} />返回发布历史
        </button>
      </div>

      <StepIndicator current={step} />

      <section className="mt-[14px] min-h-[360px] rounded-[3px] border border-ink-border bg-white p-5" aria-label={`步骤 ${step}：${steps[step - 1]}`}>
        {step === 1 && (
          <div>
            <h2 className="mb-3 text-[13px] font-medium">{singleTarget ? '选择 Release 的发布目标' : '选择要包含在本 Release 中的资产'}</h2>
            {assets.length === 0 ? (
              <div className="flex min-h-36 items-center justify-center border border-ink-border bg-[#fafafa] px-6 text-center text-xs text-ink-3">
                {singleTarget ? '当前没有已发布的规则集。请先在“规则集”中完成编排、校验并发布，再构建 Release。' : '当前没有可发布资产。'}
              </div>
            ) : <div className="overflow-x-auto border border-ink-border">
              <table className="w-full min-w-[620px] border-collapse text-left text-xs">
                <thead className="bg-[#fafafa] text-[11px] text-ink-2">
                  <tr>
                    <th className="w-10 border-b border-ink-border px-[10px] py-2">{!singleTarget && <input type="checkbox" aria-label="选择全部资产" checked={draft.assetIds.length === assets.filter(asset => !asset.needsRepublish).length} onChange={(event) => updateDraft('assetIds', event.target.checked ? assets.filter(asset => !asset.needsRepublish).map((asset) => asset.id) : [])} />}</th>
                    <th className="border-b border-ink-border px-[10px] py-2 font-semibold">资产</th>
                    <th className="border-b border-ink-border px-[10px] py-2 font-semibold">规则包</th>
                    <th className="border-b border-ink-border px-[10px] py-2 font-semibold">当前版本</th>
                    <th className="border-b border-ink-border px-[10px] py-2 font-semibold">状态</th>
                  </tr>
                </thead>
                <tbody>{assets.map((asset) => (
                  <tr key={asset.id} className="border-b border-[#e8e8e8] last:border-0 hover:bg-[#f0f6fc]">
                    <td className="px-[10px] py-2"><input type={singleTarget ? 'radio' : 'checkbox'} name={singleTarget ? 'release-target' : undefined} aria-label={`选择 ${asset.name}`} checked={draft.assetIds.includes(asset.id)} disabled={asset.needsRepublish} onChange={() => toggleAsset(asset.id)} /></td>
                    <td className="px-[10px] py-2">{asset.name}<span className="ml-2 text-[10px] text-ink-3">{asset.type === 'flow' ? '规则集' : asset.type === 'decision-table' ? '决策表' : asset.type === 'decision-tree' ? '决策树' : asset.type === 'scorecard' ? '计分卡' : asset.type === 'rule-template' ? '规则模板' : asset.type === 'event-stream' ? '事件流' : '规则'}</span></td>
                    <td className="px-[10px] py-2 font-mono text-[11px]">{asset.packageName}</td>
                    <td className="px-[10px] py-2 font-mono text-[11px] text-brand-primary">v{asset.version}</td>
                    <td className="px-[10px] py-2"><span className={`rounded-[2px] px-1.5 py-px text-[10px] ${asset.needsRepublish ? 'bg-[#fff3e0] text-[#b26a00]' : asset.status === 'published' ? 'bg-[#e8f5e9] text-env-production' : 'bg-[#fff3e0] text-env-staging'}`}>{asset.needsRepublish ? '需重新发布规则集' : asset.status === 'published' ? '已发布' : '草稿'}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>}
            <p className="mt-2 text-[11px] text-ink-3">{singleTarget ? '业务 Release 以规则集为最小发布单元；构建时会冻结规则集及其依赖版本，并重新执行 Drools 编译和必需测试套件。' : '草稿资产会随 Release 一起编译；编译失败将阻断构建。'}</p>
            {selectedTarget?.needsRepublish && <div className="mt-3 flex items-center justify-between gap-3 rounded-[3px] border border-[#ffcdd2] bg-[#fff5f5] p-3 text-[11px] text-[#9f1f1f]"><span className="flex items-start gap-2"><AlertTriangle size={14} className="mt-px shrink-0" />此规则集仍冻结旧依赖版本。请重新校验并发布规则集，再回来构建 Release。</span>{onRepublishTarget && <button type="button" className="shrink-0 rounded-[2px] border border-[#c62828] bg-white px-3 py-1.5 text-[11px] text-[#9f1f1f] hover:bg-[#fff0f0]" onClick={() => onRepublishTarget(selectedTarget.id)}>去规则集重新发布</button>}</div>}
          </div>
        )}

        {step === 2 && (
          <div className="max-w-[680px]">
            <h2 className="mb-4 text-[13px] font-medium">版本信息</h2>
            <div className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-x-5 gap-y-4 max-sm:grid-cols-1 max-sm:gap-y-2">
              <label className="pt-2 text-xs text-ink-2" htmlFor="release-version">版本号</label>
              <div><input id="release-version" className="control-input max-w-[260px] font-mono" value={draft.version} onChange={(event) => updateDraft('version', event.target.value)} /><p className="mt-1 text-[10px] text-ink-3">不含 v 前缀，使用 SemVer 格式</p></div>
              <label className="pt-2 text-xs text-ink-2" htmlFor="release-notes">发布说明</label>
              <textarea id="release-notes" rows={4} className="w-full rounded-[3px] border border-ink-border bg-white px-[10px] py-2 text-xs outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary" placeholder="说明本次规则或模型变更" value={draft.notes} onChange={(event) => updateDraft('notes', event.target.value)} />
              <span className="pt-2 text-xs text-ink-2">Release 类型</span>
              <div className="grid grid-cols-3 overflow-hidden rounded-[3px] border border-ink-border max-sm:grid-cols-1">
                {releaseTypes.map((type) => (
                  <label key={type.id} className={`cursor-pointer border-r border-ink-border px-3 py-2 text-center last:border-0 max-sm:border-b max-sm:border-r-0 max-sm:last:border-b-0 ${draft.type === type.id ? 'bg-brand-primary-l text-[#1d365d]' : 'bg-white hover:bg-[#f0f6fc]'}`}>
                    <input type="radio" className="sr-only" name="release-type" checked={draft.type === type.id} onChange={() => updateDraft('type', type.id)} />
                    <span className="block text-xs font-medium">{type.label}</span><span className="text-[10px] text-ink-3">{type.detail}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="mb-3 text-[13px] font-medium">编译与测试验证</h2>
            <div className="overflow-hidden rounded-[3px] border border-ink-border">
              <ValidationRow icon={Code2} label="Drools DRL 编译" result="通过 · 0 错误 0 警告" state="passed" />
              <ValidationRow icon={PackageCheck} label="BOM 兼容性校验" result="通过 · 无删除或类型变更" state="passed" />
              <ValidationRow icon={TestTube2} label="必需测试套件" result={failedTests > 0 ? `${12 - failedTests}/12 通过` : '全部通过'} state={failedTests > 0 ? 'warning' : 'passed'} detail={failedTests > 0 ? '“多次逾期”场景期望 HIGH，实际 MEDIUM；继续构建会将其登记为已知问题。' : undefined} />
              <ValidationRow icon={ShieldCheck} label="规则冲突检测" result="通过 · 无重叠或矛盾规则" state="passed" />
            </div>
            {failedTests > 0 && (
              <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-[3px] border border-[#ffe082] bg-[#fff8e1] p-3 text-[11px] text-[#734d00]">
                <input className="mt-0.5" type="checkbox" checked={draft.knownIssueAccepted} onChange={(event) => updateDraft('knownIssueAccepted', event.target.checked)} />
                <span><b className="font-semibold">测试负责人确认：</b>李审核员已复核失败场景，同意将其作为已知问题记录在本次 Release 中。</span>
              </label>
            )}
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 className="mb-3 text-[13px] font-medium">部署计划（构建后手动执行）</h2>
            <div className="overflow-x-auto border border-ink-border">
              <table className="w-full min-w-[650px] border-collapse text-left text-xs">
                <thead className="bg-[#fafafa] text-[11px] text-ink-2"><tr><th className="w-10 border-b border-ink-border px-[10px] py-2" /><th className="border-b border-ink-border px-[10px] py-2 font-semibold">环境</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">部署策略</th><th className="border-b border-ink-border px-[10px] py-2 font-semibold">Shadow 对比</th></tr></thead>
                <tbody>{(singleTarget ? [localEnvironment] : environments).map((environment) => (
                  <tr key={environment.id} className="border-b border-[#e8e8e8] last:border-0 hover:bg-[#f0f6fc]">
                    <td className="px-[10px] py-2"><input type="checkbox" aria-label={`部署到 ${environment.label}`} checked={draft.targetEnvironments.includes(environment.id)} onChange={() => toggleEnvironment(environment.id)} /></td>
                    <td className="px-[10px] py-2"><span className={`rounded-[2px] px-2 py-1 text-[10px] ${environment.tone}`}>{environment.label}</span></td>
                    <td className="px-[10px] py-2">{environment.strategy}</td>
                    <td className="px-[10px] py-2 text-ink-3">{environment.shadow}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {draft.targetEnvironments.includes('production') && (
              <div className="mt-4 flex max-w-[500px] items-center gap-4 max-sm:flex-col max-sm:items-start">
                <label className="w-36 text-xs text-ink-2" htmlFor="release-approver">第二位审批人</label>
                <select id="release-approver" className="control-input max-w-[260px]" value={draft.approver} onChange={(event) => updateDraft('approver', event.target.value)}>
                  <option value="">请选择发布审核人</option><option value="li-reviewer">李审核员</option><option value="zhao-reviewer">赵审核员</option>
                </select>
              </div>
            )}
            <p className="mt-3 text-[11px] text-ink-3">此步骤只记录部署计划，不会自动部署。构建完成后需在发布历史中点击“部署”；若已有当前生效版本，还需点击“激活”才会切换稳定入口。</p>
          </div>
        )}

        {step === 5 && (
          <div>
            <h2 className="mb-4 text-[13px] font-medium">确认构建 v{draft.version}</h2>
            <dl className="max-w-[760px] divide-y divide-[#e8e8e8] border border-ink-border text-xs">
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">版本号</dt><dd className="font-mono text-brand-primary">v{draft.version}</dd></div>
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">包含资产</dt><dd>{selectedAssets.length} 个（{assetSummary}）</dd></div>
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">服务类型</dt><dd>{selectedTarget?.type === 'flow' ? '规则集业务服务' : selectedTarget?.type === 'event-stream' ? '事件流服务' : '独立资产服务'}</dd></div>
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">发布说明</dt><dd>{draft.notes}</dd></div>
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">编译</dt><dd className="text-env-production">通过</dd></div>
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">测试</dt><dd className={failedTests > 0 ? 'text-[#c62828]' : 'text-env-production'}>{failedTests > 0 ? `${failedTests} 个已知失败场景，负责人已确认` : '全部通过'}</dd></div>
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">计划部署到</dt><dd className="flex flex-wrap gap-1">{draft.targetEnvironments.map((environment) => <span key={environment} className="rounded-[2px] bg-brand-primary-l px-2 py-0.5 text-[10px] text-brand-primary">{environment}</span>)}</dd></div>
              <div className="grid grid-cols-[150px_1fr] px-3 py-2.5 max-sm:grid-cols-[110px_1fr]"><dt className="text-ink-3">校验和</dt><dd className="font-mono text-[11px] text-ink-3">SHA-256 将在构建时生成</dd></div>
            </dl>
            {failedTests > 0 && <div className="mt-4 flex items-start gap-2 rounded-[3px] border border-[#ffe082] bg-[#fff8e1] p-3 text-[11px] text-[#734d00]"><AlertTriangle size={15} className="mt-px shrink-0" />本 Release 将携带已知测试问题，进入 staging 前仍需修复并重新执行门禁。</div>}
          </div>
        )}
      </section>

      {(message || buildError) && <p className="mt-3 text-[11px] text-[#c62828]" role="alert">{message || buildError}</p>}
      <div className="mt-[14px] flex justify-between">
        <button type="button" className={`inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-ink-border bg-white px-4 text-xs hover:bg-[#f0f6fc] ${step === 1 ? 'invisible' : ''}`} onClick={() => { setStep((current) => Math.max(1, current - 1)); setMessage('') }}>
          <ArrowLeft size={14} />上一步
        </button>
        <button type="button" className="primary-button" onClick={() => void next()} disabled={isBuilding}>
          {isBuilding ? <LoaderCircle size={14} className="animate-spin" /> : step === 5 ? <Rocket size={14} /> : <ArrowRight size={14} />}
          {isBuilding ? '构建中...' : step === 5 ? '构建 Release' : '下一步'}
        </button>
      </div>
    </div>
  )
}
