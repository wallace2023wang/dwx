import { Calculator, Code2, FileText, GitFork, Table2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { BomField, PackageNode } from '../../types'
import Modal from '../Modal'
import BomFieldPicker, { type BomFieldPickerOption } from '../bom/BomFieldPicker'

export interface CreateAssetForm {
  name: string
  category: string
  type: 'rule' | 'decision-table' | 'decision-tree' | 'scorecard'
  hitPolicy: 'COLLECT' | 'FIRST' | 'PRIORITY'
  conditionFields: string[]
  actionFields: string[]
}

interface CreateAssetDialogProps {
  form: CreateAssetForm
  packages: PackageNode[]
  fields: BomField[]
  error: string | null
  onChange: (form: CreateAssetForm) => void
  onClose: () => void
  onSubmit: () => void
}

export default function CreateAssetDialog({ form, packages, fields, error, onChange, onClose, onSubmit }: CreateAssetDialogProps) {
  const [columnKind, setColumnKind] = useState<'conditionFields' | 'actionFields'>('conditionFields')
  const pickerOptions = useMemo<BomFieldPickerOption[]>(() => fields
    .filter(field => field.direction === (columnKind === 'conditionFields' ? 'input' : 'output'))
    .map(field => ({ id: field.key, field })), [columnKind, fields])
  const selected = form[columnKind]
  const disabled = !form.name.trim() || !form.category || (form.type === 'decision-table' && (!form.conditionFields.length || !form.actionFields.length))

  return (
    <Modal title="新建规则资产" onClose={onClose} width="max-w-5xl">
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-5 gap-2 max-xl:grid-cols-3 max-md:grid-cols-2">
          {[{ type: 'rule', label: 'BAL 规则', text: '适合单条 if-then 逻辑', Icon: FileText, enabled: true }, { type: 'decision-table', label: '决策表', text: '适合多条件枚举矩阵', Icon: Table2, enabled: true }, { type: 'decision-tree', label: '决策树', text: '树形判断与唯一结果', Icon: GitFork, enabled: true }, { type: 'scorecard', label: '计分卡', text: '特征分箱、加分与分段', Icon: Calculator, enabled: true }, { type: 'drl', label: 'DRL 脚本', text: '高级开发者，后续开放', Icon: Code2, enabled: false }].map(option => <button key={option.type} type="button" disabled={!option.enabled} className={`min-h-20 border p-3 text-left disabled:opacity-40 ${form.type === option.type ? 'border-brand-primary bg-brand-primary-l' : 'border-ink-border'}`} onClick={() => option.enabled && onChange({ ...form, type: option.type as CreateAssetForm['type'] })}><option.Icon size={18} className={option.type === 'decision-table' ? 'text-[#7c3aed]' : option.type === 'decision-tree' ? 'text-[#287a3d]' : option.type === 'scorecard' ? 'text-[#a15c00]' : 'text-brand-primary'} /><b className="mt-2 block text-xs">{option.label}</b><span className="mt-1 block text-[10px] text-ink-3">{option.text}</span></button>)}
        </div>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1"><label className="text-[11px] font-semibold text-ink-2">名称<input className="control-input mt-1" value={form.name} onChange={event => onChange({ ...form, name: event.target.value })} placeholder={form.type === 'rule' ? '客户年龄不足拒绝' : form.type === 'decision-tree' ? '授信审批决策树' : form.type === 'scorecard' ? '客户授信计分卡' : '风险等级评估表'} /></label><label className="text-[11px] font-semibold text-ink-2">所属包<select className="control-input mt-1" value={form.category} onChange={event => onChange({ ...form, category: event.target.value })}><option value="">请选择规则包</option>{packages.map(pkg => <option key={pkg.id} value={pkg.id}>{pkg.name} {pkg.label}</option>)}</select></label></div>
        {form.type === 'decision-table' && <>
          <div className="flex flex-wrap items-end gap-3"><label className="text-[11px] font-semibold text-ink-2">命中策略<select className="control-input mt-1 w-52" value={form.hitPolicy} onChange={event => onChange({ ...form, hitPolicy: event.target.value as CreateAssetForm['hitPolicy'] })}><option value="COLLECT">COLLECT 收集命中</option><option value="FIRST">FIRST 首条命中</option><option value="PRIORITY">PRIORITY 优先命中</option></select></label><div className="ml-auto inline-flex h-8 border border-ink-border" role="group" aria-label="选择列类型"><button type="button" className={`px-3 text-[11px] ${columnKind === 'conditionFields' ? 'bg-brand-primary text-white' : 'bg-white text-ink-2'}`} onClick={() => setColumnKind('conditionFields')}>条件列 {form.conditionFields.length}</button><button type="button" className={`border-l border-ink-border px-3 text-[11px] ${columnKind === 'actionFields' ? 'bg-brand-primary text-white' : 'bg-white text-ink-2'}`} onClick={() => setColumnKind('actionFields')}>动作列 {form.actionFields.length}</button></div></div>
          <BomFieldPicker options={pickerOptions} selectedIds={selected} onChange={ids => onChange({ ...form, [columnKind]: ids })} emptyText={columnKind === 'conditionFields' ? '没有可用的输入字段' : '没有可用的输出字段'} />
        </>}
        {error && <p className="text-[11px] text-[#c62828]">{error}</p>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-border bg-[#fafafa] p-3"><span className="mr-auto text-[10px] text-ink-3">{form.type === 'decision-table' && `已选 ${form.conditionFields.length} 个条件列、${form.actionFields.length} 个动作列`}</span><button className="h-8 border border-ink-border bg-white px-3 text-[11px]" onClick={onClose}>取消</button><button className="h-8 bg-brand-primary px-3 text-[11px] text-white disabled:opacity-40" disabled={disabled} onClick={onSubmit}>创建并打开</button></footer>
    </Modal>
  )
}
