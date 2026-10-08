import { Check, ChevronRight, GitPullRequest, RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useChangeSetDecision, useChangeSets } from '../../api/governance'
import Modal from '../../components/Modal'
import type { ChangeSet, ChangeSetStatus } from '../../types'

const statusMeta: Record<ChangeSetStatus, { label: string; className: string }> = {
  DRAFT: { label: '草稿', className: 'bg-[#fff3e0] text-env-staging' },
  SUBMITTED: { label: '待审核', className: 'bg-brand-primary-l text-brand-primary' },
  APPROVED: { label: '已批准', className: 'bg-[#e8f5e9] text-env-production' },
  REJECTED: { label: '已驳回', className: 'bg-[#fff1f1] text-[#c62828]' },
}

const pathLabels: Record<string, string> = {
  name: '名称', description: '业务说明', category: '规则包', priority: '优先级',
  conditions: '条件', actions: '动作', rows: '决策行', hitPolicy: '命中策略',
  field: '字段', operator: '操作符', value: '值', enabled: '启用',
}

function displayPath(path: string) {
  return path.replace(/([a-zA-Z]+)/g, key => pathLabels[key] || key).replace(/\./g, ' / ')
}

function displayValue(value: unknown) {
  if (value === undefined) return '无'
  if (value === null) return 'null'
  if (typeof value === 'string') return value || '空字符串'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function dateTime(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export default function ReviewsTab() {
  const { projectId } = useParams()
  const { data: changeSets = [], isPending, error } = useChangeSets(projectId)
  const decision = useChangeSetDecision(projectId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<'all' | ChangeSetStatus>('SUBMITTED')
  const [search, setSearch] = useState('')
  const [comment, setComment] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const filtered = useMemo(() => changeSets.filter(item =>
    (status === 'all' || item.status === status)
    && (!search.trim() || item.name.toLowerCase().includes(search.trim().toLowerCase()) || item.createdBy.toLowerCase().includes(search.trim().toLowerCase()))
  ), [changeSets, search, status])
  const selected = changeSets.find(item => item.id === selectedId) || filtered[0] || null

  useEffect(() => {
    if (!selectedId && filtered[0]) setSelectedId(filtered[0].id)
    else if (selectedId && !changeSets.some(item => item.id === selectedId)) setSelectedId(filtered[0]?.id || null)
  }, [changeSets, filtered, selectedId])

  const run = async (item: ChangeSet, action: 'approve' | 'reject' | 'reopen', decisionComment = '') => {
    setNotice(null)
    try {
      const updated = await decision.mutateAsync({ id: item.id, action, revision: item.revision, comment: decisionComment })
      const approvalProgress = `${updated.approvals?.length || 0}/${updated.reviewPolicySnapshot?.requiredApprovals || 1}`
      setNotice({ error: false, text: action === 'approve' ? updated.status === 'APPROVED' ? '审核完成，已发布' : `已记录批准（${approvalProgress}），等待其他审核人` : action === 'reject' ? '已驳回' : '已重新打开' })
      if (updated.status !== 'SUBMITTED') setStatus('all')
      setComment('')
      setRejecting(false)
    } catch (cause) {
      setNotice({ error: true, text: cause instanceof Error ? cause.message : '审核操作失败' })
    }
  }

  if (isPending) return <div className="p-6 text-xs text-ink-3">正在加载审核队列...</div>

  return (
    <div className="flex h-full min-w-[900px] overflow-hidden bg-white">
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-ink-border bg-white">
        <header className="flex h-10 shrink-0 items-center border-b border-ink-border bg-[#fafafa] px-3"><GitPullRequest size={14} className="mr-2 text-brand-primary" /><h2 className="text-xs font-semibold">变更集</h2><span className="ml-2 text-[10px] text-ink-3">{changeSets.filter(item => item.status === 'SUBMITTED').length} 待审核</span></header>
        <div className="grid grid-cols-[1fr_92px] gap-2 border-b border-ink-border p-2"><label className="relative"><Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" /><input className="h-7 w-full border border-ink-border pl-7 pr-2 text-[11px] outline-none focus:border-brand-primary" value={search} onChange={event => setSearch(event.target.value)} placeholder="名称或提交人" /></label><select className="h-7 border border-ink-border bg-white px-1 text-[10px]" value={status} onChange={event => setStatus(event.target.value as typeof status)} aria-label="审核状态"><option value="SUBMITTED">待审核</option><option value="all">全部状态</option><option value="APPROVED">已批准</option><option value="REJECTED">已驳回</option><option value="DRAFT">草稿</option></select></div>
        <div className="min-h-0 flex-1 overflow-auto">{filtered.map(item => <button key={item.id} className={`flex w-full items-center gap-2 border-b border-[#e8e8e8] px-3 py-2.5 text-left hover:bg-[#f0f6fc] ${selected?.id === item.id ? 'bg-[#d6e6f7]' : ''}`} onClick={() => { setSelectedId(item.id); setNotice(null); setComment('') }}><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-xs font-medium text-ink-1">{item.name}</span><span className={`shrink-0 rounded-[2px] px-1.5 py-px text-[9px] ${statusMeta[item.status].className}`}>{statusMeta[item.status].label}</span></div><div className="mt-1 flex gap-2 text-[10px] text-ink-3"><span>{item.createdBy}</span><span>{item.items.length} 个资产</span><span>r{item.revision}</span></div><div className="mt-0.5 truncate text-[9px] text-ink-3">{dateTime(item.submittedAt || item.updatedAt)}</div></div><ChevronRight size={13} className="shrink-0 text-ink-3" /></button>)}{filtered.length === 0 && <p className="p-6 text-center text-[11px] text-ink-3">没有匹配的变更集</p>}</div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto bg-white">
        {error && <div className="m-4 border border-[#ef9a9a] bg-[#fff5f5] p-3 text-xs text-[#c62828]">{error.message}</div>}
        {!selected && !error && <div className="flex h-full items-center justify-center text-xs text-ink-3">选择一个变更集查看差异</div>}
        {selected && <>
          <header className="sticky top-0 z-20 border-b border-ink-border bg-white px-5 py-3">
            <div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold">{selected.name}</h1><span className={`shrink-0 rounded-[2px] px-2 py-0.5 text-[10px] ${statusMeta[selected.status].className}`}>{statusMeta[selected.status].label}</span><span className="text-[10px] text-ink-3">变更集 r{selected.revision}</span></div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-ink-3"><span>提交人: <b className="font-medium text-ink-1">{selected.createdBy}</b></span><span>提交时间: {dateTime(selected.submittedAt)}</span><span>BOM: v{selected.bomVersion ?? '-'}</span>{selected.reviewPolicySnapshot && <span>批准进度: <b className="font-medium text-ink-1">{selected.approvals?.length || 0}/{selected.reviewPolicySnapshot.requiredApprovals}</b></span>}</div>
            {selected.description && <p className="mt-2 text-xs text-ink-2">{selected.description}</p>}
          </header>

          <div className="px-5 py-4">
            {selected.items.map(item => <section key={`${item.assetType}:${item.assetId}`} className="mb-5 border border-ink-border">
              <header className="flex items-center gap-3 border-b border-ink-border bg-[#fafafa] px-3 py-2"><b className="text-xs font-semibold">{item.name}</b><span className="text-[10px] text-ink-3">{item.assetType === 'rule' ? 'BAL 规则' : item.assetType === 'table' ? '决策表' : '规则集'}</span><span className="font-mono text-[10px] text-ink-3">r{item.assetRevision}</span><div className="ml-auto flex gap-2 text-[10px]"><span className="text-env-production">+{item.summary.added}</span><span className="text-[#c62828]">-{item.summary.removed}</span><span className="text-brand-primary">~{item.summary.changed}</span></div></header>
              <table className="w-full table-fixed border-collapse text-[11px]"><thead className="bg-white text-left text-ink-3"><tr className="border-b border-ink-border"><th className="w-[28%] px-3 py-1.5 font-medium">字段</th><th className="w-[34%] px-3 py-1.5 font-medium">修改前</th><th className="w-[38%] px-3 py-1.5 font-medium">修改后</th></tr></thead><tbody>{item.changes.map((change, index) => <tr key={`${change.path}:${index}`} className="border-b border-[#eeeeee] align-top last:border-b-0"><td className="break-all px-3 py-2 font-mono text-[10px] text-ink-2">{displayPath(change.path)}</td><td className={`whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10px] ${change.kind === 'removed' || change.kind === 'changed' ? 'bg-[#fff5f5] text-[#8b1a1a]' : 'text-ink-3'}`}>{displayValue(change.before)}</td><td className={`whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10px] ${change.kind === 'added' || change.kind === 'changed' ? 'bg-[#f2fbf3] text-[#176b2c]' : 'text-ink-3'}`}>{displayValue(change.after)}</td></tr>)}</tbody></table>
            </section>)}

            {Boolean(selected.approvals?.length) && <section className="mb-4 border border-[#b8c9f5] bg-[#f5f8ff] p-3"><h3 className="mb-2 text-xs font-semibold">批准记录</h3>{selected.approvals?.map(approval => <div key={`${approval.actor}:${approval.decidedAt}`} className="flex gap-3 border-t border-[#dce4f7] py-2 text-[11px] first:border-t-0"><b>{approval.actor}</b><span className="min-w-0 flex-1 text-ink-2">{approval.comment || '无意见'}</span><span className="text-[10px] text-ink-3">{dateTime(approval.decidedAt)}</span></div>)}</section>}
            {selected.decisionComment && <section className={`mb-4 border p-3 text-xs ${selected.status === 'REJECTED' ? 'border-[#ef9a9a] bg-[#fff5f5]' : 'border-[#a5d6a7] bg-[#f2fbf3]'}`}><b className="mr-2">审核意见</b>{selected.decisionComment}<span className="ml-3 text-[10px] text-ink-3">{dateTime(selected.decidedAt)}</span></section>}
          </div>

          <footer className="sticky bottom-0 flex min-h-[52px] items-center gap-2 border-t border-ink-border bg-[#fafafa] px-4 py-2">
            {notice && <span className={`mr-auto text-[11px] ${notice.error ? 'text-[#c62828]' : 'text-env-production'}`}>{notice.text}</span>}
            {!notice && <span className="mr-auto text-[10px] text-ink-3">{selected.items.length} 个资产 · {selected.items.reduce((count, item) => count + item.changes.length, 0)} 项差异</span>}
            {selected.status === 'SUBMITTED' && <><input className="h-8 w-60 border border-ink-border bg-white px-2 text-[11px] outline-none focus:border-brand-primary" value={comment} onChange={event => setComment(event.target.value)} placeholder={selected.reviewPolicySnapshot?.requireComment ? '批准意见（必填）' : '批准意见（可选）'} /><button className="inline-flex h-8 items-center gap-1.5 border border-[#c62828] bg-white px-3 text-[11px] text-[#c62828] hover:bg-[#fff1f1]" onClick={() => setRejecting(true)}><X size={13} />驳回</button><button disabled={decision.isPending || Boolean(selected.reviewPolicySnapshot?.requireComment && !comment.trim())} className="inline-flex h-8 items-center gap-1.5 bg-brand-primary px-3 text-[11px] text-white hover:bg-brand-primary-d disabled:opacity-50" onClick={() => void run(selected, 'approve', comment)}><Check size={13} />{(selected.approvals?.length || 0) + 1 >= (selected.reviewPolicySnapshot?.requiredApprovals || 1) ? '批准并发布' : '批准'}</button></>}
            {selected.status === 'REJECTED' && <button disabled={decision.isPending} className="inline-flex h-8 items-center gap-1.5 border border-ink-border bg-white px-3 text-[11px] text-ink-2 hover:bg-ink-bg disabled:opacity-50" onClick={() => void run(selected, 'reopen')}><RotateCcw size={13} />重新打开</button>}
          </footer>
        </>}
      </main>

      {rejecting && selected && <Modal title="驳回变更集" onClose={() => setRejecting(false)}><div className="p-4"><label className="text-[11px] font-semibold text-ink-2">驳回意见<textarea className="mt-1 min-h-24 w-full resize-y border border-ink-border p-2 text-xs outline-none focus:border-brand-primary" value={comment} onChange={event => setComment(event.target.value)} autoFocus /></label></div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setRejecting(false)}>取消</button><button disabled={!comment.trim() || decision.isPending} className="h-8 bg-[#c62828] px-3 text-[11px] text-white disabled:opacity-40" onClick={() => void run(selected, 'reject', comment)}>确认驳回</button></footer></Modal>}
    </div>
  )
}
