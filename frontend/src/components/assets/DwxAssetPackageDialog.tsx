import { AlertTriangle, CheckCircle2, Download, FileJson, LoaderCircle, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DwxImportPreview, DwxImportResult } from '../../api/projects'
import Modal from '../Modal'

const exampleManifest = {
  format: 'dwx-asset-package', schemaVersion: 1,
  project: { name: '贷款决策项目', version: '1.0.0' },
  packages: [{ name: 'asset_import', label: '导入资产' }],
  assets: [{ sourceId: 'rule/adult-customer', type: 'bal', name: '成年客户', package: 'asset_import', draft: {
    name: '成年客户', description: '导入的 BAL 规则', category: 'asset_import', priority: 0,
    conditions: [{ field: 'customerAge', operator: '>=', value: '18' }], actions: [{ field: 'riskLevel', value: '低' }],
  } }],
  rulesets: [{ sourceId: 'ruleset/eligibility', name: '准入决策服务', packages: ['asset_import'] }],
}

const actionLabel = { create: '新建', reuse: '复用', skip: '跳过', error: '错误' }

interface DwxAssetPackageDialogProps {
  busy: boolean
  preview: DwxImportPreview | null
  result: DwxImportResult | null
  error: string | null
  onPreview: (manifest: unknown) => Promise<void>
  onImport: (manifest: unknown, checksum: string) => Promise<void>
  onClose: () => void
}

export default function DwxAssetPackageDialog({ busy, preview, result, error, onPreview, onImport, onClose }: DwxAssetPackageDialogProps) {
  const [source, setSource] = useState(() => JSON.stringify(exampleManifest, null, 2))
  const [parsed, setParsed] = useState<unknown>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const parse = () => {
    try { const value: unknown = JSON.parse(source); setParsed(value); setLocalError(null); return value }
    catch { setLocalError('JSON 格式无效，请检查逗号、引号和括号'); return null }
  }
  const runPreview = async () => { const value = parse(); if (value != null) await onPreview(value) }
  const loadFile = async (file: File) => {
    if (file.size > 1024 * 1024) { setLocalError('迁移清单不能超过 1 MB'); return }
    setSource(await file.text()); setParsed(null); setLocalError(null)
  }
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exampleManifest, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'dwx-asset-package.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  const displayedError = localError || error
  return (
    <Modal title="导入 DWX 资产包" onClose={onClose} width="max-w-5xl">
      <div className="grid max-h-[72vh] grid-cols-[1.05fr_.95fr] overflow-hidden max-lg:grid-cols-1">
        <section className="min-h-0 border-r border-ink-border p-4 max-lg:border-b max-lg:border-r-0">
          <div className="mb-3 flex items-start gap-2 border border-[#9bbcf7] bg-brand-primary-l p-3 text-[11px] text-ink-2"><FileJson size={16} className="mt-0.5 shrink-0 text-brand-primary" /><p>DWX 资产包包含结构化规则资产、规则包和可移植规则集。导入只创建草稿，不自动审核、发布或部署。</p></div>
          <div className="mb-2 flex items-center gap-2"><input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void loadFile(file); event.target.value = '' }} /><button className="inline-flex h-8 items-center gap-1.5 border border-ink-border bg-white px-3 text-[11px]" onClick={() => fileRef.current?.click()}><Upload size={13} />选择 JSON</button><button className="inline-flex h-8 items-center gap-1.5 border border-ink-border bg-white px-3 text-[11px]" onClick={downloadTemplate}><Download size={13} />下载模板</button><span className="ml-auto text-[10px] text-ink-3">最多 500 个资产 / 1 MB</span></div>
          <textarea className="h-[390px] w-full resize-none border border-ink-border p-3 font-mono text-[11px] leading-5 outline-none focus:border-brand-primary max-lg:h-56" spellCheck={false} value={source} onChange={event => { setSource(event.target.value); setParsed(null); setLocalError(null) }} />
        </section>
        <section className="min-h-0 overflow-auto p-4">
          {!preview && !result && <div className="flex h-full min-h-64 flex-col items-center justify-center text-center text-ink-3"><FileJson size={36} strokeWidth={1.2} /><b className="mt-3 text-xs text-ink-2">先解析并预览迁移清单</b><p className="mt-1 max-w-xs text-[11px]">服务端将验证 BOM 字段、资产结构、规则包层级、同名冲突和重复来源标识。</p></div>}
          {preview && !result && <div className="space-y-3 text-xs"><header className="flex items-center gap-2"><b>{preview.manifest?.project.name}</b><span className="text-[10px] text-ink-3">{preview.manifest?.project.version || '未标版本'}</span>{preview.valid ? <span className="ml-auto inline-flex items-center gap-1 text-env-production"><CheckCircle2 size={13} />校验通过</span> : <span className="ml-auto inline-flex items-center gap-1 text-[#c62828]"><AlertTriangle size={13} />存在错误</span>}</header>{preview.summary && <div className="grid grid-cols-3 gap-2 text-center"><div className="border border-ink-border p-2"><b className="block text-lg text-brand-primary">{preview.summary.packages.create}</b><span className="text-[10px] text-ink-3">新建包 · 复用 {preview.summary.packages.reuse}</span></div><div className="border border-ink-border p-2"><b className="block text-lg text-brand-primary">{preview.summary.assets.create}</b><span className="text-[10px] text-ink-3">新建资产 · 跳过 {preview.summary.assets.skip}</span></div><div className="border border-ink-border p-2"><b className="block text-lg text-brand-primary">{preview.summary.rulesets.create}</b><span className="text-[10px] text-ink-3">新建规则集 · 跳过 {preview.summary.rulesets.skip}</span></div></div>}
            {preview.errors.length > 0 && <div className="border border-[#ef9a9a] bg-[#fffafa] p-2 text-[11px] text-[#a31515]"><b>阻止导入的问题</b><ul className="mt-1 list-disc space-y-1 pl-4">{preview.errors.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></div>}{preview.warnings.length > 0 && <div className="border border-[#f3c65f] bg-[#fff8e1] p-2 text-[11px] text-[#734d00]">{preview.warnings.join('；')}</div>}
            <div className="border border-ink-border"><div className="bg-[#fafafa] px-2 py-1.5 text-[11px] font-semibold">资产明细</div><div className="max-h-56 overflow-auto">{preview.assets.map(asset => <div key={asset.sourceId} className="flex items-start gap-2 border-t border-[#e8e8e8] px-2 py-2 text-[11px]"><span className={`mt-0.5 shrink-0 px-1.5 py-px text-[9px] ${asset.action === 'error' ? 'bg-[#fff1f1] text-[#c62828]' : asset.action === 'skip' ? 'bg-[#eeeeee] text-ink-3' : 'bg-[#e8f5e9] text-env-production'}`}>{actionLabel[asset.action]}</span><div className="min-w-0"><b className="block truncate">{asset.name}</b><span className="font-mono text-[9px] text-ink-3">{asset.typeLabel} · {asset.package} · {asset.sourceId}</span>{asset.errors.map(item => <p key={item} className="text-[#c62828]">{item}</p>)}</div></div>)}</div></div>
            {preview.rulesets.length > 0 && <div className="border border-ink-border"><div className="bg-[#fafafa] px-2 py-1.5 text-[11px] font-semibold">Ruleset 映射</div>{preview.rulesets.map(ruleset => <div key={ruleset.sourceId} className="flex items-center gap-2 border-t border-[#e8e8e8] px-2 py-2 text-[11px]"><span className="bg-[#e8f5e9] px-1.5 py-px text-[9px] text-env-production">{actionLabel[ruleset.action]}</span><b>{ruleset.name}</b><span className="ml-auto text-[9px] text-ink-3">{ruleset.packages.join('、')} → Rule Group</span></div>)}</div>}
          </div>}
          {result && <div className="flex min-h-64 flex-col items-center justify-center text-center"><CheckCircle2 size={40} className="text-env-production" /><b className="mt-3 text-sm">DWX 资产已导入为草稿</b><p className="mt-1 text-[11px] text-ink-3">创建 {result.created.length} 个对象；请逐项编译、审核和发布后再构建 Release。</p></div>}
          {displayedError && <p className="mt-3 border border-[#ef9a9a] bg-[#fffafa] p-2 text-[11px] text-[#c62828]">{displayedError}</p>}
        </section>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={onClose}>{result ? '完成' : '取消'}</button>{!result && <button className="inline-flex h-8 items-center gap-1.5 border border-brand-primary bg-white px-3 text-[11px] text-brand-primary disabled:opacity-40" disabled={busy || !source.trim()} onClick={() => void runPreview()}>{busy && <LoaderCircle size={13} className="animate-spin" />}解析预览</button>}{preview?.valid && preview.checksum && !result && <button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={busy || parsed == null} onClick={() => parsed != null && void onImport(parsed, preview.checksum!)}>确认导入草稿</button>}</footer>
    </Modal>
  )
}
