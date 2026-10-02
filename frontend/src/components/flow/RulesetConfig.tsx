import { Check, Layers3 } from 'lucide-react'
import type { Ruleset } from '../../types'

interface RulesetConfigProps {
  rulesets: Ruleset[]
  selectedId: string
  onSelect: (rulesetId: string) => void
}

const hitPolicyLabels: Record<Ruleset['hitPolicy'], string> = {
  COLLECT: 'COLLECT（收集全部命中）',
  FIRST: 'FIRST（首条命中即停）',
  PRIORITY: 'PRIORITY（按优先级）',
}

function ConfigItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-[11px] text-ink-3">{label}</dt>
      <dd className="min-h-5 text-xs text-ink-1">{children}</dd>
    </div>
  )
}

export default function RulesetConfig({ rulesets, selectedId, onSelect }: RulesetConfigProps) {
  const selected = rulesets.find((ruleset) => ruleset.id === selectedId) ?? rulesets[0]
  if (!selected) return null

  return (
    <section className="rounded-[3px] border border-ink-border bg-white px-4 py-[14px]" aria-labelledby="ruleset-config-title">
      <div className="mb-3 flex items-center gap-2 border-b border-ink-border pb-2">
        <Layers3 size={15} className="text-brand-primary" />
        <h2 id="ruleset-config-title" className="text-xs font-medium">规则流配置</h2>
      </div>
      <dl className="grid grid-cols-4 gap-x-5 gap-y-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
        <ConfigItem label="规则流名称">
          <select
            className="h-7 max-w-full rounded-[2px] border border-ink-border bg-white px-2 font-mono text-[11px] outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary"
            value={selected.id}
            onChange={(event) => onSelect(event.target.value)}
            aria-label="选择规则流"
          >
            {rulesets.map((ruleset) => <option key={ruleset.id} value={ruleset.id}>{ruleset.name}</option>)}
          </select>
        </ConfigItem>
        <ConfigItem label="执行模型">{selected.flowName}</ConfigItem>
        <ConfigItem label="依赖状态">{selected.needsRepublish ? <span className="text-[#b26a00]">依赖资产已升版，需要重新发布</span> : <span className="text-env-production">当前</span>}</ConfigItem>
        <ConfigItem label="命中策略">{hitPolicyLabels[selected.hitPolicy]}</ConfigItem>
        <ConfigItem label="最大 firing 次数"><span className="font-mono">{selected.maxFirings}</span></ConfigItem>
        <ConfigItem label="输入签名（facts）"><span className="font-mono">{selected.inputs.join(', ')}</span></ConfigItem>
        <ConfigItem label="输出签名（facts）"><span className="font-mono">{selected.outputs.join(', ')}</span></ConfigItem>
        <ConfigItem label="包含规则包">
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {selected.packages.map((packageName) => (
              <span key={packageName} className="inline-flex items-center gap-1 font-mono text-[11px]">
                {packageName}<Check size={12} className="text-env-production" />
              </span>
            ))}
          </span>
        </ConfigItem>
        <ConfigItem label="顺序执行">
          <span className="inline-flex items-center gap-1.5">
            <span className={`flex size-4 items-center justify-center rounded-[2px] border ${selected.sequential ? 'border-brand-primary bg-brand-primary text-white' : 'border-ink-border bg-white'}`}>
              {selected.sequential && <Check size={11} strokeWidth={3} />}
            </span>
            <span className="font-mono text-[11px]">sequential</span>
          </span>
        </ConfigItem>
      </dl>
    </section>
  )
}
