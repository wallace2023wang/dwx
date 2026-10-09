import { GitBranch, LoaderCircle, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useBom } from '../../api/bom'
import { useCompileFlow, useCreateFlow, usePublishFlow, useRuleFlow, useRulesets, useSaveFlow, useTransferFlowOwner } from '../../api/flows'
import { isRevisionConflict } from '../../api/errors'
import { useAssetCollaboration } from '../../api/collaboration'
import AssetOwnershipBar from '../../components/assets/AssetOwnershipBar'
import AssetGovernanceBar from '../../components/assets/AssetGovernanceBar'
import DraftConflictModal from '../../components/assets/DraftConflictModal'
import AssetCollaborationBar from '../../components/assets/AssetCollaborationBar'
import FlowCanvas from '../../components/flow/FlowCanvas'
import FlowEditor from '../../components/flow/FlowEditor'
import RulesetConfig from '../../components/flow/RulesetConfig'
import { useProjectStore } from '../../store/project'
import type { FlowDefinition, FlowDetail, FlowDraft } from '../../types'
import { useSessionStore } from '../../store/session'
import { threeWayMerge, type DraftMergeConflict } from '../../lib/threeWayMerge'

export default function FlowTab() {
  const { projectId } = useParams()
  const [searchParams] = useSearchParams()
  const requestedFlowId = searchParams.get('flow')
  const editable = Boolean(projectId)
  const { data: rulesets, isPending: isRulesetsPending } = useRulesets(projectId)
  const currentRuleset = useProjectStore((state) => state.currentRuleset)
  const setCurrentRuleset = useProjectStore((state) => state.setCurrentRuleset)
  const selectedRuleset = rulesets?.find((ruleset) => ruleset.id === requestedFlowId)
    ?? rulesets?.find((ruleset) => ruleset.id === currentRuleset)
    ?? rulesets?.[0]
  const { data: flow, isPending: isFlowPending } = useRuleFlow(projectId, selectedRuleset?.id)
  const { data: bom } = useBom(projectId)
  const createFlow = useCreateFlow(projectId)
  const saveFlow = useSaveFlow(projectId, selectedRuleset?.id)
  const compileFlow = useCompileFlow(projectId, selectedRuleset?.id)
  const publishFlow = usePublishFlow(projectId, selectedRuleset?.id)
  const transferOwner = useTransferFlowOwner(projectId, selectedRuleset?.id)
  const [draftConflict, setDraftConflict] = useState<DraftMergeConflict<FlowDraft> | null>(null)
  const user = useSessionStore(state => state.user)
  const realFlow = flow && 'draft' in flow ? flow as FlowDetail : null
  const canManageDraft = Boolean(realFlow && user && (!realFlow.owner || realFlow.owner.id === user.id || user.roles.includes('admin') || user.permissions?.includes('*')))
  const collaboration = useAssetCollaboration({ projectId, assetType: 'flow', assetId: realFlow?.id, revision: realFlow?.revision, mode: canManageDraft ? 'editing' : 'viewing', enabled: Boolean(realFlow) })
  const collaborationBar = realFlow?.revision && collaboration.state
    ? <AssetCollaborationBar members={collaboration.state.members} clientId={collaboration.clientId} localRevision={realFlow.revision} currentRevision={collaboration.state.currentRevision} error={collaboration.error} />
    : null
  const busy = saveFlow.isPending || compileFlow.isPending || publishFlow.isPending

  useEffect(() => {
    if (selectedRuleset && selectedRuleset.id !== currentRuleset) setCurrentRuleset(selectedRuleset.id)
  }, [currentRuleset, selectedRuleset, setCurrentRuleset])
  useEffect(() => setDraftConflict(null), [selectedRuleset?.id])

  const create = async () => {
    const detail = await createFlow.mutateAsync()
    setCurrentRuleset(detail.id)
  }

  const save = async (draft: FlowDraft) => {
    if (!realFlow) throw new Error('规则集不存在')
    try {
      await saveFlow.mutateAsync({ revision: realFlow.revision ?? 1, draft })
    } catch (cause) {
      if (!isRevisionConflict<{ draft?: FlowDraft }>(cause) || !cause.current?.draft || !cause.currentRevision) throw cause
      const result = threeWayMerge(realFlow.draft, draft, cause.current.draft)
      if (!result.conflicts.length) {
        await saveFlow.mutateAsync({ revision: cause.currentRevision, draft: result.value })
        return
      }
      setDraftConflict({ base: realFlow.draft, local: draft, remote: cause.current.draft, currentRevision: cause.currentRevision, result })
      throw new Error(`检测到 ${result.conflicts.length} 项并发修改，请在冲突窗口中选择保留内容`)
    }
  }

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-base font-medium"><GitBranch size={17} />规则集</h1>
          <p className="mt-0.5 text-[11px] text-ink-3">通过规则包、决策表和条件分支编排可执行决策流程</p>
        </div>
        {editable && <button type="button" className="primary-button" disabled={createFlow.isPending} onClick={() => void create()}>{createFlow.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}新建规则集</button>}
      </div>

      {createFlow.error && <div className="mb-3 rounded-[3px] border border-[#ffcdd2] bg-[#fff5f5] px-3 py-2 text-[11px] text-[#c62828]">{createFlow.error.message}</div>}
      {isRulesetsPending
          ? <div className="p-6 text-xs text-ink-3">正在加载规则集...</div>
        : !rulesets?.length
          ? <div className="flex h-[280px] items-center justify-center rounded-[3px] border border-ink-border bg-white text-xs text-ink-3">当前项目没有规则集。</div>
          : <div className="space-y-[14px]">
              <RulesetConfig rulesets={rulesets} selectedId={selectedRuleset?.id ?? ''} onSelect={setCurrentRuleset} />
              {isFlowPending || !flow
                ? <div className="flex h-[460px] items-center justify-center rounded-[3px] border border-ink-border bg-white text-xs text-ink-3">正在加载规则集...</div>
                : editable && realFlow && canManageDraft
                  ? <div className="overflow-hidden rounded-[3px] border border-ink-border bg-white"><AssetOwnershipBar owner={realFlow.owner} user={user} busy={transferOwner.isPending} onTransfer={(ownerId, ownerName) => transferOwner.mutateAsync({ revision: realFlow.revision ?? 1, ownerId, ownerName })} /><AssetGovernanceBar projectId={projectId} asset={{ ...realFlow, type: 'flow', revision: realFlow.revision ?? 1 }} />{collaborationBar}<FlowEditor
                      detail={realFlow}
                      fields={bom?.factTypes.flatMap(fact => fact.fields) ?? []}
                      busy={busy}
                      onSave={save}
                      onCompile={draft => compileFlow.mutateAsync({ revision: realFlow.revision ?? 1, draft })}
                      onPublish={async () => { await publishFlow.mutateAsync(realFlow.revision ?? 1) }}
                    /></div>
                  : <div className="overflow-hidden rounded-[3px] border border-ink-border bg-white">{realFlow && <><AssetOwnershipBar owner={realFlow.owner} user={user} busy={transferOwner.isPending} onTransfer={(ownerId, ownerName) => transferOwner.mutateAsync({ revision: realFlow.revision ?? 1, ownerId, ownerName })} /><AssetGovernanceBar projectId={projectId} asset={{ ...realFlow, type: 'flow', revision: realFlow.revision ?? 1 }} disabled={!canManageDraft} /></>}{collaborationBar}<FlowCanvas flow={flow as FlowDefinition} /></div>}
            </div>}
      {draftConflict && <DraftConflictModal conflict={draftConflict} busy={saveFlow.isPending} onClose={() => setDraftConflict(null)} onSave={async (draft, currentRevision) => { await saveFlow.mutateAsync({ revision: currentRevision, draft }); setDraftConflict(null) }} />}
    </div>
  )
}
