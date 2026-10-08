import { AlertTriangle } from 'lucide-react'
import type { AssetDetail } from '../../types'

export default function BomVersionNotice({ detail }: { detail: AssetDetail }) {
  if (!detail.bomOutdated) return null
  return <div className="flex shrink-0 items-center gap-2 border-b border-[#f3c65f] bg-[#fff8e1] px-4 py-2 text-[11px] text-[#734d00]" role="alert"><AlertTriangle size={13} />当前发布产物冻结于 BOM v{detail.publishedBomVersion}，项目已升级到 BOM v{detail.currentBomVersion}。请重新发布该资产后再构建规则集。</div>
}
