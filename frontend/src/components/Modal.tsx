import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export default function Modal({ title, children, onClose, width = 'max-w-lg' }: { title: string; children: ReactNode; onClose: () => void; width?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className={`flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden ${width} border border-ink-border bg-white shadow-xl [&>div]:min-h-0 [&>div]:overflow-y-auto [&>footer]:shrink-0`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex h-11 shrink-0 items-center border-b border-ink-border bg-[#fafafa] px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" className="ml-auto inline-flex size-7 items-center justify-center text-ink-3 hover:bg-ink-bg" onClick={onClose} title="关闭"><X size={15} /></button>
        </header>
        {children}
      </section>
    </div>
  )
}
