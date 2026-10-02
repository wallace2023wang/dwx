import type { RuleAttributes } from '../../types'

interface AssetPropertiesProps {
  attributes: RuleAttributes
}

export default function AssetProperties({ attributes }: AssetPropertiesProps) {
  return (
    <div className="grid shrink-0 grid-cols-2 border-t border-ink-border bg-[#fafafa] text-[11px] max-sm:grid-cols-1">
      <div className="border-r border-ink-border px-5 py-[10px] max-sm:border-b max-sm:border-r-0">
        <h3 className="mb-1.5 text-[10px] font-semibold text-ink-3">规则属性</h3>
        <div className="flex justify-between py-0.5"><span>优先级</span><b className="font-medium">{attributes.priority}</b></div>
        <div className="flex justify-between py-0.5"><span>命中策略</span><b className="font-medium">{attributes.hitPolicy}</b></div>
        <div className="flex justify-between py-0.5"><span>有效日期</span><b className="font-medium">{attributes.effectiveDate}</b></div>
      </div>
      <div className="px-5 py-[10px]">
        <h3 className="mb-1.5 text-[10px] font-semibold text-ink-3">审计</h3>
        <div className="flex justify-between py-0.5"><span>创建者</span><b className="font-medium">{attributes.createdBy}</b></div>
        <div className="flex justify-between py-0.5"><span>最近审核</span><b className="font-medium">{attributes.reviewedAt}</b></div>
        <div className="flex justify-between py-0.5"><span>注释</span><b className="font-medium">无</b></div>
      </div>
    </div>
  )
}
