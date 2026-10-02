import { Check, Minus, ShieldCheck } from 'lucide-react'
import type { AdminRole } from '../../types'

interface RoleMatrixProps {
  roles: AdminRole[]
}

const permissions = [
  { id: 'view', label: '浏览规则、决策表与发布记录' },
  { id: 'author', label: '编辑草稿、BOM 与测试套件' },
  { id: 'review', label: '审核 Change Set 与发布申请' },
  { id: 'release', label: '构建 Release 并部署到 RES' },
  { id: 'manage', label: '管理用户、角色与环境' },
]

export default function RoleMatrix({ roles }: RoleMatrixProps) {
  return (
    <div>
      <p className="mb-3 text-[11px] text-ink-3">当前矩阵与 Team Server 的粗粒度 RBAC 权限保持一致。</p>
      <section className="overflow-hidden rounded-[3px] border border-ink-border bg-white" aria-label="角色权限矩阵">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] border-collapse text-left text-xs">
            <thead className="bg-[#fafafa] text-[11px] text-ink-2"><tr><th className="w-[34%] border-b border-ink-border px-[10px] py-2 font-semibold">权限</th>{roles.map((role) => <th key={role.id} className="border-b border-ink-border px-[10px] py-2 text-center font-semibold">{role.label}</th>)}</tr></thead>
            <tbody>{permissions.map((permission) => (
              <tr key={permission.id} className="border-b border-[#e8e8e8] last:border-0">
                <td className="px-[10px] py-2.5">{permission.label}</td>
                {roles.map((role) => {
                  const granted = role.permissions.includes(permission.id)
                  return <td key={role.id} className="px-[10px] py-2.5 text-center">{granted ? <Check className="mx-auto text-env-production" size={15} strokeWidth={2.5} aria-label="允许" /> : <Minus className="mx-auto text-ink-3" size={14} aria-label="不允许" />}</td>
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <div className="mt-[14px] flex items-start gap-2 rounded-[3px] border border-ink-border bg-white p-3 text-[11px] text-ink-3">
        <ShieldCheck size={15} className="mt-px shrink-0 text-brand-primary" />
        <p><b className="font-semibold text-ink-2">职责分离：</b>规则作者不能审核自己的变更；生产发布需要审核人与部署执行人分离。当前后端的 <span className="font-mono">release-manager</span> 暂时合并构建与部署权限。</p>
      </div>
    </div>
  )
}
