import { Activity, Braces, ClipboardCheck, FileText, GitBranch, LoaderCircle, PackageCheck, RefreshCw, TestTube2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useActivity, type ActivityRecord } from '../api/activity'
import { useSessionStore } from '../store/session'

const relativeTime = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

function timeAgo(value: string) {
  const elapsed = new Date(value).getTime() - Date.now()
  const absolute = Math.abs(elapsed)
  if (absolute < 60_000) return '刚刚'
  if (absolute < 3_600_000) return relativeTime.format(Math.round(elapsed / 60_000), 'minute')
  if (absolute < 86_400_000) return relativeTime.format(Math.round(elapsed / 3_600_000), 'hour')
  if (absolute < 2_592_000_000) return relativeTime.format(Math.round(elapsed / 86_400_000), 'day')
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function activityHref(activity: ActivityRecord) {
  const project = `/projects/${encodeURIComponent(activity.project.id)}`
  if (activity.resourceType === 'rule' || activity.resourceType === 'table') return `${project}/assets?asset=${encodeURIComponent(activity.resourceId)}`
  if (activity.resourceType === 'flow') return `${project}/flow?flow=${encodeURIComponent(activity.resourceId)}`
  if (activity.resourceType === 'event-stream') return `${project}/event-streams?stream=${encodeURIComponent(activity.resourceId)}`
  if (activity.resourceType === 'change-set') return `${project}/reviews`
  if (activity.resourceType === 'release') return `${project}/releases`
  if (activity.resourceType === 'test-suite') return `${project}/tests`
  if (activity.resourceType === 'bom') return `${project}/bom`
  return activity.project.engine === 'cep' ? `${project}/event-streams` : `${project}/assets`
}

function ActivityIcon({ activity }: { activity: ActivityRecord }) {
  if (activity.action === 'release.deployed') return <PackageCheck size={15} className="text-env-production" />
  if (activity.resourceType === 'release') return <PackageCheck size={15} className="text-brand-primary" />
  if (activity.resourceType === 'change-set') return <ClipboardCheck size={15} className="text-brand-primary" />
  if (activity.resourceType === 'flow' || activity.resourceType === 'event-stream') return <GitBranch size={15} className="text-brand-primary" />
  if (activity.resourceType === 'test-suite') return <TestTube2 size={15} className="text-[#6d28d9]" />
  if (activity.resourceType === 'bom') return <Braces size={15} className="text-[#a15c00]" />
  return <FileText size={15} className="text-brand-primary" />
}

export default function Home() {
  const navigate = useNavigate()
  const user = useSessionStore(state => state.user)
  const activity = useActivity(20)
  const displayName = user?.displayName || user?.username || '用户'

  return (
    <div className="h-full overflow-auto bg-ink-bg px-6 py-5 max-sm:px-3">
      <div className="mx-auto max-w-[1500px]">
        <h1 className="mb-4 text-lg font-medium">欢迎，{displayName}</h1>
        <section className="max-w-5xl border border-ink-border bg-white">
          <header className="flex min-h-10 items-center gap-2 border-b border-ink-border bg-[#fafafa] px-[14px] py-2 text-xs font-semibold"><Activity size={15} />最近活动<button type="button" className="ml-auto inline-flex size-7 items-center justify-center border border-ink-border bg-white text-ink-2 hover:border-brand-primary hover:text-brand-primary disabled:opacity-40" disabled={activity.isFetching} onClick={() => void activity.refetch()} title="刷新最近活动" aria-label="刷新最近活动"><RefreshCw size={13} className={activity.isFetching ? 'animate-spin' : ''} /></button></header>
          {activity.isPending ? <div className="flex h-32 items-center justify-center gap-2 text-xs text-ink-3"><LoaderCircle size={15} className="animate-spin" />正在加载活动...</div>
            : activity.isError ? <div className="flex h-32 flex-col items-center justify-center gap-2 text-xs text-[#c62828]"><span>{activity.error.message}</span><button type="button" className="border border-ink-border bg-white px-3 py-1.5 text-ink-1" onClick={() => void activity.refetch()}>重新加载</button></div>
              : activity.data?.length ? <div className="divide-y divide-[#e8e8e8]" aria-label="最近活动列表">{activity.data.map(item => <button key={item.id} type="button" className="flex w-full items-start gap-2.5 px-[14px] py-2.5 text-left text-xs hover:bg-[#f0f6fc]" onClick={() => navigate(activityHref(item))}><span className="mt-0.5 shrink-0"><ActivityIcon activity={item} /></span><span className="min-w-0 flex-1"><span className="font-medium">{item.actor === user?.id || item.actor === user?.username ? '你' : item.actor}</span><span className="text-ink-2"> · {item.summary}</span><span className="ml-1 text-ink-3">· {timeAgo(item.occurredAt)}</span><span className="mt-0.5 block truncate text-[10px] text-ink-3">{item.project.name}</span></span></button>)}</div>
                : <div className="flex h-32 items-center justify-center text-xs text-ink-3">暂无最近活动</div>}
        </section>
      </div>
    </div>
  )
}
