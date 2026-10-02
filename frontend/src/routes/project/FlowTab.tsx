import { GitBranch, LoaderCircle, Plus } from 'lucide-react'
import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useBom } from '../../api/bom'
import { useCompileFlow, useCreateFlow, usePublishFlow, useRuleFlow, useRulesets, useSaveFlow } from '../../api/flows'
import FlowCanvas from '../../components/flow/FlowCanvas'
import FlowEditor from '../../components/flow/FlowEditor'
import RulesetConfig from '../../components/flow/RulesetConfig'
import { useProjectStore } from '../../store/project'
import type { FlowDefinition, FlowDetail } from '../../types'

export default function FlowTab() {
  const { projectId } = useParams()
  const [searchParams] = useSearchParams()
  const requestedFlowId = searchParams.get('flow')
  const editable = Boolean(projectId && !['miniloan', 'grain-temperature'].includes(projectId))
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
  const realFlow = flow && 'draft' in flow ? flow as FlowDetail : null
  const busy = saveFlow.isPending || compileFlow.isPending || publishFlow.isPending

  useEffect(() => {
    if (selectedRuleset && selectedRuleset.id !== currentRuleset) setCurrentRuleset(selectedRuleset.id)
  }, [currentRuleset, selectedRuleset, setCurrentRuleset])

  const create = async () => {
    const detail = await createFlow.mutateAsync()
    setCurrentRuleset(detail.id)
  }

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-base font-medium"><GitBranch size={17} />规则流</h1>
          <p className="mt-0.5 text-[11px] text-ink-3">通过规则包、决策表和条件分支编排可执行决策流程</p>
        </div>
        {editable && <button type="button" className="primary-button" disabled={createFlow.isPending} onClick={() => void create()}>{createFlow.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}新建规则流</button>}
      </div>

      {createFlow.error && <div className="mb-3 rounded-[3px] border border-[#ffcdd2] bg-[#fff5f5] px-3 py-2 text-[11px] text-[#c62828]">{createFlow.error.message}</div>}
      {isRulesetsPending
          ? <div className="p-6 text-xs text-ink-3">正在加载规则流...</div>
        : !rulesets?.length
          ? <div className="flex h-[280px] items-center justify-center rounded-[3px] border border-ink-border bg-white text-xs text-ink-3">当前项目没有规则流。</div>
          : <div className="space-y-[14px]">
              <RulesetConfig rulesets={rulesets} selectedId={selectedRuleset?.id ?? ''} onSelect={setCurrentRuleset} />
              {isFlowPending || !flow
                ? <div className="flex h-[460px] items-center justify-center rounded-[3px] border border-ink-border bg-white text-xs text-ink-3">正在加载规则流...</div>
                : editable && realFlow
                  ? <FlowEditor
                      detail={realFlow}
                      fields={bom?.factTypes.flatMap(fact => fact.fields) ?? []}
                      busy={busy}
                      onSave={async draft => { await saveFlow.mutateAsync({ revision: realFlow.revision ?? 1, draft }) }}
                      onCompile={draft => compileFlow.mutateAsync({ revision: realFlow.revision ?? 1, draft })}
                      onPublish={async () => { await publishFlow.mutateAsync(realFlow.revision ?? 1) }}
                    />
                  : <FlowCanvas flow={flow as FlowDefinition} />}
            </div>}
    </div>
  )
}
