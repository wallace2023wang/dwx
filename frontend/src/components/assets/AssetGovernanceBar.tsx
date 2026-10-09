import { Tags } from 'lucide-react'
import { useState } from 'react'
import { useBatchAssets, type BatchAssetType } from '../../api/projects'
import Modal from '../Modal'

interface Props {
  projectId?: string
  asset: {
    id: string
    type: BatchAssetType
    revision: number
    tags?: string[]
    effectiveFrom?: string | null
    effectiveTo?: string | null
    effectiveStatus?: 'scheduled' | 'effective' | 'expired'
  }
  disabled?: boolean
}

export default function AssetGovernanceBar({ projectId, asset, disabled }: Props) {
  const update = useBatchAssets(projectId)
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [effectiveTo, setEffectiveTo] = useState('')

  const edit = () => {
    setTags((asset.tags || []).join(', '))
    setEffectiveFrom(asset.effectiveFrom || '')
    setEffectiveTo(asset.effectiveTo || '')
    setOpen(true)
  }
  const save = async () => {
    await update.mutateAsync({
      action: 'metadata',
      items: [{ id: asset.id, type: asset.type, revision: asset.revision }],
      tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      effectiveFrom: effectiveFrom || null,
      effectiveTo: effectiveTo || null,
    })
    setOpen(false)
  }
  const state = asset.effectiveStatus === 'scheduled' ? '待生效' : asset.effectiveStatus === 'expired' ? '已过期' : '有效'
  return <>
    <div className="flex min-h-9 items-center gap-2 border-b border-ink-border bg-[#fafafa] px-3 text-[10px] text-ink-3"><Tags size={12} /><span>标签：{asset.tags?.length ? asset.tags.join(' / ') : '无'}</span><span className="text-ink-border">|</span><span>有效期：{asset.effectiveFrom || '不限'} 至 {asset.effectiveTo || '不限'}（{state}）</span>{!disabled && <button type="button" className="ml-auto h-6 border border-ink-border bg-white px-2 text-ink-2" onClick={edit}>编辑治理信息</button>}</div>
    {open && <Modal title="编辑标签和有效期" onClose={() => setOpen(false)}><div className="space-y-3 p-4"><label className="block text-[11px] font-semibold text-ink-2">标签（逗号分隔）<input className="control-input mt-1" value={tags} onChange={event => setTags(event.target.value)} /></label><div className="grid grid-cols-2 gap-3"><label className="text-[11px] font-semibold text-ink-2">生效日期<input type="date" className="control-input mt-1" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label><label className="text-[11px] font-semibold text-ink-2">失效日期<input type="date" className="control-input mt-1" value={effectiveTo} onChange={event => setEffectiveTo(event.target.value)} /></label></div><p className="text-[10px] text-ink-3">有效期用于治理提示，不会自动切换生产 Release。</p>{update.error && <p className="text-[11px] text-[#c62828]">{update.error.message}</p>}</div><footer className="flex justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={() => setOpen(false)}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={update.isPending} onClick={() => void save()}>保存</button></footer></Modal>}
  </>
}
