import { useMemo, useState } from 'react'
import Modal from '../Modal'
import { threeWayMerge, type ConflictChoice, type DraftMergeConflict } from '../../lib/threeWayMerge'

function valueText(value: unknown) {
  if (value === undefined) return '（已删除）'
  if (typeof value === 'string') return value || '（空字符串）'
  return JSON.stringify(value, null, 2)
}

export default function DraftConflictModal<T>({ conflict, busy, onClose, onSave }: {
  conflict: DraftMergeConflict<T>
  busy: boolean
  onClose: () => void
  onSave: (draft: T, revision: number) => Promise<void>
}) {
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const [error, setError] = useState<string | null>(null)
  const unresolved = conflict.result.conflicts.filter(item => !choices[item.id]).length
  const merged = useMemo(() => threeWayMerge(conflict.base, conflict.local, conflict.remote, choices).value, [choices, conflict])
  const chooseAll = (choice: ConflictChoice) => setChoices(Object.fromEntries(conflict.result.conflicts.map(item => [item.id, choice])))
  const save = async () => {
    if (unresolved) return
    setError(null)
    try { await onSave(merged, conflict.currentRevision) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '合并保存失败') }
  }

  return <Modal title="草稿存在并发修改" width="max-w-5xl" onClose={onClose}>
    <div className="space-y-3 p-4 text-xs">
      <div className="border border-[#f3c65f] bg-[#fff8e1] p-3 text-[#734d00]">
        服务器已更新到 r{conflict.currentRevision}。未重叠的修改已经自动合并；以下 {conflict.result.conflicts.length} 项需要选择保留哪一版。
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="h-7 border border-ink-border bg-white px-2 text-[11px]" onClick={() => chooseAll('local')}>全部采用我的修改</button>
        <button type="button" className="h-7 border border-ink-border bg-white px-2 text-[11px]" onClick={() => chooseAll('remote')}>全部采用服务器版本</button>
      </div>
      <div className="max-h-[55vh] space-y-3 overflow-auto">
        {conflict.result.conflicts.map(item => <section key={item.id} className="border border-ink-border">
          <header className="border-b border-ink-border bg-[#fafafa] px-3 py-2 font-mono text-[11px] font-semibold text-ink-2">{item.path}</header>
          <div className="grid grid-cols-2 divide-x divide-ink-border">
            {(['local', 'remote'] as const).map(choice => <label key={choice} className={`block cursor-pointer p-3 ${choices[item.id] === choice ? 'bg-brand-primary-l' : 'bg-white'}`}>
              <span className="mb-2 flex items-center gap-2 font-semibold"><input type="radio" name={item.id} checked={choices[item.id] === choice} onChange={() => setChoices(current => ({ ...current, [item.id]: choice }))} />{choice === 'local' ? '我的修改' : '服务器版本'}</span>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-[2px] bg-[#f6f6f6] p-2 font-mono text-[10px] text-ink-2">{valueText(item[choice])}</pre>
            </label>)}
          </div>
        </section>)}
      </div>
      {error && <p className="text-[11px] text-[#c62828]">{error}</p>}
    </div>
    <footer className="flex items-center justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3">
      {unresolved > 0 && <span className="mr-auto text-[11px] text-[#8a5a00]">还有 {unresolved} 项未选择</span>}
      <button type="button" className="h-8 border border-ink-border bg-white px-3 text-[11px]" disabled={busy} onClick={onClose}>稍后处理</button>
      <button type="button" className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={busy || unresolved > 0} onClick={() => void save()}>{busy ? '正在保存…' : '合并并保存'}</button>
    </footer>
  </Modal>
}
