import { LockKeyhole, UserRoundCog } from 'lucide-react'
import { useState } from 'react'
import type { AssetOwner, User } from '../../types'
import Modal from '../Modal'

interface AssetOwnershipBarProps {
  owner?: AssetOwner | null
  user: User | null
  busy?: boolean
  onTransfer: (ownerId: string, ownerName: string) => Promise<unknown>
}

export default function AssetOwnershipBar({ owner, user, busy, onTransfer }: AssetOwnershipBarProps) {
  const [open, setOpen] = useState(false)
  const [ownerId, setOwnerId] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canManage = Boolean(user && (!owner || owner.id === user.id || user.roles.includes('admin') || user.permissions?.includes('*')))

  const showTransfer = () => {
    setOwnerId('')
    setOwnerName('')
    setError(null)
    setOpen(true)
  }
  const transfer = async () => {
    setError(null)
    try {
      await onTransfer(ownerId.trim(), ownerName.trim() || ownerId.trim())
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '转交失败')
    }
  }

  return <>
    <div className={`flex min-h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px] ${canManage ? 'border-[#b8c9f5] bg-[#f5f8ff] text-ink-2' : 'border-[#f3c65f] bg-[#fff8e1] text-[#734d00]'}`}>
      {canManage ? <UserRoundCog size={13} /> : <LockKeyhole size={13} />}
      <span>{owner ? <>草稿负责人：<b>{owner.name}</b></> : '草稿尚未认领，首次保存时自动归当前用户负责'}</span>
      {!canManage && <span>· 当前为只读</span>}
      {canManage && <button type="button" className="ml-auto h-6 border border-current bg-white px-2" onClick={showTransfer}>转交负责人</button>}
    </div>
    {open && <Modal title="转交草稿负责人" onClose={() => setOpen(false)}><div className="space-y-3 p-4"><label className="block text-[11px] font-semibold text-ink-2">用户 ID<input className="control-input mt-1 font-mono" value={ownerId} onChange={event => setOwnerId(event.target.value)} maxLength={120} autoFocus /></label><label className="block text-[11px] font-semibold text-ink-2">显示名称（可选）<input className="control-input mt-1" value={ownerName} onChange={event => setOwnerName(event.target.value)} maxLength={120} /></label>{error && <p className="text-[11px] text-[#c62828]">{error}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setOpen(false)}>取消</button><button disabled={!ownerId.trim() || busy} className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" onClick={() => void transfer()}>确认转交</button></footer></Modal>}
  </>
}
