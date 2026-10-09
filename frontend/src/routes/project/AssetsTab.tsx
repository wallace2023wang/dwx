import { LockKeyhole } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useBom } from '../../api/bom'
import { useAnalyzeDecisionTable, useAssetDetail, useBatchAssets, useCompileAsset, useCreateAsset, useCreatePackage, useDeleteAsset, useDeletePackage, useDeprecateAsset, useDuplicateAsset, useMoveAsset, usePackages, useProject, useReactivateAsset, useRenameAsset, useSaveAsset, useSubmitAsset, useTransferAssetOwner, useUpdatePackage } from '../../api/projects'
import { isRevisionConflict } from '../../api/errors'
import { useAssetCollaboration } from '../../api/collaboration'
import Modal from '../../components/Modal'
import AssetList from '../../components/assets/AssetList'
import DraftConflictModal from '../../components/assets/DraftConflictModal'
import AssetCollaborationBar from '../../components/assets/AssetCollaborationBar'
import AssetOwnershipBar from '../../components/assets/AssetOwnershipBar'
import BalEditor from '../../components/assets/BalEditor'
import CreateAssetDialog, { type CreateAssetForm } from '../../components/assets/CreateAssetDialog'
import DecisionTableEditor from '../../components/assets/DecisionTableEditor'
import DecisionTreeEditor from '../../components/assets/DecisionTreeEditor'
import ScorecardEditor from '../../components/assets/ScorecardEditor'
import EditableDecisionTable from '../../components/assets/EditableDecisionTable'
import PackageTree from '../../components/assets/PackageTree'
import RuleFormEditor from '../../components/assets/RuleFormEditor'
import type { Asset, AssetDraft, PackageNode } from '../../types'
import { useSessionStore } from '../../store/session'
import { threeWayMerge, type DraftMergeConflict } from '../../lib/threeWayMerge'

type PackageDialog = { mode: 'create' | 'rename'; entry?: PackageNode; parentId: string | null }
type BatchDialog = { action: 'metadata' | 'move' | 'owner' | 'archive'; assets: Asset[] }

const packageNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,2}$/

export default function AssetsTab() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedAssetId = searchParams.get('asset')
  const editable = Boolean(projectId)
  const { data: project } = useProject(projectId)
  const { data: packages = [] } = usePackages(projectId, true)
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(requestedAssetId)
  const [draftConflict, setDraftConflict] = useState<DraftMergeConflict<AssetDraft> | null>(null)
  const [packageDialog, setPackageDialog] = useState<PackageDialog | null>(null)
  const [packageForm, setPackageForm] = useState({ name: '', label: '', parentId: '' })
  const [deletePackageTarget, setDeletePackageTarget] = useState<PackageNode | null>(null)
  const [packageDeleteMode, setPackageDeleteMode] = useState<'move' | 'delete'>('move')
  const [movePackageTarget, setMovePackageTarget] = useState('')
  const [createDialog, setCreateDialog] = useState(false)
  const [createForm, setCreateForm] = useState<CreateAssetForm>({ name: '', category: '', type: 'rule', hitPolicy: 'COLLECT', conditionFields: [], actionFields: [] })
  const [duplicateTarget, setDuplicateTarget] = useState<Asset | null>(null)
  const [duplicateName, setDuplicateName] = useState('')
  const [renameTarget, setRenameTarget] = useState<Asset | null>(null)
  const [renameName, setRenameName] = useState('')
  const [moveTarget, setMoveTarget] = useState<Asset | null>(null)
  const [moveTo, setMoveTo] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null)
  const [deprecateTarget, setDeprecateTarget] = useState<Asset | null>(null)
  const [deprecationReason, setDeprecationReason] = useState('')
  const [replacementId, setReplacementId] = useState('')
  const [batchDialog, setBatchDialog] = useState<BatchDialog | null>(null)
  const [batchForm, setBatchForm] = useState({ tags: '', effectiveFrom: '', effectiveTo: '', targetPackage: '', ownerId: '', ownerName: '' })
  const [selectionKey, setSelectionKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const assets = useMemo(() => selectedPackageId ? packages.find(entry => entry.id === selectedPackageId)?.assets ?? [] : packages.flatMap(entry => entry.assets), [packages, selectedPackageId])
  const allAssets = useMemo(() => packages.flatMap(entry => entry.assets), [packages])
  const selectedAsset = allAssets.find(asset => asset.id === selectedAssetId)
  const { data: detail, isFetching: detailLoading } = useAssetDetail(projectId, selectedAssetId)
  const { data: bom } = useBom(projectId)
  const saveAsset = useSaveAsset(projectId, selectedAssetId)
  const compileAsset = useCompileAsset(projectId, selectedAssetId)
  const submitReview = useSubmitAsset(projectId, selectedAssetId)
  const analyzeTable = useAnalyzeDecisionTable(projectId, selectedAssetId)
  const createAsset = useCreateAsset(projectId)
  const createPackage = useCreatePackage(projectId)
  const updatePackage = useUpdatePackage(projectId)
  const deletePackage = useDeletePackage(projectId)
  const duplicateAsset = useDuplicateAsset(projectId)
  const renameAsset = useRenameAsset(projectId)
  const moveAsset = useMoveAsset(projectId)
  const deleteAsset = useDeleteAsset(projectId)
  const deprecateAsset = useDeprecateAsset(projectId)
  const reactivateAsset = useReactivateAsset(projectId)
  const transferOwner = useTransferAssetOwner(projectId)
  const batchAssets = useBatchAssets(projectId)
  const user = useSessionStore(state => state.user)
  const fields = bom?.factTypes.flatMap(fact => fact.fields.map(field => ({ ...field, factName: fact.name, factLabel: fact.label }))) ?? []
  const projectVariables = project?.variables ?? []
  const busy = saveAsset.isPending || compileAsset.isPending || submitReview.isPending
  const canManageDraft = Boolean(detail && user && (!detail.owner || detail.owner.id === user.id || user.roles.includes('admin') || user.permissions?.includes('*')))
  const collaboration = useAssetCollaboration({
    projectId,
    assetType: ['decision-table', 'decision-tree', 'scorecard'].includes(selectedAsset?.type || '') ? 'table' : selectedAsset?.type === 'rule' ? 'rule' : undefined,
    assetId: detail?.id,
    revision: detail?.revision,
    mode: canManageDraft ? 'editing' : 'viewing',
    enabled: Boolean(detail && !['deprecated', 'archived'].includes(detail.status)),
  })
  const collaborationBar = detail?.revision && collaboration.state
    ? <AssetCollaborationBar members={collaboration.state.members} clientId={collaboration.clientId} localRevision={detail.revision} currentRevision={collaboration.state.currentRevision} error={collaboration.error} />
    : null
  const packageTitle = selectedPackageId ? (packages.find(entry => entry.id === selectedPackageId)?.label || packages.find(entry => entry.id === selectedPackageId)?.name || '全部资产') : '全部资产'
  const deletePackageAssetCount = deletePackageTarget ? packages.filter(pkg => pkg.name === deletePackageTarget.name || pkg.name.startsWith(`${deletePackageTarget.name}.`)).reduce((count, pkg) => count + pkg.assets.length, 0) : 0
  const packageFullName = packageForm.parentId && !packageForm.name.includes('.') ? `${packageForm.parentId}.${packageForm.name.trim()}` : packageForm.name.trim()
  const packageNameError = packageDialog && packageFullName && !packageNamePattern.test(packageFullName)
    ? '英文包名只能使用小写字母、数字、下划线和点号；中文请填写到“中文显示名”。'
    : null

  useEffect(() => {
    if (requestedAssetId && allAssets.some(asset => asset.id === requestedAssetId)) {
      setSelectedPackageId(null)
      setSelectedAssetId(requestedAssetId)
    }
  }, [allAssets, requestedAssetId])
  useEffect(() => setDraftConflict(null), [detail?.id])

  const revision = () => { if (!detail?.revision) throw new Error('资产修订号缺失，请刷新后重试'); return detail.revision }
  const save = async (draft: AssetDraft) => {
    if (!detail?.draft) throw new Error('资产草稿不存在')
    try {
      await saveAsset.mutateAsync({ revision: revision(), draft })
    } catch (cause) {
      if (!isRevisionConflict<{ draft?: AssetDraft }>(cause) || !cause.current?.draft || !cause.currentRevision) throw cause
      const result = threeWayMerge(detail.draft, draft, cause.current.draft)
      if (!result.conflicts.length) {
        await saveAsset.mutateAsync({ revision: cause.currentRevision, draft: result.value })
        return
      }
      setDraftConflict({ base: detail.draft, local: draft, remote: cause.current.draft, currentRevision: cause.currentRevision, result })
      throw new Error(`检测到 ${result.conflicts.length} 项并发修改，请在冲突窗口中选择保留内容`)
    }
  }
  const compile = (draft: AssetDraft) => compileAsset.mutateAsync({ revision: revision(), draft })
  const submit = async () => { await submitReview.mutateAsync(revision()) }
  const openBom = (fieldKey: string) => navigate(`../bom?field=${encodeURIComponent(fieldKey)}`)

  const openPackage = (dialog: PackageDialog) => {
    setPackageDialog(dialog)
    setPackageForm(dialog.entry ? { name: dialog.entry.name, label: dialog.entry.label, parentId: dialog.entry.parentId || '' } : { name: dialog.parentId ? '' : '', label: '', parentId: dialog.parentId || '' })
    setError(null)
  }
  const submitPackage = async () => {
    if (!packageDialog) return
    setError(null)
    try {
      const payload = { name: packageForm.name, label: packageForm.label, parentId: packageForm.parentId || null }
      if (packageDialog.mode === 'rename' && packageDialog.entry) {
        const updated = await updatePackage.mutateAsync({ currentName: packageDialog.entry.name, ...payload })
        if (selectedPackageId === packageDialog.entry.id) setSelectedPackageId(updated.id)
      } else await createPackage.mutateAsync(payload)
      setPackageDialog(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存规则包失败') }
  }
  const openCreate = () => {
    const category = selectedPackageId || packages[0]?.id || ''
    setCreateForm({ name: '', category, type: 'rule', hitPolicy: 'COLLECT', conditionFields: [], actionFields: [] })
    setError(null)
    setCreateDialog(true)
  }
  const submitAsset = async () => {
    setError(null)
    try {
      const created = await createAsset.mutateAsync(createForm)
      if (created.type !== createForm.type) {
        throw new Error(`服务端返回了${created.type === 'rule' ? 'BAL 规则' : created.type}，与所选${createForm.type === 'decision-tree' ? '决策树' : createForm.type === 'decision-table' ? '决策表' : createForm.type === 'scorecard' ? '计分卡' : 'BAL 规则'}不一致；请重启 Team Server 后重试`)
      }
      setCreateDialog(false)
      setSelectedPackageId(null)
      setSelectedAssetId(created.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建资产失败') }
  }
  const openBatch = (action: BatchDialog['action'], selected: Asset[]) => {
    setBatchDialog({ action, assets: selected })
    setBatchForm({ tags: '', effectiveFrom: '', effectiveTo: '', targetPackage: packages[0]?.id || '', ownerId: '', ownerName: '' })
    setError(null)
  }
  const submitBatch = async () => {
    if (!batchDialog) return
    const items = batchDialog.assets.map(asset => ({ id: asset.id, type: ['decision-table', 'decision-tree', 'scorecard'].includes(asset.type) ? 'table' as const : 'rule' as const, revision: asset.revision || 1 }))
    setError(null)
    try {
      if (batchDialog.action === 'metadata') await batchAssets.mutateAsync({ action: 'metadata', items, tags: batchForm.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean), effectiveFrom: batchForm.effectiveFrom || null, effectiveTo: batchForm.effectiveTo || null })
      if (batchDialog.action === 'move') await batchAssets.mutateAsync({ action: 'move', items, targetPackage: batchForm.targetPackage })
      if (batchDialog.action === 'owner') await batchAssets.mutateAsync({ action: 'owner', items, ownerId: batchForm.ownerId.trim(), ownerName: batchForm.ownerName.trim() || batchForm.ownerId.trim() })
      if (batchDialog.action === 'archive') await batchAssets.mutateAsync({ action: 'archive', items })
      setBatchDialog(null)
      setSelectionKey(value => value + 1)
      if (items.some(item => item.id === selectedAssetId) && batchDialog.action === 'archive') setSelectedAssetId(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '批量操作失败') }
  }
  return (
    <div className="flex h-full min-w-[960px] overflow-hidden bg-ink-bg">
      <PackageTree packages={packages} selectedId={selectedPackageId} editable={editable} onSelect={id => { setSelectedPackageId(id); setSelectedAssetId(null) }} onCreate={parentId => openPackage({ mode: 'create', parentId })} onRename={entry => openPackage({ mode: 'rename', entry, parentId: entry.parentId || null })} onDelete={entry => { setError(null); setDeletePackageTarget(entry); setPackageDeleteMode('move'); setMovePackageTarget(packages.find(pkg => pkg.id !== entry.id && !pkg.name.startsWith(`${entry.name}.`))?.id || '') }} />
      <AssetList title={packageTitle} assets={assets} selectedId={selectedAssetId} editable={editable} onSelect={setSelectedAssetId} onCreate={openCreate} onRename={asset => { setRenameTarget(asset); setRenameName(asset.name) }} onDuplicate={asset => { setDuplicateTarget(asset); setDuplicateName(`${asset.name} 副本`) }} onMove={asset => { setMoveTarget(asset); setMoveTo(packages.find(pkg => !pkg.assets.some(item => item.id === asset.id))?.id || '') }} onDelete={setDeleteTarget} onDeprecate={asset => { setDeprecateTarget(asset); setDeprecationReason(''); setReplacementId('') }} onReactivate={asset => void reactivateAsset.mutateAsync({ assetId: asset.id })} selectionKey={selectionKey} onBatchMetadata={selected => openBatch('metadata', selected)} onBatchMove={selected => openBatch('move', selected)} onBatchOwner={selected => openBatch('owner', selected)} onBatchArchive={selected => openBatch('archive', selected)} />
      {editable && detail?.draft && !['in-review', 'deprecated', 'archived'].includes(detail.status) && canManageDraft && selectedAsset?.type === 'scorecard'
        ? <div className="flex min-w-[500px] flex-1 flex-col overflow-hidden"><AssetOwnershipBar owner={detail.owner} user={user} busy={transferOwner.isPending} onTransfer={(ownerId, ownerName) => transferOwner.mutateAsync({ assetId: detail.id, revision: revision(), ownerId, ownerName })} />{collaborationBar}<div className="min-h-0 flex-1"><ScorecardEditor detail={detail} fields={fields} busy={busy} editable onSave={save} onCompile={compile} onSubmit={submit} /></div></div>
        : editable && detail?.draft && !['in-review', 'deprecated', 'archived'].includes(detail.status) && canManageDraft && selectedAsset?.type === 'decision-tree'
        ? <div className="flex min-w-[500px] flex-1 flex-col overflow-hidden"><AssetOwnershipBar owner={detail.owner} user={user} busy={transferOwner.isPending} onTransfer={(ownerId, ownerName) => transferOwner.mutateAsync({ assetId: detail.id, revision: revision(), ownerId, ownerName })} />{collaborationBar}<div className="min-h-0 flex-1"><DecisionTreeEditor detail={detail} fields={fields} projectVariables={projectVariables} busy={busy} editable onSave={save} onCompile={compile} onSubmit={submit} /></div></div>
        : editable && detail?.draft && !['in-review', 'deprecated', 'archived'].includes(detail.status) && canManageDraft && selectedAsset?.type === 'decision-table'
        ? <div className="flex min-w-[500px] flex-1 flex-col overflow-hidden"><AssetOwnershipBar owner={detail.owner} user={user} busy={transferOwner.isPending} onTransfer={(ownerId, ownerName) => transferOwner.mutateAsync({ assetId: detail.id, revision: revision(), ownerId, ownerName })} />{collaborationBar}<div className="min-h-0 flex-1"><EditableDecisionTable detail={detail} fields={fields} projectVariables={projectVariables} busy={busy} onSave={save} onCompile={compile} onSubmit={submit} onAnalyze={draft => analyzeTable.mutateAsync({ revision: revision(), draft })} /></div></div>
        : editable && detail?.draft && !['in-review', 'deprecated', 'archived'].includes(detail.status) && canManageDraft && selectedAsset?.type === 'rule'
          ? <div className="flex min-w-[500px] flex-1 flex-col overflow-hidden"><AssetOwnershipBar owner={detail.owner} user={user} busy={transferOwner.isPending} onTransfer={(ownerId, ownerName) => transferOwner.mutateAsync({ assetId: detail.id, revision: revision(), ownerId, ownerName })} />{collaborationBar}<div className="min-h-0 flex-1"><RuleFormEditor detail={detail} fields={fields} projectVariables={projectVariables} busy={busy} onSave={save} onCompile={compile} onSubmit={submit} onOpenBom={openBom} /></div></div>
          : detail?.status === 'in-review'
            ? <div className="flex min-w-[500px] flex-1 flex-col overflow-hidden"><div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#9bbcf7] bg-brand-primary-l px-3 text-[11px] text-brand-primary"><LockKeyhole size={13} />该资产正在审核，当前修订已锁定。<button className="ml-auto h-6 border border-brand-primary bg-white px-2" onClick={() => navigate('../reviews')}>查看审核</button></div><div className="min-h-0 flex-1">{selectedAsset?.type === 'scorecard' ? <ScorecardEditor detail={detail} fields={fields} /> : selectedAsset?.type === 'decision-tree' ? <DecisionTreeEditor detail={detail} fields={fields} projectVariables={projectVariables} /> : selectedAsset?.type === 'decision-table' ? <DecisionTableEditor detail={detail} /> : <BalEditor detail={detail} fields={fields} projectVariables={projectVariables} loading={detailLoading} onOpenBom={openBom} />}</div></div>
            : detail && !canManageDraft && !['in-review', 'deprecated', 'archived'].includes(detail.status)
              ? <div className="flex min-w-[500px] flex-1 flex-col overflow-hidden"><AssetOwnershipBar owner={detail.owner} user={user} busy={transferOwner.isPending} onTransfer={(ownerId, ownerName) => transferOwner.mutateAsync({ assetId: detail.id, revision: revision(), ownerId, ownerName })} />{collaborationBar}<div className="min-h-0 flex-1">{selectedAsset?.type === 'scorecard' ? <ScorecardEditor detail={detail} fields={fields} /> : selectedAsset?.type === 'decision-tree' ? <DecisionTreeEditor detail={detail} fields={fields} projectVariables={projectVariables} /> : selectedAsset?.type === 'decision-table' ? <DecisionTableEditor detail={detail} /> : <BalEditor detail={detail} fields={fields} projectVariables={projectVariables} loading={detailLoading} onOpenBom={openBom} />}</div></div>
              : selectedAsset?.type === 'scorecard' && detail ? <ScorecardEditor detail={detail} fields={fields} /> : selectedAsset?.type === 'decision-tree' && detail ? <DecisionTreeEditor detail={detail} fields={fields} projectVariables={projectVariables} /> : selectedAsset?.type === 'decision-table' && detail ? <DecisionTableEditor detail={detail} /> : <BalEditor detail={detail} fields={fields} projectVariables={projectVariables} loading={detailLoading} onOpenBom={openBom} />}

      {packageDialog && <Modal title={packageDialog.mode === 'rename' ? '重命名规则包' : packageDialog.parentId ? '新建子包' : '新建规则包'} onClose={() => setPackageDialog(null)}><div className="space-y-4 p-4"><label className="block text-[11px] font-semibold text-ink-2">英文包名<input className="control-input mt-1 font-mono" value={packageForm.name} onChange={event => setPackageForm({ ...packageForm, name: event.target.value })} placeholder={packageDialog.parentId ? 'income' : 'eligibility'} autoFocus /></label>{packageNameError ? <p className="-mt-2 text-[11px] text-[#c62828]">{packageNameError}</p> : <p className="-mt-2 text-[10px] text-ink-3">用于 API 和包路径，例如 eligibility 或 eligibility.income；中文名称填下一项。</p>}<label className="block text-[11px] font-semibold text-ink-2">中文显示名<input className="control-input mt-1" value={packageForm.label} onChange={event => setPackageForm({ ...packageForm, label: event.target.value })} placeholder="收入核查" /></label><label className="block text-[11px] font-semibold text-ink-2">父包<select className="control-input mt-1" value={packageForm.parentId} onChange={event => setPackageForm({ ...packageForm, parentId: event.target.value })}><option value="">根级</option>{packages.filter(pkg => pkg.name !== packageDialog.entry?.name && pkg.name.split('.').length < 3).map(pkg => <option key={pkg.id} value={pkg.name}>{pkg.name} {pkg.label}</option>)}</select></label>{error && <p className="text-[11px] text-[#c62828]">{error}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setPackageDialog(null)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={Boolean(packageNameError) || !packageForm.name.trim() || !packageForm.label.trim()} onClick={() => void submitPackage()}>保存</button></footer></Modal>}
      {deletePackageTarget && <Modal title="删除规则包" onClose={() => setDeletePackageTarget(null)}><div className="space-y-3 p-4 text-xs"><p>删除 <b>{deletePackageTarget.name}</b> 及其子包，共涉及 {deletePackageAssetCount} 个资产。</p>{deletePackageAssetCount > 0 && <><label className="flex gap-2"><input type="radio" checked={packageDeleteMode === 'move'} onChange={() => setPackageDeleteMode('move')} />移到其他包</label>{packageDeleteMode === 'move' && <select className="control-input" value={movePackageTarget} onChange={event => setMovePackageTarget(event.target.value)}>{packages.filter(pkg => pkg.id !== deletePackageTarget.id && !pkg.name.startsWith(`${deletePackageTarget.name}.`)).map(pkg => <option key={pkg.id} value={pkg.id}>{pkg.name} {pkg.label}</option>)}</select>}<label className="flex gap-2 text-[#a31515]"><input type="radio" checked={packageDeleteMode === 'delete'} onChange={() => setPackageDeleteMode('delete')} />同时删除包内资产</label></>}{error && <p className="text-[11px] text-[#c62828]">{error}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDeletePackageTarget(null)}>取消</button><button className="h-8 bg-[#c62828] px-3 text-[11px] text-white disabled:opacity-40" disabled={deletePackageAssetCount > 0 && packageDeleteMode === 'move' && !movePackageTarget} onClick={() => void deletePackage.mutateAsync({ name: deletePackageTarget.name, moveRulesTo: packageDeleteMode === 'move' && deletePackageAssetCount ? movePackageTarget : undefined, deleteAssets: packageDeleteMode === 'delete' }).then(() => { setDeletePackageTarget(null); setSelectedPackageId(null); setSelectedAssetId(null) }).catch(cause => setError(cause instanceof Error ? cause.message : '删除失败'))}>确认删除</button></footer></Modal>}
      {createDialog && <CreateAssetDialog form={createForm} packages={packages} fields={fields} error={error} onChange={setCreateForm} onClose={() => setCreateDialog(false)} onSubmit={() => void submitAsset()} />}
      {duplicateTarget && <Modal title="复制资产" onClose={() => setDuplicateTarget(null)}><div className="p-4"><label className="text-[11px] font-semibold text-ink-2">新名称<input className="control-input mt-1" value={duplicateName} onChange={event => setDuplicateName(event.target.value)} autoFocus /></label></div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDuplicateTarget(null)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white" onClick={() => void duplicateAsset.mutateAsync({ assetId: duplicateTarget.id, newName: duplicateName }).then(created => { setDuplicateTarget(null); setSelectedAssetId(created.id) })}>复制</button></footer></Modal>}
      {renameTarget && <Modal title="重命名资产" onClose={() => setRenameTarget(null)}><div className="p-4"><label className="text-[11px] font-semibold text-ink-2">名称<input className="control-input mt-1" value={renameName} onChange={event => setRenameName(event.target.value)} autoFocus /></label>{renameAsset.error && <p className="mt-2 text-[11px] text-[#c62828]">{renameAsset.error.message}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setRenameTarget(null)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={!renameName.trim() || renameAsset.isPending} onClick={() => void renameAsset.mutateAsync({ assetId: renameTarget.id, newName: renameName }).then(renamed => { setRenameTarget(null); setSelectedAssetId(renamed.id) }).catch(() => {})}>保存</button></footer></Modal>}
      {moveTarget && <Modal title="移动资产" onClose={() => setMoveTarget(null)}><div className="p-4"><label className="text-[11px] font-semibold text-ink-2">目标规则包<select className="control-input mt-1" value={moveTo} onChange={event => setMoveTo(event.target.value)}>{packages.map(pkg => <option key={pkg.id} value={pkg.id}>{pkg.name} {pkg.label}</option>)}</select></label></div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setMoveTarget(null)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white" onClick={() => void moveAsset.mutateAsync({ assetId: moveTarget.id, targetPackage: moveTo }).then(() => { setMoveTarget(null); setSelectedPackageId(moveTo); setSelectedAssetId(moveTarget.id) })}>移动</button></footer></Modal>}
      {deleteTarget && <Modal title="删除资产" onClose={() => setDeleteTarget(null)}><div className="space-y-2 p-4 text-xs"><p>确定归档 <b>{deleteTarget.name}</b>？</p>{deleteTarget.status === 'published' && <p className="border border-[#f3c65f] bg-[#fff8e1] p-2 text-[#734d00]">该资产已经发布，删除后需要构建新 Release 才能从运行环境移除。</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDeleteTarget(null)}>取消</button><button className="h-8 bg-[#c62828] px-3 text-[11px] text-white" onClick={() => void deleteAsset.mutateAsync(deleteTarget.id).then(() => { setDeleteTarget(null); setSelectedAssetId(null) })}>确认删除</button></footer></Modal>}
      {deprecateTarget && <Modal title="标记为废弃" onClose={() => setDeprecateTarget(null)}><div className="space-y-3 p-4 text-xs"><p>废弃后 <b>{deprecateTarget.name}</b> 将保留在规则包中，但不会再被 Rule Group、规则集或新 Release 引用。</p><label className="block text-[11px] font-semibold text-ink-2">废弃原因<textarea className="mt-1 min-h-20 w-full border border-ink-border p-2 font-normal outline-none focus:border-brand-primary" value={deprecationReason} onChange={event => setDeprecationReason(event.target.value)} maxLength={500} autoFocus /></label><label className="block text-[11px] font-semibold text-ink-2">替代资产（可选）<select className="control-input mt-1 font-normal" value={replacementId} onChange={event => setReplacementId(event.target.value)}><option value="">无</option>{allAssets.filter(asset => asset.id !== deprecateTarget.id && !['deprecated', 'archived'].includes(asset.status)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>{deprecateAsset.error && <p className="text-[11px] text-[#c62828]">{deprecateAsset.error.message}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setDeprecateTarget(null)}>取消</button><button className="h-8 bg-[#8a5a00] px-3 text-[11px] text-white disabled:opacity-40" disabled={!deprecationReason.trim() || deprecateAsset.isPending} onClick={() => void deprecateAsset.mutateAsync({ assetId: deprecateTarget.id, reason: deprecationReason.trim(), replacedByAssetId: replacementId || undefined }).then(() => setDeprecateTarget(null))}>确认废弃</button></footer></Modal>}
      {batchDialog && <Modal title={`批量${batchDialog.action === 'metadata' ? '设置标签和有效期' : batchDialog.action === 'move' ? '移动资产' : batchDialog.action === 'owner' ? '转交负责人' : '归档资产'}`} onClose={() => setBatchDialog(null)}><div className="space-y-3 p-4 text-xs"><p>已选择 <b>{batchDialog.assets.length}</b> 个资产：{batchDialog.assets.map(asset => asset.name).join('、')}</p>{batchDialog.action === 'metadata' && <><label className="block text-[11px] font-semibold text-ink-2">标签（逗号分隔，最多 10 个）<input className="control-input mt-1" value={batchForm.tags} onChange={event => setBatchForm({ ...batchForm, tags: event.target.value })} placeholder="风控, 核心, 2026" /></label><div className="grid grid-cols-2 gap-3"><label className="text-[11px] font-semibold text-ink-2">生效日期<input type="date" className="control-input mt-1" value={batchForm.effectiveFrom} onChange={event => setBatchForm({ ...batchForm, effectiveFrom: event.target.value })} /></label><label className="text-[11px] font-semibold text-ink-2">失效日期<input type="date" className="control-input mt-1" value={batchForm.effectiveTo} onChange={event => setBatchForm({ ...batchForm, effectiveTo: event.target.value })} /></label></div><p className="text-[10px] text-ink-3">首版仅用于治理提示和筛选，不自动切换生产 Release。</p></>}{batchDialog.action === 'move' && <label className="block text-[11px] font-semibold text-ink-2">目标规则包<select className="control-input mt-1" value={batchForm.targetPackage} onChange={event => setBatchForm({ ...batchForm, targetPackage: event.target.value })}>{packages.map(pkg => <option key={pkg.id} value={pkg.id}>{pkg.name} {pkg.label}</option>)}</select></label>}{batchDialog.action === 'owner' && <><label className="block text-[11px] font-semibold text-ink-2">用户 ID<input className="control-input mt-1 font-mono" value={batchForm.ownerId} onChange={event => setBatchForm({ ...batchForm, ownerId: event.target.value })} /></label><label className="block text-[11px] font-semibold text-ink-2">显示名称<input className="control-input mt-1" value={batchForm.ownerName} onChange={event => setBatchForm({ ...batchForm, ownerName: event.target.value })} /></label></>}{batchDialog.action === 'archive' && <p className="border border-[#f3c65f] bg-[#fff8e1] p-2 text-[#734d00]">归档后资产退出活动列表，但历史版本和 Release 保持不变。</p>}{error && <p className="text-[11px] text-[#c62828]">{error}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setBatchDialog(null)}>取消</button><button className={`h-8 px-3 text-[11px] text-white disabled:opacity-40 ${batchDialog.action === 'archive' ? 'bg-[#c62828]' : 'bg-brand-primary'}`} disabled={batchAssets.isPending || (batchDialog.action === 'move' && !batchForm.targetPackage) || (batchDialog.action === 'owner' && !batchForm.ownerId.trim())} onClick={() => void submitBatch()}>确认</button></footer></Modal>}
      {draftConflict && <DraftConflictModal conflict={draftConflict} busy={saveAsset.isPending} onClose={() => setDraftConflict(null)} onSave={async (draft, currentRevision) => { await saveAsset.mutateAsync({ revision: currentRevision, draft }); setDraftConflict(null) }} />}
    </div>
  )
}
