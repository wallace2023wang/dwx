import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

interface DrlPreviewProps {
  drl: string
}

export default function DrlPreview({ drl }: DrlPreviewProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    await navigator.clipboard.writeText(drl)
    setCopied(true)
  }

  return (
    <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white">
      <header className="flex h-9 items-center border-b border-ink-border bg-[#fafafa] px-3 text-xs font-semibold">
        DRL 自动生成预览
        <button className="ml-auto inline-flex size-7 items-center justify-center rounded-[2px] text-brand-primary hover:bg-brand-primary-l" onClick={copy} title="复制 DRL" aria-label="复制 DRL">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </header>
      <pre className="max-h-[360px] overflow-auto bg-[#fafafa] p-3 font-mono text-[11px] leading-[1.65] text-ink-1">{drl}</pre>
    </section>
  )
}
