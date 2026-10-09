import { AlertTriangle, Eye, Pencil, Users } from 'lucide-react'
import type { CollaborationMember } from '../../api/collaboration'

export default function AssetCollaborationBar({ members, clientId, localRevision, currentRevision, error, onLoadLatest }: {
  members: CollaborationMember[]
  clientId: string
  localRevision: number
  currentRevision: number
  error?: Error | null
  onLoadLatest?: () => void
}) {
  const others = members.filter(member => member.clientId !== clientId)
  const stale = currentRevision > localRevision
  if (!others.length && !stale && !error) return null

  return <div className="shrink-0 border-b border-ink-border bg-[#f7f9fb] px-3 py-2 text-[11px]">
    <div className="flex flex-wrap items-center gap-2">
      {others.length > 0 && <><span className="inline-flex items-center gap-1 font-semibold text-ink-2"><Users size={13} />另有 {others.length} 人在线</span>{others.map(member => <span key={member.clientId} className="inline-flex items-center gap-1 border border-ink-border bg-white px-1.5 py-0.5 text-ink-2" title={`进入于 ${new Date(member.joinedAt).toLocaleTimeString('zh-CN', { hour12: false })}`}>{member.mode === 'editing' ? <Pencil size={10} /> : <Eye size={10} />}{member.name} · {member.selection ? `EPL 第 ${member.selection.startLineNumber} 行` : member.mode === 'editing' ? '编辑中' : '查看中'}</span>)}</>}
      {stale && <span className="inline-flex items-center gap-1 text-[#8a5a00]"><AlertTriangle size={13} />服务器已有新修订 r{currentRevision}，当前页面为 r{localRevision}；保存时会自动合并。</span>}
      {stale && onLoadLatest && <button type="button" className="ml-auto h-6 border border-[#b26a00] bg-white px-2 text-[10px] text-[#8a5a00]" onClick={onLoadLatest}>没有本地修改，加载最新版</button>}
      {error && !stale && <span className="text-ink-3">协作状态暂时不可用，将自动重连。</span>}
    </div>
  </div>
}
